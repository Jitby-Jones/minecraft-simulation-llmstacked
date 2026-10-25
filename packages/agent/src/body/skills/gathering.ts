// Gathering skills: gather (dig blocks that drop an item), mine (dig a block type), pickup (floor items).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { countItem } from '../inventory';
import { itemMatcher, type ItemMatcher } from '../items';
import { findKnownBlocks, isInferable } from '../sightings';
import { blockIdsDropping, blockIdsNamed, canSee, goingFor, underTheGround } from '../world';
import { type ToolKind, ensureTool, makeTool } from './tools';
import { lightTheWay } from './light';
import { abortable, digBlock, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';
import { defineSkill, type SkillContext, type SkillResult, SkillAbortedError } from './types';

interface CollectBlockApi {
  collect(target: Block | Block[], options?: { ignoreNoPath?: boolean; append?: boolean }): Promise<void>;
  cancelTask(): Promise<void>;
}

function collector(bot: Bot): CollectBlockApi {
  return (bot as unknown as { collectBlock: CollectBlockApi }).collectBlock;
}

/** Stops the collect plugin's task, if any, and waits briefly for it: a fight must not share the pathfinder with
 *  a collect task left over from the work it interrupted. */
export async function stopCollecting(bot: Bot): Promise<void> {
  const c = (bot as unknown as { collectBlock?: CollectBlockApi }).collectBlock;
  if (c) await withTimeout(c.cancelTask(), 2000).catch(() => undefined);
  stopMotion(bot);
}

/** A collect batch gets this long, plus a little per block: the collect plugin can stall on a path that keeps
 *  resetting, and then the batch counts as a failure. */
const BATCH_MS = 45_000;
const PER_BLOCK_MS = 10_000;

export function isFoodName(bot: Bot): (name: string) => boolean {
  return (name) => Boolean(bot.registry.foodsByName[name]);
}

/** True if the block needs a tool we don't have (it would drop nothing). */
export function lacksHarvestTool(bot: Bot, block: Block): boolean {
  const tools = (block as unknown as { harvestTools?: Record<string, boolean> }).harvestTools;
  if (!tools) return false;
  return !bot.inventory.items().some((i) => tools[String(i.type)]);
}

const COMMON_TOOL_MATERIALS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];

const LAVA_AROUND = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** A stalactite (pointed dripstone) hangs from this block: break it and the stalactite falls. */
export function holdsDripstone(bot: Bot, p: Vec3): boolean {
  return bot.blockAt(p.offset(0, -1, 0))?.name === 'pointed_dripstone';
}

/** Lava touching this block on any side. */
export function lavaBeside(bot: Bot, p: Vec3): boolean {
  for (const [dx, dy, dz] of LAVA_AROUND) if (bot.blockAt(p.offset(dx, dy, dz))?.name === 'lava') return true;
  return false;
}

/** Under water, or with water beside it: got at by swimming down to it, the head under. */
function wet(bot: Bot, p: Vec3): boolean {
  for (const [dx, dy, dz] of LAVA_AROUND) if (bot.blockAt(p.offset(dx, dy, dz))?.name === 'water') return true;
  return false;
}
/** A wet block counts as this many blocks farther off: a player mines dry stone before diving for it (one, after
 * stone under a pond, was pulled out of the water by its own swim reflex ten times running). */
const WET_COST = 16;

/** The cheapest common tool that harvests the block, e.g. stone_pickaxe for iron_ore. */
export function toolNameFor(bot: Bot, block: Block): string {
  const tools = (block as unknown as { harvestTools?: Record<string, boolean> }).harvestTools ?? {};
  const names = Object.keys(tools)
    .map((id) => bot.registry.items[Number(id)]?.name)
    .filter((n): n is string => Boolean(n));
  for (const mat of COMMON_TOOL_MATERIALS) {
    const n = names.find((x) => x.startsWith(`${mat}_`));
    if (n) return n;
  }
  return names[0] ?? 'better tool';
}

