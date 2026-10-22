// Survival skills: eat, equip, sleep.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { armorSlotOf, armorTier, itemMatcher } from '../items';
import { findKnownBlocks } from '../sightings';
import { abortable, errMsg, gotoNear, waitMs } from './util';
import { defineSkill, SkillAbortedError } from './types';

/** Avoid foods with bad effects unless starving. */
const BAD_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit']);

export function bestFood(bot: Bot, allowBad = false): Item | null {
  const foods = bot.registry.foodsByName;
  const candidates = bot.inventory.items().filter((i) => foods[i.name] && (allowBad || !BAD_FOODS.has(i.name)));
  candidates.sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0));
  return candidates[0] ?? null;
}

export async function eatNow(bot: Bot, item: Item): Promise<void> {
  await bot.equip(item, 'hand');
  await bot.consume();
}

export const eat = defineSkill({
  name: 'eat',
  description: 'eat {item?} — eat the best food you carry (or the named one)',
  argsSchema: z.object({ item: z.string().optional() }),
  talkOverable: true,
  slipKinds: [],
  expect: (_args, before) => ({ kind: 'foodAbove', value: Math.min(19, before.food) }),
  async run(ctx, args) {
    const { bot } = ctx;
    if (bot.food >= 20) return { ok: true, observed: 'not hungry' };
    const m = args.item ? itemMatcher(args.item) : null;
    const item = m ? (bot.inventory.items().find((i) => m.matches(i.name)) ?? null) : bestFood(bot, bot.food <= 6);
    if (!item) return { ok: false, observed: 'no food', error: m ? `no ${m.label} to eat` : 'no food in inventory' };
    try {
      await abortable(ctx.signal, eatNow(bot, item), () => bot.deactivateItem());
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'could not eat', error: errMsg(err) };
    }
    return { ok: true, observed: `ate ${item.name}, food ${bot.food}` };
  },
});

export const equip = defineSkill({
  name: 'equip',
  description: 'equip {item, slot?} — hold an item or wear armor (slot: hand|off-hand|head|torso|legs|feet)',
  argsSchema: z.object({
    item: z.string().min(1),
    slot: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']).optional(),
  }),
  talkOverable: true,
  slipKinds: [],
  expect: (args) => ({ kind: 'equipped', item: itemMatcher(args.item).label }),
  async run(ctx, args) {
    const { bot } = ctx;
    const m = itemMatcher(args.item);
    const item = bot.inventory.items().find((i) => m.matches(i.name));
    if (!item) return { ok: false, observed: 'not carried', error: `no ${m.label} in inventory` };
    const slot = args.slot ?? armorSlotOf(item.name) ?? (item.name === 'shield' ? 'off-hand' : 'hand');
    try {
      await bot.equip(item, slot);
    } catch (err) {
      return { ok: false, observed: 'equip failed', error: errMsg(err) };
    }
    return { ok: true, observed: `equipped ${item.name} (${slot})` };
  },
});

/** Wears the best armor piece per slot (the armor reflex, §4.5). Returns what changed. */
export async function equipBestArmor(bot: Bot): Promise<string[]> {
  const changed: string[] = [];
  const slots = { head: 5, torso: 6, legs: 7, feet: 8 } as const;
  for (const [dest, slotIdx] of Object.entries(slots) as [keyof typeof slots, number][]) {
    const current = bot.inventory.slots[slotIdx];
    const currentTier = current ? armorTier(current.name) : 0;
    const best = bot.inventory
      .items()
      .filter((i) => armorSlotOf(i.name) === dest && armorTier(i.name) > currentTier)
      .sort((a, b) => armorTier(b.name) - armorTier(a.name))[0];
    if (best) {
      await bot.equip(best, dest);
      changed.push(best.name);
    }
  }
  return changed;
}

export const sleep = defineSkill({
  name: 'sleep',
  description: 'sleep {near?: {x,y,z}} — sleep in a free bed nearby (near that spot, e.g. one of our own beds) at night',
  argsSchema: z.object({ near: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional() }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'awakeAfterNight' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const bedIds = bot.registry.blocksArray.filter((b) => b.name.endsWith('_bed')).map((b) => b.id);
    // A bed someone already lies in won't take a second sleeper (§19.3: each partner in one of the two beds).
    const near = args.near;
    // Our own beds, from farther off: home first.
    if (near && Math.hypot(bot.entity.position.x - near.x, bot.entity.position.z - near.z) > 16) {
      try {
        await gotoNear(ctx, new Vec3(near.x, near.y, near.z), 3);
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        return { ok: false, observed: 'could not get home', error: errMsg(err) };
      }
    }
    const bed = findKnownBlocks(bot, bedIds, 24, 16).find(
      (b) => !(bot.blockAt(b.position) ?? b).getProperties().occupied && (!near || Math.hypot(b.position.x - near.x, b.position.y - near.y, b.position.z - near.z) <= 4),
    );
    if (!bed) return { ok: false, observed: 'no bed', error: near ? 'no free bed there' : 'no free bed nearby' };
    try {
      if (bed.position.distanceTo(bot.entity.position) > 2.5) await gotoNear(ctx, bed.position, 1);
      await bot.sleep(bot.blockAt(bed.position) ?? bed);
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'could not sleep', error: errMsg(err) };
    }
    ctx.progress('sleeping');
    try {
      await abortable(
        ctx.signal,
        (async () => {
          while (bot.isSleeping) await waitMs(ctx, 1000);
        })(),
        () => void bot.wake().catch(() => undefined),
      );
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
    }
    return { ok: true, observed: 'slept and woke up' };
  },
});
