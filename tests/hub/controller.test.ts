// The controller (owner request, 2026-10-24): a master model over all the agents that steps in only on what has plainly
// gone wrong, a talk going round in circles first of all, with a push each agent takes as its own. Code finds the
// cases; the model judges them (and lets most be); its words are checked; without it, code pushes in the clearest.

import { describe, expect, it } from 'vitest';
import { ModelsConfigSchema, type Urge, nullLogger } from '@agora/shared';
import { type LlmClient, LocalRateLimiter, startLlm } from '@agora/llm';
import { Controller, type ControllerStep, fitWords, similarity } from '@agora/hub';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const MIN = 60_000;

function rig(o: { llm?: LlmClient | null; maxPerHour?: number; leaveBe?: (n: string) => boolean } = {}) {
  let t = 10_000_000;
  const sent: { who: string; urge: Urge }[] = [];
  const steps: ControllerStep[] = [];
  const c = new Controller({
    llm: o.llm ?? null,
    logger: nullLogger(),
    config: { enabled: true, models: [], timeoutMs: 5000, everySec: 20, maxPerHour: o.maxPerHour ?? 20 },
    send: (who, urge) => {
      sent.push({ who, urge });
      return true;
    },
    ...(o.leaveBe ? { leaveBe: o.leaveBe } : {}),
    onStep: (s) => void steps.push(s),
    now: () => t,
  });
  const at = () => t;
  /** `minutes` of life, a state every 5 s from each of `who`, and what `each` adds at each tick. */
  const live = (minutes: number, who: Record<string, { x: number; z: number; option?: Record<string, unknown> | null; move?: number }>, each?: (tick: number) => void) => {
    for (let i = 0; i < (minutes * MIN) / 5000; i++) {
      t += 5000;
      for (const [name, s] of Object.entries(who)) {
        const wobble = s.move ? (i % 7) * s.move : 0;
        c.observe(name, 'state', { pos: { x: s.x + wobble, y: 64, z: s.z }, option: s.option === undefined ? { option: 'work', skill: 'gather', status: 'running', startedAt: t - 1000 } : s.option, goal: 'build a house' });
      }
      each?.(i);
    }
  };
  const say = (name: string, text: string) => c.observe(name, 'utterance', { text, volume: 'normal' });
  const did = (name: string, skill: string, ok: boolean, args: Record<string, unknown> = {}, error?: string) => c.observe(name, 'skill', { skill, args, ok, observed: ok ? 'done' : 'nothing', ...(error ? { error } : {}), ms: 1000 });
  return { c, sent, steps, live, say, did, at };
}

async function model(reply: (user: string) => unknown, during?: () => void) {
  const fake = new FakeNanoGpt(standardModels());
  const asked: { model: string; system: string; user: string }[] = [];
  fake.chat = ({ body }) => {
    const messages = body.messages as { role: string; content: string }[];
    const user = messages.at(-1)?.content ?? '';
    asked.push({ model: String(body.model), system: messages[0]?.content ?? '', user });
    during?.();
    return { text: JSON.stringify(reply(user)) };
  };
  const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
  return { llm: rt.client, asked, stop: () => rt.stop() };
}

/** Ada and Bram standing together going over the same thing again and again. */
const circles = (r: ReturnType<typeof rig>) =>
  r.live(5, { Ada: { x: 0, z: 0, option: { option: 'talk', status: 'running', startedAt: r.at() } }, Bram: { x: 2, z: 1, option: { option: 'talk', status: 'running', startedAt: r.at() } } }, (i) => {
    if (i % 6 === 0) r.say('Ada', ['we should build a house', 'yeah we should build a house', 'ok so we build a house then', 'lets build a house', 'so we build the house right', 'build a house yeah', 'house time, we should build a house'][i / 6 % 7] ?? 'hmm');
    if (i % 6 === 3) r.say('Bram', ['agreed lets build a house', 'yeah lets build a house', 'ok build a house', 'lets build a house then', 'so a house yeah', 'agreed, a house', 'ok lets build a house'][(i - 3) / 6 % 7] ?? 'ok');
  });

