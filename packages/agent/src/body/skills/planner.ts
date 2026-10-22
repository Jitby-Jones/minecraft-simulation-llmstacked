// `obtain {item, qty}`: a code planner over the verified skills (§13 rule 2, code before LLM). It works out how to
// get an item (gather, mine, craft or smelt), including the tools, stations and ingredients that needs, and runs
// the steps, checking the real inventory after each one. How many prerequisite levels it can plan through is the
// agent's planning horizon (§21.1): a sharp agent plans "stone pickaxe" in one go; a slower one is told which
// prerequisite to get first and works up to it. The CC decides *what*; this decides *how*.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { countItem } from '../inventory';
import { CATEGORIES, itemMatcher, normalizeItemName } from '../items';
import { findKnownBlocks, isInferable } from '../sightings';
import { blockIdsDropping } from '../world';
import { craft, resolveCraftTarget, smelt } from './crafting';
import { gather, isFoodName } from './gathering';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';
import { throwIfAborted } from './util';

/** Furnace outputs the planner knows (mineflayer's recipe data covers crafting tables only). */
export const SMELTS: Readonly<Record<string, string>> = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  charcoal: 'log',
  cooked_beef: 'beef',
  cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken',
  cooked_mutton: 'mutton',
  cooked_rabbit: 'rabbit',
  cooked_cod: 'cod',
  cooked_salmon: 'salmon',
  baked_potato: 'potato',
  brick: 'clay_ball',
  dried_kelp: 'kelp',
};

const FUEL = ['coal', 'charcoal', 'coal_block'];
const INF = Number.POSITIVE_INFINITY;
/** Gathering something with none in view probably means a trek. */
const NOT_NEARBY_COST = 20;
/**
 * Gathering something that is never common ground (planks, ore) from blocks we haven't seen means searching for it:
 * any other way to make it wins (planks from logs), but ore still plans as "find it" (§13 rule 4).
 */
const UNSEEN_RARE_COST = 200;
/** Blocks that are nine of something packed together: made, not found, so never searched for unseen. */
const STORAGE_BLOCK = /^(raw_)?(iron|gold|copper|diamond|emerald|lapis|redstone|coal|netherite)_block$/;

interface Recipe {
  result: { id: number; count: number };
  delta: { id: number; count: number }[];
  requiresTable: boolean;
}

export class ObtainError extends Error {
  constructor(
    message: string,
    /** The prerequisite to get first when the plan was too deep for this agent. */
    readonly needFirst?: string,
  ) {
    super(message);
    this.name = 'ObtainError';
  }
}

type Route =
  | { kind: 'have'; cost: 0; height: 0 }
  | { kind: 'gather'; cost: number; height: number; tool: string | null }
  | { kind: 'craft'; cost: number; height: number; recipe: Recipe }
  | { kind: 'smelt'; cost: number; height: number; input: string }
  | { kind: 'none'; cost: number; height: number; why: 'circular' | 'unknown' | 'blocked' };

/** A route plus the prerequisite that made it as deep as it is (to name "get X first"). */
type Planned = Route & { deepest?: string; tainted?: boolean };

export function planDepthFor(intelligence: number): number {
  return 2 + Math.round(4 * Math.min(1, Math.max(0, intelligence)));
}

function count(bot: Bot, item: string): number {
  return countItem(bot, itemMatcher(item, isFoodName(bot)));
}

function nameOf(bot: Bot, id: number): string {
  return bot.registry.items[id]?.name ?? `item#${id}`;
}

function hasFuel(bot: Bot): boolean {
  return bot.inventory.items().some((i) => FUEL.includes(i.name) || CATEGORIES.log?.(i.name) === true || CATEGORIES.planks?.(i.name) === true);
}

/**
 * World lookups are the slow part of planning (block scans), so one obtain run caches them for a few seconds;
 * the inventory side is always read fresh.
 */
class WorldScan {
  private readonly cache = new Map<string, { at: number; v: unknown }>();
  constructor(
    private readonly bot: Bot,
    private readonly ttlMs = 30_000,
  ) {}

  private static readonly perBot = new WeakMap<Bot, WorldScan>();

  /** One cache per bot, shared by consecutive obtain runs. */
  static for(bot: Bot): WorldScan {
    let s = WorldScan.perBot.get(bot);
    if (!s) {
      s = new WorldScan(bot);
      WorldScan.perBot.set(bot, s);
    }
    return s;
  }

  private memo<T>(key: string, f: () => T): T {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v as T;
    const v = f();
    this.cache.set(key, { at: Date.now(), v });
    return v;
  }

  drops(item: string): number[] {
    return this.memo(`drops:${item}`, () => blockIdsDropping(this.bot, itemMatcher(item, isFoodName(this.bot))));
  }

