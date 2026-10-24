// Real-model robustness and self-sufficient agents: decisions as subscription models actually write them (every
// field filled in), whole spoken lines (never cut off mid-sentence, never a failed model's draft), wandering and
// looking around instead of standing frozen, and hiding only for one badly scared, alone and far from anyone.

import { describe, expect, it } from 'vitest';
import { DecisionOutputSchema, ModelsConfigSchema, PersonaSchema, dropUnfinished, fitWords, nullLogger, sentences } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import type { Body } from '@agora/agent/body/body';
import { getSkill } from '@agora/agent/body/skills/registry';
import { AgentBus } from '@agora/agent/bus';
import { Feelings } from '@agora/agent/mind/feelings';
import { buildPacket, dayPart, healing, hunger } from '@agora/agent/modules/bottleneck';
import { evalCondition } from '@agora/agent/modules/conditions';
import { routeItemTask } from '@agora/agent/modules/itemTasks';
import { codeDecision, validateDecision, whyNotGo } from '@agora/agent/modules/cc';
import { Conversations } from '@agora/agent/modules/conversations';
import { tidyDecision } from '@agora/agent/modules/decisionTidy';
import { SkillExecutor, skillForOption } from '@agora/agent/modules/executor';
import { HIGH_FEAR, whyNotHide } from '@agora/agent/modules/hiding';
import { hurtFear } from '@agora/agent/mind/feelings';
import { leversFor } from '@agora/agent/modules/levers';
import { Talking, cleanReply } from '@agora/agent/modules/talking';
import { whoMakesChests, whyNoChest } from '@agora/agent/social/village';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { isOff } from '@agora/agent/state/switches';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['curious'], speech: { style: 'chatty', maxWords: 12, catchphrases: [] } });
const store = () => new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tidy = (raw: unknown) => tidyDecision(raw, { me: 'Pip', isSkill: (n) => getSkill(n) !== null });
const env = { me: 'Pip', isStuck: () => false, canPerceive: () => true };

describe('decisions as subscription models write them', () => {
  it('a reply with every field filled in (as asked for in json_schema mode) is tidied to the decision it meant', () => {
    // minimax/minimax-m3, verbatim from a probe of the real subscription API.
    const raw = JSON.parse(
      '{"option":"work","target":{"agent":"oak_log","pos":{"x":0,"y":0,"z":0},"item":""},"task":{"skill":"gather","args":{"item":"oak_log","qty":4}},"speechIntent":{"stance":"none","gist":"","mayCommit":false,"volume":"whisper"},"commitmentsToCreate":[],"trade":{"with":"Mira","phase":"offer","give":[{"item":"oak_log","qty":4}],"want":[{"item":"cobblestone","qty":16}]},"fight":{"target":"zombie","intent":"brawl","withAllies":[],"joining":false,"reason":""},"romance":{"with":"Mira","phase":"flirt","reaction":"politeDecline"},"family":{"with":"Mira","phase":"propose","about":"Bram"},"terminate":{"maxSeconds":120,"until":"inventoryHas:oak_log>=4"},"rationale":"Gather oak logs first to establish a resource base."}',
    ) as unknown;
    const d = DecisionOutputSchema.parse(tidy(raw));
    expect(d).toEqual({ option: 'work', target: { agent: 'oak_log' }, task: { skill: 'gather', args: { item: 'oak_log', qty: 4 } }, terminate: { maxSeconds: 120, until: 'inventoryHas:oak_log>=4' }, rationale: 'Gather oak logs first to establish a resource base.' });
    expect(validateDecision(d, env)).toBeNull();
    // Untidied, it would have been asking Mira to start a family and fighting a zombie.
    expect(DecisionOutputSchema.safeParse(raw).success).toBe(false);
  });

  it('placeholders go ("none", "", 0,0,0, a skill for a talk), what was meant is kept, a missing time limit gets one', () => {
    const d = tidy({ option: 'talk', target: { agent: 'Mira', item: '', pos: { x: 0, y: 0, z: 0 } }, task: { skill: 'chat', args: {} }, speechIntent: { stance: 'ask', gist: 'what are you building?' }, family: { with: 'none', phase: 'propose' }, terminate: { maxSeconds: 0, until: '' }, rationale: 'curious' });
    expect(d).toEqual({ option: 'talk', target: { agent: 'Mira' }, speechIntent: { stance: 'ask', gist: 'what are you building?', mayCommit: false }, terminate: { maxSeconds: 90 }, rationale: 'curious' });
    // An option named by its skill is work with that skill; a move's place given only in its task is its target.
    expect(tidy({ option: 'gather', task: undefined, terminate: { maxSeconds: 60 }, rationale: '' })).toMatchObject({ option: 'work', task: { skill: 'gather', args: {} } });
    expect(tidy({ option: 'move', task: { skill: 'goTo', args: { x: 4, y: 70, z: -2 } }, terminate: { maxSeconds: 30 }, rationale: 'there' })).toMatchObject({ option: 'move', target: { pos: { x: 4, y: 70, z: -2 } } });
    expect(tidy({ option: 'follow', task: { skill: 'follow', args: { agent: 'Bram' } }, terminate: { maxSeconds: 30 }, rationale: '' })).toMatchObject({ target: { agent: 'Bram' } });
    // A real fight, courtship or trade stays.
    expect(tidy({ option: 'fight', fight: { target: 'Rex', intent: 'brawl' }, terminate: { maxSeconds: 60 }, rationale: '' })).toMatchObject({ fight: { target: 'Rex', intent: 'brawl', withAllies: [] } });
    expect(tidy({ option: 'court', target: { agent: 'Mira' }, romance: { with: 'Mira', phase: 'flirt', reaction: '' }, terminate: { maxSeconds: 60 }, rationale: '' })).toMatchObject({ romance: { with: 'Mira', phase: 'flirt' } });
    expect(tidy({ option: 'trade', target: { agent: 'Bram' }, trade: { with: 'Bram', phase: 'offer', give: [{ item: 'bread', qty: 2 }], want: [{ item: 'oak_log', qty: 8 }] }, terminate: { maxSeconds: 60 }, rationale: '' })).toMatchObject({ trade: { with: 'Bram' } });
    // A task naming nothing real for work stays, and is refused with the reason (one retry, told why).
    const work = DecisionOutputSchema.parse(tidy({ option: 'work', task: { skill: 'teleport', args: {} }, terminate: { maxSeconds: 60 }, rationale: '' }));
    expect(validateDecision(work, env)).toMatch(/no skill "teleport"/);
  });
});

