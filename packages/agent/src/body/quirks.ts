// Code-level quirks (§7): consistent and free (no tokens). This file compiles the condition grammar and
// exposes the body-level hooks (pathCost, reflexBias, tradeBias). Idle hooks (autoCollect, idleEmote,
// distraction) are driven by the agent's idle loop.

import { QUIRK_CONDITION, type Quirk } from '@agora/shared';

export interface QuirkEnv {
  lightLevel: number;
  timeOfDay: number;
  health: number;
  food: number;
  y: number;
}

export type QuirkCondition = (env: QuirkEnv) => boolean;

export function compileCondition(when: string): QuirkCondition {
  const m = QUIRK_CONDITION.exec(when.trim());
  if (!m) throw new Error(`invalid quirk condition "${when}"`);
  const key = m[1] as keyof QuirkEnv;
  const op = m[2] as '<' | '<=' | '>' | '>=' | '==';
  const v = Number(m[3]);
  switch (op) {
    case '<':
      return (env) => env[key] < v;
    case '<=':
      return (env) => env[key] <= v;
    case '>':
      return (env) => env[key] > v;
    case '>=':
      return (env) => env[key] >= v;
    case '==':
      return (env) => env[key] === v;
  }
}

export interface PathCostRule {
  condition: QuirkCondition;
  /** Extra cost per step, so the step costs `multiplier` times as much. */
  extraCost: number;
}

export function pathCostRules(quirks: readonly Quirk[]): PathCostRule[] {
  const out: PathCostRule[] = [];
  for (const q of quirks) {
    if (q.hook === 'pathCost') out.push({ condition: compileCondition(q.when), extraCost: Math.max(0, q.multiplier - 1) });
  }
  return out;
}

/** reflexBias deltas (health/food points) per reflex. */
export function reflexDelta(quirks: readonly Quirk[], reflex: 'flee' | 'fight' | 'eat'): number {
  let d = 0;
  for (const q of quirks) if (q.hook === 'reflexBias' && q.reflex === reflex) d += q.delta;
  return d;
}

/** tradeBias multiplier for valuing an item when trading it away. */
export function tradeMultiplier(quirks: readonly Quirk[], item: string): number {
  let m = 1;
  for (const q of quirks) if (q.hook === 'tradeBias' && q.item === item) m *= q.multiplier;
  return m;
}

export function autoCollectItems(quirks: readonly Quirk[]): string[] {
  return quirks.flatMap((q) => (q.hook === 'autoCollect' ? q.items : []));
}
