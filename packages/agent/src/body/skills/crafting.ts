// Crafting skills: craft (auto-places a crafting table from inventory if needed), smelt (furnace).
// The recipe knowledge gate (§21.2) lives here: mineflayer knows every recipe, the agent might not.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { countItem } from '../inventory';
import { CATEGORIES, normalizeItemName } from '../items';
import { findKnownBlocks } from '../sightings';
import { findPlaceableSpot } from '../world';
import { placeItemAt } from './building';
import { abortable, errMsg, gotoNear, throwIfAborted, waitMs } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

interface Recipe {
  result: { id: number; count: number };
  delta: { id: number; count: number }[];
  requiresTable: boolean;
}

/** Turns categories into a concrete craftable item: "planks" → planks of a log we own. */
export function resolveCraftTarget(bot: Bot, raw: string): string | null {
  const n = normalizeItemName(raw);
  if (bot.registry.itemsByName[n]) return n;
  if (n === 'planks') {
    const log = bot.inventory.items().find((i) => CATEGORIES.log?.(i.name));
    const wood = log ? log.name.replace(/_(log|stem)$/, '') : 'oak';
    const name = `${wood}_planks`;
    return bot.registry.itemsByName[name] ? name : 'oak_planks';
  }
  if (n === 'bed') return 'white_bed';
  return null;
}

interface Missing {
  name: string;
  count: number;
}

function missingItems(bot: Bot, recipe: Recipe, times: number): Missing[] {
  const out: Missing[] = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const need = -d.count * times;
    const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
    const have = countItem(bot, name);
    if (have < need) out.push({ name, count: need - have });
  }
  return out;
}

function missingFor(bot: Bot, recipe: Recipe, times: number): string[] {
  return missingItems(bot, recipe, times).map((m) => `${m.count} ${m.name}`);
}

// Tie-break between equally-short shopping lists: name the everyday material (cobblestone, not blackstone).
const EVERYDAY = new Set(['cobblestone', 'oak_planks', 'oak_log', 'stick', 'iron_ingot', 'coal', 'string', 'white_wool']);

/** "3 cobblestone (or cobbled_deepslate/blackstone)": other variants that swap exactly one ingredient. */
export function describeMissing(best: readonly Missing[], others: readonly (readonly Missing[])[]): string {
  return best
    .map((m) => {
      const alts = new Set<string>();
      for (const o of others) {
        if (o.length !== best.length) continue;
        const lacking = best.filter((b) => !o.some((x) => x.name === b.name));
        const extra = o.filter((x) => !best.some((b) => b.name === x.name));
        if (lacking.length === 1 && lacking[0]?.name === m.name && extra.length === 1 && extra[0]?.count === m.count) alts.add(extra[0].name);
      }
      const list = [...alts].slice(0, 3);
      return list.length > 0 ? `${m.count} ${m.name} (or ${list.join('/')})` : `${m.count} ${m.name}`;
    })
    .join(', ');
}

async function findOrPlace(ctx: SkillContext, blockName: string, itemName: string): Promise<Block | null> {
  const { bot } = ctx;
  const id = bot.registry.blocksByName[blockName]?.id;
  if (id === undefined) return null;
  const near = findKnownBlocks(bot, [id], 24, 1)[0];
  if (near) {
    if (near.position.distanceTo(bot.entity.position) > 3.5) await gotoNear(ctx, near.position, 2);
    return bot.blockAt(near.position);
  }
  if (countItem(bot, itemName) === 0) return null;
  const spot = findPlaceableSpot(bot, 3);
  if (!spot) return null;
  await placeItemAt(ctx, itemName, spot);
  await waitMs(ctx, 300);
  return bot.blockAt(spot);
}

