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

/**
 * How far up the open sky is from where one stands (blocks to the top of what is overhead), as a player in a cave knows
 * the way up; null under the sky already, or when what is overhead isn't known.
 */
export function skyUp(bot: Bot): number | null {
  const feet = bot.entity.position.floored();
  const g = bot.game as unknown as { minY?: number; height?: number };
  const top = (g.minY ?? -64) + (g.height ?? 384);
  let roof: number | null = null;
  for (let y = feet.y + 2; y < top; y++) {
    const b = bot.blockAt(new Vec3(feet.x, y, feet.z));
    if (!b) return null;
    if (b.boundingBox === 'block' && !/_leaves$/.test(b.name)) roof = y;
  }
  return roof === null ? null : roof + 1 - feet.y;
}

/**
 * Where something the hands are going for lies, when it is a walk away: how far and which way, how far up or down, and
 * whether it is out under the open sky while one is under the ground ('' when it is close by). Told only "digging 1
 * oak_log", a mind did not know its hands were taking it 34 blocks up from a mine to a tree, into the night.
 */
export function goingFor(bot: Bot, p: Vec3): string {
  const me = bot.entity.position;
  const dx = p.x + 0.5 - me.x;
  const dz = p.z + 0.5 - me.z;
  const flat = Math.hypot(dx, dz);
  const dy = Math.round(p.y - me.y);
  if (flat < 8 && Math.abs(dy) < 4) return '';
  const dir = COMPASS[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8] ?? 'east';
  const parts = [`${Math.round(flat)} m ${dir}`];
  if (dy >= 4) parts.push(`${dy} m up`);
  else if (dy <= -4) parts.push(`${-dy} m down`);
  const up = skyUp(bot);
  if (up !== null && up >= 6 && skyBeside(bot, p)) parts.push('out under the open sky');
  return parts.join(', ');
}

/** Whether the sky reaches the open cells beside or over a block (the light the ground came with: 10 under leaves). */
function skyBeside(bot: Bot, p: Vec3): boolean {
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] as const) {
    const b = bot.blockAt(p.offset(x, y, z));
    if (b && b.boundingBox === 'empty' && (b.skyLight ?? 0) >= 10) return true;
  }
  return false;
}

/** What one goes looking for under the ground that only the surface has, said as a fact where it was not found. */
export function underTheGround(bot: Bot, what: string): string {
  const up = skyUp(bot);
  return up !== null && up >= 6 ? `; you are underground, the open sky some ${up} blocks up: ${what}` : '';
}

