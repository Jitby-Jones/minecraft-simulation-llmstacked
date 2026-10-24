// Turn-taking and talks that end once settled (owner request, 2026-10-24): people stood about talking long after they
// had agreed what to do, talked over each other, and too fast. A settled talk ends and its plan goes on the mind; a
// line put to a group is answered by whoever is first, the rest taking their turn after; a line is read before it is
// answered, and waits for a gap after someone else's.

import { describe, expect, it } from 'vitest';
import { type AgentEvent, ModelsConfigSchema, PersonaSchema, type Utterance, type Volume, nullLogger } from '@agora/shared';
import { type LlmClient, LocalRateLimiter, startLlm } from '@agora/llm';
import type { Body } from '@agora/agent/body/body';
import type { Bot } from '@agora/agent/body/bot';
import { ChatOut } from '@agora/agent/body/chatOut';
import { AgentBus } from '@agora/agent/bus';
import { AGREE_RE, Consensus, PROPOSAL_RE, readsSettled } from '@agora/agent/modules/consensus';
import { Conversations } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { Talking } from '@agora/agent/modules/talking';
import { createInitialState } from '@agora/agent/state/initial';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'male', traits: ['curious'] });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (from: string, text: string, ts: number) => ({ from, text, ts });

function heard(bus: AgentBus, store: AgentStateStore, from: string, text: string, addressedToMe = true): Utterance {
  const u: Utterance = { id: `u${Math.random()}`, convId: '', from, to: ['Pip'], text, ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe, heardAs: addressedToMe ? 'me' : 'other' };
  store.update('perception', (p) => ({ ...p, heardSpeech: [...p.heardSpeech, u] }), 'test');
  bus.emit({ type: 'heard', utterance: u });
  return u;
}

