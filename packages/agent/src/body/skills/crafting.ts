// Crafting skills: craft (auto-places a crafting table from inventory if needed), smelt (furnace).
// The recipe knowledge gate (§21.2) lives here: mineflayer knows every recipe, the agent might not.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { countItem } from '../inventory';
import { CATEGORIES, normalizeItemName } from '../items';
import { findKnownBlocks } from '../sightings';
import { placeItemAt, spotOrNotch } from './building';
import { abortable, errMsg, gotoNear, throwIfAborted, upTo, waitMs } from './util';
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
  const said = normalizeItemName(raw);
  if (bot.registry.itemsByName[said]) return said;
  // "wooden_door", "wood_slab": any wood, as the names of old had it (the game now names each by its wood).
  const n = said.replace(/^(wooden|wood)_/, '');
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

/** "there is no item called wooden_door (there is oak_door, iron_door...)": names the game has with the same last word. */
export function noSuchItem(bot: Bot, name: string): string {
  const last = name.split('_').at(-1) ?? name;
  const near = Object.keys(bot.registry.itemsByName)
    .filter((k) => k === last || k.endsWith(`_${last}`))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 4);
  return `there is no item called ${name}${near.length > 0 ? ` (there is ${near.join(', ')})` : ''}`;
}

interface Missing {
  name: string;
  count: number;
  /** How many of it are on hand already. */
  have?: number;
}