describe('what looks wrong, found by code', () => {
  it('a talk going round in circles, the same talk started over and over, talk that never turns into doing', () => {
    const r = rig();
    circles(r);
    const odd = r.c.oddities();
    expect(odd.map((o) => [o.agent, o.kind])).toEqual([
      ['Ada', 'repeating'],
      ['Bram', 'repeating'],
    ]);
    expect(odd[0]?.others).toEqual(['Bram']);
    expect(odd[0]?.summary).toMatch(/Ada keeps saying the same things to Bram/);

    const again = rig();
    again.live(10, { Cyd: { x: 0, z: 0, move: 1 } }, (i) => {
      if (i % 25 === 0) again.c.observe('Cyd', 'conversation', { convId: `c${i}`, with: ['Dee'], reason: 'went quiet', turns: 3 });
    });
    expect(again.c.oddities()).toMatchObject([{ kind: 'talk_again', agent: 'Cyd', others: ['Dee'] }]);

    const chatter = rig();
    const said = [
      'did u see the sunset yesterday', 'my sheep ran off again lol', 'i think creepers hate me', 'whats ur fav block',
      'mine is probably moss honestly', 'wanna hear a joke', 'why did the chicken cross', 'nvm i forgot it',
      'how long have u lived here', 'i came from the hills', 'its windy up there', 'we had goats', 'goats are loud tho',
      'do u like fishing', 'i caught a boot once', 'still have it somewhere', 'anyway what are u up to', 'same honestly',
      'the river looks nice today', 'kinda hungry ngl',
    ];
    chatter.live(8, { Eli: { x: 0, z: 0, option: { option: 'talk', status: 'running', startedAt: chatter.at() } } }, (i) => {
      if (i % 5 === 0) chatter.say('Eli', said[(i / 5) % said.length] ?? 'ok');
    });
    expect(chatter.c.oddities()).toMatchObject([{ kind: 'talk_forever', agent: 'Eli' }]);
  });

  it('the same task failing again and again, standing stuck, a mind that keeps changing, doing nothing at all', () => {
    const r = rig();
    r.live(10, { Fay: { x: 0, z: 0, move: 1 } }, (i) => {
      if (i % 25 === 0) r.did('Fay', 'craft', false, { item: 'iron_pickaxe', qty: i % 2 === 0 ? 1 : 2 }, 'missing 3 iron_ingot');
    });
    expect(r.c.oddities()).toMatchObject([{ kind: 'fail_loop', agent: 'Fay', task: { skill: 'craft', item: 'iron_pickaxe' } }]);

    const stuck = rig();
    stuck.live(7, { Gus: { x: 5, z: 5, option: { option: 'work', skill: 'goto', status: 'running', startedAt: stuck.at(), progress: 'walking' } } });
    expect(stuck.c.oddities()).toMatchObject([{ kind: 'stuck', agent: 'Gus' }]);

    const restless = rig();
    const opts = ['work', 'explore', 'talk', 'rest'];
    restless.live(3, { Hal: { x: 0, z: 0, move: 2 } }, (i) => {
      if (i % 3 === 0) restless.c.observe('Hal', 'decision', { option: opts[i % 4] ?? 'work', source: 'llm', rationale: 'hmm' });
    });
    expect(restless.c.oddities()).toMatchObject([{ kind: 'restless', agent: 'Hal' }]);

    const idle = rig();
    idle.live(7, { Ivy: { x: 0, z: 0, option: null } });
    expect(idle.c.oddities()).toMatchObject([{ kind: 'idle', agent: 'Ivy' }]);
  });

  it('ordinary life is not odd: a chat of a few minutes, work done, a long smelt, a rest, progress made in one spot', () => {
    const r = rig();
    const lines = ['hey jo', 'hey whats up', 'not much, mining later?', 'sure, after i eat', 'cool see u at the cave', 'ok'];
    r.live(4, { Jo: { x: 0, z: 0, move: 1 }, Kit: { x: 2, z: 0, move: 1 } }, (i) => {
      if (i % 8 === 0) r.say(i % 16 === 0 ? 'Jo' : 'Kit', lines[(i / 8) % lines.length] ?? 'ok');
      if (i % 12 === 0) r.did('Jo', 'gather', true, { item: 'oak_log' });
    });
    expect(r.c.oddities()).toEqual([]);

    const still = rig();
    still.live(8, {
      Lou: { x: 0, z: 0, option: { option: 'work', skill: 'smelt', status: 'running', startedAt: still.at() } },
      Max: { x: 9, z: 9, option: { option: 'rest', status: 'running', startedAt: still.at() } },
    });
    expect(still.c.oddities()).toEqual([]);

    const building = rig();
    let n = 0;
    building.live(8, { Ned: { x: 0, z: 0, option: { option: 'work', skill: 'build', status: 'running', startedAt: building.at(), progress: 'placing' } } }, () => {
      n++;
      building.c.observe('Ned', 'state', { pos: { x: 0, y: 64, z: 0 }, option: { option: 'work', skill: 'build', status: 'running', startedAt: 0, progress: `placed ${n} of 300` } });
    });
    expect(building.c.oddities()).toEqual([]);
  });

  it('lines that say the same again read alike; different ones do not', () => {
    expect(similarity('we should build a house', 'yeah we should build a house')).toBe(1);
    expect(similarity('we should build a house', 'theres iron in the cave east')).toBe(0);
  });
});

