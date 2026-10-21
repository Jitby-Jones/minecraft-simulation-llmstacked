// System 1 and System 2 (§18.4, §18.5): biases are small transforms on judgments, each scaled by the agent's own
// susceptibility and weakened by the override factor (rational, calm, given time, not inside a mob). Conformity
// pulls opinions toward what was heard, more strongly under fear. The CC's final word on a judgment is a mix of gut
// and facts by the override, nudged at most ±0.15 by the model.

import type { HeardOpinion } from '@agora/shared';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * §18.5 override = rationality × (1 − arousal·0.7) × timeFactor × (1 − crowdSuppression). timeFactor grows with the
 * seconds since the trigger (anger cools, thinking it over helps): 0.4 at once, 1 after two minutes.
 */
export function overrideFactor(rationality: number, arousal: number, secondsSinceTrigger: number, inCrowd: boolean): number {
  const timeFactor = clamp(0.4 + secondsSinceTrigger / 200, 0.4, 1);
  return clamp(rationality * (1 - arousal * 0.7) * timeFactor * (inCrowd ? 0.7 : 1), 0, 1);
}

/** effect = base × susceptibility × (1 − override) */
export function biasEffect(base: number, susceptibility: number, override: number): number {
  return base * susceptibility * (1 - override);
}

/** Confirmation: evidence that fits the current sentiment counts more, contrary evidence less. */
export function confirmationScaled(delta: number, sentiment: number, susceptibility: number, override: number): number {
  const fits = (sentiment > 5.5 && delta > 0) || (sentiment < 4.5 && delta < 0);
  const against = (sentiment > 5.5 && delta < 0) || (sentiment < 4.5 && delta > 0);
  const c = susceptibility * (1 - override) * 0.5;
  return fits ? delta * (1 + c) : against ? delta * (1 - c) : delta;
}

/** Halo (§18.3): admiration or impressive gear lifts trust and sentiment. Returns the bonus to add. */
export function haloBonus(admiration: number, gearScore: number, halo: number, vanity: number, override: number): number {
  const cue = Math.max(admiration, gearScore * vanity);
  return biasEffect(cue * 0.3, halo, override);
}

/** Envy: visibly better gear or more followers feed resentment (×(1 − agreeableness)). */
export function envyResentment(theirStatus: number, myStatus: number, envy: number, agreeableness: number, override: number): number {
  const gap = Math.max(0, theirStatus - myStatus);
  return biasEffect(gap * (1 - agreeableness), envy, override);
}

/** §18.4.1 social pull = conformity × (1 + 1.5·fearLevel) × (1 − override). */
export function conformityPull(conformity: number, fearLevel: number, override: number): number {
  return clamp(conformity * (1 + 1.5 * fearLevel) * (1 - override), 0, 1);
}

/**
 * The heard opinion of X on the 0..10 sentiment scale, weighting each speaker by how much we admire them (and
 * their authority over us). Null when nobody said anything about X.
 */
export function heardConsensus(opinions: readonly HeardOpinion[], target: string, weightOf: (speaker: string) => number, now: number, maxAgeMs = 3 * 3_600_000): number | null {
  let w = 0;
  let sum = 0;
  const latest = new Map<string, HeardOpinion>();
  for (const o of opinions) if (o.target === target && now - o.ts < maxAgeMs) latest.set(o.speaker, o);
  for (const o of latest.values()) {
    const k = Math.max(0.1, weightOf(o.speaker));
    w += k;
    sum += k * (5 + 5 * o.valence);
  }
  return w > 0 ? sum / w : null;
}

/** Moves sentiment toward the heard consensus by pull × 0.3 per update. */
export function pulledSentiment(sentiment: number, consensus: number, pull: number): number {
  return clamp(sentiment + (consensus - sentiment) * pull * 0.3, 0, 10);
}

/** §18.5: effectiveJudgment = lerp(gut, facts, override), and the model may nudge it by at most ±0.15. */
export function effectiveJudgment(gut: number, facts: number, override: number, modelNudge = 0): number {
  return gut + (facts - gut) * override + clamp(modelNudge, -0.15, 0.15);
}

export interface CrowdMember {
  name: string;
  /** Anger toward the shared target, 0..1. */
  anger: number;
  distance: number;
}

/** §18.4.2: a crowd is ≥ 3 agents within 16 blocks sharing a target with average anger ≥ 0.5. */
export function isMob(members: readonly CrowdMember[]): boolean {
  const near = members.filter((m) => m.distance <= 16);
  if (near.length < 3) return false;
  return near.reduce((a, m) => a + m.anger, 0) / near.length >= 0.5;
}

/** Deindividuation inside a mob (§18.4.2). */
export function mobModifiers(crowdSize: number): { witnessCost: number; fear: number; angerContagion: number; rungThreshold: number } {
  return { witnessCost: 0.3, fear: Math.max(0.1, 1 - 0.15 * crowdSize), angerContagion: 1.5, rungThreshold: -0.1 };
}
