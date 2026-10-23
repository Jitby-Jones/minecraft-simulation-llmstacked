// M6b (§17.2–17.6, §21.3): the conflict evaluator against fakes. Grievances from what happens, pressure against
// fear, the escalation rung with hysteresis and pacing, the code gate for fights, how fights end, what the code
// default does about the people we're at odds with, and fear damping. Live: tests/live/m6b-conflict.test.ts.

import { describe, expect, it } from 'vitest';
import { PersonaSchema, WorldConfigSchema, nullLogger } from '@agora/shared';
import { AgentBus } from '@agora/agent/bus';
import { ConflictEvaluator } from '@agora/agent/conflict/evaluator';
import { EventEmitter } from 'node:events';
import { Vec3 } from '@agora/agent/body/bot';
import { CALL_OFF_RE, SURRENDER_RE, beaten, reckonBlow, runningAway, yieldAt } from '@agora/agent/body/skills/duel';
import { stopMotion } from '@agora/agent/body/skills/util';
import { type PvpTuning, keepPvpInReach } from '@agora/agent/body/plugins';
import { Feelings } from '@agora/agent/mind/feelings';
import { appraise, zeroEmotions } from '@agora/agent/mind/emotions';
import { type ConflictView, codeDecision, validateDecision } from '@agora/agent/modules/cc';
import type { Body } from '@agora/agent/body/body';
import { Conversations } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { Talking } from '@agora/agent/modules/talking';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';

const brute = PersonaSchema.parse({
  name: 'Gorm',
  sex: 'male',
  traits: ['brutal'],
  temperament: { aggression: 0.95, dominance: 0.9, vengefulness: 0.9, mercy: 0.2 },
  drives: { caution: 0.05 },
  abilities: { combat: 0.8, intelligence: 1 },
});
const mouse = PersonaSchema.parse({
  name: 'Tib',
  sex: 'female',
  traits: ['timid'],
  temperament: { aggression: 0.05, dominance: 0.05, vengefulness: 0.2 },
  drives: { caution: 0.95 },
  abilities: { combat: 0.1, intelligence: 1 },
});

function evaluator(persona = brute, config: Partial<ReturnType<typeof WorldConfigSchema.parse>['conflict']> = {}) {
  const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: 0 }));
  const bus = new AgentBus();
  const t = { now: 10_000_000 };
  const world = WorldConfigSchema.parse({ conflict: { maxRung: 3, newcomerGraceSec: 0, ...config } });
  const ce = new ConflictEvaluator({ store: s, bus, logger: nullLogger(), me: persona.name, config: world.conflict, mode: 'test', myGear: () => 0.3, bornAt: 0, rng: () => 0.5, now: () => t.now });
  s.update('self', (x) => ({ ...x, health: 20 }));
  s.update('perception', (p) => ({
    ...p,
    nearbyEntities: [{ id: 1, kind: 'player', name: 'Rex', pos: { x: 3, y: 0, z: 0 }, distance: 3, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }],
  }));
  s.update('social', (all) => ({ ...all, Rex: newSocialProfile('Rex', persona, 0) }));
  ce.start();
  return { s, bus, ce, t };
}

