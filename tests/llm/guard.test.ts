import { describe, expect, it } from 'vitest';
import {
  ForbiddenEndpointError,
  ForbiddenOptionError,
  SUBSCRIPTION_BASE_URL,
  checkEndpoint,
  createGuardedFetch,
  isForbiddenHeader,
  sanitizeBody,
  sanitizeHeaders,
} from '@agora/llm/guard';
import { UsageSchema, evaluateKeyLock } from '@agora/llm/usage';

describe('endpoint allowlist (§22.5)', () => {
  it('allows only the subscription endpoints and metadata', () => {
    expect(() => checkEndpoint('POST', `${SUBSCRIPTION_BASE_URL}/chat/completions`, false)).not.toThrow();
    expect(() => checkEndpoint('GET', `${SUBSCRIPTION_BASE_URL}/models`, false)).not.toThrow();
    expect(() => checkEndpoint('GET', `${SUBSCRIPTION_BASE_URL}/models?detailed=true`, false)).not.toThrow();
    expect(() => checkEndpoint('GET', `${SUBSCRIPTION_BASE_URL}/usage`, false)).not.toThrow();
    expect(() => checkEndpoint('GET', 'https://nano-gpt.com/api/v1/models?detailed=true', false)).not.toThrow();
    expect(() => checkEndpoint('GET', 'https://nano-gpt.com/api/v1/check-balance', false)).not.toThrow();
  });

  it('never allows inference outside the subscription path', () => {
    for (const url of [
      'https://nano-gpt.com/api/v1/chat/completions',
      'https://nano-gpt.com/api/paid/v1/chat/completions',
      'https://api.nano-gpt.com/api/subscription/v1/chat/completions',
      'https://example.com/api/subscription/v1/chat/completions',
      `${SUBSCRIPTION_BASE_URL}/images/generations`,
      `${SUBSCRIPTION_BASE_URL}/audio/speech`,
      `${SUBSCRIPTION_BASE_URL}/responses`,
      `${SUBSCRIPTION_BASE_URL}/messages`,
      `${SUBSCRIPTION_BASE_URL}/moderations`,
    ]) {
      expect(() => checkEndpoint('POST', url, false), url).toThrow(ForbiddenEndpointError);
    }
    expect(() => checkEndpoint('GET', `${SUBSCRIPTION_BASE_URL}/chat/completions`, false)).toThrow(ForbiddenEndpointError);
    expect(() => checkEndpoint('GET', `${SUBSCRIPTION_BASE_URL}/models?provider=x`, false)).toThrow(ForbiddenEndpointError);
  });

  it('allows remote embeddings only when explicitly enabled', () => {
    expect(() => checkEndpoint('POST', `${SUBSCRIPTION_BASE_URL}/embeddings`, false)).toThrow(ForbiddenEndpointError);
    expect(() => checkEndpoint('POST', `${SUBSCRIPTION_BASE_URL}/embeddings`, true)).not.toThrow();
  });
});

