// Code-checkable conditions (§4.4 `terminate.until`, goal `doneWhen`): a tiny grammar the CC can emit and code can
// evaluate against the Agent State. Unknown conditions never fire (maxSeconds still ends the option).
//
//   inventoryHas:oak_log>=16   agentInRange:Bram   agentLeftRange:Bram   timeIs:day|night
//   healthAbove:10   foodAbove:15   near:10,64,-5
//   villageWork:wood (the work's finishing act since the current goal was set, §6.8: logs handed in, a hut built…)

import type { AgentState } from '@agora/shared';
import { isVillageKind, villageWorkDone } from '../social/village';

const OPS: Readonly<Record<string, (a: number, b: number) => boolean>> = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
};

function held(state: AgentState, item: string): number {
  const name = item.toLowerCase().replace(/^minecraft:/, '');
  const suffix = name === 'log' || name === 'logs' ? /_(log|stem)$/ : name === 'planks' ? /_planks$/ : null;
  return state.self.inventory.filter((s) => (suffix ? suffix.test(s.item) : s.item === name)).reduce((a, s) => a + s.qty, 0);
}

function inRange(state: AgentState, name: string, range: number): boolean {
  return state.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name.toLowerCase() === name.toLowerCase() && e.distance <= range);
}

/** true/false when the condition parses; null when it doesn't (the caller logs it once). */
export function evalCondition(cond: string, state: AgentState, speechRange = 15): boolean | null {
  const c = cond.trim();
  let m = /^inventoryHas:([a-z0-9_:]+)\s*(>=|<=|==|>|<)\s*(\d+)$/i.exec(c);
  if (m?.[1] && m[2] && m[3]) return OPS[m[2]]?.(held(state, m[1]), Number(m[3])) ?? null;
  m = /^agentInRange:([A-Za-z0-9_]{1,16})$/.exec(c);
  if (m?.[1]) return inRange(state, m[1], speechRange);
  m = /^agentLeftRange:([A-Za-z0-9_]{1,16})$/.exec(c);
  if (m?.[1]) return !inRange(state, m[1], speechRange);
  m = /^timeIs:(day|night)$/i.exec(c);
  if (m?.[1]) return m[1].toLowerCase() === 'day' ? state.self.isDay : !state.self.isDay;
  m = /^(healthAbove|foodAbove):(\d+(?:\.\d+)?)$/.exec(c);
  if (m?.[1] && m[2]) return (m[1] === 'healthAbove' ? state.self.health : state.self.food) > Number(m[2]);
  m = /^villageWork:([a-z]+)$/.exec(c);
  if (m?.[1]) return isVillageKind(m[1]) ? villageWorkDone(state, m[1], state.goals.current?.createdAt ?? 0) : null;
  m = /^near:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(c);
  if (m?.[1] && m[2] && m[3]) {
    const p = state.self.pos;
    return Math.hypot(p.x - Number(m[1]), p.y - Number(m[2]), p.z - Number(m[3])) <= 3;
  }
  return null;
}