describe('whole lines (no cut-off speech)', () => {
  it('fits a reply to about its word budget in whole sentences; only one overlong sentence is cut, at a clause', () => {
    expect(sentences('Hello, Pip. I am gathering timber! Measure twice')).toEqual(['Hello, Pip.', 'I am gathering timber!', 'Measure twice']);
    // 1.5 × the budget, whole sentences: the third doesn't fit, so it goes (never half of it).
    expect(fitWords('Hello, Pip. I am gathering timber today. A sturdy foundation requires quality wood and patience.', 8)).toBe('Hello, Pip. I am gathering timber today.');
    expect(fitWords('Not much over there, just trees and stone, what are you looking for?', 12)).toBe('Not much over there, just trees and stone, what are you looking for?');
    const long = 'I have been walking around these hills all morning looking for a good place to build, and the river bend by the birch trees looks perfect for a hut with a garden and a dock for fishing';
    const cut = fitWords(long, 10);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.split(' ').length).toBeLessThanOrEqual(15);
    // A reply that ran out of tokens mid-sentence loses only the unfinished sentence.
    expect(dropUnfinished('Getting oak for the house. I will need about twenty more and then')).toBe('Getting oak for the house.');
    expect(dropUnfinished('not yet')).toBe('not yet');
  });

  it('a wrapped line is joined; a line written as someone else is dropped', () => {
    expect(cleanReply('Hello Pip, working on anything\nnew today?', 'Oswin', 20)).toBe('Hello Pip, working on anything new today?');
    expect(cleanReply('Oswin: Sure thing.\nPip: great!', 'Oswin', 20)).toBe('Sure thing.');
    expect(cleanReply('"ooh, logs? why?"\nsecond line', 'Pip', 20)).toBe('ooh, logs? why?');
  });

  it("a model that stalls after its first sentence went out: that sentence was the line, the next model's draft isn't tacked on", async () => {
    const fake = new FakeNanoGpt(standardModels());
    const tiers = { tiers: { L1: { timeoutMs: 300, maxTokens: 200, need: ['structured_output'] }, L2: { timeoutMs: 300, maxTokens: 500, need: ['structured_output', 'tool_calling'] }, L3: { timeoutMs: 600, maxTokens: 2000, need: ['structured_output'] } } };
    let n = 0;
    fake.chat = () => (++n === 1 ? { chunks: ['Hello there, Bram. ', 'I was just about to'], chunkDelayMs: 1500 } : { text: 'Something else entirely. With more words.' });
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse(tiers), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const said: string[] = [];
    const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => null, run: () => Promise.reject(new Error('unused')) } as unknown as Body;
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Bram'], rng: () => 0 });
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: rt.client, conversations, executor, me: 'Pip', rng: () => 0 });
    conversations.start();
    talking.start();
    bus.emit({ type: 'heard', utterance: { id: 'u', convId: '', from: 'Bram', to: ['Pip'], text: 'hey Pip, nice weather', ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: true } });
    for (let i = 0; i < 80 && fake.chatRequests().length < 2; i++) await wait(50);
    await wait(300);
    expect(said).toEqual(['Hello there, Bram.']);
    expect(fake.chatRequests()).toHaveLength(2);
    // The lines are written with L2 by default (a small model's come late and short).
    expect(rt.router.chain('L2')).toContain(String(fake.chatRequests()[0]?.body?.model));
    talking.stop();
    conversations.stop();
  });
});