function missingItems(bot: Bot, recipe: Recipe, times: number): Missing[] {
  const out: Missing[] = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const need = -d.count * times;
    const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
    const have = countItem(bot, name);
    if (have < need) out.push({ name, count: need - have, have });
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
      // Short of some, not all: how many in all, and how many on hand. "missing 1 iron_ingot" with 2 on hand was
      // read as wanting 1 in all; obtain {qty: 1} found 2 already there, three times over.
      const what = m.have ? `${m.count} more ${m.name} (${m.count + m.have} needed, ${m.have} on hand)` : `${m.count} ${m.name}`;
      return list.length > 0 ? `${what} (or ${list.join('/')})` : what;
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

/** The player's own 2×2 crafting grid (slots 1 to 4 of the inventory window; 0 is what comes out). */
const GRID = [1, 2, 3, 4] as const;

/**
 * What a craft the server didn't finish left in the 2×2 grid, given back first: closing one's inventory screen hands
 * them back, as a player knows, and a body never closes its own. Left there, a torch's coal and stick made every craft
 * after it come out as nothing (an agent's planks were refused eight times running).
 */
export async function clearGrid(ctx: SkillContext): Promise<void> {
  const { bot } = ctx;
  if (!GRID.some((i) => bot.inventory.slots[i])) return;
  ctx.logger.info({ module: 'skill', grid: GRID.map((i) => bot.inventory.slots[i]?.name ?? '-') }, 'things left in the crafting grid; giving them back');
  (bot as unknown as { _client: { write(name: string, data: unknown): void } })._client.write('close_window', { windowId: 0 });
  for (let t = 0; t < 10 && GRID.some((i) => bot.inventory.slots[i]); t++) await waitMs(ctx, 100);
}

/** Makes what `pocketPlan` found; what was made, in words, or null if the server would not have it. */
async function craftFromPockets(ctx: SkillContext, plan: readonly PocketCraft[], table: Block | null): Promise<string | null> {
  const { bot } = ctx;
  const made: string[] = [];
  for (const step of plan) {
    throwIfAborted(ctx.signal);
    const before = countItem(bot, step.name);
    const want = step.times * step.recipe.result.count;
    if (!step.recipe.requiresTable) await clearGrid(ctx);
    await abortable(ctx.signal, bot.craft(step.recipe as never, step.times, step.recipe.requiresTable ? (table ?? undefined) : undefined), () => undefined);
    const deadline = Date.now() + 1500;
    while (countItem(bot, step.name) - before < want && Date.now() < deadline) await waitMs(ctx, 100);
    if (countItem(bot, step.name) - before <= 0) return null;
    made.push(`${countItem(bot, step.name) - before} ${step.name}`);
  }
  return made.join(', ');
}

/** A station farther than this is not worth the walk when one can be set down here (a table is one log). */
const NEAR_STATION = 8;

async function findOrPlace(ctx: SkillContext, blockName: string, itemName: string): Promise<Block | null> {
  const { bot } = ctx;
  const id = bot.registry.blocksByName[blockName]?.id;
  if (id === undefined) return null;
  const near = findKnownBlocks(bot, [id], 24, 1)[0];
  // One of our own to set down, or one the pockets make on the spot (planks from a log, then the table).
  const makeable = countItem(bot, itemName) === 0 ? pocketPlan(bot, [{ name: itemName, count: 1 }], false, ctx.knowsRecipe) : [];
  const ours = countItem(bot, itemName) > 0 || (makeable !== null && makeable.length > 0);
  if (near && (near.position.distanceTo(bot.entity.position) <= NEAR_STATION || !ours)) {
    if (near.position.distanceTo(bot.entity.position) > 3.5) await gotoNear(ctx, near.position, 2);
    return bot.blockAt(near.position);
  }
  if (countItem(bot, itemName) === 0 && makeable && makeable.length > 0) await craftFromPockets(ctx, makeable, null);
  if (countItem(bot, itemName) === 0) return null;
  const spot = await spotOrNotch(ctx, itemName);
  if (!spot) return null;
  await placeItemAt(ctx, itemName, spot);
  await waitMs(ctx, 300);
  return bot.blockAt(spot);
}

export const craft = defineSkill({
  name: 'craft',
  description: 'craft {item, qty} — craft items (uses a nearby crafting table, or places one you carry)',
  argsSchema: z.object({ item: z.string().min(1), qty: upTo(1, 64, true).default(1) }),
  talkOverable: false,
  slipKinds: ['count'],
  expect: (args, _before, bot) => ({ kind: 'inventoryGain', item: resolveCraftTarget(bot, args.item) ?? normalizeItemName(args.item), atLeast: args.qty }),
  async run(ctx, args) {
    const { bot } = ctx;
    const name = resolveCraftTarget(bot, args.item);
    if (!name) return { ok: false, observed: 'unknown item', error: noSuchItem(bot, normalizeItemName(args.item)) };
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
      // What the grid shows short for all of it, as a player sees it: "crafted 4 torch" alone had an agent
      // fetching sticks it had plenty of, when it was the coal that had run out.
      const short = missing.length > 0 ? `; short of ${missing.join(' and ')} for all ${times * recipe.result.count}` : '';
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
        if (!table) await clearGrid(ctx);
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
      return { ok: got >= want, observed: `${first}crafted ${got} ${name}${short}` };
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

/** Kept back from the fire: a tool's sticks (an agent burned its last ones and could not make the iron pickaxe it had the iron for, the nearest tree 86 m off). */
const KEPT_FROM_FIRE: Readonly<Record<string, number>> = { stick: 2 };

/** How many of these may go in the fire. */
export function burnable(bot: Bot, name: string): number {
  return Math.max(0, countItem(bot, name) - (KEPT_FROM_FIRE[name] ?? 0));
}

/**
 * The fuel to burn for `need` items, never what is being cooked: coal and the like first, then planks before logs
 * (a log makes four planks, each burning as long as the log), then sticks, a tool's two kept back; the first of them
 * we carry enough of for the whole batch, else whichever goes furthest (one plank put in for three raw iron cooked
 * one of them).
 */
export function pickFuel(bot: Bot, prefer?: string, cooking?: string, need = 1): { name: string; perItem: number } | null {
  const items = bot.inventory.items().filter((i) => i.name !== cooking && burnable(bot, i.name) > 0);
  const has = (name: string) => items.some((i) => i.name === name);
  const order = [
    ...(prefer && has(prefer) ? [prefer] : []),
    ...FUELS.filter(has),
    ...items.filter((i) => i.name.endsWith('_planks')).map((i) => i.name),
    ...items.filter((i) => CATEGORIES.log?.(i.name)).map((i) => i.name),
    ...(has('stick') ? ['stick'] : []),
  ];
  const burns = (name: string) => burnable(bot, name) * fuelValue(name);
  const pick = order.find((n) => burns(n) >= need) ?? [...new Set(order)].sort((a, b) => burns(b) - burns(a))[0];
  return pick ? { name: pick, perItem: fuelValue(pick) } : null;
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
  const fuel = pickFuel(bot, inFuel?.name, input, qty - burns);
  if (!fuel) return inFuel ? null : `need fuel (coal, planks, or logs other than the ${input.replace(/_/g, ' ')} being cooked)`;
  const fuelType = bot.registry.itemsByName[fuel.name]?.id;
  if (fuelType === undefined) return inFuel ? null : 'unknown fuel';
  const same = inFuel?.name === fuel.name;
  if (inFuel && !same) await furnace.takeFuel();
  const n = Math.min(burnable(bot, fuel.name), Math.ceil((qty - (same ? burns : 0)) / fuel.perItem));
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

/** A log's planks: oak_log and stripped_oak_wood → oak_planks, crimson_stem → crimson_planks. */
function planksOf(log: string): string {
  return `${log.replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae)$/, '')}_planks`;
}

/**
 * Short of fuel for the batch with logs on hand: some made into planks first, as a player does (a log in planks burns
 * six items' worth). Logs other than those being cooked go first; for charcoal, failing those, some of the logs being
 * cooked, and the batch is that much smaller. How many fewer of the input there are to cook (0 if none went).
 */
async function planksForFuel(ctx: SkillContext, input: string, qty: number): Promise<number> {
  const { bot } = ctx;
  const fuel = pickFuel(bot, undefined, input, qty);
  if (fuel && burnable(bot, fuel.name) * fuel.perItem >= qty) return 0;
  const other = bot.inventory.items().find((i) => CATEGORIES.log?.(i.name) && i.name !== input);
  const log = other?.name ?? (CATEGORIES.log?.(input) ? input : null);
  if (!log) return 0;
  const planks = planksOf(log);
  const id = bot.registry.itemsByName[planks]?.id;
  if (id === undefined) return 0;
  const recipe = (bot.recipesFor(id, null, 1, null) as unknown as Recipe[]).find((r) => r.delta.some((d) => d.count < 0 && bot.registry.items[d.id]?.name === log));
  if (!recipe) return 0;
  const have = countItem(bot, planks) * 1.5;
  const own = log === input;
  // Each log cut gives 4 planks, 6 items' burning; cutting one of the batch's own also leaves one fewer to cook.
  const cut = Math.max(1, Math.ceil((qty - have) / (own ? 7 : 6)));
  const k = Math.min(cut, countItem(bot, log) - (own ? 1 : 0));
  if (k <= 0) return 0;
  const made = await craftFromPockets(ctx, [{ recipe, times: k, name: planks }], null);
  return made && own ? k : 0;
}

export const smelt = defineSkill({
  name: 'smelt',
  description: 'smelt {item, qty} — cook/smelt items in a furnace (raw_iron → iron_ingot, beef → cooked_beef)',
  argsSchema: z.object({ item: z.string().min(1), qty: upTo(1, 64, true).default(1) }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const input = normalizeItemName(args.item);
    const inputItem = bot.inventory.items().find((i) => i.name === input);
    if (!inputItem) return { ok: false, observed: 'nothing to smelt', error: `no ${input} in inventory` };
    let qty = Math.min(args.qty, countItem(bot, input));
    let furnaceBlock: Block | null;
    const carried = countItem(bot, 'furnace');
    try {
      furnaceBlock = await findOrPlace(ctx, 'furnace', 'furnace');
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'no furnace', error: errMsg(err) };
    }
    if (!furnaceBlock) return { ok: false, observed: 'no furnace', error: 'need a furnace' };
    // One set down here stays here: where, so it is known (a model took "-1 furnace" for one burned up).
    const placed = countItem(bot, 'furnace') < carried ? `; set the furnace down at ${furnaceBlock.position.x},${furnaceBlock.position.y},${furnaceBlock.position.z}` : '';
    qty = Math.min(qty - (await planksForFuel(ctx, input, qty)), countItem(bot, input));
    let furnace: FurnaceApi | null = null;
    let got = 0;
    let outputName = '';
    let left = 0;
    try {
      furnace = await bot.openFurnace(furnaceBlock);
      const unready = await readyFurnace(bot, furnace, input, qty);
      if (unready) return { ok: false, observed: `no fuel${placed}`, error: unready };
      const kind = bot.inventory.items().find((i) => i.name === input)?.type ?? inputItem.type;
      await furnace.putInput(kind, null, qty);
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
      // What didn't cook (the fuel gave out, or time) comes back with us rather than stay in a furnace left behind.
      const raw = furnace.inputItem();
      if (got < qty && raw && raw.name === input) {
        left = raw.count;
        await furnace.takeInput();
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `smelted ${got}${placed}`, error: errMsg(err) };
    } finally {
      furnace?.close();
    }
    const back = left > 0 ? `; took back ${left} ${input} uncooked` : '';
    return got >= qty
      ? { ok: true, observed: `smelted ${got} ${outputName || 'items'}${placed}` }
      : { ok: got > 0, observed: `smelted ${got}/${qty} ${outputName || 'items'}${back}${placed}`, error: got > 0 ? undefined : 'nothing came out' };
  },
});
