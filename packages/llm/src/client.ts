// The LLM client (§5, §22). Every call has a tier, a timeout, a fallback chain ending in the module's code
// default, an AbortSignal, a state-version check (`isStale`), zod validation for structured replies and cost
// logging (§13 rule 5). Inference only ever goes to the subscription base URL through the guarded fetch, only to
// allowlisted models; no error path changes the URL or adds billing or provider options (§13 rule 12).

import OpenAI from 'openai';
import { z } from 'zod';
import type { Logger } from '@agora/shared';
import { CircuitBreaker } from './circuit';
import { LlmError, ModelNotInSubscription, classifyHttpError } from './errors';
import {
  MODULE_PRIORITY,
  type ModuleName,
  type QuotaGovernor,
  agentDegrade,
  applyAgentDegrade,
  ladder,
} from './governor';
import { ForbiddenEndpointError, ForbiddenOptionError, SUBSCRIPTION_BASE_URL, createGuardedFetch } from './guard';
import type { CostMeter, CostRecord } from './meter';
import type { TokenSource } from './ratelimit';
import type { ModelRouter, TierName, TierSpec } from './tiers';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FallbackReason = 'code-only' | 'budget' | 'disabled' | 'stale' | 'aborted' | 'failed';

export type LlmResult<T> =
  | { ok: true; source: 'llm'; value: T; text: string; model: string; tier: TierName; usage: LlmUsage; ms: number; attempts: number }
  | { ok: false; source: 'fallback'; value: T; reason: FallbackReason; error?: string; ms: number; attempts: number };

export interface LlmCallOptions<T> {
  tier: TierName;
  module: ModuleName;
  agent: string;
  messages: readonly ChatMessage[];
  /** Structured reply: validated with zod, one repair retry (§4.3). */
  schema?: z.ZodType<T>;
  schemaName?: string;
  /** The module's non-LLM default (CC: keep the current option; Talking: a canned line). Required. */
  fallback: () => T;
  /** Fires on shutdown or when the state moved on (abort-on-stale). */
  signal?: AbortSignal;
  /** State-version check at reply time: true = throw the result away. */
  isStale?: () => boolean;
  maxTokens?: number;
  temperature?: number;
  /** Streams text replies (Talking): called with each new piece. */
  onText?: (delta: string) => void;
  /** A specific model (bench, tests). Must be on the allowlist. */
  model?: string;
}

export interface TierRuntime extends TierSpec {
  maxTokens: number;
}

export interface LlmClientDeps {
  apiKey: string;
  router: ModelRouter;
  governor: QuotaGovernor;
  meter: CostMeter;
  limiter: TokenSource;
  specs: Readonly<Record<TierName, TierRuntime>>;
  logger: Logger;
  /** Underlying fetch (tests inject a fake NanoGPT); always wrapped by the guard. */
  fetch?: typeof fetch;
  activeAgents?: () => number;
  onCost?: (r: CostRecord) => void;
  circuit?: CircuitBreaker;
  now?: () => number;
}

const ATTEMPTS = 2; // primary, then one fallback model, then the code default (§5)
const SCHEMA_FAILS_FOR_UNRELIABLE = 3;
const SCHEMA_FAIL_WINDOW_MS = 30 * 60_000;

interface Reply {
  text: string;
  usage: LlmUsage;
}

class AttemptError extends Error {
  constructor(
    readonly inner: LlmError,
    readonly usage: LlmUsage,
  ) {
    super(inner.message);
  }
}

function estimateTokens(messages: readonly ChatMessage[]): number {
  return Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
}

