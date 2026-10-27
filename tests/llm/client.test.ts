// M2 (§10, §22.8): the LLM client against a mocked NanoGPT.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelsConfigSchema, PersonaSchema, nullLogger } from '@agora/shared';
import {
  KeyLockError,
  type LlmCallOptions,
  LocalRateLimiter,
  ModelNotInSubscription,
  type LlmRuntime,
  type ModelSwap,
  startLlm,
} from '@agora/llm';
import { AgentStateStore } from '@agora/agent/state/store';
import { createInitialState } from '@agora/agent/state/initial';
import { CC_POLICY } from '@agora/agent/state/policies';
import { FakeNanoGpt, standardModels } from './fakeNanoGpt';

const Decision = z.object({ option: z.enum(['work', 'rest', 'talk']), rationale: z.string() });
type Decision = z.infer<typeof Decision>;
const DEFAULT: Decision = { option: 'rest', rationale: 'code default' };
const GOOD = JSON.stringify({ option: 'work', rationale: 'need logs' });

const fastTiers = {
  tiers: {
    L1: { timeoutMs: 300, maxTokens: 200, need: ['structured_output'] },
    L2: { timeoutMs: 300, maxTokens: 500, need: ['structured_output', 'tool_calling'] },
    L3: { timeoutMs: 600, maxTokens: 2000, need: ['structured_output'] },
  },
};

async function runtime(fake: FakeNanoGpt, cfg: Record<string, unknown> = fastTiers): Promise<LlmRuntime> {
  return startLlm({
    apiKey: 'test-key',
    config: ModelsConfigSchema.parse(cfg),
    logger: nullLogger(),
    fetch: fake.fetch,
    background: false,
    limiter: new LocalRateLimiter({ rps: 10_000 }),
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((res) => setTimeout(res, 2));
  }
}

function ask(rt: LlmRuntime, extra: Partial<LlmCallOptions<Decision>> = {}) {
  const opts: LlmCallOptions<Decision> = {
    tier: 'L2',
    module: 'cc',
    agent: 'Pip',
    messages: [
      { role: 'system', content: 'You are Pip, a careful builder.' },
      { role: 'user', content: 'What do you do next?' },
    ],
    schema: Decision,
    fallback: () => DEFAULT,
    ...extra,
  };
  return rt.client.call(opts);
}

describe('startup lock (§22.1, §22.3)', () => {
  it('refuses a key that can spend balance, unless allowPaidKey', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.usage = { paidSpendPolicyAllowsBalance: true };
    await expect(runtime(fake)).rejects.toBeInstanceOf(KeyLockError);
    const rt = await runtime(fake, { ...fastTiers, llm: { allowPaidKey: true } });
    expect(rt.router.chain('L1').length).toBeGreaterThanOrEqual(3);
  });

  it('refuses an inactive subscription', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.usage = { active: false, state: 'inactive' };
    await expect(runtime(fake)).rejects.toThrow(/not active/);
  });

  it('resolves ≥ 3-model chains with the tier capabilities and provider diversity', async () => {
    const rt = await runtime(new FakeNanoGpt(standardModels()));
    const { chains } = rt.router.resolution;
    expect(chains.L1.slice(0, 3)).toEqual(['p1-fast', 'p2-fast', 'p3-fast']);
    expect(chains.L2[0]).toMatch(/-mid$/);
    expect(chains.L2.every((id) => !id.endsWith('-fast') && id !== 'p4-plain')).toBe(true);
    expect(chains.L3.slice(0, 3)).toEqual(['p1-big', 'p2-big', 'p3-big']);
  });
});

