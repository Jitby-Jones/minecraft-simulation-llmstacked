// What this bot has seen (§13 rule 4: never give a bot information it hasn't perceived). The client can query every
// loaded block, but a player can't see through walls. Skills may look for the ground itself anywhere (everyone knows
// there is stone under the grass, and trees show from afar), but ores, containers, beds, workstations and anything
// built only where this bot has had them in sight: now, or earlier (remembered until the block changes).

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { canSee, findNearestBlocks } from './world';

const INFERABLE_NAMES = new Set([
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'dripstone_block', 'dirt', 'grass_block',
  'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'clay', 'sand', 'red_sand', 'gravel', 'sandstone',
  'red_sandstone', 'terracotta', 'snow', 'snow_block', 'ice', 'packed_ice', 'netherrack', 'soul_sand', 'soul_soil',
  'basalt', 'blackstone', 'end_stone', 'moss_block', 'water', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'sugar_cane', 'cactus', 'bamboo', 'vine', 'kelp', 'seagrass', 'pumpkin', 'melon',
]);
const INFERABLE_RE = /_(log|wood|stem|leaves|sapling)$/;
const MAX_REMEMBERED = 4000;

/** Natural ground and vegetation that a player can find without having seen the particular block. */
export function isInferable(blockName: string): boolean {
  return INFERABLE_NAMES.has(blockName) || INFERABLE_RE.test(blockName);
}

interface Seen {
  name: string;
  at: number;
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** A block sharing a face with the cell our feet or head is in: the wall we touch counts as seen. */
function touching(bot: Bot, p: Vec3): boolean {
  const f = bot.entity.position.floored();
  return [f, f.offset(0, 1, 0)].some((c) => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) + Math.abs(p.z - c.z) <= 1);
}

export class Sightings {
  private static readonly perBot = new WeakMap<Bot, Sightings>();
  private readonly seen = new Map<string, Seen>();

  static for(bot: Bot): Sightings {
    let s = Sightings.perBot.get(bot);
    if (!s) {
      s = new Sightings(bot);
      Sightings.perBot.set(bot, s);
    }
    return s;
  }

  private constructor(private readonly bot: Bot) {
    bot.on('blockUpdate', (_old: Block | null, cur: Block) => {
      const k = key(cur.position);
      const s = this.seen.get(k);
      if (s && s.name !== cur.name) this.seen.delete(k);
    });
  }

  /** Records a block this bot has in sight now. */
  record(b: Block): void {
    const k = key(b.position);
    this.seen.delete(k);
    this.seen.set(k, { name: b.name, at: Date.now() });
    if (this.seen.size > MAX_REMEMBERED) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Whether this bot perceives `b` now (touching or in line of sight) or has seen it there before. */
  knows(b: Block, maxDistance: number): boolean {
    if (this.seen.get(key(b.position))?.name === b.name) return true;
    if (touching(this.bot, b.position) || canSee(this.bot, b.position.offset(0.5, 0.5, 0.5), maxDistance + 1)) {
      this.record(b);
      return true;
    }
    return false;
  }

  /** Remembered blocks from `ids` within `maxDistance` that are still there. */
  remembered(ids: readonly number[], maxDistance: number): Block[] {
    const names = new Set(ids.map((id) => this.bot.registry.blocks[id]?.name));
    const here = this.bot.entity.position;
    const out: Block[] = [];
    for (const [k, s] of this.seen) {
      if (!names.has(s.name)) continue;
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      if (Math.hypot(x + 0.5 - here.x, y + 0.5 - here.y, z + 0.5 - here.z) > maxDistance) continue;
      const b = this.bot.blockAt(new Vec3(x, y, z));
      if (b?.name === s.name) out.push(b);
    }
    return out;
  }
}

/**
 * The nearest blocks from `ids` that this bot may know about: natural ground anywhere within range, everything else
 * only if perceived now or remembered (§13 rule 4). Nearest first.
 */
export function findKnownBlocks(bot: Bot, ids: readonly number[], maxDistance = 48, count = 16): Block[] {
  if (ids.length === 0) return [];
  const reg = bot.registry;
  const free = ids.filter((id) => isInferable(reg.blocks[id]?.name ?? ''));
  const rare = ids.filter((id) => !free.includes(id));
  const out = findNearestBlocks(bot, [...free], maxDistance, count);
  if (rare.length > 0) {
    const s = Sightings.for(bot);
    const have = new Set<string>();
    for (const b of s.remembered(rare, maxDistance)) {
      have.add(key(b.position));
      out.push(b);
    }
    // And what is in sight now. Over-fetch: most rare blocks in range are hidden in the ground.
    for (const b of findNearestBlocks(bot, [...rare], maxDistance, Math.max(64, count * 4))) {
      if (!have.has(key(b.position)) && s.knows(b, maxDistance)) out.push(b);
    }
  }
  const here = bot.entity.position;
  return out.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here)).slice(0, count);
}