describe('request stripping (§22.2)', () => {
  it('strips provider, billing-mode, BYOK, payment, cache and moderation headers', () => {
    const h = new Headers({
      'X-Provider': 'openai',
      'X-Billing-Mode': 'paygo',
      'x-nanogpt-billing-mode': 'paygo',
      'x-use-byok': 'true',
      'x-byok-fallback-to-credits': 'true',
      'x-payment': 'abc',
      'x-x402-payment-id': '1',
      'x-prompt-caching-cut-after': '2',
      'x-cache-depth': '3',
      moderation: 'on',
      authorization: 'Bearer k',
      'content-type': 'application/json',
    });
    const removed = sanitizeHeaders(h);
    expect(removed.length).toBe(10);
    expect([...h.keys()].sort()).toEqual(['authorization', 'content-type']);
    expect(isForbiddenHeader('X-Some-Billing-Thing')).toBe(true);
  });

  it('strips billing, provider and caching body fields, deep cache_control and non-default service_tier', () => {
    const { body, removed } = sanitizeBody({
      model: 'm1',
      billing_mode: 'paygo',
      billingMode: 'paygo',
      provider: 'x',
      prompt_caching: { enabled: true },
      promptCaching: true,
      caching: true,
      stickyProvider: true,
      service_tier: 'priority',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    });
    expect(removed.sort()).toEqual(
      ['billing_mode', 'billingMode', 'provider', 'prompt_caching', 'promptCaching', 'caching', 'stickyProvider', 'service_tier', 'messages[0].content[0].cache_control'].sort(),
    );
    expect(body).toEqual({ model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    expect(sanitizeBody({ model: 'm', service_tier: 'auto' }).body.service_tier).toBe('auto');
  });

  it('rejects paid model suffixes', () => {
    expect(() => sanitizeBody({ model: 'gpt-x:online' })).toThrow(ForbiddenOptionError);
    expect(() => sanitizeBody({ model: 'gpt-x:online/linkup-deep' })).toThrow(ForbiddenOptionError);
    expect(() => sanitizeBody({ model: 'gpt-x:caching' })).toThrow(ForbiddenOptionError);
  });

  it('the guarded fetch sanitizes before sending and forbids redirects', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const base = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: typeof url === 'string' ? url : 'non-string', init: init ?? {} };
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const strips: unknown[] = [];
    const f = createGuardedFetch({ baseFetch: base, onStrip: (r) => strips.push(r) });
    await f(`${SUBSCRIPTION_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'X-Provider': 'p', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', billing_mode: 'paygo', messages: [] }),
    });
    expect(seen).not.toBeNull();
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(new Headers(s.init.headers).has('x-provider')).toBe(false);
    expect(JSON.parse(s.init.body as string)).toEqual({ model: 'm', messages: [] });
    expect(s.init.redirect).toBe('error');
    expect(strips).toEqual([{ headers: ['x-provider'], fields: ['billing_mode'] }]);
    await expect(f('https://nano-gpt.com/api/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      ForbiddenEndpointError,
    );
  });
});

describe('key lock (§22.1)', () => {
  const base = { active: true, state: 'active', routing: { recommendedMode: 'subscription', paidSpendPolicyAllowsBalance: false } };

  it('accepts a subscription-only active key', () => {
    expect(evaluateKeyLock(UsageSchema.parse(base), false)).toEqual({ ok: true, fatal: null, warnings: [] });
  });

  it('refuses a key that can spend balance unless allowPaidKey', () => {
    const u = UsageSchema.parse({ ...base, routing: { paidSpendPolicyAllowsBalance: true } });
    const v = evaluateKeyLock(u, false);
    expect(v.ok).toBe(false);
    expect(v.fatal).toMatch(/Subscription only/);
    expect(evaluateKeyLock(u, true).ok).toBe(true);
  });

  it('refuses inactive subscriptions and warns in grace', () => {
    expect(evaluateKeyLock(UsageSchema.parse({ ...base, active: false }), false).ok).toBe(false);
    expect(evaluateKeyLock(UsageSchema.parse({ ...base, state: 'inactive' }), false).ok).toBe(false);
    const g = evaluateKeyLock(UsageSchema.parse({ ...base, state: 'grace' }), false);
    expect(g.ok).toBe(true);
    expect(g.warnings.join()).toMatch(/grace/);
  });

  it('warns when the billing policy is not reported', () => {
    const v = evaluateKeyLock(UsageSchema.parse({ active: true, state: 'active' }), false);
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/cannot be verified/);
  });

  it('parses the documented usage shape including nulls', () => {
    const u = UsageSchema.parse({
      active: true,
      state: 'active',
      limits: { dailyInputTokens: null, weeklyInputTokens: 5_000_000, dailyImages: null },
      dailyInputTokens: null,
      weeklyInputTokens: { used: 100, remaining: 4_999_900, percentUsed: 0.00002, resetAt: 1792700000000, degraded: false },
      dailyImages: null,
      period: { currentPeriodEnd: null },
      routing: { recommendedMode: 'subscription', reason: 'ok', subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: false },
      allowOverage: false,
    });
    expect(u.weeklyInputTokens?.remaining).toBe(4_999_900);
  });
});
