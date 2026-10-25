// M2 building blocks: the quota as the operator sees it, error classes, circuit breaker, rate limiter, single-flight,
// model-list parsing and tier resolution.

import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  CostMeter,
  LocalRateLimiter,
  ModelAllowlist,
  QuotaWatch,
  SUPERSEDED,
  SingleFlight,
  type TierSpec,
  type Usage,
  classifyHttpError,
  describeQuota,
  extractJson,
  parseModelList,
  parseRetryAfter,
  quotaView,
  resolveTiers,
} from '@agora/llm';
import { type Logger, MODULE_PRIORITY, nullLogger } from '@agora/shared';

const usage = (weekly: number | null, extra: Partial<Usage> = {}): Usage => ({
  active: true,
  state: 'active',
  weeklyInputTokens: { used: 0, remaining: 1000, percentUsed: weekly, resetAt: Date.now() + 86_400_000, degraded: false },
  routing: { recommendedMode: 'subscription', paidSpendPolicyAllowsBalance: false },
  ...extra,
});

describe('the quota, read for the operator only (owner request, 2026-10-25)', () => {
  it('reads what NanoGPT reports, and says it in a line', () => {
    const reset = Date.now() + 86_400_000;
    const q = quotaView(usage(0.42, { weeklyInputTokens: { used: 25_200_000, remaining: 34_800_000, percentUsed: 0.42, resetAt: reset } }));
    expect(q).toMatchObject({ weeklyPercent: 0.42, remaining: 34_800_000, resetAt: reset, recommendedMode: 'subscription' });
    expect(describeQuota(q)).toBe(`quota 42.0% of the week used, resets ${new Date(reset).toISOString()}`);
    expect(quotaView(usage(null)).weeklyPercent).toBeNull();
    expect(describeQuota(null)).toBe('quota not known');
  });

  it('says once when the subscription stops covering calls (they are refused, never paid for)', async () => {
    const warned: string[] = [];
    const logger = { ...nullLogger(), warn: (_o: unknown, m?: string) => void warned.push(m ?? '') } as Logger;
    let next = usage(0.97);
    const watch = new QuotaWatch({ fetchUsage: () => Promise.resolve(next), pollMs: 60_000, logger });
    await watch.poll();
    expect(warned).toEqual([]);
    next = usage(1.0, { routing: { recommendedMode: 'paygo' } });
    await watch.poll();
    await watch.poll();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('calls will be refused until the reset or more is bought');
  });
});

describe('NanoGPT errors (§22.6)', () => {
  it('classifies the documented shapes and codes', () => {
    expect(classifyHttpError(404, { error: { message: 'Model not found', type: 'not_found_error', code: 'model_not_found' } }).kind).toBe('model_gone');
    expect(classifyHttpError(503, { error: { message: 'x', code: 'model_not_available' } }).kind).toBe('model_gone');
    expect(classifyHttpError(403, { error: { message: 'nope', code: 'model_not_allowed' } }).kind).toBe('not_covered');
    expect(classifyHttpError(402, { error: 'Insufficient balance', status: 402 }).kind).toBe('not_covered');
    expect(classifyHttpError(400, { error: 400, message: 'This model is not included in your subscription' }).kind).toBe('not_covered');
    expect(classifyHttpError(401, { error: { message: 'bad key', type: 'authentication_error' } }).kind).toBe('auth');
    const rl = classifyHttpError(429, { error: { message: 'slow', code: 'rate_limit_exceeded' } }, '2');
    expect(rl.kind).toBe('rate_limited');
    expect(rl.opts.retryAfterMs).toBe(2000);
    expect(classifyHttpError(429, { error: { message: 'x', code: 'daily_rpd_limit_exceeded' } }).kind).toBe('daily_limit');
    expect(classifyHttpError(500, { error: { message: 'boom', type: 'server_error' } }).kind).toBe('provider');
    expect(classifyHttpError(400, { error: { message: 'too long', code: 'context_length_exceeded' } }).kind).toBe('context_length');
    expect(classifyHttpError(400, { error: { message: 'bad', code: 'invalid_parameter_value' } }).kind).toBe('bad_request');
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const ms = parseRetryAfter(new Date(Date.now() + 10_000).toUTCString()) ?? 0;
    expect(ms).toBeGreaterThan(8000);
  });
});