describe('the conflict evaluator (§17.4, §17.5)', () => {
  it('a stranger raises no pressure; wrongs and provocation do, more for a brute than a mouse', () => {
    const b = evaluator(brute);
    expect(b.ce.pressureOf('Rex').rung).toBe(0);
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 6 });
    b.bus.emit({ type: 'felt', cause: 'insulted', by: 'Rex', arousal: 0.9 });
    const hot = b.ce.pressureOf('Rex');
    expect(b.s.state.social.Rex?.grievances.map((g) => g.kind).sort()).toEqual(['attack', 'insult']);
    expect(hot.resentment).toBeGreaterThan(0.4);
    // Enough for threats (0.35), but the rung climbs one step at a time: words come first.
    expect(hot.pressure).toBeGreaterThan(0.35);
    expect(hot.rung).toBe(1);
    b.t.now += 16_000;
    expect(b.ce.evaluate('Rex').rung).toBe(2);
    const m = evaluator(mouse);
    m.bus.emit({ type: 'attacked', by: 'Rex', damage: 6 });
    m.bus.emit({ type: 'felt', cause: 'insulted', by: 'Rex', arousal: 0.9 });
    expect(m.ce.pressureOf('Rex').pressure).toBeLessThan(hot.pressure);
    expect(m.ce.pressureOf('Rex').rung).toBe(0);
  });

  it('fear of a well-armed fighter holds even a brute back', () => {
    const b = evaluator(brute);
    b.bus.emit({ type: 'felt', cause: 'insulted', by: 'Rex', arousal: 0.9 });
    const plain = b.ce.pressureOf('Rex');
    b.s.update('social', (all) => ({ ...all, Rex: { ...(all.Rex ?? newSocialProfile('Rex', brute, 0)), gearScore: 1, killsSeen: 3, estCombat: 1 } }));
    const armed = b.ce.pressureOf('Rex');
    expect(armed.fear).toBeGreaterThan(plain.fear);
    expect(armed.pressure).toBeLessThan(plain.pressure);
  });

  it('the gate lets a brawl through only after words and above the threshold, never lethal at maxRung 3, and not twice in a row', () => {
    const b = evaluator(brute);
    expect(b.ce.mayFight('Rex', 'brawl')).toMatch(/not come to that/);
    b.s.update('conflict', (c) => ({ ...c, rungs: { Rex: 2 } }));
    expect(b.ce.mayFight('Rex', 'brawl')).toMatch(/not angry enough/);
    b.s.update('conflict', (c) => ({ ...c, rungs: {} }));
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 8 });
    b.bus.emit({ type: 'felt', cause: 'insulted', by: 'Rex', arousal: 0.9 });
    b.s.update('social', (all) => ({ ...all, Rex: { ...(all.Rex ?? newSocialProfile('Rex', brute, 0)), sentiment: 1 } }));
    expect(b.ce.mayFight('Rex', 'brawl')).toMatch(/not come to that/);
    for (let i = 0; i < 3; i++) {
      b.t.now += 16_000;
      b.ce.evaluate('Rex');
    }
    expect(b.s.state.conflict.rungs.Rex).toBe(3);
    expect(b.ce.mayFight('Rex', 'brawl')).toBeNull();
    // An impulsive punch needs no words first, only the lower bar.
    expect(b.ce.mayPunch('Rex')).toBe(true);
    expect(b.ce.mayFight('Rex', 'lethal')).toMatch(/limited to rung 3/);
    b.s.update('conflict', (c) => ({ ...c, pairCooldownUntil: { Rex: b.t.now + 60_000 } }));
    expect(b.ce.mayFight('Rex', 'brawl')).toMatch(/too recently/);
    const off = evaluator(brute, { enabled: false });
    expect(off.ce.mayFight('Rex', 'brawl')).toMatch(/off here/);
  });

  it('a newcomer does not start fights during its grace period', () => {
    const b = evaluator(brute, { newcomerGraceSec: 600 });
    b.t.now = 100_000;
    b.s.update('social', (all) => ({ ...all, Rex: { ...(all.Rex ?? newSocialProfile('Rex', brute, 0)), sentiment: 0 } }));
    b.s.update('conflict', (c) => ({ ...c, rungs: { Rex: 3 } }));
    expect(b.ce.mayFight('Rex', 'brawl')).toMatch(/too new/);
  });

  it('says so when someone it is at odds with comes near, once a minute at most', () => {
    const b = evaluator(brute);
    const seen: string[] = [];
    b.bus.on('atOddsNearby', (e) => void seen.push(`${e.name}@${e.rung}`));
    const away = () => b.s.update('perception', (p) => ({ ...p, nearbyEntities: p.nearbyEntities.map((e) => ({ ...e, distance: 20 })) }));
    const close = () => b.s.update('perception', (p) => ({ ...p, nearbyEntities: p.nearbyEntities.map((e) => ({ ...e, distance: 3 })) }));
    const tick = () => (b.ce as unknown as { tick(): void }).tick();
    tick();
    expect(seen).toEqual([]); // rung 0: nothing to say
    away();
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 6 }); // out of reach when it got worse
    expect(b.s.state.conflict.rungs.Rex).toBe(1);
    tick();
    expect(seen).toEqual([]);
    close();
    tick();
    expect(seen).toEqual(['Rex@1']);
    away();
    tick();
    close();
    tick();
    expect(seen).toEqual(['Rex@1']); // not again within the minute
    b.t.now += 61_000;
    away();
    tick();
    close();
    tick();
    expect(seen).toHaveLength(2);
    // Worse since the last time: said again right away.
    away();
    tick();
    b.s.update('conflict', (c) => ({ ...c, rungs: { Rex: 3 } }));
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 8 });
    b.bus.emit({ type: 'felt', cause: 'insulted', by: 'Rex', arousal: 0.9 });
    close();
    tick();
    expect(seen.at(-1)).toBe('Rex@3');
  });

  it('the rung steps down only well below its threshold (hysteresis), and relaxes out of sight', () => {
    const b = evaluator(brute);
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 6 });
    const up = b.ce.evaluate('Rex');
    expect(up.rung).toBeGreaterThan(0);
    expect(b.s.state.conflict.rungs.Rex).toBe(up.rung);
    // Out of sight for long: the rung lets go.
    b.s.update('perception', (p) => ({ ...p, nearbyEntities: [] }));
    b.t.now += 11 * 60_000;
    (b.ce as unknown as { tick(): void }).tick();
    expect(b.s.state.conflict.rungs.Rex).toBe(0);
  });

  it('a kill announced is remembered, and killing a friend is the heaviest grievance', () => {
    const b = evaluator(brute);
    b.s.update('social', (all) => ({ ...all, Ann: { ...newSocialProfile('Ann', brute, 0), sentiment: 8 } }));
    b.bus.emit({ type: 'systemEvent', event: { kind: 'death', ts: 0, text: 'Ann was slain by Rex', subject: 'Ann', killer: 'Rex' } });
    expect(b.s.state.social.Rex?.killsSeen).toBe(1);
    expect(b.s.state.social.Rex?.grievances[0]?.kind).toBe('killed_friend');
  });
});

