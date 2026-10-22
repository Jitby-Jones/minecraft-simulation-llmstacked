// M9a (§19.1, §19.2, §19.6, §19.10): romance without Minecraft. Who can be attracted to whom and how much, the sex
// one says one is or others take one to be, the PG line filter, and the trait-weighted reactions to an advance and
// to a rejection (scenarios W and X). Live courtship, rejection and jealousy are in tests/live/m9a-romance.test.ts.

import { describe, expect, it } from 'vitest';
import { type Persona, type PersonaInput, PersonaSchema, SeededRandom, WorldConfigSchema, generatePersona, loadSexDifferences } from '@agora/shared';
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
