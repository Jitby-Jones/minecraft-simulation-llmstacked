// M9b (§19.3–19.5): reproduction and families without Minecraft. A child's persona from its parents' (scenario T's
// "traits within the parents' ranges ± noise"), the family watch (the gates each partner checks for itself, the
// question, the bed ritual, a child known by its greeting, parents keeping a young child close, feeding it and warning
// it), the code default's family steps, a young one taking its parents' word for people (scenario U), birth facts,
// and youth (no fighting). The Hub's side is in tests/hub/births.test.ts; live T and U in tests/live/m9b-family.test.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  type BirthFacts,
  type DecisionOutput,
  GAME_DAY_MS,
  NUMERIC_TRAIT_KEYS,
  type Persona,
  PersonaSchema,
  SeededRandom,
  WorldConfigSchema,
  getTrait,
  inheritPersona,
  isValidUsername,
  nullLogger,
  perceivedPersona,
  setTrait,
} from '@agora/shared';
import { AgentBus } from '@agora/agent/bus';
import { ConflictEvaluator } from '@agora/agent/conflict/evaluator';
import type { Body } from '@agora/agent/body/body';
import { codeDecision, validateDecision } from '@agora/agent/modules/cc';
import { Conversations } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { Talking, needsDecision } from '@agora/agent/modules/talking';
import { SocialAwareness } from '@agora/agent/social/awareness';
import {
  FAMILY_HAPPY,
  FAMILY_NOT_YET,
  FAMILY_PROPOSAL,
  FAMILY_YES,
  type FamilyView,
  FamilyWatch,
  greeting,
  isFamilyAsk,
  isFamilyYes,
  warnLine,
} from '@agora/agent/social/familyWatch';
import { namedIn } from '@agora/agent/social/opinions';
import { applyBirthFacts } from '@agora/agent/state/birth';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { isYoung, parentsWhileYoung } from '@agora/agent/state/youth';

const world = WorldConfigSchema.parse({});
const person = (name: string, sex: 'male' | 'female', o: Record<string, unknown> = {}): Persona => PersonaSchema.parse({ id: name.toLowerCase(), name, sex, traits: ['kind'], ...o });