  /** The nearest block that drops `item`, if any within 32 blocks. */
  sample(item: string): { harvestTools?: Record<string, boolean> } | null {
    return this.memo(`sample:${item}`, () => {
      const b = findKnownBlocks(this.bot, this.drops(item), 32, 1)[0];
      return b ? { harvestTools: (b as unknown as { harvestTools?: Record<string, boolean> }).harvestTools } : null;
    });
  }

  /** Wood types with a log or stem within 32 blocks (one scan for all of them). */
  nearbyWoods(): ReadonlySet<string> {
    return this.memo('woods', () => {
      const ids = Object.values(this.bot.registry.blocksByName)
        .filter((b) => /_(log|stem)$/.test(b.name))
        .map((b) => b.id);
      const out = new Set<string>();
      for (const b of findKnownBlocks(this.bot, ids, 32, 24)) {
        const w = woodOf(b.name);
        if (w) out.add(w);
      }
      return out;
    });
  }

  stationNearby(name: string): boolean {
    return this.memo(`station:${name}`, () => {
      const id = this.bot.registry.blocksByName[name]?.id;
      return id !== undefined && findKnownBlocks(this.bot, [id], 24, 1).length > 0;
    });
  }

  forget(): void {
    this.cache.clear();
  }
}

function hasStation(bot: Bot, scan: WorldScan, name: string): boolean {
  return count(bot, name) > 0 || scan.stationNearby(name);
}

/** The cheapest harvest tool we'd need for the nearest block that drops `item`, or null if hands will do. */
function toolNeeded(bot: Bot, scan: WorldScan, item: string): string | null {
  const sample = scan.sample(item);
  let tools = sample?.harvestTools;
  if (!sample) {
    const id = scan.drops(item)[0];
    tools = (id !== undefined ? (bot.registry.blocks[id] as unknown as { harvestTools?: Record<string, boolean> } | undefined) : undefined)?.harvestTools;
  }
  if (!tools) return null;
  const toolIds = tools;
  if (bot.inventory.items().some((i) => toolIds[String(i.type)])) return null;
  const names = Object.keys(toolIds).map((k) => nameOf(bot, Number(k)));
  for (const mat of ['wooden', 'stone', 'iron', 'diamond', 'netherite']) {
    const n = names.find((x) => x.startsWith(`${mat}_`));
    if (n) return n;
  }
  return names[0] ?? null;
}

interface PlanCtx {
  bot: Bot;
  knowsRecipe: (item: string) => boolean;
  scan: WorldScan;
  memo: Map<string, Planned>;
  /** Last time the search yielded to the event loop. */
  lastYield: number;
}

/** Recipe variants beyond the ones made of things we hold: wood types and the like are interchangeable. */
const EXTRA_VARIANTS = 2;