describe('the client (§5, §22.2, §22.6)', () => {
  it('refuses a model that is not on the allowlist before sending anything', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const rt = await runtime(fake);
    await expect(ask(rt, { model: 'openai/gpt-paid-only' })).rejects.toBeInstanceOf(ModelNotInSubscription);
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('sends a structured request to the subscription endpoint only, with nothing that bypasses it', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: GOOD, usage: { prompt_tokens: 321, completion_tokens: 12 } });
    const rt = await runtime(fake);
    const r = await ask(rt);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ option: 'work', rationale: 'need logs' });
    const req = fake.chatRequests()[0];
    expect(req?.url).toBe('https://nano-gpt.com/api/subscription/v1/chat/completions');
    // A JSON-object reply, the schema in the prompt (subscription models fill every field of a json_schema reply).
    expect(req?.body?.response_format).toEqual({ type: 'json_object' });
    const msgs = req?.body?.messages as { role: string; content: string }[];
    expect(msgs[0]?.content).toMatch(/^You are Pip, a careful builder\.\n\nReply with only a JSON object \(reply\) matching this JSON schema:\n\{/);
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'What do you do next?' });
    expect(req?.body?.include_usage).toBe(true);
    const sent = JSON.stringify(req?.body);
    expect(sent).not.toMatch(/cache_control|billing|provider|service_tier/i);
    expect([...(req?.headers.keys() ?? [])].some((h) => /provider|billing|cache/i.test(h))).toBe(false);
    expect(rt.meter.spentThisHour('Pip')).toBe(321);
  });

  it("asks for the API's json_schema format only when configured to", async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: GOOD });
    const rt = await runtime(fake, { ...fastTiers, llm: { structuredOutput: 'schema' } });
    expect((await ask(rt, { schemaName: 'decision' })).ok).toBe(true);
    expect(fake.chatRequests()[0]?.body?.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'decision' } });
  });

  it('a prompt that describes the format gets only the line asking for it; placeholders are tidied before validation', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: JSON.stringify({ option: 'work', rationale: 'need logs', target: { agent: 'none' } }) });
    const rt = await runtime(fake);
    const strict = z.object({ option: z.enum(['work', 'rest', 'talk']), rationale: z.string(), target: z.object({ agent: z.string().min(1) }).optional() }).strict();
    const r = await rt.client.call({
      tier: 'L2',
      module: 'cc',
      agent: 'Pip',
      messages: [{ role: 'user', content: 'Reply with {"option": ..., "rationale": ...}' }],
      schema: strict,
      schemaName: 'decision',
      formatInPrompt: true,
      prepare: (j) => {
        const o = { ...(j as Record<string, unknown>) };
        if ((o.target as { agent?: string } | undefined)?.agent === 'none') delete o.target;
        return o;
      },
      fallback: () => ({ option: 'rest' as const, rationale: 'code default' }),
    });
    expect(r.value).toEqual({ option: 'work', rationale: 'need logs' });
    const msgs = fake.chatRequests()[0]?.body?.messages as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: 'system', content: 'Reply with only the JSON object (decision) described above.' });
  });

  it('repairs an invalid reply once, then falls back to the code default', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = ({ n }) => ({ text: n === 1 ? '{"option":"dance"}' : GOOD });
    const rt = await runtime(fake);
    const r1 = await ask(rt);
    expect(r1.ok).toBe(true);
    const repairMsgs = fake.chatRequests()[1]?.body?.messages as { role: string; content: string }[];
    expect(repairMsgs.at(-1)?.content).toMatch(/not valid/);
    // The repair is small: the reply and what was wrong with it, not the whole prompt again.
    expect(repairMsgs).toHaveLength(2);
    expect(repairMsgs.map((m) => m.content).join('\n')).not.toContain('You are Pip');
    expect(repairMsgs.at(-1)?.content).toContain('{"option":"dance"}');

    fake.chat = () => ({ text: 'I think I will go dancing.' });
    const r2 = await ask(rt);
    expect(r2.ok).toBe(false);
    expect(r2.value).toEqual(DEFAULT);
  });

  it('does not send a reply cut off by its length back for repair: it would be cut again', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: '{"thought": "I will', finishReason: 'length' });
    const rt = await runtime(fake);
    const r = await ask(rt);
    expect(r).toMatchObject({ ok: false, value: DEFAULT });
    expect(fake.chatRequests()).toHaveLength(1);
    // Cut off after its decision, a reply is mended and used.
    fake.chat = () => ({ text: '{"option": "work", "rationale": "need logs", "then": [{"skill": "craft", "args": {"it', finishReason: 'length' });
    const mended = await ask(rt);
    expect(mended).toMatchObject({ ok: true, value: { option: 'work', rationale: 'need logs' }, truncated: true });
  });

  it('does not send a thought that went stale while it waited for its turn', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: GOOD });
    const rt = await runtime(fake);
    const r = await ask(rt, { isStale: () => true });
    expect(r).toMatchObject({ ok: false, reason: 'stale' });
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('a JSON mode that answers "{}" is no answer: asked again in plain, and in plain from then on', async () => {
    // glm-5.3 answered "{}" six times of six on two of the mind's packets in JSON mode, and in plain gave the decision.
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = ({ body }) => ({ text: body.response_format ? '{}' : GOOD });
    const rt = await runtime(fake);
    const r1 = await ask(rt);
    expect(r1.ok).toBe(true);
    const [first, second] = fake.chatRequests();
    expect(first?.body?.response_format).toBeDefined();
    expect(second?.body?.response_format).toBeUndefined();
    // The same model next time: no JSON mode at all, one request.
    const before = fake.chatRequests().length;
    expect((await ask(rt)).ok).toBe(true);
    expect(fake.chatRequests().length - before).toBe(1);
    expect(fake.chatRequests().at(-1)?.body?.response_format).toBeUndefined();
  });

  it('marks a model unreliable for a tier after repeated schema failures and swaps', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const rt = await runtime(fake);
    const head = rt.router.chain('L2')[0];
    const swaps: ModelSwap[] = [];
    rt.router.on('swap', (s) => swaps.push(s));
    fake.chat = ({ model }) => ({ text: model === head ? 'nope' : GOOD });
    for (let i = 0; i < 3; i++) expect((await ask(rt)).ok).toBe(false);
    expect(rt.router.chain('L2')[0]).not.toBe(head);
    expect(swaps.some((s) => s.tier === 'L2' && s.from === head)).toBe(true);
    expect((await ask(rt)).ok).toBe(true);
  });

  it('times out to the next model, and circuit-breaks a model after 3 failures', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const rt = await runtime(fake);
    const [first, second] = rt.router.chain('L2');
    fake.chat = ({ model }) => (model === first ? { text: GOOD, delayMs: 2000 } : { text: GOOD });
    for (let i = 0; i < 3; i++) {
      const r = await ask(rt);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model).toBe(second);
    }
    const before = fake.chatRequests().filter((q) => q.body?.model === first).length;
    await ask(rt);
    expect(fake.chatRequests().filter((q) => q.body?.model === first).length).toBe(before);
  });

  it('tries the models a call prefers first (speech), skipping one not on the list; the operator’s model still first; its own timeout', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const rt = await runtime(fake);
    const tierFirst = rt.router.chain('L2')[0];
    fake.chat = ({ model }) => (model === 'p2-big' ? { text: GOOD, delayMs: 600 } : { text: GOOD });
    // p2-big answers in 600 ms: past the tier's 300 ms, within this call's 1500.
    const r = await ask(rt, { prefer: ['not-on-the-list', 'p2-big', 'p3-big'], timeoutMs: 1500 });
    expect(r.ok && r.model).toBe('p2-big');
    expect(fake.chatRequests().map((q) => q.body?.model)).toEqual(['p2-big']);
    // With the tier's own timeout it is too slow: the next preferred model answers.
    const slow = await ask(rt, { prefer: ['p2-big', 'p3-big'] });
    expect(slow.ok && slow.model).toBe('p3-big');
    // The operator chose a model for the tier: it comes first all the same.
    rt.client.setRouting({ tierModel: { L2: 'p1-mid' } });
    const routed = await ask(rt, { prefer: ['p3-big'] });
    expect(routed.ok && routed.model).toBe('p1-mid');
    expect(tierFirst).toBeDefined();
  });

  it('takes a rate token for every request it sends: a fallback model’s and a repair’s too (NanoGPT counts each)', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let tokens = 0;
    const counting = {
      acquire: () => {
        tokens++;
        return Promise.resolve();
      },
      rate: 10_000,
    };
    const rt = await startLlm({ apiKey: 'test-key', config: ModelsConfigSchema.parse(fastTiers), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: counting });
    const [first] = rt.router.chain('L2');
    // The first model times out, the second answers wrongly once and then rightly: three requests, three tokens.
    let wrong = true;
    fake.chat = ({ model }) => {
      if (model === first) return { text: GOOD, delayMs: 2000 };
      if (!wrong) return { text: GOOD };
      wrong = false;
      return { text: '{"option":"dance"}' };
    };
    const r = await ask(rt);
    expect(r.ok).toBe(true);
    expect(fake.chatRequests()).toHaveLength(3);
    expect(tokens).toBe(3);
  });

  it('says how much of a call went on waiting for a rate token, apart from the thought itself', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const slow = { acquire: () => new Promise<void>((r) => setTimeout(r, 300)), rate: 10_000 };
    const rt = await startLlm({ apiKey: 'test-key', config: ModelsConfigSchema.parse(fastTiers), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: slow });
    fake.chat = () => ({ text: GOOD, delayMs: 100 });
    const r = await ask(rt);
    expect(r.ok).toBe(true);
    expect(r.waitMs).toBeGreaterThanOrEqual(280);
    expect(r.ms - r.waitMs).toBeGreaterThanOrEqual(90);
    expect(r.ms - r.waitMs).toBeLessThan(280);
  });

  it('refreshes the allowlist on "model not found" and hot-swaps when a model disappears', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const rt = await runtime(fake);
    const head = rt.router.chain('L2')[0] as string;
    const swaps: ModelSwap[] = [];
    rt.router.on('swap', (s) => swaps.push(s));
    fake.models = fake.models.filter((m) => m.id !== head);
    fake.chat = ({ model }) =>
      model === head ? { status: 404, json: { error: { message: 'Model not found', type: 'not_found_error', code: 'model_not_found' } } } : { text: GOOD };
    const listsBefore = fake.count('/api/subscription/v1/models');
    const r = await ask(rt);
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(fake.count('/api/subscription/v1/models')).toBe(listsBefore + 1);
    expect(rt.router.allowlist.has(head)).toBe(false);
    expect(swaps.some((s) => s.from === head && s.tier === 'L2')).toBe(true);
  });

  it('takes an uncovered model out for the session (402 / not covered)', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const rt = await runtime(fake);
    const head = rt.router.chain('L2')[0] as string;
    fake.chat = ({ model }) => (model === head ? { status: 402, json: { error: 'Insufficient balance', status: 402 } } : { text: GOOD });
    const r = await ask(rt);
    expect(r.ok).toBe(true);
    expect(rt.router.allowlist.has(head)).toBe(false);
    expect(rt.router.chain('L2')).not.toContain(head);
  });

  it('maps an empty L3 to L2, and an empty L1 to code-only without sending anything', async () => {
    const noBig = new FakeNanoGpt(standardModels().filter((m) => !m.id.endsWith('-big') && m.id !== 'p1-mid'));
    const rt = await runtime(noBig, {
      tiers: { ...fastTiers.tiers, L3: { timeoutMs: 600, maxTokens: 2000, need: ['structured_output', 'reasoning'] } },
    });
    expect(rt.router.resolution.mappedTo.L3).toBe('L2');
    expect(rt.router.chain('L3')).toEqual(rt.router.chain('L2'));

    const none = new FakeNanoGpt([{ id: 'p4-plain', caps: [] }]);
    const rt2 = await runtime(none);
    expect(rt2.router.codeOnly).toBe(true);
    const r = await ask(rt2);
    expect(r).toMatchObject({ ok: false, reason: 'code-only', value: DEFAULT });
    expect(none.chatRequests()).toHaveLength(0);
  });

  it('never lets the quota change a thought: nearly used up, every call keeps its tier and goes out (owner request, 2026-10-25)', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 10 } });
    fake.usage = { weeklyPercent: 0.97, weeklyRemaining: 500, resetInMs: 72 * 3_600_000, recommendedMode: 'paygo' };
    const rt = await runtime(fake);
    expect(rt.quota.view).toMatchObject({ weeklyPercent: 0.97, recommendedMode: 'paygo' });
    const goal = await ask(rt, { tier: 'L3', module: 'goal' });
    expect(goal.ok && goal.tier).toBe('L3');
    for (let i = 0; i < 3; i++) {
      const cc = await ask(rt, { tier: 'L2', module: 'cc' });
      expect(cc.ok && cc.tier).toBe('L2');
    }
    expect((await ask(rt, { module: 'socialGoal' })).ok).toBe(true);
    expect(fake.chatRequests()).toHaveLength(5);
  });

  it('backs off on 429, and sends nothing more once the daily key limit is reached', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const limiter = new LocalRateLimiter({ rps: 10_000 });
    const rt = await startLlm({
      apiKey: 'k',
      config: ModelsConfigSchema.parse(fastTiers),
      logger: nullLogger(),
      fetch: fake.fetch,
      background: false,
      limiter,
    });
    const head = rt.router.chain('L2')[0];
    fake.chat = ({ model }) =>
      model === head ? { status: 429, json: { error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, headers: { 'retry-after': '0' } } : { text: GOOD };
    expect((await ask(rt)).ok).toBe(true);
    expect(limiter.rate).toBeCloseTo(8000);

    fake.chat = () => ({ status: 429, json: { error: { message: 'daily limit', type: 'rate_limit_error', code: 'daily_rpd_limit_exceeded' } }, headers: { 'retry-after': '3600' } });
    expect(await ask(rt)).toMatchObject({ ok: false, reason: 'refused' });
    const sent = fake.chatRequests().length;
    expect(await ask(rt)).toMatchObject({ ok: false, reason: 'refused' });
    expect(fake.chatRequests().length).toBe(sent);
  });

  it('streams text replies and still meters them', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ chunks: ['hey ', 'there, ', 'Bram!'], usage: { prompt_tokens: 50, completion_tokens: 6 } });
    const rt = await runtime(fake);
    const pieces: string[] = [];
    const r = await rt.client.call<string>({
      tier: 'L1',
      module: 'talking',
      agent: 'Pip',
      messages: [{ role: 'user', content: 'Bram says hi' }],
      fallback: () => 'hm?',
      onText: (d) => pieces.push(d),
    });
    expect(r).toMatchObject({ ok: true, value: 'hey there, Bram!' });
    expect(pieces).toEqual(['hey ', 'there, ', 'Bram!']);
    expect(fake.chatRequests()[0]?.body?.stream).toBe(true);
    expect(rt.meter.spentThisHour('Pip')).toBe(50);
  });

});

