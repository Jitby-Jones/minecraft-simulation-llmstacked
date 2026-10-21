// The verified skill library. The CC sees `skillCatalog()`; the executor looks skills up by name.

import { attack } from './combat';
import { craft, smelt } from './crafting';
import { deposit, withdraw } from './containers';
import { gather, mine, pickup } from './gathering';
import { place, shelter } from './building';
import { obtain } from './planner';
import { explore, flee, follow, goTo, look, wait } from './movement';
import { give, say } from './social';
import { eat, equip, sleep } from './survival';
import type { AnySkill } from './types';

export const SKILLS: readonly AnySkill[] = [
  goTo,
  follow,
  explore,
  flee,
  look,
  wait,
  gather,
  mine,
  pickup,
  craft,
  smelt,
  obtain,
  place,
  shelter,
  deposit,
  withdraw,
  attack,
  eat,
  equip,
  sleep,
  give,
  say,
];

const BY_NAME = new Map(SKILLS.map((s) => [s.name.toLowerCase(), s]));

const ALIASES: Readonly<Record<string, string>> = {
  goto: 'goTo',
  go: 'goTo',
  walk: 'goTo',
  move: 'goTo',
  come: 'goTo',
  collect: 'gather',
  chop: 'gather',
  get: 'obtain',
  acquire: 'obtain',
  fetch: 'obtain',
  dig: 'mine',
  stay: 'wait',
  rest: 'wait',
  idle: 'wait',
  store: 'deposit',
  take: 'withdraw',
  fight: 'attack',
  hit: 'attack',
  toss: 'give',
  drop: 'give',
  talk: 'say',
  speak: 'say',
  build_shelter: 'shelter',
  hide: 'shelter',
  cook: 'smelt',
  wear: 'equip',
  hold: 'equip',
  run: 'flee',
  wander: 'explore',
};

export function getSkill(name: string): AnySkill | null {
  const key = name.trim().replace(/[\s-]+/g, '_').toLowerCase();
  return BY_NAME.get(key) ?? BY_NAME.get((ALIASES[key] ?? '').toLowerCase()) ?? null;
}

/** Skill list for the CC prompt (§4.3 "available options (enum) and skill names"). */
export function skillCatalog(extra: readonly AnySkill[] = []): string {
  return [...SKILLS, ...extra].map((s) => `- ${s.description}`).join('\n');
}

export function skillNames(extra: readonly AnySkill[] = []): string[] {
  return [...SKILLS, ...extra].map((s) => s.name);
}
