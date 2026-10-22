// M9a (§19.1, §19.2, §19.6, §19.10): romance without Minecraft. Who can be attracted to whom and how much, the sex
// one says one is or others take one to be, the PG line filter, and the trait-weighted reactions to an advance and
// to a rejection (scenarios W and X). Live courtship, rejection and jealousy are in tests/live/m9a-romance.test.ts.

import { describe, expect, it } from 'vitest';
import { type DecisionOutput, type Persona, type PersonaInput, PersonaSchema, SeededRandom, type SocialProfile, WorldConfigSchema, generatePersona, loadSexDifferences, nullLogger } from '@agora/shared';
import { AgentBus } from '@agora/agent/bus';
import { ACCEPTANCE, type CourtStep, DECLINE_LINES, FLIRT_BACK, PROPOSAL, type RomanceView, RomanceWatch, isAdvance } from '@agora/agent/social/romanceWatch';
import type { Body } from '@agora/agent/body/body';
import { codeDecision, validateDecision } from '@agora/agent/modules/cc';
import { Conversations } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { Talking, needsDecision } from '@agora/agent/modules/talking';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import {
  type AdvanceContext,
  type AdvanceReaction,
  NOT_PG_RE,
  type RejectionReaction,
  advanceWeights,
  attraction,
  orientationFit,
  persistenceCap,
  pronounSex,
  rejectionWeights,
  rollReaction,
  statedSex,
} from '@agora/agent/social/romance';

const someone = (o: Partial<PersonaInput> & { name: string }): Persona => PersonaSchema.parse({ sex: 'female', traits: ['plain'], ...o });

describe('who can be attracted to whom (§19.1, §19.2)', () => {
  it('follows orientation, and is cautious about someone whose sex is not known yet', () => {
    expect(orientationFit('hetero', 'male', 'female')).toBe(1);
    expect(orientationFit('hetero', 'male', 'male')).toBe(0);
    expect(orientationFit('homo', 'female', 'female')).toBe(1);
    expect(orientationFit('homo', 'female', 'male')).toBe(0);
    expect(orientationFit('bi', 'female', 'male')).toBe(1);
    expect(orientationFit('hetero', 'female', 'unknown')).toBe(0.5);
  });

  it('weighs what shows by vanity and the rest by how well they would get on; time together and gifts add a little', () => {
    const looks = { superficial: 0.6, compatibility: 0.2, sharedTime: 0, gifts: 0 };
    expect(attraction(0.9, looks)).toBeGreaterThan(attraction(0.1, looks));
    expect(attraction(0.5, { ...looks, sharedTime: 1, gifts: 1 })).toBeCloseTo(attraction(0.5, looks) + 0.45, 5);
    expect(attraction(1, { superficial: 1, compatibility: 1, sharedTime: 1, gifts: 1 })).toBe(1);
  });

  it('reads the sex someone says they are, and the pronoun others use for someone', () => {
    expect(statedSex("I'm a guy who loves mining")).toBe('male');
    expect(statedSex('as a woman I can tell you, that cave is deep')).toBe('female');
    expect(statedSex('I am a builder')).toBeNull();
    expect(pronounSex("Rex took my iron. I can't stand him")).toBe('male');
    expect(pronounSex('Pia? she is lovely')).toBe('female');
    expect(pronounSex('he said she would come')).toBeNull();
  });

  it('lets no line through that is not PG, and leaves game talk alone', () => {
    for (const t of ['you look sexy today', 'wanna sleep with me?', 'send nudes', 'you turn me on']) expect(NOT_PG_RE.test(t)).toBe(true);
    for (const t of ["let's strip mine down here", 'I stripped those logs', "I'm naked without my armor", 'tit for tat', 'you look lovely today', 'can I hold your hand?']) {
      expect(NOT_PG_RE.test(t)).toBe(false);
    }
  });

  it('caps how often a suitor may try again in a week, tighter for the agreeable', () => {
    expect(persistenceCap(1)).toBe(1);
    expect(persistenceCap(0.5)).toBe(2);
    expect(persistenceCap(0)).toBe(3);
  });
});