describe('one model for each kind of thought (owner request, 2026-10-25)', () => {
  const withThoughts = {
    ...fastTiers,
    thoughts: {
      mind: { model: 'p2-big', backup: 'p3-mid', effort: 'none', maxTokens: 1200, timeoutMs: 600 },
      check: { model: 'p1-fast', effort: 'low', maxTokens: 50, timeoutMs: 300 },
    },
  };

  it('runs each kind on its own model, with its reply cap, time and effort (sent only to a model that reasons)', async () => {
    const fake = new FakeNanoGpt(standardModels());
    // Slower than L2's 300 ms: only the mind's own 600 ms lets it through.
    fake.chat = () => ({ text: GOOD, delayMs: 400 });
    const rt = await runtime(fake, withThoughts);
    const mind = await ask(rt);
    expect(mind.ok && mind.model).toBe('p2-big');
    expect(fake.chatRequests()[0]?.body).toMatchObject({ model: 'p2-big', max_tokens: 1200, reasoning_effort: 'none' });
    fake.chat = () => ({ text: GOOD });
    const check = await ask(rt, { tier: 'L1', thought: 'check' });
    expect(check.ok && check.model).toBe('p1-fast');
    const body = fake.chatRequests()[1]?.body;
    expect(body?.max_tokens).toBe(50);
    expect(body).not.toHaveProperty('reasoning_effort');
    // A kind with no model of its own runs on its tier's chain, as before.
    const plan = await ask(rt, { tier: 'L3', module: 'goal' });
    expect(plan.ok && rt.router.chain('L3')).toContain(plan.ok ? plan.model : '');
  });

  it('turns to the backup only while the model is down, never for a malformed reply', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = ({ model }) => (model === 'p2-big' ? { status: 503, json: { error: { message: 'overloaded' } } } : { text: GOOD });
    const rt = await runtime(fake, withThoughts);
    const down = await ask(rt);
    expect(down.ok && down.model).toBe('p3-mid');
    fake.chat = ({ model }) => (model === 'p2-big' ? { text: 'not json at all' } : { text: GOOD });
    const before = fake.chatRequests().length;
    expect(await ask(rt)).toMatchObject({ ok: false, value: DEFAULT });
    expect(fake.chatRequests().slice(before).map((q) => q.body?.model)).toEqual(['p2-big', 'p2-big']);
  });

  it('a thought that cannot wait asks the backup as well once it is slow, and takes the first good reply', async () => {
    // Under fire the mind's model now and then took more than its 8 s, and the backup was asked only after it: one
    // among five zombies died at 15 s with no thought had.
    const fake = new FakeNanoGpt(standardModels());
    const cfg = { ...fastTiers, thoughts: { underFire: { model: 'p2-big', backup: 'p3-mid', effort: 'none', maxTokens: 600, timeoutMs: 2000, hedgeMs: 150 } } };
    const rt = await runtime(fake, cfg);
    const under = { thought: 'underFire' as const };
    // Slow: the backup, asked at 150 ms, answers first; the slow one is called off.
    fake.chat = ({ model }) => (model === 'p2-big' ? { text: GOOD, delayMs: 1500 } : { text: GOOD, delayMs: 50 });
    const t0 = Date.now();
    const slow = await ask(rt, under);
    expect(slow.ok && slow.model).toBe('p3-mid');
    expect(Date.now() - t0).toBeLessThan(800);
    // Quick: the backup is never asked.
    fake.chat = () => ({ text: GOOD, delayMs: 20 });
    let before = fake.chatRequests().length;
    const quick = await ask(rt, under);
    expect(quick.ok && quick.model).toBe('p2-big');
    expect(fake.chatRequests().slice(before).map((q) => q.body?.model)).toEqual(['p2-big']);
    // Slow, and the backup no quicker: whichever answers first.
    fake.chat = ({ model }) => (model === 'p2-big' ? { text: GOOD, delayMs: 300 } : { text: GOOD, delayMs: 900 });
    const both = await ask(rt, under);
    expect(both.ok && both.model).toBe('p2-big');
    // Down before the hedge: the backup, as for any call; a malformed reply: the code default, never the backup.
    fake.chat = ({ model }) => (model === 'p2-big' ? { status: 503, json: { error: { message: 'overloaded' } } } : { text: GOOD });
    const down = await ask(rt, under);
    expect(down.ok && down.model).toBe('p3-mid');
    fake.chat = ({ model }) => (model === 'p2-big' ? { text: 'not json at all' } : { text: GOOD });
    before = fake.chatRequests().length;
    expect(await ask(rt, under)).toMatchObject({ ok: false, value: DEFAULT });
    expect(fake.chatRequests().slice(before).map((q) => q.body?.model)).toEqual(['p2-big', 'p2-big']);
  });

  it("still puts the operator's model for the tier first", async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: GOOD });
    const rt = await runtime(fake, withThoughts);
    rt.client.setRouting({ tierModel: { L2: 'p1-mid' } });
    const r = await ask(rt);
    expect(r.ok && r.model).toBe('p1-mid');
  });

  it('will not start with a kind of thought on a model the subscription lacks', async () => {
    const fake = new FakeNanoGpt(standardModels());
    await expect(runtime(fake, { ...fastTiers, thoughts: { mind: { model: 'gone-model', maxTokens: 100, timeoutMs: 1000 } } })).rejects.toThrow(/mind: gone-model/);
  });
});

