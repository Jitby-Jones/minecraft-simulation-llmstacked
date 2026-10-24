// Village skills (§6.8): hunt, build a hut, post on the notice board, walk a patrol. Schematic code, not
// LLM-placed blocks (§12); everything they find out, the agent found out with its own eyes.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { isSignBlock, readSign, wrapForSign } from '../signs';
import { CREATURE_SIGHT, canSee, isAirLike, isHostile, isSolid } from '../world';
import { bearingOf } from '../../perception/sceneWords';
import { BOARD_RADIUS } from '../../perception/village';
import { sharedRepertoire } from '../../building/repertoire';
import { placeItemAt } from './building';
import { bestWeapon, equipBestWeapon, pvp } from './combat';
import { buildDesign } from './construct';
import { stopCollecting } from './gathering';
import { ensureTool } from './tools';
import { abortable, digBlock, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

// --- hunt ---------------------------------------------------------------------------------------------------------

export const ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'] as const;
const MEAT = /^(beef|porkchop|mutton|chicken|rabbit)$/;

function nearestAnimal(bot: Bot, kinds: readonly string[], radius: number): Entity | null {
  return bot.nearestEntity((e) => e !== bot.entity && kinds.includes(e.name ?? '') && e.position.distanceTo(bot.entity.position) <= radius && canSee(bot, e, radius + 1));
}

/** As far as the world shows animals (the server's tracking range): one past our sight, to say where the next ones are. */
const FAR_OFF = 96;

/** Where the nearest of these animals in view beyond our sight is, in words ('' if none shows). */
function fartherAnimal(bot: Bot, kinds: readonly string[]): string {
  const far = nearestAnimal(bot, kinds, FAR_OFF);
  if (!far) return '';
  const p = far.position;
  return `; the nearest in view is a ${far.name ?? 'animal'} ${Math.round(p.distanceTo(bot.entity.position))} m ${bearingOf(bot.entity.position, p)}, at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
}

/** Walks over the drops near where an animal fell. */
async function collectDropsAt(ctx: SkillContext, where: Vec3): Promise<void> {
  const { bot } = ctx;
  for (let i = 0; i < 4; i++) {
    const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(where) <= 4);
    if (!drop) return;
    bot.pathfinder.setMovements(ctx.movements());
    try {
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), 8000), () => stopMotion(bot));
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      stopMotion(bot);
      return;
    }
    await waitMs(ctx, 350);
  }
}

export const hunt = defineSkill({
  name: 'hunt',
  description: 'hunt {animal?, qty?} — kill farm animals in sight (cow, pig, sheep, chicken) for raw meat and pick it up',
  argsSchema: z.object({ animal: z.enum(ANIMALS).optional(), qty: z.coerce.number().int().min(1).max(16).default(3) }),
  talkOverable: false,
  slipKinds: ['tool'],
  expect: (args) => ({ kind: 'inventoryGain', item: 'meat', atLeast: Math.min(args.qty, 1) }),
  async run(ctx, args) {
    const { bot } = ctx;
    const meat = () => bot.inventory.items().filter((i) => MEAT.test(i.name)).reduce((a, i) => a + i.count, 0);
    const start = meat();
    const kinds = args.animal ? [args.animal] : [...ANIMALS];
    const deadline = Date.now() + 120_000;
    let kills = 0;
    // Hunting with bare hands takes many blows: a sword first, made if we can (tools.ts); without one, hands.
    if (!bestWeapon(bot) && nearestAnimal(bot, kinds, CREATURE_SIGHT)) {
      await ensureTool(ctx, 'sword').catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
    }
    await stopCollecting(bot);
    try {
      while (meat() - start < args.qty && Date.now() < deadline && kills < args.qty + 2) {
        throwIfAborted(ctx.signal);
        const prey = nearestAnimal(bot, kinds, CREATURE_SIGHT);
        if (!prey) break;
        if (ctx.slip !== 'tool') await equipBestWeapon(bot);
        const p = pvp(bot);
        p.attack(prey);
        const until = Date.now() + 25_000;
        let last = prey.position.clone();
        try {
          await abortable(
            ctx.signal,
            (async () => {
              while (bot.entities[prey.id] && Date.now() < until) {
                last = prey.position.clone();
                await waitMs(ctx, 250);
              }
            })(),
            () => p.forceStop(),
          );
        } finally {
          p.forceStop();
        }
        if (bot.entities[prey.id]) break;
        kills++;
        ctx.progress(`hunt: ${kills} down`);
        await waitMs(ctx, 500);
        await collectDropsAt(ctx, last);
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `hunt failed after ${kills} kill(s)`, error: errMsg(err) };
    }
    const got = meat() - start;
    if (got <= 0) {
      if (kills > 0) return { ok: false, observed: 'killed but picked nothing up', error: 'lost the meat', data: { kills } };
      const which = args.animal ?? 'animal';
      return { ok: false, observed: `no ${which} within ${CREATURE_SIGHT} m${fartherAnimal(bot, kinds)}`, error: `no ${which} to hunt nearby`, data: { kills } };
    }
    return { ok: got >= Math.min(args.qty, 1), observed: `hunted ${kills} animal(s), +${got} raw meat`, data: { kills, meat: got } };
  },
});

// --- build a hut ----------------------------------------------------------------------------------------------------

/** Blocks a hut can be made of, best first. */
/** What a hut is built of, in the order used: stone, then planks of any wood (acacia in a savanna), then dirt. */
export const HUT_MATERIALS = ['cobblestone', 'cobbled_deepslate', 'stone_bricks', 'planks', 'dirt'] as const;
const hutRank = (name: string): number => HUT_MATERIALS.indexOf((name.endsWith('_planks') ? 'planks' : name) as (typeof HUT_MATERIALS)[number]);
/** A block a hut can be built of. */
export const isHutMaterial = (name: string): boolean => hutRank(name) >= 0;

/** The hut block to place next: the first kind in HUT_MATERIALS' order that we carry. */
function hutBlock(bot: Bot): string | undefined {
  return bot.inventory
    .items()
    .filter((i) => isHutMaterial(i.name))
    .sort((a, b) => hutRank(a.name) - hutRank(b.name))[0]?.name;
}
const DOORS = /_door$/;

/**
 * A hut's room is 1, 2 or 3 blocks across: 3 if not said; 1, a night's shelter for one, as a player's first dirt hut;
 * 2, for two. On their first evening two agents set out for the 75 blocks of the big one and were short at dark.
 */
const sideOf = (room: number): number => room + 2;
/** Walls this high: a small room's two, the big one's three. */
const wallsOf = (room: number): number => (room < 3 ? 2 : 3);

/** A hut around a room `room` across: walls with a doorway in the middle of one side, then a flat roof, rim first. */
export function hutPlan(room = 3): Vec3[] {
  const f = sideOf(room);
  const h = wallsOf(room);
  const mid = Math.floor(f / 2);
  const walls: Vec3[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < f; x++) {
      for (let z = 0; z < f; z++) {
        const edge = x === 0 || x === f - 1 || z === 0 || z === f - 1;
        const door = x === mid && z === 0 && y < 2;
        if (edge && !door) walls.push(new Vec3(x, y, z));
      }
    }
  }
  const roof: Vec3[] = [];
  for (let x = 0; x < f; x++) for (let z = 0; z < f; z++) roof.push(new Vec3(x, h, z));
  // The rim rests on the walls; then inward, so every block has a neighbor to go against.
  const c = (f - 1) / 2;
  roof.sort((a, b) => Math.max(Math.abs(b.x - c), Math.abs(b.z - c)) - Math.max(Math.abs(a.x - c), Math.abs(a.z - c)));
  return [...walls, ...roof];
}

/** Shallow holes a hut site may have under it, filled before the walls go up (dug-up ground by home, §6.8). */
export const HUT_HOLES = 4;
/** The blocks a hut takes, with enough over to fill the holes in its site. */
export const hutBlocks = (room = 3): number => hutPlan(room).length + HUT_HOLES;
export const HUT_BLOCKS = hutBlocks();
/** Where the door goes in the plan (its lower half). */
export const hutDoor = (room = 3): Vec3 => new Vec3(Math.floor(sideOf(room) / 2), 0, 0);
export const HUT_DOOR = hutDoor();
/** The middle of the room inside. */
const hutRoom = (room: number): Vec3 => new Vec3(Math.floor(sideOf(room) / 2), 0, Math.floor(sideOf(room) / 2));

const free = (bot: Bot, p: Vec3) => isAirLike(bot.blockAt(p));

/** Ground a player digs out of the way in a moment: earth, sand, stone, leaves (not a tree's trunk, nor deepslate). */
const DIGGABLE_BUMP = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|dirt_path|sand|red_sand|gravel|clay|mud|moss_block|snow_block|stone|cobblestone|andesite|diorite|granite|tuff|calcite|sandstone|red_sandstone|terracotta|\w+_terracotta)$|_leaves$/;
/** At most this much of a slope dug away for a hut: a bump or two out of a hillside, not the hill. */
export const HUT_BUMPS = 12;

/**
 * What a hut at corner `c` needs done first: the holes one deep under it to fill and, when `bumpsAllowed`, the earth
 * or stone in its way to dig out (a hillside); null when the site won't do. Agents on hilly ground were told, night
 * after night, there was no level spot for a hut, and one gathered logs in the dark instead.
 */
export function hutSiteWork(bot: Bot, c: Vec3, room = 3, bumpsAllowed = 0): { holes: Vec3[]; bumps: Vec3[] } | null {
  const f = sideOf(room);
  const holes: Vec3[] = [];
  const bumps: Vec3[] = [];
  for (let x = -1; x <= f; x++) {
    for (let z = -1; z <= f; z++) {
      const inside = x >= 0 && x < f && z >= 0 && z < f;
      for (let y = 0; y <= wallsOf(room); y++) {
        const p = c.offset(x, y, z);
        if (free(bot, p)) continue;
        if (bumps.length >= bumpsAllowed || !DIGGABLE_BUMP.test(bot.blockAt(p)?.name ?? '')) return null;
        bumps.push(p);
      }
      if (!inside || isSolid(bot.blockAt(c.offset(x, -1, z)))) continue;
      // A hole one deep in solid ground is filled; anything deeper, or water, rules the site out.
      if (!free(bot, c.offset(x, -1, z)) || !isSolid(bot.blockAt(c.offset(x, -2, z))) || holes.length >= HUT_HOLES) return null;
      holes.push(c.offset(x, -1, z));
    }
  }
  return { holes, bumps };
}

/** Ground cells under a hut at corner `c` that are a hole one deep (to fill), or null when the site won't do. */
export function hutSiteHoles(bot: Bot, c: Vec3, room = 3): Vec3[] | null {
  return hutSiteWork(bot, c, room)?.holes ?? null;
}

/** Solid, but no ground to build on: a tree's canopy or trunk. */
const NOT_GROUND = /_(leaves|log|wood|stem)$|^(vine|brown_mushroom_block|red_mushroom_block|mushroom_stem)$/;

/** The top of the ground at (x, z) within 8 blocks of height `y`: a solid block with room above it (null: none). */
function groundAt(bot: Bot, x: number, z: number, y: number): number | null {
  for (let yy = y + 8; yy >= y - 8; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z));
    if (isSolid(b) && !NOT_GROUND.test(b?.name ?? '') && free(bot, new Vec3(x, yy + 1, z))) return yy;
  }
  return null;
}

/** Within this of home, a hut goes up about home; farther off, where one is. */
const HUT_HOME_RANGE = 48;

/**
 * The nearest corner near `center` with level, solid ground under the hut (a few shallow holes are filled), room for
 * it and a free cell all round; of those at the same distance, the one with the least to do. The height follows
 * the ground (on a hillside the level patch is rarely at home's own height). With `bumpsAllowed`, a site with that
 * much earth or stone to dig out of the way will do too.
 */
export function findHutSite(bot: Bot, center: Vec3, radius = 20, minDist = 4, room = 3, bumpsAllowed = 0): Vec3 | null {
  const base = center.floored();
  const mid = Math.floor(sideOf(room) / 2);
  for (let r = minDist; r <= radius; r++) {
    let best: { c: Vec3; work: number } | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        // The ground under the middle of the hut sets its height (home's own as well, as before).
        const g = groundAt(bot, base.x + dx + mid, base.z + dz + mid, base.y - 1);
        const heights = [...new Set([...(g === null ? [] : [g + 1, g + 2, g]), base.y, base.y + 1, base.y - 1])];
        for (const y of heights) {
          const c = new Vec3(base.x + dx, y, base.z + dz);
          const w = hutSiteWork(bot, c, room, bumpsAllowed);
          const work = w ? w.holes.length + w.bumps.length : Infinity;
          if (w && (!best || work < best.work)) best = { c, work };
          if (best?.work === 0) return best.c;
        }
      }
    }
    if (best) return best.c;
  }
  return null;
}

function buildingBlocks(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => isHutMaterial(i.name))
    .reduce((a, i) => a + i.count, 0);
}

export const build = defineSkill({
  name: 'build',
  description: `build {design: name, x?,y?,z?, facing?} — put up one of the village's buildings near home (a plains cottage, a taiga cabin, a farmhouse, a storehouse, a smithy, a wheat farm, ... or one designed for us), or at x,y,z (its north-west corner on the ground): clears and levels the ground, builds it block by block, says what it still lacks; again to carry on. {structure: hut, room?: 1|2|3, x?,y?,z?} is the quick hut of cobblestone, planks or dirt round a room 1, 2 or 3 blocks across (by home, or the nearest spot to x,y,z) (${hutBlocks(1)}, ${hutBlocks(2)} or ${hutBlocks(3)} blocks; 3 if not said)`,
  argsSchema: z.object({
    structure: z.string().min(1).optional(),
    room: z.coerce.number().int().min(1).max(3).optional(),
    design: z.string().min(1).optional(),
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
    z: z.coerce.number().optional(),
    facing: z.enum(['north', 'east', 'south', 'west']).optional(),
  }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const asked = args.design ?? (args.structure && args.structure !== 'hut' ? args.structure : null);
    if (asked) return buildDesign(ctx, asked, { x: args.x, y: args.y, z: args.z, facing: args.facing }, async () => sharedRepertoire());
    const { bot } = ctx;
    const room = args.room ?? 3;
    const need = hutBlocks(room);
    const have = buildingBlocks(bot);
    if (have < need) return { ok: false, observed: `have ${have} building blocks`, error: `need ${need - have} more building blocks (cobblestone, planks or dirt)` };
    // Near home, about home; far from it, where one is (one 200 blocks off at dusk was told there was no spot "near
    // home", and walked home through the night).
    // Where it was asked for, the nearest spot to it (asked for at its own feet, one went up by home, 40 blocks off).
    const me = bot.entity.position;
    const spot = args.x !== undefined && args.y !== undefined && args.z !== undefined ? new Vec3(args.x, args.y, args.z) : null;
    const nearHome = !spot && ctx.home !== undefined && ctx.home !== null && ctx.home.distanceTo(me) <= HUT_HOME_RANGE;
    const center = spot ?? (nearHome && ctx.home ? ctx.home : me);
    const from = new Vec3(center.x, center.y, center.z);
    const minDist = spot ? 0 : nearHome ? 4 : 2;
    // Level ground first; on a slope, a site with a bump or two to dig out of the way.
    const corner = findHutSite(bot, from, 20, minDist, room) ?? findHutSite(bot, from, 20, minDist, room, HUT_BUMPS);
    if (!corner) return { ok: false, observed: 'no room', error: `no spot for a hut within 20 blocks of ${spot ? 'there' : nearHome ? 'home' : 'here'}, even digging a little out of a slope (a design, e.g. build {design: "starter-hut"}, clears and levels its own)` };
    const at = { x: corner.x, y: corner.y, z: corner.z };
    const work = hutSiteWork(bot, corner, room, HUT_BUMPS) ?? { holes: [], bumps: [] };
    // What is in the way first, from the top down (a bump dug from under what is on it brings that down).
    for (const p of [...work.bumps].sort((a, b) => b.y - a.y)) {
      throwIfAborted(ctx.signal);
      const b = bot.blockAt(p);
      if (!b || free(bot, p)) continue;
      try {
        if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4) await gotoNear(ctx, p, 3, 20_000);
        const tool = bot.pathfinder.bestHarvestTool(b);
        if (tool) await bot.equip(tool, 'hand');
        await digBlock(ctx, b);
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        ctx.logger.debug({ module: 'skill', cell: p.toString(), err: errMsg(err) }, 'bump not dug');
      }
    }
    // The holes in the ground next, so the floor is whole.
    for (const hole of work.holes) {
      throwIfAborted(ctx.signal);
      const block = hutBlock(bot);
      if (!block) break;
      await placeItemAt(ctx, block, hole).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
        ctx.logger.debug({ module: 'skill', cell: hole.toString(), err: errMsg(err) }, 'hole not filled');
      });
    }
    const plan = hutPlan(room);
    const firstRoof = plan.findIndex((c) => c.y === wallsOf(room));
    const middle = corner.plus(hutRoom(room));
    let placed = 0;
    for (const [i, cell] of plan.entries()) {
      throwIfAborted(ctx.signal);
      const target = corner.plus(cell);
      if (isSolid(bot.blockAt(target))) continue;
      // The roof goes on from inside, standing in the middle.
      if (i === firstRoof) await gotoNear(ctx, middle, 0.8, 20_000).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
      const block = hutBlock(bot);
      if (!block) break;
      try {
        await placeItemAt(ctx, block, target);
        placed++;
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        ctx.logger.debug({ module: 'skill', cell: target.toString(), err: errMsg(err) }, 'hut block not placed');
      }
      if (placed % 8 === 0) ctx.progress(`hut: ${placed}/${plan.length}`);
    }
    // A second go at what didn't take the first time (out of reach, or nothing yet to set it against), from close by.
    for (const cell of plan) {
      throwIfAborted(ctx.signal);
      const target = corner.plus(cell);
      if (isSolid(bot.blockAt(target))) continue;
      const block = hutBlock(bot);
      if (!block) break;
      await gotoNear(ctx, target, 3, 10_000).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
      try {
        await placeItemAt(ctx, block, target);
        placed++;
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        ctx.logger.debug({ module: 'skill', cell: target.toString(), err: errMsg(err) }, 'hut block not placed, second try');
      }
    }
    // Out through the doorway, and the door in it if we have one.
    const doorway = corner.plus(hutDoor(room));
    // Out to stand off the doorway: near it, on whatever ground is there (a spot exactly two out, on a slope, was
    // nowhere to stand, and the walk left the builder in the doorway).
    await gotoNear(ctx, doorway.offset(0, 0, -2), 1.5, 20_000).catch((err: unknown) => {
      if (err instanceof SkillAbortedError) throw err;
    });
    const door = bot.inventory.items().find((i) => DOORS.test(i.name));
    if (door && free(bot, doorway)) {
      try {
        await placeItemAt(ctx, door.name, doorway);
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        ctx.logger.debug({ module: 'skill', err: errMsg(err) }, 'door not placed');
      }
    }
    const missing = plan.filter((c) => !isSolid(bot.blockAt(corner.plus(c)))).length;
    const hasDoor = DOORS.test(bot.blockAt(doorway)?.name ?? '');
    if (missing > 4) return { ok: false, observed: `placed ${placed} blocks; ${missing} missing`, error: 'the hut is not finished', data: { corner: at, placed } };
    // Where it is as one would go to it: the room inside, and the doorway, shut or open. Told only its corner, an
    // agent walked to that (through the wall) and took itself for inside; another took an open doorway for shut.
    const way = `${doorway.x},${doorway.y},${doorway.z}`;
    const shut = hasDoor ? `a door in its doorway at ${way}` : `its doorway at ${way} open (no door: a door, or a block from inside, shuts it)`;
    return { ok: true, observed: `built a hut, its room inside at ${middle.x},${middle.y},${middle.z}, ${shut}; you are outside it`, data: { corner: at, room: { x: middle.x, y: middle.y, z: middle.z }, placed, door: hasDoor } };
  },
});

