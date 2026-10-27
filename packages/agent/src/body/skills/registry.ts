// The verified skill library. The CC sees `skillCatalog()`; the executor looks skills up by name.

import { attack } from './combat';
import { duel } from './duel';
import { craft, smelt } from './crafting';
import { deposit, withdraw } from './containers';
import { gather, mine, pickup } from './gathering';
import { place, shelter } from './building';
import { obtain } from './planner';
import { prospect } from './prospecting';
import { tunnel } from './digging';
import { explore, flee, follow, goTo, look, lookAround, wait, wander } from './movement';
import { give, say } from './social';
import { eat, equip, sleep } from './survival';
import { build, hunt, patrol, sign } from './village';
import { design } from './design';
import { scout, settle } from './settle';
import { enchant, nameItem } from './enchanting';
import { eye, fill, portal, travel } from './expedition';
import { dig, drop, harvest, lead, use } from './hands';
import type { AnySkill } from './types';

export const SKILLS: readonly AnySkill[] = [
  goTo,
  follow,
  explore,
  wander,
  lookAround,
  flee,
  look,
  wait,
  gather,
  mine,
  pickup,
  prospect,
  tunnel,
  craft,
  smelt,
  obtain,
  place,
  shelter,
  deposit,
  withdraw,
  attack,
  duel,
  eat,
  equip,
  sleep,
  give,
  say,
  hunt,
  build,
  design,
  scout,
  settle,
  nameItem,
  enchant,
  portal,
  travel,
  eye,
  fill,
  sign,
  patrol,
  use,
  dig,
  lead,
  harvest,
  drop,
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
  break: 'dig',
  break_block: 'dig',
  stay: 'wait',
  rest: 'lookAround',
  idle: 'lookAround',
  watch: 'lookAround',
  observe: 'lookAround',
  look_around: 'lookAround',
  stroll: 'wander',
  walk_around: 'wander',
  store: 'deposit',
  take: 'withdraw',
  fight: 'attack',
  brawl: 'duel',
  hit: 'attack',
  toss: 'give',
  drop: 'give',
  talk: 'say',
  speak: 'say',
  cook: 'smelt',
  wear: 'equip',
  hold: 'equip',
  run: 'flee',
  prospecting: 'prospect',
  search_ore: 'prospect',
  dig_tunnel: 'tunnel',
  staircase: 'tunnel',
  post: 'sign',
  write_sign: 'sign',
  notice: 'sign',
  construct: 'build',
  architect: 'design',
  rename: 'name',
  name_item: 'name',
  enchanting: 'enchant',
  nether_portal: 'portal',
  build_portal: 'portal',
  go_through: 'travel',
  throw_eye: 'eye',
  fill_portal: 'fill',
  draw: 'design',
  plan_building: 'design',
  build_hut: 'build',
  guard: 'patrol',
  hunt_animals: 'hunt',
};

export function getSkill(name: string): AnySkill | null {
  const key = name.trim().replace(/[\s-]+/g, '_').toLowerCase();
  return BY_NAME.get(key) ?? BY_NAME.get((ALIASES[key] ?? '').toLowerCase()) ?? null;
}

/** Skill list for the CC prompt (§4.3 "available options (enum) and skill names"): the mind's hands, not the code's routines. */
export function skillCatalog(extra: readonly AnySkill[] = []): string {
  return [...SKILLS, ...extra].filter((s) => !s.codeOnly).map((s) => `- ${s.description}`).join('\n');
}

export function skillNames(extra: readonly AnySkill[] = []): string[] {
  return [...SKILLS, ...extra].filter((s) => !s.codeOnly).map((s) => s.name);
}