describe('a child from its parents (§19.4, scenario T)', () => {
  const ned = person('Ned', 'male', { familyName: 'Stark', values: ['family', 'honor'], abilities: { intelligence: 0.9, combat: 0.3 } });
  const ivy = person('Ivy', 'female', { values: ['nature'], abilities: { intelligence: 0.5, combat: 0.7 } });
  // Parents far apart on every numeric trait, so "within their range" means something.
  for (const k of NUMERIC_TRAIT_KEYS) {
    setTrait(ned, k, 0.2);
    setTrait(ivy, k, 0.8);
  }

  it('takes each numeric trait from one parent, the other or their mean, with a little noise and now and then a larger change', () => {
    const rng = new SeededRandom(11);
    const kids = Array.from({ length: 300 }, () => inheritPersona({ rng, world, a: ned, b: ivy, takenNames: new Set(['Ned', 'Ivy']) }));
    for (const k of NUMERIC_TRAIT_KEYS) {
      const v = kids.map((c) => getTrait(c, k));
      // Within the parents' range ± noise for nearly all (the large changes are one in ten, and most stay near).
      expect(v.filter((x) => x >= 0.2 - 0.25 && x <= 0.8 + 0.25).length / v.length).toBeGreaterThan(0.95);
      expect(v.every((x) => x >= 0 && x <= 1)).toBe(true);
      const mean = v.reduce((a, x) => a + x, 0) / v.length;
      expect(Math.abs(mean - 0.5)).toBeLessThan(0.06);
      // Some at either parent, some between: not just the mean.
      expect(v.some((x) => x < 0.35)).toBe(true);
      expect(v.some((x) => x > 0.65)).toBe(true);
    }
    const girls = kids.filter((c) => c.sex === 'female').length / kids.length;
    expect(girls).toBeGreaterThan(0.4);
    expect(girls).toBeLessThan(0.6);
  });

  it('is born with a family name, a player-like name of its own, the next generation, and nothing in its pockets', () => {
    const rng = new SeededRandom(3);
    const taken = new Set(['Ned', 'Ivy']);
    const c = inheritPersona({ rng, world, a: ned, b: ivy, takenNames: taken });
    expect(c.familyName).toBe('Stark');
    expect(c.name).toMatch(/^[A-Za-z0-9]+_S$/);
    expect(isValidUsername(c.name)).toBe(true);
    expect(c.source).toBe('born');
    expect(c.generation).toBe(1);
    expect(c.inventory).toEqual([]);
    // Values and quirks kept from the parents (each with p 0.5), plus one quirk of its own.
    expect(c.quirks.length).toBeGreaterThanOrEqual(1);
    for (const v of c.values) expect(['family', 'honor', 'nature', ...c.values]).toContain(v);
  });

  it('inherits abilities in part (heritability), the rest from the population', () => {
    const rng = new SeededRandom(5);
    const kids = Array.from({ length: 300 }, () => inheritPersona({ rng, world, a: ned, b: ivy, takenNames: new Set() }));
    const h = world.abilities.intelligence.heritability;
    const want = h * 0.7 + (1 - h) * world.abilities.intelligence.mean;
    const mean = kids.reduce((a, c) => a + c.abilities.intelligence, 0) / kids.length;
    expect(Math.abs(mean - want)).toBeLessThan(0.05);
  });

  it('for a parent there is no persona for, stands in what the other parent believes of them', () => {
    const them = perceivedPersona(ivy, { username: 'Sam', sex: 'male', model: { openness: 0.95, combat: 0.9, compatibility: 0.7 } });
    expect(them.name).toBe('Sam');
    expect(them.sex).toBe('male');
    expect(getTrait(them, 'openness')).toBe(0.95);
    expect(them.abilities.combat).toBe(0.9);
    expect(them.abilities.intelligence).toBe(ivy.abilities.intelligence);
    expect(them.values).toEqual([]);
    expect(them.quirks).toEqual([]);
    expect(them.familyName).toBeUndefined();
  });
});

describe('what is said about starting a family (§19.3)', () => {
  it('tells the question from the answer, and a greeting names the parents', () => {
    expect(isFamilyAsk(FAMILY_PROPOSAL)).toBe(true);
    expect(isFamilyAsk('Ivy, shall we have a child?')).toBe(true);
    expect(isFamilyAsk(FAMILY_YES)).toBe(false);
    expect(isFamilyYes(FAMILY_YES)).toBe(true);
    expect(isFamilyYes(FAMILY_NOT_YET)).toBe(false);
    expect(needsDecision(FAMILY_PROPOSAL)).toBe(true);
    expect(needsDecision(FAMILY_NOT_YET)).toBe(false);
    expect(greeting([{ name: 'Ned', sex: 'male' }, { name: 'Ivy', sex: 'female' }])).toBe('Ned, Ivy: hi dad, hi mom!');
    expect(warnLine('Gorm', 'Gorm attacked me')).toBe('watch out for Gorm. Gorm attacked me.');
    expect(warnLine('Gorm', 'I lost my sword')).toBe('watch out for Gorm. Gorm is a bully.');
  });
});