export const craft = defineSkill({
  name: 'craft',
  description: 'craft {item, qty} — craft items (uses a nearby crafting table, or places one you carry)',
  argsSchema: z.object({ item: z.string().min(1), qty: z.coerce.number().int().min(1).max(64).default(1) }),
  talkOverable: false,
  slipKinds: ['count'],
  expect: (args, _before, bot) => ({ kind: 'inventoryGain', item: resolveCraftTarget(bot, args.item) ?? normalizeItemName(args.item), atLeast: args.qty }),
  async run(ctx, args) {
    const { bot } = ctx;
    const name = resolveCraftTarget(bot, args.item);
    if (!name) return { ok: false, observed: 'unknown item', error: `there is no item called ${args.item}` };
    if (!ctx.knowsRecipe(name)) return { ok: false, observed: 'did not try', error: `I don't know how to make ${name}` };
    const item = bot.registry.itemsByName[name];
    if (!item) return { ok: false, observed: 'unknown item', error: `unknown item ${name}` };
    const all = bot.recipesAll(item.id, null, true) as unknown as Recipe[];
    if (all.length === 0) return { ok: false, observed: 'no recipe', error: `${name} cannot be crafted` };
    let table: Block | null = null;
    let recipes: Recipe[] = bot.recipesFor(item.id, null, 1, null);
    try {
      if (recipes.length === 0 && all.some((r) => r.requiresTable)) {
        table = await findOrPlace(ctx, 'crafting_table', 'crafting_table');
        if (table) recipes = bot.recipesFor(item.id, null, 1, table);
      }
      const recipe = recipes[0];
      if (!recipe) {
        // Report against the variant closest to what we carry (oak planks, not cherry planks).
        const score = (m: Missing[]): [number, number, number] => [
          m.length,
          m.filter((x) => !EVERYDAY.has(x.name)).length,
          m.reduce((a, x) => a + x.count, 0),
        ];
        const ranked = all
          .map((r) => {
            const t = Math.ceil(args.qty / Math.max(1, r.result.count));
            const missing = missingItems(bot, r, t);
            return { r, missing, key: score(missing) };
          })
          .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
        const { r: best, missing } = ranked[0] as { r: Recipe; missing: Missing[] };
        const text = describeMissing(missing, ranked.slice(1).map((x) => x.missing));
        if (best.requiresTable && !table) {
          return { ok: false, observed: 'no crafting table', error: text ? `need a crafting table and ${text}` : 'need a crafting table' };
        }
        return { ok: false, observed: 'missing ingredients', error: `missing ${text || 'ingredients'}` };
      }
      let times = Math.ceil(args.qty / Math.max(1, recipe.result.count));
      const missing = missingFor(bot, recipe, times);
      if (missing.length > 0) {
        // Craft what we can.
        times = Math.max(1, times - 1);
        while (times > 1 && missingFor(bot, recipe, times).length > 0) times--;
      }
      if (ctx.slip === 'count' && times > 1) times -= 1;
      const before = countItem(bot, name);
      const want = times * recipe.result.count;
      // Verify against the server's view and retry once: a craft the server rejected comes back as
      // returned ingredients, not an error.
      for (let attempt = 0; attempt < 2; attempt++) {
        throwIfAborted(ctx.signal);
        await abortable(ctx.signal, bot.craft(recipe as never, times, table ?? undefined), () => undefined);
        const deadline = Date.now() + 1500;
        while (countItem(bot, name) - before < want && Date.now() < deadline) await waitMs(ctx, 100);
        if (countItem(bot, name) - before >= want) break;
        ctx.logger.warn({ module: 'skill', item: name, attempt }, 'craft not confirmed by the server; retrying');
        await waitMs(ctx, 500);
        if (missingFor(bot, recipe, times).length > 0) break;
      }
      const got = countItem(bot, name) - before;
      if (got <= 0) return { ok: false, observed: `could not craft ${name}`, error: 'the server did not accept the craft' };
      return { ok: got >= want, observed: `crafted ${got} ${name}` };
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `could not craft ${name}`, error: errMsg(err) };
    }
  },
});

const FUELS = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block'];

function pickFuel(bot: Bot): { name: string; perItem: number } | null {
  const items = bot.inventory.items();
  for (const f of FUELS) {
    if (items.some((i) => i.name === f)) return { name: f, perItem: f === 'coal_block' ? 80 : f === 'blaze_rod' ? 12 : 8 };
  }
  const log = items.find((i) => CATEGORIES.log?.(i.name));
  if (log) return { name: log.name, perItem: 1.5 };
  const planks = items.find((i) => i.name.endsWith('_planks'));
  if (planks) return { name: planks.name, perItem: 1.5 };
  const stick = items.find((i) => i.name === 'stick');
  if (stick) return { name: 'stick', perItem: 0.5 };
  return null;
}

interface FurnaceApi {
  putInput(itemType: number, metadata: number | null, count: number): Promise<void>;
  putFuel(itemType: number, metadata: number | null, count: number): Promise<void>;
  takeOutput(): Promise<unknown>;
  outputItem(): { name: string; count: number } | null;
  inputItem(): { name: string; count: number } | null;
  fuelItem(): { name: string; count: number } | null;
  close(): void;
}

export const smelt = defineSkill({
  name: 'smelt',
  description: 'smelt {item, qty} — cook/smelt items in a furnace (raw_iron → iron_ingot, beef → cooked_beef)',
  argsSchema: z.object({ item: z.string().min(1), qty: z.coerce.number().int().min(1).max(64).default(1) }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const input = normalizeItemName(args.item);
    const inputItem = bot.inventory.items().find((i) => i.name === input);
    if (!inputItem) return { ok: false, observed: 'nothing to smelt', error: `no ${input} in inventory` };
    const qty = Math.min(args.qty, countItem(bot, input));
    let furnaceBlock: Block | null;
    try {
      furnaceBlock = await findOrPlace(ctx, 'furnace', 'furnace');
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'no furnace', error: errMsg(err) };
    }
    if (!furnaceBlock) return { ok: false, observed: 'no furnace', error: 'need a furnace' };
    let furnace: FurnaceApi | null = null;
    let got = 0;
    let outputName = '';
    try {
      furnace = await bot.openFurnace(furnaceBlock);
      if (!furnace.fuelItem()) {
        const fuel = pickFuel(bot);
        if (!fuel) return { ok: false, observed: 'no fuel', error: 'need fuel (coal, logs or planks)' };
        const fuelType = bot.registry.itemsByName[fuel.name]?.id;
        if (fuelType === undefined) return { ok: false, observed: 'no fuel', error: 'unknown fuel' };
        const n = Math.min(countItem(bot, fuel.name), Math.ceil(qty / fuel.perItem));
        await furnace.putFuel(fuelType, null, n);
      }
      await furnace.putInput(inputItem.type, null, qty);
      const deadline = Date.now() + qty * 10_500 + 8000;
      while (got < qty && Date.now() < deadline) {
        await waitMs(ctx, 1000);
        const out = furnace.outputItem();
        if (out && out.count > 0) {
          outputName = out.name;
          const n = out.count;
          await furnace.takeOutput();
          got += n;
        }
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `smelted ${got}`, error: errMsg(err) };
    } finally {
      furnace?.close();
    }
    return got >= qty
      ? { ok: true, observed: `smelted ${got} ${outputName || 'items'}` }
      : { ok: got > 0, observed: `smelted ${got}/${qty} ${outputName || 'items'}`, error: got > 0 ? undefined : 'nothing came out' };
  },
});
