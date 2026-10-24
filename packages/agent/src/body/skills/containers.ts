// Container skills: deposit, withdraw (chests and barrels). A chest is a thing in the world (owner request, 2026-10-24:
// agents spoke of putting things in a chest that wasn't there): one asked for at a place where there is none is said to
// be missing, and with none about, a deposit makes one (makeChest).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { countItem } from '../inventory';
import { armorSlotOf, isWeapon, itemMatcher } from '../items';
import { findKnownBlocks } from '../sightings';
import { runOther } from './tools';
import { errMsg, gotoNear, throwIfAborted } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

const CONTAINERS = ['chest', 'trapped_chest', 'barrel'];

const PosOpt = {
  x: z.coerce.number().optional(),
  y: z.coerce.number().optional(),
  z: z.coerce.number().optional(),
};

async function reachContainer(ctx: SkillContext, pos: { x?: number; y?: number; z?: number }): Promise<Block | null> {
  const { bot } = ctx;
  let block: Block | null;
  if (pos.x !== undefined && pos.y !== undefined && pos.z !== undefined) block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  else {
    const ids = CONTAINERS.map((n) => bot.registry.blocksByName[n]?.id).filter((v): v is number => v !== undefined);
    block = findKnownBlocks(bot, ids, 24, 1)[0] ?? null;
  }
  if (!block || !CONTAINERS.includes(block.name)) return null;
  if (block.position.distanceTo(bot.entity.position) > 3.5) await gotoNear(ctx, block.position, 2);
  return bot.blockAt(block.position);
}

/** What the open container holds (item → count), as seen when we looked inside. */
function contentsOf(container: { containerItems(): { name: string; count: number }[] }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of container.containerItems()) out[it.name] = (out[it.name] ?? 0) + it.count;
  return out;
}

const where = (b: Block) => ({ x: b.position.x, y: b.position.y, z: b.position.z });
const given = (a: { x?: number; y?: number; z?: number }) => a.x !== undefined && a.y !== undefined && a.z !== undefined;

/** Home is this near: the chest goes by it, where the village keeps its things. */
const CHEST_BY_HOME = 64;

/**
 * No chest about: a builder makes one (anyone, when there is no builder), sets it down by home when home is near, and
 * it is used. Otherwise why not: the builder to ask, or what went wrong.
 */
async function makeChest(ctx: SkillContext): Promise<Block | string> {
  const { bot } = ctx;
  const builder = ctx.chestMaker?.() ?? null;
  if (builder) return `there's no chest here yet; ${builder} is the builder: ask them to make one`;
  if (countItem(bot, itemMatcher('chest')) === 0) {
    ctx.progress('no chest about: making one');
    const made = await runOther(ctx, 'obtain', { item: 'chest', qty: 1 });
    if (!made?.ok) return `there's no chest here, and I couldn't make one: ${made?.error ?? 'no way to'}`;
  }
  const home = ctx.home;
  if (home && home.distanceTo(bot.entity.position) <= CHEST_BY_HOME && home.distanceTo(bot.entity.position) > 4) {
    ctx.progress('taking the chest home');
    await gotoNear(ctx, home, 3).catch((err: unknown) => {
      if (err instanceof SkillAbortedError) throw err;
    });
  }
  const placed = await runOther(ctx, 'place', { block: 'chest' });
  if (!placed?.ok) return `made a chest but couldn't set it down: ${placed?.error ?? 'no room'}`;
  return (await reachContainer(ctx, {})) ?? 'set a chest down but lost sight of it';
}

function keepItem(bot: Bot, name: string): boolean {
  return Boolean(bot.registry.foodsByName[name]) || isWeapon(name) || armorSlotOf(name) !== null || /_(pickaxe|axe|shovel)$/.test(name);
}