/** Ned and his partner Ivy, together long enough and fond of each other, with a home and food unless told otherwise. */
function rig(o: { me?: Persona; home?: boolean; food?: number; days?: number; liking?: number; resent?: Record<string, number> } = {}) {
  const me = o.me ?? person('Ned', 'male');
  const t = { now: 50 * GAME_DAY_MS };
  const s = new AgentStateStore(createInitialState({ persona: me, username: me.name, now: t.now }));
  s.update('family', (f) => ({ ...f, partner: 'Ivy' }));
  s.update('social', (all) => ({ ...all, Ivy: { ...newSocialProfile('Ivy', me, t.now), relationship: 'partner', relationshipSince: t.now - (o.days ?? 3) * GAME_DAY_MS, sentiment: 9, perceivedSex: 'female' } }));
  const bed = (x: number, z: number) => ({ name: 'red_bed', pos: { x, y: 64, z }, distance: 3, seenAt: t.now });
  if (o.home !== false) {
    s.update('perception', (p) => ({ ...p, nearbyBlocksOfInterest: [bed(0, 0), bed(0, 1), bed(1, 0), bed(1, 1), { name: 'chest', pos: { x: 4, y: 64, z: 0 }, distance: 5, seenAt: t.now }] }));
  }
  s.update('self', (x) => ({ ...x, pos: { x: 2, y: 64, z: 2 }, inventory: (o.food ?? 20) > 0 ? [{ item: 'bread', qty: o.food ?? 20 }] : [] }));
  const bus = new AgentBus();
  const said: string[] = [];
  const conceived: string[] = [];
  const felt: string[] = [];
  const w = new FamilyWatch({
    store: s,
    bus,
    logger: nullLogger(),
    me: me.name,
    enabled: true,
    config: { partnerMinDays: 2, coupleCooldownSec: 7200, minFoodItems: 20, youthSec: 1800 },
    liking: (n) => (n === 'Ivy' ? (o.liking ?? 9) : 5),
    resentmentOf: (n) => o.resent?.[n] ?? 0,
    conceived: (partner, bed) => void conceived.push(`${partner}@${bed.x},${bed.z}`),
    feel: (ev, who) => void felt.push(`${ev.kind}${who ? `:${who}` : ''}`),
    say: (text, to, volume) => void said.push(`${volume} ${to.join('+')}: ${text}`),
    now: () => t.now,
    tickMs: 60_000_000,
  });
  w.start();
  const tick = () => (w as unknown as { tick(): void }).tick();
  const see = (...who: [string, number, { sleeping?: boolean }?][]) =>
    s.update('perception', (p) => ({
      ...p,
      nearbyEntities: who.map(([name, d, x], i) => ({ id: i + 1, kind: 'player' as const, name, pos: { x: 2 + d, y: 64, z: 2 }, distance: d, visible: true, heldItem: null, armor: [], lastSeen: t.now, hurtRecently: false, ...(x?.sleeping ? { sleeping: true } : {}) })),
    }));
  const hear = (from: string, text: string) =>
    bus.emit({ type: 'heard', utterance: { id: `u${Math.random()}`, convId: 'c1', from, to: [me.name], text, ts: t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true } });
  const decide = (d: Partial<DecisionOutput>) => bus.emit({ type: 'decision', decision: { option: 'talk', terminate: { maxSeconds: 30 }, rationale: 'test', ...d, id: `d${t.now}`, createdAt: t.now, stateVersion: 1, source: 'default' } });
  return { s, bus, w, t, tick, see, hear, decide, said, conceived, felt };
}