// --- the notice board -------------------------------------------------------------------------------------------

/** Signs standing within `radius` of `center` (the board is where they are). */
export function signsNear(bot: Bot, center: Vec3, radius: number): Block[] {
  const ids = bot.registry.blocksArray.filter((b) => isSignBlock(b.name)).map((b) => b.id);
  return bot
    .findBlocks({ matching: ids, maxDistance: radius + 8, count: 32, point: center })
    .map((p) => bot.blockAt(p))
    .filter((b): b is Block => b !== null && b.position.distanceTo(center) <= radius);
}

/** A free ground cell next to the board (or near home when there is none yet) for one more sign. */
function boardSpot(bot: Bot, home: Vec3): Vec3 | null {
  const board = signsNear(bot, home, BOARD_RADIUS).sort((a, b) => a.position.distanceTo(home) - b.position.distanceTo(home));
  const around = board.length > 0 ? board.map((b) => b.position) : [home.floored().offset(2, 0, 2)];
  for (const c of around) {
    for (let r = board.length > 0 ? 1 : 0; r <= 3; r++) {
      for (const [dx, dz] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]] as const) {
        for (const dy of [0, 1, -1]) {
          const p = c.offset(dx, dy, dz);
          if (free(bot, p) && free(bot, p.offset(0, 1, 0)) && isSolid(bot.blockAt(p.offset(0, -1, 0)))) return p;
        }
      }
    }
  }
  return null;
}

