// M3 (§10): the single-agent PIANO modules without Minecraft: pure parts, then modules against fakes and the mocked
// NanoGPT. Live behavior is in tests/live/m3-agent.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { type AgentState, ModelsConfigSchema, PersonaSchema, type Utterance, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import type { Body } from '@agora/agent/body/body';
import type { SkillRunRecord } from '@agora/agent/body/skills/runner';
import { AgentBus } from '@agora/agent/bus';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { buildPacket } from '@agora/agent/modules/bottleneck';
import { CognitiveController, codeDecision, validateDecision } from '@agora/agent/modules/cc';
import { evalCondition } from '@agora/agent/modules/conditions';
import { Conversations, detectAddressee, textSimilarity } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { GIVEAWAY_RE, Talking, cleanReply, looksLikePromise, needsDecision } from '@agora/agent/modules/talking';
import { parseSystemLine } from '@agora/agent/perception/system';
import { createInitialState } from '@agora/agent/state/initial';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, standardModels, schemaNameOf } from '../llm/fakeNanoGpt';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['curious', 'generous'], speech: { maxWords: 20 } });
const store = () => new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withState(patch: (s: AgentState) => AgentState): AgentState {
  return patch(createInitialState({ persona, username: 'Pip', now: 0 }));
}

describe('addressing and conversations (§6.2)', () => {
  it('detects who a line is for', () => {
    const base = { me: 'Pip', speaker: 'Bram', inConversationWith: false };
    expect(detectAddressee({ ...base, text: 'hey Pip, got wood?', inRange: ['Bram', 'Mira'] })).toBe('me');
    expect(detectAddressee({ ...base, text: '@pip over here', inRange: ['Bram', 'Mira'] })).toBe('me');
    expect(detectAddressee({ ...base, text: 'Mira, come here', inRange: ['Bram', 'Mira'] })).toBe('other');
    expect(detectAddressee({ ...base, text: 'anyone got wood?', inRange: ['Bram'] })).toBe('me');
    expect(detectAddressee({ ...base, text: 'anyone got wood?', inRange: ['Bram', 'Mira'] })).toBe('unsure');
    expect(detectAddressee({ ...base, text: 'and then?', inRange: ['Bram', 'Mira'], inConversationWith: true })).toBe('me');
  });

  it('scores repetition', () => {
    expect(textSimilarity('I need some wood please', 'I need some wood please!')).toBeGreaterThan(0.92);
    expect(textSimilarity('I need some wood', 'nice weather today')).toBeLessThan(0.3);
  });

  it('opens on an addressed line, ends at the turn cap, and cools the pair down', () => {
    const s = store();
    const bus = new AgentBus();
    const ended: string[] = [];
    bus.on('conversationEnded', (e) => ended.push(e.reason));
    const conv = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Bram'], rng: () => 0 });
    conv.start();
    const u: Utterance = { id: 'u1', convId: '', from: 'Bram', to: ['Pip'], text: 'hi Pip', ts: 0, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true };
    bus.emit({ type: 'heard', utterance: u });
    const c = conv.withPartner('Bram');
    expect(c?.transcript).toHaveLength(1);
    expect(s.state.perception.heardSpeech[0]?.convId).toBe(c?.convId);
    const cap = 4 + Math.round(6 * persona.big5.extraversion);
    let alive = true;
    for (let i = 0; i < cap && alive; i++) alive = conv.noteOwnUtterance(c?.convId ?? '', `line number ${i} about ${['wood', 'stone', 'iron', 'sheep', 'boats', 'bread', 'maps', 'caves', 'rain', 'stars'][i]}`);
    expect(alive).toBe(false);
    expect(ended).toEqual(['turn cap']);
    expect(conv.mayInitiate('Bram')).toBe(false);
    conv.stop();
  });

  it('a conversation nobody has spoken in for a minute ends, whoever spoke last (a stroll is not held for it)', () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const s = store();
      const bus = new AgentBus();
      const ended: string[] = [];
      bus.on('conversationEnded', (e) => ended.push(e.reason));
      const conv = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Bram'], rng: () => 0, now: () => t });
      conv.start();
      bus.emit({ type: 'heard', utterance: { id: 'u1', convId: '', from: 'Bram', to: ['Pip'], text: 'hi Pip', ts: 0, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true } });
      // Pip never answers, and Bram stands there saying nothing more.
      t = 30_000;
      vi.advanceTimersByTime(1000);
      expect(conv.withPartner('Bram')?.status).toBe('active');
      t = 61_000;
      vi.advanceTimersByTime(1000);
      expect(ended).toEqual(['went quiet']);
      conv.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('our line unanswered by someone right here: the talk ends quietly, with no "you still there?"', () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const s = store();
      const bus = new AgentBus();
      const ended: string[] = [];
      const asked: string[] = [];
      bus.on('conversationEnded', (e) => ended.push(e.reason));
      bus.on('needsDecision', (e) => asked.push(e.reason));
      const conv = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Bram'], rng: () => 0, now: () => t });
      conv.start();
      const c = conv.open('Bram', true);
      conv.noteOwnUtterance(c.convId, 'bram wanna go mining?');
      // Bram stands right there and says nothing: no nudge, nothing asked of the mind.
      t = 20_000;
      vi.advanceTimersByTime(1000);
      expect(conv.withPartner('Bram')?.status).toBe('active');
      expect(asked).toEqual([]);
      t = 26_000;
      vi.advanceTimersByTime(1000);
      expect(ended).toEqual(['partner silent']);
      expect(asked).toEqual([]);
      // Answered in time, the talk goes on.
      const d = conv.open('Bram', true);
      t = 100_000;
      conv.noteOwnUtterance(d.convId, 'so, mining?');
      bus.emit({ type: 'heard', utterance: { id: 'u2', convId: '', from: 'Bram', to: ['Pip'], text: 'sure lets go', ts: 104_000, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true } });
      t = 125_000;
      vi.advanceTimersByTime(1000);
      expect(conv.withPartner('Bram')?.status).toBe('active');
      conv.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('in a conversation of two, a line plainly for someone else is not for us', () => {
    const s = store();
    const bus = new AgentBus();
    const got: string[] = [];
    bus.on('addressed', (e) => got.push(`addressed: ${e.utterance.text}`));
    bus.on('overheard', (e) => got.push(`overheard: ${e.utterance.text}`));
    const conv = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Bram', 'Cyd'], rng: () => 0 });
    conv.start();
    const line = (id: string, text: string, heardAs: 'me' | 'other' | 'unsure'): Utterance => ({ id, convId: '', from: 'Bram', to: heardAs === 'me' ? ['Pip'] : 'nearby', text, ts: 0, pos: null, volume: 'normal', outOfSight: false, addressedToMe: heardAs === 'me', heardAs });
    bus.emit({ type: 'heard', utterance: line('u1', 'Pip, what do you think of Rex?', 'me') });
    bus.emit({ type: 'heard', utterance: line('u2', 'and then?', 'unsure') });
    bus.emit({ type: 'heard', utterance: line('u3', 'Cyd, what do you think of Rex?', 'other') });
    expect(got).toEqual(['addressed: Pip, what do you think of Rex?', 'addressed: and then?', 'overheard: Cyd, what do you think of Rex?']);
    conv.stop();
  });
});

describe('conditions, levers and the packet (§4.3, §4.4, §21.1)', () => {
  it('evaluates the until/doneWhen grammar', () => {
    const s = withState((x) => ({
      ...x,
      self: { ...x.self, inventory: [{ item: 'oak_log', qty: 5 }, { item: 'birch_log', qty: 3 }], health: 15, isDay: false, pos: { x: 10, y: 64, z: -5 } },
      perception: { ...x.perception, nearbyEntities: [{ id: 1, kind: 'player', name: 'Bram', pos: { x: 0, y: 0, z: 0 }, distance: 8, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }] },
    }));
    expect(evalCondition('inventoryHas:oak_log>=5', s)).toBe(true);
    expect(evalCondition('inventoryHas:log>=8', s)).toBe(true);
    // A kind of wood counts any wood (the birch too): all serve alike.
    expect(evalCondition('inventoryHas:oak_log>5', s)).toBe(true);
    expect(evalCondition('inventoryHas:oak_log>8', s)).toBe(false);
    expect(evalCondition('agentInRange:Bram', s)).toBe(true);
    expect(evalCondition('agentLeftRange:Bram', s)).toBe(false);
    expect(evalCondition('timeIs:night', s)).toBe(true);
    expect(evalCondition('healthAbove:10', s)).toBe(true);
    expect(evalCondition('near:11,64,-5', s)).toBe(true);
    expect(evalCondition('fly to the moon', s)).toBeNull();
  });

  it('scales the mind with intelligence (anchors at 0.2 and 0.8)', () => {
    expect(leversFor(0.2)).toMatchObject({ ccTier: 'L1', memories: 3, tasks: 2, people: 3, queueDepth: 2, candidates: 2, slipChance: 0.08 });
    expect(leversFor(0.8)).toMatchObject({ ccTier: 'L2', memories: 6, tasks: 5, people: 6, queueDepth: 6, candidates: 4, slipChance: 0.01 });
    expect(leversFor(0.2, false).ccTier).toBe('L2');
    expect(leversFor(0.2).planDepth).toBeLessThan(leversFor(0.8).planDepth);
  });

  it('builds a narrow packet with forced social inclusion and capacity limits', () => {
    const people = ['Bram', 'Mira', 'Tobin', 'Ada', 'Cole'].map((name, i) => ({
      id: i,
      kind: 'player' as const,
      name,
      pos: { x: i, y: 64, z: 0 },
      distance: 3 + i,
      visible: true,
      heldItem: null,
      armor: [],
      lastSeen: 0,
      hurtRecently: false,
    }));
    const s = withState((x) => ({ ...x, perception: { ...x.perception, nearbyEntities: people }, goals: { ...x.goals, current: { id: 'g', text: 'get stone tools', kind: 'current', createdAt: 0, status: 'active' } } }));
    const low = buildPacket({ state: s, levers: leversFor(0.2), reason: 'checking in', stuck: ['gather(item="oak_log"): no trees'], now: 0 });
    expect(low).toContain('Current goal: get stone tools');
    expect(low).toContain('Bram (3 m');
    expect(low).not.toContain('Ada');
    expect(low).toContain('Not working lately: gather');
    expect(buildPacket({ state: s, levers: leversFor(0.8), reason: 'x', now: 0 })).toContain('Ada');
  });
});

describe('decision checks and the code default (§4.3, §22.4)', () => {
  const env = { me: 'Pip', isStuck: (skill: string) => skill === 'mine', canPerceive: (n: string) => n === 'Bram' };
  const base = { terminate: { maxSeconds: 60 }, rationale: 'r' };

  it('rejects decisions code can see are wrong', () => {
    expect(validateDecision({ ...base, option: 'work' }, env)).toMatch(/needs a task/);
    expect(validateDecision({ ...base, option: 'work', task: { skill: 'teleport', args: {} } }, env)).toMatch(/no skill/);
    expect(validateDecision({ ...base, option: 'work', task: { skill: 'gather', args: {} } }, env)).toMatch(/bad arguments/);
    expect(validateDecision({ ...base, option: 'work', task: { skill: 'mine', args: { block: 'stone' } } }, env)).toMatch(/stuck/);
    expect(validateDecision({ ...base, option: 'talk' }, env)).toMatch(/target/);
    expect(validateDecision({ ...base, option: 'talk', target: { agent: 'Ghost' } }, env)).toMatch(/can't see/);
    expect(validateDecision({ ...base, option: 'work', task: { skill: 'get', args: { item: 'stone_pickaxe' } } }, env)).toBeNull();
  });

  it('keeps working without an LLM: no digging in at night as a matter of course, then the goal, then the prerequisite it was told to get first', () => {
    const never = () => false;
    const night = withState((x) => ({ ...x, self: { ...x.self, isDay: false } }));
    // The night is no reason to hide: with nothing to do, a stroll close to home, never standing frozen.
    const atNight = codeDecision(night, {}, false, never)?.task;
    expect([atNight?.skill, atNight?.args.radius]).toEqual(['wander', 8]);
    const day = withState((x) => ({ ...x, self: { ...x.self, isDay: true, time: 6000 } }));
    const byDay = codeDecision(day, {}, false, never)?.task;
    expect([byDay?.skill, byDay?.args.radius]).toEqual(['wander', 16]);
    // Out after dark a short run from a home with a hut at it: back home. Far off: a night's hut there, not the whole
    // dark way home.
    const away = withState((x) => ({ ...x, self: { ...x.self, isDay: false, pos: { x: 60, y: 64, z: 0 } }, village: { ...x.village, home: { x: 0, y: 64, z: 0 }, huts: [{ x: 2, y: 64, z: 1 }] }, scene: { ...x.scene, where: 'In plains, standing on grass block, under the open sky' } }));
    expect(codeDecision(away, {}, false, never)?.task).toEqual({ skill: 'goTo', args: { x: 0, y: 64, z: 0, range: 4 } });
    // Nothing built at home: no run through the dark to it, a night's hut here (one at 3.5 health was sent 40 m to an
    // empty field).
    const bare = { ...away, village: { ...away.village, huts: [] } };
    expect(codeDecision(bare, {}, false, never)?.task).toEqual({ skill: 'build', args: { structure: 'hut', room: 1 } });
    const farOff = { ...away, self: { ...away.self, pos: { x: 200, y: 64, z: 0 } } };
    expect(codeDecision(farOff, {}, false, never)?.task).toEqual({ skill: 'build', args: { structure: 'hut', room: 1 } });
    // In a tunnel, the dark is no news: no walk home across the open in it.
    const below = { ...away, scene: { ...away.scene, where: 'In plains, standing on stone, under a roof' } };
    expect(codeDecision(below, {}, false, never)?.task?.skill).not.toBe('goTo');
    // With a model, hiding is the model's call (gated below); a decision of the code default's never hides.
    const scared = { ...away, emotions: { ...away.emotions, fear: 0.8 } };
    expect(codeDecision(scared, {}, false, never, { candidates: [], roll: 0.9 })?.task?.skill).toBe('goTo');
    const bram = { id: 7, kind: 'player' as const, name: 'Bram', pos: { x: 110, y: 64, z: 0 }, distance: 10, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false };
    const company = { ...scared, perception: { ...scared.perception, nearbyEntities: [bram] } };
    // The code-only brain (no model at all) digs in at night, with others or not: without a mind to choose better, it
    // was that or be shot down in the open (M8's village).
    expect(codeDecision(company, {}, false, never, { candidates: [], roll: 0.9, codeOnly: true })?.task?.skill).toBe('shelter');
    expect(codeDecision(night, {}, false, never, { candidates: [], roll: 0.9, codeOnly: true })?.task?.skill).toBe('shelter');
    // The hole is the code-only brain's routine, no hand of a mind's: a mind that names it is told there is none.
    const env = { me: 'Pip', isStuck: never, canPerceive: () => true };
    const hole = { option: 'work' as const, task: { skill: 'shelter', args: {} }, terminate: { maxSeconds: 600 }, rationale: 'scared' };
    expect(validateDecision(hole, env)).toMatch(/there is no skill "shelter"/);
    expect(validateDecision({ ...hole, task: { skill: 'hide', args: {} } }, env)).toMatch(/there is no skill "hide"/);
    expect(validateDecision(hole, { ...env, codeOnly: true })).toBeNull();
    // Its own way dug is: into the wall, the way behind closed.
    expect(validateDecision({ ...hole, task: { skill: 'tunnel', args: { direction: 'west', blocks: 2, close: true } } }, env)).toBeNull();
    const goal = withState((x) => ({ ...x, goals: { ...x.goals, current: { id: 'g', text: 'stone tools', kind: 'current', createdAt: 0, status: 'active', doneWhen: 'inventoryHas:stone_pickaxe>=1' } } }));
    expect(codeDecision(goal, {}, false, never)?.task).toEqual({ skill: 'obtain', args: { item: 'stone_pickaxe', qty: 1 } });
    const deep = {
      ...goal,
      actionLog: [{ id: 'a', skill: 'obtain', args: { item: 'stone_pickaxe', qty: 1 }, expected: '', observed: '', ok: false, ts: 0, durationMs: 1, error: "that's too many steps to work out at once; get cobblestone first" }],
    };
    expect(codeDecision(deep, {}, false, never)?.task).toEqual({ skill: 'obtain', args: { item: 'cobblestone', qty: 1 } });
    const asked = codeDecision(goal, { from: 'Bram', convId: 'c1' }, true, never);
    expect(asked?.speechIntent).toMatchObject({ mayCommit: false, stance: 'decline' });
    expect(codeDecision(goal, {}, true, never)).toBeNull();
  });

  it('for a mind whose thought did not come, chooses nothing beyond the body’s needs and the mind’s own next step (owner request, 2026-10-25)', () => {
    const goal = withState((x) => ({ ...x, goals: { ...x.goals, current: { id: 'g', text: 'iron armor', kind: 'current', createdAt: 0, status: 'active', doneWhen: 'inventoryHas:iron_chestplate>=1' } } }));
    const never = () => false;
    const thinking = { candidates: [], roll: 0.5, thinking: true };
    // No goal step of the code's: a moment, and the mind is asked again.
    expect(codeDecision(goal, {}, false, never)?.task?.skill).toBe('obtain');
    expect(codeDecision(goal, {}, false, never, thinking)).toMatchObject({ option: 'rest', terminate: { maxSeconds: 10 } });
    // What the mind meant to do next goes on.
    const meant = { ...goal, taskQueue: [{ id: 't1', skill: 'smelt', args: { item: 'raw_iron', qty: 8 }, source: 'cc' as const, createdAt: 0, priority: 1 }] };
    expect(codeDecision(meant, {}, false, never, thinking)?.task).toEqual({ skill: 'smelt', args: { item: 'raw_iron', qty: 8 } });
    // Starving with nothing to eat, the body goes for food all the same (eating what it carries is a reflex's).
    const cow = { id: 9, kind: 'passive' as const, name: 'cow', pos: { x: 8, y: 64, z: 0 }, distance: 8, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false };
    const starving = { ...goal, self: { ...goal.self, food: 3, inventory: [] }, perception: { ...goal.perception, nearbyEntities: [cow] } };
    expect(codeDecision(starving, {}, false, never, thinking)?.task?.skill).toBe('hunt');
  });
});

describe('Talking guards (§6.2, §6.4, §13 rule 3, §16.1)', () => {
  it('recognizes promises, requests and giveaways, and cleans replies', () => {
    for (const t of ["Sure, I'll bring you 8 logs!", 'deal', 'I promise', "you got it, I'm on it"]) expect(looksLikePromise(t)).toBe(true);
    for (const t of ['hmm, let me think about it', 'what do you need them for?', 'nice day']) expect(looksLikePromise(t)).toBe(false);
    expect(needsDecision('Pip, can you give me 8 logs?')).toBe(true);
    expect(needsDecision('nice weather')).toBe(false);
    // Someone stalling for time asks for nothing.
    expect(needsDecision('give me a sec to think')).toBe(false);
    expect(needsDecision('give me a moment')).toBe(false);
    expect(needsDecision('give me a stone pickaxe')).toBe(true);
    expect(GIVEAWAY_RE.test('As an AI I cannot do that')).toBe(true);
    expect(GIVEAWAY_RE.test('I am a builder')).toBe(false);
    expect(cleanReply('Pip: "ooh, logs? why?"\nsecond line', 'Pip', 20)).toBe('ooh, logs? why?');
    expect(cleanReply('/give @a diamond', 'Pip', 20)).toBe('give @a diamond');
  });

  it('never promises without mayCommit, even when the model insists, and wakes the CC', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: "Sure, I'll bring you 8 logs right away!" });
    const rt = await startLlm({
      apiKey: 'k',
      config: ModelsConfigSchema.parse({}),
      logger: nullLogger(),
      fetch: fake.fetch,
      background: false,
      limiter: new LocalRateLimiter({ rps: 10_000 }),
    });
    const s = store();
    const bus = new AgentBus();
    const said: string[] = [];
    const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => null, run: () => Promise.reject(new Error('unused')) } as unknown as Body;
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Bram'], rng: () => 0 });
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: rt.client, conversations, executor, me: 'Pip', rng: () => 0 });
    const asks: string[] = [];
    bus.on('needsDecision', (e) => asks.push(`${e.reason}:${e.from ?? ''}`));
    conversations.start();
    talking.start();
    bus.emit({
      type: 'heard',
      utterance: { id: 'u', convId: '', from: 'Bram', to: ['Pip'], text: 'Pip, can you give me 8 logs?', ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: true },
    });
    for (let i = 0; i < 40 && said.length === 0; i++) await wait(50);
    expect(asks).toEqual(['request:Bram']);
    expect(said).toEqual(['let me think about it.']);
    expect(fake.chatRequests().length).toBe(2);
    expect(String(fake.chatRequests()[0]?.body?.messages && JSON.stringify(fake.chatRequests()[0]?.body?.messages))).toMatch(/Do not promise/);
    talking.stop();
    conversations.stop();
  });
});

