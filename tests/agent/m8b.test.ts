// M8b (§17.7, §17.8, §17.5 rung 4, §17.10): power structures, without Minecraft. Demands and coerced commitments,
// compliance out of fear (lower for a leader: authority), followers and leaders as onlookers infer them, shared
// grudges and gossip, coalitions and uprisings (proposed, joined, carried out together), defection, the lethal rung
// behind the gate with mercy, ignoring a yield, and the extinction brake. Live behavior is in
// tests/live/m8b-power.test.ts (scenarios J, K and L).

import { afterEach, describe, expect, it } from 'vitest';
import { type AgentState, type Commitment, type SeenEntity, PersonaSchema, WorldConfigSchema, nullLogger } from '@agora/shared';
import { AgentBus } from '@agora/agent/bus';
import {
  authorityShift,
  companionsOf,
  complies,
  defects,
  defendsAlly,
  follows,
  joinsRally,
  looksLikeLeader,
  mayRally,
  parseDemand,
  parseFightPromise,
  parseRally,
} from '@agora/agent/conflict/coercion';
import { ConflictEvaluator } from '@agora/agent/conflict/evaluator';
import { FOLLOWER_WEIGHT, LIVE_MARGIN, PowerWatch } from '@agora/agent/conflict/power';
import { spareChance } from '@agora/agent/conflict/pressure';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { CognitiveController, type ConflictView, codeDecision, lastDemandSaid, lastSaidTo, owesThreat, paying, tributeDue, validateDecision } from '@agora/agent/modules/cc';
import { NOW_RE, type PowerMoveCtx, type PowerView, escortMove, gossipMove, rallyMove, swornWith, uprisingMove } from '@agora/agent/modules/powerMove';
import { SocialAwareness, codePromises } from '@agora/agent/social/awareness';
import { CommitmentTracker } from '@agora/agent/social/commitments';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import type { Body } from '@agora/agent/body/body';
import { Conversations, detectAddressee } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { PROMISE_RE, Talking } from '@agora/agent/modules/talking';

const tyrant = PersonaSchema.parse({
  name: 'Rex',
  sex: 'male',
  traits: ['domineering'],
  temperament: { aggression: 0.8, dominance: 0.95, vengefulness: 0.7, mercy: 0.2, loyalty: 0.3, ambition: 0.9 },
  drives: { caution: 0.1 },
  abilities: { combat: 0.8, intelligence: 1 },
});
const rebel = PersonaSchema.parse({
  name: 'Ann',
  sex: 'female',
  traits: ['proud'],
  temperament: { aggression: 0.5, dominance: 0.4, vengefulness: 0.8, mercy: 0.5, loyalty: 0.6, ambition: 0.5 },
  drives: { caution: 0.3 },
  abilities: { combat: 0.5, intelligence: 1 },
});
const meek = PersonaSchema.parse({
  name: 'Tib',
  sex: 'male',
  traits: ['timid'],
  temperament: { aggression: 0.1, dominance: 0.1, vengefulness: 0.3, mercy: 0.8, loyalty: 0.4, ambition: 0.2 },
  drives: { caution: 0.6 },
  abilities: { combat: 0.2, intelligence: 1 },
});

const never = () => false;
const ent = (name: string, x: number, extra: Partial<SeenEntity> = {}): SeenEntity => ({
  id: x * 7 + name.length,
  kind: 'player',
  name,
  pos: { x, y: 0, z: 0 },
  distance: Math.abs(x),
  visible: true,
  heldItem: null,
  armor: [],
  lastSeen: 0,
  hurtRecently: false,
  ...extra,
});
const pact = (debtor: string, creditor: string, target: string, status: Commitment['status'] = 'accepted'): Commitment => ({
  id: `k${debtor}${creditor}${target}`,
  debtor,
  creditor,
  what: { kind: 'fight', target, text: `fight ${target} together` },
  dueBy: 10_000_000 + 1_800_000,
  status,
  createdFromConv: 'c1',
  createdAt: 10_000_000,
});

function world(persona = rebel, people: string[] = ['Rex', 'Bo', 'Cy']): AgentStateStore {
  const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: 0 }));
  s.update('self', (x) => ({ ...x, health: 20 }));
  s.update('social', (all) => ({ ...all, ...Object.fromEntries(people.map((n) => [n, { ...newSocialProfile(n, persona, 10_000_000), lastSeen: 10_000_000 }])) }));
  return s;
}

describe('demands and compliance (§17.7)', () => {
  it('a request with a threat on it is a demand; a polite one is not', () => {
    expect(parseDemand('give me 5 iron or else')).toEqual({ item: 'iron', qty: 5, recurring: false });
    expect(parseDemand("bring me bread every day or you'll regret it")).toEqual({ item: 'bread', qty: 1, recurring: true });
    expect(parseDemand("hand over your logs if you know what's good for you")).toEqual({ item: 'log', qty: 1, recurring: false });
    expect(parseDemand('give me 3 bread, please?')).toBeNull();
    expect(parseDemand('or else what?')).toBeNull();
  });

  it('complies when fear outweighs resentment and pride; the loyal bend more easily, and a leader asks more easily', () => {
    expect(complies(0.9, 0.1, 0.5)).toBe(true); // 0.9 > 0.1 + 0.75
    expect(complies(0.7, 0.1, 0.5)).toBe(false);
    expect(complies(0.7, 0.1, 1)).toBe(true); // pride 0.5
    expect(complies(0.95, 0.4, 0.5)).toBe(false); // too resentful
    // §18.4 authority: our leader's demand clears a lower bar; less so for the clear-headed (override).
    const fromLeader = authorityShift({ leader: true, admiration: 0, susceptibility: 0.8, override: 0 });
    expect(complies(0.7, 0.1, 0.5, fromLeader)).toBe(true);
    expect(authorityShift({ leader: true, admiration: 0, susceptibility: 0.8, override: 1 })).toBe(0);
    expect(authorityShift({ leader: false, admiration: 0.8, susceptibility: 1, override: 0 })).toBeCloseTo(0.18);
    expect(authorityShift({ leader: false, admiration: 0.2, susceptibility: 1, override: 0 })).toBe(0);
  });

  it('follows after complying twice while still afraid, or for protection; a leader has followers or tribute', () => {
    expect(follows({ complied: 2, fear: 0.8, fearOfOthers: 0, sentiment: 3, power: 0.2 })).toBe(true);
    // The tyrant looks weak now (§18.4.1): giving in no longer binds.
    expect(follows({ complied: 2, fear: 0.2, fearOfOthers: 0, sentiment: 3, power: 0.2 })).toBe(false);
    expect(follows({ complied: 0, fear: 0, fearOfOthers: 0.7, sentiment: 7, power: 0.7 })).toBe(true);
    expect(follows({ complied: 1, fear: 0.9, fearOfOthers: 0.7, sentiment: 4, power: 0.9 })).toBe(false);
    expect(looksLikeLeader(2, 0)).toBe(true);
    expect(looksLikeLeader(1, 1)).toBe(false);
    expect(companionsOf([{ with: ['Rex'] }, { with: ['Rex', 'Ann'] }, { with: ['Rex'] }, { with: ['Ann'] }])).toEqual(['Rex']);
  });

  it('the code default answers a demand by fear: gives in (a coerced promise) or refuses', () => {
    const s = world(meek).state;
    const heard = (text: string): AgentState => ({
      ...s,
      self: { ...s.self, inventory: [{ item: 'bread', qty: 5 }] },
      perception: { ...s.perception, heardSpeech: [{ id: 'u1', convId: 'c1', from: 'Rex', to: ['Tib'], text, ts: 1, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true }] },
    });
    const view = (fear: number, authority = 0): ConflictView => ({ rungOf: () => 0, fearOf: () => fear, mayBrawl: never, resentmentOf: () => 0.1, authorityOf: () => authority, warnedLately: never });
    const give = codeDecision(heard('give me 3 bread, or else'), { from: 'Rex', convId: 'c1' }, false, never, { candidates: [], roll: 1, conflict: view(0.95) });
    expect(give?.task).toEqual({ skill: 'give', args: { to: 'Rex', item: 'bread', qty: 3 } });
    expect(give?.commitmentsToCreate?.[0]).toMatchObject({ debtor: 'Tib', creditor: 'Rex', coerced: true });
    expect(give?.speechIntent?.gist).toBe('fine. I\'ll give you 3 bread');
    const no = codeDecision(heard('give me 3 bread, or else'), { from: 'Rex', convId: 'c1' }, false, never, { candidates: [], roll: 1, conflict: view(0.6) });
    expect(no?.speechIntent?.stance).toBe('hostile');
    expect(no?.commitmentsToCreate).toBeUndefined();
    // Having demanded it, a domineering agent gives them the chance before any blows.
    const rex = world(tyrant, ['Tib']).state;
    const near: AgentState = { ...rex, perception: { ...rex.perception, nearbyEntities: [ent('Tib', 4)] } };
    const brawl = (pending: boolean): ConflictView => ({ rungOf: () => 3, fearOf: () => 0, mayBrawl: () => true, demandPending: () => pending, warnedLately: () => true });
    expect(codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: brawl(false) })?.option).toBe('fight');
    expect(codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: brawl(true) })?.option).not.toBe('fight');
    // A tyrant asks before he beats: no demand said to Tib lately, so a demand first; one unpaid, then the blows.
    const asked = (lately: boolean): ConflictView => ({ rungOf: () => 3, fearOf: () => 0, mayBrawl: () => true, demandPending: () => false, demandedLately: () => lately, warnedLately: () => false });
    expect(codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: asked(false) })?.option).toBe('demand');
    expect(codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: asked(true) })?.option).toBe('fight');
    // One who heard it and didn't pay is gone after, if in sight; out of sight, not.
    const off = (d: number): AgentState => ({ ...rex, perception: { ...rex.perception, nearbyEntities: [ent('Tib', d)] } });
    expect(codeDecision(off(20), {}, false, never, { candidates: [], roll: 1, conflict: asked(true) })).toMatchObject({ option: 'fight', target: { agent: 'Tib' } });
    expect(codeDecision(off(30), {}, false, never, { candidates: [], roll: 1, conflict: asked(true) })?.option).not.toBe('fight');
    // When a demand was said is what our side of the conversation has.
    const said = world(tyrant, ['Tib']);
    said.update('conversations', (cs) => ({
      ...cs,
      d1: { convId: 'd1', participants: ['Rex', 'Tib'], startedAt: 0, lastActivity: 5, turns: 2, myTurns: 1, lastEmbeds: [], status: 'ended', transcript: [{ id: 'x', convId: 'd1', from: 'Rex', to: ['Tib'], text: 'Tib, give me 3 bread, or else', ts: 5, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false }], initiatedByMe: true, endedReason: 'quiet' },
    }));
    expect(lastDemandSaid(said.state, 'Tib')).toBe(5);
    expect(lastDemandSaid(said.state, 'Pia')).toBe(-Infinity);
    // The same fear, but Rex is the one we follow: authority tips it.
    const led = codeDecision(heard('give me 3 bread, or else'), { from: 'Rex', convId: 'c1' }, false, never, { candidates: [], roll: 1, conflict: view(0.75, 0.24) });
    expect(led?.task?.skill).toBe('give');
    // Busy chopping when asked: the refusal goes on with the chopping (a valid decision), unless the chopping is stuck.
    const working: AgentState = { ...heard('give me 3 bread, or else'), option: { decisionId: 'd0', option: 'work', startedAt: 0, maxSeconds: 600, skill: 'obtain', args: { item: 'oak_log', qty: 32 }, status: 'running' } };
    const env = { me: 'Tib', isStuck: never, canPerceive: () => true };
    const busyNo = codeDecision(working, { from: 'Rex', convId: 'c1' }, true, never, { candidates: [], roll: 1, conflict: view(0.6) });
    expect(busyNo).toMatchObject({ option: 'work', task: { skill: 'obtain', args: { item: 'oak_log', qty: 32 } }, speechIntent: { stance: 'hostile' } });
    expect(busyNo && validateDecision(busyNo, env)).toBeNull();
    const stuck = (skill: string) => skill === 'obtain';
    expect(codeDecision(working, { from: 'Rex', convId: 'c1' }, true, stuck, { candidates: [], roll: 1, conflict: view(0.6) })).toMatchObject({ option: 'rest', speechIntent: { stance: 'hostile' } });
    // In the middle of a fight when asked: the answer goes on with the fight.
    const fighting: AgentState = { ...heard('give me 3 bread, or else'), option: { decisionId: 'd0', option: 'fight', startedAt: 0, maxSeconds: 90, skill: 'duel', args: { target: 'Rex', stopAtHealth: 5 }, status: 'running' } };
    expect(codeDecision(fighting, { from: 'Rex', convId: 'c1' }, true, never, { candidates: [], roll: 1, conflict: view(0.6) })).toMatchObject({ option: 'fight', task: { skill: 'duel', args: { target: 'Rex' } }, speechIntent: { stance: 'hostile' } });
  });
});