const WOODS = ['dark_oak', 'pale_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'spruce', 'birch', 'jungle', 'acacia', 'oak'];
const EVERYDAY_MATERIALS = new Set(['cobblestone', 'oak_planks', 'oak_log', 'stick', 'iron_ingot', 'coal', 'string', 'white_wool']);

export function woodOf(item: string): string | null {
  return WOODS.find((w) => item.startsWith(`${w}_`)) ?? null;
}

/** Long searches give physics, keepalives and reflexes a turn every ~15 ms. */
async function breathe(p: PlanCtx): Promise<void> {
  if (Date.now() - p.lastYield < 15) return;
  await new Promise((r) => setImmediate(r));
  p.lastYield = Date.now();
}

/**
 * Cheapest way to get one more `item` from here. `height` is how many prerequisite levels it needs (0 = can be
 * done right now); the caller compares it with the agent's planning depth. Memoized per item for one planning
 * pass, except results cut short by a cycle (they depend on the path taken).
 */
async function route(p: PlanCtx, item: string, stack: readonly string[]): Promise<Planned> {
  const { bot, scan } = p;
  if (stack.includes(item)) return { kind: 'none', cost: INF, height: 0, why: 'circular', tainted: true };
  const cached = p.memo.get(item);
  if (cached) return cached;
  await breathe(p);
  const next = [...stack, item];
  const options: Planned[] = [];
  let tainted = false;
  /** Height and the deepest child of a set of prerequisites. */
  const deepen = (kids: { name: string; r: Planned }[]): { height: number; deepest?: string } => {
    let height = 0;
    let deepest: string | undefined;
    for (const k of kids) {
      if (k.r.tainted) tainted = true;
      if (1 + k.r.height > height) {
        height = 1 + k.r.height;
        deepest = k.name;
      }
    }
    return { height, deepest };
  };

  const input = SMELTS[item];
  if (input) {
    // What we carry needs no route: raw meat comes from no block, and is cooked all the same.
    const kids = count(bot, input) > 0 ? [] : [{ name: input, r: await route(p, input, next) }];
    if (!hasStation(bot, scan, 'furnace')) kids.push({ name: 'furnace', r: await route(p, 'furnace', next) });
    if (!hasFuel(bot)) kids.push({ name: 'log', r: await route(p, 'log', next) });
    const d = deepen(kids);
    options.push({ kind: 'smelt', cost: 1 + kids.reduce((a, k) => a + k.r.cost, 0), height: d.height, deepest: d.deepest, input });
  }

  const id = bot.registry.itemsByName[item]?.id;
  if (id !== undefined && p.knowsRecipe(item)) {
    const all = bot.recipesAll(id, null, true) as unknown as Recipe[];
    // Variants made of what we already hold first; then the likeliest others: woods growing nearby, everyday
    // materials (cobblestone, not blackstone). Interchangeable variants beyond that aren't worth the scans.
    const ings = (r: Recipe) => r.delta.filter((d) => d.count < 0).map((d) => nameOf(bot, d.id));
    const holds = (r: Recipe) => ings(r).filter((n) => count(bot, n) > 0).length;
    const woods = all.length > 3 ? scan.nearbyWoods() : new Set<string>();
    const score = (r: Recipe) => {
      const names = ings(r);
      const wood = names.map(woodOf).filter((w): w is string => w !== null);
      return (wood.length > 0 && wood.every((w) => woods.has(w)) ? 10 : 0) + names.filter((n) => EVERYDAY_MATERIALS.has(n)).length;
    };
    const ranked = [...all].sort((a, b) => holds(b) - holds(a) || score(b) - score(a));
    const held = ranked.filter((r) => holds(r) > 0);
    const recipes = [...held, ...ranked.filter((r) => holds(r) === 0).slice(0, held.length > 0 ? 1 : EXTRA_VARIANTS)];
    for (const r of recipes) {
      const kids: { name: string; r: Planned }[] = [];
      let cost = 1;
      for (const d of r.delta) {
        if (d.count >= 0) continue;
        const ing = nameOf(bot, d.id);
        // Made of what we're after (nuggets cut from the ingots we want more of): a way round, never to more of it,
        // even with some in hand.
        if (next.includes(ing)) {
          tainted = true;
          cost = INF;
          break;
        }
        if (count(bot, ing) >= -d.count) continue;
        const ri = await route(p, ing, next);
        kids.push({ name: ing, r: ri });
        cost += ri.cost;
        if (!Number.isFinite(cost)) break;
      }
      if (Number.isFinite(cost) && r.requiresTable && !hasStation(bot, scan, 'crafting_table')) {
        const rt = await route(p, 'crafting_table', next);
        kids.push({ name: 'crafting_table', r: rt });
        cost += rt.cost;
      }
      const d = deepen(kids);
      options.push({ kind: 'craft', cost, height: d.height, deepest: d.deepest, recipe: r });
    }
  }

  if (scan.drops(item).length > 0 && (!STORAGE_BLOCK.test(item) || scan.sample(item))) {
    const tool = toolNeeded(bot, scan, item);
    const seen = scan.sample(item);
    const ground = scan.drops(item).some((id) => isInferable(bot.registry.blocks[id]?.name ?? ''));
    let cost = 1 + (seen ? 0 : ground ? NOT_NEARBY_COST : UNSEEN_RARE_COST);
    const kids: { name: string; r: Planned }[] = [];
    if (tool) {
      const rt = await route(p, tool, next);
      kids.push({ name: tool, r: rt });
      cost += rt.cost;
    }
    const d = deepen(kids);
    options.push({ kind: 'gather', cost, height: d.height, deepest: d.deepest, tool });
  }

  const best = options.filter((o) => Number.isFinite(o.cost)).sort((a, b) => a.cost - b.cost || a.height - b.height)[0];
  const result: Planned = best ? { ...best, tainted } : { kind: 'none', cost: INF, height: 0, why: options.length === 0 ? 'unknown' : 'blocked', tainted };
  if (!tainted) p.memo.set(item, result);
  return result;
}

/** One planning pass from the current inventory (diagnostics and tests). */
export async function planObtain(bot: Bot, item: string, knowsRecipe: (item: string) => boolean = () => true): Promise<{ kind: Route['kind']; cost: number; height: number; deepest?: string }> {
  const r = await route({ bot, knowsRecipe, scan: new WorldScan(bot), memo: new Map(), lastYield: Date.now() }, item, []);
  return { kind: r.kind, cost: r.cost, height: r.height, deepest: r.deepest };
}

async function acquire(ctx: SkillContext, scan: WorldScan, item: string, qty: number, depth: number, stack: readonly string[]): Promise<void> {
  throwIfAborted(ctx.signal);
  const { bot } = ctx;
  if (count(bot, item) >= qty) return;
  if (stack.includes(item)) throw new ObtainError(`going in circles over ${item}`);
  const r = await route({ bot, knowsRecipe: ctx.knowsRecipe, scan, memo: new Map(), lastYield: Date.now() }, item, stack);
  const limit = ctx.planDepth - depth;
  if (r.kind !== 'none' && r.height > limit) {
    const first = depth === 0 ? r.deepest : (stack[1] ?? r.deepest);
    throw new ObtainError(`that's too many steps to work out at once${first ? `; get ${first} first` : ''}`, first);
  }
  const next = [...stack, item];
  switch (r.kind) {
    case 'have':
      return;
    case 'none': {
      if (r.why === 'unknown' && bot.registry.itemsByName[item] && !ctx.knowsRecipe(item)) throw new ObtainError(`I don't know how to make ${item}`);
      throw new ObtainError(`I don't know how to get ${item}`);
    }
    case 'gather': {
      if (r.tool) await acquire(ctx, scan, r.tool, 1, depth + 1, next);
      ctx.progress(`obtain: gathering ${item}`);
      const res = await gather.run(ctx, { item, qty: qty - count(bot, item), maxDistance: 64 });
      scan.forget();
      if (!res.ok) throw new ObtainError(res.error ?? `could not gather ${item}`);
      return;
    }
    case 'smelt': {
      let need = qty - count(bot, item);
      // Get more to cook if there's a way; otherwise cook what we carry.
      try {
        await acquire(ctx, scan, r.input, need, depth + 1, next);
      } catch (err) {
        if (err instanceof SkillAbortedError || count(bot, r.input) === 0) throw err;
        need = count(bot, r.input);
      }
      if (!hasStation(bot, scan, 'furnace')) await acquire(ctx, scan, 'furnace', 1, depth + 1, next);
      if (!hasFuel(bot)) await acquire(ctx, scan, 'log', 1, depth + 1, next);
      const raw = bot.inventory.items().find((i) => itemMatcher(r.input, isFoodName(bot)).matches(i.name))?.name ?? r.input;
      ctx.progress(`obtain: smelting ${raw}`);
      const res = await smelt.run(ctx, { item: raw, qty: need });
      scan.forget();
      if (!res.ok) throw new ObtainError(res.error ?? `could not smelt ${raw}`);
      return;
    }
    case 'craft': {
      const need = qty - count(bot, item);
      const times = Math.ceil(need / Math.max(1, r.recipe.result.count));
      const ingredients = r.recipe.delta.filter((d) => d.count < 0).map((d) => ({ name: nameOf(bot, d.id), n: -d.count * times }));
      // Later steps can eat earlier ones (sticks use the planks the pickaxe needs; the table uses planks too),
      // so re-check everything until it all holds at once.
      for (let pass = 0; pass < 3; pass++) {
        for (const ing of ingredients) await acquire(ctx, scan, ing.name, ing.n, depth + 1, next);
        if (r.recipe.requiresTable && !hasStation(bot, scan, 'crafting_table')) await acquire(ctx, scan, 'crafting_table', 1, depth + 1, next);
        if (ingredients.every((ing) => count(bot, ing.name) >= ing.n) && (!r.recipe.requiresTable || hasStation(bot, scan, 'crafting_table'))) break;
      }
      ctx.progress(`obtain: crafting ${item}`);
      const res = await craft.run(ctx, { item, qty: need });
      scan.forget();
      if (!res.ok) throw new ObtainError(res.error ?? `could not craft ${item}`);
      return;
    }
  }
}

function resolveTarget(bot: Bot, raw: string): string {
  const n = normalizeItemName(raw);
  if (CATEGORIES[n]) return n === 'planks' ? (resolveCraftTarget(bot, 'planks') ?? 'oak_planks') : n;
  return resolveCraftTarget(bot, raw) ?? n;
}

export const obtain = defineSkill({
  name: 'obtain',
  description: 'obtain {item, qty} — get an item any way you know: gather, mine, craft or smelt, including the tools and ingredients it needs',
  argsSchema: z.object({ item: z.string().min(1), qty: z.coerce.number().int().min(1).max(64).default(1) }),
  talkOverable: true,
  slipKinds: ['path'],
  expect: (args, _before, bot) => ({ kind: 'inventoryHas', item: resolveTarget(bot, args.item), atLeast: args.qty }),
  async run(ctx, args) {
    const target = resolveTarget(ctx.bot, args.item);
    try {
      await acquire(ctx, WorldScan.for(ctx.bot), target, args.qty, 0, []);
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      if (err instanceof ObtainError) {
        return { ok: false, observed: `holding ${count(ctx.bot, target)} ${target}`, error: err.message, data: err.needFirst ? { needFirst: err.needFirst } : undefined };
      }
      return { ok: false, observed: `holding ${count(ctx.bot, target)} ${target}`, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, observed: `holding ${count(ctx.bot, target)} ${target}` };
  },
});