/** A creeper hissing, its fuse burning (or lit with flint and steel): it goes off in a moment and a half. */
export function hissing(bot: Bot, e: Entity): boolean {
  if (e.name !== 'creeper') return false;
  const keys = (bot.registry.entitiesByName[e.name] as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys ?? [];
  const md = e.metadata as unknown[] | undefined;
  const swell = md?.[keys.indexOf('swell_dir')];
  return swell === 1 || md?.[keys.indexOf('is_ignited')] === true;
}

/** A fishing line's bobber pulled under: a fish has bitten (its `biting` flag, as the float dips for a player). */
export function biting(bot: Bot, e: Entity): boolean {
  const keys = (bot.registry.entitiesByName[e.name ?? ''] as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys ?? [];
  const i = keys.indexOf('biting');
  return i >= 0 && (e.metadata as unknown[] | undefined)?.[i] === true;
}

export function isPlayer(e: Entity): boolean {
  return e.type === 'player';
}

export function eyePos(e: Entity): Vec3 {
  return e.position.offset(0, e.height ?? 1.62, 0);
}

/**
 * What a player never looks in the eye: an enderman met in the eye turns on whoever looked (live, a glance round
 * picked one out to look at, and it killed the one who looked).
 */
export function lookAway(e: { name?: string }): boolean {
  return e.name === 'enderman';
}

/** How far off creatures are made out (perception's reach); a hunt looks as far, so what is seen is what it can go after. */
export const CREATURE_SIGHT = 32;

/** Blocks one sees through or past to what is beyond them: glass, bars, fences and the like. */
const SEE_THROUGH = /glass|_pane$|^iron_bars$|_fence$|_fence_gate$|^chain$|^scaffolding$|^(barrier|light|structure_void)$/;

type Ray = (from: Vec3, dir: Vec3, range: number, matcher?: (b: Block & { shapes: number[][] }, iter: { intersect(shapes: number[][], at: Vec3): unknown }) => boolean) => { position: Vec3 } | null;

/**
 * Line of sight from our eyes to the target (§6.1 "plus a line-of-sight raycast"): to its eyes, or failing that the
 * top of its head or its middle (a sheep behind a fence shows its back). Glass, bars and fences don't hide it.
 */
export function canSee(bot: Bot, target: Entity | Vec3, maxDistance = 64): boolean {
  const from = bot.entity.position.offset(0, (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
  const points = target instanceof Vec3 ? [target] : [eyePos(target), target.position.offset(0, (target.height ?? 1.8) + 0.05, 0), target.position.offset(0, (target.height ?? 1.8) / 2, 0)];
  const raycast = (bot.world as unknown as { raycast: Ray }).raycast.bind(bot.world);
  const blocks = (b: Block & { shapes: number[][] }, iter: { intersect(shapes: number[][], at: Vec3): unknown }) => !SEE_THROUGH.test(b.name) && b.shapes.length > 0 && Boolean(iter.intersect(b.shapes, b.position));
  for (const to of points) {
    const delta = to.minus(from);
    const dist = delta.norm();
    if (dist === 0) return true;
    if (dist > maxDistance) return false;
    const hit = raycast(from, delta.normalize(), dist, blocks);
    if (!hit || hit.position.offset(0.5, 0.5, 0.5).distanceTo(from) >= dist - 0.6) return true;
  }
  return false;
}

type Raycast = (from: Vec3, dir: Vec3, range: number) => { position: Vec3 } | null;

/** Points just inside each face of a block (a block counts as seen when any of its faces is in view). */
const FACE_POINTS: readonly [number, number, number][] = [
  [0.5, 0.98, 0.5],
  [0.5, 0.5, 0.5],
  [0.02, 0.5, 0.5],
  [0.98, 0.5, 0.5],
  [0.5, 0.5, 0.02],
  [0.5, 0.5, 0.98],
  [0.5, 0.02, 0.5],
];

/**
 * Line of sight to any face of the block at `pos`: ore in the ground shows its top, ore in a wall its side. Rays
 * pass through blocks without a collision shape (flowers, torches, rails), so those count as seen when nothing
 * else is in the way.
 */
export function canSeeBlock(bot: Bot, pos: Vec3, maxDistance = 64): boolean {
  const from = bot.entity.position.offset(0, (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
  const raycast = (bot.world as unknown as { raycast: Raycast }).raycast.bind(bot.world);
  const target = pos.floored();
  const block = bot.blockAt(target);
  if (!block) return false;
  const shapeless = block.shapes.length === 0;
  for (const [fx, fy, fz] of FACE_POINTS) {
    const to = target.offset(fx, fy, fz);
    const delta = to.minus(from);
    const dist = delta.norm();
    if (dist > maxDistance) continue;
    if (dist < 0.01) return true;
    const hit = raycast(from, delta.normalize(), shapeless ? dist : dist + 0.1);
    if (shapeless ? !hit : hit?.position.equals(target)) return true;
  }
  return false;
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

/**
 * What people make and set down (stations and chests, beds and doors, planks, wool, glass, bricks...): not where any of
 * it comes from. Getting a crafting table, an agent went to dig up the one its companion had set down.
 */
const MADE = /(_planks|_wool|_carpet|glass|_pane|bricks|_concrete|_bed|_door|_trapdoor|_fence|_fence_gate|_sign|_banner|torch|lantern|_slab|_stairs|_button|_pressure_plate|^scaffolding$)$/;

/** Block ids whose drops include an item matching `matcher` (e.g. cobblestone ← stone, cobblestone); never what people make. */
export function blockIdsDropping(bot: Bot, matcher: ItemMatcher): number[] {
  const reg = bot.registry;
  const ids: number[] = [];
  for (const b of reg.blocksArray) {
    if (MADE.test(b.name) || USABLE_BLOCK.test(b.name)) continue;
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

/** What the game lets a block go in over (its own list, water and lava aside): grass, ferns, vines, a layer of snow. */
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush', 'short_dry_grass', 'tall_dry_grass', 'seagrass', 'tall_seagrass', 'fire', 'soul_fire', 'snow', 'vine', 'glow_lichen', 'resin_clump', 'light', 'structure_void', 'bubble_column', 'warped_roots', 'nether_sprouts', 'crimson_roots', 'leaf_litter', 'hanging_roots']);

/**
 * Whether a block set down at this cell goes in: air, or what it replaces. Not a flower, a sapling, a mushroom, a torch
 * or a crop, though one walks through them: those come out first (an agent's crafting table, put down on a tulip, was
 * refused).
 */
export function placeableInto(b: Block | null): boolean {
  if (!b || !REPLACEABLE.has(b.name)) return false;
  if (b.name !== 'snow') return true;
  return Number((b.getProperties() as { layers?: number | string }).layers ?? 1) <= 1;
}

/** Walked through and out with a touch (a flower, a sapling, a torch) before a block goes there. */
export function outByHand(b: Block | null): boolean {
  return Boolean(b && isAirLike(b) && !placeableInto(b) && b.hardness !== null && b.hardness >= 0 && b.hardness < 1);
}

/** Whether a walk to (x, z) would end in water or lava: the first block down from above `y` that isn't air. */
export function wetAt(bot: Bot, x: number, z: number, y: number): boolean {
  for (let dy = 12; dy >= -16; dy--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) + dy, Math.floor(z)));
    // Not loaded: nothing to go by.
    if (!b) return false;
    if (!isAirLike(b)) return ['water', 'lava', 'bubble_column'].includes(b.name);
  }
  return false;
}

/**
 * Blocks a right-click uses rather than builds against (a crafting table opens, a door swings): placing against one
 * needs a sneak, as players do, and a spot on top of one isn't where a block is set down.
 */
export const USABLE_BLOCK = /(crafting_table|chest|barrel|furnace|smoker|anvil|enchanting_table|_door|_trapdoor|_bed|lever|_button|note_block|loom|stonecutter|grindstone|cartography_table|smithing_table|fletching_table|brewing_stand|hopper|dispenser|dropper|beacon|lectern|bell|shulker_box|_fence_gate|composter|cauldron|crafter|jukebox|respawn_anchor)$/;

/** What goes on a face rather than being a block of its own (a torch, a sign, a button): it needs a sturdy one. */
export const ATTACHED = /^(torch|soul_torch|redstone_torch|copper_torch|lantern|soul_lantern|copper_lantern|lever|ladder|tripwire_hook|redstone|repeater|comparator|rail|powered_rail|detector_rail|activator_rail|flower_pot|candle|item_frame|glow_item_frame|painting|\w+_(button|sign|hanging_sign|carpet|pressure_plate|candle))$/;
/** Torches stand on a floor or hang on a wall, never from a ceiling (a lantern can). */
export const NOT_FROM_ABOVE = /^(torch|soul_torch|redstone_torch|copper_torch|ladder|lever|\w+_button|\w+_sign|rail|powered_rail|detector_rail|activator_rail|redstone|repeater|comparator|\w+_carpet|\w+_pressure_plate|flower_pot|candle|\w+_candle)$/;

/**
 * A face that holds a torch, a sign or a button: a whole block's. Not leaves (solid to walk on, but their faces hold
 * nothing: torches put on them were refused), nor a slab's or a fence's part of one.
 */
export function sturdy(b: Block | null): boolean {
  if (!b || !isSolid(b) || /_leaves$/.test(b.name)) return false;
  const shapes = (b as unknown as { shapes?: number[][] }).shapes ?? [];
  const box = shapes[0];
  return shapes.length === 1 && box !== undefined && box[0] === 0 && box[1] === 0 && box[2] === 0 && box[3] === 1 && box[4] === 1 && box[5] === 1;
}

/**
 * A spot within `radius` to set something down (air with ground below; a sturdy floor for what goes on a face). In a
 * meadow with flowers in every cell, one with a flower (placeItemAt picks it first).
 */
export function findPlaceableSpot(bot: Bot, radius = 3, opts: { sturdy?: boolean } = {}): Vec3 | null {
  const me = bot.entity.position.floored();
  // The server refuses a block inside anyone's hitbox, ours included (standing near a cell's edge overlaps it).
  const bodies = Object.values(bot.entities).filter((e) => e === bot.entity || e.type === 'player' || e.type === 'mob' || e.type === 'hostile');
  const occupied = (p: Vec3) => bodies.some((e) => overlapsCell(e, p));
  let picked: Vec3 | null = null;
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const p = me.offset(dx, dy, dz);
          const below = bot.blockAt(p.offset(0, -1, 0));
          const floor = opts.sturdy ? sturdy(below) : isSolid(below);
          const cell = bot.blockAt(p);
          if (isAirLike(cell) && isAirLike(bot.blockAt(p.offset(0, 1, 0))) && floor && !USABLE_BLOCK.test(below?.name ?? '') && !occupied(p)) {
            if (placeableInto(cell)) return p;
            if (outByHand(cell)) picked ??= p;
          }
        }
      }
    }
  }
  return picked;
}

/** Whether an entity's hitbox reaches into the block cell at `cell` (with a hair of margin). */
export function overlapsCell(e: Entity, cell: Vec3): boolean {
  const half = (e.width || 0.6) / 2 + 0.05;
  const h = e.height || 1.8;
  const { x, y, z } = e.position;
  return x + half > cell.x && x - half < cell.x + 1 && z + half > cell.z && z - half < cell.z + 1 && y + h > cell.y && y < cell.y + 1;
}

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** Solid blocks on all four sides at feet and head level (a 1×1 shaft or a sealed nook). */
export function wallsAround(bot: Bot, feet: Vec3 = bot.entity.position.floored()): boolean {
  return SIDES.every((s) => isSolid(bot.blockAt(feet.plus(s))) && isSolid(bot.blockAt(feet.plus(s).offset(0, 1, 0))));
}

/**
 * Daytime as it is felt, the packet's "daytime" (bottleneck's dayPart): from first light (23000 of the day's 24000
 * ticks) until the evening begins (9600). Waited for in the evening, it is the next morning.
 */
export function daytime(timeOfDay: number): boolean {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return t > 23000 || t < 9600;
}

/** Walled in and covered: nothing can walk up to us (§4.5 night shelter). */
export function isEnclosed(bot: Bot, feet: Vec3 = bot.entity.position.floored()): boolean {
  return wallsAround(bot, feet) && isSolid(bot.blockAt(feet.offset(0, 2, 0)));
}

/**
 * Inside a room: a roof over the head and a wall within two blocks every way (a hut's room up to 3 across, its door
 * shut). What is outside the walls can only come in by the door, and is seen if it does.
 */
export function isIndoors(bot: Bot, feet: Vec3 = bot.entity.position.floored()): boolean {
  if (!isSolid(bot.blockAt(feet.offset(0, 2, 0))) && !isSolid(bot.blockAt(feet.offset(0, 3, 0)))) return false;
  return SIDES.every((s) => [1, 2].some((k) => isSolid(bot.blockAt(feet.plus(s.scaled(k)))) || isSolid(bot.blockAt(feet.plus(s.scaled(k)).offset(0, 1, 0)))));
}

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'] as const;

/** The way from one cell to another, by the compass. */
function wayTo(from: Vec3, to: Vec3): string {
  return COMPASS[(Math.round(Math.atan2(to.z - from.z, to.x - from.x) / (Math.PI / 4)) + 8) % 8] ?? 'east';
}

/** A room as one standing in it sees it: how many cells across its floor, which ways it opens out, its doors. */
export interface Room {
  cells: number;
  /** The ways out to the open sky, from where one stands (an open door among them). */
  open: string[];
  /** Doors in its walls: the way to each, and whether it stands open. */
  doors: { way: string; open: boolean }[];
}

/** Bigger than this, or reaching farther, it is a hall or a cave: not a room around one. */
const ROOM_MOST = 36;
const ROOM_REACH = 5;

/**
 * The room one stands in, as a player sees it from inside: the floor at one's own level that can be walked to under a
 * roof, its walls, where it opens out under the sky, its doors (null: under the open sky, or in a hall or a cave too
 * big to take in as a room). A builder who could not fill his hut's doorway went out beside it and waited out the
 * night there, believing himself sealed in.
 */
export function roomAround(bot: Bot, feet: Vec3 = bot.entity.position.floored()): Room | null {
  const roofed = (c: Vec3) => roofedAt(bot, c);
  if (!roofed(feet)) return null;
  const key = (c: Vec3) => `${c.x},${c.z}`;
  const seen = new Set([key(feet)]);
  const queue = [feet];
  const open = new Set<string>();
  const doors = new Map<string, { way: string; open: boolean }>();
  let cells = 0;
  for (let c = queue.shift(); c; c = queue.shift()) {
    if (++cells > ROOM_MOST) return null;
    for (const d of SIDES) {
      const n = c.plus(d);
      if (seen.has(key(n))) continue;
      const lo = bot.blockAt(n);
      const hi = bot.blockAt(n.offset(0, 1, 0));
      if (!lo || !hi) continue;
      if (/_door$/.test(lo.name)) {
        seen.add(key(n));
        const isOpen = (lo.getProperties?.() as { open?: boolean } | undefined)?.open === true;
        doors.set(key(n), { way: wayTo(feet, n), open: isOpen });
        if (isOpen && !roofed(n.plus(d))) open.add(wayTo(feet, n));
        continue;
      }
      if (isSolid(lo) || isSolid(hi) || lo.name === 'lava') continue;
      seen.add(key(n));
      if (Math.max(Math.abs(n.x - feet.x), Math.abs(n.z - feet.z)) > ROOM_REACH) return null;
      if (!roofed(n)) {
        open.add(wayTo(feet, n));
        continue;
      }
      queue.push(n);
    }
  }
  return { cells, open: [...open], doors: [...doors.values()] };
}

/** A roof over a cell, two to five blocks up (a tree's leaves are no roof). */
function roofedAt(bot: Bot, c: Vec3): boolean {
  for (let dy = 2; dy <= 5; dy++) {
    const b = bot.blockAt(c.offset(0, dy, 0));
    if (!b) return false;
    if (isSolid(b) && !/_leaves$/.test(b.name)) return true;
  }
  return false;
}

/**
 * A room one stands just outside of, within two blocks, as one sees a hut from beside its walls: the way to its
 * inside and what it is like (null: none). A builder who had shut his hut's doorway with himself outside it waited
 * out the night there "sealed in", under the open sky.
 */
export function roomBeside(bot: Bot, feet: Vec3 = bot.entity.position.floored()): { way: string; distance: number; room: Room } | null {
  let best: { way: string; distance: number; room: Room } | null = null;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue;
      const c = feet.offset(dx, 0, dz);
      const lo = bot.blockAt(c);
      const hi = bot.blockAt(c.offset(0, 1, 0));
      if (!lo || !hi || isSolid(lo) || isSolid(hi) || lo.name === 'water' || lo.name === 'lava' || !roofedAt(bot, c)) continue;
      const room = roomAround(bot, c);
      if (!room || room.cells > 9) continue;
      const distance = Math.hypot(dx, dz);
      if (!best || distance < best.distance) best = { way: wayTo(feet, c), distance, room };
    }
  }
  return best;
}

