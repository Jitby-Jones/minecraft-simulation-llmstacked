// World queries from the bot's own client only (§6.1): blocks it has loaded, entities it tracks, line of sight.

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { type ItemMatcher, blockMatcher } from './items';

export function entityLabel(e: Entity): string {
  if (e.type === 'player') return e.username ?? e.name ?? 'player';
  return e.name ?? e.displayName ?? 'entity';
}

const EXTRA_HOSTILE = new Set(['slime', 'magma_cube', 'phantom', 'ghast', 'hoglin', 'zoglin', 'shulker', 'warden', 'breeze', 'bogged', 'creaking']);

export function isHostile(e: Entity): boolean {
  if (e.type === 'hostile') return true;
  return EXTRA_HOSTILE.has(e.name ?? '');
}

/** A living entity's health from its synced metadata; mineflayer only tracks our own (`bot.health`). */
export function entityHealth(bot: Bot, e: Entity): number | undefined {
  const keys = (bot.registry.entitiesByName[e.name ?? ''] as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys;
  const idx = keys ? keys.indexOf('health') : -1;
  const v = idx >= 0 ? (e.metadata as unknown[] | undefined)?.[idx] : undefined;
  return typeof v === 'number' ? v : e.health;
}

export function isPlayer(e: Entity): boolean {
  return e.type === 'player';
}

export function eyePos(e: Entity): Vec3 {
  return e.position.offset(0, e.height ?? 1.62, 0);
}

/** Line-of-sight raycast from our eyes to the target's eyes (§6.1 "plus a line-of-sight raycast"). */
export function canSee(bot: Bot, target: Entity | Vec3, maxDistance = 64): boolean {
  const from = bot.entity.position.offset(0, (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
  const to = target instanceof Vec3 ? target : eyePos(target);
  const delta = to.minus(from);
  const dist = delta.norm();
  if (dist === 0) return true;
  if (dist > maxDistance) return false;
  const hit = (bot.world as unknown as { raycast(from: Vec3, dir: Vec3, range: number): { position: Vec3 } | null }).raycast(
    from,
    delta.normalize(),
    dist,
  );
  if (!hit) return true;
  return hit.position.offset(0.5, 0.5, 0.5).distanceTo(from) >= dist - 0.6;
}

export function playerEntity(bot: Bot, username: string): Entity | null {
  const p = bot.players[username];
  return p?.entity ?? null;
}

/** Entity by player username or mob type, nearest first. Only entities our client tracks. */
export function findEntity(bot: Bot, nameOrType: string, maxDistance = 48): Entity | null {
  const lower = nameOrType.toLowerCase();
  const player = Object.values(bot.players).find((p) => p.username.toLowerCase() === lower)?.entity;
  if (player && player.position.distanceTo(bot.entity.position) <= maxDistance) return player;
  return bot.nearestEntity(
    (e) =>
      e !== bot.entity &&
      (e.name?.toLowerCase() === lower || e.username?.toLowerCase() === lower) &&
      e.position.distanceTo(bot.entity.position) <= maxDistance,
  );
}

export function nearbyHostiles(bot: Bot, radius: number): Entity[] {
  const out: Entity[] = [];
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !isHostile(e)) continue;
    if (e.position.distanceTo(bot.entity.position) <= radius) out.push(e);
  }
  return out.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

// Mobs whose ambient sounds carry through walls (groans, rattles, hisses). Creepers are silent until they fuse.
const NOISY = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider',
  'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'zombified_piglin', 'piglin', 'hoglin', 'zoglin',
  'blaze', 'wither_skeleton', 'slime', 'magma_cube', 'silverfish', 'warden']);

/** Hostiles we could hear from here (no line of sight needed): what a player in a shelter knows is outside. */
export function audibleHostiles(bot: Bot, radius: number): Entity[] {
  return nearbyHostiles(bot, radius).filter((e) => NOISY.has(e.name ?? ''));
}

/** Block ids whose drops include an item matching `matcher` (e.g. cobblestone ← stone, cobblestone). */
export function blockIdsDropping(bot: Bot, matcher: ItemMatcher): number[] {
  const reg = bot.registry;
  const ids: number[] = [];
  for (const b of reg.blocksArray) {
    if (matcher.matches(b.name)) {
      ids.push(b.id);
      continue;
    }
    const drops = (b as unknown as { drops?: (number | { drop: number | { id: number } })[] }).drops ?? [];
    for (const d of drops) {
      const id = typeof d === 'number' ? d : typeof d.drop === 'number' ? d.drop : d.drop.id;
      const item = reg.items[id];
      if (item && matcher.matches(item.name)) {
        ids.push(b.id);
        break;
      }
    }
  }
  return ids;
}

export function blockIdsNamed(bot: Bot, raw: string): number[] {
  const m = blockMatcher(raw);
  return bot.registry.blocksArray.filter((b) => m.matches(b.name)).map((b) => b.id);
}

/** Every loaded block, seen or not: skills go through `findKnownBlocks` (sightings.ts) instead. */
export function findNearestBlocks(bot: Bot, ids: number[], maxDistance = 48, count = 16): Block[] {
  if (ids.length === 0) return [];
  const positions = bot.findBlocks({ matching: ids, maxDistance, count });
  const out: Block[] = [];
  for (const p of positions) {
    const b = bot.blockAt(p);
    if (b) out.push(b);
  }
  return out;
}

export function lightLevelAt(bot: Bot, pos: Vec3): number {
  const b = bot.blockAt(pos);
  if (!b) return 15;
  const block = b as unknown as { light?: number; skyLight?: number };
  const isDay = bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000;
  const sky = isDay ? (block.skyLight ?? 15) : Math.max(0, (block.skyLight ?? 15) - 11);
  return Math.max(block.light ?? 0, sky);
}

export function isSolid(b: Block | null): boolean {
  return Boolean(b && b.boundingBox === 'block' && !['water', 'lava'].includes(b.name));
}

export function isAirLike(b: Block | null): boolean {
  return Boolean(b && b.boundingBox === 'empty' && !['water', 'lava'].includes(b.name));
}

/** A spot within `radius` where a block can be placed (air with solid ground below), excluding our own column. */
export function findPlaceableSpot(bot: Bot, radius = 3): Vec3 | null {
  const me = bot.entity.position.floored();
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const p = me.offset(dx, dy, dz);
          if (isAirLike(bot.blockAt(p)) && isAirLike(bot.blockAt(p.offset(0, 1, 0))) && isSolid(bot.blockAt(p.offset(0, -1, 0)))) {
            return p;
          }
        }
      }
    }
  }
  return null;
}

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** Solid blocks on all four sides at feet and head level (a 1×1 shaft or a sealed nook). */
export function wallsAround(bot: Bot, feet: Vec3 = bot.entity.position.floored()): boolean {
  return SIDES.every((s) => isSolid(bot.blockAt(feet.plus(s))) && isSolid(bot.blockAt(feet.plus(s).offset(0, 1, 0))));
}

/** Walled in and covered: nothing can walk up to us (§4.5 night shelter). */
export function isEnclosed(bot: Bot, feet: Vec3 = bot.entity.position.floored()): boolean {
  return wallsAround(bot, feet) && isSolid(bot.blockAt(feet.offset(0, 2, 0)));
}

export function isNight(bot: Bot): boolean {
  const t = bot.time.timeOfDay;
  return t >= 13000 && t < 23000;
}
