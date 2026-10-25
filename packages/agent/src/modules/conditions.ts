// Code-checkable conditions (§4.4 `terminate.until`, goal `doneWhen`): a tiny grammar the CC can emit and code can
// evaluate against the Agent State. Unknown conditions never fire (maxSeconds still ends the option).
//
//   inventoryHas:oak_log>=16   agentInRange:Bram   agentLeftRange:Bram   timeIs:day|night
//   healthAbove:10   foodAbove:15   near:10,64,-5
//   villageWork:wood (the work's finishing act since the current goal was set, §6.8: logs handed in, a hut built…)
//   For plan steps (since the current goal was set): explored:2 (looked around twice), talkedWith:Bram (a talk with
//   them, both of us saying something), spent:5 (five minutes on it). inventoryHas:food>=4 counts anything edible,
//   and a kind of wood any wood (inventoryHas:oak_log>=4 is met by birch logs). built:plains-cottage (a building of
//   that design finished, owner request 2026-10-24).

import type { AgentState } from '@agora/shared';
import { isVillageKind, villageWorkDone } from '../social/village';
import { anyWood } from './itemTasks';
import { daytime } from '../body/world';

/** What can be eaten (inventoryHas:food). */
const FOOD = /^(bread|apple|golden_apple|cooked_\w+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|carrot|golden_carrot|baked_potato|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|mushroom_stew|rabbit_stew|beetroot_soup|dried_kelp)$/;

const OPS: Readonly<Record<string, (a: number, b: number) => boolean>> = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
};

/** How many of the item the agent holds; a kind of wood counts any wood ("oak_log" any log: all serve alike). */
export function held(state: AgentState, item: string): number {
  const name = anyWood(item.toLowerCase().replace(/^minecraft:/, ''));
  const suffix = name === 'log' || name === 'logs' ? /_(log|stem)$/ : name === 'planks' ? /_planks$/ : name === 'food' ? FOOD : null;
  return state.self.inventory.filter((s) => (suffix ? suffix.test(s.item) : s.item === name)).reduce((a, s) => a + s.qty, 0);
}

function inRange(state: AgentState, name: string, range: number): boolean {
  return state.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name.toLowerCase() === name.toLowerCase() && e.distance <= range);
}

/** true/false when the condition parses; null when it doesn't (the caller logs it once). */
export function evalCondition(cond: string, state: AgentState, speechRange = 15, now = Date.now()): boolean | null {
  const c = cond.trim();
  const since = state.goals.current?.createdAt ?? 0;
  let p = /^explored:(\d+)$/.exec(c);
  if (p?.[1]) return state.actionLog.filter((a) => a.ok && a.ts >= since && (a.skill === 'explore' || a.skill === 'wander')).length >= Number(p[1]);
  p = /^talkedWith:([A-Za-z0-9_]{1,16})$/.exec(c);
  if (p?.[1]) {
    const who = p[1].toLowerCase();
    return Object.values(state.conversations).some((cv) => cv.transcript.some((u) => u.ts >= since && u.from.toLowerCase() === who) && cv.transcript.some((u) => u.ts >= since && u.from === state.self.username));
  }
  p = /^spent:(\d+(?:\.\d+)?)$/.exec(c);
  if (p?.[1]) return state.goals.current !== null && now - since >= Number(p[1]) * 60_000;
  let m = /^inventoryHas:([a-z0-9_:]+)\s*(>=|<=|==|>|<)\s*(\d+)$/i.exec(c);
  if (m?.[1] && m[2] && m[3]) return OPS[m[2]]?.(held(state, m[1]), Number(m[3])) ?? null;
  m = /^agentInRange:([A-Za-z0-9_]{1,16})$/.exec(c);
  if (m?.[1]) return inRange(state, m[1], speechRange);
  m = /^agentLeftRange:([A-Za-z0-9_]{1,16})$/.exec(c);
  if (m?.[1]) return !inRange(state, m[1], speechRange);
  m = /^timeIs:(day|night)$/i.exec(c);
  // Day as it is felt: in the evening, "until day" is the next morning (wait's own "day").
  if (m?.[1]) return m[1].toLowerCase() === 'day' ? daytime(state.self.time) : !state.self.isDay;
  m = /^(healthAbove|foodAbove):(\d+(?:\.\d+)?)$/.exec(c);
  if (m?.[1] && m[2]) return (m[1] === 'healthAbove' ? state.self.health : state.self.food) > Number(m[2]);
  m = /^villageWork:([a-z]+)$/.exec(c);
  if (m?.[1]) return isVillageKind(m[1]) ? villageWorkDone(state, m[1], state.goals.current?.createdAt ?? 0) : null;
  m = /^built:([a-z0-9:_-]+)$/.exec(c);
  if (m?.[1]) {
    const id = m[1];
    return (state.village.projects ?? []).some((p) => p.design === id && p.doneAt !== null);
  }
  m = /^near:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(c);
  if (m?.[1] && m[2] && m[3]) {
    const p = state.self.pos;
    return Math.hypot(p.x - Number(m[1]), p.y - Number(m[2]), p.z - Number(m[3])) <= 3;
  }
  return null;
}
