// Romance (§19.1, §19.2, §19.10), the parts that are plain arithmetic: who can be attracted to whom, how much,
// and how people take an advance or a rejection. Reactions are rolled from trait-weighted tables, not fixed: code
// picks the kind of reaction and the agent carries it out in character. Everything here is PG (§19.6).

import type { Orientation, Persona, Sex } from '@agora/shared';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * §19.2: whether someone could be a romantic interest at all, by our orientation and the sex we take them to be:
 * 1 yes, 0 no, and 0.5 for someone whose sex we don't know yet (cautious).
 */
export function orientationFit(orientation: Orientation, mySex: Sex, theirs: Sex | 'unknown'): number {
  if (theirs === 'unknown') return 0.5;
  if (orientation === 'bi') return 1;
  return (orientation === 'homo') === (theirs === mySex) ? 1 : 0;
}

export interface AttractionInputs {
  /** What shows (gear, style, the first impression), 0..1. */
  superficial: number;
  /** How well we'd get on, judged from what we perceived of them, 0..1. */
  compatibility: number;
  /** Time spent together lately, 0..1 (saturating). */
  sharedTime: number;
  /** Gifts from them lately, 0..1 (saturating). */
  gifts: number;
}

/** §19.2: vanity·superficial + (1 − vanity)·compatibility + shared time + gifts (the last two a little each). */
export function attraction(vanity: number, x: AttractionInputs): number {
  return clamp01(vanity * x.superficial + (1 - vanity) * x.compatibility + 0.25 * x.sharedTime + 0.2 * x.gifts);
}

/** §19.10 soft persistence cap: further attempts per person per in-game week, after the first. */
export function persistenceCap(agreeableness: number): number {
  return 1 + Math.round(2 * (1 - agreeableness));
}

export type AdvanceReaction = 'reciprocate' | 'politeDecline' | 'ignore' | 'uncomfortable' | 'disgusted' | 'hostile';
export type RejectionReaction = 'graceful' | 'sadWithdrawal' | 'persist' | 'jealousy' | 'resentment' | 'rage';

export interface AdvanceContext {
  /** Our attraction to the one making the advance, 0..1. */
  attraction: number;
  admiration: number;
  /** How we feel about them, 0..10. */
  sentiment: number;
  /** How high they stand in our eyes (power, gear), 0..1: the vain look down on a suitor of low standing. */
  status: number;
  friction: number;
  /** What we hold against them already, 0..1. */
  resentment: number;
  joy: number;
  /** Further attempts after the first this week: each makes the unwelcome reactions half as likely again. */
  attempt: number;
}

/** How unfond we are of them: 1 at a neutral 5, up to 2 at 0, down to 0.2 for a friend. */
const unfond = (sentiment: number) => Math.min(2, Math.max(0.2, (10 - sentiment) / 5));
/** Dislike, for disgust: none to speak of from 7 up, 1 at a neutral 5, 3 at 1 and below. */
const dislike = (sentiment: number) => Math.min(3, Math.max(0.1, (7 - sentiment) / 2));

/** §19.10 A: the weight of each way of taking an advance, base × the traits and the moment that raise it. */
export function advanceWeights(p: Persona, c: AdvanceContext): Record<AdvanceReaction, number> {
  const harsher = 1.5 ** Math.max(0, c.attempt);
  return {
    reciprocate: 12 * c.attraction ** 3 * (0.7 + 0.6 * c.admiration) * (0.85 + 0.3 * c.joy),
    politeDecline: 1 * (0.5 + p.big5.agreeableness) * (0.75 + 0.5 * p.big5.conscientiousness),
    ignore: 0.5 * (1.5 - p.big5.extraversion) * (1.3 - c.attraction),
    uncomfortable: 0.4 * (0.5 + p.big5.neuroticism) * unfond(c.sentiment) * harsher,
    disgusted: 0.15 * dislike(c.sentiment) * (1.5 - c.attraction) * (1 + 2 * p.mind.vanity * (1 - c.status)) * (1 + c.friction) * harsher,
    hostile: 0.05 * (0.5 + p.temperament.aggression) * (1 + 2 * c.resentment) * harsher,
  };
}