async function breakAndCollect(ctx: SkillContext, b: Block, matcher: ItemMatcher): Promise<void> {
  const { bot } = ctx;
  await gotoNear(ctx, b.position, 1.5, 20_000);
  const fresh = bot.blockAt(b.position);
  if (fresh?.name !== b.name) return;
  await digBlock(ctx, fresh);
  for (let i = 0; i < 10; i++) {
    const drop = bot.nearestEntity((e) => {
      if (e.name !== 'item' || e.position.distanceTo(b.position.offset(0.5, 0, 0.5)) > 2.5) return false;
      const it = (e as unknown as { getDroppedItem(): { name: string } | null }).getDroppedItem();
      return Boolean(it && matcher.matches(it.name));
    });
    if (drop) {
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), 10_000), () => stopMotion(bot));
      await waitMs(ctx, 300);
      return;
    }
    await waitMs(ctx, 100);
  }
}

/**
 * Walks over drops of the item lying near where we just dug. The collect plugin only goes after a drop that lands
 * within half a block of the block's center; one that rolls farther stays on the ground, in plain sight.
 */
async function pickUpDropsNear(ctx: SkillContext, dug: readonly Vec3[], matcher: ItemMatcher): Promise<number> {
  const { bot } = ctx;
  let walked = 0;
  for (let i = 0; i < 3; i++) {
    throwIfAborted(ctx.signal);
    const drop = bot.nearestEntity((e) => {
      if (e.name !== 'item' || !dug.some((p) => e.position.distanceTo(p.offset(0.5, 0.5, 0.5)) <= 3)) return false;
      const it = (e as unknown as { getDroppedItem(): { name: string } | null }).getDroppedItem();
      return Boolean(it && matcher.matches(it.name)) && canSee(bot, e, 8);
    });
    if (!drop) break;
    bot.pathfinder.setMovements(ctx.movements());
    try {
      // Within a block is close enough to pick it up, and reachable when it lies in a pocket we can't stand in.
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)), 6000), () => stopMotion(bot));
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      stopMotion(bot);
      break;
    }
    await waitMs(ctx, 300);
    walked++;
  }
  return walked;
}

/** Ground dug for its blocks (dirt and the like). */
const GROUND = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|sand|red_sand|gravel|clay|mud)$/;
/** Ground this close to home is left whole: it is where huts go (§6.8). Dirt for them is dug farther out. */
export const HOME_GROUND = 16;

/** The blocks among `near` that are not in the ground kept whole round home. */
export function awayFromHome<T extends { position: { x: number; z: number } }>(near: readonly T[], home: { x: number; z: number }): T[] {
  return near.filter((b) => Math.hypot(b.position.x - home.x, b.position.z - home.z) > HOME_GROUND);
}

/** Out past the ground kept whole round home, on the side we are on. */
async function walkOutFrom(ctx: SkillContext, home: Vec3): Promise<void> {
  const here = ctx.bot.entity.position;
  const a = Math.hypot(here.x - home.x, here.z - home.z) > 1 ? Math.atan2(here.z - home.z, here.x - home.x) : ctx.rng.next() * Math.PI * 2;
  const to = new Vec3(home.x + Math.cos(a) * (HOME_GROUND + 6), here.y, home.z + Math.sin(a) * (HOME_GROUND + 6));
  ctx.progress('heading out of the village to dig');
  await gotoNear(ctx, to, 3, 30_000).catch((err: unknown) => {
    if (err instanceof SkillAbortedError) throw err;
  });
}

/**
 * What was looked for and not seen: the block that drops it, by name, where that isn't the thing itself ("haven't
 * seen any iron_ore around here; raw_iron comes from mining it"). Told only "any raw_iron", a model asked for the
 * drop five times over at the spot where the one block of ore it had found was gone.
 */
/** What grows only under the sky (trees, grass, flowers, crops): looked for underground, where it is said to be. */
const GROWS = /(_log|_stem|_leaves|^short_grass|^tall_grass|^fern|_sapling|^dandelion|^poppy|_tulip|^sugar_cane|^pumpkin|^melon|^wheat|^carrots|^potatoes|^beetroots|^bamboo|^cactus|^sweet_berry_bush)$/;

