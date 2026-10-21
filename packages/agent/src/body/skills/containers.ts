// Container skills: deposit, withdraw (chests and barrels).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { countItem } from '../inventory';
import { armorSlotOf, isWeapon, itemMatcher } from '../items';
import { findKnownBlocks } from '../sightings';
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
      const block = await reachContainer(ctx, args);
      if (!block) return { ok: false, observed: 'no chest', error: 'no chest nearby' };
      const container = await bot.openContainer(block);
      let moved = 0;
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
      } finally {
        await container.close();
      }
      return { ok: moved > 0, observed: `deposited ${moved} item(s)`, error: moved > 0 ? undefined : 'nothing deposited' };
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
      if (!block) return { ok: false, observed: 'no chest', error: 'no chest nearby' };
      const container = await bot.openContainer(block);
      const m = itemMatcher(args.item);
      const start = countItem(bot, m);
      try {
        let left = args.qty;
        for (const it of container.containerItems().filter((i) => m.matches(i.name))) {
          throwIfAborted(ctx.signal);
          if (left <= 0) break;
          const n = Math.min(it.count, left);
          await container.withdraw(it.type, null, n);
          left -= n;
        }
      } finally {
        await container.close();
      }
      const got = countItem(bot, m) - start;
      if (got <= 0) return { ok: false, observed: 'took nothing', error: `no ${m.label} in the chest` };
      return { ok: got >= args.qty, observed: `took ${got} ${m.label}`, error: got >= args.qty ? undefined : `only ${got} ${m.label} in the chest` };
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'withdraw failed', error: errMsg(err) };
    }
  },
});
