// Village skills (§6.8): hunt, build a hut, post on the notice board, walk a patrol. Schematic code, not
// LLM-placed blocks (§12); everything they find out, the agent found out with its own eyes.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { isSignBlock, readSign, wrapForSign } from '../signs';
import { canSee, isAirLike, isHostile, isSolid } from '../world';
import { BOARD_RADIUS } from '../../perception/village';
import { placeItemAt } from './building';
import { equipBestWeapon, pvp } from './combat';
import { stopCollecting } from './gathering';
import { abortable, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

// --- hunt ---------------------------------------------------------------------------------------------------------

export const ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'] as const;
const MEAT = /^(beef|porkchop|mutton|chicken|rabbit)$/;

function nearestAnimal(bot: Bot, kinds: readonly string[], radius: number): Entity | null {
  return bot.nearestEntity((e) => e !== bot.entity && kinds.includes(e.name ?? '') && e.position.distanceTo(bot.entity.position) <= radius && canSee(bot, e, radius + 1));
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
    await stopCollecting(bot);
    try {
      while (meat() - start < args.qty && Date.now() < deadline && kills < args.qty + 2) {
        throwIfAborted(ctx.signal);
        const prey = nearestAnimal(bot, kinds, 24);
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
    if (got <= 0) return { ok: false, observed: kills > 0 ? 'killed but picked nothing up' : 'no animals in sight', error: kills > 0 ? 'lost the meat' : 'no animals to hunt nearby', data: { kills } };
    return { ok: got >= Math.min(args.qty, 1), observed: `hunted ${kills} animal(s), +${got} raw meat`, data: { kills, meat: got } };
  },
});

// --- build a hut ----------------------------------------------------------------------------------------------------

/** Blocks a hut can be made of, best first. */
export const HUT_MATERIALS = ['cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks', 'stone_bricks', 'dirt'] as const;
const DOORS = /_door$/;

/** A 5×5 hut: walls three high with a doorway in the middle of one side, then a flat roof, rim first. */
export function hutPlan(): Vec3[] {
  const walls: Vec3[] = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 5; x++) {
      for (let z = 0; z < 5; z++) {
        const edge = x === 0 || x === 4 || z === 0 || z === 4;
        const door = x === 2 && z === 0 && y < 2;
        if (edge && !door) walls.push(new Vec3(x, y, z));
      }
    }
  }
  const roof: Vec3[] = [];
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) roof.push(new Vec3(x, 3, z));
  // The rim rests on the walls; then inward, so every block has a neighbor to go against.
  roof.sort((a, b) => Math.max(Math.abs(b.x - 2), Math.abs(b.z - 2)) - Math.max(Math.abs(a.x - 2), Math.abs(a.z - 2)));
  return [...walls, ...roof];
}

/** Shallow holes a hut site may have under it, filled before the walls go up (dug-up ground by home, §6.8). */
export const HUT_HOLES = 4;
/** The blocks a hut takes, with enough over to fill the holes in its site. */
export const HUT_BLOCKS = hutPlan().length + HUT_HOLES;
/** Where the door goes in the plan (its lower half). */
export const HUT_DOOR = new Vec3(2, 0, 0);

const free = (bot: Bot, p: Vec3) => isAirLike(bot.blockAt(p));

/** Ground cells under a hut at corner `c` that are a hole one deep (to fill), or null when the site won't do. */
export function hutSiteHoles(bot: Bot, c: Vec3): Vec3[] | null {
  const holes: Vec3[] = [];
  for (let x = -1; x <= 5; x++) {
    for (let z = -1; z <= 5; z++) {
      const inside = x >= 0 && x <= 4 && z >= 0 && z <= 4;
      for (let y = 0; y < 4; y++) if (!free(bot, c.offset(x, y, z))) return null;
      if (!inside || isSolid(bot.blockAt(c.offset(x, -1, z)))) continue;
      // A hole one deep in solid ground is filled; anything deeper, or water, rules the site out.
      if (!free(bot, c.offset(x, -1, z)) || !isSolid(bot.blockAt(c.offset(x, -2, z))) || holes.length >= HUT_HOLES) return null;
      holes.push(c.offset(x, -1, z));
    }
  }
  return holes;
}

/**
 * The nearest corner near `center` with level, solid ground under 5×5 (a few shallow holes are filled), room for
 * 5×5×4 and a free cell all round; of those at the same distance, the one with the fewest holes.
 */
export function findHutSite(bot: Bot, center: Vec3, radius = 20, minDist = 4): Vec3 | null {
  const base = center.floored();
  for (let r = minDist; r <= radius; r++) {
    let best: { c: Vec3; holes: number } | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const c = base.offset(dx, dy, dz);
          const holes = hutSiteHoles(bot, c);
          if (holes && (!best || holes.length < best.holes)) best = { c, holes: holes.length };
          if (best?.holes === 0) return best.c;
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
    .filter((i) => (HUT_MATERIALS as readonly string[]).includes(i.name))
    .reduce((a, i) => a + i.count, 0);
}

export const build = defineSkill({
  name: 'build',
  description: `build {structure: hut} — build a small hut near home (walls, a doorway, a flat roof) from ${HUT_BLOCKS} blocks you carry (cobblestone, planks or dirt), and a door if you have one`,
  argsSchema: z.object({ structure: z.enum(['hut']).default('hut') }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx) {
    const { bot } = ctx;
    const have = buildingBlocks(bot);
    if (have < HUT_BLOCKS) return { ok: false, observed: `have ${have} building blocks`, error: `need ${HUT_BLOCKS - have} more building blocks (cobblestone, planks or dirt)` };
    const center = ctx.home ?? bot.entity.position;
    const corner = findHutSite(bot, new Vec3(center.x, center.y, center.z));
    if (!corner) return { ok: false, observed: 'no room', error: 'no level spot for a hut near home' };
    const at = { x: corner.x, y: corner.y, z: corner.z };
    // The holes in the ground first, so the floor is whole.
    for (const hole of hutSiteHoles(bot, corner) ?? []) {
      throwIfAborted(ctx.signal);
      const block = HUT_MATERIALS.find((m) => bot.inventory.items().some((it) => it.name === m));
      if (!block) break;
      await placeItemAt(ctx, block, hole).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
        ctx.logger.debug({ module: 'skill', cell: hole.toString(), err: errMsg(err) }, 'hole not filled');
      });
    }
    const plan = hutPlan();
    const firstRoof = plan.findIndex((c) => c.y === 3);
    let placed = 0;
    for (const [i, cell] of plan.entries()) {
      throwIfAborted(ctx.signal);
      const target = corner.plus(cell);
      if (isSolid(bot.blockAt(target))) continue;
      // The roof goes on from inside, standing in the middle.
      if (i === firstRoof) await gotoNear(ctx, corner.offset(2, 0, 2), 0.8, 20_000).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
      const block = HUT_MATERIALS.find((m) => bot.inventory.items().some((it) => it.name === m));
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
      const block = HUT_MATERIALS.find((m) => bot.inventory.items().some((it) => it.name === m));
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
    const doorway = corner.plus(HUT_DOOR);
    await gotoNear(ctx, doorway.offset(0, 0, -2), 0.8, 20_000).catch((err: unknown) => {
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
    return { ok: true, observed: `built a hut at ${at.x},${at.y},${at.z}${hasDoor ? ' with a door' : ''}`, data: { corner: at, placed, door: hasDoor } };
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
  argsSchema: z.object({ text: z.string().min(2).max(60) }),
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