const ctx = (o: Partial<AdvanceContext> = {}): AdvanceContext => ({ attraction: 0.2, admiration: 0.2, sentiment: 5, status: 0.5, friction: 0, resentment: 0, joy: 0.2, attempt: 0, ...o });

function shares<K extends string>(n: number, roll: () => K): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const k = roll();
    out[k] = (out[k] ?? 0) + 1 / n;
  }
  return out;
}

describe('how an advance is taken (§19.10 A)', () => {
  const p = someone({ name: 'Ivy', big5: { agreeableness: 0.6, extraversion: 0.5, neuroticism: 0.5 }, mind: { vanity: 0.4 } });

  it('is returned by one who is drawn to them, and mostly declined politely by one who is not', () => {
    const rng = new SeededRandom(7);
    const drawn = shares(2000, () => rollReaction<AdvanceReaction>(advanceWeights(p, ctx({ attraction: 0.85, admiration: 0.5, sentiment: 7 })), () => rng.next()));
    expect(drawn.reciprocate ?? 0).toBeGreaterThan(0.7);
    const cool = shares(2000, () => rollReaction<AdvanceReaction>(advanceWeights(p, ctx({ attraction: 0.1 })), () => rng.next()));
    expect(cool.reciprocate ?? 0).toBeLessThan(0.02);
    expect(cool.politeDecline ?? 0).toBeGreaterThan(0.4);
    expect(cool.hostile ?? 0).toBeLessThan(0.05);
  });

  it('X: a disliked suitor of low standing, proposing to someone vain, is often met with disgust', () => {
    const vain = someone({ name: 'Zoe', big5: { agreeableness: 0.3, neuroticism: 0.6 }, mind: { vanity: 0.95 } });
    const rng = new SeededRandom(19);
    const lowly = shares(2000, () => rollReaction<AdvanceReaction>(advanceWeights(vain, ctx({ attraction: 0.05, sentiment: 2, status: 0.05, friction: 0.4 })), () => rng.next()));
    const liked = shares(2000, () => rollReaction<AdvanceReaction>(advanceWeights(p, ctx({ attraction: 0.05, sentiment: 6, status: 0.7 })), () => rng.next()));
    expect(lowly.disgusted ?? 0).toBeGreaterThan(0.25);
    expect(liked.disgusted ?? 0).toBeLessThan(0.08);
    // Every further attempt makes the unwelcome reactions half as likely again.
    const again = shares(2000, () => rollReaction<AdvanceReaction>(advanceWeights(p, ctx({ attraction: 0.05, sentiment: 6, status: 0.7, attempt: 2 })), () => rng.next()));
    expect((again.uncomfortable ?? 0) + (again.disgusted ?? 0) + (again.hostile ?? 0)).toBeGreaterThan((liked.uncomfortable ?? 0) + (liked.disgusted ?? 0) + (liked.hostile ?? 0));
  });

  it('has System 2 veto the hostile option now and then: never, with no override; always, with full', () => {
    const w: Record<AdvanceReaction, number> = { reciprocate: 0, politeDecline: 0.01, ignore: 0, uncomfortable: 0, disgusted: 0, hostile: 100 };
    const rng = new SeededRandom(3);
    expect(rollReaction(w, () => rng.next(), 0)).toBe('hostile');
    expect(rollReaction(w, () => rng.next(), 1)).toBe('politeDecline');
  });
});