describe('fights end in a yield (§17.6)', () => {
  it('knows a yield when it hears one, gives up before a blow could kill, and reckons a beating only from what it sees', () => {
    for (const t of ['ok ok, I yield!', 'ok ok, I give up!', 'you win', 'mercy!', 'enough!', 'stop, please', "I'm done."]) expect(SURRENDER_RE.test(t)).toBe(true);
    for (const t of ['I will never yield to you, coward', "I won't give up", "I've had enough of you!", "that's enough. stay out of my way.", "I'm done with you"]) {
      expect(SURRENDER_RE.test(t)).toBe(false);
    }
    // Fists: our own threshold; a diamond sword (7, crits 10.5): give up at 12 so one more blow can't finish us.
    expect(yieldAt(4, undefined)).toBe(4);
    expect(yieldAt(4, 'diamond_sword')).toBe(12);
    expect(yieldAt(14, 'wooden_sword')).toBe(14);
    // Hearts aren't shown: a blow is reckoned from our weapon, their visible armor and our technique.
    expect(reckonBlow('iron_sword', [], 0.5)).toBe(6);
    expect(reckonBlow('iron_sword', ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], 0.5)).toBeCloseTo(6 * (1 - 15 / 50), 5);
    expect(reckonBlow(undefined, [], 0.1)).toBeCloseTo(0.4, 5);
    // A beating is over before a blow could kill: two of an iron sword (one more, a crit, would make 21).
    expect(beaten(6, 6)).toBe(false);
    expect(beaten(12, 6)).toBe(true);
    expect(beaten(15, 5)).toBe(true);
    expect(beaten(12, 4)).toBe(false);
  });

  it('tells someone running off from someone knocked back', () => {
    const me = { x: 0, z: 0 };
    // A second's sprint, away from us: running.
    expect(runningAway({ x: 2, z: 0 }, { x: 6, z: 0 }, me)).toBe(true);
    expect(runningAway({ x: 2, z: 1 }, { x: 5, z: 3 }, me)).toBe(true);
    // Knocked back a block: not.
    expect(runningAway({ x: 2, z: 0 }, { x: 3, z: 0 }, me)).toBe(false);
    // Circling us, or coming at us: not running away.
    expect(runningAway({ x: 3, z: 0 }, { x: 0, z: 3 }, me)).toBe(false);
    expect(runningAway({ x: 5, z: 0 }, { x: 1, z: 0 }, me)).toBe(false);
  });

  it('a fight called off is over for both, and nobody gave up', () => {
    for (const t of ["that's enough. stay out of my way.", "we're done here", "let's leave it"]) expect(CALL_OFF_RE.test(t)).toBe(true);
    for (const t of ['ok ok, I yield!', 'leave, or we fight.', "I've had enough of you!"]) expect(CALL_OFF_RE.test(t)).toBe(false);
  });

  it('records how our fight ended, cools the pair down, and teaches a little', () => {
    const b = evaluator(brute);
    b.bus.emit({ type: 'actionRecorded', record: { id: 'r', skill: 'duel', args: { target: 'Rex' }, expected: '', observed: 'Rex gave up', ok: true, ts: 0, durationMs: 1, data: { outcome: 'won' } } });
    expect(b.s.state.social.Rex?.lastFight?.outcome).toBe('won');
    expect(b.s.state.conflict.pairCooldownUntil.Rex).toBe(b.t.now + 300_000);
    expect(b.s.state.growth.combatGrowth).toBeGreaterThan(0);
    expect(b.s.state.workmem.at(-1)?.text).toBe('I beat Rex in a fight');
    // Our own fight ending settles it: their earlier blows no longer make them a threat.
    expect(b.ce.settled('Rex', b.t.now - 1000)).toBe(true);
    // Whoever else struck us meanwhile was in that fight too: it is over with them, with its cooldown.
    const g = evaluator(brute);
    g.s.update('social', (all) => ({ ...all, Bo: newSocialProfile('Bo', brute, 0) }));
    g.bus.emit({ type: 'attacked', by: 'Bo', damage: 3 });
    g.t.now += 2000;
    g.bus.emit({ type: 'actionRecorded', record: { id: 'r', skill: 'duel', args: { target: 'Rex' }, expected: '', observed: 'Rex took a beating', ok: true, ts: 0, durationMs: 1, data: { outcome: 'won' } } });
    expect(g.s.state.conflict.pairCooldownUntil.Bo).toBe(g.t.now + 300_000);
    expect(g.s.state.social.Bo?.lastFight?.outcome).toBe('interrupted');
  });

  it('a fight the reflexes fought counts too: recorded with its cooldown when the danger passes', () => {
    const b = evaluator(brute);
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 3 });
    b.ce.ownYield(); // we ran, and said so
    b.t.now += 5000;
    b.bus.emit({ type: 'dangerCleared' });
    expect(b.s.state.social.Rex?.lastFight?.outcome).toBe('yielded');
    expect(b.s.state.conflict.pairCooldownUntil.Rex).toBe(b.t.now + 300_000);
    expect(b.s.state.social.Rex?.fightsWonSeen).toBe(1);
    // Once is enough: the next danger passing doesn't count the same fight again.
    b.t.now += 5000;
    b.bus.emit({ type: 'dangerCleared' });
    expect(b.s.state.growth.combatGrowth).toBeCloseTo(0.01, 5);
    // And they gave up to us: a win.
    const w = evaluator(brute);
    w.bus.emit({ type: 'attacked', by: 'Rex', damage: 3 });
    w.bus.emit({ type: 'heard', utterance: { id: 'u', convId: '', from: 'Rex', to: 'nearby', text: 'ok ok, I give up!', ts: w.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    w.bus.emit({ type: 'dangerCleared' });
    expect(w.s.state.social.Rex?.lastFight?.outcome).toBe('won');
  });

  it('a person who just gave up is left alone until they strike again, and a fight seen won raises the winner', () => {
    const b = evaluator(brute);
    b.s.update('social', (all) => ({ ...all, Ann: newSocialProfile('Ann', brute, 0) }));
    b.s.update('perception', (p) => ({ ...p, observedActions: [{ id: 'a', actor: 'Ann', kind: 'attack', target: 'Rex', ts: b.t.now - 2000 }] }));
    b.bus.emit({ type: 'heard', utterance: { id: 'u', convId: '', from: 'Rex', to: 'nearby', text: 'ok ok, I yield!', ts: b.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    expect(b.ce.settled('Rex')).toBe(true);
    expect(b.ce.settled('Rex', b.t.now - 500)).toBe(true);
    // A blow right after the yield (a last swing) is the same fight; one a while after starts a new one.
    expect(b.ce.settled('Rex', b.t.now + 500)).toBe(true);
    expect(b.ce.settled('Rex', b.t.now + 9000)).toBe(false);
    // So does a second one, however soon: a parting blow is one.
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 2 });
    expect(b.ce.settled('Rex', b.t.now + 500)).toBe(true);
    b.bus.emit({ type: 'attacked', by: 'Rex', damage: 2 });
    expect(b.ce.settled('Rex', b.t.now + 1000)).toBe(false);
    expect(b.s.state.social.Ann?.fightsWonSeen).toBe(1);
    b.t.now += 31_000;
    expect(b.ce.settled('Rex')).toBe(false);
    // The winner calling it off settles it too, without counting as a yield.
    b.bus.emit({ type: 'heard', utterance: { id: 'v', convId: '', from: 'Ann', to: 'nearby', text: "that's enough. stay out of my way.", ts: b.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    expect(b.ce.settled('Ann')).toBe(true);
    expect(b.s.state.social.Rex?.fightsWonSeen ?? 0).toBe(0);
  });
});

describe('the gate in the CC (§17.5: the LLM proposes, code decides)', () => {
  const base = { terminate: { maxSeconds: 60 }, rationale: 'r' };
  const gate = (target: string, intent: string) => (intent === 'impulse' || target === 'Rex' ? null : 'not angry enough to fight');
  const env = (intentSeen: string[]) => ({
    me: 'Gorm',
    isStuck: () => false,
    canPerceive: () => true,
    isPerson: (n: string) => ['Rex', 'Ann'].includes(n),
    mayFight: (t: string, intent: 'brawl' | 'lethal') => {
      intentSeen.push(intent);
      return gate(t, intent);
    },
  });

  it('a fight with a person, in any form, goes through the gate; a mob does not', () => {
    const seen: string[] = [];
    const e = env(seen);
    expect(validateDecision({ ...base, option: 'fight', fight: { target: 'Ann', intent: 'brawl', withAllies: [] } }, e)).toMatch(/can't fight Ann: not angry enough/);
    expect(validateDecision({ ...base, option: 'work', task: { skill: 'attack', args: { target: 'Ann' } } }, e)).toMatch(/can't fight Ann/);
    expect(validateDecision({ ...base, option: 'work', task: { skill: 'brawl', args: { target: 'Ann' } } }, e)).toMatch(/can't fight Ann/);
    expect(validateDecision({ ...base, option: 'fight', target: { agent: 'Rex' } }, e)).toBeNull();
    expect(validateDecision({ ...base, option: 'work', task: { skill: 'attack', args: { target: 'zombie' } } }, e)).toBeNull();
    expect(validateDecision({ ...base, option: 'fight' }, e)).toMatch(/needs fight.target/);
    // Without a conflict core, nobody fights a person on purpose.
    expect(validateDecision({ ...base, option: 'fight', target: { agent: 'Rex' } }, { ...e, mayFight: undefined })).toMatch(/not possible here/);
    expect(seen).toEqual(['brawl', 'brawl', 'brawl', 'brawl']);
  });
});

describe('the code default at odds with someone (§17.5 rungs 0–3)', () => {
  const near = (name: string, distance: number) => ({ id: 7, kind: 'player' as const, name, pos: { x: distance, y: 0, z: 0 }, distance, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false });
  function state(distance = 4) {
    const s = new AgentStateStore(createInitialState({ persona: brute, username: 'Gorm', now: 0 }));
    s.update('self', (x) => ({ ...x, isDay: true, pos: { x: 0, y: 64, z: 0 } }));
    s.update('perception', (p) => ({ ...p, nearbyEntities: [near('Rex', distance)] }));
    return s.state;
  }
  const view = (rung: number, o: Partial<ConflictView> = {}): ConflictView => ({ rungOf: () => rung, fearOf: () => 0.2, mayBrawl: () => true, warnedLately: () => false, ...o });
  const never = () => false;
  const decide = (c: ConflictView, liking = 5, distance = 4) => codeDecision(state(distance), {}, false, never, { candidates: [], roll: 1, conflict: c, liking: () => liking });

  it('rung 3 and the gate open: a brawl until someone yields, at our yield health', () => {
    const d = decide(view(3));
    expect(d?.option).toBe('fight');
    expect(d?.task).toEqual({ skill: 'duel', args: { target: 'Rex', stopAtHealth: 4 } });
    expect(d?.fight).toMatchObject({ target: 'Rex', intent: 'brawl' });
  });

  it('rungs 1–2: words, now and then; the gate closed at rung 3 means a warning instead', () => {
    expect(decide(view(1))?.speechIntent?.stance).toBe('hostile');
    expect(decide(view(2))?.speechIntent?.stance).toBe('threaten');
    expect(decide(view(3, { mayBrawl: () => false }))?.speechIntent?.stance).toBe('threaten');
    expect(decide(view(2, { warnedLately: () => true }))?.task?.skill).toBe('wander');
  });

  it('rung 0: keeps away from someone feared and disliked close by, not from a friend or the far-off', () => {
    const scared = view(0, { fearOf: () => 0.8 });
    const d = decide(scared, 3);
    expect(d?.option).toBe('move');
    expect(d?.target?.agent).toBe('Rex');
    expect(d?.target?.pos?.x).toBeLessThan(0);
    expect(decide(scared, 7)?.task?.skill).toBe('wander');
    expect(decide(scared, 3, 10)?.task?.skill).toBe('wander');
  });
});

describe('fear damping (§21.3)', () => {
  const fighter = (combat: number) => PersonaSchema.parse({ name: 'Vet', sex: 'male', traits: ['steady'], big5: { neuroticism: 0.5 }, abilities: { combat } });

  it('a skilled fighter fears a blow less; a novice the most', () => {
    const hit = { kind: 'attacked' as const, damage: 6 };
    const novice = appraise(zeroEmotions(), hit, fighter(0.1), 0.1);
    const master = appraise(zeroEmotions(), hit, fighter(0.95), 0.95);
    expect(master.fear).toBeCloseTo(novice.fear * (1 - 0.6 * 0.95) / (1 - 0.6 * 0.1), 5);
    // Not combat: fighting skill doesn't help with a death.
    const death = { kind: 'peerDied' as const, sentiment: 8, nearby: true };
    expect(appraise(zeroEmotions(), death, fighter(0.95), 0.95).fear).toBe(appraise(zeroEmotions(), death, fighter(0.1), 0.1).fear);
  });

  it('in a fight, arousal stays under 1 − 0.5·combat, so the skilled keep thinking', () => {
    const run = (combat: number) => {
      const p = PersonaSchema.parse({ name: 'Vet', sex: 'male', traits: ['hot'], big5: { neuroticism: 0.5 }, temperament: { aggression: 1 }, drives: { caution: 0.5 }, abilities: { combat } });
      const s = new AgentStateStore(createInitialState({ persona: p, username: 'Vet', now: 0 }));
      const bus = new AgentBus();
      const t = { now: 1_000_000 };
      const f = new Feelings({ store: s, bus, logger: nullLogger(), me: 'Vet', tickMs: 60_000, rng: () => 0, now: () => t.now });
      f.start();
      bus.emit({ type: 'attacked', by: null, damage: 8 });
      f.stop();
      return s.state.emotions;
    };
    const vet = run(0.9);
    const novice = run(0.05);
    expect(vet.arousal).toBeLessThanOrEqual(1 - 0.5 * 0.9 + 1e-9);
    expect(novice.arousal).toBeGreaterThan(vet.arousal);
    expect(vet.fear).toBeLessThan(novice.fear);
  });
});

describe('a yield is let stand (§17.6)', () => {
  it('says nothing back to someone giving up, but answers other lines in its stance', async () => {
    const s = new AgentStateStore(createInitialState({ persona: brute, username: 'Gorm', now: 0 }));
    const bus = new AgentBus();
    const said: string[] = [];
    const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => ({ talkOverable: true }), run: () => Promise.reject(new Error('unused')) } as unknown as Body;
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Gorm', inRange: () => ['Rex'], rng: () => 0 });
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Gorm', rng: () => 0, rungOf: () => 3 });
    conversations.start();
    talking.start();
    const hear = (text: string) =>
      bus.emit({ type: 'heard', utterance: { id: `u${said.length}${text.length}`, convId: '', from: 'Rex', to: ['Gorm'], text, ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: true, heardAs: 'me' } });
    hear('ok ok, I yield!');
    await new Promise((r) => setTimeout(r, 1500));
    expect(said).toEqual([]);
    hear('you are a coward, Gorm');
    for (let i = 0; i < 40 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/back off|or else|push me|we fight/);
    talking.stop();
    conversations.stop();
  }, 10_000);

  it('the threat that opens a fight goes unsaid once the fight is over, also when a later decision went on with it', async () => {
    const s = new AgentStateStore(createInitialState({ persona: brute, username: 'Gorm', now: 0 }));
    const bus = new AgentBus();
    const said: string[] = [];
    const body = {
      say: (t: string, _v: unknown, _to: unknown, stillWanted?: () => boolean) => Promise.resolve(stillWanted && !stillWanted() ? false : said.push(t) > 0),
      skill: () => ({ talkOverable: true }),
      run: () => Promise.reject(new Error('unused')),
    } as unknown as Body;
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Gorm', inRange: () => ['Rex'], rng: () => 0 });
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Gorm', rng: () => 0, rungOf: () => 3 });
    conversations.start();
    talking.start();
    const rex = (distance: number) =>
      s.update('perception', (p) => ({ ...p, nearbyEntities: [{ id: 7, kind: 'player', name: 'Rex', pos: { x: distance, y: 0, z: 0 }, distance, visible: true, heldItem: null, armor: [], lastSeen: Date.now(), hurtRecently: false }] }), 'see');
    const fightRex = (id: string) => {
      const d = {
        id,
        createdAt: Date.now(),
        stateVersion: s.version,
        source: 'default' as const,
        option: 'fight' as const,
        target: { agent: 'Rex' },
        task: { skill: 'duel', args: { target: 'Rex' } },
        speechIntent: { stance: 'threaten' as const, gist: "now! we've had enough of you, Rex", mayCommit: false },
        terminate: { maxSeconds: 90 },
        rationale: 'test',
      };
      s.set('decision', d, 'decided');
      bus.emit({ type: 'decision', decision: d });
    };
    // The fight started by d1 is on; d2 goes on with it, its line waiting for Rex to come near. The fight ends first.
    s.set('option', { decisionId: 'd1', option: 'fight', startedAt: Date.now(), maxSeconds: 90, targetAgent: 'Rex', skill: 'duel', args: { target: 'Rex' }, status: 'running' }, 'fighting');
    rex(20);
    fightRex('d2');
    await new Promise((r) => setTimeout(r, 300));
    s.update('option', (o) => (o ? { ...o, status: 'succeeded' } : o), 'gave up');
    rex(3);
    await new Promise((r) => setTimeout(r, 1500));
    expect(said).toEqual([]);
    // While a fight is on, the threat is said.
    s.set('option', { decisionId: 'd3', option: 'fight', startedAt: Date.now(), maxSeconds: 90, targetAgent: 'Rex', skill: 'duel', args: { target: 'Rex' }, status: 'running' }, 'fighting');
    fightRex('d3');
    for (let i = 0; i < 40 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(said).toEqual(["now! we've had enough of you, Rex"]);
    talking.stop();
    conversations.stop();
  }, 10_000);
});

describe('staying within reach in a fight', () => {
  type Goal = { entity?: unknown; x?: number; y?: number; z?: number } | null;
  const fake = () => {
    const calls: string[] = [];
    let moving = false;
    let goal: Goal = null;
    const bot = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0, -60, 0) },
      pathfinder: {
        isMoving: () => moving,
        get goal() {
          return goal;
        },
        stop: () => void calls.push('stop'),
        setGoal: (g: Goal) => {
          goal = g;
          calls.push(g ? `follow ${g.x},${g.z}` : 'clear');
        },
      },
      clearControlStates: () => void calls.push('controls'),
    });
    return { bot, calls, move: (m: boolean) => (moving = m), aim: (g: Goal) => (goal = g) };
  };

  it("stopping an idle pathfinder clears its goal, so the stop can't wipe the next one", () => {
    const f = fake();
    stopMotion(f.bot as never);
    expect(f.calls).toEqual(['clear', 'controls']);
    f.calls.length = 0;
    f.move(true);
    stopMotion(f.bot as never);
    expect(f.calls).toEqual(['stop', 'controls']);
  });

  it('a fighter out of reach and standing still aims again at where the target is now, once a second at most', () => {
    const f = fake();
    const target = { position: new Vec3(3.5, -60, 0.5) };
    const pvp: PvpTuning = { target: target as never, attackRange: 3, followRange: 1, movements: {} as never };
    keepPvpInReach(f.bot as never, pvp);
    const tick = () => f.bot.emit('physicsTick');
    tick();
    expect(f.calls).toEqual(['follow 3,0']);
    // Aimed right, but no way there: left alone (no search every second).
    f.calls.length = 0;
    tick();
    expect(f.calls).toEqual([]);
  });

  it('leaves a fighter alone within reach, on the move, or without a target', async () => {
    const f = fake();
    const target = { position: new Vec3(2.5, -60, 0.5) };
    const pvp: PvpTuning = { target: target as never, attackRange: 3, followRange: 1, movements: {} as never };
    keepPvpInReach(f.bot as never, pvp);
    f.bot.emit('physicsTick');
    expect(f.calls).toEqual([]);
    // A goal that went stale (the target stepped away from where it was seen), but we're walking: no re-aim.
    target.position = new Vec3(6.5, -60, 0.5);
    f.aim({ entity: target, x: 2, y: -60, z: 0 });
    f.move(true);
    await new Promise((r) => setTimeout(r, 1010));
    f.bot.emit('physicsTick');
    expect(f.calls).toEqual([]);
    // Standing still with that stale goal: re-aimed.
    f.move(false);
    await new Promise((r) => setTimeout(r, 1010));
    f.bot.emit('physicsTick');
    expect(f.calls).toEqual(['follow 6,0']);
    pvp.target = undefined;
    f.calls.length = 0;
    await new Promise((r) => setTimeout(r, 1010));
    f.bot.emit('physicsTick');
    expect(f.calls).toEqual([]);
  });
});
