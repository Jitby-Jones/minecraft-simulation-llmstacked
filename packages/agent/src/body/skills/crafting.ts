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

/**
 * Turns a kind of thing into a concrete craftable item, as a player means it: "planks" or "a sign" or "a door" in the
 * wood on hand (planks or logs we carry, else oak), "a bed" or "wool" or "a carpet" in a colour on hand (else white).
 */
export function resolveCraftTarget(bot: Bot, raw: string): string | null {
  const n = normalizeItemName(raw);
  if (bot.registry.itemsByName[n]) return n;
  const items = bot.inventory.items();
  const fromPlanks = items.filter((i) => i.name.endsWith('_planks')).map((i) => i.name.replace(/_planks$/, ''));
  const fromLogs = items.filter((i) => CATEGORIES.log?.(i.name)).map((i) => i.name.replace(/_(log|stem)$/, ''));
  // Planks are made from logs; the rest from planks.
  const woods = n === 'planks' ? [...fromLogs, ...fromPlanks, 'oak'] : [...fromPlanks, ...fromLogs, 'oak'];
  for (const wood of woods) if (bot.registry.itemsByName[`${wood}_${n}`]) return `${wood}_${n}`;
  const colours = [...items.filter((i) => i.name.endsWith('_wool')).map((i) => i.name.replace(/_wool$/, '')), 'white'];
  for (const colour of colours) if (bot.registry.itemsByName[`${colour}_${n}`]) return `${colour}_${n}`;
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

interface PocketCraft {
  recipe: Recipe;
  times: number;
  name: string;
}

/** All a recipe takes, `times` over. */
function needsOf(bot: Bot, recipe: Recipe, times: number): Missing[] {
  return recipe.delta.filter((d) => d.count < 0).map((d) => ({ name: bot.registry.items[d.id]?.name ?? `item#${d.id}`, count: -d.count * times }));
}

/**
 * How the pockets can make up what a recipe needs by crafting alone, as a player does without a second thought
 * (planks from the logs on hand, sticks from those planks), without touching what the recipe itself takes: the crafts
 * in order (none if all is on hand), or null if anything would have to be got. Two steps deep at most; a table recipe
 * only with a table at hand.
 */
export function pocketPlan(bot: Bot, needs: readonly Missing[], table: boolean, knows: (item: string) => boolean = () => true): PocketCraft[] | null {
  let have = new Map<string, number>();
  for (const it of bot.inventory.items()) have.set(it.name, (have.get(it.name) ?? 0) + it.count);
  const steps: PocketCraft[] = [];
  const take = (name: string, count: number, depth: number): boolean => {
    const h = have.get(name) ?? 0;
    if (h >= count) {
      have.set(name, h - count);
      return true;
    }
    const id = bot.registry.itemsByName[name]?.id;
    if (depth === 0 || id === undefined || !knows(name)) return false;
    const recipes = (bot.recipesAll(id, null, table ? true : null) as unknown as Recipe[]).filter((r) => table || !r.requiresTable);
    for (const r of recipes) {
      const saved = new Map(have);
      const n = steps.length;
      const times = Math.ceil((count - h) / Math.max(1, r.result.count));
      const ok = r.delta.every((d) => {
        if (d.count >= 0) return true;
        const ing = bot.registry.items[d.id]?.name;
        return ing !== undefined && ing !== name && take(ing, -d.count * times, depth - 1);
      });
      if (ok) {
        steps.push({ recipe: r, times, name });
        have.set(name, (have.get(name) ?? 0) + times * r.result.count - count);
        return true;
      }
      have = saved;
      steps.length = n;
    }
    return false;
  };
  // What is on hand for the recipe is kept for it first.
  const onHand = (m: Missing) => (have.get(m.name) ?? 0) >= m.count;
  for (const m of [...needs].sort((a, b) => Number(onHand(b)) - Number(onHand(a)))) if (!take(m.name, m.count, 2)) return null;
  return steps;
}

/** Makes what `pocketPlan` found; what was made, in words, or null if the server would not have it. */
async function craftFromPockets(ctx: SkillContext, plan: readonly PocketCraft[], table: Block | null): Promise<string | null> {
  const { bot } = ctx;
  const made: string[] = [];
  for (const step of plan) {
    throwIfAborted(ctx.signal);
    const before = countItem(bot, step.name);
    const want = step.times * step.recipe.result.count;
    await abortable(ctx.signal, bot.craft(step.recipe as never, step.times, step.recipe.requiresTable ? (table ?? undefined) : undefined), () => undefined);
    const deadline = Date.now() + 1500;
    while (countItem(bot, step.name) - before < want && Date.now() < deadline) await waitMs(ctx, 100);
    if (countItem(bot, step.name) - before <= 0) return null;
    made.push(`${countItem(bot, step.name) - before} ${step.name}`);
  }
  return made.join(', ');
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
      let first = '';
      if (recipes.length === 0) {
        // What is missing, made from what is on hand if it can be (for the variant closest to what we carry).
        for (const r of all) {
          if (r.requiresTable && !table) continue;
          const plan = pocketPlan(bot, needsOf(bot, r, Math.ceil(args.qty / Math.max(1, r.result.count))), table !== null, ctx.knowsRecipe);
          if (!plan || plan.length === 0) continue;
          const made = await craftFromPockets(ctx, plan, table);
          if (made) first = `made ${made} from what I had, then `;
          recipes = bot.recipesFor(item.id, null, 1, table);
          break;
        }
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
      if (missingFor(bot, recipe, times).length > 0) {
        // Short for all of it: what can be made on the spot is made first.
        const plan = pocketPlan(bot, needsOf(bot, recipe, times), table !== null, ctx.knowsRecipe);
        const made = plan && plan.length > 0 ? await craftFromPockets(ctx, plan, table) : null;
        if (made) first = `made ${made} from what I had, then `;
      }
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
      return { ok: got >= want, observed: `${first}crafted ${got} ${name}` };
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `could not craft ${name}`, error: errMsg(err) };
    }
  },
});