describe('streamed replies and timeouts', () => {
  const tiers = { tiers: { L1: { timeoutMs: 300, maxTokens: 200, need: ['structured_output'] }, L2: { timeoutMs: 300, maxTokens: 500, need: ['structured_output', 'tool_calling'] }, L3: { timeoutMs: 600, maxTokens: 2000, need: ['structured_output'] } } };
  const run = async (reply: { chunks: string[]; chunkDelayMs: number }) => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => reply;
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse(tiers), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const pieces: string[] = [];
    const r = await rt.client.call<string>({ tier: 'L2', module: 'talking', agent: 'Pip', messages: [{ role: 'user', content: 'hi' }], fallback: () => 'canned', onText: (d) => pieces.push(d) });
    return { r, fake };
  };

  it('the timeout is for the first piece: a slow but steady stream comes through whole; a stalled one fails over', async () => {
    // Four pieces 200 ms apart: 600 ms in all, twice the 300 ms timeout, but never a gap as long as it.
    const steady = await run({ chunks: ['One. ', 'Two. ', 'Three. ', 'Four.'], chunkDelayMs: 200 });
    expect(steady.r.ok && steady.r.value).toBe('One. Two. Three. Four.');
    const stalled = await run({ chunks: ['One. ', 'Two.'], chunkDelayMs: 900 });
    expect(stalled.r.ok).toBe(false);
    expect(stalled.r.value).toBe('canned');
  });
});

describe('the operator’s routing in the client (debug controls)', () => {
  it('a model a tier tries first, a tier a module uses instead, and every call off', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = () => ({ text: 'ok' });
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const ask = (module: 'talking' | 'cc', tier: 'L1' | 'L2' | 'L3' = 'L1') => rt.client.call<string>({ tier, module, agent: 'Pip', messages: [{ role: 'user', content: 'hi' }], fallback: () => 'fallback' });
    const head = rt.router.chain('L2')[1] ?? '';
    rt.client.setRouting({ tierModel: { L2: head }, moduleTier: { talking: 'L2' } });
    expect(rt.client.chainFor('L2')[0]).toBe(head);
    await ask('talking', 'L1');
    expect(fake.chatRequests().at(-1)?.body?.model).toBe(head);
    // A model that isn't on the subscription list is never tried.
    rt.client.setRouting({ tierModel: { L2: 'openai/gpt-paid-only' } });
    expect(rt.client.chainFor('L2')).not.toContain('openai/gpt-paid-only');
    rt.client.setRouting({ off: true });
    const before = fake.chatRequests().length;
    const r = await ask('cc');
    expect(r.ok === false && r.reason).toBe('disabled');
    expect(fake.chatRequests()).toHaveLength(before);
  });
});