describe('a fight decided again (§17.6)', () => {
  it('goes on with the fight under way with that person, not broken off and begun anew; its cry is said once', async () => {
    const s = world(rebel, ['Rex']);
    // Within reach of a fight, not yet of the cry.
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 10)] }));
    const bus = new AgentBus();
    const said: string[] = [];
    const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => ({ talkOverable: false }), run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: rebel.name, inRange: () => ['Rex'], rng: () => 0 });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: rebel.name, rng: () => 0, rungOf: () => 3 });
    const conflict = { rungOf: () => 3, fearOf: () => 0, mayFight: () => null };
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: rebel.name, levers: () => leversFor(0.5), awareness, executor, canPerceive: () => true, conflict, rng: () => 0.99 });
    const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
    for (const m of [executor, conversations, talking, cc]) m.start();
    // An uprising's strike at Rex, still on its way: its own terms (120 s) and its cry.
    const strike = { id: 'd0', createdAt: Date.now(), stateVersion: s.version, source: 'default' as const, option: 'fight' as const, target: { agent: 'Rex' }, task: { skill: 'duel', args: { target: 'Rex', stopAtHealth: 5, seconds: 120 } }, speechIntent: { stance: 'threaten' as const, gist: "now! we've had enough of you, Rex", mayCommit: false }, terminate: { maxSeconds: 150 }, rationale: 'test' };
    s.set('option', { decisionId: 'd0', option: 'fight', startedAt: Date.now(), maxSeconds: 150, targetAgent: 'Rex', skill: 'duel', args: strike.task.args, status: 'running' }, 'fighting');
    s.set('decision', strike, 'decided');
    bus.emit({ type: 'decision', decision: strike });
    // Struck back, we decide again: the brawl with Rex, on other terms. It is the same fight.
    cc.trigger('Rex hit us', { urgent: true, atOdds: 'Rex' });
    await settle();
    expect(s.state.decision?.id).not.toBe('d0');
    expect(s.state.decision).toMatchObject({ option: 'fight', task: { skill: 'duel', args: { target: 'Rex' } } });
    expect(s.state.option?.decisionId).toBe('d0');
    // Rex in reach: the cry goes out, once.
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 3)] }));
    for (let i = 0; i < 60 && said.length === 0; i++) await settle(50);
    await settle(800);
    expect(said).toEqual(["now! we've had enough of you, Rex"]);
    for (const m of [cc, talking, conversations, executor]) m.stop();
  });
});

describe('a new follower out on a stroll (§17.7)', () => {
  it('beginning to follow someone wakes the mind mid-stroll, and it keeps by them from then on; at work, the work goes on', async () => {
    const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
    const follows = async (skill: string, args: Record<string, unknown>) => {
      const s = world(meek, ['Rex']);
      s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 3)] }));
      const bus = new AgentBus();
      const body = { say: () => Promise.resolve(true), skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
      const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
      const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
      let leader: string | null = null;
      const power = { leader: () => leader, coalition: (x: string) => ({ target: x, members: [], power: 0, against: 1, opening: false }), knownResenters: () => [] };
      const conflict = { rungOf: () => 0, fearOf: () => 0, mayFight: () => null };
      const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: meek.name, levers: () => leversFor(0.5), awareness, executor, canPerceive: () => true, conflict, power, rng: () => 0.99 });
      for (const m of [executor, cc]) m.start();
      s.set('option', { decisionId: 'd0', option: 'work', startedAt: Date.now(), maxSeconds: 90, skill, args, status: 'running' }, 'under way');
      await settle();
      expect(executor.busy).toBe(true);
      // Tib has just begun to follow Rex (right beside him at that moment).
      leader = 'Rex';
      bus.emit({ type: 'leaderChanged', leader: 'Rex', before: null });
      await settle(100);
      const d = s.state.decision;
      for (const m of [cc, executor]) m.stop();
      return d;
    };
    expect(await follows('wander', { radius: 16, seconds: 75 })).toMatchObject({ option: 'follow', target: { agent: 'Rex' }, rationale: 'code default: following Rex now; keeping by Rex' });
    expect(await follows('obtain', { item: 'oak_log', qty: 32 })).toBeNull();
  });
});

describe('a demand on its way (§17.7)', () => {
  it('is said before the next one; one that never got said is made again, and one said counts', async () => {
    const s = world(tyrant, ['Tib', 'Pia']);
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Tib', 9), ent('Pia', 10)] }));
    const bus = new AgentBus();
    const walks: ((r: unknown) => void)[] = [];
    const body = { skill: () => null, run: () => new Promise((resolve) => walks.push(resolve)) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    // Tib is the worse of the two; neither may be beaten yet.
    const conflict = { rungOf: (n: string) => (n === 'Tib' ? 3 : 2), fearOf: () => 0, mayFight: () => 'not yet' };
    const clock = { now: 10_000_000 };
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: 'Rex', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => true, conflict, rng: () => 0.99, now: () => clock.now });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    executor.start();
    cc.start();
    cc.trigger('Tib is here', { urgent: true, atOdds: 'Tib' });
    await settle();
    expect(s.state.decision).toMatchObject({ option: 'demand', target: { agent: 'Tib' } });
    expect(s.state.option).toMatchObject({ option: 'demand', targetAgent: 'Tib', skill: 'goTo' });
    expect(owesThreat(s.state)).toBe(true);
    // Pia comes near while we walk over to Tib: Tib hears the demand first.
    const first = s.state.decision?.id;
    cc.trigger('Pia is here', { urgent: true, atOdds: 'Pia' });
    await settle();
    expect(s.state.decision?.id).toBe(first);
    // Tib walked off and the walk came to nothing before a word was said: Tib is asked again, not passed over.
    clock.now += 5000;
    walks.shift()?.({ id: 'w', skill: 'goTo', args: { agent: 'Tib', range: 4 }, ok: false, expected: 'within 6 of Tib', observed: '8.2 blocks from Tib', error: 'expected within 6 of Tib but saw 8.2', startedAt: 0, durationMs: 1 });
    await settle();
    expect(s.state.decision).toMatchObject({ option: 'demand', target: { agent: 'Tib' } });
    expect(s.state.decision?.id).not.toBe(first);
    // Said, it counts: the next demand is Pia's, and it is a new option (walking over to Pia, not on to Tib).
    const at = clock.now + 1;
    s.update('conversations', (cs) => ({
      ...cs,
      d1: { convId: 'd1', participants: ['Rex', 'Tib'], startedAt: at, lastActivity: at, turns: 1, myTurns: 1, lastEmbeds: [], status: 'active', transcript: [{ id: 'x', convId: 'd1', from: 'Rex', to: ['Tib'], text: 'Tib, give me 3 bread, or else', ts: at, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false }], initiatedByMe: true },
    }));
    expect(owesThreat(s.state)).toBe(false);
    expect(lastSaidTo(s.state, 'Tib')).toBe(at);
    expect(lastSaidTo(s.state, 'Tib', (t) => t.startsWith('hello'))).toBe(-Infinity);
    cc.trigger('Pia is here', { urgent: true, atOdds: 'Pia' });
    await settle();
    expect(s.state.decision).toMatchObject({ option: 'demand', target: { agent: 'Pia' } });
    expect(s.state.option?.targetAgent).toBe('Pia');
    cc.stop();
    executor.stop();
  });

  it('a beating answers one demand: another takes another demand first', async () => {
    const run = async (foughtAgoSec: number) => {
      const s = world(tyrant, ['Tib']);
      const clock = { now: 10_000_000 };
      s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Tib', 9)] }));
      // A demand said two minutes ago and not paid; the fight with Tib was before it, or after.
      const said = clock.now - 120_000;
      s.update('conversations', (cs) => ({
        ...cs,
        d1: { convId: 'd1', participants: ['Rex', 'Tib'], startedAt: said, lastActivity: said, turns: 1, myTurns: 1, lastEmbeds: [], status: 'ended', transcript: [{ id: 'x', convId: 'd1', from: 'Rex', to: ['Tib'], text: 'Tib, give me 3 bread, or else', ts: said, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false }], initiatedByMe: true, endedReason: 'quiet' },
      }));
      s.update('social', (all) => ({ ...all, Tib: { ...(all.Tib ?? newSocialProfile('Tib', tyrant, 0)), lastFight: { ts: clock.now - foughtAgoSec * 1000, outcome: 'won' } } }));
      const bus = new AgentBus();
      const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
      const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
      const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
      const conflict = { rungOf: () => 3, fearOf: () => 0, mayFight: () => null };
      const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: 'Rex', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => true, conflict, rng: () => 0.99, now: () => clock.now });
      cc.start();
      cc.trigger('Tib is here', { urgent: true, atOdds: 'Tib' });
      await new Promise((r) => setTimeout(r, 20));
      cc.stop();
      return s.state.decision;
    };
    // Beaten before the demand, and the demand unpaid: the blows come.
    expect(await run(300)).toMatchObject({ option: 'fight', target: { agent: 'Tib' } });
    // Beaten since: that demand is answered; a new one comes first.
    expect(await run(60)).toMatchObject({ option: 'demand', target: { agent: 'Tib' } });
  });

  it('is paid once: a later reason to decide does not answer the same demand again', async () => {
    const s = world(meek, ['Rex']);
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 2)], heardSpeech: [{ id: 'u1', convId: 'c1', from: 'Rex', to: ['Tib'], text: 'Tib, give me 3 bread, or else', ts: 1, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true }] }));
    s.update('self', (x) => ({ ...x, inventory: [{ item: 'bread', qty: 8 }] }));
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const conflict = { rungOf: () => 0, fearOf: () => 0.95, mayFight: () => 'no' };
    const clock = { now: 10_000_000 };
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: 'Tib', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => true, conflict, rng: () => 0.99, now: () => clock.now });
    executor.start();
    cc.start();
    bus.emit({ type: 'needsDecision', reason: 'request', convId: 'c1', from: 'Rex' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.state.decision?.task).toMatchObject({ skill: 'give', args: { to: 'Rex', item: 'bread', qty: 3 } });
    expect(s.state.commitments.filter((c) => c.coerced)).toHaveLength(1);
    clock.now += 15_000;
    bus.emit({ type: 'needsDecision', reason: 'request', convId: 'c1', from: 'Rex' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.state.decision?.rationale).toMatch(/nothing new from Rex/);
    expect(s.state.decision?.speechIntent).toBeUndefined();
    expect(s.state.commitments.filter((c) => c.coerced)).toHaveLength(1);
    cc.stop();
    executor.stop();
  });

  it('is answered mid-fight without ending the fight, which the gate need not pass again', async () => {
    const s = world(meek, ['Rex']);
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 2)], heardSpeech: [{ id: 'u1', convId: 'c1', from: 'Rex', to: ['Tib'], text: 'Tib, give me 3 bread, or else', ts: 1, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true }] }));
    s.update('self', (x) => ({ ...x, inventory: [{ item: 'bread', qty: 5 }] }));
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    // Fights are capped world-wide just now: a new one would be held back, this one goes on.
    const conflict = { rungOf: () => 3, fearOf: () => 0.3, mayFight: () => 'you hold back for now' };
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: 'Tib', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => true, conflict, isPerson: () => true, rng: () => 0.99 });
    executor.start();
    cc.start();
    s.set('option', { decisionId: 'd0', option: 'fight', startedAt: Date.now(), maxSeconds: 90, skill: 'duel', args: { target: 'Rex', stopAtHealth: 5 }, status: 'running' }, 'a fight under way');
    await new Promise((r) => setTimeout(r, 20));
    bus.emit({ type: 'needsDecision', reason: 'request', convId: 'c1', from: 'Rex' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.state.decision).toMatchObject({ option: 'fight', speechIntent: { stance: 'hostile' } });
    expect(s.state.option?.decisionId).toBe('d0');
    cc.stop();
    executor.stop();
  });

  it('only blows come before it', () => {
    const s = world(tyrant, ['Tib', 'Pia']);
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Tib', 9), ent('Pia', 5)] }));
    s.set('decision', { id: 'd1', createdAt: 100, stateVersion: 1, source: 'default', option: 'demand', target: { agent: 'Tib' }, speechIntent: { stance: 'threaten', gist: 'give me 3 bread, or else', mayCommit: false }, terminate: { maxSeconds: 40 }, rationale: 't' }, 'test');
    s.set('option', { decisionId: 'd1', option: 'demand', startedAt: 100, maxSeconds: 40, targetAgent: 'Tib', status: 'running' }, 'test');
    const view = (refused: boolean): ConflictView => ({ rungOf: () => 3, fearOf: () => 0, mayBrawl: () => true, demandPending: () => false, demandedLately: (n) => refused && n === 'Pia', warnedLately: (n) => n === 'Tib' });
    expect(codeDecision(s.state, { atOdds: 'Pia' }, true, never, { candidates: [], roll: 1, conflict: view(false) })).toBeNull();
    expect(codeDecision(s.state, { atOdds: 'Pia' }, true, never, { candidates: [], roll: 1, conflict: view(true) })).toMatchObject({ option: 'fight', target: { agent: 'Pia' } });
    // Its option over, nothing is owed any more.
    s.update('option', (o) => (o ? { ...o, status: 'failed' } : o), 'test');
    expect(owesThreat(s.state)).toBe(false);
  });
});