const FUELS = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block'];

/** How many items one of this fuel smelts. */
export function fuelValue(name: string): number {
  if (name === 'coal_block') return 80;
  if (name === 'dried_kelp_block') return 20;
  if (name === 'blaze_rod') return 12;
  if (FUELS.includes(name)) return 8;
  if (name === 'stick') return 0.5;
  return CATEGORIES.log?.(name) || name.endsWith('_planks') ? 1.5 : 1;
}

function pickFuel(bot: Bot, prefer?: string): { name: string; perItem: number } | null {
  const items = bot.inventory.items();
  if (prefer && items.some((i) => i.name === prefer)) return { name: prefer, perItem: fuelValue(prefer) };
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

/**
 * An open furnace made ready for `qty` of `input`: what is left in it from before (cooked, or something else still
 * raw when the fuel ran out) comes out first, since a slot that holds something else takes nothing new; and there
 * is fuel enough for the batch, counting what is in it (a different fuel comes out to make room for ours). The
 * error, if there is no fuel at all.
 */
export async function readyFurnace(bot: Bot, furnace: FurnaceApi, input: string, qty: number): Promise<string | null> {
  if (furnace.outputItem()) await furnace.takeOutput();
  const left = furnace.inputItem();
  if (left && left.name !== input) await furnace.takeInput();
  const inFuel = furnace.fuelItem();
  const burns = inFuel ? fuelValue(inFuel.name) * inFuel.count : 0;
  if (burns >= qty) return null;
  const fuel = pickFuel(bot, inFuel?.name);
  if (!fuel) return inFuel ? null : 'need fuel (coal, logs or planks)';
  const fuelType = bot.registry.itemsByName[fuel.name]?.id;
  if (fuelType === undefined) return inFuel ? null : 'unknown fuel';
  const same = inFuel?.name === fuel.name;
  if (inFuel && !same) await furnace.takeFuel();
  const n = Math.min(countItem(bot, fuel.name), Math.ceil((qty - (same ? burns : 0)) / fuel.perItem));
  if (n > 0) await furnace.putFuel(fuelType, null, n);
  return null;
}

export interface FurnaceApi {
  putInput(itemType: number, metadata: number | null, count: number): Promise<void>;
  putFuel(itemType: number, metadata: number | null, count: number): Promise<void>;
  takeOutput(): Promise<unknown>;
  outputItem(): { name: string; count: number } | null;
  inputItem(): { name: string; count: number } | null;
  fuelItem(): { name: string; count: number } | null;
  takeInput(): Promise<unknown>;
  takeFuel(): Promise<unknown>;
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
      const unready = await readyFurnace(bot, furnace, input, qty);
      if (unready) return { ok: false, observed: 'no fuel', error: unready };
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
