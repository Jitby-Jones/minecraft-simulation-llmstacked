// prospect: look for ore the way a player does when none is in sight (§13 rule 4: gather and mine only target ore the
// bot has seen). It digs a staircase down into the stone toward the depth where that ore is common, then a straight
// 1×2 tunnel, looking at the walls as it goes, and stops as soon as the ore comes into sight. Water or lava ahead is
// walled off with a block, as a player does (a few to a step); more than that makes it turn; bedrock or a gap it can't
// bridge ends the tunnel.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { itemMatcher } from '../items';
import { findKnownBlocks } from '../sightings';
import { blockIdsDropping, isAirLike, isSolid } from '../world';
import { holdsDripstone, mine } from './gathering';
import { lightTheWay } from './light';
import { abortable, digBlock, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

/** Feet height where each ore is common in today's overworld generation. */
const ORE_DEPTH: readonly [RegExp, number][] = [
  [/coal/, 40],
  [/copper/, 40],
  [/iron/, 14],
  [/lapis/, 0],
  [/gold/, -16],
  [/redstone/, -56],
  [/diamond/, -56],
  [/emerald/, 60],
];
const DIRS: Readonly<Record<string, Vec3>> = {
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
  south: new Vec3(0, 0, 1),
  north: new Vec3(0, 0, -1),
};
const FACES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const BRIDGE_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff'];

class Blocked extends Error {}

/** Rock that ore forms in; tunneling through dirt finds nothing. */
const HOST_ROCK = new Set(['stone', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'netherrack', 'blackstone', 'basalt']);

/**
 * The direction with the most host rock ahead at tunnel depth (the ground itself is common knowledge, §13 rule 4;
 * ore is not). Null when there is none anywhere, so the caller picks at random.
 */
function rockiestDirection(bot: Bot, targetY: number, roll: number): string | null {
  const start = bot.entity.position.floored();
  const scores = Object.entries(DIRS).map(([name, d]) => {
    let n = 0;
    for (let k = 1; k <= 12; k++) {
      for (const dy of [0, 1]) {
        const b = bot.blockAt(new Vec3(start.x + d.x * k, targetY + dy, start.z + d.z * k));
        if (b && HOST_ROCK.has(b.name)) n++;
      }
    }
    return { name, n };
  });
  const best = Math.max(...scores.map((x) => x.n));
  if (best === 0) return null;
  const top = scores.filter((x) => x.n === best);
  return top[Math.floor(roll * top.length)]?.name ?? null;
}

function oreIds(bot: Bot, item: string): number[] {
  return blockIdsDropping(bot, itemMatcher(item)).filter((id) => /_ore$|^ancient_debris$/.test(bot.registry.blocks[id]?.name ?? ''));
}

/** How many blocks of water or lava one dig may be walled off with before the way is given up as too wet. */
const PLUGS_PER_DIG = 4;

/**
 * A block put into a cell of water or lava, against `ref` (a solid block beside it), as a player walls one off to dig
 * on: a prospect in a wet cave gave up nine times on "water ahead". True if it went in.
 */
async function plug(ctx: SkillContext, ref: Vec3, face: Vec3): Promise<boolean> {
  const { bot } = ctx;
  const item = bot.inventory.items().find((i) => BRIDGE_BLOCKS.includes(i.name));
  const against = bot.blockAt(ref);
  if (!item || !against || !isSolid(against)) return false;
  try {
    await bot.equip(item, 'hand');
    await bot.placeBlock(against, face);
  } catch (err) {
    ctx.logger.debug({ module: 'skill', at: ref.plus(face).toString(), err: errMsg(err) }, 'could not wall off the liquid');
    return false;
  }
  return isSolid(bot.blockAt(ref.plus(face)));
}

/** Clears one block (and whatever gravel or sand falls into it). Returns what was there first (null: nothing). */
async function clear(ctx: SkillContext, p: Vec3): Promise<string | null> {
  const { bot } = ctx;
  let first: string | null = null;
  let plugs = 0;
  for (let i = 0; i < 6 + PLUGS_PER_DIG; i++) {
    throwIfAborted(ctx.signal);
    const b = bot.blockAt(p);
    if (!b) throw new Blocked('the ground ahead is not loaded');
    if (b.name === 'water' || b.name === 'lava') {
      // The cell itself: filled from the floor under it, then dug like any other.
      if (plugs++ >= PLUGS_PER_DIG || !(await plug(ctx, p.offset(0, -1, 0), new Vec3(0, 1, 0)))) throw new Blocked(`${b.name} ahead`);
      continue;
    }
    if (isAirLike(b)) return first;
    first ??= b.name;
    if (b.name === 'bedrock' || b.hardness === null || b.hardness < 0) throw new Blocked(`${b.name} ahead`);
    // Water or lava beside it would pour in once it's dug: walled off first, each from the block itself.
    const wet = FACES.find((f) => /^(water|lava)$/.test(bot.blockAt(p.plus(f))?.name ?? ''));
    if (wet) {
      const liquid = bot.blockAt(p.plus(wet))?.name ?? 'water';
      if (plugs++ >= PLUGS_PER_DIG || !(await plug(ctx, p, wet))) throw new Blocked(`${liquid} ahead`);
      continue;
    }
    if (holdsDripstone(bot, p)) throw new Blocked('a stalactite hangs from the rock ahead');
    const tool = bot.pathfinder.bestHarvestTool(b);
    if (tool) await bot.equip(tool, 'hand');
    await digBlock(ctx, b);
    await waitMs(ctx, 150);
  }
  throw new Blocked('gravel keeps falling');
}

/**
 * The ore one went looking for, found: mined there and then, the whole vein in sight (up to 8), as a player does;
 * what came of it, in words to add (empty if nothing).
 */
async function mineTheVein(ctx: SkillContext, name: string, ids: number[]): Promise<string> {
  const vein = findKnownBlocks(ctx.bot, ids, 8, 8).length;
  if (vein === 0) return '';
  try {
    const r = await mine.run(ctx, { block: name, qty: vein, maxDistance: 12 });
    return `; ${r.observed}`;
  } catch (err) {
    if (err instanceof SkillAbortedError) throw err;
    return `; could not mine it: ${errMsg(err)}`;
  }
}

/** Walks onto the cleared step (the cheapest path there is the one we just dug). */
async function stepTo(ctx: SkillContext, p: Vec3): Promise<void> {
  const { bot } = ctx;
  bot.pathfinder.setMovements(ctx.movements());
  await abortable(ctx.signal, bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z)), () => stopMotion(bot));
}

