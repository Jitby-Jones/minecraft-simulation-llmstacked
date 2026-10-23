// A scripted stand-in for NanoGPT's subscription API (models, usage, chat completions incl. streaming). It records
// every request it receives, so tests can assert what the guarded client actually sent.

export interface FakeModel {
  id: string;
  caps?: string[];
  price?: [number, number];
  ownedBy?: string;
  context?: number;
  aliases?: string[];
  modality?: string;
}

export interface FakeUsage {
  active?: boolean;
  state?: string;
  weeklyPercent?: number | null;
  weeklyRemaining?: number;
  resetInMs?: number;
  degraded?: boolean;
  recommendedMode?: string;
  paidSpendPolicyAllowsBalance?: boolean | undefined;
}

export interface ChatCall {
  model: string;
  body: Record<string, unknown>;
  headers: Headers;
  /** How many chat requests this model has received, including this one. */
  n: number;
}

export interface FakeReply {
  status?: number;
  /** Assistant text for a 200 reply. */
  text?: string;
  /** Raw JSON body (errors). */
  json?: unknown;
  headers?: Record<string, string>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  delayMs?: number;
  /** Streamed pieces (stream: true requests). */
  chunks?: string[];
  /** A pause before each streamed piece after the first (a slow or stalled stream). */
  chunkDelayMs?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('This operation was aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('This operation was aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeNanoGpt {
  models: FakeModel[];
  usage: FakeUsage = {};
  chat: (call: ChatCall) => FakeReply | Promise<FakeReply> = () => ({ text: 'ok' });
  readonly requests: RecordedRequest[] = [];
  private readonly perModel = new Map<string, number>();
  aborted = 0;

  constructor(models: FakeModel[]) {
    this.models = models;
  }

  chatRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.endsWith('/chat/completions'));
  }

  count(path: string): number {
    return this.requests.filter((r) => new URL(r.url).pathname === path).length;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.requests.push({ method, url, headers, body });
    const path = new URL(url).pathname;
    if (path === '/api/subscription/v1/models') return json(200, { object: 'list', data: this.models.map((m) => this.modelJson(m)) });
    if (path === '/api/subscription/v1/usage') return json(200, this.usageJson());
    if (path !== '/api/subscription/v1/chat/completions' || !body) return json(404, { error: { message: 'not found', type: 'not_found_error' } });
    const model = String(body.model);
    const n = (this.perModel.get(model) ?? 0) + 1;
    this.perModel.set(model, n);
    const reply = await this.chat({ model, body, headers, n });
    try {
      if (reply.delayMs) await abortableDelay(reply.delayMs, init?.signal);
    } catch (err) {
      this.aborted++;
      throw err;
    }
    const status = reply.status ?? 200;
    if (status !== 200) return json(status, reply.json ?? { error: { message: `HTTP ${status}` } }, reply.headers);
    const usage = reply.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
    if (body.stream === true) {
      const enc = new TextEncoder();
      const chunks = reply.chunks ?? [reply.text ?? ''];
      const gap = reply.chunkDelayMs ?? 0;
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (const [i, c] of chunks.entries()) {
              if (i > 0 && gap > 0) await abortableDelay(gap, signal);
              const frame = { id: 'c1', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] };
              controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
            }
          } catch (err) {
            controller.error(err);
            return;
          }
          const last = { id: 'c1', object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json(200, {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? '' }, finish_reason: 'stop' }],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    });
  };

  private modelJson(m: FakeModel): Record<string, unknown> {
    const caps = new Set(m.caps ?? []);
    return {
      id: m.id,
      object: 'model',
      owned_by: m.ownedBy ?? m.id.split('-')[1] ?? 'x',
      name: m.id,
      context_length: m.context ?? 131072,
      max_output_tokens: 8192,
      architecture: { modality: m.modality ?? 'text->text', output_modalities: [m.modality?.endsWith('decisions') ? 'decisions' : 'text'] },
      capabilities: {
        structured_output: caps.has('structured_output'),
        tool_calling: caps.has('tool_calling'),
        reasoning: caps.has('reasoning'),
        vision: false,
      },
      pricing: { prompt: m.price?.[0] ?? 0.1, completion: m.price?.[1] ?? 0.2, currency: 'USD', unit: 'per_million_tokens' },
      ...(m.aliases ? { aliases: m.aliases } : {}),
    };
  }

  private usageJson(): Record<string, unknown> {
    const u = this.usage;
    const resetAt = Date.now() + (u.resetInMs ?? 3 * 24 * 3_600_000);
    const percent = u.weeklyPercent === undefined ? 0.1 : u.weeklyPercent;
    return {
      active: u.active ?? true,
      state: u.state ?? 'active',
      limits: { weeklyInputTokens: 60_000_000, dailyInputTokens: null },
      weeklyInputTokens: {
        used: percent === null ? null : Math.round(60_000_000 * percent),
        remaining: u.weeklyRemaining ?? (percent === null ? null : Math.round(60_000_000 * (1 - percent))),
        percentUsed: percent,
        resetAt,
        degraded: u.degraded ?? false,
      },
      dailyInputTokens: null,
      routing: {
        recommendedMode: u.recommendedMode ?? 'subscription',
        ...('paidSpendPolicyAllowsBalance' in u ? { paidSpendPolicyAllowsBalance: u.paidSpendPolicyAllowsBalance } : { paidSpendPolicyAllowsBalance: false }),
      },
    };
  }
}

/** Nine allowlisted models: three per size class from three providers, plus one without structured output. */
export function standardModels(): FakeModel[] {
  return [
    { id: 'p1-fast', ownedBy: 'p1', caps: ['structured_output'], price: [0.05, 0.1] },
    { id: 'p2-fast', ownedBy: 'p2', caps: ['structured_output'], price: [0.06, 0.12] },
    { id: 'p3-fast', ownedBy: 'p3', caps: ['structured_output'], price: [0.07, 0.14] },
    { id: 'p1-mid', ownedBy: 'p1', caps: ['structured_output', 'tool_calling'], price: [0.5, 1.5] },
    { id: 'p2-mid', ownedBy: 'p2', caps: ['structured_output', 'tool_calling'], price: [0.6, 1.6] },
    { id: 'p3-mid', ownedBy: 'p3', caps: ['structured_output', 'tool_calling'], price: [0.4, 1.4] },
    { id: 'p1-big', ownedBy: 'p1', caps: ['structured_output', 'tool_calling', 'reasoning'], price: [1.5, 4] },
    { id: 'p2-big', ownedBy: 'p2', caps: ['structured_output', 'reasoning'], price: [1.2, 3.5] },
    { id: 'p3-big', ownedBy: 'p3', caps: ['structured_output', 'reasoning'], price: [1.1, 3] },
    { id: 'p4-plain', ownedBy: 'p4', caps: [], price: [0.01, 0.02] },
  ];
}

/**
 * Which structured reply a chat request asks for: the json_schema name, or the name the client puts in parentheses in
 * its reply-format line (`Reply with only a JSON object (decision) …`); undefined for a plain text request.
 */
export function schemaNameOf(body: Record<string, unknown> | null | undefined): string | undefined {
  const named = (body?.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
  if (named) return named;
  const messages = (body?.messages as { role: string; content: string }[] | undefined) ?? [];
  for (const m of messages) {
    const hit = /(?:^|\n)Reply with only (?:a|the) JSON object \(([A-Za-z0-9_-]+)\)/.exec(m.content);
    if (m.role === 'system' && hit?.[1]) return hit[1];
  }
  return undefined;
}