describe('the master model judges each case and words the push', () => {
  it('both walk off from a talk going round in circles, each with a thought of their own; the goodbye in chat style', async () => {
    const m = await model(() => ({
      wrong: true,
      why: 'agreed on the house and kept going',
      urges: [
        { who: 'Ada', act: 'move_on', thought: "We've agreed on the house twice over; time I went and got the wood", say: 'Aight gonna go get wood' },
        { who: 'bram', act: 'move_on', thought: 'Enough talk, I should start on the house' },
      ],
    }));
    try {
      const r = rig({ llm: m.llm });
      circles(r);
      await r.c.sweep();
      // One case, judged once: Bram was pushed with Ada's, so his own isn't asked about.
      expect(m.asked).toHaveLength(1);
      expect(m.asked[0]?.system).toMatch(/Almost all of it is theirs to choose/);
      expect(m.asked[0]?.user).toMatch(/What looks wrong: Ada keeps saying the same things to Bram/);
      expect(m.asked[0]?.user).toMatch(/Ada's last lines \(oldest first\):\n- \(\d+ min ago\) we should build a house/);
      expect(m.asked[0]?.user).toMatch(/Bram's last lines/);
      expect(r.sent).toEqual([
        { who: 'Ada', urge: { act: 'move_on', thought: "We've agreed on the house twice over; time I went and got the wood", say: 'aight gonna go get wood', avoid: ['Bram'] } },
        { who: 'Bram', urge: { act: 'move_on', thought: 'Enough talk, I should start on the house', avoid: ['Ada'] } },
      ]);
      expect(r.steps[0]).toMatchObject({ kind: 'repeating', wrong: true, by: 'model' });
    } finally {
      m.stop();
    }
  });

  it('most cases are let be: nothing sent, and the same case not asked about again for a while', async () => {
    const m = await model(() => ({ wrong: false, why: 'just a long chat about plans', urges: [] }));
    try {
      const r = rig({ llm: m.llm });
      circles(r);
      await r.c.sweep();
      expect(r.sent).toEqual([]);
      expect(r.steps.map((s) => s.wrong)).toEqual([false, false]);
      const asked = m.asked.length;
      r.live(1, { Ada: { x: 0, z: 0 }, Bram: { x: 2, z: 1 } });
      await r.c.sweep();
      expect(m.asked.length).toBe(asked);
    } finally {
      m.stop();
    }
  });

  it("words that won't do as the person's own give way to code's: numbers, a stranger's name, the controller given away", async () => {
    expect(fitWords('Go to 120, 64 and dig', ['Ada'], ['Ada', 'Cyd'])).toBe(false);
    expect(fitWords('Cyd will know where the iron is', ['Ada'], ['Ada', 'Cyd'])).toBe(false);
    expect(fitWords("I've been nudged to move on", ['Ada'], ['Ada'])).toBe(false);
    expect(fitWords('...', ['Ada'], ['Ada'])).toBe(false);
    expect(fitWords('This server is laggy', ['Ada'], ['Ada'])).toBe(false);
    expect(fitWords('Bram and I keep going round in circles; time to go', ['Ada', 'Bram'], ['Ada', 'Bram', 'Cyd'])).toBe(true);
    const m = await model(() => ({ wrong: true, why: 'stuck', urges: [{ who: 'Gus', act: 'wander', thought: 'Walk to 12, 70 where Cyd mines', say: 'the controller says bye' }] }));
    try {
      const r = rig({ llm: m.llm });
      r.live(1, { Cyd: { x: 80, z: 80, move: 2 } });
      r.live(7, { Gus: { x: 5, z: 5, option: { option: 'work', skill: 'goto', status: 'running', startedAt: r.at() } }, Cyd: { x: 80, z: 80, move: 2 } });
      await r.c.sweep();
      expect(r.sent).toEqual([{ who: 'Gus', urge: { act: 'wander', thought: "I've been stuck in this spot too long; I should move", avoid: [] } }]);
    } finally {
      m.stop();
    }
  });

  it('a case that ends while the model thinks is dropped', async () => {
    let r!: ReturnType<typeof rig>;
    const m = await model(
      () => ({ wrong: true, why: 'stuck', urges: [{ who: 'Gus', act: 'wander', thought: 'I should move' }] }),
      () => r.c.observe('Gus', 'state', { pos: { x: 40, y: 64, z: 40 }, option: { option: 'work', skill: 'goto', status: 'running', startedAt: 0 } }),
    );
    try {
      r = rig({ llm: m.llm });
      r.live(7, { Gus: { x: 5, z: 5, option: { option: 'work', skill: 'goto', status: 'running', startedAt: r.at() } } });
      await r.c.sweep();
      expect(m.asked).toHaveLength(1);
      expect(r.sent).toEqual([]);
    } finally {
      m.stop();
    }
  });
});

describe('without a model, and the limits', () => {
  it("code pushes in the clearest cases: what keeps failing given up, in the person's own words", async () => {
    const r = rig();
    r.live(10, { Fay: { x: 0, z: 0, move: 1 } }, (i) => {
      if (i % 25 === 0) r.did('Fay', 'craft', false, { item: 'iron_pickaxe' }, 'missing 3 iron_ingot');
    });
    await r.c.sweep();
    expect(r.sent).toEqual([{ who: 'Fay', urge: { act: 'drop_task', thought: "Trying to craft iron pickaxe again and again isn't working; I'll do something else for now", avoid: [], task: { skill: 'craft', item: 'iron_pickaxe' } } }]);
    expect(r.steps[0]).toMatchObject({ by: 'code', kind: 'fail_loop' });
  });

  it('at most so many an hour, a person let be after a push, and none for anyone it is switched off for', async () => {
    const r = rig({ maxPerHour: 1, leaveBe: (n) => n === 'Ivy' });
    r.live(7, { Gus: { x: 5, z: 5, option: { option: 'work', skill: 'goto', status: 'running', startedAt: 0 } }, Hal: { x: 50, z: 5, option: { option: 'work', skill: 'goto', status: 'running', startedAt: 0 } }, Ivy: { x: 90, z: 5, option: null } });
    await r.c.sweep();
    expect(r.sent.map((s) => s.who)).toEqual(['Gus']);
    // Still stuck a minute on: Gus is let be (just pushed), Hal waits for the hour's cap, Ivy is never pushed.
    r.live(1, { Gus: { x: 5, z: 5, option: { option: 'work', skill: 'goto', status: 'running', startedAt: 0 } }, Hal: { x: 50, z: 5, option: { option: 'work', skill: 'goto', status: 'running', startedAt: 0 } }, Ivy: { x: 90, z: 5, option: null } });
    await r.c.sweep();
    expect(r.sent.map((s) => s.who)).toEqual(['Gus']);
    expect(r.c.oddities().map((o) => o.agent)).toEqual(['Hal']);
  });
});