describe('never standing frozen', () => {
  it('rest and a talk keep an eye on things (facing the one we talk to); the new skills are on offer', () => {
    const opt = (option: 'rest' | 'talk' | 'yield', targetAgent?: string) => ({ decisionId: 'd', option, startedAt: 0, maxSeconds: 30, status: 'running' as const, ...(targetAgent ? { targetAgent } : {}) });
    expect(skillForOption(opt('rest'), () => true)).toEqual({ skill: 'lookAround', args: { seconds: 30 } });
    expect(skillForOption(opt('talk', 'Bram'), () => true)).toEqual({ skill: 'lookAround', args: { seconds: 30, at: 'Bram' } });
    expect(skillForOption(opt('talk', 'Bram'), () => false)).toEqual({ skill: 'goTo', args: { agent: 'Bram', range: 4 } });
    expect(getSkill('wander')?.name).toBe('wander');
    expect(getSkill('stroll')?.name).toBe('wander');
    expect(getSkill('rest')?.name).toBe('lookAround');
    expect(getSkill('lookAround')?.parseArgs({ seconds: 10, at: 'Bram' }).ok).toBe(true);
  });

  it('with nothing to do, a stroll keeps about a friend, a partner or kin in sight; with strangers, it goes where it likes', () => {
    const near = (name: string, distance: number) => ({ id: distance, kind: 'player' as const, name, pos: { x: distance, y: 64, z: 0 }, distance, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false });
    const idle = (o: { sentiment?: number; kin?: 'parent'; partner?: boolean; at?: number }) => {
      const s = store();
      s.update('self', (x) => ({ ...x, isDay: true, time: 1000 }));
      s.update('perception', (p) => ({ ...p, nearbyEntities: [near('Bram', o.at ?? 10), near('Cass', 5)] }));
      s.update('social', (all) => ({ ...all, Bram: { ...newSocialProfile('Bram', persona, 0), sentiment: o.sentiment ?? 5, kin: o.kin ?? null } }));
      if (o.partner) s.update('family', (f) => ({ ...f, partner: 'Bram' }));
      return codeDecision(s.state, {}, false, () => false, { candidates: [], roll: 0.9 })?.task;
    };
    expect(idle({ sentiment: 8 })).toEqual({ skill: 'wander', args: { radius: 8, seconds: 75, near: 'Bram' } });
    expect(idle({ kin: 'parent' })?.args.near).toBe('Bram');
    expect(idle({ partner: true })?.args.near).toBe('Bram');
    // Strangers (Cass, nearer) and the far-off are no company.
    expect(idle({})).toEqual({ skill: 'wander', args: { radius: 16, seconds: 75 } });
    expect(idle({ sentiment: 8, at: 40 })?.args.near).toBeUndefined();
  });
});

describe('hiding is for one badly scared, alone and far from anyone', () => {
  const person = (name: string, distance: number) => ({ id: 1, kind: 'player' as const, name, pos: { x: distance, y: 64, z: 0 }, distance, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false });
  const zombie = (distance: number) => ({ id: 2, kind: 'hostile' as const, name: 'zombie', pos: { x: distance, y: 64, z: 0 }, distance, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false });

  it('the gate: not with people near or in sight, not close to home, not without real fear', () => {
    const base = createInitialState({ persona, username: 'Pip', now: 0 });
    const far = { ...base, self: { ...base.self, pos: { x: 200, y: 64, z: 0 } }, village: { ...base.village, home: { x: 0, y: 64, z: 0 } } };
    const scared = { ...far, emotions: { ...far.emotions, fear: HIGH_FEAR + 0.1 } };
    expect(whyNotHide(scared)).toBeNull();
    expect(whyNotHide(far)).toMatch(/not scared enough/);
    expect(whyNotHide({ ...scared, perception: { ...scared.perception, nearbyEntities: [person('Bram', 10)] } })).toMatch(/not alone/);
    expect(whyNotHide({ ...scared, perception: { ...scared.perception, nearbyEntities: [person('Bram', 30)] } })).toMatch(/people in sight/);
    // Badly hurt, one stays afraid: the wounds keep fear up (3.6 of 20 is well past scared enough).
    expect(hurtFear(3.6)).toBeGreaterThan(HIGH_FEAR);
    expect(hurtFear(8)).toBeCloseTo(0.3);
    expect(hurtFear(12)).toBe(0);
    // Close to home: back there, once there is a hut to shelter in; an empty field is no refuge.
    const near = { ...scared, self: { ...scared.self, pos: { x: 20, y: 64, z: 0 } } };
    expect(whyNotHide(near)).toBeNull();
    expect(whyNotHide({ ...near, village: { ...near.village, huts: [{ x: 4, y: 64, z: 4 }] } })).toMatch(/close to home/);
  });

  it('alone in the dark with monsters about, fear creeps up; with company it does not', async () => {
    const run = async (company: boolean) => {
      const s = store();
      let t = 0;
      s.update('self', (x) => ({ ...x, isDay: false }), 'night');
      s.update('perception', (p) => ({ ...p, nearbyEntities: [zombie(8), zombie(12), ...(company ? [person('Bram', 5)] : [])] }), 'seen');
      const f = new Feelings({ store: s, bus: new AgentBus(), logger: nullLogger(), me: 'Pip', tickMs: 5, now: () => t });
      f.start();
      for (let i = 0; i < 6; i++) {
        t += 10_001;
        await wait(12);
      }
      f.stop();
      return s.state.emotions.fear;
    };
    const alone = await run(false);
    expect(alone).toBeGreaterThan(0.2);
    expect(await run(true)).toBeLessThan(0.05);
  });
});