function grownUp(bot: Bot, blockIds: readonly number[]): string {
  if (!blockIds.some((id) => GROWS.test(bot.registry.blocks[id]?.name ?? ''))) return '';
  return underTheGround(bot, 'trees and plants grow up on the surface');
}

function unseenText(bot: Bot, blockIds: readonly number[], label: string): string {
  const names = blockIds.map((id) => bot.registry.blocks[id]?.name).filter((n): n is string => Boolean(n));
  const source = names.find((n) => !n.startsWith('deepslate_')) ?? names[0];
  if (!source || source === label) return `haven't seen any ${label} around here`;
  return `haven't seen any ${source} around here; ${label} comes from mining it`;
}

async function collectUntil(
  ctx: SkillContext,
  matcher: ItemMatcher,
  blockIds: number[],
  qty: number,
  maxDistance: number,
  label: string,
): Promise<SkillResult> {
  const { bot } = ctx;
  const start = countItem(bot, matcher);
  let failures = 0;
  let lastError = '';
  const skipped = new Set<string>();
  const home = ctx.home && blockIds.every((id) => GROUND.test(bot.registry.blocks[id]?.name ?? '')) ? ctx.home : null;
  let walkedOut = 0;
  let madeTool = false;
  // Every loop has a cap (§13): enough rounds for the job and a few failures, never more.
  const maxRounds = qty + 12;
  for (let round = 0; countItem(bot, matcher) - start < qty; round++) {
    throwIfAborted(ctx.signal);
    if (round >= maxRounds) {
      return { ok: false, observed: `got ${countItem(bot, matcher) - start}/${qty} ${matcher.label}`, error: lastError || `took too many tries to gather ${label}` };
    }
    // Prefer blocks within reach of the ground we stand on: low logs before the canopy, near before far.
    const feetY = bot.entity.position.y;
    // Never one with lava against it (broken, it lets the lava in) nor one a stalactite hangs from (it falls, and
    // kills): as anyone who has played knows. Prospecting keeps the same rules.
    const near = findKnownBlocks(bot, blockIds, maxDistance, 24).filter((b) => !skipped.has(b.position.toString()) && !lavaBeside(bot, b.position) && !holdsDripstone(bot, b.position));
    const outside = home ? awayFromHome(near, home) : near;
    if (home && outside.length === 0 && near.length > 0 && walkedOut < 3) {
      walkedOut++;
      await walkOutFrom(ctx, home);
      continue;
    }
    const cost = (b: Block) => b.position.distanceTo(bot.entity.position) + Math.max(0, b.position.y - feetY - 2) * 4 + (wet(bot, b.position) ? WET_COST : 0);
    const candidates = outside.sort((a, b) => cost(a) - cost(b));
    if (candidates.length === 0) {
      const got = countItem(bot, matcher) - start;
      return {
        ok: false,
        observed: `got ${got}/${qty} ${matcher.label}`,
        error:
          lastError ||
          (blockIds.some((id) => isInferable(bot.registry.blocks[id]?.name ?? ''))
            ? `no ${label} within ${maxDistance} blocks${grownUp(bot, blockIds)}`
            : unseenText(bot, blockIds, label)),
      };
    }
    const harvestable = candidates.filter((b) => !lacksHarvestTool(bot, b));
    if (harvestable.length === 0) {
      const first = candidates[0];
      // Stone and ore drop nothing without a pickaxe: make one, as a player would (tools.ts), once.
      if (first && !madeTool) {
        madeTool = true;
        if (await makeTool(ctx, toolNameFor(bot, first))) continue;
      }
      return {
        ok: false,
        observed: `got ${countItem(bot, matcher) - start}/${qty} ${matcher.label}`,
        error: first ? `need a ${toolNameFor(bot, first)} or better to harvest ${first.name}` : 'need a tool',
      };
    }
    const remaining = qty - (countItem(bot, matcher) - start);
    const batch = harvestable.slice(0, Math.max(1, Math.min(remaining, 4)));
    const far = batch[0] ? goingFor(bot, batch[0].position) : '';
    ctx.progress(`digging ${batch.length} ${batch[0]?.name ?? label}${far ? `, ${far}` : ''}`);
    bot.pathfinder.setMovements(ctx.movements());
    const had = countItem(bot, matcher);
    try {
      // Flowers, grass and crops have no collision box, which the collect plugin can't path to: walk over,
      // break it, and pick the drop up.
      if (batch.every((b) => b.boundingBox === 'empty')) {
        for (const b of batch) await breakAndCollect(ctx, b, matcher);
      } else {
        const task = withTimeout(collector(bot).collect(batch, { ignoreNoPath: true }), BATCH_MS + PER_BLOCK_MS * batch.length, `collecting ${label} took too long`);
        await abortable(ctx.signal, task, () => {
          void collector(bot).cancelTask();
          stopMotion(bot);
        });
        await lightTheWay(ctx);
      }
      // A drop that rolled off where the plugin looks for it: go and get it.
      if (countItem(bot, matcher) <= had) {
        const walked = await pickUpDropsNear(ctx, batch.map((b) => b.position), matcher);
        ctx.logger.debug(
          { module: 'skill', item: matcher.label, dug: batch.map((b) => `${b.position.toString()}:${bot.blockAt(b.position)?.name ?? '?'}`), walked, got: countItem(bot, matcher) - had },
          'collect batch brought nothing in',
        );
      }
      // Not dug at all: no way to it (seen through a gap, or up in a wall), said so; the way there is the mind's to
      // dig (an agent told "nothing came of digging iron_ore" twice, with the ore untouched in a cave wall).
      const untouched = batch.filter((b) => bot.blockAt(b.position)?.name === b.name);
      if (countItem(bot, matcher) <= had && untouched.length === batch.length) {
        const b = untouched[0];
        throw new Error(`could not get to the ${b?.name.replace(/_/g, ' ') ?? label}${b ? ` at ${b.position.x},${b.position.y},${b.position.z}` : ''}: no way there to stand and dig it from`);
      }
      // Dug, but nothing came of it (the drop wasn't picked up, or went to someone else): skip those blocks.
      if (countItem(bot, matcher) <= had) throw new Error(`nothing came of digging ${batch[0]?.name ?? label}`);
      failures = 0;
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      // The plugin may still be at it after a timeout.
      void collector(bot)
        .cancelTask()
        .catch(() => undefined);
      stopMotion(bot);
      lastError = errMsg(err);
      failures++;
      for (const b of batch) skipped.add(b.position.toString());
      if (failures >= 4) {
        return { ok: false, observed: `got ${countItem(bot, matcher) - start}/${qty} ${matcher.label}`, error: lastError };
      }
    }
  }
  const got = countItem(bot, matcher) - start;
  return { ok: true, observed: `+${got} ${matcher.label}` };
}

