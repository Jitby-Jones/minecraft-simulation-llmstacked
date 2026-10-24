// What the long runs check (owner request, 2026-10-24), from outside the agents: test code reading what their own
// clients have of the world, never telling them anything. Each check says whether a task's end is there in the world:
// diamonds come by, the Nether been to, a full set of iron armor at once, cows kept in a pen, a house (a roofed room
// behind a door), an enchanting table, a food supply that renews itself (crops planted, or animals bred).

import { type Bot, Vec3 } from '@agora/agent/body/bot';

type Entity = Bot['entity'];

export const IRON_ARMOR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'] as const;
export const IRON_TOOLS = ['iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_sword'] as const;
const CROPS = ['wheat', 'carrots', 'potatoes', 'beetroots'];
const BREEDABLE = new Set(['cow', 'sheep', 'pig', 'chicken', 'rabbit', 'goat', 'mooshroom']);

/** All a body has: its inventory and what it wears. */
export function owned(bot: Bot): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  for (const slot of [5, 6, 7, 8, 45]) {
    const it = bot.inventory.slots[slot];
    if (it) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  }
  return m;
}

export function hasAll(bot: Bot, items: readonly string[]): boolean {
  const m = owned(bot);
  return items.every((i) => (m.get(i) ?? 0) > 0);
}

const solidAt = (bot: Bot, p: Vec3): boolean => {
  const b = bot.blockAt(p);
  return Boolean(b && b.boundingBox === 'block');
};

/**
 * The ground cells around a creature it can't walk out of: a flood fill at its feet' level through what has no
 * collision, stopped by fences and walls; null if it gets out (more than `max` cells), or nothing is loaded there.
 */
export function enclosure(bot: Bot, at: Vec3, max = 600): { cells: Set<string>; fences: number } | null {
  const start = at.floored();
  const key = (x: number, z: number) => `${x},${z}`;
  const cells = new Set<string>([key(start.x, start.z)]);
  const queue: [number, number][] = [[start.x, start.z]];
  let fences = 0;
  const walls = new Set<string>();
  while (queue.length > 0) {
    const [x, z] = queue.shift() as [number, number];
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const nz = z + dz;
      const k = key(nx, nz);
      if (cells.has(k) || walls.has(k)) continue;
      const b = bot.blockAt(new Vec3(nx, start.y, nz));
      if (!b) return null;
      if (b.boundingBox === 'block') {
        walls.add(k);
        if (/_fence$|_fence_gate$|_wall$/.test(b.name)) fences++;
        continue;
      }
      cells.add(k);
      if (cells.size > max) return null;
      queue.push([nx, nz]);
    }
  }
  return { cells, fences };
}

/** Cows kept in a fenced pen (two or more in one), and how many. */
export function cowFarm(bot: Bot): { cows: number; at: Vec3 } | null {
  const cows = Object.values(bot.entities).filter((e) => e.name === 'cow' && e.position.distanceTo(bot.entity.position) <= 128);
  const done = new Set<number>();
  for (const c of cows) {
    if (done.has(c.id)) continue;
    const pen = enclosure(bot, c.position);
    if (!pen || pen.fences < 4) continue;
    const inside = cows.filter((o) => pen.cells.has(`${Math.floor(o.position.x)},${Math.floor(o.position.z)}`) && Math.abs(o.position.y - c.position.y) < 2);
    for (const o of inside) done.add(o.id);
    if (inside.length >= 2) return { cows: inside.length, at: c.position.floored() };
  }
  return null;
}

/**
 * A house: a door with a roofed room behind it that a creature can't walk out of (closed in all round, a roof over
 * every cell of it). Doors that were there at the start (a village's) don't count, nor (with `ours`) any but those
 * the agents set down: a solo's tunnel at y -5 by a door it never placed (a structure's, found later) was counted.
 */
export function house(bot: Bot, before: ReadonlySet<string>, ours: (p: Vec3) => boolean = () => true): { door: Vec3; room: number } | null {
  const doorIds = bot.registry.blocksArray.filter((b) => b.name.endsWith('_door')).map((b) => b.id);
  for (const p of bot.findBlocks({ matching: doorIds, maxDistance: 96, count: 40 })) {
    if (before.has(p.toString())) continue;
    if (!ours(p) && !ours(p.offset(0, -1, 0))) continue;
    const door = bot.blockAt(p);
    if (!door || String(door.getProperties?.().half ?? 'lower') !== 'lower') continue;
    for (const side of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      const inside = p.plus(side);
      if (solidAt(bot, inside) || solidAt(bot, inside.offset(0, 1, 0))) continue;
      const room = enclosure(bot, inside, 200);
      if (!room || room.cells.size < 3) continue;
      // The door's own cell is part of the room's wall, not the room.
      const roofed = [...room.cells].every((k) => {
        const [x, z] = k.split(',').map(Number) as [number, number];
        if (x === p.x && z === p.z) return true;
        for (let dy = 2; dy <= 6; dy++) if (solidAt(bot, new Vec3(x, p.y + dy, z))) return true;
        return false;
      });
      if (roofed) return { door: p, room: room.cells.size };
    }
  }
  return null;
}

/** Crops growing on farmland that weren't there at the start, within reach of sight. */
export function cropsPlanted(bot: Bot, before: ReadonlySet<string>): number {
  const ids = CROPS.map((c) => bot.registry.blocksByName[c]?.id).filter((x): x is number => x !== undefined);
  return bot.findBlocks({ matching: ids, maxDistance: 96, count: 400 }).filter((p) => !before.has(p.toString()) && bot.blockAt(p.offset(0, -1, 0))?.name === 'farmland').length;
}

export function cropPositions(bot: Bot): Set<string> {
  const ids = CROPS.map((c) => bot.registry.blocksByName[c]?.id).filter((x): x is number => x !== undefined);
  return new Set(bot.findBlocks({ matching: ids, maxDistance: 128, count: 4000 }).map((p) => p.toString()));
}

export function doorPositions(bot: Bot): Set<string> {
  const ids = bot.registry.blocksArray.filter((b) => b.name.endsWith('_door')).map((b) => b.id);
  return new Set(bot.findBlocks({ matching: ids, maxDistance: 128, count: 400 }).map((p) => p.toString()));
}

export function placedNear(bot: Bot, block: string, before: ReadonlySet<string>): Vec3 | null {
  const id = bot.registry.blocksByName[block]?.id;
  if (id === undefined) return null;
  return bot.findBlocks({ matching: [id], maxDistance: 96, count: 20 }).find((p) => !before.has(p.toString())) ?? null;
}

export function blockPositions(bot: Bot, block: string): Set<string> {
  const id = bot.registry.blocksByName[block]?.id;
  if (id === undefined) return new Set();
  return new Set(bot.findBlocks({ matching: [id], maxDistance: 128, count: 200 }).map((p) => p.toString()));
}

/** A baby animal of a kind that breeds, close by (bred, as babies don't come any other way near people). */
export function isBabyAnimal(bot: Bot, e: Entity): boolean {
  if (!BREEDABLE.has(e.name ?? '')) return false;
  const keys = (bot.registry.entitiesByName[e.name ?? ''] as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys ?? [];
  return (e.metadata as unknown[] | undefined)?.[keys.indexOf('baby')] === true;
}