export const deposit = defineSkill({
  name: 'deposit',
  description: 'deposit {item?, qty?, x?,y?,z?} — put items into the nearest chest (no item = everything except food, tools, weapons, armor)',
  argsSchema: z.object({ item: z.string().optional(), qty: z.coerce.number().int().min(1).optional(), ...PosOpt }),
  talkOverable: false,
  slipKinds: [],
  expect: (args) => (args.item ? { kind: 'inventoryLoss', item: itemMatcher(args.item).label, atLeast: args.qty ?? 1 } : { kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    try {
      const m0 = args.item ? itemMatcher(args.item) : null;
      if (m0 && !bot.inventory.items().some((i) => m0.matches(i.name))) return { ok: false, observed: 'nothing to deposit', error: `no ${m0.label} in inventory` };
      let block = await reachContainer(ctx, args);
      // Asked for one at a place where there is none: said so, not made up.
      if (!block && given(args)) return { ok: false, observed: 'no chest there', error: `there is no chest at ${args.x},${args.y},${args.z}` };
      if (!block) {
        const made = await makeChest(ctx);
        if (typeof made === 'string') return { ok: false, observed: 'no chest', error: made };
        block = made;
      }
      const container = await bot.openContainer(block);
      let moved = 0;
      let seen: Record<string, number> = {};
      try {
        const m = args.item ? itemMatcher(args.item) : null;
        const items = bot.inventory.items().filter((i) => (m ? m.matches(i.name) : !keepItem(bot, i.name)));
        if (m && items.length === 0) return { ok: false, observed: 'nothing to deposit', error: `no ${m.label} in inventory` };
        let left = args.qty ?? Number.POSITIVE_INFINITY;
        for (const it of items) {
          throwIfAborted(ctx.signal);
          if (left <= 0) break;
          const n = Math.min(it.count, left);
          await container.deposit(it.type, null, n);
          moved += n;
          left -= n;
        }
        seen = contentsOf(container);
      } finally {
        await container.close();
      }
      // What was inside, as we saw it (the village chest's contents, §6.8).
      return { ok: moved > 0, observed: `deposited ${moved} item(s)`, error: moved > 0 ? undefined : 'nothing deposited', data: { chest: where(block), contents: seen } };
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'deposit failed', error: errMsg(err) };
    }
  },
});

export const withdraw = defineSkill({
  name: 'withdraw',
  description: 'withdraw {item, qty, x?,y?,z?} — take items out of the nearest chest',
  argsSchema: z.object({ item: z.string().min(1), qty: z.coerce.number().int().min(1).max(2304).default(1), ...PosOpt }),
  talkOverable: false,
  slipKinds: [],
  expect: (args) => ({ kind: 'inventoryGain', item: itemMatcher(args.item).label, atLeast: args.qty }),
  async run(ctx, args) {
    const { bot } = ctx;
    try {
      const block = await reachContainer(ctx, args);
      if (!block) return { ok: false, observed: 'no chest', error: given(args) ? `there is no chest at ${args.x},${args.y},${args.z}` : 'no chest nearby' };
      const container = await bot.openContainer(block);
      const m = itemMatcher(args.item);
      const start = countItem(bot, m);
      let seen: Record<string, number> = {};
      try {
        let left = args.qty;
        for (const it of container.containerItems().filter((i) => m.matches(i.name))) {
          throwIfAborted(ctx.signal);
          if (left <= 0) break;
          const n = Math.min(it.count, left);
          await container.withdraw(it.type, null, n);
          left -= n;
        }
        seen = contentsOf(container);
      } finally {
        await container.close();
      }
      const data = { chest: where(block), contents: seen };
      const got = countItem(bot, m) - start;
      if (got <= 0) return { ok: false, observed: 'took nothing', error: `no ${m.label} in the chest`, data };
      return { ok: got >= args.qty, observed: `took ${got} ${m.label}`, error: got >= args.qty ? undefined : `only ${got} ${m.label} in the chest`, data };
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'withdraw failed', error: errMsg(err) };
    }
  },
});
