// A death ends every activity at once (owner request, 2026-10-24; §16.3): nothing more is said, and every model call
// of the agent ends there, one under way included. The body, the modules and the respawn are checked live in
// tests/live/death.test.ts.

import { describe, expect, it } from 'vitest';
import type { Bot } from 'mineflayer';
import { ModelsConfigSchema, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { haltable } from '@agora/agent/agent';
import { ChatOut } from '@agora/agent/body/chatOut';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

function fakeChatBot(): { bot: Bot; sent: string[] } {
  const sent: string[] = [];
  const bot = { chat: (text: string) => sent.push(text), _client: { ended: false } } as unknown as Bot;
  return { bot, sent };
}

describe('a death ends every activity', () => {
  it('nothing more is said: not what was waiting, nor what is asked after', async () => {
    const { bot, sent } = fakeChatBot();
    const out = new ChatOut(bot, { minIntervalMs: 0, msPerChar: 20 });
    const typing = out.say('one sec, almost done with this tree');
    const queued = out.say('then we can head back');
    out.silence();
    expect((await typing).reason).toBe('silenced');
    expect((await queued).reason).toBe('silenced');
    expect((await out.say('ow!', 'normal', [], undefined, true)).reason).toBe('silenced');
    expect(sent).toEqual([]);
  });

  it('a model call under way ends there, and none goes out after', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: 'a reply that comes too late', delayMs: 10_000 });
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const halt = new AbortController();
    const llm = haltable(rt.client, halt.signal);
    const ask = () => llm.call({ tier: 'L1', module: 'talking', agent: 'Pip', messages: [{ role: 'user', content: 'say hi' }], fallback: () => 'canned' });
    try {
      const t0 = Date.now();
      const under = ask();
      await new Promise((r) => setTimeout(r, 200));
      const sentBefore = fake.requests.filter((r) => r.url.includes('/chat/completions')).length;
      expect(sentBefore).toBe(1);
      halt.abort(new Error('died'));
      const r = await under;
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r).toMatchObject({ ok: false, source: 'fallback', value: 'canned', reason: 'aborted' });
      // After: the fallback, with nothing sent.
      expect(await ask()).toMatchObject({ ok: false, reason: 'aborted', attempts: 0 });
      expect(fake.requests.filter((q) => q.url.includes('/chat/completions')).length).toBe(1);
      // The rest of the client is the client's own.
      expect(llm.chainFor('L1')).toEqual(rt.client.chainFor('L1'));
    } finally {
      rt.stop();
    }
  });
});
