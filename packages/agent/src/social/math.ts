// The social model's arithmetic (§6.3, §17.2, §18.3): pure functions, so every number the agents act on can be
// tested and shown on the dashboard. Code-only deltas for notable deeds, the ±2 clamp per update, grudges and
// negativity amplifying the bad, anchoring on the first two interactions, drift back to the persona's baseline,
// grievances that fade unless the agent is vengeful, and resentment computed from all of it.

import type { BiasProfile, Grievance, GrievanceKind, Persona, SocialProfile } from '@agora/shared';

/** One in-game day (24000 ticks at 20 tps). */
export const GAME_DAY_MS = 20 * 60_000;

/** §6.3: no single update moves sentiment by more than this. */
export const MAX_SENTIMENT_STEP = 2;

/** Code-only sentiment deltas for notable deeds (§6.3 rule 2). */
export const DEED_DELTAS = {
  gaveMeItems: 1,
  attackedMe: -3,
  attackedAlly: -2,
  brokeMyBlocks: -1,
  helpedMeFight: 1.5,
  keptPromise: 0.5,
  brokePromise: -1,
} as const;
export type Deed = keyof typeof DEED_DELTAS;

/** Trust changes from resolved commitments (§6.3 rule 3). */
export const TRUST_DELTAS = { keptPromise: 0.1, brokePromise: -0.2, falseClaim: -0.15 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The delta actually applied: negativity bias (×(1 + negativity·0.5)) and grudges (×(1 + grudge)) amplify bad
 * news; the first two interactions count double (anchoring, §18.3); the result is clamped to ±2.
 */
export function effectiveDelta(delta: number, p: SocialProfile, persona: Persona, bias: BiasProfile = persona.mind.biasProfile): number {
  let d = delta;
  if (d < 0) d *= (1 + bias.negativity * 0.5) * (1 + persona.social.grudge);
  if (p.anchorCount < 2) d *= 2;
  return clamp(d, -MAX_SENTIMENT_STEP, MAX_SENTIMENT_STEP);
}

/** Applies a sentiment change (and counts it toward anchoring). */
export function withSentiment(p: SocialProfile, delta: number, persona: Persona, now: number): SocialProfile {
  const d = effectiveDelta(delta, p, persona);
  return { ...p, sentiment: clamp(p.sentiment + d, 0, 10), anchorCount: Math.min(2, p.anchorCount + 1), interactions: p.interactions + 1, lastSeen: Math.max(p.lastSeen, now) };
}

export function withTrust(p: SocialProfile, delta: number): SocialProfile {
  return { ...p, trust: clamp(p.trust + delta, 0, 1) };
}

/**
 * §6.3 decay: without contact, sentiment drifts back toward the persona's baseline by 0.1 per in-game day;
 * a grudge-holder's bad feelings fade at half that speed.
 */
export function driftSentiment(p: SocialProfile, persona: Persona, now: number): number {
  const days = Math.max(0, now - p.lastSeen) / GAME_DAY_MS;
  const base = persona.social.baselineSentiment;
  const below = p.sentiment < base;
  const rate = 0.1 * (below ? 1 - 0.5 * persona.social.grudge : 1);
  const step = Math.min(Math.abs(base - p.sentiment), rate * days);
  return p.sentiment + (below ? step : -step);
}

/** How heavy each kind of wrong is to begin with (§17.2). */
export const GRIEVANCE_WEIGHT: Readonly<Record<GrievanceKind, number>> = {
  insult: 0.15,
  theft: 0.4,
  attack: 0.5,
  betrayal: 0.6,
  coercion: 0.45,
  killed_friend: 0.9,
  killed_partner: 1,
  killed_parent: 1,
  broken_promise: 0.3,
  griefing: 0.35,
  unwanted_advance: 0.25,
  romantic_rival: 0.3,
  rejection: 0.15,
  scapegoat: 0.3,
};

/** Kinds of wrong that barely fade (§17.2: murder of a friend). */
const LASTING: ReadonlySet<GrievanceKind> = new Set(['killed_friend', 'killed_partner', 'killed_parent']);

/**
 * A grievance's weight now: half-life of about 2 in-game days, slowed by vengefulness (a fully vengeful agent
 * never lets go); killings fade ten times slower.
 */
export function grievanceWeightNow(g: Grievance, vengefulness: number, now: number): number {
  const age = Math.max(0, now - g.ts);
  const halfLife = 2 * GAME_DAY_MS * (LASTING.has(g.kind) ? 10 : 1);
  const rate = (Math.LN2 / halfLife) * Math.max(0, 1 - vengefulness);
  return g.weight * Math.exp(-rate * age);
}

/** §17.2: resentment = clamp((5 − sentiment)/5, 0, 1)·0.5 + Σ grievance weight·decay·vengefulness, capped at 1. */
export function resentment(p: SocialProfile, persona: Persona, now: number): number {
  const v = persona.temperament.vengefulness;
  const fromSentiment = clamp((5 - p.sentiment) / 5, 0, 1) * 0.5;
  const fromWrongs = p.grievances.reduce((a, g) => a + grievanceWeightNow(g, v, now), 0) * v;
  return clamp(fromSentiment + fromWrongs, 0, 1);
}

/** Records a wrong (witnessed wrongs count more; a halo discounts an idol's, §18.3). */
export function withGrievance(p: SocialProfile, kind: GrievanceKind, persona: Persona, o: { now: number; witnessed: boolean; source: Grievance['source']; note?: string; weight?: number }): SocialProfile {
  const halo = p.admiration > 0.75 ? 1 - persona.mind.biasProfile.halo * 0.7 : 1;
  const weight = (o.weight ?? GRIEVANCE_WEIGHT[kind]) * (o.witnessed ? 1 : 0.6) * halo;
  const g: Grievance = { kind, weight, ts: o.now, witnessed: o.witnessed, source: o.source, ...(o.note ? { note: o.note } : {}) };
  // Keep the heaviest dozen.
  const grievances = [...p.grievances, g].sort((a, b) => grievanceWeightNow(b, persona.temperament.vengefulness, o.now) - grievanceWeightNow(a, persona.temperament.vengefulness, o.now)).slice(0, 12);
  return { ...p, grievances };
}

/** §6.3 policies that read sentiment. */
export const SENTIMENT_POLICY = { share: 6, defend: 7, avoid: 2 } as const;
