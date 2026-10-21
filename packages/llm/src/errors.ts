// Error classes and the §22.6 classifier. NanoGPT answers in three shapes (checked live in its error reference):
// OpenAI-style { error: { message, type, code } }, legacy { error: "…", status }, and { error: <int>, message }.
// Codes seen there: model_not_found (404), model_not_allowed (403), model_not_available (503),
// rate_limit_exceeded / daily_rpd_limit_exceeded / daily_usd_limit_exceeded (429, Retry-After in seconds).

export type LlmErrorKind =
  | 'not_in_subscription' // refused locally before sending (§22.3)
  | 'model_gone' // 400/404/503 model not found / not available: lineup changed
  | 'not_covered' // 402/403 or "subscription only": uncovered model or quota issue
  | 'rate_limited' // 429 per-second throughput
  | 'daily_limit' // 429 per-key daily cap: nothing more until the reset
  | 'provider' // 5xx, 408, 504: provider trouble
  | 'timeout' // our tier timeout fired
  | 'auth' // 401: key missing, revoked or expired
  | 'context_length' // prompt too long for this model
  | 'bad_request' // other 4xx: fix the request, don't retry
  | 'schema_invalid' // reply failed zod validation after the repair retry
  | 'aborted'; // the caller's signal fired (stale state, shutdown)

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly opts: { status?: number; model?: string; retryAfterMs?: number; code?: string } = {},
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** §22.3: `llm.call()` refuses a model that is not on the subscription allowlist before anything is sent. */
export class ModelNotInSubscription extends LlmError {
  constructor(model: string) {
    super('not_in_subscription', `model ${model} is not in the NanoGPT subscription list; refusing to send`, { model });
    this.name = 'ModelNotInSubscription';
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function bodyParts(body: unknown): { message: string; code: string; type: string } {
  if (typeof body === 'string') return { message: body, code: '', type: '' };
  const b = (body ?? {}) as Record<string, unknown>;
  const err = b.error;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return { message: str(e.message), code: str(e.code), type: str(e.type) };
  }
  return { message: typeof err === 'string' ? err : str(b.message), code: str(b.code), type: str(b.type) };
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Maps an HTTP failure to the §22.6 action class. */
export function classifyHttpError(status: number, body: unknown, retryAfter?: string | null, model?: string): LlmError {
  const { message, code, type } = bodyParts(body);
  const text = `${code} ${type} ${message}`.toLowerCase();
  const retryAfterMs = parseRetryAfter(retryAfter);
  const o = { status, model, retryAfterMs, code: code || undefined };
  const msg = `HTTP ${status}${code ? ` ${code}` : ''}: ${message || type || 'no message'}`;
  if (/model_not_found|model_not_available|model not found|not available|unknown model|no such model|does not exist/.test(text)) {
    return new LlmError('model_gone', msg, o);
  }
  if (status === 402 || /model_not_allowed|not covered|subscription[ -]only|not included in (your )?subscription|insufficient balance/.test(text)) {
    return new LlmError('not_covered', msg, o);
  }
  if (status === 401) return new LlmError('auth', msg, o);
  if (status === 429) {
    return /daily_rpd_limit|daily_usd_limit|daily limit/.test(text) ? new LlmError('daily_limit', msg, o) : new LlmError('rate_limited', msg, o);
  }
  if (status === 403) return new LlmError('not_covered', msg, o);
  if (status === 408 || status >= 500) return new LlmError('provider', msg, o);
  if (/context_length|context length|too many tokens|maximum context/.test(text)) return new LlmError('context_length', msg, o);
  return new LlmError('bad_request', msg, o);
}