const normalize = (t: string) => t.replace(/…/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export const sign = defineSkill({
  name: 'sign',
  description: 'sign {text} — post a notice on a sign at the village board by home (up to ~60 characters; carry a sign: 6 planks + 1 stick make 3)',
  argsSchema: z.object({ text: z.string().min(2).transform((t) => t.slice(0, 60)) }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'inventoryLoss', item: 'sign', atLeast: 1 }),
  async run(ctx, args) {
    const { bot } = ctx;
    const item = bot.inventory.items().find((i) => isSignBlock(i.name));
    if (!item) return { ok: false, observed: 'no sign to post on', error: 'no sign in inventory; make one first (oak_sign: 6 planks and a stick)' };
    const home = ctx.home ?? bot.entity.position;
    const spot = boardSpot(bot, new Vec3(home.x, home.y, home.z));
    if (!spot) return { ok: false, observed: 'no room by the board', error: 'no free spot at the board' };
    const lines = wrapForSign(args.text);
    // Setting a sign down opens its editor (the server's open_sign_entity); then the text can go on.
    const events = bot as unknown as { on(ev: 'signOpen', f: (b: Block) => void): void; off(ev: 'signOpen', f: (b: Block) => void): void };
    const opened = new Promise<Block | null>((resolve) => {
      const t = setTimeout(() => {
        events.off('signOpen', onOpen);
        resolve(null);
      }, 3000);
      const onOpen = (b: Block) => {
        clearTimeout(t);
        events.off('signOpen', onOpen);
        resolve(b);
      };
      events.on('signOpen', onOpen);
    });
    try {
      await placeItemAt(ctx, item.name, spot);
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `could not set the sign down at ${spot.toString()}`, error: errMsg(err) };
    }
    await opened;
    const block = bot.blockAt(spot);
    if (!block || !isSignBlock(block.name)) return { ok: false, observed: 'the sign did not stay', error: 'sign not placed' };
    bot.updateSign(block, lines.join('\n'));
    // Read it back as anyone passing by would.
    const want = normalize(lines.join(' '));
    for (let i = 0; i < 12; i++) {
      await waitMs(ctx, 250);
      const text = readSign(bot.blockAt(spot));
      if (text && normalize(text) === want) {
        return { ok: true, observed: `posted "${lines.join(' ')}" at the board (${spot.x},${spot.y},${spot.z})`, data: { pos: { x: spot.x, y: spot.y, z: spot.z }, text: lines.join(' ') } };
      }
    }
    const got = readSign(bot.blockAt(spot));
    return { ok: false, observed: `the sign reads "${got ?? ''}"`, error: 'the writing did not take', data: { pos: { x: spot.x, y: spot.y, z: spot.z } } };
  },
});