describe('saying it (§17.7, §17.8)', () => {
  it('a demand and a call to rise are said, as worded, to the one they are for, once that one is in range', async () => {
    const s = world(tyrant, ['Tib', 'Bo']);
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Tib', 3), ent('Bo', 4)] }));
    const bus = new AgentBus();
    const said: string[] = [];
    const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Rex', inRange: () => ['Tib', 'Bo'], rng: () => 0 });
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Rex', rng: () => 0, rungOf: () => 2 });
    conversations.start();
    talking.start();
    const decide = (id: string, option: 'demand' | 'recruit', agent: string, stance: 'threaten' | 'rally', gist: string) => {
      const d = { id, createdAt: 0, stateVersion: 1, source: 'default' as const, option, target: { agent }, speechIntent: { stance, gist, mayCommit: false }, terminate: { maxSeconds: 30 }, rationale: 'test' };
      s.set('decision', d, 'test');
      bus.emit({ type: 'decision', decision: d });
    };
    decide('d1', 'demand', 'Tib', 'threaten', 'give me 3 bread, or else');
    for (let i = 0; i < 40 && said.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    decide('d2', 'recruit', 'Bo', 'rally', "Tib has pushed us around long enough. let's deal with Tib together.");
    for (let i = 0; i < 40 && said.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(said).toEqual(['Tib, give me 3 bread, or else', "Bo, Tib has pushed us around long enough. let's deal with Tib together."]);
    // Bo answers in that conversation: the call isn't said again, word for word, on every turn.
    const conv = Object.values(s.state.conversations).find((c) => c.participants.includes('Bo'));
    bus.emit({ type: 'heard', utterance: { id: 'b1', convId: conv?.convId ?? '', from: 'Bo', to: ['Rex'], text: 'hmm, really?', ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: true, heardAs: 'me' } });
    for (let i = 0; i < 60 && said.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    expect(said[2]).toBeDefined();
    expect(said[2]).not.toBe(said[1]);
    talking.stop();
    conversations.stop();
  }, 10_000);
});

describe('who a line is for (§6.2)', () => {
  it('the name a line opens with decides it, whoever else the line names', () => {
    const base = { speaker: 'Rex', inConversationWith: false };
    expect(detectAddressee({ ...base, me: 'Tib', text: 'Tib, give me 3 bread, or else', inRange: ['Rex', 'Pia'] })).toBe('me');
    expect(detectAddressee({ ...base, me: 'Pia', text: 'Tib, give me 3 bread, or else', inRange: ['Rex', 'Tib'] })).toBe('other');
    // A call to rise against Tib, said to Bo, isn't said to Tib, though it names Tib.
    expect(detectAddressee({ ...base, me: 'Tib', text: "Bo, Tib has pushed us around long enough. let's deal with Tib together.", inRange: ['Rex', 'Bo'] })).toBe('other');
    expect(detectAddressee({ ...base, me: 'Tib', text: '@Bo come here', inRange: ['Rex', 'Bo'] })).toBe('other');
    // A word that isn't anyone around is no name.
    expect(detectAddressee({ ...base, me: 'Tib', text: "fine, I'll give you 3 bread", inRange: ['Rex'] })).toBe('me');
  });

  it("dealing with someone together is no promise; a deal is", () => {
    expect(PROMISE_RE.test("Rex has pushed us around long enough. let's deal with Rex together.")).toBe(false);
    expect(PROMISE_RE.test('deal! two logs for a bread')).toBe(true);
    expect(PROMISE_RE.test("ok, it's a deal")).toBe(true);
  });
});

describe('giving in, as it is said (§17.7)', () => {
  it('two demands paid in one conversation are two coerced promises; a payment restated is not a third', async () => {
    const s = world(tyrant, ['Pia']);
    const bus = new AgentBus();
    const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: 'Rex', settleMs: 0, now: () => 10_000_000 });
    sa.start();
    const lines: { id: string; from: string; text: string }[] = [];
    const say = (from: string, text: string) => {
      const u = { id: `u${lines.length}`, convId: 'p1', from, to: from === 'Rex' ? ['Pia'] : ['Rex'], text, ts: lines.length + 1, pos: null, volume: 'normal' as const, outOfSight: false, addressedToMe: from !== 'Rex', heardAs: from === 'Rex' ? ('other' as const) : ('me' as const) };
      lines.push(u);
      s.update('conversations', (cs) => ({
        ...cs,
        p1: { convId: 'p1', participants: ['Rex', 'Pia'], startedAt: 0, lastActivity: u.ts, turns: lines.length, myTurns: 0, lastEmbeds: [], status: 'active', transcript: lines.map((l, i) => ({ ...u, ...l, ts: i + 1 })), initiatedByMe: true },
      }));
      if (from !== 'Rex') bus.emit({ type: 'addressed', utterance: u });
    };
    const coerced = () => s.state.commitments.filter((c) => c.coerced && c.debtor === 'Pia' && c.creditor === 'Rex');
    say('Rex', 'Pia, give me 3 bread, or else');
    say('Pia', "Rex, fine. I'll give you 3 bread");
    expect(coerced().map((c) => c.what.text)).toEqual(["fine. I'll give you 3 bread"]);
    s.update('commitments', (all) => all.map((c) => ({ ...c, status: 'fulfilled' as const, resolvedAt: 5 })));
    say('Pia', "there, I'll give you the bread, ok?");
    expect(coerced()).toHaveLength(1);
    say('Rex', 'Pia, give me 3 bread, or else');
    say('Pia', "Rex, fine. I'll give you 3 bread");
    expect(coerced()).toHaveLength(2);
    // Read at the end, the conversation adds nothing that is already down.
    s.update('conversations', (cs) => ({ ...cs, p1: { ...(cs.p1 as NonNullable<typeof cs.p1>), status: 'ended', endedReason: 'turn cap' } }));
    bus.emit({ type: 'conversationEnded', convId: 'p1', reason: 'turn cap' });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.state.commitments.filter((c) => c.debtor === 'Pia')).toHaveLength(2);
    // Demanded in that conversation, given in to in the next one: still giving in.
    s.update('conversations', (cs) => ({
      ...cs,
      p2: { convId: 'p2', participants: ['Rex', 'Pia'], startedAt: 50, lastActivity: 50, turns: 0, myTurns: 0, lastEmbeds: [], status: 'ended', transcript: [{ id: 'd3', convId: 'p2', from: 'Rex', to: ['Pia'], text: 'Pia, give me 8 logs, or else', ts: 50, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false }], initiatedByMe: true, endedReason: 'quiet' },
      p3: { convId: 'p3', participants: ['Rex', 'Pia'], startedAt: 60, lastActivity: 60, turns: 1, myTurns: 0, lastEmbeds: [], status: 'active', transcript: [], initiatedByMe: false },
    }));
    const late = { id: 'g3', convId: 'p3', from: 'Pia', to: ['Rex'], text: "Rex, fine. I'll give you 8 logs", ts: 60, pos: null, volume: 'normal' as const, outOfSight: false, addressedToMe: true, heardAs: 'me' as const };
    s.update('conversations', (cs) => ({ ...cs, p3: { ...(cs.p3 as NonNullable<typeof cs.p3>), transcript: [late] } }));
    bus.emit({ type: 'addressed', utterance: late });
    expect(coerced().map((c) => c.what.item)).toEqual(['bread', 'bread', 'log']);
    sa.stop();
  });
});

