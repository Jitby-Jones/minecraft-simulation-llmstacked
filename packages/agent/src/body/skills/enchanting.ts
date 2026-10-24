// Anvils and enchanting (owner request, 2026-10-24). `name {item, name}`: a tool, weapon or piece of armor of one's
// own given a name at an anvil, as players do with the one they're proudest of. The anvil is one this agent has seen
// (and remembers where), one it carries, or one it makes, when it has the 31 iron that takes. `enchant {item}`: a
// weapon, tool or armor enchanted at an enchanting table, with lapis and experience: the strongest of the three offers
// it can pay for. Both cost experience levels, earned mining ore, smelting, and killing mobs; neither is pretended.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';
import type { Vec3 } from 'vec3';
import { countItem } from '../inventory';
import { itemMatcher } from '../items';
import { findKnownBlocks } from '../sightings';
import { findPlaceableSpot } from '../world';
import { placeItemAt } from './building';
import { runOther } from './tools';
import { defineSkill, type SkillContext } from './types';
import { errMsg, gotoNear, throwIfAborted, waitMs } from './util';

/** A name as the game keeps it (a plain string, or a text component). */
export function customNameOf(item: Item | null | undefined): string | null {
  const raw = (item as unknown as { customName?: unknown } | null)?.customName;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw) as { text?: string };
      return typeof j === 'object' && j && typeof j.text === 'string' ? j.text : raw;
    } catch {
      return raw;
    }
  }
  const o = raw as { text?: unknown; value?: unknown; type?: string };
  if (typeof o.text === 'string') return o.text;
  if (typeof o.value === 'string') return o.value;
  if (o.value && typeof o.value === 'object' && typeof (o.value as { text?: { value?: string } }).text?.value === 'string') return (o.value as { text: { value: string } }).text.value;
  return null;
}

/** The enchantments on an item, by name and level. */
export function enchantsOf(bot: Bot, item: Item | null | undefined): { name: string; lvl: number }[] {
  if (!item) return [];
  let raw: unknown;
  try {
    raw = (item as unknown as { enchants?: unknown }).enchants;
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { enchantments?: unknown }).enchantments) ? (raw as { enchantments: unknown[] }).enchantments : [];
  return list
    .map((e) => {
      const x = e as { name?: string; id?: number | string; lvl?: number; level?: number };
      const name = x.name ?? (typeof x.id === 'number' ? bot.registry.enchantments?.[x.id]?.name : typeof x.id === 'string' ? x.id.replace(/^minecraft:/, '') : undefined) ?? 'unknown';
      return { name, lvl: x.lvl ?? x.level ?? 1 };
    })
    .filter((e) => e.name !== 'unknown' || e.lvl > 0);
}

const ANVILS = ['anvil', 'chipped_anvil', 'damaged_anvil'];
/** Iron an anvil takes: three blocks of nine and four ingots. */
export const ANVIL_IRON = 31;

function ironHeld(bot: Bot): number {
  return countItem(bot, itemMatcher('iron_ingot')) + 9 * countItem(bot, itemMatcher('iron_block'));
}

/** The item of ours asked for: the best match ("sword" is the best sword we carry). */
function ourItem(bot: Bot, what: string): Item | null {
  const m = itemMatcher(what);
  const w = what.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_').replace(/s$/, '');
  const items = bot.inventory.items();
  // Its own name, else any of the kind ("sword": an iron sword), else one with the word in it.
  let all = items.filter((i) => m.matches(i.name));
  if (all.length === 0) all = items.filter((i) => i.name.endsWith(`_${w}`));
  if (all.length === 0) all = items.filter((i) => i.name.includes(w));
  const rank = (n: string) => ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden', 'leather', 'chainmail'].findIndex((x) => n.startsWith(`${x}_`));
  return all.sort((a, b) => (rank(a.name) < 0 ? 99 : rank(a.name)) - (rank(b.name) < 0 ? 99 : rank(b.name)))[0] ?? null;
}

/**
 * A block of this kind to use: one seen before (remembered where), else one carried put down nearby, else one made
 * (`make` says whether we can) and put down. Null, with why, when there's none to be had.
 */