describe('abort-on-stale (§4.2, M2 exit)', () => {
  const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['careful'] });

  it('aborts the in-flight call when danger starts and returns the code default', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: GOOD, delayMs: 250 });
    const rt = await runtime(fake, { tiers: { ...fastTiers.tiers, L2: { timeoutMs: 2000, maxTokens: 500, need: ['structured_output', 'tool_calling'] } } });
    const store = new AgentStateStore(createInitialState({ persona, username: 'Pip' }));
    const g = store.guard(CC_POLICY);
    const pending = ask(rt, { signal: g.signal, isStale: g.isStale });
    setTimeout(() => store.update('flags', (f) => ({ ...f, inDanger: true }), 'zombie'), 60);
    const r = await pending;
    g.dispose();
    expect(r).toMatchObject({ ok: false, reason: 'stale', value: DEFAULT });
    expect(g.reason()).toBe('danger');
    expect(fake.aborted).toBe(1);
  });

  it('throws a reply away when too much changed while it was in flight', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: GOOD, delayMs: 80 });
    const rt = await runtime(fake);
    const store = new AgentStateStore(createInitialState({ persona, username: 'Pip' }));
    const g = store.guard({ ...CC_POLICY, maxChanges: 2 });
    const pending = ask(rt, { signal: g.signal, isStale: g.isStale });
    // Once the request is out (the reply takes 80 ms), the world moves on.
    await until(() => fake.chatRequests().length > 0);
    for (let i = 0; i < 3; i++) store.update('perception', (p) => ({ ...p, observedActions: [] }), `tick ${i}`);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, reason: 'stale' });
    expect(fake.aborted).toBe(0);
    expect(rt.meter.spentThisHour('Pip')).toBeGreaterThan(0);
  });
});