describe('promises in a group', () => {
  it("a promise made to someone else in the conversation isn't one to us", async () => {
    const run = async (addressedToMe: boolean) => {
      const s = world(meek, ['Tib', 'Rex']);
      const bus = new AgentBus();
      const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: 'Tib', settleMs: 0, now: () => 10_000_000 });
      sa.start();
      const u = (id: string, from: string, text: string, toMe: boolean) => ({ id, convId: 'g1', from, to: toMe ? ['Tib'] : ['Rex'], text, ts: 1, pos: null, volume: 'normal' as const, outOfSight: false, addressedToMe: toMe, heardAs: toMe ? ('me' as const) : ('other' as const) });
      s.update('conversations', (cs) => ({
        ...cs,
        g1: {
          convId: 'g1',
          participants: ['Tib', 'Pia', 'Rex'],
          startedAt: 0,
          lastActivity: 10,
          turns: 2,
          myTurns: 0,
          lastEmbeds: [],
          status: 'ended',
          transcript: [u('a', 'Rex', 'give me 3 bread, or else', false), u('b', 'Pia', "fine. I'll give you 3 bread", addressedToMe)],
          initiatedByMe: false,
          endedReason: 'turn cap',
        },
      }));
      bus.emit({ type: 'conversationEnded', convId: 'g1', reason: 'turn cap' });
      await new Promise((r) => setTimeout(r, 100));
      sa.stop();
      return s.state.commitments.filter((c) => c.debtor === 'Pia');
    };
    expect(await run(false)).toEqual([]);
    expect((await run(true)).map((c) => c.creditor)).toEqual(['Tib']);
  });
});

describe('tribute (§17.7)', () => {
  it('who gave in pays again every few minutes, once nothing is owed, for an hour', () => {
    const t = 10_000_000;
    const paid = (at: number, status: Commitment['status'] = 'fulfilled'): Commitment => ({ ...pact('Tib', 'Rex', 'x'), id: `p${at}${status}`, what: { kind: 'give', item: 'bread', qty: 3, text: '3 bread' }, coerced: true, status, resolvedAt: at });
    expect(tributeDue([], 'Rex', 'Tib', t)).toBe(false);
    expect(tributeDue([paid(t - 60_000)], 'Rex', 'Tib', t)).toBe(false);
    expect(tributeDue([paid(t - 6 * 60_000)], 'Rex', 'Tib', t)).toBe(true);
    expect(tributeDue([paid(t - 6 * 60_000), paid(t - 1000, 'accepted')], 'Rex', 'Tib', t)).toBe(false);
    expect(tributeDue([paid(t - 61 * 60_000)], 'Rex', 'Tib', t)).toBe(false);
    // Only what was paid to us under threat.
    expect(tributeDue([{ ...paid(t - 6 * 60_000), coerced: false }], 'Rex', 'Tib', t)).toBe(false);
  });

  it('who is paying, or paid lately, is left alone: no blows over it', () => {
    const t = 10_000_000;
    const paid = (at: number, status: Commitment['status'] = 'fulfilled'): Commitment => ({ ...pact('Tib', 'Rex', 'x'), id: `p${at}${status}`, what: { kind: 'give', item: 'bread', qty: 3, text: '3 bread' }, coerced: true, status, resolvedAt: at });
    expect(paying([paid(t - 1000, 'accepted')], 'Rex', 'Tib', t)).toBe(true);
    expect(paying([paid(t - 9 * 60_000)], 'Rex', 'Tib', t)).toBe(true);
    expect(paying([paid(t - 11 * 60_000)], 'Rex', 'Tib', t)).toBe(false);
    expect(paying([paid(t - 1000, 'broken')], 'Rex', 'Tib', t)).toBe(false);
    expect(paying([{ ...paid(t - 1000), coerced: false }], 'Rex', 'Tib', t)).toBe(false);
    // The tyrant at rung 3 with Tib: a beating, unless Tib is paying.
    const s = world(tyrant, ['Tib']).state;
    const near: AgentState = { ...s, perception: { ...s.perception, nearbyEntities: [ent('Tib', 4)] } };
    const angry = (pending: boolean): ConflictView => ({ rungOf: () => 3, fearOf: () => 0, mayBrawl: () => true, demandPending: () => pending, warnedLately: () => true });
    expect(codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: angry(false) })?.option).toBe('fight');
    expect(codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: angry(true) })?.option).not.toBe('fight');
  });

  it('a domineering agent asks it of them even when not angry; a follower stays near the leader it fears', () => {
    const s = world(tyrant, ['Tib']).state;
    const near: AgentState = { ...s, perception: { ...s.perception, nearbyEntities: [ent('Tib', 4)] } };
    const view = (due: boolean): ConflictView => ({ rungOf: () => 0, fearOf: () => 0, mayBrawl: never, tributeDue: () => due, warnedLately: never });
    expect(codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: view(false) })?.option).not.toBe('demand');
    const d = codeDecision(near, {}, false, never, { candidates: [], roll: 1, conflict: view(true) });
    expect(d).toMatchObject({ option: 'demand', target: { agent: 'Tib' }, speechIntent: { stance: 'threaten', gist: 'give me 3 bread, or else' } });
    // Off at work, in sight: he goes over to collect it; out of sight, or asked lately, not.
    const at = (d: number, visible = true): AgentState => ({ ...s, perception: { ...s.perception, nearbyEntities: [ent('Tib', d, { visible })] } });
    expect(codeDecision(at(20), {}, false, never, { candidates: [], roll: 1, conflict: view(true) })).toMatchObject({ option: 'demand', target: { agent: 'Tib' } });
    expect(codeDecision(at(20, false), {}, false, never, { candidates: [], roll: 1, conflict: view(true) })?.option).not.toBe('demand');
    expect(codeDecision(at(30), {}, false, never, { candidates: [], roll: 1, conflict: view(true) })?.option).not.toBe('demand');
    expect(codeDecision(at(20), {}, false, never, { candidates: [], roll: 1, conflict: { ...view(true), warnedLately: () => true } })?.option).not.toBe('demand');
    // Tib fears and dislikes Rex: keeps away from Rex, unless Rex is the one Tib follows.
    const tib = world(meek, ['Rex']).state;
    const t2: AgentState = { ...tib, perception: { ...tib.perception, nearbyEntities: [ent('Rex', 4)] }, social: { ...tib.social, Rex: { ...(tib.social.Rex ?? newSocialProfile('Rex', meek, 0)), sentiment: 3 } } };
    const afraid: ConflictView = { rungOf: () => 0, fearOf: () => 0.9, mayBrawl: never, warnedLately: never };
    expect(codeDecision(t2, {}, false, never, { candidates: [], roll: 1, conflict: afraid })?.option).toBe('move');
    const led: PowerView = { leader: () => 'Rex', coalition: (x) => ({ target: x, members: [], power: 0, against: 1, opening: false }), knownResenters: () => [], saidLately: () => false };
    expect(codeDecision(t2, {}, false, never, { candidates: [], roll: 1, conflict: afraid, power: led })?.option).not.toBe('move');
    // With nothing else to do, a follower keeps by the one it follows.
    expect(codeDecision(t2, {}, false, never, { candidates: [], roll: 1, conflict: afraid, power: led })).toMatchObject({ option: 'follow', target: { agent: 'Rex' } });
  });

  it('one who has just begun to follow, out on a stroll, keeps by them from then on; work with a purpose goes on', () => {
    const tib = world(meek, ['Rex']).state;
    const led: PowerView = { leader: () => 'Rex', coalition: (x) => ({ target: x, members: [], power: 0, against: 1, opening: false }), knownResenters: () => [], saidLately: () => false };
    const calm: ConflictView = { rungOf: () => 0, fearOf: () => 0, mayBrawl: never, warnedLately: never };
    const doing = (skill: string, d: number): AgentState => ({
      ...tib,
      perception: { ...tib.perception, nearbyEntities: [ent('Rex', d)] },
      option: { decisionId: 'd0', option: 'work', startedAt: 0, maxSeconds: 90, skill, args: {}, status: 'running' },
    });
    const now = (s: AgentState, leader?: string) => codeDecision(s, leader ? { leader } : {}, true, never, { candidates: [], roll: 1, conflict: calm, power: led });
    expect(now(doing('wander', 14), 'Rex')).toMatchObject({ option: 'follow', target: { agent: 'Rex' }, rationale: 'code default: following Rex now; keeping by Rex' });
    expect(now(doing('lookAround', 14), 'Rex')).toMatchObject({ option: 'follow', target: { agent: 'Rex' } });
    // Beside them just now is no reason to stroll off from them.
    expect(now(doing('wander', 2), 'Rex')).toMatchObject({ option: 'follow', target: { agent: 'Rex' } });
    // Work with a purpose goes on; one out of sight is no one to keep by; and nothing new, nothing changes.
    expect(now(doing('obtain', 14), 'Rex')).toBeNull();
    expect(now(doing('wander', 40), 'Rex')).toBeNull();
    expect(now(doing('wander', 14))).toBeNull();
  });
});

