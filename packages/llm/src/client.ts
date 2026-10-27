// The LLM client (§5, §22). Every call has a tier, a timeout, a fallback chain ending in the module's code
// default, an AbortSignal, a state-version check (`isStale`), zod validation for structured replies and cost
// logging (§13 rule 5). Inference only ever goes to the subscription base URL through the guarded fetch, only to
// allowlisted models; no error path changes the URL or adds billing or provider options (§13 rule 12).

import OpenAI from 'openai';
import { z } from 'zod';
import { type LlmModule, type Logger, MODULE_PRIORITY, MODULE_THOUGHT, type ReasoningEffort, type ThoughtConfig, type ThoughtKind } from '@agora/shared';
import { CircuitBreaker } from './circuit';
import { LlmError, ModelNotInSubscription, classifyHttpError } from './errors';
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

/** `refused`: NanoGPT turned the key away (its daily limit, a revoked key), so no call goes out for a while. */
export type FallbackReason = 'code-only' | 'refused' | 'disabled' | 'stale' | 'aborted' | 'failed';

export type LlmResult<T> =
  | { ok: true; source: 'llm'; value: T; text: string; model: string; tier: TierName; usage: LlmUsage; ms: number; attempts: number; truncated?: boolean }
  | { ok: false; source: 'fallback'; value: T; reason: FallbackReason; error?: string; ms: number; attempts: number };

export interface LlmCallOptions<T> {
  tier: TierName;
  module: LlmModule;
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
  /** Called before another model is tried after a failed attempt (a stream's pieces so far were from the failed one). */
  onRetry?: () => void;
  /** A specific model (bench, tests). Must be on the allowlist. */
  model?: string;
  /**
   * Models tried first, in order, before the tier's own chain (models.yaml speech.models). One not on the subscription
   * list is skipped, never sent anything; the operator's model for the tier still comes first.
   */
  prefer?: readonly string[];
  /** This call's per-try timeout instead of the tier's (when its kind of thought has no model of its own). */
  timeoutMs?: number;
  /** The kind of thought this is (by default, by its module): its configured model, effort, length and time are used. */
  thought?: ThoughtKind;
  /** A reasoning effort for this call instead of its thought's (bench, tests). */
  effort?: ReasoningEffort;
  /**
   * The prompt already describes the reply's JSON (the CC's decision format): the schema itself isn't appended, only
   * a line asking for that object.
   */
  formatInPrompt?: boolean;
  /** Tidies the parsed JSON before validation (placeholders a model filled in for fields it didn't need). */
  prepare?: (json: unknown) => unknown;
}

/**
 * The operator's routing for one agent (debug controls): every model call off (the code defaults run), the model a
 * tier tries first, and the tier a module uses instead of the one it asks for. Subscription models only: a model not
 * on the allowlist is never sent anything (§22.3).
 */
export interface Routing {
  off?: boolean;
  tierModel?: Partial<Record<TierName, string>>;
  moduleTier?: Partial<Record<LlmModule, TierName>>;
}

/**
 * How structured replies are asked for. `object`: a JSON-object reply, the schema given in the prompt. `schema`: the
 * API's json_schema format for models that list structured output. Subscription models asked for a json_schema
 * reply fill in every optional field, mostly with empty strings (a goal of "", a fight with "zombie"), so `object` is
 * the default.
 */
export type StructuredMode = 'object' | 'schema';

/** The line that asks for a structured reply; `name` in parentheses (tests read it to tell the callers apart). */
export function replyFormatLine(name: string, schemaJson: string | null): string {
  return schemaJson === null ? `Reply with only the JSON object (${name}) described above.` : `Reply with only a JSON object (${name}) matching this JSON schema:\n${schemaJson}`;
}

export interface TierRuntime extends TierSpec {
  maxTokens: number;
}

/** What one call runs under: its tier's settings, or its kind of thought's, and the reasoning effort to send. */
interface CallSpec extends TierRuntime {
  effort?: ReasoningEffort;
}