describe('module switches (debug controls)', () => {
  it('a switched-off module is off; "llm" switches off every model call', () => {
    const s = store();
    expect(isOff(s.state, 'goalGen')).toBe(false);
    s.update('flags', (f) => ({ ...f, off: ['goalGen'] }), 'switch');
    expect(isOff(s.state, 'goalGen')).toBe(true);
    expect(isOff(s.state, 'cc.llm')).toBe(false);
    s.update('flags', (f) => ({ ...f, off: ['llm'] }), 'switch');
    expect(isOff(s.state, 'cc.llm')).toBe(true);
    expect(isOff(s.state, 'talking.llm')).toBe(true);
    expect(isOff(s.state, 'reflection')).toBe(false);
  });
});

describe('hunger said plainly (an agent starved with "food 3/20" in its packet)', () => {
  const at = (food: number, carrying: { item: string; qty: number }[] = []) => {
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    return { ...s, self: { ...s.self, food, inventory: carrying } };
  };
  it('fed, or hungry with food at hand: nothing to say', () => {
    expect(hunger(at(18))).toBeNull();
    expect(hunger(at(7, [{ item: 'bread', qty: 2 }]))).toBeNull();
  });
  // Owner request, 2026-10-24: how it feels is said; what to do about it is the mind's.
  it('hungry with nothing to eat, or starving: said plainly, with no telling what to do', () => {
    expect(hunger(at(7))).toBe('You are getting hungry, and you carry nothing to eat.');
    expect(hunger(at(3))).toBe('You are starving and carry nothing to eat: without food you will soon die.');
    expect(hunger(at(3, [{ item: 'apple', qty: 1 }]))).toBe('You are starving; you carry apple.');
  });
});

describe('what one carries, as one sees it: a tool nearly worn out', () => {
  it('says how much of it is left', () => {
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    const st = { ...s, self: { ...s.self, inventory: [{ item: 'iron_pickaxe', qty: 1, left: 0.08 }, { item: 'stone_pickaxe', qty: 1, left: 0.9 }] } };
    const packet = buildPacket({ state: st, levers: leversFor(0.5), reason: 'test', stuck: [], memories: [], mind: [], now: 0 });
    expect(packet).toContain('1 iron_pickaxe (nearly worn out: 8% left)');
    // No armor on is something one sees too (one with twelve iron ingots and none went deep, and died to a skeleton).
    expect(packet).toContain('1 stone_pickaxe; wearing no armor.');
  });
});

describe('how the body heals, said as a fact (a model at 1 health and food 10 waited to heal "on its own")', () => {
  const at = (health: number, food: number) => {
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    return { ...s, self: { ...s.self, health, food } };
  };
  it('whole, barely hurt, or fed enough to heal: nothing to say', () => {
    expect(healing(at(20, 10))).toBeNull();
    expect(healing(at(18, 10))).toBeNull();
    expect(healing(at(4, 18))).toBeNull();
  });
  it('hurt and short of food: health will not come back by itself', () => {
    expect(healing(at(1, 10))).toBe('Health comes back by itself only with food at 18 of 20 or more; at food 10 it stays where it is.');
    expect(healing(at(6, 0))).toBe('Health comes back by itself only with food at 18 of 20 or more; with no food at all, hunger itself does harm.');
    expect(buildPacket({ state: at(1, 10), levers: leversFor(0.5), reason: 'test', stuck: [], memories: [], mind: [], now: 0 })).toContain('only with food at 18 of 20');
  });
});