describe('the family watch (§19.3)', () => {
  it('checks every condition from its own side: partner, long enough, fond, home, food, no child just now', () => {
    expect(rig().w.whyNotFamily('Ivy')).toBeNull();
    expect(rig().w.whyNotFamily('Bea')).toMatch(/not my partner/);
    expect(rig({ days: 1 }).w.whyNotFamily('Ivy')).toMatch(/not together long enough/);
    expect(rig({ liking: 7 }).w.whyNotFamily('Ivy')).toMatch(/not sure about us/);
    expect(rig({ home: false }).w.whyNotFamily('Ivy')).toMatch(/no home yet/);
    expect(rig({ food: 12 }).w.whyNotFamily('Ivy')).toMatch(/not enough food/);
    const r = rig();
    r.s.update('family', (f) => ({ ...f, lastConceptionTs: r.t.now - 60_000 }));
    expect(r.w.whyNotFamily('Ivy')).toMatch(/only just had a child/);
    const off = new FamilyWatch({ store: rig().s, bus: new AgentBus(), logger: nullLogger(), me: 'Ned', enabled: false, config: { partnerMinDays: 2, coupleCooldownSec: 1, minFoodItems: 1, youthSec: 1 }, liking: () => 9 });
    expect(off.whyNotFamily('Ivy')).toMatch(/not possible here/);
  });

  it('asks its partner when all is in place, takes their yes, and at night goes to bed beside them at home', () => {
    const r = rig();
    expect(r.w.step()).toBeNull(); // Ivy isn't here
    r.see(['Ivy', 4]);
    expect(r.w.step()).toEqual({ kind: 'ask', to: 'Ivy' });
    r.decide({ target: { agent: 'Ivy' }, speechIntent: { stance: 'propose', gist: FAMILY_PROPOSAL, mayCommit: false }, family: { with: 'Ivy', phase: 'propose' } });
    expect(r.w.step()).toBeNull(); // asked: not again for a while
    r.hear('Ivy', "Ned, yes, let's start a family!");
    expect(r.s.state.family.planning?.with).toBe('Ivy');
    // Daytime: nothing yet. At night: to the nearest of the home's beds.
    r.s.update('self', (x) => ({ ...x, time: 6000 }));
    expect(r.w.step()).toBeNull();
    r.s.update('self', (x) => ({ ...x, time: 13_000 }));
    expect(r.w.step()).toMatchObject({ kind: 'sleep', with: 'Ivy', near: { x: 1, z: 1 } });
  });

  it('lying in its bed with its partner asleep in the one beside: tells the Hub once, and the plan is done', () => {
    const r = rig();
    r.s.update('family', (f) => ({ ...f, planning: { with: 'Ivy', at: r.t.now } }));
    r.s.update('self', (x) => ({ ...x, isSleeping: true }));
    r.see(['Ivy', 5, { sleeping: true }]);
    r.tick();
    expect(r.conceived).toEqual([]); // too far: not the bed beside ours
    r.see(['Ivy', 1.2]);
    r.tick();
    expect(r.conceived).toEqual([]); // beside, but awake
    r.see(['Ivy', 1.2, { sleeping: true }]);
    r.tick();
    r.tick();
    expect(r.conceived).toEqual(['Ivy@2,2']);
    expect(r.s.state.family.planning).toBeUndefined();
    expect(r.s.state.family.lastConceptionTs).toBe(r.t.now);
  });

  it('knows its child by the greeting that names it, and holds it dear (kin)', () => {
    const r = rig();
    r.hear('Lily_S', 'Ned, Ivy: hi dad, hi mom!');
    expect(r.s.state.family.children).toEqual(['Lily_S']);
    expect(r.s.state.social.Lily_S).toMatchObject({ kin: 'child' });
    expect(r.s.state.social.Lily_S?.sentiment).toBeGreaterThanOrEqual(9);
    expect(r.felt).toContain('goalAchieved');
    // A greeting naming someone else is no child of ours; nor is "hi" from a stranger.
    r.hear('Tom_B', 'Bo, Cy: hi dad, hi mom!');
    r.hear('Rex', 'hi there!');
    expect(r.s.state.family.children).toEqual(['Lily_S']);
  });

  it('as a parent: keeps a young child close, gives it food once, and warns it about the one it resents most', () => {
    const r = rig({ resent: { Gorm: 0.8, Bea: 0.3 } });
    r.s.update('social', (all) => ({ ...all, Gorm: { ...newSocialProfile('Gorm', r.s.state.self.persona, r.t.now), grievances: [{ kind: 'attack', weight: 0.6, ts: r.t.now, witnessed: true, source: 'self_observed', note: 'Gorm attacked me' }] }, Bea: newSocialProfile('Bea', r.s.state.self.persona, r.t.now) }));
    r.hear('Lily_S', 'Ned, Ivy: hi dad, hi mom!');
    r.see(['Lily_S', 14]);
    expect(r.w.step()).toMatchObject({ kind: 'keepClose', to: 'Lily_S' });
    r.see(['Lily_S', 5]);
    expect(r.w.step()).toEqual({ kind: 'feed', to: 'Lily_S', item: 'bread', qty: 3 });
    r.bus.emit({ type: 'actionRecorded', record: { id: 'g1', skill: 'give', args: { to: 'Lily_S', item: 'bread', qty: 3 }, expected: '', observed: 'tossed 3 bread', ok: true, ts: r.t.now, durationMs: 1 } });
    expect(r.w.step()).toEqual({ kind: 'warn', to: 'Lily_S', about: 'Gorm', line: 'watch out for Gorm. Gorm attacked me.' });
    r.decide({ target: { agent: 'Lily_S' }, speechIntent: { stance: 'inform', gist: 'watch out for Gorm. Gorm attacked me.', mayCommit: false }, family: { with: 'Lily_S', phase: 'warn', about: 'Gorm' } });
    expect(r.w.step()).toBeNull(); // Bea isn't resented enough to warn about
    expect(r.w.hint()).toMatch(/young child \(Lily_S\): teach and protect them/);
    // Grown up (after youthSec): no longer looked after so.
    r.t.now += 1801 * 1000;
    r.see(['Lily_S', 14]);
    expect(r.w.step()).toBeNull();
  });

  it('as a young child: keeps to a parent, greets them (first words shouted, then each in person), and is told to', () => {
    vi.useFakeTimers();
    try {
      const lily = person('Lily_S', 'female');
      const t0 = Date.now();
      const s = new AgentStateStore(createInitialState({ persona: lily, username: 'Lily_S', now: t0, born: true, youthUntil: t0 + 1_800_000 }));
      applyBirthFacts(s, { parents: [{ username: 'Ned', name: 'Ned', sex: 'male' }, { username: 'Ivy', name: 'Ivy', sex: 'female' }], siblings: [], home: { x: 0, y: 64, z: 0 } }, lily, t0);
      const said: string[] = [];
      const w = new FamilyWatch({ store: s, bus: new AgentBus(), logger: nullLogger(), me: 'Lily_S', enabled: true, config: { partnerMinDays: 2, coupleCooldownSec: 7200, minFoodItems: 20, youthSec: 1800 }, liking: () => 9, say: (text, to, volume) => void said.push(`${volume} ${to.join('+')}: ${text}`), tickMs: 1000 });
      w.start();
      expect(w.young()).toBe(true);
      vi.advanceTimersByTime(8000);
      expect(said).toEqual(['shout Ned+Ivy: Ned, Ivy: hi dad, hi mom!']);
      s.update('perception', (p) => ({ ...p, nearbyEntities: [{ id: 1, kind: 'player', name: 'Ivy', pos: { x: 9, y: 64, z: 0 }, distance: 9, visible: true, heldItem: null, armor: [], lastSeen: Date.now(), hurtRecently: false }] }));
      vi.advanceTimersByTime(1000);
      expect(said.at(-1)).toBe('normal Ivy: Ivy: hi mom!');
      vi.advanceTimersByTime(5000);
      expect(said.filter((x) => x.includes('hi mom')).length).toBe(2); // once in person
      expect(w.step()).toEqual({ kind: 'keepClose', to: 'Ivy', why: 'keeping close to my parent' });
      expect(w.hint()).toMatch(/You are young: stay close to your parents \(Ned and Ivy\)/);
      expect(w.whyNotFamily('Ned')).not.toBeNull();
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('families in the code default (§19.3, §19.5)', () => {
  const view = (o: Partial<FamilyView> = {}): FamilyView => ({ step: () => null, whyNotFamily: () => null, young: () => false, ...o });
  const withLine = (text: string) => {
    const r = rig();
    r.s.update('perception', (p) => ({ ...p, heardSpeech: [{ id: 'u', convId: 'c1', from: 'Ivy', to: ['Ned'], text, ts: 1, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true }] }));
    return r.s.state;
  };
  const answer = (text: string, family: FamilyView) => codeDecision(withLine(text), { from: 'Ivy', convId: 'c1' }, false, () => false, { candidates: [], roll: 1, family });

  it("answers its partner's question for itself: yes when all is in place on its side, otherwise not yet; and is glad of a yes", () => {
    expect(answer('Ned, want to start a family?', view())).toMatchObject({ speechIntent: { stance: 'agree', gist: FAMILY_YES }, family: { with: 'Ivy', phase: 'accept' } });
    expect(answer('Ned, want to start a family?', view({ whyNotFamily: () => 'no home yet' }))).toMatchObject({ speechIntent: { stance: 'decline', gist: FAMILY_NOT_YET }, family: { with: 'Ivy', phase: 'decline' } });
    expect(answer("Ned, yes, let's start a family!", view())).toMatchObject({ speechIntent: { stance: 'chat', gist: FAMILY_HAPPY } });
  });

  it('asks, goes to bed at night beside its partner instead of digging in, and looks after a young child', () => {
    const s = rig().s;
    s.update('self', (x) => ({ ...x, time: 13_000, isDay: false }));
    const decide = (step: ReturnType<FamilyView['step']>) => codeDecision(s.state, {}, false, () => false, { candidates: [], roll: 1, family: view({ step: () => step }) });
    expect(decide({ kind: 'sleep', near: { x: 1, y: 64, z: 1 }, with: 'Ivy' })).toMatchObject({ option: 'work', task: { skill: 'sleep', args: { near: { x: 1, y: 64, z: 1 } } } });
    s.update('self', (x) => ({ ...x, time: 6000, isDay: true }));
    expect(decide({ kind: 'ask', to: 'Ivy' })).toMatchObject({ option: 'talk', target: { agent: 'Ivy' }, speechIntent: { stance: 'propose', gist: FAMILY_PROPOSAL }, family: { with: 'Ivy', phase: 'propose' } });
    expect(decide({ kind: 'keepClose', to: 'Lily_S', why: 'looking after my child' })).toMatchObject({ option: 'follow', target: { agent: 'Lily_S' } });
    expect(decide({ kind: 'feed', to: 'Lily_S', item: 'bread', qty: 3 })).toMatchObject({ option: 'work', task: { skill: 'give', args: { to: 'Lily_S', item: 'bread', qty: 3 } } });
    expect(decide({ kind: 'warn', to: 'Lily_S', about: 'Gorm', line: 'watch out for Gorm. Gorm is a bully.' })).toMatchObject({
      option: 'talk',
      speechIntent: { stance: 'inform', gist: 'watch out for Gorm. Gorm is a bully.' },
      family: { with: 'Lily_S', phase: 'warn', about: 'Gorm' },
    });
  });

  it('the question is said even right after a chat with them (a family’s business, not small talk)', async () => {
    const r = rig();
    r.see(['Ivy', 3]);
    const said: string[] = [];
    const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const conversations = new Conversations({ store: r.s, bus: r.bus, logger: nullLogger(), me: 'Ned', inRange: () => ['Ivy'], rng: () => 0 });
    const executor = new SkillExecutor({ store: r.s, bus: r.bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: r.s, bus: r.bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Ned', rng: () => 0 });
    conversations.start();
    talking.start();
    // A chat with Ivy just ended: no small talk with her for a while.
    const chat = conversations.open('Ivy', true);
    conversations.end(chat.convId, 'done');
    expect(conversations.mayInitiate('Ivy')).toBe(false);
    const d = { id: 'd1', createdAt: Date.now(), stateVersion: 1, source: 'default' as const, option: 'talk' as const, target: { agent: 'Ivy' }, speechIntent: { stance: 'propose' as const, gist: FAMILY_PROPOSAL, mayCommit: false }, family: { with: 'Ivy', phase: 'propose' as const }, terminate: { maxSeconds: 40 }, rationale: 'test' };
    r.s.set('decision', d, 'decided');
    r.bus.emit({ type: 'decision', decision: d });
    for (let i = 0; i < 40 && said.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    expect(said).toEqual([`Ivy, ${FAMILY_PROPOSAL}`]);
    talking.stop();
    conversations.stop();
  });

  it('the gate keeps a model from asking or agreeing when it is not all in place on our side', () => {
    const env = { me: 'Ned', isStuck: () => false, canPerceive: () => true, mayStartFamily: (n: string) => (n === 'Ivy' ? null : `${n} is not my partner`) };
    expect(validateDecision({ option: 'talk', target: { agent: 'Bea' }, family: { with: 'Bea', phase: 'propose' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toMatch(/can't ask Bea to start a family: Bea is not my partner/);
    expect(validateDecision({ option: 'talk', target: { agent: 'Bea' }, family: { with: 'Bea', phase: 'accept' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toMatch(/can't agree with Bea/);
    expect(validateDecision({ option: 'talk', target: { agent: 'Ivy' }, family: { with: 'Ivy', phase: 'propose' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toBeNull();
    expect(validateDecision({ option: 'talk', target: { agent: 'Bea' }, family: { with: 'Bea', phase: 'decline' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toBeNull();
  });
});

describe('a young one takes its parents’ word for people (§19.5, scenario U)', () => {
  it('learns a stranger’s name from a warning', () => {
    expect(namedIn('watch out for Gorm. Gorm attacked me.')).toEqual(['Gorm']);
    expect(namedIn('Rex is a bully. stay away from him')).toEqual(['Rex']);
    expect(namedIn('watch out for creepers at night')).toEqual([]);
  });

  function child(o: { young: boolean }) {
    const lily = person('Lily_S', 'female', { mind: { conformity: 0.6 } });
    const t = { now: 1_000_000 };
    const s = new AgentStateStore(createInitialState({ persona: lily, username: 'Lily_S', now: t.now, born: true, youthUntil: o.young ? t.now + 1_800_000 : t.now - 1 }));
    applyBirthFacts(s, { parents: [{ username: 'Ned', name: 'Ned', sex: 'male' }, { username: 'Ivy', name: 'Ivy', sex: 'female' }], siblings: [] }, lily, t.now);
    s.update('social', (all) => ({ ...all, Tom: { ...newSocialProfile('Tom', lily, t.now), sentiment: 9, trust: 0.9, admiration: 0.8 } }));
    const bus = new AgentBus();
    const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: 'Lily_S', now: () => t.now });
    sa.start();
    const hear = (from: string, text: string) =>
      bus.emit({ type: 'heard', utterance: { id: `u${Math.random()}`, convId: 'c1', from, to: ['Lily_S'], text, ts: t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true } });
    return { s, sa, hear };
  }

  it('a parent’s warning about someone it has never met turns it against them, more in its youth', () => {
    const young = child({ young: true });
    const grown = child({ young: false });
    for (const c of [young, grown]) c.hear('Ned', 'watch out for Gorm. Gorm attacked me.');
    const youngView = young.s.state.social.Gorm?.sentiment ?? 5;
    const grownView = grown.s.state.social.Gorm?.sentiment ?? 5;
    const baseline = newSocialProfile('Gorm', young.s.state.self.persona, 0).sentiment;
    expect(youngView).toBeLessThan(baseline);
    expect(youngView).toBeLessThan(grownView);
    // Told, not seen: a hearsay grievance from the parent, at half weight.
    expect(young.s.state.social.Gorm?.grievances.some((g) => g.source === 'told_by:Ned' && g.kind === 'attack')).toBe(true);
    // Someone else held just as dear says the same: the parent's word still counts for more while young.
    const other = child({ young: true });
    other.hear('Tom', 'watch out for Gorm. Gorm attacked me.');
    expect(youngView).toBeLessThan(other.s.state.social.Gorm?.sentiment ?? 5);
    for (const c of [young, grown, other]) c.sa.stop();
  });

  it('knows its parents only while young', () => {
    const young = child({ young: true });
    expect(isYoung(young.s.state, 1_000_000)).toBe(true);
    expect(parentsWhileYoung(young.s.state, 1_000_000)).toEqual(['Ned', 'Ivy']);
    expect(parentsWhileYoung(young.s.state, 1_000_000 + 1_800_001)).toEqual([]);
    young.sa.stop();
  });
});

describe('born knowing its family (§19.4)', () => {
  it('its parents and siblings, held dear, its home; and no memories of anyone', () => {
    const lily = person('Lily_S', 'female');
    const s = new AgentStateStore(createInitialState({ persona: lily, username: 'Lily_S', now: 0, born: true, youthUntil: 1_800_000 }));
    const facts: BirthFacts = { parents: [{ username: 'Ned', name: 'Ned', sex: 'male' }, { username: 'Ivy', name: 'Ivy', sex: 'female' }], siblings: ['Tom_S'], home: { x: 10, y: 64, z: -3 }, familyName: 'Stark' };
    applyBirthFacts(s, facts, lily, 0);
    const st = s.state;
    expect(st.life).toMatchObject({ born: true, youthUntil: 1_800_000 });
    expect(st.family).toMatchObject({ parents: ['Ned', 'Ivy'], siblings: ['Tom_S'], familyName: 'Stark' });
    expect(st.social.Ned).toMatchObject({ kin: 'parent', sentiment: 9, admiration: 0.8, perceivedSex: 'male' });
    expect(st.social.Ivy).toMatchObject({ kin: 'parent', sentiment: 9, admiration: 0.8, perceivedSex: 'female' });
    expect(st.social.Tom_S).toMatchObject({ kin: 'sibling', sentiment: 7 });
    expect(st.workmem.map((w) => w.text)).toEqual(expect.arrayContaining(['my parents are Ned and Ivy; my siblings: Tom_S', "home is where my parents' beds are, at 10, 64, -3"]));
    // Nothing about anyone else: no grudges, no history.
    expect(Object.keys(st.social).sort()).toEqual(['Ivy', 'Ned', 'Tom_S']);
    expect(Object.values(st.social).every((p) => p.grievances.length === 0)).toBe(true);
  });
});

describe('youth and kin in the conflict core (§19.5)', () => {
  function evaluator(young: boolean) {
    const lily = person('Lily_S', 'female', { temperament: { aggression: 0.9, vengefulness: 0.9 } });
    const s = new AgentStateStore(createInitialState({ persona: lily, username: 'Lily_S', now: 0, born: true, youthUntil: young ? Number.MAX_SAFE_INTEGER : 0 }));
    s.update('family', (f) => ({ ...f, parents: ['Ned', 'Ivy'] }));
    s.update('social', (all) => ({ ...all, Ned: { ...newSocialProfile('Ned', lily, 0), kin: 'parent', sentiment: 9 }, Gorm: newSocialProfile('Gorm', lily, 0) }));
    s.update('conflict', (c) => ({ ...c, rungs: { Gorm: 3 } }));
    const bus = new AgentBus();
    const w = WorldConfigSchema.parse({ conflict: { maxRung: 3, newcomerGraceSec: 0 } });
    const ce = new ConflictEvaluator({ store: s, bus, logger: nullLogger(), me: 'Lily_S', config: w.conflict, mode: 'test', myGear: () => 0.3, bornAt: 0, young: () => young, rng: () => 0.5, now: () => 10_000_000 });
    ce.start();
    return { s, bus, ce };
  }

  it('the young stay at words: no fight, whatever the anger', () => {
    expect(evaluator(true).ce.mayFight('Gorm', 'brawl')).toMatch(/limited to rung 1/);
    expect(evaluator(true).ce.mayFight('Gorm', 'impulse')).toMatch(/limited to rung 1/);
    expect(evaluator(false).ce.mayFight('Gorm', 'brawl')).not.toMatch(/limited to rung/);
  });

  it('a parent killed is a lifetime grievance against the killer', () => {
    const e = evaluator(false);
    e.bus.emit({ type: 'systemEvent', event: { kind: 'death', subject: 'Ned', killer: 'Gorm', text: 'Ned was slain by Gorm', ts: 10_000_000 } });
    expect(e.s.state.social.Gorm?.grievances.map((g) => [g.kind, g.note])).toContainEqual(['killed_parent', 'Gorm killed my parent Ned']);
  });
});