describe('W: how a rejection is taken, over a population (§19.10 B)', () => {
  const world = WorldConfigSchema.parse({});
  const diffs = loadSexDifferences();

  function reject(n: number, seed: number): { counts: Record<RejectionReaction, number>; rage: number[]; rest: number[] } {
    const rng = new SeededRandom(seed);
    const taken = new Set<string>();
    const counts: Record<RejectionReaction, number> = { graceful: 0, sadWithdrawal: 0, persist: 0, jealousy: 0, resentment: 0, rage: 0 };
    const rage: number[] = [];
    const rest: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = generatePersona({ rng, world, sexDiffs: diffs, takenNames: taken });
      const c = {
        romanticInterest: 0.5 + 0.5 * rng.next(),
        rival: rng.next() < 0.3,
        public: rng.next() < 0.3,
        shame: 0.2,
        arousal: 0.2 + 0.4 * rng.next(),
        combat: p.abilities.combat,
        attemptsLeft: persistenceCap(p.big5.agreeableness),
      };
      const r = rollReaction(rejectionWeights(p, c), () => rng.next(), p.mind.rationality * 0.6);
      counts[r]++;
      (r === 'rage' ? rage : rest).push(p.temperament.aggression * p.mind.impulsivity);
    }
    return { counts, rage, rest };
  }

  it('is mostly graceful or sad, a minority jealous or resentful, and rage at most 5 % of 100', () => {
    const { counts } = reject(100, 2026);
    expect(counts.graceful + counts.sadWithdrawal).toBeGreaterThanOrEqual(55);
    expect(counts.jealousy + counts.resentment).toBeGreaterThan(0);
    expect(counts.jealousy + counts.resentment).toBeLessThan(counts.graceful + counts.sadWithdrawal);
    expect(counts.rage).toBeLessThanOrEqual(5);
  });

  it('rages the more, the more aggressive and impulsive', () => {
    const { counts, rage, rest } = reject(4000, 1910);
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
    expect(counts.rage).toBeGreaterThan(0);
    expect(counts.rage / 4000).toBeLessThanOrEqual(0.05);
    expect(mean(rage)).toBeGreaterThan(mean(rest) * 1.5);
  });

  it('persists only while attempts are left, and is jealous only of a rival there is', () => {
    const p = someone({ name: 'Ned', sex: 'male', big5: { agreeableness: 0.1 }, abilities: { intelligence: 0.2 } });
    const base = { romanticInterest: 0.9, rival: false, public: false, shame: 0, arousal: 0.2, combat: 0.4, attemptsLeft: 2 };
    expect(rejectionWeights(p, base).persist).toBeGreaterThan(0);
    expect(rejectionWeights(p, { ...base, attemptsLeft: 0 }).persist).toBe(0);
    expect(rejectionWeights(p, base).jealousy).toBe(0);
    expect(rejectionWeights(p, { ...base, rival: true }).jealousy).toBeGreaterThan(0);
  });
});

// ---- The romance watch: one agent's side of it ----

const ned = PersonaSchema.parse({ name: 'Ned', sex: 'male', orientation: 'hetero', traits: ['kind'], big5: { agreeableness: 0.5 }, mind: { vanity: 0.2 } });

function rig(persona: Persona = ned, people: string[] = ['Ivy', 'Bea']) {
  const t = { now: 10_000_000 };
  const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: t.now }));
  s.update('social', (all) => ({ ...all, ...Object.fromEntries(people.map((n) => [n, { ...newSocialProfile(n, persona, t.now), sentiment: 7 }])) }));
  const bus = new AgentBus();
  const felt: string[] = [];
  const grieved: string[] = [];
  const said: string[] = [];
  const impulses: string[] = [];
  const w = new RomanceWatch({
    store: s,
    bus,
    logger: nullLogger(),
    me: persona.name,
    feel: (ev, who) => void felt.push(`${ev.kind}${who ? `:${who}` : ''}`),
    grieve: (n, kind) => void grieved.push(`${kind}:${n}`),
    say: (to, text) => void said.push(`${to}: ${text}`),
    impulse: (out) => (impulses.push(out.rationale), true),
    rng: () => 0.5,
    now: () => t.now,
    tickMs: 60_000_000,
  });
  w.start();
  const tick = () => (w as unknown as { tick(): void }).tick();
  const see = (...who: [string, number][]) => s.update('perception', (p) => ({ ...p, nearbyEntities: who.map(([name, d], i) => ({ id: i + 1, kind: 'player' as const, name, pos: { x: d, y: 0, z: 0 }, distance: d, visible: true, heldItem: null, armor: [], lastSeen: t.now, hurtRecently: false })) }));
  const hear = (from: string, text: string, toMe = true) =>
    bus.emit({ type: 'heard', utterance: { id: `u${Math.random()}`, convId: 'c1', from, to: [persona.name], text, ts: t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: toMe } });
  const decide = (d: Partial<DecisionOutput> & { romance: NonNullable<DecisionOutput['romance']> }) =>
    bus.emit({ type: 'decision', decision: { option: 'court', terminate: { maxSeconds: 30 }, rationale: 'test', ...d, id: `d${t.now}`, createdAt: t.now, stateVersion: 1, source: 'default' } });
  return { s, bus, w, t, tick, see, hear, decide, felt, grieved, said, impulses };
}