/** A room one is outside of, in words ("outside a room 1 m to the west, shut on every side"). */
export function besideWords(b: { way: string; distance: number; room: Room } | null): string | null {
  if (!b) return null;
  const how = b.room.open.length === 0 ? 'shut on every side' : `open to the ${b.room.open.slice(0, 2).join(' and the ')}`;
  return `outside a room ${Math.max(1, Math.round(b.distance))} m to the ${b.way}, ${how}`;
}

/** A room in words, for where one is ("inside a room, open to the north"; null: not in one). */
export function roomWords(r: Room | null): string | null {
  if (!r) return null;
  const small = r.cells <= 3;
  const shut = r.doors.filter((d) => !d.open).map((d) => `a door to the ${d.way}, shut`);
  if (r.open.length === 0) return `${small ? 'walled in on every side' : 'inside a room, shut in on every side'}${shut.length > 0 ? ` (${shut.join('; ')})` : ''}`;
  const ways = r.open.slice(0, 3);
  const openDoors = r.doors.filter((d) => d.open).map((d) => d.way);
  const out = `open to the ${ways.join(' and the ')}${openDoors.length > 0 ? ` (the door to the ${openDoors.join(' and the ')} standing open)` : ''}`;
  return `${small ? 'walled in but' : 'inside a room,'} ${out}`;
}