async function bridge(ctx: SkillContext, p: Vec3): Promise<void> {
  const { bot } = ctx;
  if (isSolid(bot.blockAt(p))) return;
  const item = bot.inventory.items().find((i) => BRIDGE_BLOCKS.includes(i.name));
  if (!item) throw new Blocked('a gap ahead and nothing to fill it with');
  const below = bot.blockAt(p.offset(0, -1, 0));
  const side = FACES.map((f) => bot.blockAt(p.plus(f))).find((n) => n && isSolid(n) && !n.position.equals(p.offset(0, 1, 0)));
  const ref = isSolid(below) ? below : side;
  if (!ref) throw new Blocked('a gap ahead with nothing to build on');
  await bot.equip(item, 'hand');
  await bot.placeBlock(ref, p.minus(ref.position));
}

export const prospect = defineSkill({
  name: 'prospect',
  description: 'prospect {item, maxBlocks?, direction?, outside?} — dig down and tunnel to look for an ore you have not seen yet (needs a pickaxe); outside: start at least this many blocks from home',
  argsSchema: z.object({
    item: z.string().min(1),
    maxBlocks: z.coerce.number().min(4).max(96).default(48),
    direction: z.enum(['north', 'south', 'east', 'west']).optional(),
    /** Start the mine at least this far from home (a tunnel under a village lets mobs in among the people there). */
    outside: z.coerce.number().min(0).max(64).optional(),
  }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const ids = oreIds(bot, args.item);
    if (ids.length === 0) return { ok: false, observed: 'nothing to look for', error: `${args.item} doesn't come from ore` };
    const seen = () => findKnownBlocks(bot, ids, 16, 1)[0];
    const already = seen();
    if (already) return { ok: true, observed: `already know of ${already.name} at ${already.position.toString()}` };
    if (!bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) {
      return { ok: false, observed: 'no pickaxe', error: 'need a pickaxe to dig for ore' };
    }
    if (args.outside && ctx.home && bot.entity.position.distanceTo(ctx.home) < args.outside) {
      const away = bot.entity.position.minus(ctx.home);
      const len = Math.hypot(away.x, away.z);
      const a = len > 1 ? Math.atan2(away.z, away.x) : ctx.rng.next() * Math.PI * 2;
      const to = new Vec3(ctx.home.x + Math.cos(a) * (args.outside + 4), ctx.home.y, ctx.home.z + Math.sin(a) * (args.outside + 4));
      ctx.progress('walking out of the village to dig');
      await gotoNear(ctx, to, 3, 60_000).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
    }
    const oreName = bot.registry.blocks[ids[0] ?? -1]?.name ?? args.item;
    const depth = ORE_DEPTH.find(([re]) => re.test(oreName))?.[1] ?? 14;
    const minY = (bot.game as unknown as { minY?: number }).minY ?? -64;
    const startY = Math.floor(bot.entity.position.y);
    // Below the ore's usual depth already (or on a flat world): stay just under the surface, with a roof if the
    // ground is thick enough.
    const targetY = Math.max(minY + 2, Math.min(depth, startY - 3));
    const names = Object.keys(DIRS);
    let dirName = args.direction ?? rockiestDirection(bot, targetY, ctx.rng.next()) ?? names[Math.floor(ctx.rng.next() * names.length)] ?? 'east';
    let dug = 0;
    let turns = 0;
    let outOfRock = 0;
    let lastBlock = '';
    // Each way that was tried and what stopped it: "water ahead" alone, three times over, says nothing of where to go.
    const stopped: string[] = [];
    try {
      while (dug < args.maxBlocks) {
        throwIfAborted(ctx.signal);
        const d = DIRS[dirName] ?? new Vec3(1, 0, 0);
        const feet = bot.entity.position.floored();
        const down = feet.y > targetY;
        const next = down ? feet.plus(d).offset(0, -1, 0) : feet.plus(d);
        let dugHere: (string | null)[] = [];
        try {
          // A staircase step needs the head room at our current height too.
          if (down) await clear(ctx, feet.plus(d).offset(0, 1, 0));
          dugHere = [await clear(ctx, next.offset(0, 1, 0)), await clear(ctx, next)];
          await bridge(ctx, next.offset(0, -1, 0));
        } catch (err) {
          if (err instanceof Blocked) stopped.push(`${err.message} ${dirName}`);
          if (!(err instanceof Blocked) || turns >= 2) throw err;
          lastBlock = err.message;
          turns++;
          dirName = names[(names.indexOf(dirName) + 1 + Math.floor(ctx.rng.next() * 3)) % names.length] ?? 'east';
          continue;
        }
        const found = seen();
        if (found) return { ok: true, observed: `found ${found.name} at ${found.position.toString()} after digging ${dug} blocks${await mineTheVein(ctx, found.name, ids)}` };
        await stepTo(ctx, next);
        dug++;
        await lightTheWay(ctx);
        // Out of the rock for a while (digging dirt or sand): head back toward rock if there is any around.
        outOfRock = dugHere.some((n) => n !== null && HOST_ROCK.has(n)) ? 0 : outOfRock + 1;
        if (!down && outOfRock >= 6 && turns < 2) {
          const back = rockiestDirection(bot, next.y, ctx.rng.next());
          if (back && back !== dirName) {
            dirName = back;
            turns++;
            outOfRock = 0;
          }
        }
        ctx.progress(`tunneling ${dirName}, ${dug} blocks`);
        const after = seen();
        if (after) return { ok: true, observed: `found ${after.name} at ${after.position.toString()} after digging ${dug} blocks${await mineTheVein(ctx, after.name, ids)}` };
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      const where = err instanceof Blocked && stopped.length > 1 ? `${stopped.join(', ')}, from ${bot.entity.position.floored().toString()}` : errMsg(err);
      return { ok: false, observed: `dug ${dug} blocks, no ${oreName} seen`, error: where };
    }
    return {
      ok: false,
      observed: `dug ${dug} blocks${lastBlock ? ` (${lastBlock})` : ''}, no ${oreName} seen`,
      error: `no ${oreName} found in ${dug} blocks of tunnel`,
    };
  },
});
