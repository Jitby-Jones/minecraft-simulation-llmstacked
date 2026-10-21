// Gathering skills: gather (dig blocks that drop an item), mine (dig a block type), pickup (floor items).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { countItem } from '../inventory';
import { itemMatcher, type ItemMatcher } from '../items';
import { blockIdsDropping, blockIdsNamed, findNearestBlocks } from '../world';
import { abortable, errMsg, goals, stopMotion, throwIfAborted } from './util';
import { defineSkill, type SkillContext, type SkillResult, SkillAbortedError } from './types';

interface CollectBlockApi {
  collect(target: Block | Block[], options?: { ignoreNoPath?: boolean; append?: boolean }): Promise<void>;
  cancelTask(): Promise<void>;
}

function collector(bot: Bot): CollectBlockApi {
  return (bot as unknown as { collectBlock: CollectBlockApi }).collectBlock;
}

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

/** The cheapest common tool that harvests the block, e.g. stone_pickaxe for iron_ore. */
function toolNameFor(bot: Bot, block: Block): string {
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
  while (countItem(bot, matcher) - start < qty) {
    throwIfAborted(ctx.signal);
    // Prefer blocks within reach of the ground we stand on: low logs before the canopy, near before far.
    const feetY = bot.entity.position.y;
    const candidates = findNearestBlocks(bot, blockIds, maxDistance, 24)
      .filter((b) => !skipped.has(b.position.toString()))
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) + Math.max(0, a.position.y - feetY - 2) * 4 -
          (b.position.distanceTo(bot.entity.position) + Math.max(0, b.position.y - feetY - 2) * 4),
      );
    if (candidates.length === 0) {
      const got = countItem(bot, matcher) - start;
      return {
        ok: false,
        observed: `got ${got}/${qty} ${matcher.label}`,
        error: lastError || `no ${label} within ${maxDistance} blocks`,
      };
    }
    const harvestable = candidates.filter((b) => !lacksHarvestTool(bot, b));
    if (harvestable.length === 0) {
      const first = candidates[0];
      return {
        ok: false,
        observed: `got ${countItem(bot, matcher) - start}/${qty} ${matcher.label}`,
        error: first ? `need a ${toolNameFor(bot, first)} or better to harvest ${first.name}` : 'need a tool',
      };
    }
    const remaining = qty - (countItem(bot, matcher) - start);
    const batch = harvestable.slice(0, Math.max(1, Math.min(remaining, 4)));
    ctx.progress(`digging ${batch.length} ${batch[0]?.name ?? label}`);
    bot.pathfinder.setMovements(ctx.movements());
    try {
      await abortable(ctx.signal, collector(bot).collect(batch, { ignoreNoPath: true }), () => {
        void collector(bot).cancelTask();
        stopMotion(bot);
      });
      failures = 0;
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
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
    return collectUntil(ctx, matcher, ids, args.qty, args.maxDistance, matcher.label);
  },
});

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
    const ids = blockIdsNamed(ctx.bot, args.block);
    if (ids.length === 0) return { ok: false, observed: 'nothing to mine', error: `unknown block ${args.block}` };
    const block = ctx.bot.registry.blocks[ids[0] as number];
    const dropId = (block as unknown as { drops?: number[] } | undefined)?.drops?.[0];
    const dropName = typeof dropId === 'number' ? ctx.bot.registry.items[dropId]?.name : undefined;
    const matcher = itemMatcher(dropName ?? args.block);
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
        await abortable(ctx.signal, bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), () =>
          stopMotion(bot),
        );
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
      }
      await new Promise((r) => setTimeout(r, 400));
      if (bot.inventory.items().reduce((a, it) => a + it.count, 0) > before) picked++;
      else break;
    }
    return picked > 0 ? { ok: true, observed: `picked up ${picked} stack(s)` } : { ok: !matcher, observed: 'nothing picked up' };
  },
});