/** Where a block is from where one stands, in words ("beside you to the north, at head height", "3 m to the east"). */
export function whereFrom(feet: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }): string {
  const dx = p.x - feet.x;
  const dy = p.y - feet.y;
  const dz = p.z - feet.z;
  const flat = Math.hypot(dx, dz);
  if (flat < 0.5) return dy >= 2 ? 'right over your head' : dy < 0 ? 'right under your feet' : 'where you stand';
  const dir = COMPASS[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8] ?? 'east';
  const level = dy >= 2 ? ', up high' : dy === 1 ? ', at head height' : dy === 0 ? ', at your feet' : ', below you';
  return flat <= 1.5 ? `beside you to the ${dir}${level}` : `${Math.round(flat)} m to the ${dir}${dy >= 2 || dy < 0 ? level : ''}`;
}

/** The cells of a dug-in shelter around the feet: the roof first, then the four sides at head and at feet height. */
const SHELTER_CELLS: readonly [number, number, number][] = [
  [0, 2, 0],
  [1, 1, 0],
  [-1, 1, 0],
  [0, 1, 1],
  [0, 1, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Whether `p` is one of the cells of a dug-in shelter around feet at `feet` (its walls and its roof). */
export function isShelterCell(feet: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }): boolean {
  return SHELTER_CELLS.some(([x, y, z]) => feet.x + x === p.x && feet.y + y === p.y && feet.z + z === p.z);
}

/** The first part of a shelter around us that is gone (the roof, a wall), in words; null while it is whole. */
export function shelterHole(bot: Bot, feet: Vec3 = bot.entity.position.floored()): string | null {
  for (const [x, y, z] of SHELTER_CELLS) {
    const p = feet.offset(x, y, z);
    if (!isSolid(bot.blockAt(p))) return whereFrom(feet, p);
  }
  return null;
}

/**
 * The biome at a place, by name ("plains"). The block's own biome comes back nameless on this version; the world's
 * biome id, looked up in the registry the server sent, has it. Null where nothing is loaded.
 */
export function biomeAt(bot: Bot, pos: Vec3): string | null {
  const id = (bot.world as unknown as { getBiome?: (p: Vec3) => number | null | undefined }).getBiome?.(pos.floored());
  const fromWorld = id === null || id === undefined ? undefined : (bot.registry.biomes as unknown as Record<number, { name?: string } | undefined> | undefined)?.[id]?.name;
  const fromBlock = (bot.blockAt(pos) as unknown as { biome?: { name?: string } } | null)?.biome?.name;
  return fromWorld || fromBlock || null;
}

export function isNight(bot: Bot): boolean {
  const t = bot.time.timeOfDay;
  return t >= 13000 && t < 23000;
}