async function stationFor(ctx: SkillContext, names: readonly string[], make: { item: string; can: () => string | null }): Promise<{ block: Block } | { why: string }> {
  const { bot } = ctx;
  const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((v): v is number => v !== undefined);
  const known = findKnownBlocks(bot, ids, 64, 4)[0];
  if (known) return { block: known };
  if (!names.some((n) => countItem(bot, itemMatcher(n)) > 0)) {
    const cant = make.can();
    if (cant) return { why: cant };
    ctx.progress(`making ${make.item.replace(/_/g, ' ')}`);
    const r = await runOther(ctx, 'obtain', { item: make.item, qty: 1 });
    if (!r?.ok) return { why: `could not make ${make.item.replace(/_/g, ' ')}: ${r?.error ?? 'no way to'}` };
  }
  const carried = names.find((n) => countItem(bot, itemMatcher(n)) > 0);
  const spot = findPlaceableSpot(bot, 3);
  if (!carried || !spot) return { why: `nowhere to put the ${make.item.replace(/_/g, ' ')} down` };
  await placeItemAt(ctx, carried, spot);
  const b = bot.blockAt(spot);
  return b && names.includes(b.name) ? { block: b } : { why: `the ${make.item.replace(/_/g, ' ')} did not go down` };
}

interface WindowLike {
  slots: (Item | null)[];
  inventoryStart: number;
  inventoryEnd: number;
  items(): Item[];
}

export const nameItem = defineSkill({
  name: 'name',
  description: `name {item, name} — give a tool, weapon or armor of yours a name at an anvil (one you've seen, one you carry, or one made of ${ANVIL_IRON} iron); costs an experience level`,
  argsSchema: z.object({ item: z.string().min(2), name: z.string().min(1).max(35) }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const item = ourItem(bot, args.item);
    if (!item) return { ok: false, observed: `no ${args.item} on me`, error: `I don't have a ${args.item} to name` };
    if (customNameOf(item) === args.name) return { ok: true, observed: `my ${item.name.replace(/_/g, ' ')} is already called ${args.name}` };
    if (bot.experience.level < 1) return { ok: false, observed: 'no experience', error: 'naming takes an experience level: mine ore or coal, smelt, or kill mobs first' };
    const st = await stationFor(ctx, ANVILS, {
      item: 'anvil',
      can: () => (ironHeld(bot) >= ANVIL_IRON ? null : `no anvil seen, and an anvil takes ${ANVIL_IRON} iron (I have ${ironHeld(bot)})`),
    });
    if ('why' in st) return { ok: false, observed: 'no anvil', error: st.why };
    throwIfAborted(ctx.signal);
    await gotoNear(ctx, st.block.position, 3);
    const win = (await bot.openBlock(st.block)) as unknown as WindowLike & { id: number };
    try {
      const src = win.slots.findIndex((it, i) => i >= win.inventoryStart && it?.type === item.type && customNameOf(it) === customNameOf(item));
      if (src < 0) throw new Error(`lost track of the ${item.name}`);
      await bot.moveSlotItem(src, 0);
      // The game names what is in the anvil as the name is typed.
      (bot as unknown as { _client: { write(p: string, d: object): void } })._client.write('name_item', { name: args.name });
      for (let t = 0; t < 30 && !(win.slots[2] && customNameOf(win.slots[2]) === args.name); t++) await waitMs(ctx, 100);
      if (!win.slots[2]) throw new Error('the anvil gave nothing back (not enough experience?)');
      await bot.putAway(2);
      // Anything left in the anvil comes back.
      if (win.slots[0]) await bot.putAway(0);
    } catch (err) {
      if (win.slots[0]) await bot.putAway(0).catch(() => undefined);
      return { ok: false, observed: 'naming failed', error: errMsg(err) };
    } finally {
      void bot.closeWindow(win as never);
    }
    const named = bot.inventory.items().find((i) => i.type === item.type && customNameOf(i) === args.name);
    if (!named) return { ok: false, observed: 'the name did not take', error: 'the anvil did not name it' };
    return { ok: true, observed: `named my ${item.name.replace(/_/g, ' ')} "${args.name}"`, data: { item: item.name, name: args.name } };
  },
});

/** What enchanting can go on: weapons, tools, armor, bows, books. */
const ENCHANTABLE = /(_sword|_axe|_pickaxe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|^bow$|^crossbow$|^trident$|^fishing_rod$|^book$|^mace$|^shield$)/;

