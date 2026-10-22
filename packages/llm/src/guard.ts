// Subscription lock, layers 2 and 5 (§22.2, §22.5): the HTTP layer only reaches allowlisted NanoGPT endpoints,
// and every request is stripped of anything NanoGPT documents (or advertises in its CORS headers) as bypassing
// the subscription. This file holds the ONLY copy of the forbidden option names (scripts/check-forbidden.ts).
// No error path ever changes the base URL or adds billing or provider headers.

/** Hard-coded; config cannot override it unless llm.allowPaidKey is true (§22.2). */
export const SUBSCRIPTION_BASE_URL = 'https://nano-gpt.com/api/subscription/v1';
export const NANOGPT_ORIGIN = 'https://nano-gpt.com';

export class ForbiddenEndpointError extends Error {
  constructor(method: string, url: string) {
    super(`blocked ${method} ${url}: not an allowlisted subscription endpoint (§22.5)`);
    this.name = 'ForbiddenEndpointError';
  }
}

export class ForbiddenOptionError extends Error {
  constructor(what: string) {
    super(`blocked request option ${what}: it bypasses the subscription (§22.2)`);
    this.name = 'ForbiddenOptionError';
  }
}

interface EndpointRule {
  methods: readonly string[];
  path: string;
  /** Allowed query keys (others are rejected). */
  query?: readonly string[];
  /** Only when remote embeddings passed the §22.5 checks. */
  embeddingsOnly?: boolean;
}

const ENDPOINTS: readonly EndpointRule[] = [
  { methods: ['POST'], path: '/api/subscription/v1/chat/completions' },
  { methods: ['GET'], path: '/api/subscription/v1/models', query: ['detailed'] },
  { methods: ['GET'], path: '/api/subscription/v1/usage' },
  // Metadata only (no inference, no billing).
  { methods: ['GET'], path: '/api/v1/models', query: ['detailed'] },
  // Balance lookup (checked live: POST /api/check-balance with x-api-key; /api/v1/check-balance is a 404).
  { methods: ['POST'], path: '/api/check-balance' },
  { methods: ['POST'], path: '/api/subscription/v1/embeddings', embeddingsOnly: true },
];

/** Headers that select a provider or billing mode, BYOK fallbacks to credits, paid add-ons or cache controls. */
const FORBIDDEN_HEADER_EXACT = new Set([
  'x-provider',
  'x-billing-mode',
  'x-nanogpt-billing-mode',
  'x-payment',
  'x-x402',
  'x-x402-payment-id',
  'x-use-byok',
  'x-byok-provider',
  'x-byok-disable-fallbacks',
  'x-byok-fallback-to-credits',
  'x-prompt-caching-cut-after',
  'x-prompt-caching-sticky-provider',
  'x-anthropic-cache-depth',
  'x-cache-depth',
  'moderation',
  'anthropic-beta',
]);
const FORBIDDEN_HEADER_PATTERNS = [/^x-byok/i, /^x-x402/i, /billing/i, /^x-prompt-caching/i, /cache-depth/i, /^x-payment/i];

/** Top-level body fields that bypass the subscription or enable paid features. */
const FORBIDDEN_BODY_FIELDS = new Set([
  'billing_mode',
  'billingMode',
  'provider',
  'providers',
  'prompt_caching',
  'promptCaching',
  'caching',
  'stickyProvider',
  'stickyprovider',
  'byok',
]);
/** Removed wherever they appear (content blocks, tools, …). */
const FORBIDDEN_DEEP_FIELDS = new Set(['cache_control']);
/** service_tier values other than the default cannot be assumed to be covered (§22.2). */
const ALLOWED_SERVICE_TIERS = new Set(['auto', 'default']);
/** Paid model suffixes (web search, cache routing). */
const FORBIDDEN_MODEL_SUFFIX = /:(online|caching)(\/.*)?$/i;

export function isForbiddenHeader(name: string): boolean {
  const n = name.toLowerCase();
  return FORBIDDEN_HEADER_EXACT.has(n) || FORBIDDEN_HEADER_PATTERNS.some((re) => re.test(n));
}

export interface StripReport {
  headers: string[];
  fields: string[];
}

function stripDeep(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) return value.map((v, i) => stripDeep(v, `${path}[${i}]`, removed));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_DEEP_FIELDS.has(k)) {
        removed.push(`${path}.${k}`);
        continue;
      }
      out[k] = stripDeep(v, `${path}.${k}`, removed);
    }
    return out;
  }
  return value;
}

/** Returns a sanitized copy of a chat-completions body plus what was removed. Throws on paid model suffixes. */
export function sanitizeBody(body: Record<string, unknown>): { body: Record<string, unknown>; removed: string[] } {
  const removed: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (FORBIDDEN_BODY_FIELDS.has(k)) {
      removed.push(k);
      continue;
    }
    if (k === 'service_tier') {
      if (typeof v === 'string' && ALLOWED_SERVICE_TIERS.has(v)) out[k] = v;
      else removed.push(k);
      continue;
    }
    out[k] = stripDeep(v, k, removed);
  }
  const model = out.model;
  if (typeof model === 'string' && FORBIDDEN_MODEL_SUFFIX.test(model)) {
    throw new ForbiddenOptionError(`model suffix in "${model}"`);
  }
  return { body: out, removed };
}

export function sanitizeHeaders(headers: Headers): string[] {
  const removed: string[] = [];
  for (const name of [...headers.keys()]) {
    if (isForbiddenHeader(name)) {
      headers.delete(name);
      removed.push(name);
    }
  }
  return removed;
}

export function checkEndpoint(method: string, rawUrl: string, allowEmbeddings: boolean): void {
  const url = new URL(rawUrl);
  if (url.origin !== NANOGPT_ORIGIN) throw new ForbiddenEndpointError(method, rawUrl);
  const rule = ENDPOINTS.find((r) => r.path === url.pathname.replace(/\/+$/, ''));
  if (!rule || !rule.methods.includes(method.toUpperCase())) throw new ForbiddenEndpointError(method, rawUrl);
  if (rule.embeddingsOnly && !allowEmbeddings) throw new ForbiddenEndpointError(method, rawUrl);
  for (const key of url.searchParams.keys()) {
    if (!rule.query?.includes(key)) throw new ForbiddenEndpointError(method, rawUrl);
  }
}

export interface GuardedFetchOptions {
  baseFetch?: typeof fetch;
  allowEmbeddings?: boolean;
  /** Called whenever something had to be stripped (it should never happen; log loudly). */
  onStrip?: (report: StripReport) => void;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A fetch that can only reach allowlisted endpoints and never sends bypass options. Used for every NanoGPT
 * request (the openai SDK gets it as its `fetch`).
 */
export function createGuardedFetch(opts: GuardedFetchOptions = {}): typeof fetch {
  const base = opts.baseFetch ?? fetch;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    checkEndpoint(method, url, opts.allowEmbeddings ?? false);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const strippedHeaders = sanitizeHeaders(headers);
    let body = init?.body;
    const strippedFields: string[] = [];
    if (typeof body === 'string' && body.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new ForbiddenOptionError('non-JSON request body');
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const s = sanitizeBody(parsed as Record<string, unknown>);
        strippedFields.push(...s.removed);
        body = JSON.stringify(s.body);
      }
    } else if (body !== undefined && body !== null) {
      throw new ForbiddenOptionError('non-string request body');
    }
    if (strippedHeaders.length > 0 || strippedFields.length > 0) {
      opts.onStrip?.({ headers: strippedHeaders, fields: strippedFields });
    }
    return base(url, { ...init, method, headers, body, redirect: 'error' });
  };
  return guarded;
}