export interface LlmClientDeps {
  apiKey: string;
  router: ModelRouter;
  meter: CostMeter;
  limiter: TokenSource;
  specs: Readonly<Record<TierName, TierRuntime>>;
  /** Each kind of thought's own model (models.yaml `thoughts`); a kind not named runs on its tier's chain. */
  thoughts?: Partial<Record<ThoughtKind, ThoughtConfig>>;
  logger: Logger;
  /** Underlying fetch (tests inject a fake NanoGPT); always wrapped by the guard. */
  fetch?: typeof fetch;
  onCost?: (r: CostRecord) => void;
  circuit?: CircuitBreaker;
  /** How structured replies are asked for (default `object`). */
  structured?: StructuredMode;
  now?: () => number;
}

const ATTEMPTS = 2; // primary, then one fallback model, then the code default (§5)
const SCHEMA_FAILS_FOR_UNRELIABLE = 3;
const SCHEMA_FAIL_WINDOW_MS = 30 * 60_000;

interface Reply {
  text: string;
  usage: LlmUsage;
  /** The reply stopped at max_tokens. */
  truncated?: boolean;
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

/**
 * Pulls a JSON value out of a reply: code fences and chatter around it are common with small models, and what is wrong
 * inside it is mended here when it can be (stray quotes, a missing or trailing comma, a reply cut off part way), so no
 * model is asked again for what code can put right.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    if (start < 0) throw new Error('no JSON object in the reply');
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    const slice = body.slice(start, Math.max(end, start) + 1);
    let first: unknown;
    try {
      return JSON.parse(slice);
    } catch (err) {
      first = err;
    }
    // Quotes inside a string left bare, and line breaks: a model asked in plain wrote its thought with "so" in it.
    const tail = body.slice(start);
    for (const attempt of [() => escapeStrays(slice), () => repairJson(tail), () => repairJson(escapeStrays(tail))]) {
      try {
        const mended = attempt();
        if (mended !== null) return JSON.parse(mended);
      } catch {
        // the next way
      }
    }
    throw first instanceof Error ? first : new Error(String(first));
  }
}

type Mended = 'ok' | 'cut' | 'end' | 'bad';

/**
 * The JSON with what models get wrong in its shape mended: a comma missing between two members or added after the last
 * one, and a reply cut off part way (its length ran out). A cut reply is cut back to its last whole member and closed:
 * the step or field being written when it stopped is dropped, never closed half written, so a cut-off `goTo` is not
 * kept without its z. Null when it can't be mended.
 */
export function repairJson(json: string): string | null {
  let i = 0;
  let out = '';
  const ws = () => {
    while (i < json.length && /\s/.test(json[i] as string)) i++;
  };
  const str = (): Mended => {
    let j = i + 1;
    while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
    if (j >= json.length) return 'cut';
    out += json.slice(i, j + 1);
    i = j + 1;
    return 'ok';
  };
  const literal = (): Mended => {
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(json.slice(i));
    if (!m) return /^(-|\d|t|f|n)/.test(json.slice(i)) && /^[-\d.eE+tfnrulas]*$/.test(json.slice(i).trim()) ? 'cut' : 'bad';
    // A number at the very end may have been cut short (120 cut to 12).
    if (i + m[0].length >= json.length && /\d$/.test(m[0])) return 'cut';
    out += m[0];
    i += m[0].length;
    return 'ok';
  };
  const value = (top: boolean): Mended => {
    ws();
    if (i >= json.length) return 'cut';
    const c = json[i];
    if (c === '{') return container('}', top);
    if (c === '[') return container(']', top);
    if (c === '"') return str();
    return literal();
  };
  // A member's value cut off: an array drops the element it was in, and so does the top object; a nested object
  // passes it up, so the whole member it belongs to goes.
  const container = (close: '}' | ']', top: boolean): Mended => {
    const isArray = close === ']';
    out += json[i];
    i++;
    let members = 0;
    for (;;) {
      const before = out.length;
      ws();
      if (i >= json.length) {
        out += close;
        return 'end';
      }
      if (json[i] === close) {
        out += close;
        i++;
        return 'ok';
      }
      if (json[i] === ',') {
        i++;
        continue; // a comma before a member is written with it; a trailing one is never written
      }
      if (members > 0) out += ',';
      let r: Mended;
      if (isArray) r = value(false);
      else {
        if (json[i] !== '"') return 'bad';
        const k = str();
        if (k !== 'ok') r = k;
        else {
          ws();
          if (json[i] !== ':') r = i >= json.length ? 'cut' : 'bad';
          else {
            i++;
            out += ':';
            r = value(false);
          }
        }
      }
      if (r === 'bad') return 'bad';
      if (r === 'cut') {
        if (!isArray && !top) return 'cut';
        out = out.slice(0, before) + close;
        return 'end';
      }
      members++;
      if (r === 'end') {
        out += close;
        return 'end';
      }
    }
  };
  ws();
  const r = value(true);
  return r === 'ok' || r === 'end' ? out : null;
}

/**
 * The text with quotes inside strings that do not end them escaped, and raw line breaks in strings made \\n: a quote
 * ends a string only where what follows could follow one (a colon, a closing bracket, the end, or a comma and then
 * what comes next where it stands: a key in an object, a value in a list).
 */
export function escapeStrays(json: string): string {
  let out = '';
  let inString = false;
  const open: string[] = [];
  for (let i = 0; i < json.length; i++) {
    const c = json[i] as string;
    if (!inString) {
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') open.push(c);
      else if (c === '}' || c === ']') open.pop();
      out += c;
      continue;
    }
    if (c === '\\') {
      out += c + (json[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      out += c === '\n' ? '\\n' : '';
      continue;
    }
    if (c !== '"') {
      out += c;
      continue;
    }
    const rest = json.slice(i + 1).trimStart();
    const next = rest[0];
    const after = rest.slice(1).trimStart()[0];
    const nextUp = open.at(-1) === '[' ? /["{[\d\-tfn]/ : /"/;
    const ends = next === undefined || next === ':' || next === '}' || next === ']' || (next === ',' && after !== undefined && nextUp.test(after));
    if (ends) {
      inString = false;
      out += c;
    } else out += '\\"';
  }
  return out;
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
  /** Models whose JSON mode answered with an empty object: asked in plain from then on, the format in the prompt. */
  private readonly plainOnly = new Set<string>();
  private route: Routing = {};
  /** NanoGPT turned the key away: no calls until then. */
  private refused: { reason: string; until: number } | null = null;

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

  /** Sets the operator's routing (replaces the previous one). */
  setRouting(r: Routing): void {
    this.route = { ...r };
  }

  get routing(): Routing {
    return this.route;
  }

  /** The models a tier would try, in order, as routed now (for the dashboard). */
  chainFor(tier: TierName): string[] {
    const first = this.route.tierModel?.[tier];
    const chain = this.deps.router.chain(tier);
    return first && this.deps.router.allowlist.has(first) ? [first, ...chain.filter((m) => m !== first)] : [...chain];
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
    if (this.route.off) return fallback('disabled', 'model calls switched off by the operator');
    if (this.refused && this.now() < this.refused.until) return fallback('refused', this.refused.reason);
    // The tier asked for (or the operator's for this module) is the tier used: the quota never changes it.
    const tier = this.route.moduleTier?.[o.module] ?? o.tier;

    const kind = o.thought ?? MODULE_THOUGHT[o.module];
    const thought = this.deps.thoughts?.[kind];

    // Layer 3: only allowlisted models, refused before anything is sent.
    let chain: string[];
    if (o.model !== undefined) {
      const id = this.deps.router.allowlist.resolve(o.model);
      if (!id) throw new ModelNotInSubscription(o.model);
      chain = [id];
    } else if (thought) {
      // One model for this kind of thought, its backup only while that one is down (owner request, 2026-10-25). The
      // operator's model for the tier still comes first.
      const routed = this.route.tierModel?.[tier];
      const named = [...new Set([...(routed ? [routed] : []), thought.model, ...(thought.backup ? [thought.backup] : [])])];
      chain = named.filter((m) => this.deps.router.allowlist.has(m) && !this.circuit.isOpen(m));
      if (chain.length === 0) return fallback('failed', `no model for ${kind}: ${named.join(', ')} unavailable`);
    } else {
      if (this.deps.router.codeOnly) return fallback('code-only', 'no subscription model fits any tier');
      chain = this.chainFor(tier).filter((m) => !this.circuit.isOpen(m));
      if (o.prefer && o.prefer.length > 0) {
        const routed = this.route.tierModel?.[tier];
        const head = routed && chain[0] === routed ? [routed] : [];
        const pref = o.prefer.filter((m) => this.deps.router.allowlist.has(m) && !this.circuit.isOpen(m) && !head.includes(m));
        chain = [...head, ...pref, ...chain.filter((m) => !head.includes(m) && !pref.includes(m))];
      }
      if (chain.length === 0) return fallback('failed', `every ${tier} model is circuit-broken`);
    }
    const tierSpec = this.deps.specs[tier];
    const effort = o.effort ?? thought?.effort;
    const spec: CallSpec = {
      ...tierSpec,
      timeoutMs: thought?.timeoutMs ?? o.timeoutMs ?? tierSpec.timeoutMs,
      maxTokens: thought?.maxTokens ?? Math.min(o.maxTokens ?? tierSpec.maxTokens, tierSpec.maxTokens),
      ...(effort ? { effort } : {}),
    };

    let lastError = '';
    for (const model of chain) {
      if (attempts >= ATTEMPTS) break;
      if (!this.deps.router.allowlist.has(model)) {
        if (o.model !== undefined) throw new ModelNotInSubscription(model);
        continue; // removed since the chain was read
      }
      // Each try is a request against the key's limit (60 a minute, NanoGPT counts every one, a timed-out one and a
      // fallback model's alike): a rate token each, not one for the whole call.
      try {
        await this.deps.limiter.acquire(MODULE_PRIORITY[o.module], o.signal, o.module);
      } catch {
        return fallback('aborted');
      }
      // A thought gone stale while it waited for its turn is not sent at all.
      if (o.isStale?.()) return fallback('stale', 'state moved on before it was sent');
      if (attempts > 0) o.onRetry?.();
      attempts++;
      const started = this.now();
      try {
        const r = await this.attempt(o, model, spec);
        this.record(o, tier, model, r.usage, this.now() - started, true, { thought: kind, ...(r.truncated ? { truncated: true } : {}) });
        this.circuit.success(model);
        if (o.signal?.aborted || o.isStale?.()) return fallback(o.isStale?.() ? 'stale' : 'aborted', 'state moved on');
        return { ok: true, source: 'llm', value: r.value, text: r.text, model, tier, usage: r.usage, ms: this.now() - t0, attempts, ...(r.truncated ? { truncated: true } : {}) };
      } catch (err) {
        if (err instanceof ForbiddenEndpointError || err instanceof ForbiddenOptionError || err instanceof ModelNotInSubscription) throw err;
        const usage = err instanceof AttemptError ? err.usage : { inputTokens: 0, outputTokens: 0 };
        const e = err instanceof AttemptError ? err.inner : this.toLlmError(err, model, o.signal);
        this.record(o, tier, model, usage, this.now() - started, false, { thought: kind, failure: e.kind, ...(/cut off at/.test(e.message) ? { truncated: true } : {}) });
        lastError = `${model}: ${e.message}`;
        this.deps.logger.info({ module: 'llm', caller: o.module, agent: o.agent, model, kind: e.kind, err: e.message }, 'llm attempt failed');
        const next = await this.onFailure(e, model, tier, o.signal);
        if (next === 'stop') return fallback(e.kind === 'aborted' ? (o.isStale?.() ? 'stale' : 'aborted') : e.kind === 'daily_limit' || e.kind === 'auth' ? 'refused' : 'failed', lastError);
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
        return 'next';
      case 'rate_limited': {
        this.deps.limiter.backOff?.();
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
        this.refuse('NanoGPT daily key limit reached', until);
        return 'stop';
      }
      case 'auth':
        this.deps.logger.error({ module: 'llm' }, 'NanoGPT rejected the API key (401); check NANOGPT_API_KEY in .env');
        this.refuse('NanoGPT rejected the API key', this.now() + 10 * 60_000);
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

  /** NanoGPT said no to the key itself: every call would be refused, so none goes out until `until`. */
  private refuse(reason: string, until: number): void {
    if (!this.refused || this.refused.until < until) this.deps.logger.warn({ module: 'llm', reason, until: new Date(until).toISOString() }, 'no model calls until then');
    this.refused = { reason, until };
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

  private record(o: LlmCallOptions<unknown>, tier: TierName, model: string, usage: LlmUsage, ms: number, ok: boolean, more: Pick<CostRecord, 'thought' | 'failure' | 'truncated'> = {}): void {
    const r: CostRecord = { ts: this.now(), agent: o.agent, module: o.module, tier, model, ...usage, ms, ok, ...more };
    this.deps.meter.record(r);
    this.deps.onCost?.(r);
  }

  private async attempt<T>(o: LlmCallOptions<T>, model: string, spec: CallSpec): Promise<{ value: T; text: string; usage: LlmUsage; truncated?: boolean }> {
    if (!o.schema) {
      const r = await this.request(o, model, spec, o.messages, undefined);
      return { value: r.text as T, text: r.text, usage: r.usage, ...(r.truncated ? { truncated: true } : {}) };
    }
    const schema = o.schema;
    const name = o.schemaName ?? 'reply';
    const native = (this.deps.structured ?? 'object') === 'schema' && (this.deps.router.allowlist.get(model)?.capabilities.has('structured_output') ?? false);
    const format = this.plainOnly.has(model) ? undefined : native ? { type: 'json_schema' as const, json_schema: { name, schema: jsonSchemaOf(schema), strict: false } } : { type: 'json_object' as const };
    // The reply format goes at the end of the system prompt (a system message after the conversation confuses some).
    const line = replyFormatLine(name, o.formatInPrompt ? null : JSON.stringify(jsonSchemaOf(schema)));
    const [head, ...rest] = o.messages;
    const messages: ChatMessage[] = native
      ? [...o.messages]
      : head?.role === 'system'
        ? [{ role: 'system', content: `${head.content}\n\n${line}` }, ...rest]
        : [{ role: 'system', content: line }, ...o.messages];
    let first = await this.request(o, model, spec, messages, format);
    // A JSON mode that answers "{}" is no answer: the model is asked again in plain, and in plain from then on
    // (glm-5.3 answered "{}" six times of six on two of the mind's packets, and in plain gave the whole decision).
    if (format && /^\s*\{\s*\}\s*$/.test(first.text)) {
      this.plainOnly.add(model);
      this.deps.logger.info({ module: 'llm', caller: o.module, model }, 'json mode came back empty; asking in plain from now on');
      await this.deps.limiter.acquire(MODULE_PRIORITY[o.module], o.signal, o.module);
      const plain = await this.request(o, model, spec, messages, undefined);
      first = { ...plain, usage: { inputTokens: first.usage.inputTokens + plain.usage.inputTokens, outputTokens: first.usage.outputTokens + plain.usage.outputTokens } };
    }
    const p1 = this.validate(first.text, schema, o.prepare);
    if (p1.ok) return { value: p1.value, text: first.text, usage: first.usage, ...(first.truncated ? { truncated: true } : {}) };
    // A reply that ran out of length would run out again: it is not asked for twice (its cap is what to change).
    if (first.truncated) {
      this.deps.logger.info({ module: 'llm', caller: o.module, agent: o.agent, model, maxTokens: spec.maxTokens, error: p1.error.slice(0, 300), reply: first.text.slice(0, 4000) }, 'reply cut off by its length');
      throw new AttemptError(new LlmError('schema_invalid', `reply cut off at ${spec.maxTokens} tokens: ${p1.error}`, { model }), first.usage);
    }
    // One repair retry with the validation error (§4.3), small: the reply, what was wrong and the form it should take,
    // not the whole prompt again, so it comes back quickly.
    const repair: ChatMessage[] = [
      { role: 'system', content: `You correct replies that came back in the wrong form. Keep what the reply says and decides; change only what makes it invalid. ${replyFormatLine(name, JSON.stringify(jsonSchemaOf(schema)))}` },
      { role: 'user', content: `This reply was not valid (${p1.error}):\n\n${first.text.slice(0, 6000)}` },
    ];
    let second: Reply;
    try {
      // The repair is a request of its own: another token.
      await this.deps.limiter.acquire(MODULE_PRIORITY[o.module], o.signal, o.module);
      second = await this.request(o, model, spec, repair, this.plainOnly.has(model) ? undefined : format);
    } catch (err) {
      throw new AttemptError(this.toLlmError(err, model, o.signal), first.usage);
    }
    const usage = { inputTokens: first.usage.inputTokens + second.usage.inputTokens, outputTokens: first.usage.outputTokens + second.usage.outputTokens };
    const p2 = this.validate(second.text, schema, o.prepare);
    if (p2.ok) return { value: p2.value, text: second.text, usage };
    // The first reply and what was wrong with it as well: a model that answers a repair with "{}" hides why it failed.
    this.deps.logger.info({ module: 'llm', caller: o.module, agent: o.agent, model, first: first.text.slice(0, 4000), firstError: p1.error.slice(0, 300), reply: second.text.slice(0, 2000) }, 'reply still invalid after repair');
    throw new AttemptError(new LlmError('schema_invalid', `invalid reply after repair: ${p2.error}`, { model }), usage);
  }

  private validate<T>(text: string, schema: z.ZodType<T>, prepare?: (json: unknown) => unknown): { ok: true; value: T } | { ok: false; error: string } {
    let json: unknown;
    try {
      json = extractJson(text);
      if (prepare) json = prepare(json);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const r = schema.safeParse(json);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error).slice(0, 600) };
  }

  private async request(
    o: LlmCallOptions<unknown>,
    model: string,
    spec: CallSpec,
    messages: readonly ChatMessage[],
    format: { type: 'json_object' } | { type: 'json_schema'; json_schema: Record<string, unknown> } | undefined,
  ): Promise<Reply> {
    const base = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: spec.maxTokens,
      // A model setting, not a provider, billing or cache option (§22.2), sent only to models that reason.
      ...(spec.effort && this.deps.router.allowlist.get(model)?.capabilities.has('reasoning') ? { reasoning_effort: spec.effort } : {}),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    };
    if (o.onText && !format) return this.stream(o, model, spec, messages, base);
    const timeout = AbortSignal.timeout(spec.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    try {
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
      return { text, usage, truncated: res.choices[0]?.finish_reason === 'length' };
    } catch (err) {
      if (err instanceof AttemptError) throw err;
      if (timeout.aborted && !o.signal?.aborted) throw new LlmError('timeout', `no reply within ${spec.timeoutMs} ms`, { model });
      throw err;
    }
  }

  /**
   * A streamed text reply (Talking). The tier's timeout is for the first piece to arrive; after that the stream may
   * take up to three times as long in all, with no pause between pieces longer than the timeout. A reply cut off by a
   * timeout once it was under way is a failure like any other: what streamed so far was only ever a draft.
   */
  private async stream(o: LlmCallOptions<unknown>, model: string, spec: CallSpec, messages: readonly ChatMessage[], base: Record<string, unknown>): Promise<Reply> {
    const ac = new AbortController();
    const signal = o.signal ? AbortSignal.any([o.signal, ac.signal]) : ac.signal;
    let why = `no reply within ${spec.timeoutMs} ms`;
    const cut = (reason: string) => () => {
      why = reason;
      ac.abort(new Error(reason));
    };
    let gap = setTimeout(cut(`no reply within ${spec.timeoutMs} ms`), spec.timeoutMs);
    const total = setTimeout(cut(`the reply took over ${spec.timeoutMs * 3} ms`), spec.timeoutMs * 3);
    try {
      const stream = await this.openai.chat.completions.create(
        { ...(base as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming), stream: true, stream_options: { include_usage: true } },
        { signal, timeout: spec.timeoutMs * 3 },
      );
      let text = '';
      let usage: LlmUsage | null = null;
      let truncated = false;
      for await (const chunk of stream) {
        clearTimeout(gap);
        gap = setTimeout(cut(`the reply stalled for ${spec.timeoutMs} ms`), spec.timeoutMs);
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          text += delta;
          o.onText?.(delta);
        }
        if (chunk.choices[0]?.finish_reason === 'length') truncated = true;
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
      if (ac.signal.aborted && !o.signal?.aborted) throw new LlmError('timeout', why, { model });
      return { text, usage: usage ?? { inputTokens: estimateTokens(messages), outputTokens: Math.ceil(text.length / 4) }, truncated };
    } catch (err) {
      if (err instanceof AttemptError || err instanceof LlmError) throw err;
      if (ac.signal.aborted && !o.signal?.aborted) throw new LlmError('timeout', why, { model });
      throw err;
    } finally {
      clearTimeout(gap);
      clearTimeout(total);
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
