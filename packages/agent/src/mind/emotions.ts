// Emotions (§18.2): code, cheap. Appraisal rules turn events into emotion deltas scaled by neuroticism; emotions
// decay toward the mood baseline (intense ones in 1–2 minutes, sadness slower, more slowly still for the
// neurotic); mood is a slow average. Arousal, the strongest intense emotion, drives impulses and blocks reflection.

import type { EmotionName, EmotionState, Mood, Persona } from '@agora/shared';

export type AppraisalEvent =
  | { kind: 'attacked'; damage: number }
  | { kind: 'insulted'; hitsInsecurity: boolean }
  | { kind: 'gift' }
  | { kind: 'peerDied'; sentiment: number; nearby: boolean }
  | { kind: 'rivalSucceeded' }
  | { kind: 'rejected' }
  | { kind: 'goalAchieved' }
  | { kind: 'repeatedFailure' }
  | { kind: 'threatened' }
  | { kind: 'praised' }
  | { kind: 'witnessedFight' };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function zeroEmotions(): EmotionState {
  return { anger: 0, fear: 0, joy: 0, sadness: 0, disgust: 0, shame: 0, envy: 0, affection: 0, arousal: 0 };
}

/** The intense emotions set arousal (§18.2). */
export function arousalOf(e: EmotionState): number {
  return clamp01(Math.max(e.anger, e.fear, e.joy * 0.8, e.disgust * 0.7, e.envy * 0.6, e.shame * 0.5));
}

/** Event → emotion deltas, each scaled by (0.5 + neuroticism), with the temperament's own slant. */
export function appraise(e: EmotionState, ev: AppraisalEvent, p: Persona): EmotionState {
  const k = 0.5 + p.big5.neuroticism;
  const d: Partial<Record<EmotionName, number>> = {};
  switch (ev.kind) {
    case 'attacked': {
      const hurt = Math.min(1, ev.damage / 6);
      d.anger = (0.25 + 0.35 * hurt) * (0.5 + p.temperament.aggression);
      d.fear = (0.2 + 0.35 * hurt) * (0.5 + p.drives.caution);
      break;
    }
    case 'insulted':
      // The disagreeable and the aggressive bristle; a sore spot stings too.
      d.anger = (0.3 + 0.3 * (1 - p.big5.agreeableness)) * (0.5 + p.temperament.aggression);
      if (ev.hitsInsecurity) d.shame = 0.35;
      break;
    case 'gift':
      d.joy = 0.3;
      d.affection = 0.3;
      break;
    case 'peerDied': {
      const care = Math.max(0, (ev.sentiment - 3) / 7);
      d.fear = ev.nearby ? 0.45 : 0.2;
      d.sadness = 0.15 + 0.5 * care;
      break;
    }
    case 'rivalSucceeded':
      d.envy = 0.4 * p.mind.biasProfile.envy;
      break;
    case 'rejected':
      d.sadness = 0.3;
      d.shame = 0.2;
      d.anger = 0.15 * (1 - p.big5.agreeableness);
      break;
    case 'goalAchieved':
      d.joy = 0.35;
      break;
    case 'repeatedFailure':
      d.anger = 0.2;
      d.sadness = 0.15;
      break;
    case 'threatened':
      d.fear = 0.3 * (0.5 + p.drives.caution);
      d.anger = 0.2 * (0.5 + p.temperament.aggression);
      break;
    case 'praised':
      d.joy = 0.25;
      d.affection = 0.15;
      break;
    case 'witnessedFight':
      d.fear = 0.15;
      break;
  }
  const out = { ...e };
  for (const [name, v] of Object.entries(d) as [EmotionName, number][]) out[name] = clamp01(out[name] + v * k);
  out.arousal = arousalOf(out);
  return out;
}

/** Half-lives in seconds (§18.2): intense emotions 60–120 s, sadness and affection minutes; the neurotic linger. */
const HALF_LIFE_S: Readonly<Record<EmotionName, number>> = {
  anger: 90,
  fear: 60,
  joy: 120,
  disgust: 90,
  envy: 120,
  shame: 180,
  sadness: 600,
  affection: 900,
};

export function decayEmotions(e: EmotionState, dtMs: number, p: Persona, mood: Mood = { valence: 0, baselineShift: 0 }): EmotionState {
  const linger = 1 + p.big5.neuroticism;
  const out = { ...e };
  for (const name of Object.keys(HALF_LIFE_S) as EmotionName[]) {
    // A low mood keeps a little sadness around; a high one a little joy.
    const floor = name === 'sadness' ? Math.max(0, -mood.valence) * 0.2 : name === 'joy' ? Math.max(0, mood.valence) * 0.2 : 0;
    const f = 0.5 ** (dtMs / 1000 / (HALF_LIFE_S[name] * linger));
    out[name] = floor + (out[name] - floor) * f;
    if (out[name] < 0.001) out[name] = 0;
  }
  out.arousal = arousalOf(out);
  return out;
}

/** Mood: an hours-scale moving average of how things feel (§18.2). */
export function updateMood(mood: Mood, e: EmotionState, dtMs: number): Mood {
  const now = (e.joy + e.affection * 0.5 - e.sadness - e.fear * 0.5 - e.anger * 0.5 - e.shame * 0.5) / 2;
  const a = 1 - Math.exp(-dtMs / (2 * 3_600_000));
  return { ...mood, valence: Math.max(-1, Math.min(1, mood.valence + (now - mood.valence) * a)) };
}

/** The feeling worth expressing (§18.2 expression), if any is above 0.25. */
export function topEmotion(e: EmotionState): { name: EmotionName; intensity: number } | null {
  let best: { name: EmotionName; intensity: number } | null = null;
  for (const name of Object.keys(HALF_LIFE_S) as EmotionName[]) {
    if (e[name] > 0.25 && (!best || e[name] > best.intensity)) best = { name, intensity: e[name] };
  }
  return best;
}

/** Contagion (§18.2): move toward the crowd's feeling, scaled by conformity × extraversion. */
export function contagion(e: EmotionState, crowd: Partial<Record<EmotionName, number>>, p: Persona, scale = 1): EmotionState {
  const k = p.mind.conformity * p.big5.extraversion * 0.5 * scale;
  const out = { ...e };
  for (const [name, v] of Object.entries(crowd) as [EmotionName, number][]) if (v > out[name]) out[name] = clamp01(out[name] + (v - out[name]) * k);
  out.arousal = arousalOf(out);
  return out;
}