describe('a talk that has settled what to do', () => {
  it('reads as settled when someone says yes to what another put forward, nobody pushing back', () => {
    expect(readsSettled([line('Mira', 'theres a cave east with iron, lets all go', 1), line('Wren', 'yeah lets go', 2)])).toEqual({ proposal: 'theres a cave east with iron, lets all go', by: 'Mira' });
    expect(readsSettled([line('Mira', 'so who gets wood?', 1), line('Bram', 'i can get stone', 2), line('Pip', 'ok i got wood', 3)])?.by).toBe('Bram');
    // A yes to nothing, a yes to oneself, and a no in between: not settled.
    expect(readsSettled([line('Mira', 'nice day huh', 1), line('Wren', 'yeah', 2)])).toBeNull();
    expect(readsSettled([line('Mira', 'lets go mine', 1), line('Mira', 'ok cool', 2)])).toBeNull();
    expect(readsSettled([line('Mira', 'lets go mine', 1), line('Bram', 'nah not now', 2), line('Wren', 'ok', 3)])).toBeNull();
    expect(readsSettled([line('Mira', 'lets go mine', 1), line('Wren', 'nah, ok maybe later', 2)])).toBeNull();
    expect(AGREE_RE.test('ok lets do it')).toBe(true);
    expect(AGREE_RE.test('omw!')).toBe(true);
    expect(PROPOSAL_RE.test('wanna go fishing')).toBe(true);
  });

  function setup(llm: LlmClient | null = null) {
    const store = new AgentStateStore(createInitialState({ persona, username: 'Pip', now: Date.now() }));
    const bus = new AgentBus();
    const conversations = new Conversations({ store, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Mira', 'Wren'], rng: () => 0 });
    const consensus = new Consensus({ store, bus, logger: nullLogger(), llm, conversations, me: 'Pip', settleMs: 80 });
    const events: AgentEvent[] = [];
    bus.on('agreed', (e) => void events.push(e));
    conversations.start();
    consensus.start();
    const stop = () => {
      consensus.stop();
      conversations.stop();
    };
    return { store, bus, conversations, events, stop };
  }

  it('ends the talk once settled (without a model, taken at its word): the plan on the mind, and the mind told', async () => {
    const x = setup();
    heard(x.bus, x.store, 'Mira', 'Pip, theres a cave east with iron, lets all go');
    expect(x.conversations.active().length).toBe(1);
    heard(x.bus, x.store, 'Wren', 'yeah lets go');
    await wait(200);
    x.stop();
    expect(x.conversations.active()).toEqual([]);
    expect(Object.values(x.store.state.conversations)[0]?.endedReason).toBe('agreed');
    expect(x.events).toEqual([{ type: 'agreed', with: ['Mira', 'Wren'], what: 'Pip, theres a cave east with iron, lets all go' }]);
    expect(x.store.state.workmem.some((w) => /we agreed with Mira, Wren: Pip, theres a cave east/.test(w.text))).toBe(true);
  });

  it('not when someone pushes back in the pause', async () => {
    const x = setup();
    heard(x.bus, x.store, 'Mira', 'Pip, lets all go to the cave east');
    heard(x.bus, x.store, 'Wren', 'ok');
    heard(x.bus, x.store, 'Wren', 'wait, its getting dark');
    await wait(200);
    x.stop();
    expect(x.events).toEqual([]);
    // Talks with each of them, none ended.
    expect(x.conversations.active().length).toBe(2);
  });

  it('with a model: its reading of what was agreed and our part in it; and not settled when it says so', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let settled = true;
    fake.chat = () => ({ text: JSON.stringify({ settled, what: 'go to the cave east and mine iron together', mine: 'bring torches' }) });
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    try {
      const x = setup(rt.client);
      heard(x.bus, x.store, 'Mira', 'Pip, theres a cave east with iron, lets all go');
      heard(x.bus, x.store, 'Wren', 'yeah lets go');
      for (let i = 0; i < 40 && x.events.length === 0; i++) await wait(25);
      x.stop();
      expect(x.events).toEqual([{ type: 'agreed', with: ['Mira', 'Wren'], what: 'go to the cave east and mine iron together', mine: 'bring torches' }]);
      expect(x.store.state.workmem.some((w) => /my part: bring torches/.test(w.text))).toBe(true);

      settled = false;
      const y = setup(rt.client);
      heard(y.bus, y.store, 'Mira', 'Pip, wanna go to the cave?');
      heard(y.bus, y.store, 'Wren', 'yeah maybe, what do you think pip');
      await wait(400);
      y.stop();
      expect(y.events).toEqual([]);
      expect(y.conversations.active().length).toBe(2);
    } finally {
      rt.stop();
    }
  });
});

describe('taking turns', () => {
  // The body's own chat queue (the floor is held there, after typing), over a bot that records what goes out.
  function talker(rng = 0.5) {
    const store = new AgentStateStore(createInitialState({ persona, username: 'Pip', now: Date.now() }));
    const bus = new AgentBus();
    const said: { text: string; at: number }[] = [];
    const bot = { chat: (t: string) => void said.push({ text: t, at: Date.now() }), _client: { ended: false } } as unknown as Bot;
    const chat = new ChatOut(bot, { minIntervalMs: 0, msPerChar: 0 });
    const body = {
      chat,
      say: async (t: string, v?: Volume, l?: readonly string[], sw?: () => boolean, urgent?: boolean) => (await chat.say(t, v, l, sw, urgent)).sent,
      skill: () => null,
      run: () => Promise.reject(new Error('unused')),
    } as unknown as Body;
    const conversations = new Conversations({ store, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Mira', 'Wren'], rng: () => 0 });
    const executor = new SkillExecutor({ store, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Pip', rng: () => rng });
    conversations.start();
    talking.start();
    const stop = () => {
      talking.stop();
      conversations.stop();
    };
    return { store, bus, said, stop };
  }

  it('a line is read before it is answered, and a reply waits for a gap after someone else', async () => {
    const x = talker(0);
    const t0 = Date.now();
    heard(x.bus, x.store, 'Mira', 'Pip, how is the mining going over by the big oak tree?');
    for (let i = 0; i < 160 && x.said.length === 0; i++) await wait(25);
    // 54 characters: 500 + 30 × 54 ms of reading before the reply.
    expect(x.said.length).toBe(1);
    expect((x.said[0]?.at ?? 0) - t0).toBeGreaterThanOrEqual(2000);
    // Someone else speaks just as we would: we wait for the gap.
    x.said.length = 0;
    const t1 = Date.now();
    heard(x.bus, x.store, 'Mira', 'Pip?');
    await wait(400);
    heard(x.bus, x.store, 'Wren', 'hey');
    for (let i = 0; i < 200 && x.said.length === 0; i++) await wait(25);
    expect(x.said.length).toBeGreaterThanOrEqual(1);
    expect((x.said[0]?.at ?? 0) - t1).toBeGreaterThanOrEqual(400 + 1200);
    x.stop();
  });

  it('a line put to the group is answered by whoever is first; the rest stay quiet unless they have something else to say', async () => {
    // (Not the one in seven who chimes in on a line to someone else: that is talking.ts's onOverheard.)
    const x = talker(0.99);
    // Wren and Mira are talking; Mira asks everyone.
    heard(x.bus, x.store, 'Wren', 'so whats the plan', false);
    const q = heard(x.bus, x.store, 'Mira', 'anyone know where to find iron?');
    expect(q.addressedToMe).toBe(true);
    // Wren answers first.
    await wait(300);
    heard(x.bus, x.store, 'Wren', 'theres some in the ravine east', false);
    await wait(3500);
    x.stop();
    expect(x.said).toEqual([]);
  });
});