describe('the model says what to get; code works out how (item tasks to obtain)', () => {
  const canon = (n: string) => getSkill(n)?.name ?? null;
  const route = (skill: string, args: Record<string, unknown>) => routeItemTask({ skill, args }, canon);
  it('a craft goes to obtain (which gets the ingredients and the table first)', () => {
    expect(route('craft', { item: 'crafting_table', qty: 1 })).toEqual({ skill: 'obtain', args: { item: 'crafting_table', qty: 1 } });
    expect(route('craft', { item: 'oak_planks', qty: 80 })).toEqual({ skill: 'obtain', args: { item: 'planks', qty: 64 } });
  });
  it('a mine of ore, stone or wood gets what it drops, the pickaxe first if need be', () => {
    expect(route('mine', { block: 'iron_ore', qty: 3 })).toEqual({ skill: 'obtain', args: { item: 'raw_iron', qty: 3 } });
    expect(route('dig', { block: 'deepslate_coal_ore' })).toEqual({ skill: 'obtain', args: { item: 'coal', qty: 1 } });
    expect(route('mine', { block: 'cobblestone', qty: 8 })).toEqual({ skill: 'obtain', args: { item: 'cobblestone', qty: 8 } });
    expect(route('mine', { block: 'stone', qty: 3 })).toEqual({ skill: 'obtain', args: { item: 'cobblestone', qty: 3 } });
    expect(route('mine', { block: 'birch_log', qty: 2 })).toEqual({ skill: 'obtain', args: { item: 'log', qty: 2 } });
    expect(route('mine', { block: 'sand', qty: 4 })).toEqual({ skill: 'mine', args: { block: 'sand', qty: 4 } });
  });
  it('a gather of something no block drops is obtained; a kind of wood is any wood', () => {
    expect(route('gather', { item: 'stick', qty: 4 })).toEqual({ skill: 'obtain', args: { item: 'stick', qty: 4 } });
    expect(route('gather', { item: 'wooden_pickaxe' })).toEqual({ skill: 'obtain', args: { item: 'wooden_pickaxe', qty: 1 } });
    expect(route('chop', { item: 'oak_log', qty: 8 })).toEqual({ skill: 'gather', args: { item: 'log', qty: 8 } });
    expect(route('gather', { item: 'dirt', qty: 16 })).toEqual({ skill: 'gather', args: { item: 'dirt', qty: 16 } });
    expect(route('obtain', { item: 'spruce_planks', qty: 4 })).toEqual({ skill: 'obtain', args: { item: 'planks', qty: 4 } });
  });
  it('a craft, a mine or a gather gets that many more: obtain is told to have what is held and those', () => {
    const holding = (item: string) => (item === 'torch' ? 4 : item === 'cobblestone' ? 60 : 0);
    expect(routeItemTask({ skill: 'craft', args: { item: 'torch', qty: 4 } }, canon, holding)).toEqual({ skill: 'obtain', args: { item: 'torch', qty: 8 } });
    expect(routeItemTask({ skill: 'mine', args: { block: 'stone', qty: 16 } }, canon, holding)).toEqual({ skill: 'obtain', args: { item: 'cobblestone', qty: 64 } });
  });
  it('a crafting table goes where there is room; a wall block stays where it was put', () => {
    expect(route('place', { block: 'crafting_table', x: 257, y: 62, z: 613 })).toEqual({ skill: 'place', args: { block: 'crafting_table' } });
    expect(route('place', { block: 'cobblestone', x: 1, y: 64, z: 2 })).toEqual({ skill: 'place', args: { block: 'cobblestone', x: 1, y: 64, z: 2 } });
    expect(route('say', { text: 'hi' })).toEqual({ skill: 'say', args: { text: 'hi' } });
  });
  it('a kind of wood counts as any wood in a condition (inventoryHas:oak_log is met by birch logs)', () => {
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    const held = { ...s, self: { ...s.self, inventory: [{ item: 'birch_log', qty: 4 }] } };
    expect(evalCondition('inventoryHas:oak_log>=4', held)).toBe(true);
    expect(evalCondition('inventoryHas:oak_planks>=1', held)).toBe(false);
  });
});