describe('the romance watch (§19.1, §19.2)', () => {
  it("returns a partner's kindness rather than rolling it as a suitor's advance, while still fond of them", () => {
    const vain = PersonaSchema.parse({ name: 'Ned', sex: 'male', orientation: 'hetero', traits: ['vain'], big5: { agreeableness: 0.9, conscientiousness: 0.9 }, mind: { vanity: 1 } });
    const r = rig(vain);
    // Hardly any looks to go by: as a suitor's advance, a kind no is the likely roll.
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), perceivedSex: 'female', sentiment: 6, evidence: 6 } }));
    expect(r.w.reactionTo('Ivy')).not.toBe('reciprocate');
    r.s.update('family', (f) => ({ ...f, partner: 'Ivy' }));
    expect(r.w.reactionTo('Ivy')).toBe('reciprocate');
    // Gone cold, the table again (and a breakup coming).
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), sentiment: 3, evidence: 3 } }));
    expect(r.w.reactionTo('Ivy')).not.toBe('reciprocate');
  });

  it('learns the sex one says one is, and the pronoun used for the one a line is about, once', () => {
    const r = rig();
    r.hear('Ivy', "hey! I'm a gal who loves exploring.");
    expect(r.s.state.social.Ivy?.perceivedSex).toBe('female');
    r.hear('Ivy', "Bea? he's out mining");
    expect(r.s.state.social.Bea?.perceivedSex).toBe('male');
    r.hear('Ivy', 'Bea, she said so');
    expect(r.s.state.social.Bea?.perceivedSex).toBe('male');
  });

  it('is drawn to someone over time spent together, and a crush comes of it', () => {
    const r = rig();
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), perceivedSex: 'female', sentiment: 9, admiration: 0.6 } }));
    r.see(['Ivy', 3]);
    for (let i = 0; i < 120 && r.s.state.social.Ivy?.relationship !== 'crush'; i++) {
      r.t.now += 10_000;
      r.tick();
    }
    expect(r.s.state.social.Ivy?.relationship).toBe('crush');
    expect(r.felt).toContain('nearCrush:Ivy');
    // Not someone of the sex we're not drawn to.
    r.s.update('social', (all) => ({ ...all, Bea: { ...(all.Bea as SocialProfile), perceivedSex: 'male', sentiment: 9, admiration: 0.6 } }));
    r.see(['Bea', 3]);
    for (let i = 0; i < 60; i++) {
      r.t.now += 10_000;
      r.tick();
    }
    expect(r.s.state.social.Bea?.romanticInterest).toBe(0);
    expect(r.w.mayCourt('Bea')).toMatch(/not someone you are drawn to/);
  });

  it('courts one it is drawn to: a compliment, a small gift, and the question once they have returned it twice', () => {
    const r = rig();
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), perceivedSex: 'female', sentiment: 8, romanticInterest: 0.8, relationship: 'crush' } }));
    r.see(['Ivy', 5]);
    const first = r.w.courtship();
    expect(first?.kind).toBe('flirt');
    r.decide({ target: { agent: 'Ivy' }, speechIntent: { stance: 'flirt', gist: 'you look lovely today.', mayCommit: false }, romance: { with: 'Ivy', phase: 'flirt' } });
    expect(r.s.state.social.Ivy?.relationship).toBe('courting');
    // Paced: no second compliment at once.
    expect(r.w.courtship()).toBeNull();
    r.hear('Ivy', "Ned, hehe, you're sweet too.");
    expect(r.felt).toContain('welcomeAdvance:Ivy');
    // A flower to give: a small gift.
    r.s.update('self', (x) => ({ ...x, inventory: [{ item: 'poppy', qty: 1 }] }));
    r.t.now += 4 * 60_000;
    expect(r.w.courtship()).toMatchObject({ kind: 'gift', item: 'poppy' });
    r.decide({ target: { agent: 'Ivy' }, task: { skill: 'give', args: { to: 'Ivy', item: 'poppy', qty: 1 } }, speechIntent: { stance: 'flirt', gist: 'this is for you.', mayCommit: false }, romance: { with: 'Ivy', phase: 'flirt' } });
    r.hear('Ivy', 'Ned, you always make me smile.');
    // Returned twice: the question.
    r.t.now += 4 * 60_000;
    expect(r.w.courtship()).toMatchObject({ kind: 'propose' });
    r.decide({ target: { agent: 'Ivy' }, speechIntent: { stance: 'propose', gist: 'will you be my partner?', mayCommit: false }, romance: { with: 'Ivy', phase: 'propose' } });
    r.hear('Ivy', "Ned, yes! I'd love to be your partner.");
    expect(r.s.state.family.partner).toBe('Ivy');
    expect(r.s.state.social.Ivy).toMatchObject({ relationship: 'partner', kin: 'partner' });
    expect(r.w.mindLines()).toContain('Ivy is your partner.');
    // Partners court no one else.
    expect(r.w.mayCourt('Bea')).toMatch(/Ivy is your partner/);
  });

  it('returning a compliment is no attempt of ours and waits for no answer; our own next one waits a while', () => {
    const r = rig();
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), perceivedSex: 'female', sentiment: 8, romanticInterest: 0.8, relationship: 'crush' } }));
    r.see(['Ivy', 5]);
    r.hear('Ivy', 'Ned, you look lovely today.');
    r.decide({ option: 'rest', target: { agent: 'Ivy' }, speechIntent: { stance: 'flirt', gist: FLIRT_BACK, mayCommit: false }, romance: { with: 'Ivy', phase: 'return' } });
    expect(r.s.state.family.advances.Ivy).toBeUndefined();
    expect(r.w.courtship()).toBeNull();
    // Nothing was asked of her: a "no" now is no rejection.
    r.hear('Ivy', 'no, not that one');
    expect(r.felt.some((f) => f.startsWith('rejected'))).toBe(false);
    r.t.now += 4 * 60_000;
    expect(r.w.courtship()?.kind).toBe('flirt');
  });

  it('takes a no as rolled, and leaves them be once they have said no too often this week (the soft cap)', () => {
    const vain = PersonaSchema.parse({ ...ned, big5: { agreeableness: 1 }, temperament: { vengefulness: 0.9 } });
    const r = rig(vain);
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), perceivedSex: 'female', romanticInterest: 0.9, relationship: 'courting' } }));
    r.see(['Ivy', 4]);
    const cap = persistenceCap(1);
    for (let i = 0; i <= cap; i++) {
      r.decide({ target: { agent: 'Ivy' }, speechIntent: { stance: 'propose', gist: 'will you be my partner?', mayCommit: false }, romance: { with: 'Ivy', phase: 'propose' } });
      r.hear('Ivy', "Ned, that's sweet of you, but I don't feel that way.");
      r.t.now += 60_000;
    }
    expect(r.s.state.family.advances.Ivy?.rejections).toBe(cap + 1);
    expect(r.felt.filter((f) => f === 'turnedDown:Ivy').length).toBe(cap + 1);
    expect(r.said.length).toBeGreaterThan(0);
    expect(r.w.mayCourt('Ivy')).toMatch(/said no too often/);
    r.t.now += 4 * 60_000;
    expect(r.w.courtship()).toBeNull();
  });

  it('is jealous of one seen courting its partner, breaks up when told, and grieves a partner killed', () => {
    const r = rig(ned, ['Ivy', 'Bea', 'Max']);
    r.s.update('family', (f) => ({ ...f, partner: 'Ivy' }));
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), relationship: 'partner', kin: 'partner', sentiment: 9 } }));
    // Max courts Ivy in our hearing; then they're together near us.
    r.bus.emit({ type: 'heard', utterance: { id: 'u1', convId: 'c2', from: 'Max', to: ['Ivy'], text: 'Ivy, you look lovely today.', ts: r.t.now, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false } });
    r.see(['Ivy', 3], ['Max', 4]);
    r.tick();
    expect(r.felt).toContain('jealous:Max');
    expect(r.grieved).toContain('romantic_rival:Max');
    expect(r.w.mindLines()).toContain('You suspect Max is after Ivy.');
    // Ivy ends it.
    r.hear('Ivy', "Ned, I think we're done.");
    expect(r.s.state.family.partner).toBeUndefined();
    expect(r.s.state.social.Ivy?.relationship).toBe('ex');
    // A new partner, killed: grief, and a grievance that lasts against the killer.
    r.s.update('family', (f) => ({ ...f, partner: 'Bea' }));
    r.bus.emit({ type: 'peerDied', name: 'Bea', cause: 'killed by Max', witnessed: true, killer: 'Max' });
    expect(r.felt).toContain('grief');
    expect(r.grieved).toContain('killed_partner:Max');
    expect(r.s.state.family.partner).toBeUndefined();
  });

  it('seeks out a crush in sight; a partner who coerces or hits them is left', () => {
    const r = rig();
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), perceivedSex: 'female', romanticInterest: 0.55, relationship: 'crush' } }));
    r.see(['Ivy', 15]);
    expect(r.w.courtship()).toEqual({ with: 'Ivy', kind: 'approach' });
    // Paced; and near, only a crush (not yet drawn enough to court): nothing more.
    expect(r.w.courtship()).toBeNull();
    r.see(['Ivy', 4]);
    expect(r.w.courtship()).toBeNull();
    // Partners: then she demands of him under threat.
    r.s.update('family', (f) => ({ ...f, partner: 'Ivy' }));
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), relationship: 'partner', kin: 'partner', relationshipSince: r.t.now, sentiment: 8 } }));
    r.t.now += 60_000;
    r.s.update('social', (all) => ({ ...all, Ivy: { ...(all.Ivy as SocialProfile), grievances: [{ kind: 'coercion', weight: 0.12, ts: r.t.now, witnessed: true, source: 'self_observed' }] } }));
    r.tick();
    expect(r.s.state.family.partner).toBeUndefined();
    expect(r.s.state.social.Ivy?.relationship).toBe('ex');
    expect(r.said).toContain("Ivy: I think we're done.");
  });

  it('turning an advance down: disgust is a grievance and costs them our liking; discomfort keeps us away', () => {
    const r = rig();
    r.decide({ option: 'rest', target: { agent: 'Bea' }, romance: { with: 'Bea', phase: 'decline', reaction: 'disgusted' } });
    expect(r.grieved).toContain('unwanted_advance:Bea');
    expect(r.s.state.social.Bea?.sentiment).toBeCloseTo(5.5);
    expect(r.felt).toContain('unwantedAdvance:Bea');
  });
});