export interface RejectionContext {
  /** Our romantic interest in the one who turned us down, 0..1. */
  romanticInterest: number;
  /** Someone they spend time with or trade gifts with, whom we take for a rival. */
  rival: boolean;
  /** Turned down in front of others. */
  public: boolean;
  shame: number;
  arousal: number;
  /** Our fighting ability with growth (§21.3): the less we fear a fight, the likelier rage turns to blows. */
  combat: number;
  /** Attempts we may still make this week (the soft cap): none left, no persisting. */
  attemptsLeft: number;
}

/** §19.10 B: the weight of each way of taking a rejection. */
export function rejectionWeights(p: Persona, c: RejectionContext): Record<RejectionReaction, number> {
  const agree = p.big5.agreeableness;
  return {
    graceful: 1 * (0.5 + agree) * (0.5 + p.mind.rationality) * (1.5 - p.mind.vanity),
    sadWithdrawal: 0.6 * (0.5 + p.big5.neuroticism) * (0.5 + c.romanticInterest),
    persist: c.attemptsLeft > 0 ? 0.3 * (1.5 - agree) * (0.5 + c.romanticInterest) * (1.5 - p.abilities.intelligence) : 0,
    jealousy: c.rival ? 0.25 * (0.5 + p.mind.biasProfile.envy) * (0.5 + p.mind.vanity) * (0.5 + c.romanticInterest) : 0,
    resentment: 0.2 * (0.5 + p.temperament.vengefulness) * (1.5 - agree) * (c.public ? 1.5 : 1) * (1 + c.shame),
    rage: 0.04 * (4 * p.temperament.aggression * p.mind.impulsivity) ** 2 * (0.5 + c.arousal) * (c.public ? 2 : 1) * (0.5 + c.combat),
  };
}

/** The violent or hostile option of each table, which System 2 may veto (§18.5 override). */
const VETOABLE: ReadonlySet<string> = new Set(['hostile', 'rage']);

/**
 * Normalize and sample (§19.10 "how to roll"). The hostile option is then vetoed with probability `override`, as
 * any impulse may be, and the roll taken again among the rest.
 */
export function rollReaction<K extends string>(weights: Record<K, number>, rng: () => number, override = 0): K {
  const pick = (w: [K, number][]): K => {
    const total = w.reduce((a, [, x]) => a + Math.max(0, x), 0);
    let r = rng() * total;
    for (const [k, x] of w) {
      r -= Math.max(0, x);
      if (r < 0) return k;
    }
    return (w.find(([, x]) => x > 0) ?? w[0])?.[0] as K;
  };
  const all = Object.entries(weights) as [K, number][];
  const k = pick(all);
  if (!VETOABLE.has(k) || rng() >= override) return k;
  return pick(all.filter(([x]) => x !== k));
}

const MALE = /\b(i'?m|i am)( just)? an? (guy|man|boy|dude|fella|fellow|gentleman)\b|\bas an? (guy|man)\b/i;
const FEMALE = /\b(i'?m|i am)( just)? an? (girl|woman|gal|lady)\b|\bas an? (girl|woman)\b/i;

/** §19.1: the sex someone says they are, in so many words ("I'm a guy who loves mining"). */
export function statedSex(text: string): Sex | null {
  const m = MALE.test(text);
  const f = FEMALE.test(text);
  return m === f ? null : m ? 'male' : 'female';
}

const HE = /\b(he|him|his|himself)\b/i;
const SHE = /\b(she|her|hers|herself)\b/i;

/**
 * §19.1: the sex others take someone to be, from the pronoun they use for them: a line about one person (named, and
 * not the listener) that says "he" or "she", and not both.
 */
export function pronounSex(text: string): Sex | null {
  const he = HE.test(text);
  const she = SHE.test(text);
  return he === she ? null : he ? 'male' : 'female';
}

/** §19.6: romance is PG (the filter lives in shared, for the Hub's persona writer too). */
export { NOT_PG_RE } from '@agora/shared';