describe('going somewhere one knows (a "head home" went to a made-up 0,64,0, 389 blocks off)', () => {
  const s0 = createInitialState({ persona, username: 'Pip', now: 0 });
  const s = { ...s0, self: { ...s0.self, pos: { x: 218, y: 66, z: 448 } }, village: { ...s0.village, home: { x: 220, y: 66, z: 450 } } };
  it('near, or somewhere it knows: fine; far and unknown: refused, with where home is', () => {
    expect(whyNotGo(s, { x: 240, y: 64, z: 480 })).toBeNull();
    expect(whyNotGo({ ...s, self: { ...s.self, pos: { x: 600, y: 66, z: 448 } } }, { x: 221, y: 66, z: 452 })).toBeNull();
    expect(whyNotGo(s, { x: 0, y: 64, z: 0 })).toBe('0,64,0 is 498 blocks away and you know of nothing there: pick a place you can see or one you know; home is at 220,66,450');
  });
  it('the packet says where home is', () => {
    const packet = buildPacket({ state: s, levers: leversFor(0.5), reason: 'test', stuck: [], memories: [], mind: [], now: 0 });
    expect(packet).toContain('Home: 220,66,450, 3 m away; nothing built there yet.');
    const withHut = buildPacket({ state: { ...s, village: { ...s.village, huts: [{ x: 224, y: 66, z: 452 }] } }, levers: leversFor(0.5), reason: 'test', stuck: [], memories: [], mind: [], now: 0 });
    expect(withHut).toContain('huts with doors at 224,66,452.');
  });
  it('the time of day as one plans by it: how long until dark, or until light', () => {
    expect(dayPart(3000, true)).toBe('daytime');
    expect(dayPart(10600, true)).toBe('evening, dark in about 2 min');
    expect(dayPart(12900, true)).toBe('evening, dark in about 1 min');
    expect(dayPart(14000, false)).toBe('night, light in about 8 min');
    expect(dayPart(23500, false)).toBe('night');
  });
});

describe('a chest is a thing in the world (owner request, 2026-10-24)', () => {
  const T = 1_000_000;
  const base = () => {
    const s = createInitialState({ persona: PersonaSchema.parse({ name: 'Pip', sex: 'male', traits: ['curious'] }), username: 'Pip', now: T });
    return s;
  };

  it('a builder makes the chest when there is none; anyone else asks the builder they saw lately, or makes it if there is none', () => {
    const s = base();
    expect(whoMakesChests(s, T)).toBeNull();
    const withBram = { ...s, social: { Bram: { ...newSocialProfile('Bram', s.self.persona, T), perceivedRole: 'builder', lastSeen: T - 60_000 } } };
    expect(whoMakesChests(withBram, T)).toBe('Bram');
    // Not seen for a long while, or seen to die: no builder to wait for.
    expect(whoMakesChests(withBram, T + 20 * 60_000)).toBeNull();
    const dead = { ...withBram, perception: { ...withBram.perception, systemEvents: [{ kind: 'death' as const, subject: 'Bram', text: 'Bram was slain by Zombie', ts: T }] } };
    expect(whoMakesChests(dead, T)).toBeNull();
    // We're the builder: ours to make.
    expect(whoMakesChests({ ...withBram, goals: { ...withBram.goals, role: 'builder' } }, T)).toBeNull();
  });

  it('a chest named by its spot must be there: the village chest, or one seen there; otherwise said so', () => {
    const s = base();
    expect(whyNoChest(s, { x: 10, y: 64, z: 10 }, false)).toMatch(/there is no chest at 10,64,10 that you know of, and no village chest yet/);
    expect(whyNoChest(s, { x: 10, y: 64, z: 10 }, true)).toBeNull();
    const withChest = { ...s, village: { ...s.village, chest: { pos: { x: 3, y: 64, z: 4 }, contents: null, seenAt: T } } };
    expect(whyNoChest(withChest, { x: 3, y: 64, z: 4 }, null)).toBeNull();
    expect(whyNoChest(withChest, { x: 10, y: 64, z: 10 }, null)).toBe('there is no chest at 10,64,10; the village chest is at 3,64,4');
    // Validation turns a made-up chest away with that reason.
    const env = { me: 'Pip', isStuck: () => false, canPerceive: () => false, chestThere: (p: { x: number; y: number; z: number }) => whyNoChest(withChest, p, false) };
    expect(validateDecision({ option: 'work', task: { skill: 'deposit', args: { item: 'oak_log', x: 10, y: 64, z: 10 } }, terminate: { maxSeconds: 60 }, rationale: 'store logs' }, env)).toMatch(/no chest at 10,64,10/);
    expect(validateDecision({ option: 'work', task: { skill: 'deposit', args: { item: 'oak_log' } }, terminate: { maxSeconds: 60 }, rationale: 'store logs' }, env)).toBeNull();
  });
});