describe('romance in the code default (§19.2, §19.10)', () => {
  const view = (o: Partial<RomanceView> = {}): RomanceView => ({
    partner: () => null,
    relationshipWith: () => 'none',
    courtship: () => null,
    reactionTo: () => 'reciprocate',
    wouldAccept: () => true,
    mayCourt: () => null,
    ...o,
  });
  const withLine = (text: string) => {
    const r = rig();
    r.s.update('perception', (p) => ({ ...p, heardSpeech: [{ id: 'u', convId: 'c1', from: 'Ivy', to: ['Ned'], text, ts: 1, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true }] }));
    return r.s.state;
  };
  const answer = (text: string, romance: RomanceView) => codeDecision(withLine(text), { from: 'Ivy', convId: 'c1' }, false, () => false, { candidates: [], roll: 1, romance });

  it('says yes to a proposal it welcomes, and returns a compliment', () => {
    expect(answer('Ned, will you be my partner?', view())).toMatchObject({ speechIntent: { stance: 'agree', gist: ACCEPTANCE, mayCommit: true }, romance: { with: 'Ivy', phase: 'accept' } });
    expect(answer('Ned, you look lovely today.', view())).toMatchObject({ speechIntent: { stance: 'flirt', gist: FLIRT_BACK }, romance: { with: 'Ivy', phase: 'return' } });
    // Drawn to her, but not ready to be partners: a kind no.
    expect(answer('Ned, will you be my partner?', view({ wouldAccept: () => false }))).toMatchObject({ romance: { phase: 'decline', reaction: 'politeDecline' }, speechIntent: { gist: DECLINE_LINES.politeDecline } });
  });

  it('turns one down as the roll has it, and an ignored one gets no answer', () => {
    expect(answer('Ned, will you be my partner?', view({ reactionTo: () => 'disgusted' }))).toMatchObject({ speechIntent: { stance: 'decline', gist: DECLINE_LINES.disgusted }, romance: { phase: 'decline', reaction: 'disgusted' } });
    expect(answer('Ned, you look lovely today.', view({ reactionTo: () => 'hostile' }))?.speechIntent).toMatchObject({ stance: 'hostile', gist: DECLINE_LINES.hostile });
    expect(answer('Ned, you look lovely today.', view({ reactionTo: () => 'ignore' }))?.speechIntent?.stance).toBe('none');
  });

  it('courts when it is time, and the gate keeps a model from courting whom it may not', () => {
    const s = rig().s.state;
    const court = (step: CourtStep) => codeDecision(s, {}, false, () => false, { candidates: [], roll: 1, romance: view({ courtship: () => step }) });
    expect(court({ with: 'Ivy', kind: 'flirt', line: 'you look lovely today.' })).toMatchObject({ option: 'court', target: { agent: 'Ivy' }, speechIntent: { stance: 'flirt', gist: 'you look lovely today.' }, romance: { phase: 'flirt' } });
    expect(court({ with: 'Ivy', kind: 'gift', item: 'poppy' })).toMatchObject({ option: 'court', task: { skill: 'give', args: { to: 'Ivy', item: 'poppy', qty: 1 } } });
    expect(court({ with: 'Ivy', kind: 'propose' })).toMatchObject({ option: 'court', speechIntent: { stance: 'propose', gist: PROPOSAL }, romance: { phase: 'propose' } });
    expect(court({ with: 'Ivy', kind: 'approach' })).toMatchObject({ option: 'move', target: { agent: 'Ivy' } });
    const env = { me: 'Ned', isStuck: () => false, canPerceive: () => true, mayCourt: (n: string) => (n === 'Bea' ? 'Bea is family' : null) };
    expect(validateDecision({ option: 'court', target: { agent: 'Bea' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toMatch(/can't court Bea: Bea is family/);
    expect(validateDecision({ option: 'talk', target: { agent: 'Bea' }, romance: { with: 'Bea', phase: 'propose' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toMatch(/can't court Bea/);
    expect(validateDecision({ option: 'rest', target: { agent: 'Bea' }, romance: { with: 'Bea', phase: 'return' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toMatch(/can't court Bea/);
    expect(validateDecision({ option: 'court', target: { agent: 'Ivy' }, terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toBeNull();
    expect(validateDecision({ option: 'court', terminate: { maxSeconds: 30 }, rationale: 'r' }, env)).toMatch(/needs target.agent/);
  });

  it('takes a compliment or a proposal for something that wants an answer', () => {
    expect(needsDecision('Ned, you look lovely today.')).toBe(true);
    expect(needsDecision('will you be my partner?')).toBe(true);
    expect(needsDecision('nice weather today')).toBe(false);
    // A compliment returned answers ours: it wants no answer of its own (or the two would go on returning it).
    expect(needsDecision(`Ned, ${FLIRT_BACK}`)).toBe(false);
    expect(isAdvance("aww, you're sweet yourself")).toBe(false);
    expect(isAdvance("you're really sweet, you know that?")).toBe(true);
  });
});

describe('saying it, PG (§19.1, §19.6)', () => {
  function talker(persona: Persona) {
    const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: 0 }));
    s.update('perception', (p) => ({ ...p, nearbyEntities: [{ id: 1, kind: 'player', name: 'Ivy', pos: { x: 3, y: 0, z: 0 }, distance: 3, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }] }));
    const bus = new AgentBus();
    const said: string[] = [];
    const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: persona.name, inRange: () => ['Ivy'], rng: () => 0 });
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: persona.name, rng: () => 0 });
    conversations.start();
    talking.start();
    let n = 0;
    const decideRaw = (o: Pick<DecisionOutput, 'option' | 'speechIntent'>) => {
      const d = { id: `x${++n}`, createdAt: 0, stateVersion: 1, source: 'default' as const, target: { agent: 'Ivy' }, terminate: { maxSeconds: 30 }, rationale: 'test', ...o };
      s.set('decision', d, 'test');
      bus.emit({ type: 'decision', decision: d });
    };
    const decide = (id: string, option: 'talk' | 'court', stance: 'chat' | 'flirt' | 'propose', gist: string) => {
      const d = { id, createdAt: 0, stateVersion: 1, source: 'default' as const, option, target: { agent: 'Ivy' }, speechIntent: { stance, gist, mayCommit: false }, terminate: { maxSeconds: 30 }, rationale: 'test' };
      s.set('decision', d, 'test');
      bus.emit({ type: 'decision', decision: d });
    };
    // A line from Ivy, put to us.
    const addressed = (id: string, text: string) => {
      const conv = conversations.withPartner('Ivy') ?? conversations.open('Ivy', false);
      bus.emit({ type: 'addressed', utterance: { id, convId: conv.convId, from: 'Ivy', to: ['Ned'], text, ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: true } });
    };
    return { said, decide, decideRaw, addressed, bus, conversations };
  }
  const wait = async (said: string[], n: number) => {
    for (let i = 0; i < 60 && said.length < n; i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('says who it is in a first hello, and courting lines as worded, to whom they are for', async () => {
    const t = talker(PersonaSchema.parse({ name: 'Ned', sex: 'male', traits: ['kind'], values: ['exploration'] }));
    t.decide('d1', 'talk', 'chat', 'say hello');
    await wait(t.said, 1);
    expect(t.said[0]).toMatch(/I'm a guy who loves exploring\.$/);
    expect(statedSex(t.said[0] ?? '')).toBe('male');
    t.decide('d2', 'court', 'flirt', 'you look lovely today.');
    await wait(t.said, 2);
    expect(t.said[1]).toBe('Ivy, you look lovely today.');
    t.decide('d3', 'court', 'propose', PROPOSAL);
    await wait(t.said, 3);
    expect(t.said[2]).toBe('Ivy, will you be my partner?');
    for (const line of t.said) expect(NOT_PG_RE.test(line)).toBe(false);
  });

  it('courts on purpose: right after a chat with them ended, the line is said all the same; small talk waits', async () => {
    const t = talker(PersonaSchema.parse({ name: 'Ned', sex: 'male', traits: ['kind'], values: ['exploration'] }));
    t.decide('d1', 'talk', 'chat', 'say hello');
    await wait(t.said, 1);
    const conv = t.conversations.withPartner('Ivy');
    if (conv) t.conversations.end(conv.convId, 'test');
    expect(t.conversations.mayInitiate('Ivy')).toBe(false);
    t.decide('d2', 'talk', 'chat', 'say hello again');
    await new Promise((r) => setTimeout(r, 300));
    expect(t.said).toHaveLength(1);
    t.decide('d3', 'court', 'propose', PROPOSAL);
    await wait(t.said, 2);
    expect(t.said[1]).toBe('Ivy, will you be my partner?');
  });

  it('a conversation gone quiet: asks whether they are still there, not for time to think', async () => {
    const t = talker(PersonaSchema.parse({ name: 'Ned', sex: 'male', traits: ['kind'], values: ['exploration'] }));
    const conv = t.conversations.open('Ivy', true);
    t.bus.emit({ type: 'needsDecision', reason: 'nudge', convId: conv.convId });
    await wait(t.said, 1);
    expect(['you still there?', 'hello?', 'still around?']).toContain(t.said[0]);
  });

  it('answering an advance in code: the answer, and no "let me think" after it; an ignored one, nothing at all', async () => {
    const t = talker(PersonaSchema.parse({ name: 'Ned', sex: 'male', traits: ['kind'], values: ['exploration'] }));
    let answer: 'return' | 'ignore' = 'return';
    t.bus.on('needsDecision', (e) => {
      if (e.reason !== 'request') return;
      const gist = answer === 'return' ? FLIRT_BACK : '';
      t.decideRaw({ option: 'rest', speechIntent: { stance: answer === 'return' ? 'flirt' : 'none', gist, mayCommit: false } });
    });
    t.addressed('u1', 'Ned, you look lovely today.');
    await wait(t.said, 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(t.said).toEqual([`Ivy, ${FLIRT_BACK}`]);
    answer = 'ignore';
    t.addressed('u2', "Ned, you're really sweet, you know that?");
    await new Promise((r) => setTimeout(r, 1500));
    expect(t.said).toHaveLength(1);
  });
});