export const enchant = defineSkill({
  name: 'enchant',
  description: 'enchant {item} — enchant a weapon, tool or armor of yours at an enchanting table (one seen, carried, or made of a book, 2 diamonds and 4 obsidian), with lapis lazuli and experience: the strongest enchantment you can pay for',
  argsSchema: z.object({ item: z.string().min(2) }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const item = ourItem(bot, args.item);
    if (!item) return { ok: false, observed: `no ${args.item} on me`, error: `I don't have a ${args.item} to enchant` };
    if (!ENCHANTABLE.test(item.name)) return { ok: false, observed: `a ${item.name} can't be enchanted`, error: `${item.name.replace(/_/g, ' ')} takes no enchantment` };
    if (enchantsOf(bot, item).length > 0) return { ok: false, observed: 'already enchanted', error: `my ${item.name.replace(/_/g, ' ')} is enchanted already` };
    const lapis = countItem(bot, itemMatcher('lapis_lazuli'));
    if (lapis < 1) return { ok: false, observed: 'no lapis', error: 'enchanting takes lapis lazuli (mined deep down, blue ore)' };
    if (bot.experience.level < 1) return { ok: false, observed: 'no experience', error: 'enchanting takes experience levels: mine ore or coal, smelt, or kill mobs first' };
    const st = await stationFor(ctx, ['enchanting_table'], {
      item: 'enchanting_table',
      can: () => {
        const lack = [
          ['book', 1],
          ['diamond', 2],
          ['obsidian', 4],
        ].filter(([n, k]) => countItem(bot, itemMatcher(String(n))) < Number(k));
        return lack.length === 0 ? null : `no enchanting table seen, and making one takes ${lack.map(([n, k]) => `${k} ${n}`).join(', ')} more than I have`;
      },
    });
    if ('why' in st) return { ok: false, observed: 'no enchanting table', error: st.why };
    throwIfAborted(ctx.signal);
    await gotoNear(ctx, st.block.position, 3);
    const table = (await (bot as unknown as { openEnchantmentTable(b: Block): Promise<unknown> }).openEnchantmentTable(st.block)) as WindowLike & {
      enchantments: { level: number; expected: { enchant: number; level: number } }[];
      putTargetItem(i: Item): Promise<void>;
      putLapis(i: Item): Promise<void>;
      enchant(choice: number): Promise<Item>;
      takeTargetItem(): Promise<Item>;
      once(ev: 'ready', f: () => void): void;
    };
    let chosen: { level: number; clue: string } | undefined;
    try {
      const target = table.items().find((i) => i.type === item.type && enchantsOf(bot, i).length === 0);
      const blue = table.items().find((i) => i.name === 'lapis_lazuli');
      if (!target || !blue) throw new Error('lost track of the item or the lapis');
      await table.putTargetItem(target);
      await table.putLapis(blue);
      // The table shows its three offers once both are in.
      for (let t = 0; t < 60 && !table.enchantments.some((o) => o.level > 0); t++) await waitMs(ctx, 100);
      // The strongest offer we can pay for: its level in experience, and one lapis and one level per row.
      const offers = table.enchantments.map((o, i) => ({ i, ...o })).filter((o) => o.level > 0 && o.level <= bot.experience.level && o.i + 1 <= Math.min(lapis, 3));
      const pick = offers.sort((a, b) => b.i - a.i)[0];
      if (!pick) throw new Error(`no enchantment I can pay for (level ${bot.experience.level}, ${lapis} lapis; offers ${table.enchantments.map((o) => o.level).join('/')})`);
      const clueName = bot.registry.enchantments?.[pick.expected.enchant]?.name;
      chosen = { level: pick.level, clue: clueName ? `${clueName.replace(/_/g, ' ')} ${pick.expected.level > 0 ? pick.expected.level : ''}`.trim() : 'something' };
      await table.enchant(pick.i);
      ctx.logger.debug({ module: 'skill', slot0: table.slots[0]?.name, components: [...((table.slots[0] as unknown as { componentMap?: Map<string, unknown> } | null)?.componentMap ?? new Map()).keys()] }, 'enchanted');
      await table.takeTargetItem();
      if (table.slots[1]) await bot.putAway(1);
      for (let t = 0; t < 20 && !bot.inventory.items().some((i) => i.type === item.type && enchantsOf(bot, i).length > 0); t++) await waitMs(ctx, 100);
    } catch (err) {
      for (const s of [0, 1]) if (table.slots[s]) await bot.putAway(s).catch(() => undefined);
      return { ok: false, observed: 'enchanting failed', error: errMsg(err) };
    } finally {
      void bot.closeWindow(table as never);
    }
    const done = bot.inventory.items().find((i) => i.type === item.type && enchantsOf(bot, i).length > 0);
    const list = enchantsOf(bot, done);
    if (!done || list.length === 0) return { ok: false, observed: 'the enchantment did not take', error: 'the table did not enchant it' };
    return {
      ok: true,
      observed: `enchanted my ${item.name.replace(/_/g, ' ')}: ${list.map((e) => `${e.name.replace(/_/g, ' ')} ${e.lvl}`).join(', ')} (level ${chosen?.level ?? '?'} offer)`,
      data: { item: item.name, enchants: list },
    };
  },
});

/** Where an anvil this agent has seen stands, if any (for what it tells others). */
export function knownAnvil(bot: Bot): Vec3 | null {
  const ids = ANVILS.map((n) => bot.registry.blocksByName[n]?.id).filter((v): v is number => v !== undefined);
  return findKnownBlocks(bot, ids, 64, 1)[0]?.position ?? null;
}
