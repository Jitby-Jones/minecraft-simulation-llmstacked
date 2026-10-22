// M8c (§18.4, §18.4.1, §18.6): reflection as debiasing and the dynamics of conformity, without Minecraft. The bias
// audit (its candidates, the corrections and who accepts them, inoculation and growth), hearsay grievances, a feared
// leader keeping dissent quiet and defiance that goes unpunished bringing it out, tribute and the bandwagon, and the
// in-group, attribution and sunk-cost biases. Live behavior is in tests/live/m8c-minds.test.ts (scenarios O and P).

import { afterEach, describe, expect, it } from 'vitest';
import { type AgentState, ModelsConfigSchema, PersonaSchema, type SeenEntity, type SocialProfile, WorldConfigSchema, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { AgentBus } from '@agora/agent/bus';
import { ConflictEvaluator } from '@agora/agent/conflict/evaluator';
import { PowerWatch } from '@agora/agent/conflict/power';
import { inoculation, rationalityOf, susceptibilityToward } from '@agora/agent/mind/biases';
import { type ConflictView, codeDecision } from '@agora/agent/modules/cc';
import { leversFor } from '@agora/agent/modules/levers';
import { type PowerMoveCtx, gossipMove } from '@agora/agent/modules/powerMove';
import { Reflection, acceptsCorrection, auditCandidates, corrected } from '@agora/agent/modules/reflection';
import { SocialAwareness } from '@agora/agent/social/awareness';
import { withGrievance } from '@agora/agent/social/math';
import { opinionLine, readDeeds, readOpinionAsk, readOpinions, statedOpinion } from '@agora/agent/social/opinions';
import { needsDecision } from '@agora/agent/modules/talking';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const person = (name: string, mind: Record<string, number>, traits = ['calm']) =>
  PersonaSchema.parse({ name, sex: 'female', traits, mind: { arousal: 0, ...mind }, temperament: { loyalty: 0.4 }, drives: { caution: 0.4 }, abilities: { intelligence: 0.9 } });
const sage = person('Ana', { rationality: 0.9, conformity: 0.2 });
const sheep = person('Ivo', { rationality: 0.1, conformity: 0.9 });
const T = 10_000_000;
const ent = (name: string, x: number): SeenEntity => ({ id: x * 7 + name.length, kind: 'player', name, pos: { x, y: 0, z: 0 }, distance: Math.abs(x), visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false });
const say = (id: string, from: string, text: string, toMe: boolean, to: string[] = []) => ({ id, convId: 'c1', from, to: toMe ? ['Ana'] : to, text, ts: T, pos: null, volume: 'normal' as const, outOfSight: false, addressedToMe: toMe });

function world(p = sage, people: string[] = ['Bram', 'Cass', 'Dov']) {
  const s = new AgentStateStore(createInitialState({ persona: p, username: p.name, now: 0 }));
  s.update('social', (all) => ({ ...all, ...Object.fromEntries(people.map((n) => [n, { ...newSocialProfile(n, p, T), lastSeen: T }])) }));
  return s;
}
const set = (s: AgentStateStore, name: string, f: (p: SocialProfile) => SocialProfile) => s.update('social', (all) => ({ ...all, [name]: f(all[name] ?? newSocialProfile(name, s.state.self.persona, T)) }), 'test');

const stops: (() => void)[] = [];
afterEach(() => {
  for (const f of stops.splice(0)) f();
});

describe('hearsay (§17.8)', () => {
  it('reads wrongs told of: who did it, what, to whom; a denial takes it back', () => {
    const known = ['Bram', 'Cass', 'Dov'];
    expect(readDeeds('Bram stole my iron', 'Cass', known)).toEqual([{ speaker: 'Cass', target: 'Bram', deed: 'theft' }]);
    expect(readDeeds('watch out, Bram killed Dov last night', 'Cass', known)).toEqual([{ speaker: 'Cass', target: 'Bram', deed: 'kill', victim: 'Dov' }]);
    expect(readDeeds('Bram never stole anything', 'Cass', known)).toEqual([]);
    expect(readDeeds('I hit a zombie', 'Cass', known)).toEqual([]);
    // The speaker isn't the doer they tell of.
    expect(readDeeds('Cass hit Bram', 'Cass', known)).toEqual([]);
  });

  it('a wrong we were told of becomes a grievance from hearsay: half weight, less for a teller we doubt, once an hour', () => {
    const s = world();
    const bus = new AgentBus();
    const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: 'Ana', now: () => T });
    sa.start();
    stops.push(() => sa.stop());
    bus.emit({ type: 'heard', utterance: say('u1', 'Cass', 'Bram stole my iron', true) });
    bus.emit({ type: 'heard', utterance: say('u2', 'Cass', 'Bram stole my iron', true) });
    const g = s.state.social.Bram?.grievances ?? [];
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: 'theft', source: 'told_by:Cass', note: 'Cass says Bram stole', witnessed: false });
    expect(g[0]?.weight).toBeCloseTo(0.2); // 0.4 × ½
    set(s, 'Dov', (p) => ({ ...p, trust: 0.1 }));
    bus.emit({ type: 'heard', utterance: say('u3', 'Dov', 'Cass lied to everyone', true) });
    expect(s.state.social.Cass?.grievances[0]?.weight).toBeCloseTo(0.3 * 0.2); // betrayal 0.6 × ½ × credence 0.2
    // Seen through on reflection once, the same rumor counts half when it comes round again.
    set(s, 'Bram', (p) => corrected(p, 'hearsay'));
    bus.emit({ type: 'heard', utterance: say('u4', 'Cass', 'Bram stole my iron', true) });
    expect(s.state.social.Bram?.grievances[0]?.weight).toBeCloseTo(0.1);
  });
});

