// M3 (§10): the single-agent PIANO modules without Minecraft: pure parts, then modules against fakes and the mocked
// NanoGPT. Live behavior is in tests/live/m3-agent.test.ts.

import { describe, expect, it } from 'vitest';
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
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

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
    expect(evalCondition('inventoryHas:oak_log>5', s)).toBe(false);
    expect(evalCondition('agentInRange:Bram', s)).toBe(true);
    expect(evalCondition('agentLeftRange:Bram', s)).toBe(false);
    expect(evalCondition('timeIs:night', s)).toBe(true);
    expect(evalCondition('healthAbove:10', s)).toBe(true);
    expect(evalCondition('near:11,64,-5', s)).toBe(true);
    expect(evalCondition('fly to the moon', s)).toBeNull();
  });

  it('scales the mind with intelligence (anchors at 0.2 and 0.8)', () => {
    expect(leversFor(0.2)).toMatchObject({ ccTier: 'L1', memories: 3, tasks: 2, people: 3, queueDepth: 2, candidates: 2, slipChance: 0.08, planningBurst: false });
    expect(leversFor(0.8)).toMatchObject({ ccTier: 'L2', memories: 6, tasks: 5, people: 6, queueDepth: 6, candidates: 4, slipChance: 0.01, planningBurst: true });
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
    expect(low).toContain('You are stuck on: gather');
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

  it('keeps working without an LLM: shelter at night, then the goal, then the prerequisite it was told to get first', () => {
    const never = () => false;
    const night = withState((x) => ({ ...x, self: { ...x.self, isDay: false } }));
    expect(codeDecision(night, {}, false, never)?.task?.skill).toBe('shelter');
    // Dug in from dusk, before the monsters come out at dark; not in the afternoon.
    const at = (time: number) => withState((x) => ({ ...x, self: { ...x.self, isDay: true, time } }));
    expect(codeDecision(at(12_800), {}, false, never)?.task?.skill).toBe('shelter');
    expect(codeDecision(at(11_000), {}, false, never)?.task?.skill).not.toBe('shelter');
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
});

describe('Talking guards (§6.2, §6.4, §13 rule 3, §16.1)', () => {
  it('recognizes promises, requests and giveaways, and cleans replies', () => {
    for (const t of ["Sure, I'll bring you 8 logs!", 'deal', 'I promise', "you got it, I'm on it"]) expect(looksLikePromise(t)).toBe(true);
    for (const t of ['hmm, let me think about it', 'what do you need them for?', 'nice day']) expect(looksLikePromise(t)).toBe(false);
    expect(needsDecision('Pip, can you give me 8 logs?')).toBe(true);
    expect(needsDecision('nice weather')).toBe(false);
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
      const name = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
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
  });
});

describe('Action Awareness (§4.6)', () => {
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