describe('followers and leaders, as onlookers see them (§17.7)', () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const f of stops.splice(0)) f();
  });

  function watch(persona = rebel, mode: 'test' | 'live' = 'test') {
    const s = world(persona, ['Rex', 'Bo', 'Cy', 'Di']);
    const bus = new AgentBus();
    const t = { now: 10_000_000 };
    const powers: Record<string, number> = { Rex: 0.7, Bo: 0.2, Cy: 0.2, Di: 0.25, Ann: 0.3, Tib: 0.15 };
    const fears: Record<string, number> = { Rex: 0.8 };
    const pw = new PowerWatch({ store: s, bus, logger: nullLogger(), me: persona.name, mode, powerOf: (n) => powers[n] ?? 0.3, myPower: () => powers[persona.name] ?? 0.3, fearOf: (n) => fears[n] ?? 0, now: () => t.now });
    const tick = () => (pw as unknown as { tick(): void }).tick();
    pw.start();
    stops.push(() => pw.stop());
    return { s, bus, t, pw, tick, powers, fears };
  }

  it('two weaker people seen going about with Rex make Rex a leader in our eyes; it fades when they part', () => {
    const w = watch();
    const crowd = [ent('Rex', 20), ent('Bo', 22), ent('Cy', 18), ent('Di', -30)];
    w.s.update('perception', (p) => ({ ...p, nearbyEntities: crowd }));
    for (let i = 0; i < 3; i++) {
      w.tick();
      w.t.now += 10_000;
    }
    expect(w.pw.companions('Bo')).toContain('Rex');
    expect(w.s.state.social.Rex?.followersSeen).toBe(2);
    expect(w.s.state.social.Rex?.perceivedRole).toBe('leader');
    // Di is alone; nobody follows Bo (Bo is the weaker one).
    expect(w.s.state.social.Bo?.followersSeen).toBe(0);
    w.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 20), ent('Bo', -40), ent('Cy', 60)] }));
    for (let i = 0; i < 4; i++) {
      w.tick();
      w.t.now += 10_000;
    }
    expect(w.s.state.social.Rex?.followersSeen).toBe(0);
    expect(w.s.state.social.Rex?.perceivedRole).toBeUndefined();
  });

  it('after paying Rex twice under threat we follow Rex; seeing Rex set upon by a strong group, a half-hearted follower walks away', () => {
    const w = watch(meek);
    const paid = (i: number): Commitment => ({ ...pact('Tib', 'Rex', 'x'), id: `p${i}`, what: { kind: 'give', item: 'bread', qty: 3, text: '3 bread' }, coerced: true, status: 'fulfilled', resolvedAt: w.t.now - i * 60_000 });
    w.s.update('commitments', () => [paid(1), paid(2)]);
    w.tick();
    expect(w.pw.leader()).toBe('Rex');
    expect(w.s.state.social.Rex?.allegiance).toBe('leader');
    // Unafraid of Rex for a moment, Tib would drift off; afraid again, back.
    w.fears.Rex = 0.1;
    w.tick();
    expect(w.pw.leader()).toBeNull();
    w.t.now += 61 * 60_000;
    w.s.update('commitments', () => [paid(1), paid(2)]);
    w.fears.Rex = 0.8;
    w.tick();
    expect(w.pw.leader()).toBe('Rex');
    expect(w.s.state.social.Rex?.allegiance).toBe('leader');
    // One attacker: we defend our leader (the reflex asks standsBy).
    w.bus.emit({ type: 'observedAction', action: { id: 'a1', actor: 'Bo', kind: 'attack', target: 'Rex', ts: w.t.now } });
    expect(w.pw.standsBy('Rex')).toBe(true);
    expect(w.pw.standsBy('Bo')).toBe(false);
    // A group sets upon Rex: Tib (loyalty 0.4, little fondness) fears them more than Rex: walks away, for the hour.
    w.powers.Bo = 0.5;
    w.powers.Cy = 0.5;
    w.fears.Rex = 0.3;
    w.bus.emit({ type: 'observedAction', action: { id: 'a2', actor: 'Cy', kind: 'attack', target: 'Rex', ts: w.t.now } });
    const left: unknown[] = [];
    w.bus.on('defected', (e) => left.push(e));
    expect(w.pw.standsBy('Rex')).toBe(false);
    expect(w.pw.leader()).toBeNull();
    expect(w.s.state.social.Rex?.allegiance).toBeUndefined();
    expect(left).toEqual([{ type: 'defected', from: 'Rex', attackers: ['Bo', 'Cy'] }]);
    w.tick();
    expect(w.pw.leader()).toBeNull();
  });

  it('one we follow who dies is followed no more; someone else dying changes nothing', () => {
    const w = watch(meek);
    const paid = (i: number): Commitment => ({ ...pact('Tib', 'Rex', 'x'), id: `p${i}`, what: { kind: 'give', item: 'bread', qty: 3, text: '3 bread' }, coerced: true, status: 'fulfilled', resolvedAt: w.t.now - i * 60_000 });
    w.s.update('commitments', () => [paid(1), paid(2)]);
    w.fears.Rex = 0.8;
    w.tick();
    expect(w.pw.leader()).toBe('Rex');
    w.bus.emit({ type: 'peerDied', name: 'Bo', cause: 'was slain by Zombie', witnessed: true });
    expect(w.pw.leader()).toBe('Rex');
    w.bus.emit({ type: 'peerDied', name: 'Rex', cause: 'was slain by Ann', witnessed: true, killer: 'Ann' });
    expect(w.pw.leader()).toBeNull();
    expect(w.s.state.social.Rex?.allegiance).toBeUndefined();
  });

  it('blows by two within a minute are a group setting upon the leader; a minute apart, two fights', () => {
    const at = (gap: number) => {
      const w = watch(meek);
      const paid = (i: number): Commitment => ({ ...pact('Tib', 'Rex', 'x'), id: `p${i}`, what: { kind: 'give', item: 'bread', qty: 3, text: '3 bread' }, coerced: true, status: 'fulfilled', resolvedAt: w.t.now - i * 60_000 });
      w.s.update('commitments', () => [paid(1), paid(2)]);
      w.fears.Rex = 0.8;
      w.tick();
      expect(w.pw.leader()).toBe('Rex');
      w.powers.Bo = 0.5;
      w.powers.Cy = 0.5;
      w.fears.Rex = 0.3;
      w.bus.emit({ type: 'observedAction', action: { id: 'a1', actor: 'Bo', kind: 'attack', target: 'Rex', ts: w.t.now } });
      w.t.now += gap;
      w.bus.emit({ type: 'observedAction', action: { id: 'a2', actor: 'Cy', kind: 'attack', target: 'Rex', ts: w.t.now } });
      return w.pw.standsBy('Rex');
    };
    expect(at(40_000)).toBe(false);
    expect(at(70_000)).toBe(true);
  });

  it('seeing the leader give up a fight, a half-hearted follower walks away; a loyal, fond one stands by', () => {
    const beaten = (persona: typeof meek, sentiment: number) => {
      const w = watch(persona);
      const paid = (i: number): Commitment => ({ ...pact(persona.name, 'Rex', 'x'), id: `p${i}`, what: { kind: 'give', item: 'bread', qty: 3, text: '3 bread' }, coerced: true, status: 'fulfilled', resolvedAt: w.t.now - i * 60_000 });
      w.s.update('commitments', () => [paid(1), paid(2)]);
      w.s.update('social', (all) => ({ ...all, Rex: { ...(all.Rex ?? newSocialProfile('Rex', persona, 0)), sentiment } }));
      w.tick();
      expect(w.pw.leader()).toBe('Rex');
      const left: unknown[] = [];
      w.bus.on('defected', (e) => left.push(e));
      // One rebel beats Rex, who gives up in front of us.
      w.powers.Bo = 0.35;
      w.bus.emit({ type: 'observedAction', action: { id: 'a1', actor: 'Bo', kind: 'attack', target: 'Rex', ts: w.t.now } });
      expect(w.pw.standsBy('Rex')).toBe(true);
      w.bus.emit({ type: 'heard', utterance: { id: 'u1', convId: '', from: 'Rex', to: 'nearby', text: 'ok ok, I yield!', ts: w.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
      return { leader: w.pw.leader(), left };
    };
    expect(beaten(meek, 4)).toEqual({ leader: null, left: [{ type: 'defected', from: 'Rex', attackers: ['Bo'] }] });
    const devoted = PersonaSchema.parse({ ...meek, name: 'Pia', temperament: { ...meek.temperament, loyalty: 0.95 } });
    expect(beaten(devoted, 9)).toEqual({ leader: 'Rex', left: [] });
  });

  it('a loyal follower who likes the leader stands by them against the same group', () => {
    expect(defects({ loyalty: 0.9, sentiment: 8, fearOfLeader: 0.5, fearOfCoalition: 0.8 })).toBe(false);
    expect(defects({ loyalty: 0.4, sentiment: 3, fearOfLeader: 0.3, fearOfCoalition: 0.8 })).toBe(true);
  });

  it('protection: someone afraid of another, fond of a strong person, follows them', () => {
    const w = watch(meek);
    w.s.update('social', (all) => ({ ...all, Di: { ...(all.Di ?? newSocialProfile('Di', meek, 0)), sentiment: 7 } }));
    w.powers.Di = 0.7;
    w.fears.Rex = 0.7;
    w.tick();
    expect(w.pw.leader()).toBe('Di');
  });
});

describe('grudges, gossip and coalitions (§17.8)', () => {
  function setup(persona = rebel, mode: 'test' | 'live' = 'test') {
    const s = world(persona, ['Rex', 'Bo', 'Cy', 'Di']);
    const bus = new AgentBus();
    const t = { now: 10_000_000 };
    const powers: Record<string, number> = { Rex: 0.6, Bo: 0.25, Cy: 0.25, Di: 0.25, Ann: 0.3 };
    const pw = new PowerWatch({ store: s, bus, logger: nullLogger(), me: persona.name, mode, powerOf: (n) => powers[n] ?? 0.3, myPower: () => 0.3, fearOf: () => 0, now: () => t.now });
    pw.start();
    return { s, bus, t, pw, powers };
  }

  it('a moment against one we resent, with others who resent them too, is told once (the CC wakes for it, mid-task too)', () => {
    const s = world(rebel, ['Rex', 'Bo', 'Cy']);
    const bus = new AgentBus();
    const t = { now: 10_000_000 };
    const resent: Record<string, number> = { Rex: 0.7, Cy: 0.6 };
    const pw = new PowerWatch({ store: s, bus, logger: nullLogger(), me: rebel.name, mode: 'test', powerOf: () => 0.3, myPower: () => 0.3, fearOf: () => 0, resentmentOf: (n) => resent[n] ?? 0, now: () => t.now });
    const told: string[] = [];
    bus.on('opening', (e) => told.push(e.name));
    const tick = () => (pw as unknown as { tick(): void }).tick();
    s.update('social', (all) => ({ ...all, Bo: { ...(all.Bo ?? newSocialProfile('Bo', rebel, 0)), trust: 0.7 } }));
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 14), ent('Cy', 30), ent('Bo', 3)] }));
    tick();
    expect(told).toEqual([]); // nobody we know of resents Rex too
    s.update('heardOpinions', () => [{ speaker: 'Bo', target: 'Rex', valence: -0.7, ts: t.now }]);
    tick();
    expect(told).toEqual([]); // alone for a moment is not yet alone
    t.now += 4000;
    tick();
    tick();
    expect(told).toEqual(['Rex']); // once; Cy we resent, but nobody else does
    t.now += 2 * 60_000;
    tick();
    expect(told).toEqual(['Rex', 'Rex']);
    // Not one we hardly resent, nor while he has company.
    resent.Rex = 0.3;
    t.now += 2 * 60_000;
    tick();
    resent.Rex = 0.7;
    s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 14), ent('Cy', 16), ent('Bo', 3)] }));
    t.now += 2 * 60_000;
    tick();
    expect(told).toEqual(['Rex', 'Rex']);
  });

  it('knows who resents whom: what they said, the wrongs seen done to them, the demands overheard', () => {
    const w = setup();
    w.s.update('heardOpinions', () => [{ speaker: 'Bo', target: 'Rex', valence: -0.7, ts: w.t.now }]);
    w.bus.emit({ type: 'observedAction', action: { id: 'a1', actor: 'Rex', kind: 'attack', target: 'Cy', ts: w.t.now } });
    w.bus.emit({ type: 'heard', utterance: { id: 'u1', convId: 'c1', from: 'Rex', to: ['Di'], text: 'give me 5 logs or else', ts: w.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    expect(w.pw.knownResenters('Rex').sort()).toEqual(['Bo', 'Cy', 'Di']);
    // An hour later it's old news.
    w.t.now += 61 * 60_000;
    expect(w.pw.knownResenters('Rex')).toEqual([]);
    // Overheard, a demand is made of whomever it names first.
    w.bus.emit({ type: 'heard', utterance: { id: 'u2', convId: '', from: 'Rex', to: 'nearby', text: 'Cy, give me 3 bread, or else', ts: w.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    expect(w.pw.knownResenters('Rex')).toEqual(['Cy']);
    w.pw.stop();
  });

  it('weighs the coalition: the trusted who resent Rex, against Rex and followers (× 1.3 in live); alone or hurt is an opening', () => {
    const w = setup();
    w.s.update('heardOpinions', () => [
      { speaker: 'Bo', target: 'Rex', valence: -0.7, ts: w.t.now },
      { speaker: 'Cy', target: 'Rex', valence: -0.7, ts: w.t.now },
    ]);
    w.s.update('social', (all) => ({ ...all, Bo: { ...(all.Bo ?? newSocialProfile('Bo', rebel, 0)), trust: 0.7 }, Cy: { ...(all.Cy ?? newSocialProfile('Cy', rebel, 0)), trust: 0.2 }, Rex: { ...(all.Rex ?? newSocialProfile('Rex', rebel, 0)), followersSeen: 2 } }));
    const c = w.pw.coalition('Rex');
    expect(c.members).toEqual(['Bo']); // Cy isn't trusted enough
    expect(c.power).toBeCloseTo(0.55);
    expect(c.against).toBeCloseTo(0.6 + 2 * FOLLOWER_WEIGHT);
    expect(c.opening).toBe(false); // not in sight
    w.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 14), ent('Bo', 3)] }));
    expect(w.pw.coalition('Rex').opening).toBe(false); // in sight, nobody but us near Rex: for a moment, not yet
    w.t.now += 4000;
    expect(w.pw.coalition('Rex').opening).toBe(true); // seen alone a while
    // The moment lasts a while (time to call on the others), then it's gone while Rex has company.
    w.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 14), ent('Di', 16)] }));
    expect(w.pw.coalition('Rex').opening).toBe(true);
    w.t.now += 2 * 60_000;
    expect(w.pw.coalition('Rex').opening).toBe(false);
    w.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 14, { hurtRecently: true }), ent('Di', 16)] }));
    expect(w.pw.coalition('Rex').opening).toBe(true);
    // Hurt by one of us, in a fight he's winning, is no weakness of his; hurt by something else is.
    w.t.now += 2 * 60_000;
    w.bus.emit({ type: 'observedAction', action: { id: 'a9', actor: 'Bo', kind: 'attack', target: 'Rex', ts: w.t.now } });
    expect(w.pw.coalition('Rex').members).toContain('Bo');
    expect(w.pw.coalition('Rex').opening).toBe(false);
    w.t.now += 6000;
    expect(w.pw.coalition('Rex').opening).toBe(true);
    const live = setup(rebel, 'live');
    live.s.update('social', (all) => ({ ...all, Rex: { ...(all.Rex ?? newSocialProfile('Rex', rebel, 0)), followersSeen: 2 } }));
    expect(live.pw.coalition('Rex').against).toBeCloseTo((0.6 + 2 * FOLLOWER_WEIGHT) * LIVE_MARGIN);
    w.pw.stop();
    live.pw.stop();
  });

  it('calls on the most wronged first; blows a beating apart count once', () => {
    const w = setup();
    w.s.update('social', (all) => ({ ...all, ...Object.fromEntries(['Bo', 'Cy', 'Di'].map((n) => [n, { ...(all[n] ?? newSocialProfile(n, rebel, 0)), trust: 0.7 }])) }));
    const blow = (target: string) => w.bus.emit({ type: 'observedAction', action: { id: `a${w.t.now}${target}`, actor: 'Rex', kind: 'attack', target, ts: w.t.now } });
    // Cy is beaten once (three blows in a row), Di twice, a minute apart; Bo once, last.
    for (let i = 0; i < 3; i++) {
      blow('Cy');
      w.t.now += 1000;
    }
    blow('Di');
    w.t.now += 60_000;
    blow('Di');
    w.t.now += 1000;
    blow('Bo');
    expect([w.pw.wrongsSeen('Cy', 'Rex'), w.pw.wrongsSeen('Di', 'Rex'), w.pw.wrongsSeen('Bo', 'Rex')]).toEqual([1, 2, 1]);
    expect(w.pw.coalition('Rex').members[0]).toBe('Di');
    // An hour on, it's old news.
    w.t.now += 61 * 60_000;
    expect(w.pw.wrongsSeen('Di', 'Rex')).toBe(0);
    w.pw.stop();
  });

  it('counts on those who have not given in to Rex since they stood up to him, and those who stood up to him last come first', () => {
    const w = setup();
    w.s.update('social', (all) => ({ ...all, ...Object.fromEntries(['Bo', 'Cy', 'Di'].map((n) => [n, { ...(all[n] ?? newSocialProfile(n, rebel, 0)), trust: 0.7 }])) }));
    const say = (from: string, text: string) =>
      w.bus.emit({ type: 'heard', utterance: { id: `u${w.t.now}${from}`, convId: '', from, to: 'nearby', text, ts: w.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    say('Rex', 'Bo, give me 3 bread, or else');
    say('Bo', "Rex, fine. I'll give you 3 bread");
    w.t.now += 1000;
    say('Rex', 'Cy, give me 3 bread, or else');
    say('Cy', 'get lost.');
    w.t.now += 1000;
    say('Rex', 'Di, give me 8 logs, or else');
    say('Di', 'leave me alone.');
    expect(w.pw.believedWilling('Bo', 'Rex')).toBe(false);
    expect(w.pw.coalition('Rex').members).toEqual(['Di', 'Cy']);
    // Bo speaking out against Rex since: the fear has lifted.
    w.t.now += 1000;
    w.s.update('heardOpinions', (o) => [...o, { speaker: 'Bo', target: 'Rex', valence: -0.7, ts: w.t.now }]);
    expect(w.pw.believedWilling('Bo', 'Rex')).toBe(true);
    // Cy striking Rex: the last to stand up to him.
    w.t.now += 1000;
    w.bus.emit({ type: 'observedAction', action: { id: 'a1', actor: 'Cy', kind: 'attack', target: 'Rex', ts: w.t.now } });
    expect(w.pw.coalition('Rex').members).toEqual(['Cy', 'Di', 'Bo']);
    // A line long after a demand is no answer to it.
    say('Rex', 'Di, give me 8 logs, or else');
    w.t.now += 2 * 60_000;
    say('Di', "fine, I'll give you some");
    expect(w.pw.believedWilling('Di', 'Rex')).toBe(true);
    w.pw.stop();
  });

  it('proposes an uprising only when ambitious, vengeful or loyal enough, with someone to ask, and the odds or the moment right', () => {
    const base = { resentment: 0.6, ambition: 0.2, vengefulness: 0.8, loyalty: 0.3, members: 1, power: 0.5, against: 0.9, opening: true };
    expect(mayRally(base)).toBe(true);
    expect(mayRally({ ...base, opening: false })).toBe(false);
    expect(mayRally({ ...base, opening: false, power: 1 })).toBe(true);
    expect(mayRally({ ...base, vengefulness: 0.4 })).toBe(false);
    expect(mayRally({ ...base, members: 0 })).toBe(false);
    expect(mayRally({ ...base, resentment: 0.4 })).toBe(false);
    expect(joinsRally({ resentment: 0.5, trust: 0.6, fear: 0.6, followsTarget: false })).toBe(true);
    expect(joinsRally({ resentment: 0.5, trust: 0.6, fear: 0.9, followsTarget: false })).toBe(false);
    expect(joinsRally({ resentment: 0.5, trust: 0.3, fear: 0.2, followsTarget: false })).toBe(false);
    expect(joinsRally({ resentment: 0.9, trust: 0.9, fear: 0.1, followsTarget: true })).toBe(false);
  });

  it('steps in for a friend, unless the one attacking frightens us too much; a follower stands by its leader all the same', () => {
    expect(defendsAlly({ liking: 8, fearOfAttacker: 0.5, leader: false })).toBe(true);
    // The timid stay out of it when the tyrant is the one attacking.
    expect(defendsAlly({ liking: 8, fearOfAttacker: 0.95, leader: false })).toBe(false);
    expect(defendsAlly({ liking: 6, fearOfAttacker: 0, leader: false })).toBe(false);
    expect(defendsAlly({ liking: 3, fearOfAttacker: 0.95, leader: true })).toBe(true);
  });

  it('reads calls to rise and promises to join them, about people we know', () => {
    const known = ['Rex', 'Bo'];
    expect(parseRally("Rex has pushed us around long enough. let's deal with Rex together.", known)).toBe('Rex');
    expect(parseRally('we should take down rex', known)).toBe('Rex');
    expect(parseRally('join me against Rex!', known)).toBe('Rex');
    expect(parseRally("let's deal with the zombies", known)).toBeNull();
    expect(parseRally("let's go mining", known)).toBeNull();
    expect(parseFightPromise("fine. I'll fight Rex with you.", known)).toBe('Rex');
    expect(parseFightPromise('count me in against Rex', known)).toBe('Rex');
    expect(parseFightPromise("I'll bring you 8 logs", known)).toBeNull();
    expect(codePromises(["fine. I'll fight Rex with you."], known).promises[0]?.what).toMatchObject({ kind: 'fight', target: 'Rex' });
    expect(codePromises(["fine. I'll fight Rex with you."]).promises[0]?.what.kind).toBe('custom');
  });
});

describe('the code default for power (§17.7, §17.8)', () => {
  const never2 = (_k: string, _a: Record<string, unknown>) => false;
  function ctx(o: Partial<PowerMoveCtx> & { leader?: string | null; members?: string[]; opening?: boolean; resenters?: string[]; said?: string[]; saidAgo?: Record<string, number> } = {}): PowerMoveCtx {
    const power: PowerView = {
      leader: () => o.leader ?? null,
      coalition: (target) => ({ target, members: o.members ?? ['Bo'], power: 0.55, against: 1.1, opening: o.opening ?? false }),
      knownResenters: () => o.resenters ?? [],
      saidLately: (stance, to, within = 10 * 60_000) => (o.said ?? []).includes(`${stance}:${to}`) || (o.saidAgo?.[`${stance}:${to}`] ?? Infinity) < within,
    };
    return {
      isStuck: o.isStuck ?? never2,
      power,
      resentmentOf: o.resentmentOf ?? ((n) => (n === 'Rex' ? 0.7 : 0)),
      mayBrawl: o.mayBrawl ?? never,
      mayKill: o.mayKill ?? never,
      ...(o.mayJoin ? { mayJoin: o.mayJoin } : {}),
      liking: o.liking ?? ((n) => (n === 'Rex' ? 2 : 7)),
      candidates: o.candidates ?? ['Bo'],
      roll: o.roll ?? 0.9,
    };
  }
  const state = (people: SeenEntity[], commitments: Commitment[] = []): AgentState => {
    const s = world(rebel, ['Rex', 'Bo', 'Cy']).state;
    return { ...s, perception: { ...s.perception, nearbyEntities: people }, commitments };
  };

  it('a follower keeps close to the leader', () => {
    expect(escortMove(state([ent('Rex', 20)]), ctx({ leader: 'Rex' }))).toMatchObject({ option: 'follow', target: { agent: 'Rex' } });
    expect(escortMove(state([ent('Rex', 5)]), ctx({ leader: 'Rex' }))).toBeNull();
    // Seen with him (within 6) is by him: one 7 blocks off goes back to his side.
    expect(escortMove(state([ent('Rex', 7)]), ctx({ leader: 'Rex' }))).toMatchObject({ option: 'follow', target: { agent: 'Rex' } });
    expect(escortMove(state([ent('Rex', 20)]), ctx())).toBeNull();
  });

  it('grumbles to a friend out of earshot of the one resented; a shared grudge is said as one', () => {
    const shared = gossipMove(state([ent('Bo', 3)]), ctx({ resenters: ['Bo'] }));
    expect(shared).toMatchObject({ option: 'talk', target: { agent: 'Bo' }, speechIntent: { stance: 'inform' } });
    expect(shared?.speechIntent?.gist).toBe("Rex wronged you too. Rex is a bully, I can't stand Rex.");
    // Not when Rex can hear it, not twice in a row, and grumbling without a shared grudge only sometimes.
    expect(gossipMove(state([ent('Bo', 3), ent('Rex', 8)]), ctx({ resenters: ['Bo'] }))).toBeNull();
    expect(gossipMove(state([ent('Bo', 3)]), ctx({ resenters: ['Bo'], said: ['inform:Bo'] }))).toBeNull();
    expect(gossipMove(state([ent('Bo', 3)]), ctx({ roll: 0.9 }))).toBeNull();
    expect(gossipMove(state([ent('Bo', 3)]), ctx({ roll: 0.1 }))?.speechIntent?.gist).toBe("Rex is a bully. I can't stand Rex.");
  });

  it('rallies one who resents Rex too when Rex is alone or hurt', () => {
    const s = state([ent('Bo', 3), ent('Rex', 30)]);
    expect(rallyMove(s, ctx({ opening: false }))).toBeNull();
    const r = rallyMove(s, ctx({ opening: true }));
    expect(r).toMatchObject({ option: 'recruit', target: { agent: 'Bo' }, speechIntent: { stance: 'rally', mayCommit: false } });
    expect(parseRally(r?.speechIntent?.gist ?? '', ['Rex'])).toBe('Rex');
    // Not against our own leader, not again soon, not once sworn already.
    expect(rallyMove(s, ctx({ opening: true, leader: 'Rex' }))).toBeNull();
    expect(rallyMove(s, ctx({ opening: true, said: ['rally:Bo'] }))).toBeNull();
    expect(rallyMove({ ...s, commitments: [pact('Bo', 'Ann', 'Rex')] }, ctx({ opening: true }))).toBeNull();
    // Called on three minutes ago, to no end: when the moment comes (Rex alone or hurt), Bo is called on again.
    expect(rallyMove(s, ctx({ opening: false, members: ['Bo'], saidAgo: { 'rally:Bo': 3 * 60_000 } }))).toBeNull();
    expect(rallyMove(s, ctx({ opening: true, saidAgo: { 'rally:Bo': 3 * 60_000 } }))?.target).toEqual({ agent: 'Bo' });
    expect(rallyMove(s, ctx({ opening: true, saidAgo: { 'rally:Bo': 60_000 } }))).toBeNull();
  });

  it('the moment against Rex is worth stopping work for, and comes before warning him off', () => {
    const s = state([ent('Bo', 3), ent('Rex', 6)]);
    const conflict: ConflictView = { rungOf: (n) => (n === 'Rex' ? 1 : 0), fearOf: () => 0.3, mayBrawl: never, resentmentOf: (n) => (n === 'Rex' ? 0.7 : 0), warnedLately: never };
    const social = { candidates: ['Bo'], roll: 0.9, conflict, power: ctx({ opening: true }).power };
    expect(codeDecision(s, { opening: 'Rex', urgent: true }, true, never2, social)).toMatchObject({ option: 'recruit', target: { agent: 'Bo' } });
    expect(codeDecision(s, { urgent: true }, true, never2, social)).toBeNull();
    expect(codeDecision(s, { opening: 'Rex' }, false, never2, social)).toMatchObject({ option: 'recruit', target: { agent: 'Bo' } });
    expect(codeDecision(s, {}, false, never2, social)?.option).not.toBe('recruit');
  });

  it('answers a call to rise: joins (a promise to fight together) or stays out', () => {
    const s = world(rebel, ['Rex', 'Bo']).state;
    const heard: AgentState = {
      ...s,
      perception: { ...s.perception, heardSpeech: [{ id: 'u1', convId: 'c1', from: 'Bo', to: ['Ann'], text: "Rex has pushed us around long enough. let's deal with Rex together.", ts: 1, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true }] },
    };
    const view = (res: number, fear: number): ConflictView => ({ rungOf: () => 0, fearOf: () => fear, mayBrawl: never, resentmentOf: (n) => (n === 'Rex' ? res : 0), warnedLately: never });
    const yes = codeDecision(heard, { from: 'Bo', convId: 'c1' }, false, never, { candidates: [], roll: 1, conflict: view(0.6, 0.4) });
    expect(yes?.speechIntent).toMatchObject({ stance: 'agree', gist: "fine. I'll fight Rex with you.", mayCommit: true });
    expect(yes?.commitmentsToCreate?.[0]).toMatchObject({ debtor: 'Ann', creditor: 'Bo', what: { kind: 'fight', target: 'Rex' } });
    const scared = codeDecision(heard, { from: 'Bo', convId: 'c1' }, false, never, { candidates: [], roll: 1, conflict: view(0.6, 0.95) });
    expect(scared?.speechIntent?.stance).toBe('decline');
    const loyal = codeDecision(heard, { from: 'Bo', convId: 'c1' }, false, never, {
      candidates: [],
      roll: 1,
      conflict: view(0.6, 0.4),
      power: { leader: () => 'Rex', coalition: (t) => ({ target: t, members: [], power: 0, against: 1, opening: false }), knownResenters: () => [], saidLately: () => false },
    });
    expect(loyal?.speechIntent?.gist).toBe('no. Rex looks after me');
  });

  it('carries out the uprising: meet up, find Rex, set upon Rex together once the gate allows it', () => {
    const sworn = [pact('Bo', 'Ann', 'Rex')];
    // Bo is far: go to Bo first.
    expect(uprisingMove(state([ent('Bo', 30)], sworn), ctx())).toMatchObject({ option: 'follow', target: { agent: 'Bo' } });
    // Bo out of sight, last seen somewhere: go there.
    const s0 = state([], sworn);
    const s1 = { ...s0, social: { ...s0.social, Bo: { ...(s0.social.Bo ?? newSocialProfile('Bo', rebel, 0)), lastSeenPos: { x: 50, y: 0, z: 5 } } } };
    expect(uprisingMove(s1, ctx())?.task).toEqual({ skill: 'goTo', args: { x: 50, y: 0, z: 5, range: 3 } });
    // Together, Rex out of sight: go where Rex was last seen.
    const s2 = { ...state([ent('Bo', 3)], sworn) };
    const s3 = { ...s2, social: { ...s2.social, Rex: { ...(s2.social.Rex ?? newSocialProfile('Rex', rebel, 0)), lastSeenPos: { x: -20, y: 0, z: 9 } } } };
    expect(uprisingMove(s3, ctx())?.rationale).toMatch(/looking for Rex with Bo/);
    // Rex in sight with Bo at hand: the gate says not yet → close in; then a brawl alongside Bo; at rung 4, to the death.
    const s4 = state([ent('Bo', 3), ent('Rex', 12)], sworn);
    expect(uprisingMove(s4, ctx())).toMatchObject({ option: 'follow', target: { agent: 'Rex' } });
    const brawl = uprisingMove(s4, ctx({ mayBrawl: () => true }));
    expect(brawl).toMatchObject({ option: 'fight', fight: { target: 'Rex', intent: 'brawl', withAllies: ['Bo'] }, speechIntent: { stance: 'threaten' } });
    expect(brawl?.task?.args.lethal).toBeUndefined();
    const kill = uprisingMove(s4, ctx({ mayKill: () => true }));
    expect(kill?.task?.args).toMatchObject({ target: 'Rex', lethal: true, spareChance: Math.round(spareChance(0.5, 0.7, 4) * 100) / 100 });
    // Bo already at it with Rex: we join in, though our own gate (the pair cooldown) is still shut.
    const join = uprisingMove(s4, ctx({ mayJoin: () => true }));
    expect(join).toMatchObject({ option: 'fight', fight: { target: 'Rex', intent: 'brawl', withAllies: ['Bo'], joining: true } });
    expect(brawl?.fight?.joining).toBeUndefined();
    // No pact, nothing to do.
    expect(uprisingMove(state([ent('Rex', 12)]), ctx())).toBeNull();
  });

  it('a fight joined is put to the gate as joining; any other is not', () => {
    const seen: boolean[] = [];
    const env = {
      me: 'Ann',
      isStuck: () => false,
      canPerceive: () => true,
      isPerson: (n: string) => n === 'Rex',
      mayFight: (_t: string, _intent: 'brawl' | 'lethal', joining?: boolean) => {
        seen.push(joining === true);
        return joining ? null : 'fought them too recently';
      },
    };
    const base = { option: 'fight' as const, terminate: { maxSeconds: 60 }, rationale: 'r' };
    expect(validateDecision({ ...base, fight: { target: 'Rex', intent: 'brawl', withAllies: ['Bo'], joining: true } }, env)).toBeNull();
    expect(validateDecision({ ...base, fight: { target: 'Rex', intent: 'brawl', withAllies: ['Bo'] } }, env)).toMatch(/fought them too recently/);
    expect(seen).toEqual([true, false]);
  });

  it('in the CC: busy with work when Rex comes near with Bo at hand, the sworn fight comes first', () => {
    const s = state([ent('Bo', 3), ent('Rex', 12)], [pact('Bo', 'Ann', 'Rex')]);
    const conflict: ConflictView = { rungOf: () => 3, fearOf: () => 0.2, mayBrawl: () => true, mayKill: never, resentmentOf: () => 0.7, warnedLately: never };
    const power: PowerView = { leader: () => null, coalition: (t) => ({ target: t, members: ['Bo'], power: 0.55, against: 1, opening: false }), knownResenters: () => ['Bo'], saidLately: () => false };
    const d = codeDecision(s, { atOdds: 'Rex' }, true, never, { candidates: ['Bo'], roll: 0.9, conflict, power });
    expect(d?.fight).toMatchObject({ target: 'Rex', withAllies: ['Bo'] });
  });

  it('strikes when one sworn with us does: the "now!" is against whom it names, and only from one sworn with us', () => {
    expect(NOW_RE.exec("now! we've had enough of you, Rex")?.[1]).toBe('Rex');
    expect(NOW_RE.exec('Rex, give me 3 bread, or else')).toBeNull();
    const pacts = [pact('Bo', 'Ann', 'Rex')];
    expect(swornWith(pacts, 'Ann', 'Bo', 'Rex')).toBe(true);
    expect(swornWith(pacts, 'Bo', 'Ann', 'Rex')).toBe(true);
    expect(swornWith(pacts, 'Ann', 'Cy', 'Rex')).toBe(false);
    expect(swornWith(pacts, 'Ann', 'Bo', 'Tib')).toBe(false);
    expect(swornWith([pact('Bo', 'Ann', 'Rex', 'fulfilled')], 'Ann', 'Bo', 'Rex')).toBe(false);
  });
});

describe('the evaluator with power (§17.6, §17.8)', () => {
  function evaluator(persona = rebel) {
    const s = world(persona, ['Rex', 'Bo']);
    const bus = new AgentBus();
    const t = { now: 10_000_000 };
    const w = WorldConfigSchema.parse({ conflict: { newcomerGraceSec: 0 } });
    const ce = new ConflictEvaluator({ store: s, bus, logger: nullLogger(), me: persona.name, config: w.conflict, mode: 'test', myGear: () => 0.1, bornAt: 0, rng: () => 0.5, now: () => t.now });
    s.update('social', (all) => ({ ...all, Rex: { ...(all.Rex ?? newSocialProfile('Rex', persona, 0)), gearScore: 0.9, estCombat: 0.8, fightsWonSeen: 3 }, Bo: { ...(all.Bo ?? newSocialProfile('Bo', persona, 0)), gearScore: 0.4 } }));
    ce.start();
    return { s, bus, t, ce };
  }

  it('fear of Rex faced together with others is smaller than alone', () => {
    const e = evaluator();
    expect(e.ce.fearWith('Rex', ['Bo'])).toBeLessThan(e.ce.fearWith('Rex', []));
    expect(e.ce.fearWith('Rex', ['Bo', 'Ann'])).toBeCloseTo(e.ce.fearWith('Rex', ['Bo']));
    e.ce.stop();
  });

  it('those sworn to take Rex on, at hand, shrink the fear of Rex and are the moment to act', () => {
    const e = evaluator();
    e.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 8), ent('Bo', 3)] }));
    const alone = e.ce.pressureOf('Rex');
    e.s.update('commitments', () => [pact('Bo', 'Ann', 'Rex')]);
    expect(e.ce.swornAgainst('Rex')).toEqual(['Bo']);
    const together = e.ce.pressureOf('Rex');
    expect(together.fear).toBeLessThan(alone.fear);
    expect(together.motive).toBeCloseTo(alone.motive + 0.3);
    expect(together.pressure).toBeGreaterThan(alone.pressure + 0.3);
    expect(e.ce.powerOfName('Rex')).toBeGreaterThan(e.ce.powerOfName('Bo'));
    e.ce.stop();
  });

  it('joins a fight a sworn ally is in with them just now, whatever the pair cooldown; not one that is not going on', () => {
    const e = evaluator(tyrant);
    e.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Rex', 3), ent('Bo', 3)] }));
    e.s.update('conflict', (c) => ({ ...c, rungs: { Rex: 3 }, pairCooldownUntil: { Rex: e.t.now + 60_000 } }));
    e.s.update('social', (all) => ({ ...all, Rex: { ...(all.Rex ?? newSocialProfile('Rex', tyrant, 0)), gearScore: 0, estCombat: 0.2, fightsWonSeen: 0, sentiment: 0 } }));
    for (let i = 0; i < 4; i++) e.bus.emit({ type: 'attacked', by: 'Rex', damage: 8 });
    expect(e.ce.mayFight('Rex', 'brawl')).toBe('fought them too recently');
    // Sworn with Bo against Rex, but no fight going on: still held back.
    e.s.update('commitments', () => [pact('Bo', tyrant.name, 'Rex')]);
    expect(e.ce.allyInFightWith('Rex')).toBe(false);
    expect(e.ce.mayFight('Rex', 'brawl', { joining: true })).toBe('fought them too recently');
    // Bo strikes Rex: joining it isn't held back by the cooldown; nor is it when Rex strikes Bo.
    e.s.update('perception', (p) => ({ ...p, observedActions: [{ id: 'o1', actor: 'Bo', kind: 'attack', target: 'Rex', ts: e.t.now - 1000 }] }));
    expect(e.ce.allyInFightWith('Rex')).toBe(true);
    expect(e.ce.mayFight('Rex', 'brawl', { joining: true })).toBeNull();
    expect(e.ce.mayFight('Rex', 'brawl')).toBe('fought them too recently');
    e.s.update('perception', (p) => ({ ...p, observedActions: [{ id: 'o2', actor: 'Rex', kind: 'attack', target: 'Bo', ts: e.t.now - 1000 }] }));
    expect(e.ce.mayFight('Rex', 'brawl', { joining: true })).toBeNull();
    // Someone not sworn with us at it with Rex is not our fight to join.
    e.s.update('perception', (p) => ({ ...p, observedActions: [{ id: 'o3', actor: 'Cy', kind: 'attack', target: 'Rex', ts: e.t.now - 1000 }] }));
    expect(e.ce.mayFight('Rex', 'brawl', { joining: true })).toBe('fought them too recently');
    // A while after, it's over.
    e.s.update('perception', (p) => ({ ...p, observedActions: [{ id: 'o1', actor: 'Bo', kind: 'attack', target: 'Rex', ts: e.t.now - 1000 }] }));
    e.t.now += 10_000;
    expect(e.ce.mayFight('Rex', 'brawl', { joining: true })).toBe('fought them too recently');
    e.ce.stop();
  });

  it('no new brawl with someone who just gave up; only a fight to the death ignores it', () => {
    const e = evaluator(tyrant);
    e.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Bo', 3)] }));
    e.s.update('conflict', (c) => ({ ...c, rungs: { Bo: 4 } }));
    e.s.update('social', (all) => ({ ...all, Bo: { ...(all.Bo ?? newSocialProfile('Bo', tyrant, 0)), gearScore: 0, sentiment: 0 } }));
    for (let i = 0; i < 4; i++) e.bus.emit({ type: 'attacked', by: 'Bo', damage: 8 });
    expect(e.ce.mayFight('Bo', 'brawl')).toBeNull();
    e.bus.emit({ type: 'heard', utterance: { id: 'y1', convId: 'c1', from: 'Bo', to: 'nearby', text: 'ok ok, I yield!', ts: e.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    expect(e.ce.mayFight('Bo', 'brawl')).toBe('they just gave up');
    expect(e.ce.mayFight('Bo', 'lethal')).toBeNull();
    e.t.now += 31_000;
    expect(e.ce.mayFight('Bo', 'brawl')).toBeNull();
    e.ce.stop();
  });

  it('a demand made of us with a threat is a small wrong in itself', () => {
    const e = evaluator();
    e.bus.emit({ type: 'heard', utterance: { id: 'u1', convId: 'c1', from: 'Rex', to: ['Ann'], text: 'give me 3 bread, or else', ts: e.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true } });
    e.bus.emit({ type: 'heard', utterance: { id: 'u2', convId: 'c1', from: 'Rex', to: ['Bo'], text: 'give me 3 bread, or else', ts: e.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    const g = e.s.state.social.Rex?.grievances.filter((x) => x.kind === 'coercion') ?? [];
    expect(g.map((x) => x.note)).toEqual(['Rex threatened me']);
    e.ce.stop();
  });

  it('blows on someone who gave up are a betrayal everyone who saw it holds heavily against the attacker', () => {
    const e = evaluator();
    e.bus.emit({ type: 'observedAction', action: { id: 'f1', actor: 'Rex', kind: 'attack', target: 'Bo', ts: e.t.now } });
    e.bus.emit({ type: 'heard', utterance: { id: 'u1', convId: 'c1', from: 'Bo', to: 'nearby', text: 'ok ok, I yield!', ts: e.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    // A blow in the same breath doesn't count; one five seconds on does, once.
    e.t.now += 400;
    e.bus.emit({ type: 'observedAction', action: { id: 'f2', actor: 'Rex', kind: 'attack', target: 'Bo', ts: e.t.now } });
    expect(e.s.state.social.Rex?.grievances.some((g) => g.kind === 'betrayal')).toBe(false);
    e.t.now += 5000;
    e.bus.emit({ type: 'observedAction', action: { id: 'f3', actor: 'Rex', kind: 'attack', target: 'Bo', ts: e.t.now } });
    e.bus.emit({ type: 'observedAction', action: { id: 'f4', actor: 'Rex', kind: 'attack', target: 'Bo', ts: e.t.now } });
    const b = e.s.state.social.Rex?.grievances.filter((g) => g.kind === 'betrayal') ?? [];
    expect(b).toHaveLength(1);
    expect(b[0]?.weight).toBeCloseTo(1.2);
    e.ce.stop();
  });

  it('the lethal rung opens only where maxRung allows it, and in live mode only for the vengeful or domineering', () => {
    const e = evaluator(tyrant);
    const w = WorldConfigSchema.parse({});
    expect(w.conflict.maxRung).toBe(4);
    e.s.update('conflict', (c) => ({ ...c, rungs: { Rex: 4 } }));
    e.s.update('perception', (p) => ({ ...p, nearbyEntities: [ent('Bo', 3)] }));
    for (let i = 0; i < 4; i++) e.bus.emit({ type: 'attacked', by: 'Bo', damage: 8 });
    e.s.update('social', (all) => ({ ...all, Bo: { ...(all.Bo ?? newSocialProfile('Bo', tyrant, 0)), gearScore: 0 } }));
    let r = e.ce.evaluate('Bo');
    for (let i = 0; i < 4; i++) {
      e.t.now += 16_000;
      e.bus.emit({ type: 'attacked', by: 'Bo', damage: 8 });
      r = e.ce.evaluate('Bo');
    }
    expect(r.rung).toBe(4);
    expect(e.ce.mayFight('Bo', 'lethal')).toBeNull();
    const capped = new ConflictEvaluator({ store: e.s, bus: new AgentBus(), logger: nullLogger(), me: 'Rex', config: WorldConfigSchema.parse({ conflict: { maxRung: 3, newcomerGraceSec: 0 } }).conflict, mode: 'test', myGear: () => 0.1, bornAt: 0, now: () => e.t.now });
    expect(capped.mayFight('Bo', 'lethal')).toMatch(/limited to rung 3/);
    e.ce.stop();
  });
});

describe('fight promises (§17.8) in the commitment tracker', () => {
  function tracker() {
    const s = world(rebel, ['Rex', 'Bo']);
    const bus = new AgentBus();
    const t = { now: 10_000_000 };
    const social = { promiseResolved: () => undefined } as unknown as SocialAwareness;
    const ct = new CommitmentTracker({ store: s, bus, logger: nullLogger(), llm: null, me: 'Ann', social, now: () => t.now });
    ct.start();
    return { s, bus, t, ct };
  }

  it('kept when they strike the one they swore to take on; when we do; moot if that one dies untouched; lapses unbroken', async () => {
    const k = tracker();
    k.s.update('commitments', () => [pact('Bo', 'Ann', 'Rex'), { ...pact('Ann', 'Bo', 'Rex'), id: 'mine' }, { ...pact('Bo', 'Ann', 'Cy'), id: 'cy' }, { ...pact('Bo', 'Ann', 'Di'), id: 'di', dueBy: k.t.now - 1 }]);
    k.bus.emit({ type: 'observedAction', action: { id: 'x1', actor: 'Bo', kind: 'attack', target: 'Rex', ts: k.t.now } });
    k.bus.emit({ type: 'actionRecorded', record: { id: 'r1', skill: 'duel', args: { target: 'Rex' }, expected: '', observed: 'Rex gave up', ok: true, ts: k.t.now, durationMs: 1 } });
    k.bus.emit({ type: 'peerDied', name: 'Cy', cause: 'fell', witnessed: false });
    await (k.ct as unknown as { check(): Promise<void> }).check();
    const by = (id: string) => k.s.state.commitments.find((c) => c.id === id)?.status;
    expect(by('kBoAnnRex')).toBe('fulfilled');
    expect(by('mine')).toBe('fulfilled');
    expect(by('cy')).toBe('cancelled');
    expect(by('di')).toBe('cancelled');
    k.ct.stop();
  });
});