describe('Cognitive Controller against the mocked NanoGPT', () => {
  it('rejects an impossible decision, retries once with the reason, and broadcasts the fixed one', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let n = 0;
    fake.chat = ({ body }) => {
      const name = schemaNameOf(body);
      if (name !== 'decision') return { text: '{"summary":"ok"}' };
      n++;
      return n === 1
        ? { text: JSON.stringify({ option: 'work', task: { skill: 'teleport', args: {} }, terminate: { maxSeconds: 60 }, rationale: 'fast' }) }
        : { text: JSON.stringify({ option: 'work', task: { skill: 'obtain', args: { item: 'stone_pickaxe', qty: 1 } }, terminate: { maxSeconds: 600 }, rationale: 'need tools' }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    cc.trigger('testing');
    for (let i = 0; i < 40 && decided.length === 0; i++) await wait(25);
    expect(decided).toEqual(['llm:obtain']);
    expect(s.state.option).toMatchObject({ option: 'work', skill: 'obtain', status: 'running' });
    const retry = fake.chatRequests()[1]?.body?.messages as { role: string; content: string }[];
    expect(retry.at(-1)?.content).toMatch(/no skill "teleport"/);
    // Kept in mind: the next decision sees it was reached for and could not be done, and why.
    expect(s.state.mind.ruledOut).toEqual([expect.objectContaining({ what: 'teleport {}', n: 1 })]);
    const packet = buildPacket({ state: s.state, levers: leversFor(0.5), reason: 'again', now: Date.now() });
    expect(packet).toMatch(/Lately you reached for what you can't do now:\n {2}- teleport \{\}: there is no skill "teleport"[^\n]*\(once, /);
  });
});

describe('thinking under fire (owner request, 2026-10-24: think, don\'t follow directives)', () => {
  it('in danger the mind thinks at once, and what it chooses is done in the danger: eat, then the step meant next; "get away" is left to the legs', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const asked: string[] = [];
    let reply: object = { thought: 'Two zombies and I am at 5. Eat the steak while the legs carry me, then up the tunnel.', option: 'work', task: { skill: 'eat', args: { item: 'cooked_beef' } }, terminate: { maxSeconds: 20 }, rationale: 'heal', then: [{ skill: 'goTo', args: { x: 10, y: 70, z: 0 } }] };
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      asked.push(JSON.stringify(body?.messages ?? ''));
      return { text: JSON.stringify(reply) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const ran: string[] = [];
    const finish = new Map<string, () => void>();
    const body = {
      skill: () => ({ talkOverable: true }),
      run: (skill: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
        new Promise<SkillRunRecord>((resolve) => {
          ran.push(skill);
          const rec = (ok: boolean, aborted: boolean): SkillRunRecord => ({ id: 'r', skill, args, expected: 'x', observed: aborted ? 'interrupted' : 'done', ok, mismatch: false, aborted, slip: null, startedAt: 0, durationMs: 1, ...(aborted ? { error: 'aborted' } : {}) });
          finish.set(skill, () => resolve(rec(true, false)));
          opts.signal.addEventListener('abort', () => resolve(rec(false, true)), { once: true });
        }),
    } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    executor.start();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    let runs = 0;
    const cc = new CognitiveController({
      store: s,
      bus,
      logger: nullLogger(),
      llm: rt.client,
      me: 'Pip',
      levers: () => leversFor(0.5),
      awareness,
      executor,
      canPerceive: () => false,
      bodyInDanger: () => 'running from 2 zombies (the nearest 3 m off)',
      runNow: () => runs++,
    });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    cc.start();
    s.update('self', (x) => ({ ...x, health: 5, inventory: [{ item: 'cooked_beef', qty: 4 }] }));
    s.update('flags', (f) => ({ ...f, inDanger: true }), 'danger');
    bus.emit({ type: 'danger', source: 'zombie', level: 0.6, kind: 'flee' });
    for (let i = 0; i < 80 && decided.length === 0; i++) await wait(25);
    expect(decided).toEqual(['llm:eat']);
    expect(asked[0]).toMatch(/danger: zombie; your body is running from 2 zombies \(the nearest 3 m off\)\. You are in danger now: think fast/);
    expect(s.state.option).toMatchObject({ skill: 'eat', status: 'running', underFire: true });
    for (let i = 0; i < 40 && !ran.includes('eat'); i++) await wait(25);
    // The danger goes on (the body's own alarms): what was chosen goes on with it.
    bus.emit({ type: 'danger', source: 'zombie', level: 0.6, kind: 'fight' });
    await wait(100);
    expect(s.state.option?.status).toBe('running');
    // Eaten: on to the step meant next, still in the danger, without stopping to think.
    finish.get('eat')?.();
    for (let i = 0; i < 80 && decided.length < 2; i++) await wait(25);
    expect(decided).toEqual(['llm:eat', 'intention:goTo']);
    expect(s.state.option).toMatchObject({ skill: 'goTo', underFire: true });
    // A hazard (water, lava) still stops it: the body sees to those first. Then, thought again under fire: this
    // time, away. The legs do it; no option is set for it.
    const ends: string[] = [];
    bus.on('optionTerminated', (e) => ends.push(e.reason));
    for (let i = 0; i < 40 && !ran.includes('goTo'); i++) await wait(25);
    reply = { thought: 'Too many. Run.', option: 'flee', terminate: { maxSeconds: 20 }, rationale: 'away' };
    bus.emit({ type: 'danger', source: 'water', level: 0.9, kind: 'hazard' });
    for (let i = 0; i < 40 && ends.length === 0; i++) await wait(25);
    expect(ends).toEqual(['danger']);
    for (let i = 0; i < 120 && runs === 0; i++) await wait(25);
    expect(runs).toBe(1);
    cc.stop();
    executor.stop();
  }, 15_000);

  it('a thought of before the danger still in flight as it comes: dropped, and the thought under fire comes next, at a glance', async () => {
    // Skipped while that one was in flight, the first thought under fire waited for the next blow: five zombies took a
    // body from 7 health to none before any came.
    const fake = new FakeNanoGpt(standardModels());
    const asked: string[] = [];
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      const m = JSON.stringify(body?.messages ?? '');
      asked.push(m);
      if (!/You are in danger now/.test(m)) return { text: JSON.stringify({ thought: 'Wood next.', option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'x' }), delayMs: 5000 };
      return { text: JSON.stringify({ thought: 'Three of them. Back down the tunnel.', option: 'flee', terminate: { maxSeconds: 20 }, rationale: 'away' }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    let runs = 0;
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false, bodyInDanger: () => 'running from 3 zombies (the nearest 2 m off)', runNow: () => runs++ });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    cc.start();
    cc.trigger('testing', { urgent: true });
    for (let i = 0; i < 40 && asked.length === 0; i++) await wait(25);
    expect(asked.length).toBe(1);
    const t0 = Date.now();
    s.update('flags', (f) => ({ ...f, inDanger: true }), 'danger');
    bus.emit({ type: 'danger', source: 'zombie', level: 0.6, kind: 'flee' });
    for (let i = 0; i < 80 && runs === 0; i++) await wait(25);
    expect(runs).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(decided).toEqual(['llm:flee']);
    // At a glance: the steps for when there is time are not asked for.
    expect(asked[1]).toMatch(/there is no time to think it all through/);
    expect(asked[1]).not.toMatch(/Did anything surprise you/);
    cc.stop();
    executor.stop();
  }, 15_000);

  it('out of danger, nothing waits on it: a thought is had as before, and what was meant before the danger is not taken for under fire', async () => {
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    cc.start();
    // A plain trigger in danger is held until it is over (no code default under fire).
    s.update('flags', (f) => ({ ...f, inDanger: true }), 'danger');
    bus.emit({ type: 'danger', source: 'zombie', level: 0.6, kind: 'flee' });
    cc.trigger('testing');
    await wait(300);
    expect(decided).toEqual([]);
    s.update('flags', (f) => ({ ...f, inDanger: false }), 'over');
    bus.emit({ type: 'dangerCleared' });
    for (let i = 0; i < 40 && decided.length === 0; i++) await wait(25);
    expect(decided.length).toBe(1);
    expect(s.state.option?.underFire).toBeUndefined();
    cc.stop();
  });
});

describe('a look up from long work', () => {
  it('three minutes and more at one piece of work, it thinks a moment, and the same work goes on, not begun again', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const asked: string[] = [];
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      asked.push(JSON.stringify(body?.messages ?? ''));
      return { text: JSON.stringify({ option: 'work', task: { skill: 'prospect', args: { item: 'iron_ore' } }, terminate: { maxSeconds: 900 }, rationale: 'iron' }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    executor.start();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const clock = { t: Date.now() };
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false, now: () => clock.t });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    cc.start();
    cc.trigger('testing');
    for (let i = 0; i < 40 && decided.length === 0; i++) await wait(25);
    const started = s.state.option?.startedAt;
    // Two minutes in: nothing yet.
    clock.t += 2 * 60_000;
    await wait(2300);
    expect(decided).toEqual(['llm:prospect']);
    clock.t += 2 * 60_000;
    for (let i = 0; i < 120 && decided.length < 2; i++) await wait(25);
    cc.stop();
    executor.stop();
    expect(decided).toEqual(['llm:prospect', 'llm:prospect']);
    expect(asked.at(-1)).toMatch(/you have been at prospect for 4 min; you look up from the work a moment/);
    expect(s.state.option?.startedAt).toBe(started);
  }, 15_000);

  it('a wait for the day is no work to look up from: it ends on its own, or when something happens', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let asked = 0;
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      asked++;
      return { text: JSON.stringify({ option: 'rest', task: { skill: 'wait', args: { until: 'day' } }, terminate: { maxSeconds: 600 }, rationale: 'sealed in' }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    executor.start();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const clock = { t: Date.now() };
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false, now: () => clock.t });
    cc.start();
    cc.trigger('testing');
    for (let i = 0; i < 40 && asked === 0; i++) await wait(25);
    expect(s.state.option?.skill).toBe('wait');
    clock.t += 4 * 60_000;
    await wait(2500);
    cc.stop();
    executor.stop();
    expect(asked).toBe(1);
  }, 15_000);
});

describe('the world changed since the steps were meant', () => {
  /** A walk away meant with wood to gather after it; `change` happens on the way. What was decided, and what asked. */
  async function stepsAfter(change: (s: ReturnType<typeof store>) => void): Promise<{ decided: string[]; asked: string[] }> {
    const fake = new FakeNanoGpt(standardModels());
    const asked: string[] = [];
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      asked.push(JSON.stringify(body?.messages ?? ''));
      return { text: JSON.stringify({ thought: 'Back off, then wood.', option: 'work', task: { skill: 'goTo', args: { x: 10, y: 64, z: 0 } }, terminate: { maxSeconds: 60 }, rationale: 'away', then: [{ skill: 'gather', args: { item: 'oak_log', qty: 8 } }] }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const finish = new Map<string, () => void>();
    const body = {
      skill: () => ({ talkOverable: true }),
      run: (skill: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
        new Promise<SkillRunRecord>((resolve) => {
          const rec = (ok: boolean, aborted: boolean): SkillRunRecord => ({ id: 'r', skill, args, expected: 'x', observed: aborted ? 'interrupted' : 'done', ok, mismatch: false, aborted, slip: null, startedAt: 0, durationMs: 1, ...(aborted ? { error: 'aborted' } : {}) });
          finish.set(skill, () => resolve(rec(true, false)));
          opts.signal.addEventListener('abort', () => resolve(rec(false, true)), { once: true });
        }),
    } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    executor.start();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    s.update('self', (x) => ({ ...x, health: 18, isDay: true }));
    cc.start();
    cc.trigger('testing', { urgent: true });
    for (let i = 0; i < 80 && !finish.has('goTo'); i++) await wait(25);
    change(s);
    finish.get('goTo')?.();
    for (let i = 0; i < 80 && decided.length < 2; i++) await wait(25);
    cc.stop();
    executor.stop();
    return { decided, asked };
  }

  it('badly hurt: the steps wait for a thought (nobody goes on to gather logs at one heart without one)', async () => {
    const { decided, asked } = await stepsAfter((s) => s.update('self', (x) => ({ ...x, health: 5 })));
    expect(decided[1]).toBe('llm:goTo');
    expect(decided).not.toContain('intention:gather');
    expect(asked.at(-1)).toMatch(/you meant to gather next, but you have been hurt since you decided \(health 18 to 5\)/);
  }, 15_000);

  it('night come on: the steps wait for a thought', async () => {
    const { decided, asked } = await stepsAfter((s) => s.update('self', (x) => ({ ...x, isDay: false, time: 14_000 })));
    expect(decided[1]).toBe('llm:goTo');
    expect(decided).not.toContain('intention:gather');
    expect(asked.at(-1)).toMatch(/you meant to gather next, but night has fallen since you decided/);
  }, 15_000);

  it('a wait for the day cut short before it came: what was meant for the morning waits for a thought', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const asked: string[] = [];
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      asked.push(JSON.stringify(body?.messages ?? ''));
      return { text: JSON.stringify({ thought: 'Sit tight till morning, then wool.', option: 'rest', task: { skill: 'wait', args: { until: 'day' } }, terminate: { maxSeconds: 600 }, rationale: 'night', then: [{ skill: 'obtain', args: { item: 'white_wool', qty: 3 } }] }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const finish = new Map<string, (observed: string) => void>();
    const body = {
      skill: () => ({ talkOverable: true }),
      run: (skill: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
        new Promise<SkillRunRecord>((resolve) => {
          finish.set(skill, (observed) => resolve({ id: 'r', skill, args, expected: 'x', observed, ok: true, mismatch: false, aborted: false, slip: null, startedAt: 0, durationMs: 1 }));
          opts.signal.addEventListener('abort', () => resolve({ id: 'r', skill, args, expected: 'x', observed: 'interrupted', ok: false, mismatch: false, aborted: true, slip: null, startedAt: 0, durationMs: 1, error: 'aborted' }), { once: true });
        }),
    } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    executor.start();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    s.update('self', (x) => ({ ...x, isDay: false, time: 15_000 }));
    cc.start();
    cc.trigger('testing', { urgent: true });
    for (let i = 0; i < 80 && !finish.has('wait'); i++) await wait(25);
    finish.get('wait')?.('stopped waiting early, after 2s');
    for (let i = 0; i < 80 && decided.length < 2; i++) await wait(25);
    cc.stop();
    executor.stop();
    expect(decided).not.toContain('intention:obtain');
    expect(asked.at(-1)).toMatch(/you meant to obtain next, but the wait for day was cut short before it came \(stopped waiting early, after 2s\)/);
  }, 15_000);

  it('a long wait meant for the night, come to under the open sky: a look round first (one waited it out beside his hut)', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const asked: string[] = [];
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      asked.push(JSON.stringify(body?.messages ?? ''));
      return { text: JSON.stringify({ thought: 'Into the hut, then wait for the day.', option: 'work', task: { skill: 'goTo', args: { x: -49, y: 78, z: 55 } }, terminate: { maxSeconds: 60 }, rationale: 'shelter', then: [{ skill: 'wait', args: { seconds: 480, until: 'day' } }] }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const finish = new Map<string, () => void>();
    const body = {
      skill: () => ({ talkOverable: true }),
      run: (skill: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
        new Promise<SkillRunRecord>((resolve) => {
          finish.set(skill, () => resolve({ id: 'r', skill, args, expected: 'x', observed: 'arrived within 1.6 blocks', ok: true, mismatch: false, aborted: false, slip: null, startedAt: 0, durationMs: 1 }));
          opts.signal.addEventListener('abort', () => resolve({ id: 'r', skill, args, expected: 'x', observed: 'interrupted', ok: false, mismatch: false, aborted: true, slip: null, startedAt: 0, durationMs: 1, error: 'aborted' }), { once: true });
        }),
    } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    executor.start();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    s.update('self', (x) => ({ ...x, isDay: false, time: 12_500 }));
    cc.start();
    cc.trigger('testing', { urgent: true });
    for (let i = 0; i < 80 && !finish.has('goTo'); i++) await wait(25);
    s.update('scene', (x) => ({ ...x, where: 'In forest, standing on grass block, under the open sky, outside a room 2 m to the north-west, open to the north' }));
    finish.get('goTo')?.();
    for (let i = 0; i < 80 && decided.length < 2; i++) await wait(25);
    cc.stop();
    executor.stop();
    expect(decided).not.toContain('intention:wait');
    expect(asked.at(-1)).toMatch(/you meant to wait next, but where you would wait is out in the dark: In forest, standing on grass block, under the open sky, outside a room 2 m to the north-west/);
  }, 15_000);

  it('a little hurt, still day: on to the next step', async () => {
    const { decided } = await stepsAfter((s) => s.update('self', (x) => ({ ...x, health: 15 })));
    expect(decided[1]).toBe('intention:gather');
  }, 15_000);
});

describe('the end of what a newer decision replaced', () => {
  it('is no news: the steps meant after the new one wait for it; its own end brings them on', async () => {
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    cc.start();
    const now = Date.now();
    // The look up's "wait 200 s more" is under way, a walk out meant after it; the wait it replaced comes to its end.
    s.set('option', { decisionId: 'd-new', option: 'work', startedAt: now, maxSeconds: 200, skill: 'wait', args: { seconds: 200 }, status: 'running' });
    s.update('mind', (m) => ({ ...m, intention: { aim: 'wait for the light, then hunt', steps: [{ skill: 'goTo', args: { x: -81, y: 75, z: -5, range: 10 } }], from: 'd-new', at: now } }), 'test');
    // As if the controller had decided it itself (as the look up did).
    (cc as unknown as { ownOption: boolean }).ownOption = true;
    bus.emit({ type: 'optionTerminated', reason: 'replaced by a new decision', ok: true, option: 'work', decisionId: 'd-old' });
    await wait(300);
    expect(decided).toEqual([]);
    // Its own end: on to the next step.
    s.update('option', (o) => (o ? { ...o, status: 'succeeded' } : o), 'test');
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'work', decisionId: 'd-new' });
    for (let i = 0; i < 40 && decided.length === 0; i++) await wait(25);
    cc.stop();
    expect(decided).toEqual(['intention:goTo']);
  });
});

describe('Action Awareness (§4.6)', () => {
  it('the same attempt is known again whatever the amount (9, 9, then 10 diamonds, failing the same way)', () => {
    const s = store();
    const bus = new AgentBus();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    awareness.start();
    const fail = (qty: number) =>
      bus.emit({ type: 'actionRecorded', record: { id: 'r', skill: 'obtain', args: { item: 'diamond', qty }, expected: '', observed: 'holding 8 diamond', ok: false, ts: 0, durationMs: 3000, error: "haven't seen any diamond_ore around here; diamond comes from mining it" } });
    fail(9);
    fail(9);
    expect(awareness.isStuckOn('obtain', { item: 'diamond', qty: 11 })).toBe(false);
    fail(10);
    expect(awareness.isStuckOn('obtain', { item: 'diamond', qty: 11 })).toBe(true);
    expect(awareness.isStuckOn('obtain', { item: 'iron_ingot', qty: 3 })).toBe(false);
  });

  it('failing closer each time, or another way, is not stuck; the same failure three times is', () => {
    const s = store();
    const bus = new AgentBus();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    awareness.start();
    const hut = { structure: 'hut', room: 1 };
    const fail = (error: string) => bus.emit({ type: 'actionRecorded', record: { id: 'r', skill: 'build', args: hut, expected: '', observed: 'not built', ok: false, ts: 0, durationMs: 100, error } });
    // Short 27, 27, then 11: closer, so not stuck (one refused so went on being refused with forty planks in hand).
    fail('need 27 more building blocks (stone of any kind, planks or dirt)');
    fail('need 27 more building blocks (stone of any kind, planks or dirt)');
    fail('need 11 more building blocks (stone of any kind, planks or dirt)');
    expect(awareness.isStuckOn('build', hut)).toBe(false);
    // Short 11 three times over: the same rut.
    fail('need 11 more building blocks (stone of any kind, planks or dirt)');
    fail('need 11 more building blocks (stone of any kind, planks or dirt)');
    expect(awareness.isStuckOn('build', hut)).toBe(true);
    awareness.stop();
  });

  it('marks a task stuck after three failures, and lifts the mark once a prospect finds what it lacked', () => {
    const s = store();
    const bus = new AgentBus();
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    awareness.start();
    const rec = (skill: string, args: Record<string, unknown>, ok: boolean, observed: string, error?: string) =>
      bus.emit({ type: 'actionRecorded', record: { id: 'r', skill, args, expected: '', observed, ok, ts: 0, durationMs: 3000, ...(error ? { error } : {}) } });
    const obtain = { item: 'iron_pickaxe', qty: 1 };
    for (let i = 0; i < 3; i++) rec('obtain', obtain, false, 'holding 0 iron_pickaxe', "haven't seen any raw_iron around here");
    expect(awareness.isStuckOn('obtain', obtain)).toBe(true);
    // A prospect that comes back empty changes nothing.
    rec('prospect', { item: 'raw_iron' }, false, 'dug 48 blocks, no iron_ore seen', 'no iron_ore found in 48 blocks of tunnel');
    expect(awareness.isStuckOn('obtain', obtain)).toBe(true);
    // One that finds it does; a mark about something else stays.
    for (let i = 0; i < 3; i++) rec('gather', { item: 'diamond', qty: 1 }, false, 'got 0/1 diamond', "haven't seen any diamond around here");
    rec('prospect', { item: 'raw_iron' }, true, 'found iron_ore at (604, -62, 7) after digging 3 blocks');
    expect(awareness.isStuckOn('obtain', obtain)).toBe(false);
    expect(awareness.isStuckOn('gather', { item: 'diamond', qty: 1 })).toBe(true);
    awareness.stop();
  });
});

describe('Skill Executor termination (§4.4)', () => {
  function fakeBody(): Body {
    return {
      skill: () => ({ talkOverable: true }),
      run: (skill: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
        new Promise<SkillRunRecord>((resolve) => {
          const rec = (ok: boolean, aborted: boolean): SkillRunRecord => ({ id: 'r', skill, args, expected: 'x', observed: aborted ? 'interrupted' : 'done', ok, mismatch: false, aborted, slip: null, startedAt: 0, durationMs: 1, ...(aborted ? { error: 'aborted' } : {}) });
          opts.signal.addEventListener('abort', () => resolve(rec(false, true)), { once: true });
        }),
    } as unknown as Body;
  }

  it('ends an option when its until-condition comes true, and records the action', async () => {
    const s = store();
    const bus = new AgentBus();
    const ends: string[] = [];
    bus.on('optionTerminated', (e) => ends.push(`${e.reason}|${e.ok}`));
    const ex = new SkillExecutor({ store: s, bus, body: fakeBody(), logger: nullLogger(), levers: () => leversFor(0.5) });
    ex.start();
    s.set('option', { decisionId: 'd1', option: 'work', startedAt: Date.now(), maxSeconds: 60, until: 'inventoryHas:oak_log>=2', skill: 'gather', args: { item: 'oak_log', qty: 2 }, status: 'running' });
    await wait(50);
    expect(ex.busy).toBe(true);
    s.update('self', (x) => ({ ...x, inventory: [{ item: 'oak_log', qty: 2 }] }));
    for (let i = 0; i < 40 && ends.length === 0; i++) await wait(50);
    expect(ends).toEqual(['until inventoryHas:oak_log>=2|true']);
    expect(s.state.option?.status).toBe('terminated');
    expect(s.state.actionLog).toHaveLength(1);
    // What it was for came true: the work done, not a failure.
    expect(s.state.actionLog[0]).toMatchObject({ ok: true, observed: 'stopped once inventoryHas:oak_log>=2 came true' });
    expect(s.state.actionLog[0]?.error).toBeUndefined();
    ex.stop();
  });

  it('an until said as a later says it ("night", "see:pig") is heard too: the mind used them there, and they went unheard', async () => {
    const s = store();
    const bus = new AgentBus();
    const ends: string[] = [];
    bus.on('optionTerminated', (e) => ends.push(`${e.reason}|${e.ok}`));
    const ex = new SkillExecutor({ store: s, bus, body: fakeBody(), logger: nullLogger(), levers: () => leversFor(0.5) });
    ex.start();
    s.update('self', (x) => ({ ...x, isDay: true }));
    s.set('option', { decisionId: 'd3', option: 'rest', startedAt: Date.now(), maxSeconds: 60, until: 'night', skill: 'lookAround', args: { seconds: 60 }, status: 'running' });
    await wait(1200);
    expect(ends).toEqual([]);
    s.update('self', (x) => ({ ...x, isDay: false }));
    for (let i = 0; i < 40 && ends.length === 0; i++) await wait(50);
    expect(ends).toEqual(['until night|true']);
    ex.stop();
  });

  it('a walk somewhere gets the time it takes: 100 blocks off, more than the minute it was given', async () => {
    const { walkSeconds } = await import('@agora/agent/modules/executor');
    const s = store();
    const opt = (skill: string, args: Record<string, unknown>) => ({ decisionId: 'd', option: 'move', startedAt: 0, maxSeconds: 60, skill, args, status: 'running' }) as never;
    expect(walkSeconds(opt('goTo', { x: 100, y: 64, z: 0 }), s.state)).toBe(170);
    expect(walkSeconds(opt('goTo', { x: 1000, y: 64, z: 0 }), s.state)).toBe(240);
    expect(walkSeconds(opt('explore', { distance: 64 }), s.state)).toBe(116);
    expect(walkSeconds(opt('goTo', { agent: 'Bram' }), s.state)).toBe(0);
    expect(walkSeconds(opt('gather', { item: 'log', qty: 4 }), s.state)).toBe(0);
    // A dig up out of the deep is minutes of it; a wait for the day, the wait.
    expect(walkSeconds(opt('tunnel', { direction: 'up' }), s.state)).toBe(404);
    expect(walkSeconds(opt('tunnel', { direction: 'west', blocks: 3 }), s.state)).toBe(32);
    expect(walkSeconds(opt('wait', { until: 'day' }), s.state)).toBe(600);
    expect(walkSeconds(opt('wait', { seconds: 30 }), s.state)).toBe(0);
    // A dig for iron from the surface: the stair down to y 14 (2.5 s a step), then the tunnel there.
    s.update('self', (x) => ({ ...x, pos: { x: 0, y: 70, z: 0 } }));
    expect(walkSeconds(opt('prospect', { item: 'iron_ore' }), s.state)).toBe(30 + 56 * 2.5 + 48 * 2);
    expect(walkSeconds(opt('prospect', { item: 'diamond', maxBlocks: 96 }), s.state)).toBe(30 + 126 * 2.5 + 96 * 2);
    s.update('self', (x) => ({ ...x, pos: { x: 0, y: 10, z: 0 } }));
    expect(walkSeconds(opt('prospect', { item: 'iron_ore', maxBlocks: 20 }), s.state)).toBe(70);
  });

  it('an until-condition true from the start is not watched: the work goes on (5 more logs, holding 10)', async () => {
    const s = store();
    const bus = new AgentBus();
    const ends: string[] = [];
    bus.on('optionTerminated', (e) => ends.push(e.reason));
    const ex = new SkillExecutor({ store: s, bus, body: fakeBody(), logger: nullLogger(), levers: () => leversFor(0.5) });
    ex.start();
    s.update('self', (x) => ({ ...x, inventory: [{ item: 'oak_log', qty: 10 }] }));
    s.set('option', { decisionId: 'd2', option: 'work', startedAt: Date.now(), maxSeconds: 60, until: 'inventoryHas:oak_log>=5', skill: 'gather', args: { item: 'oak_log', qty: 5 }, status: 'running' });
    await wait(1600);
    expect(ends).toEqual([]);
    expect(ex.busy).toBe(true);
    ex.stop();
  });

  it('a walk to a spot is not cut short by "near" that same spot: it gets there (one stopped 2.6 blocks short, outside its hut)', async () => {
    const s = store();
    const bus = new AgentBus();
    const ends: string[] = [];
    bus.on('optionTerminated', (e) => ends.push(e.reason));
    const ex = new SkillExecutor({ store: s, bus, body: fakeBody(), logger: nullLogger(), levers: () => leversFor(0.5) });
    ex.start();
    // 2.6 blocks from the room's cell, outside its wall: "near" (3 blocks) is true, the walk is not done.
    s.update('self', (x) => ({ ...x, pos: { x: 8.6, y: 68, z: -35 } }));
    s.set('option', { decisionId: 'd3', option: 'move', startedAt: Date.now(), maxSeconds: 60, until: 'near:6,68,-35', skill: 'goTo', args: { x: 6, y: 68, z: -35 }, status: 'running' });
    await wait(1600);
    expect(ends).toEqual([]);
    expect(ex.busy).toBe(true);
    ex.stop();
    const { nearSameSpot } = await import('@agora/agent/modules/executor');
    const walk = (until: string, args: Record<string, unknown>) => ({ decisionId: 'd', option: 'move', startedAt: 0, maxSeconds: 60, skill: 'goTo', until, args, status: 'running' }) as never;
    expect(nearSameSpot(walk('near:6,68,-35', { x: '6', y: '68', z: '-35' }))).toBe(true);
    // Near somewhere else on the way: watched as said.
    expect(nearSameSpot(walk('near:20,68,-35', { x: 6, y: 68, z: -35 }))).toBe(false);
  });

  it('a new option starts once the one it replaced has cleaned up (its last stop of motion cut the new walk short)', async () => {
    const s = store();
    const bus = new AgentBus();
    const events: string[] = [];
    const body = {
      skill: () => ({ talkOverable: true }),
      run: (skill: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
        new Promise<SkillRunRecord>((resolve) => {
          events.push(`start ${skill}`);
          // Cleaning up after an abort takes a moment (stopping motion), as a skill's finally does.
          opts.signal.addEventListener('abort', () => setTimeout(() => (events.push(`cleanup ${skill}`), resolve({ id: 'r', skill, args, expected: 'x', observed: 'interrupted', ok: false, mismatch: false, aborted: true, slip: null, startedAt: 0, durationMs: 1, error: 'aborted' })), 60), { once: true });
        }),
    } as unknown as Body;
    const ex = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    ex.start();
    s.set('option', { decisionId: 'd1', option: 'work', startedAt: Date.now(), maxSeconds: 60, skill: 'wander', args: {}, status: 'running' });
    await wait(20);
    s.set('option', { decisionId: 'd2', option: 'work', startedAt: Date.now(), maxSeconds: 60, skill: 'give', args: { to: 'Wit', item: 'bread', qty: 2 }, status: 'running' });
    await wait(200);
    expect(events).toEqual(['start wander', 'cleanup wander', 'start give']);
    // Replaced again while waiting: only the latest runs.
    s.set('option', { decisionId: 'd3', option: 'work', startedAt: Date.now(), maxSeconds: 60, skill: 'gather', args: {}, status: 'running' });
    s.set('option', { decisionId: 'd4', option: 'work', startedAt: Date.now(), maxSeconds: 60, skill: 'obtain', args: {}, status: 'running' });
    await wait(300);
    expect(events.slice(3)).toEqual(['cleanup give', 'start obtain']);
    ex.stop();
  });

  it('is preempted by danger', async () => {
    const s = store();
    const bus = new AgentBus();
    const ends: string[] = [];
    bus.on('optionTerminated', (e) => ends.push(e.reason));
    const ex = new SkillExecutor({ store: s, bus, body: fakeBody(), logger: nullLogger(), levers: () => leversFor(0.5) });
    ex.start();
    s.set('option', { decisionId: 'd2', option: 'explore', startedAt: Date.now(), maxSeconds: 60, status: 'running' });
    await wait(20);
    bus.emit({ type: 'danger', source: 'zombie', level: 0.5 });
    for (let i = 0; i < 20 && ends.length === 0; i++) await wait(25);
    expect(ends).toEqual(['danger']);
    ex.stop();
  });
});

describe('system news (§6.1, §16.3)', () => {
  it('parses deaths, joins and advancements for real players only', () => {
    const isPlayer = (n: string) => ['Bram', 'Pip'].includes(n);
    expect(parseSystemLine('Bram was slain by Zombie', 1, isPlayer)).toMatchObject({ kind: 'death', subject: 'Bram', killer: 'Zombie' });
    expect(parseSystemLine('Bram was slain by Pip using [Iron Sword]', 1, isPlayer)).toMatchObject({ kind: 'death', killer: 'Pip' });
    expect(parseSystemLine('Pip drowned', 1, isPlayer)).toMatchObject({ kind: 'death', subject: 'Pip' });
    expect(parseSystemLine('Bram joined the game', 1, isPlayer)).toMatchObject({ kind: 'join' });
    expect(parseSystemLine('Pip has made the advancement [Stone Age]', 1, isPlayer)).toMatchObject({ kind: 'advancement', cause: 'Stone Age' });
    expect(parseSystemLine('Ghost was slain by Zombie', 1, isPlayer)).toBeNull();
  });
});