export const gather = defineSkill({
  name: 'gather',
  description: 'gather {item, qty} — dig blocks that drop the item (e.g. oak_log, cobblestone, coal, dirt) and pick them up',
  argsSchema: z.object({
    item: z.string().min(1),
    qty: z.coerce.number().int().min(1).max(256).default(1),
    maxDistance: z.coerce.number().min(4).max(96).default(48),
  }),
  talkOverable: true,
  slipKinds: ['path'],
  expect: (args, _before, bot) => ({ kind: 'inventoryGain', item: itemMatcher(args.item, isFoodName(bot)).label, atLeast: args.qty }),
  async run(ctx, args) {
    const matcher = itemMatcher(args.item, isFoodName(ctx.bot));
    const ids = blockIdsDropping(ctx.bot, matcher);
    if (ids.length === 0) return { ok: false, observed: 'nothing to dig', error: `no block drops ${matcher.label}` };
    // A lot of wood or earth goes quicker with an axe or a shovel: made first when it can be (not a must). An axe
    // made of the logs we are after is made up for: as many more are gathered.
    const speed = speedTool(ctx.bot.registry.blocks[ids[0] ?? -1]?.name ?? '');
    const before = countItem(ctx.bot, matcher);
    if (speed && args.qty >= SPEED_TOOL_FROM) {
      await ensureTool(ctx, speed).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
    }
    const used = Math.max(0, before - countItem(ctx.bot, matcher));
    return collectUntil(ctx, matcher, ids, args.qty + used, args.maxDistance, matcher.label);
  },
});