// --- patrol ----------------------------------------------------------------------------------------------------------

export const patrol = defineSkill({
  name: 'patrol',
  description: 'patrol {radius?} — walk a round of the village edge and fight off hostile mobs that come near',
  argsSchema: z.object({ radius: z.coerce.number().min(4).max(32).default(10) }),
  talkOverable: true,
  slipKinds: ['tool'],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const home = ctx.home ?? bot.entity.position;
    const start = ctx.rng.next() * Math.PI * 2;
    let kills = 0;
    let reached = 0;
    for (let i = 0; i < 4; i++) {
      throwIfAborted(ctx.signal);
      const mob = bot.nearestEntity((e) => isHostile(e) && e.position.distanceTo(bot.entity.position) <= 14 && e.position.distanceTo(new Vec3(home.x, home.y, home.z)) <= args.radius + 12 && canSee(bot, e, 15));
      if (mob) {
        if (ctx.slip !== 'tool') await equipBestWeapon(bot);
        const p = pvp(bot);
        p.attack(mob);
        const until = Date.now() + 25_000;
        try {
          await abortable(
            ctx.signal,
            (async () => {
              while (bot.entities[mob.id] && Date.now() < until) await waitMs(ctx, 250);
            })(),
            () => p.forceStop(),
          );
        } finally {
          p.forceStop();
        }
        if (!bot.entities[mob.id]) {
          kills++;
          ctx.progress(`patrol: drove off a ${mob.name ?? 'mob'}`);
        }
        continue;
      }
      const a = start + (i * Math.PI) / 2;
      const to = new Vec3(Math.round(home.x + Math.cos(a) * args.radius), Math.round(home.y), Math.round(home.z + Math.sin(a) * args.radius));
      try {
        bot.pathfinder.setMovements(ctx.movements());
        await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(to.x, to.z, 2)), 30_000), () => stopMotion(bot));
        reached++;
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        stopMotion(bot);
      }
    }
    if (reached + kills === 0) return { ok: false, observed: 'could not get round the village', error: 'patrol route blocked' };
    return { ok: true, observed: kills > 0 ? `walked the village edge; fought off ${kills} mob(s)` : `walked the village edge (${reached} of 4 points); all quiet`, data: { kills, reached } };
  },
});
