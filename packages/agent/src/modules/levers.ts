// Intelligence levers (§21.1, M3b). Intelligence is ability, not disposition: it sets the CC's model tier, how much
// of the state fits in its packet, how far ahead it plans and how often its hands slip. Values interpolate the
// design's anchors at intelligence 0.2 and 0.8.

import type { TierName } from '@agora/llm';
import { planDepthFor } from '../body/skills/planner';

export interface MindLevers {
  ccTier: TierName;
  memories: number;
  tasks: number;
  people: number;
  /** Task queue depth (planning horizon). */
  queueDepth: number;
  /** Candidate options the CC is asked to weigh. */
  candidates: number;
  /** Chance per task of a code-injected slip. */
  slipChance: number;
  /** Prerequisite levels `obtain` can plan through. */
  planDepth: number;
  reflectionEveryMin: number;
}

/** Linear through (0.2, lo) and (0.8, hi), clamped to [min(lo,hi), max(lo,hi)]. */
function lerp(i: number, lo: number, hi: number): number {
  const v = lo + ((i - 0.2) / 0.6) * (hi - lo);
  return Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), v));
}

export function leversFor(intelligence: number, intelligenceRoutesCCTier = true): MindLevers {
  const i = Math.min(1, Math.max(0, intelligence));
  return {
    ccTier: intelligenceRoutesCCTier && i < 0.35 ? 'L1' : 'L2',
    memories: Math.round(lerp(i, 3, 6)),
    tasks: Math.round(lerp(i, 2, 5)),
    people: Math.round(lerp(i, 3, 6)),
    queueDepth: Math.round(lerp(i, 2, 6)),
    candidates: Math.round(lerp(i, 2, 4)),
    slipChance: Math.round(lerp(i, 0.08, 0.01) * 1000) / 1000,
    planDepth: planDepthFor(i),
    reflectionEveryMin: Math.round(lerp(i, 25, 8)),
  };
}