/** How much wood or earth to dig before an axe or a shovel is worth making. */
const SPEED_TOOL_FROM = 6;

/** The tool that digs this kind of block quicker, when hands will do but slowly. */
function speedTool(block: string): ToolKind | null {
  if (/_(log|stem|wood|hyphae)$/.test(block)) return 'axe';
  if (GROUND.test(block)) return 'shovel';
  return null;
}

export const mine = defineSkill({
  name: 'mine',
  description: 'mine {block, qty} — dig a specific block type (e.g. stone, iron_ore) and collect what drops',
  argsSchema: z.object({
    block: z.string().min(1),
    qty: z.coerce.number().int().min(1).max(256).default(1),
    maxDistance: z.coerce.number().min(4).max(96).default(48),
  }),
  talkOverable: true,
  slipKinds: ['path'],
  expect(args, _before, bot) {
    const ids = blockIdsNamed(bot, args.block);
    const block = ids[0] !== undefined ? bot.registry.blocks[ids[0]] : undefined;
    const dropId = (block as unknown as { drops?: number[] } | undefined)?.drops?.[0];
    const drop = typeof dropId === 'number' ? bot.registry.items[dropId]?.name : undefined;
    return drop ? { kind: 'inventoryGain', item: drop, atLeast: args.qty } : { kind: 'none' };
  },
  async run(ctx, args) {
    const named = blockIdsNamed(ctx.bot, args.block);
    if (named.length === 0) return { ok: false, observed: 'nothing to mine', error: `unknown block ${args.block}` };
    const block = ctx.bot.registry.blocks[named[0] as number];
    const dropId = (block as unknown as { drops?: number[] } | undefined)?.drops?.[0];
    const dropName = typeof dropId === 'number' ? ctx.bot.registry.items[dropId]?.name : undefined;
    const matcher = itemMatcher(dropName ?? args.block);
    // As a player means it: "mine cobblestone" is mining the stone it comes from, "mine dirt" takes grass too (an
    // agent was told it had seen no cobblestone, standing on stone).
    const ids = [...new Set([...named, ...blockIdsDropping(ctx.bot, matcher)])];
    return collectUntil(ctx, matcher, ids, args.qty, args.maxDistance, args.block);
  },
});

export const pickup = defineSkill({
  name: 'pickup',
  description: 'pickup {item?, radius?} — walk over dropped items nearby to collect them',
  argsSchema: z.object({ item: z.string().optional(), radius: z.coerce.number().min(1).max(24).default(8) }),
  talkOverable: true,
  slipKinds: [],
  expect: (args) => (args.item ? { kind: 'inventoryGain', item: itemMatcher(args.item).label, atLeast: 1 } : { kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const matcher = args.item ? itemMatcher(args.item) : null;
    let picked = 0;
    for (let i = 0; i < 12; i++) {
      throwIfAborted(ctx.signal);
      const drop = bot.nearestEntity((e) => {
        if (e.name !== 'item' || e.position.distanceTo(bot.entity.position) > args.radius) return false;
        if (!matcher) return true;
        const it = (e as unknown as { getDroppedItem(): { name: string } | null }).getDroppedItem();
        return Boolean(it && matcher.matches(it.name));
      });
      if (!drop) break;
      const before = bot.inventory.items().reduce((a, it) => a + it.count, 0);
      bot.pathfinder.setMovements(ctx.movements());
      try {
        await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), 10_000), () =>
          stopMotion(bot),
        );
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        stopMotion(bot);
      }
      await new Promise((r) => setTimeout(r, 400));
      if (bot.inventory.items().reduce((a, it) => a + it.count, 0) > before) picked++;
      else break;
    }
    return picked > 0 ? { ok: true, observed: `picked up ${picked} stack(s)` } : { ok: !matcher, observed: 'nothing picked up' };
  },
});