describe('circuit breaker, rate limiter, single-flight', () => {
  it('opens after 3 consecutive failures for 5 minutes', () => {
    let t = 0;
    const c = new CircuitBreaker({ now: () => t });
    expect(c.failure('m')).toBe(false);
    c.success('m');
    c.failure('m');
    c.failure('m');
    expect(c.failure('m')).toBe(true);
    expect(c.isOpen('m')).toBe(true);
    t += 5 * 60_000;
    expect(c.isOpen('m')).toBe(false);
  });

  it('serves waiters by module priority (Talking first) and slows down after a 429', async () => {
    const l = new LocalRateLimiter({ rps: 50, burst: 1 });
    const order: string[] = [];
    await l.acquire(MODULE_PRIORITY.talking);
    const p = [
      l.acquire(MODULE_PRIORITY.reflection).then(() => order.push('reflection')),
      l.acquire(MODULE_PRIORITY.cc).then(() => order.push('cc')),
      l.acquire(MODULE_PRIORITY.talking).then(() => order.push('talking')),
    ];
    await Promise.all(p);
    expect(order).toEqual(['talking', 'cc', 'reflection']);
    l.backOff();
    expect(l.rate).toBeCloseTo(40);
    const ac = new AbortController();
    const waiting = l.acquire(3, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow();
  });

  it('keeps one call in flight per key and replaces the queued one', async () => {
    const sf = new SingleFlight<string>();
    let release!: () => void;
    const first = sf.run('cc', () => new Promise<string>((r) => (release = () => r('first'))));
    const second = sf.run('cc', () => Promise.resolve('second'));
    const third = sf.run('cc', () => Promise.resolve('third'));
    expect(await second).toBe(SUPERSEDED);
    release();
    expect(await first).toBe('first');
    expect(await third).toBe('third');
    expect(sf.inFlight('cc')).toBe(false);
  });
});

describe('model list and tiers (§22.3)', () => {
  const raw = {
    data: [
      { id: 'a/small', owned_by: 'a', capabilities: { structured_output: true }, pricing: { prompt: 0.1, completion: 0.1 } },
      { id: 'b/small', owned_by: 'b', capabilities: { structured_output: true }, pricing: { prompt: 0.2, completion: 0.2 }, aliases: ['B/Small'] },
      { id: 'c/small', owned_by: 'c', capabilities: { structured_output: true }, pricing: { prompt: 0.3, completion: 0.3 } },
      { id: 'd/think:thinking', owned_by: 'd', capabilities: { structured_output: true, reasoning: true }, pricing: { prompt: 0.01, completion: 0.01 } },
      { id: 'kev', owned_by: 'k', architecture: { modality: 'text->decisions', output_modalities: ['decisions'] }, capabilities: { structured_output: true } },
      { id: 'auto-model', owned_by: 'nano', capabilities: { structured_output: true } },
      { name: 'no id' },
    ],
  };
  const spec: TierSpec = { primary: 'auto', fallbacks: ['auto'], need: ['structured_output'], timeoutMs: 2500 };

  it('parses leniently, flags non-chat models and resolves aliases', () => {
    const models = parseModelList(raw);
    expect(models.map((m) => m.id)).toEqual(['a/small', 'b/small', 'c/small', 'd/think:thinking', 'kev', 'auto-model']);
    expect(models.find((m) => m.id === 'kev')?.chat).toBe(false);
    const allow = new ModelAllowlist(models);
    expect(allow.resolve('b/small')).toBe('b/small');
    expect(allow.resolve('b/SMALL')).toBe('b/small');
    allow.removeForSession('b/small', 'not covered');
    expect(allow.has('B/Small')).toBe(false);
    expect(() => parseModelList({ nope: true })).toThrow();
  });

  it('never auto-picks routers or decision models, keeps thinking variants last for L1, honors bench data', () => {
    const allow = new ModelAllowlist(parseModelList(raw));
    const specs = { L1: spec, L2: spec, L3: spec };
    const r = resolveTiers(allow, specs);
    expect(r.chains.L1).toEqual(['a/small', 'b/small', 'c/small', 'd/think:thinking']);
    expect(r.chains.L1).not.toContain('kev');
    expect(r.chains.L1).not.toContain('auto-model');
    const bench = {
      measuredAt: 'now',
      results: [
        { model: 'c/small', calls: 20, okRate: 1, jsonOkRate: 1, p50Ms: 300, p90Ms: 600 },
        { model: 'b/small', calls: 20, okRate: 1, jsonOkRate: 1, p50Ms: 500, p90Ms: 900 },
        { model: 'a/small', calls: 20, okRate: 0.5, jsonOkRate: 1, p50Ms: 100, p90Ms: 200 },
      ],
    };
    expect(resolveTiers(allow, specs, bench).chains.L1.slice(0, 2)).toEqual(['c/small', 'b/small']);
    // A measurement taken on one tier's prompts orders that tier only: fast at planning isn't fast at talk.
    const planning = { measuredAt: 'now', results: bench.results.map((x) => ({ ...x, tier: 'L3' as const })) };
    expect(resolveTiers(allow, specs, planning).chains.L1).toEqual(r.chains.L1);
    expect(resolveTiers(allow, specs, planning).chains.L3.slice(0, 2).sort()).toEqual(['b/small', 'c/small']);
    const configured = resolveTiers(allow, { ...specs, L1: { ...spec, primary: 'b/small', fallbacks: ['missing/model'] } });
    expect(configured.chains.L1[0]).toBe('b/small');
    expect(configured.chains.L1.length).toBeGreaterThanOrEqual(3);
    expect(configured.notes.some((n) => n.includes('missing/model'))).toBe(true);
  });

  it('pulls JSON out of chatty or fenced replies', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
    // A thought with bare quotes in it, as a model asked in plain wrote one, and a line break inside a string.
    const bare = '{"thought": "Bram said "hi" so I waved, then "kept going", fine.", "option": "work", "then": ["a"]}';
    expect(extractJson(bare)).toEqual({ thought: 'Bram said "hi" so I waved, then "kept going", fine.', option: 'work', then: ['a'] });
    expect(extractJson('{"thought": "one\ntwo", "option": "rest"}')).toEqual({ thought: 'one\ntwo', option: 'rest' });
    expect(extractJson('{"a": "x \\"q\\" y", "b": [1, 2]}')).toEqual({ a: 'x "q" y', b: [1, 2] });
  });
});

describe('cost meter', () => {
  it('keeps a rolling hour per agent and projects exhaustion', () => {
    let t = 0;
    const m = new CostMeter(() => t);
    m.record({ ts: t, agent: 'Pip', module: 'cc', tier: 'L2', model: 'x', inputTokens: 1000, outputTokens: 10, ms: 5, ok: true });
    t += 30 * 60_000;
    m.record({ ts: t, agent: 'Bram', module: 'talking', tier: 'L1', model: 'y', inputTokens: 500, outputTokens: 10, ms: 5, ok: true });
    expect(m.spentThisHour('Pip')).toBe(1000);
    expect(m.inputPerHour()).toBe(1500);
    expect(m.projectedExhaustion(3000, null)).toBe(t + 2 * 3_600_000);
    expect(m.projectedExhaustion(3000, t + 3_600_000)).toBeNull();
    t += 31 * 60_000;
    expect(m.spentThisHour('Pip')).toBe(0);
    expect(m.byModule.get('cc')?.calls).toBe(1);
  });
});