/** Pulls a JSON value out of a reply (code fences and chatter around it are common with small models). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('no JSON object in the reply');
  }
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

export class LlmClient {
  private readonly openai: OpenAI;
  private readonly circuit: CircuitBreaker;
  private readonly now: () => number;
  private readonly schemaFails = new Map<string, number[]>();

  constructor(private readonly deps: LlmClientDeps) {
    this.now = deps.now ?? Date.now;
    this.circuit = deps.circuit ?? new CircuitBreaker({ now: this.now });
    this.openai = new OpenAI({
      apiKey: deps.apiKey,
      baseURL: SUBSCRIPTION_BASE_URL,
      fetch: createGuardedFetch({
        baseFetch: deps.fetch,
        onStrip: (what) => deps.logger.warn({ module: 'llm', stripped: what }, 'stripped a forbidden request option'),
      }),
      maxRetries: 0,
      timeout: 120_000,
    });
  }

  async call<T>(o: LlmCallOptions<T>): Promise<LlmResult<T>> {
    const t0 = this.now();
    let attempts = 0;
    const fallback = (reason: FallbackReason, error?: string): LlmResult<T> => ({
      ok: false,
      source: 'fallback',
      value: o.fallback(),
      reason,
      error,
      ms: this.now() - t0,
      attempts,
    });
    if (o.signal?.aborted) return fallback('aborted');

    // Layer 4: quota ladder, then the agent's own hourly share.
    const q = this.deps.governor.status;
    const effects = ladder(q.level);
    if (!effects.enabled(o.module)) return fallback(q.codeOnly ? 'code-only' : 'disabled', q.reason);
    const share = this.deps.governor.perAgentHourly(this.deps.activeAgents?.() ?? 1);
    const tier = applyAgentDegrade(effects.tier(o.tier, o.module), agentDegrade(this.deps.meter.spentThisHour(o.agent), share));
    if (tier === null) return fallback(q.codeOnly ? 'code-only' : 'budget', q.codeOnly ? q.reason : 'hourly share used up');

    // Layer 3: only allowlisted models, refused before anything is sent.
    let chain: string[];
    if (o.model !== undefined) {
      const id = this.deps.router.allowlist.resolve(o.model);
      if (!id) throw new ModelNotInSubscription(o.model);
      chain = [id];
    } else {
      if (this.deps.router.codeOnly) return fallback('code-only', 'no subscription model fits any tier');
      chain = this.deps.router.chain(tier).filter((m) => !this.circuit.isOpen(m));
      if (chain.length === 0) return fallback('failed', `every ${tier} model is circuit-broken`);
    }
    const spec = this.deps.specs[tier];

    try {
      await this.deps.limiter.acquire(MODULE_PRIORITY[o.module], o.signal, o.module);
    } catch {
      return fallback('aborted');
    }

    let lastError = '';
    for (const model of chain) {
      if (attempts >= ATTEMPTS) break;
      if (!this.deps.router.allowlist.has(model)) {
        if (o.model !== undefined) throw new ModelNotInSubscription(model);
        continue; // removed since the chain was read
      }
      attempts++;
      const started = this.now();
      try {
        const r = await this.attempt(o, model, spec);
        this.record(o, tier, model, r.usage, this.now() - started, true);
        this.circuit.success(model);
        if (o.signal?.aborted || o.isStale?.()) return fallback(o.isStale?.() ? 'stale' : 'aborted', 'state moved on');
        return { ok: true, source: 'llm', value: r.value, text: r.text, model, tier, usage: r.usage, ms: this.now() - t0, attempts };
      } catch (err) {
        if (err instanceof ForbiddenEndpointError || err instanceof ForbiddenOptionError || err instanceof ModelNotInSubscription) throw err;
        const usage = err instanceof AttemptError ? err.usage : { inputTokens: 0, outputTokens: 0 };
        const e = err instanceof AttemptError ? err.inner : this.toLlmError(err, model, o.signal);
        this.record(o, tier, model, usage, this.now() - started, false);
        lastError = `${model}: ${e.message}`;
        this.deps.logger.info({ module: 'llm', caller: o.module, agent: o.agent, model, kind: e.kind, err: e.message }, 'llm attempt failed');
        const next = await this.onFailure(e, model, tier, o.signal);
        if (next === 'stop') return fallback(e.kind === 'aborted' ? (o.isStale?.() ? 'stale' : 'aborted') : e.kind === 'daily_limit' ? 'code-only' : 'failed', lastError);
      }
    }
    return fallback('failed', lastError || 'no model left to try');
  }

  /** §22.6 actions. 'next' tries the next model in the chain; 'stop' goes to the code default. */
  private async onFailure(e: LlmError, model: string, tier: TierName, signal?: AbortSignal): Promise<'next' | 'stop'> {
    switch (e.kind) {
      case 'aborted':
        return 'stop';
      case 'model_gone':
        void this.deps.router.refresh(`${model}: ${e.opts.code ?? 'model not found'}`);
        return 'next';
      case 'not_covered':
        this.deps.router.removeForSession(model, e.message);
        void this.deps.governor.poll('not covered');
        return 'next';
      case 'rate_limited': {
        this.deps.limiter.backOff?.();
        void this.deps.governor.poll('429');
        const wait = Math.min(e.opts.retryAfterMs ?? 1000 + Math.random() * 1000, 4000);
        try {
          await abortableSleep(wait, signal);
        } catch {
          return 'stop';
        }
        return 'next';
      }
      case 'daily_limit': {
        const until = this.now() + (e.opts.retryAfterMs ?? msUntilUtcMidnight(this.now()));
        this.deps.governor.forceCodeOnly('NanoGPT daily key limit reached', until);
        return 'stop';
      }
      case 'auth':
        this.deps.logger.error({ module: 'llm' }, 'NanoGPT rejected the API key (401); check NANOGPT_API_KEY in .env');
        this.deps.governor.forceCodeOnly('NanoGPT rejected the API key', this.now() + 10 * 60_000);
        return 'stop';
      case 'provider':
      case 'timeout':
        if (this.circuit.failure(model)) {
          this.deps.logger.warn({ module: 'llm', event: 'circuitOpen', model, tier }, 'model circuit-broken for 5 min');
        }
        return 'next';
      case 'schema_invalid':
        this.noteSchemaFailure(tier, model);
        return 'stop';
      case 'context_length':
      case 'bad_request':
        return 'next';
      case 'not_in_subscription':
        return 'stop';
    }
  }

  private noteSchemaFailure(tier: TierName, model: string): void {
    const key = `${tier}|${model}`;
    const cutoff = this.now() - SCHEMA_FAIL_WINDOW_MS;
    const list = (this.schemaFails.get(key) ?? []).filter((t) => t >= cutoff);
    list.push(this.now());
    this.schemaFails.set(key, list);
    if (list.length >= SCHEMA_FAILS_FOR_UNRELIABLE) {
      this.schemaFails.delete(key);
      this.deps.router.markUnreliable(tier, model);
    }
  }

  private record(o: LlmCallOptions<unknown>, tier: TierName, model: string, usage: LlmUsage, ms: number, ok: boolean): void {
    const r: CostRecord = { ts: this.now(), agent: o.agent, module: o.module, tier, model, ...usage, ms, ok };
    this.deps.meter.record(r);
    this.deps.onCost?.(r);
  }

  private async attempt<T>(o: LlmCallOptions<T>, model: string, spec: TierRuntime): Promise<{ value: T; text: string; usage: LlmUsage }> {
    if (!o.schema) {
      const r = await this.request(o, model, spec, o.messages, undefined);
      return { value: r.text as T, text: r.text, usage: r.usage };
    }
    const schema = o.schema;
    const native = this.deps.router.allowlist.get(model)?.capabilities.has('structured_output') ?? false;
    const format = native
      ? { type: 'json_schema' as const, json_schema: { name: o.schemaName ?? 'reply', schema: jsonSchemaOf(schema), strict: false } }
      : { type: 'json_object' as const };
    const messages: ChatMessage[] = native
      ? [...o.messages]
      : [...o.messages, { role: 'system', content: `Reply with only a JSON object matching this JSON schema:\n${JSON.stringify(jsonSchemaOf(schema))}` }];
    const first = await this.request(o, model, spec, messages, format);
    const p1 = this.validate(first.text, schema);
    if (p1.ok) return { value: p1.value, text: first.text, usage: first.usage };
    // One repair retry with the validation error (§4.3).
    const repair: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first.text.slice(0, 4000) },
      { role: 'user', content: `That reply was not valid (${p1.error}). Reply again with only the corrected JSON object.` },
    ];
    let second: Reply;
    try {
      second = await this.request(o, model, spec, repair, format);
    } catch (err) {
      throw new AttemptError(this.toLlmError(err, model, o.signal), first.usage);
    }
    const usage = { inputTokens: first.usage.inputTokens + second.usage.inputTokens, outputTokens: first.usage.outputTokens + second.usage.outputTokens };
    const p2 = this.validate(second.text, schema);
    if (p2.ok) return { value: p2.value, text: second.text, usage };
    throw new AttemptError(new LlmError('schema_invalid', `invalid reply after repair: ${p2.error}`, { model }), usage);
  }

  private validate<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
    let json: unknown;
    try {
      json = extractJson(text);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const r = schema.safeParse(json);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error).slice(0, 600) };
  }

  private async request(
    o: LlmCallOptions<unknown>,
    model: string,
    spec: TierRuntime,
    messages: readonly ChatMessage[],
    format: { type: 'json_object' } | { type: 'json_schema'; json_schema: Record<string, unknown> } | undefined,
  ): Promise<Reply> {
    const timeout = AbortSignal.timeout(spec.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    const base = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: Math.min(o.maxTokens ?? spec.maxTokens, spec.maxTokens),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    };
    try {
      if (o.onText && !format) {
        const stream = await this.openai.chat.completions.create(
          { ...base, stream: true, stream_options: { include_usage: true } },
          { signal, timeout: spec.timeoutMs },
        );
        let text = '';
        let usage: LlmUsage | null = null;
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (delta) {
            text += delta;
            o.onText(delta);
          }
          if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }
        return { text, usage: usage ?? { inputTokens: estimateTokens(messages), outputTokens: Math.ceil(text.length / 4) } };
      }
      // NanoGPT only reports usage on non-streaming calls when asked (`include_usage`).
      const body = { ...base, ...(format ? { response_format: format } : {}), include_usage: true };
      const res = await this.openai.chat.completions.create(body as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, {
        signal,
        timeout: spec.timeoutMs,
      });
      const text = res.choices[0]?.message?.content ?? '';
      const usage = res.usage
        ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
        : { inputTokens: estimateTokens(messages), outputTokens: Math.ceil(text.length / 4) };
      if (!text.trim()) throw new AttemptError(new LlmError('provider', 'empty reply', { model }), usage);
      return { text, usage };
    } catch (err) {
      if (err instanceof AttemptError) throw err;
      if (timeout.aborted && !o.signal?.aborted) throw new LlmError('timeout', `no reply within ${spec.timeoutMs} ms`, { model });
      throw err;
    }
  }

  private toLlmError(err: unknown, model: string, signal?: AbortSignal): LlmError {
    if (err instanceof LlmError) return err;
    if (signal?.aborted) return new LlmError('aborted', 'aborted by caller', { model });
    if (err instanceof OpenAI.APIConnectionTimeoutError) return new LlmError('timeout', err.message, { model });
    if (err instanceof OpenAI.APIUserAbortError) return new LlmError('aborted', 'aborted', { model });
    if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
      const headers = err.headers as Headers | undefined;
      return classifyHttpError(err.status, { error: err.error as unknown, message: err.message }, headers?.get('retry-after') ?? null, model);
    }
    return new LlmError('provider', err instanceof Error ? err.message : String(err), { model });
  }
}

function msUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
