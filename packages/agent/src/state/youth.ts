// §19.5 the youth phase: a born agent's first youthSec, when it keeps to its parents and takes their word for things.

import type { AgentName, AgentState } from '@agora/shared';

/** A born agent still in its youth. Founders (spawned, not born) are adults from the start. */
export function isYoung(s: Pick<AgentState, 'life'>, now: number): boolean {
  return s.life.born && now < s.life.youthUntil;
}

/** Our parents while we are young (their opinions count double and pull harder, §19.5); nobody after that. */
export function parentsWhileYoung(s: Pick<AgentState, 'life' | 'family'>, now: number): readonly AgentName[] {
  return isYoung(s, now) ? s.family.parents : [];
}
