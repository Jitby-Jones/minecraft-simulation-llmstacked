// Hiding (the shelter skill: dig into the ground and seal the top). People don't dig a hole on their first night
// as a matter of course: they stay with the others, near home, and keep clear of monsters. Hiding is what one does
// badly scared and on one's own, far from anyone: high fear, nobody near, away from home. It is the model's call
// (the CC); the gate below only says when it may be made. The code default hides only as the code-only brain
// (§22.4), and only then under the same gate.

import type { AgentState } from '@agora/shared';

/** Nobody of ours this close: alone. */
export const ALONE_RANGE = 24;
/** Farther than this from home, with nobody in sight: isolated. */
export const ISOLATED_RANGE = 40;
/** Fear (0..1, §18.2) at or above this is high. */
export const HIGH_FEAR = 0.5;

/** Null when digging in to hide may be chosen now; otherwise why not, as the CC is told. */
export function whyNotHide(s: AgentState): string | null {
  const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player');
  if (people.some((e) => e.distance <= ALONE_RANGE)) return 'you are not alone; stay with the others';
  const home = s.village.home;
  const p = s.self.pos;
  if (home && Math.hypot(p.x - home.x, p.z - home.z) <= ISOLATED_RANGE) return 'you are close to home; go back there instead';
  if (people.length > 0) return 'there are people in sight; go to them instead';
  if (s.emotions.fear < HIGH_FEAR) return 'you are not scared enough to hide in a hole';
  return null;
}