describe('the bias audit (§18.6)', () => {
  const told = (p: SocialProfile, persona = sage) => withGrievance(p, 'theft', persona, { now: T, witnessed: false, source: 'told_by:Cass', note: 'Cass says Bram stole', weight: 0.33 });

  it('finds the feelings that rest on hearsay, blame without cause, an idol, a crowd or a first impression', () => {
    const s = world(sage, ['Bram', 'Cass', 'Dov', 'Eve', 'Fay']);
    set(s, 'Bram', (p) => ({ ...told(p), sentiment: 2.5, evidence: 7 }));
    s.update('heardOpinions', () => [{ speaker: 'Cass', target: 'Bram', valence: -0.7, ts: T }], 'test');
    set(s, 'Cass', (p) => ({ ...withGrievance(p, 'scapegoat', sage, { now: T, witnessed: false, source: 'self_observed', note: 'I bet Cass had something to do with it' }), sentiment: 4 }));
    set(s, 'Dov', (p) => ({ ...p, admiration: 0.9, sentiment: 8, evidence: 3 }));
    set(s, 'Eve', (p) => ({ ...p, sentiment: 3, evidence: 7 }));
    s.update('workmem', (w) => [...w, { id: 'w1', text: 'Everyone is against Eve, and so am I', salience: 0.6, source: 'self_observed', ts: T, aboutAgent: 'Eve' }], 'test');
    set(s, 'Fay', (p) => ({ ...p, sentiment: 8.5, evidence: 5, interactions: 4 }));
    const found = Object.fromEntries(auditCandidates(s.state).map((x) => [x.name, x.kind]));
    expect(found).toEqual({ Bram: 'hearsay', Cass: 'scapegoat', Dov: 'idol', Eve: 'crowd' });
    // A grudge that is only what we were told, before it has moved the feeling much, is hearsay too.
    expect(auditCandidates({ ...s.state, social: { Bram: { ...told(newSocialProfile('Bram', sage, T)), sentiment: 5, evidence: 5 } } }).map((x) => x.kind)).toEqual(['hearsay']);
    // Four at most: the strongest gaps first (Fay's first impression waits for the next time).
    expect(auditCandidates({ ...s.state, social: { Fay: s.state.social.Fay as SocialProfile } }).map((x) => x.kind)).toEqual(['first_impression']);
  });

  it('a correction undoes the bias toward the facts and inoculates against it about that person', () => {
    const p = { ...told(newSocialProfile('Bram', sage, T)), sentiment: 2, evidence: 7 };
    const c = corrected(p, 'hearsay');
    expect(c.grievances).toEqual([]);
    expect(c.sentiment).toBeCloseTo(2 + 5 * 0.6);
    expect(c.inoculated).toEqual(['conformity']);
    expect(corrected({ ...p, admiration: 0.9 }, 'idol')).toMatchObject({ admiration: 0.45, inoculated: ['halo'] });
  });

  it('is taken to heart with probability rationality; the stubborn resist', () => {
    expect(acceptsCorrection(0.9, ['calm'], 0.5)).toBe(true);
    expect(acceptsCorrection(0.9, ['stubborn'], 0.5)).toBe(false);
    expect(acceptsCorrection(0.1, ['calm'], 0.5)).toBe(false);
  });

  it('without a model: the rational one sees through the hearsay, grows a little wiser; the other keeps the grudge', async () => {
    const run = async (p = sage) => {
      const s = world(p);
      set(s, 'Bram', (x) => ({ ...told(x, p), sentiment: 2.5, evidence: 7 }));
      s.update('heardOpinions', () => [{ speaker: 'Cass', target: 'Bram', valence: -0.7, ts: T }], 'test');
      const r = new Reflection({ store: s, bus: new AgentBus(), logger: nullLogger(), llm: null, me: p.name, levers: () => leversFor(0.9), rng: () => 0.5, now: () => T });
      await r.run('test');
      return s.state;
    };
    const ana = await run(sage);
    expect(ana.social.Bram?.grievances).toEqual([]);
    expect(ana.social.Bram?.sentiment).toBeGreaterThan(5);
    expect(ana.social.Bram?.inoculated).toEqual(['conformity']);
    expect(ana.growth).toMatchObject({ rationalityBonus: 0.02, selfCorrections: 1 });
    expect(ana.workmem.at(-1)?.source).toBe('reflection');
    const ivo = await run(sheep);
    expect(ivo.social.Bram?.grievances).toHaveLength(1);
    expect(ivo.social.Bram?.sentiment).toBe(2.5);
    expect(ivo.growth.rationalityBonus).toBe(0);
  });

  it('not while worked up; and mobs joined without a second thought make one more conformist', async () => {
    const s = world(sheep);
    set(s, 'Eve', (p) => ({ ...p, sentiment: 3, evidence: 7 }));
    s.update('workmem', (w) => [...w, { id: 'w1', text: 'Everyone is against Eve, and so am I', salience: 0.6, source: 'self_observed', ts: T, aboutAgent: 'Eve' }], 'test');
    const r = new Reflection({ store: s, bus: new AgentBus(), logger: nullLogger(), llm: null, me: 'Ivo', levers: () => leversFor(0.5), rng: () => 0.5, now: () => T });
    s.update('emotions', (e) => ({ ...e, arousal: 0.8 }), 'test');
    s.update('growth', (g) => ({ ...g, mobParticipations: 2 }), 'test');
    await r.run('test');
    expect(s.state.growth.conformityBonus).toBe(0);
    s.update('emotions', (e) => ({ ...e, arousal: 0.1 }), 'test');
    await r.run('test');
    // Ivo (rationality 0.1) wasn't convinced the crowd was wrong: two mobs, +0.02 conformity.
    expect(s.state.social.Eve?.sentiment).toBe(3);
    expect(s.state.growth.conformityBonus).toBeCloseTo(0.02);
  });

  it('with a model: L3 audits the candidates, and nobody it wasn’t asked about is touched', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let tier = '';
    fake.chat = ({ body }) => {
      tier = String(body.model);
      return { text: JSON.stringify({ corrections: [{ who: 'Bram', kind: 'hearsay', why: 'Cass said so, Bram never did' }, { who: 'Zed', kind: 'idol', why: 'made up' }] }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = world(sage, ['Bram', 'Zed']);
    set(s, 'Bram', (x) => ({ ...told(x), sentiment: 2.5, evidence: 7 }));
    s.update('heardOpinions', () => [{ speaker: 'Cass', target: 'Bram', valence: -0.7, ts: T }], 'test');
    set(s, 'Zed', (p) => ({ ...p, admiration: 0.9 }));
    const r = new Reflection({ store: s, bus: new AgentBus(), logger: nullLogger(), llm: rt.client, me: 'Ana', levers: () => leversFor(0.9), rng: () => 0.5, now: () => T });
    await r.run('test');
    expect(tier).toBe('p1-big');
    expect(s.state.social.Bram?.inoculated).toEqual(['conformity']);
    expect(s.state.social.Zed?.admiration).toBe(0.9);
    rt.stop();
  });

  it('inoculation halves that bias about that person, for good', () => {
    const s = world();
    set(s, 'Bram', (p) => ({ ...p, inoculated: ['halo', 'conformity'] }));
    expect(susceptibilityToward(s.state, 'halo', 'Bram')).toBeCloseTo(sage.mind.biasProfile.halo * 0.5);
    expect(susceptibilityToward(s.state, 'halo', 'Cass')).toBeCloseTo(sage.mind.biasProfile.halo);
    expect(inoculation(s.state, 'conformity', 'Bram')).toBe(0.5);
    s.update('growth', (g) => ({ ...g, rationalityBonus: 0.2 }), 'test');
    expect(rationalityOf(s.state)).toBe(1);
  });
});

describe('fear and conformity (§18.4.1)', () => {
  it('under a feared leader grievances go unvoiced; a dissenter speaks up anyway', () => {
    const s = world().state;
    const st: AgentState = { ...s, perception: { ...s.perception, nearbyEntities: [ent('Cass', 3)] } };
    const ctx = (quiet: number): PowerMoveCtx => ({
      isStuck: () => false,
      power: { leader: () => null, coalition: (t) => ({ target: t, members: [], power: 0, against: 1, opening: false }), knownResenters: () => ['Cass'], saidLately: () => false, quiet: () => quiet },
      resentmentOf: (n) => (n === 'Bram' ? 0.8 : 0),
      mayBrawl: () => false,
      mayKill: () => false,
      liking: () => 7,
      candidates: ['Cass'],
      roll: 0.5,
    });
    expect(gossipMove(st, ctx(0.9))).toBeNull();
    expect(gossipMove(st, ctx(0.1))?.speechIntent?.gist).toMatch(/Bram wronged you too/);
  });

  function watch(persona = sage) {
    const s = world(persona, ['Rex', 'Bo', 'Cy']);
    const bus = new AgentBus();
    const t = { now: T };
    const pw = new PowerWatch({ store: s, bus, logger: nullLogger(), me: persona.name, mode: 'test', powerOf: () => 0.3, myPower: () => 0.3, fearOf: () => 0.5, now: () => t.now });
    pw.start();
    stops.push(() => pw.stop());
    const tick = () => (pw as unknown as { tick(): void }).tick();
    return { s, bus, t, pw, tick };
  }

  it('defiance that goes unpunished is seen: the demander looks weaker, and it is remembered', () => {
    const w = watch();
    w.bus.emit({ type: 'heard', utterance: say('d1', 'Rex', 'give me 3 bread, or else', false, ['Bo']) });
    w.t.now += 5000;
    w.bus.emit({ type: 'heard', utterance: say('d2', 'Bo', 'get lost.', false, ['Rex']) });
    w.t.now += 30_000;
    w.tick();
    expect(w.s.state.social.Rex?.defiedSeen).toBeUndefined();
    w.t.now += 40_000;
    w.tick();
    expect(w.s.state.social.Rex?.defiedSeen).toEqual([w.t.now]);
    expect(w.s.state.workmem.at(-1)?.text).toBe('Bo stood up to Rex, and Rex did nothing');
    // Answered with blows, it doesn't count.
    w.bus.emit({ type: 'heard', utterance: say('d3', 'Rex', 'give me 3 bread, or else', false, ['Cy']) });
    w.bus.emit({ type: 'heard', utterance: say('d4', 'Cy', 'no way', false, ['Rex']) });
    w.bus.emit({ type: 'observedAction', action: { id: 'x1', actor: 'Rex', kind: 'attack', target: 'Cy', ts: w.t.now } });
    w.t.now += 70_000;
    w.tick();
    expect(w.s.state.social.Rex?.defiedSeen).toHaveLength(1);
  });

  it('fear of someone seen defied with impunity falls', () => {
    const s = world(sage, ['Rex']);
    const bus = new AgentBus();
    const ce = new ConflictEvaluator({ store: s, bus, logger: nullLogger(), me: 'Ana', config: WorldConfigSchema.parse({}).conflict, mode: 'test', myGear: () => 0, bornAt: 0, now: () => T });
    set(s, 'Rex', (p) => ({ ...p, gearScore: 0.8 }));
    const before = ce.pressureOf('Rex').fear;
    set(s, 'Rex', (p) => ({ ...p, defiedSeen: [T - 1000, T - 2000] }));
    expect(ce.pressureOf('Rex').fear).toBeCloseTo(before * 0.7);
  });

  it('tribute seen paid: those asked who then handed it over; a leader by it; paying comes easier when most paid', () => {
    const w = watch();
    for (const [i, who] of ['Bo', 'Cy'].entries()) {
      w.bus.emit({ type: 'heard', utterance: say(`r${i}`, 'Rex', 'give me 3 bread, or else', false, [who]) });
      w.bus.emit({ type: 'observedAction', action: { id: `g${i}`, actor: who, kind: 'gave', target: 'Rex', item: 'bread', qty: 3, ts: w.t.now } });
    }
    expect(w.pw.tributeSeen('Rex')).toBe(2);
    expect(w.pw.tributeShare('Rex')).toBe(1);
    w.tick();
    expect(w.s.state.social.Rex?.perceivedRole).toBe('leader');
    // The bandwagon lowers the bar to give in.
    const st = world(person('Tib', { rationality: 0.2, conformity: 0.8 }), ['Rex']).state;
    const heard: AgentState = { ...st, self: { ...st.self, inventory: [{ item: 'bread', qty: 5 }] }, perception: { ...st.perception, heardSpeech: [{ ...say('q', 'Rex', 'give me 3 bread, or else', true), to: ['Tib'] }] } };
    const view = (bandwagon: number): ConflictView => ({ rungOf: () => 0, fearOf: () => 0.75, mayBrawl: () => false, resentmentOf: () => 0.1, bandwagon: () => bandwagon, warnedLately: () => false });
    expect(codeDecision(heard, { from: 'Rex', convId: 'c1' }, false, () => false, { candidates: [], roll: 1, conflict: view(0) })?.task).toBeUndefined();
    expect(codeDecision(heard, { from: 'Rex', convId: 'c1' }, false, () => false, { candidates: [], roll: 1, conflict: view(0.2) })?.task?.skill).toBe('give');
  });
});

describe('saying what one thinks of someone (§18.4.1)', () => {
  it('reads the question, and the answer says what is felt, pulled toward a safe word by the fear of speaking up', () => {
    expect(readOpinionAsk('Ana, what do you think of Rex?', ['Rex', 'Bo'])).toBe('Rex');
    expect(readOpinionAsk('how do you feel about bo', ['Rex', 'Bo'])).toBe('Bo');
    expect(readOpinionAsk('what do you think of the weather', ['Rex'])).toBeNull();
    expect(needsDecision('what do you make of Rex?')).toBe(true);
    expect(statedOpinion(-0.8, 0)).toBeCloseTo(-0.8);
    expect(statedOpinion(-0.8, 1)).toBeCloseTo(0.3);
    expect(statedOpinion(-0.8, 0.4)).toBeCloseTo(-0.36);
    // A good opinion has nothing to hide.
    expect(statedOpinion(0.7, 1)).toBeCloseTo(0.7);
    // Worded so that whoever hears it reads it the same way.
    const read = (v: number) => readOpinions(opinionLine('Rex', v), 'Ana', ['Rex'], T)[0]?.valence ?? 0;
    expect([0.8, 0.3, 0, -0.3, -0.8].map(read)).toEqual([0.6, 0.3, 0, -0.4, -0.7]);
  });

  it('the code default answers it: the frightened echo a safe word, the unafraid say what they feel', () => {
    const s = world(sheep, ['Rex', 'Quill']);
    set(s, 'Rex', (p) => ({ ...p, sentiment: 1.5 }));
    s.update('perception', (p) => ({ ...p, heardSpeech: [{ ...say('q1', 'Quill', 'Ivo, what do you think of Rex?', true), to: ['Ivo'] }] }));
    const view: ConflictView = { rungOf: () => 0, fearOf: () => 0.9, mayBrawl: () => false, resentmentOf: () => 0.8, warnedLately: () => true };
    const power = (quiet: number) => ({ leader: () => null, coalition: (x: string) => ({ target: x, members: [], power: 0, against: 1, opening: false }), knownResenters: () => [], saidLately: () => false, quiet: () => quiet });
    const answer = (quiet: number) => codeDecision(s.state, { from: 'Quill', convId: 'c1' }, false, () => false, { candidates: [], roll: 1, conflict: view, power: power(quiet) })?.speechIntent;
    expect(answer(1)).toMatchObject({ stance: 'inform', gist: "Rex isn't mean, I suppose.", mayCommit: false });
    expect(answer(0)).toMatchObject({ stance: 'inform', gist: "Rex is a bully. I can't stand Rex." });
  });
});

describe('in-group, attribution and sunk cost (§18.4)', () => {
  it("a wrong weighs as the agent's view of the wrongdoer makes it", () => {
    const s = world(sage, ['Bram', 'Cass']);
    const ce = new ConflictEvaluator({
      store: s,
      bus: new AgentBus(),
      logger: nullLogger(),
      me: 'Ana',
      config: WorldConfigSchema.parse({}).conflict,
      mode: 'test',
      myGear: () => 0,
      bornAt: 0,
      grievanceScale: (n) => (n === 'Bram' ? 0.75 : 1.25),
      now: () => T,
    });
    ce.grieve('Bram', 'theft', true, 'Bram took my logs');
    ce.grieve('Cass', 'theft', true, 'Cass took my logs');
    expect(s.state.social.Bram?.grievances[0]?.weight).toBeCloseTo(0.4 * 0.75);
    expect(s.state.social.Cass?.grievances[0]?.weight).toBeCloseTo(0.4 * 1.25);
  });

  it('half an hour of following someone makes walking away harder', () => {
    const run = (followedMin: number) => {
      const s = world(person('Tib', { rationality: 0.2, conformity: 0.6 }), ['Rex', 'Bo', 'Cy']);
      const bus = new AgentBus();
      const t = { now: T };
      const powers: Record<string, number> = { Rex: 0.6, Bo: 0.2, Cy: 0.2, Tib: 0.1 };
      const pw = new PowerWatch({ store: s, bus, logger: nullLogger(), me: 'Tib', mode: 'test', powerOf: (n) => powers[n] ?? 0.3, myPower: () => 0.1, fearOf: (n) => (n === 'Rex' ? 0.6 : 0), sunkCost: () => 1, now: () => t.now });
      pw.start();
      stops.push(() => pw.stop());
      const paid = (i: number) => ({ id: `p${i}`, debtor: 'Tib', creditor: 'Rex', what: { kind: 'give' as const, item: 'bread', qty: 3, text: '3 bread' }, coerced: true, status: 'fulfilled' as const, createdFromConv: 'c', createdAt: t.now, resolvedAt: t.now - i * 1000 });
      s.update('commitments', () => [paid(1), paid(2)], 'test');
      (pw as unknown as { tick(): void }).tick();
      t.now += followedMin * 60_000;
      s.update('commitments', () => [paid(1), paid(2)], 'test');
      for (const a of ['Bo', 'Cy']) bus.emit({ type: 'observedAction', action: { id: `a${a}`, actor: a, kind: 'attack', target: 'Rex', ts: t.now } });
      return pw.standsBy('Rex');
    };
    expect(run(1)).toBe(false);
    expect(run(40)).toBe(true);
  });
});
