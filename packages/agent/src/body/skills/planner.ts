// `obtain {item, qty}`: a code planner over the verified skills (§13 rule 2, code before LLM). It works out how to
// get an item (gather, mine, craft or smelt), including the tools, stations and ingredients that needs, and runs
// the steps, checking the real inventory after each one. How many prerequisite levels it can plan through is the
// agent's planning horizon (§21.1): a sharp agent plans "stone pickaxe" in one go; a slower one is told which
// prerequisite to get first and works up to it. The CC decides *what*; this decides *how*.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { countItem } from '../inventory';
import { CATEGORIES, itemMatcher, normalizeItemName } from '../items';
import { blockIdsDropping, findNearestBlocks } from '../world';
import { craft, resolveCraftTarget, smelt } from './crafting';
import { gather, isFoodName, toolNameFor } from './gathering';
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
  | { kind: 'have'; cost: 0 }
  | { kind: 'gather'; cost: number; tool: string | null }
  | { kind: 'craft'; cost: number; recipe: Recipe }
  | { kind: 'smelt'; cost: number; input: string }
  | { kind: 'none'; cost: number; why: string; deepAt?: string[] };

export function planDepthFor(intelligence: number): number {
  return 2 + Math.round(4 * Math.min(1, Math.max(0, intelligence)));
}

function count(bot: Bot, item: string): number {
  return countItem(bot, itemMatcher(item, isFoodName(bot)));
}

function nameOf(bot: Bot, id: number): string {
  return bot.registry.items[id]?.name ?? `item#${id}`;
}

function hasStation(bot: Bot, name: string): boolean {
  const id = bot.registry.blocksByName[name]?.id;
  return count(bot, name) > 0 || (id !== undefined && findNearestBlocks(bot, [id], 24, 1).length > 0);
}

function hasFuel(bot: Bot): boolean {
  return bot.inventory.items().some((i) => FUEL.includes(i.name) || CATEGORIES.log?.(i.name) === true || CATEGORIES.planks?.(i.name) === true);
}

/** The cheapest harvest tool we'd need for the nearest block that drops `item`, or null if hands will do. */
function toolNeeded(bot: Bot, item: string): string | null {
  const ids = blockIdsDropping(bot, itemMatcher(item, isFoodName(bot)));
  const blocks = findNearestBlocks(bot, ids, 32, 6);
  const sample = blocks[0] ?? null;
  if (!sample) {
    const def = ids[0] !== undefined ? bot.registry.blocks[ids[0]] : undefined;
    const tools = (def as unknown as { harvestTools?: Record<string, boolean> } | undefined)?.harvestTools;
    if (!tools) return null;
    return bot.inventory.items().some((i) => tools[String(i.type)]) ? null : (Object.keys(tools).map((k) => nameOf(bot, Number(k))).find((n) => n.startsWith('wooden_')) ?? nameOf(bot, Number(Object.keys(tools)[0])));
  }
  const tools = (sample as unknown as { harvestTools?: Record<string, boolean> }).harvestTools;
  if (!tools || bot.inventory.items().some((i) => tools[String(i.type)])) return null;
  return toolNameFor(bot, sample);
}

interface PlanCtx {
  bot: Bot;
  knowsRecipe: (item: string) => boolean;
  limit: number;
  memo: Map<string, Route>;
}

/** Cheapest way to get one more `item` from here (memoized per call; inventory changes re-plan). */
function route(p: PlanCtx, item: string, depth: number, stack: readonly string[]): Route {
  const { bot } = p;
  if (stack.includes(item)) return { kind: 'none', cost: INF, why: 'circular' };
  if (depth > p.limit) return { kind: 'none', cost: INF, why: 'too deep', deepAt: [...stack, item] };
  const key = `${item}@${depth}`;
  const cached = p.memo.get(key);
  if (cached) return cached;
  const next = [...stack, item];
  const options: Route[] = [];
  let deepest: string[] | undefined;
  const note = (r: Route) => {
    if (r.kind === 'none' && r.deepAt && (!deepest || r.deepAt.length < deepest.length)) deepest = r.deepAt;
  };

  const input = SMELTS[item];
  if (input) {
    const ri = route(p, input, depth + 1, next);
    note(ri);
    const furnace = hasStation(bot, 'furnace') ? 0 : route(p, 'furnace', depth + 1, next);
    const fuel = hasFuel(bot) ? 0 : route(p, 'log', depth + 1, next);
    const parts = [ri.cost, typeof furnace === 'number' ? furnace : furnace.cost, typeof fuel === 'number' ? fuel : fuel.cost];
    if (typeof furnace !== 'number') note(furnace);
    if (typeof fuel !== 'number') note(fuel);
    options.push({ kind: 'smelt', cost: 1 + parts.reduce((a, b) => a + b, 0), input });
  }

  const id = bot.registry.itemsByName[item]?.id;
  if (id !== undefined && p.knowsRecipe(item)) {
    const recipes = bot.recipesAll(id, null, true) as unknown as Recipe[];
    for (const r of recipes) {
      let cost = 1;
      for (const d of r.delta) {
        if (d.count >= 0) continue;
        const ing = nameOf(bot, d.id);
        if (count(bot, ing) >= -d.count) continue;
        const ri = route(p, ing, depth + 1, next);
        note(ri);
        cost += ri.cost;
        if (!Number.isFinite(cost)) break;
      }
      if (Number.isFinite(cost) && r.requiresTable && !hasStation(bot, 'crafting_table')) {
        const rt = route(p, 'crafting_table', depth + 1, next);
        note(rt);
        cost += rt.cost;
      }
      options.push({ kind: 'craft', cost, recipe: r });
    }
  }

  const drops = blockIdsDropping(bot, itemMatcher(item, isFoodName(bot)));
  if (drops.length > 0) {
    const nearby = findNearestBlocks(bot, drops, 32, 1).length > 0;
    const tool = toolNeeded(bot, item);
    let cost = 1 + (nearby ? 0 : NOT_NEARBY_COST);
    if (tool) {
      const rt = route(p, tool, depth + 1, next);
      note(rt);
      cost += rt.cost;
    }
    options.push({ kind: 'gather', cost, tool });
  }

  const best = options.filter((o) => Number.isFinite(o.cost)).sort((a, b) => a.cost - b.cost)[0];
  const result: Route = best ?? { kind: 'none', cost: INF, why: options.length === 0 ? 'unknown' : 'blocked', deepAt: deepest };
  p.memo.set(key, result);
  return result;
}

async function acquire(ctx: SkillContext, item: string, qty: number, depth: number, stack: readonly string[]): Promise<void> {
  throwIfAborted(ctx.signal);
  const { bot } = ctx;
  if (count(bot, item) >= qty) return;
  const plan: PlanCtx = { bot, knowsRecipe: ctx.knowsRecipe, limit: ctx.planDepth - depth, memo: new Map() };
  const r = route(plan, item, 0, []);
  const next = [...stack, item];
  switch (r.kind) {
    case 'have':
      return;
    case 'none': {
      if (r.why === 'too deep') {
        const path = [...stack, ...(r.deepAt ?? [])];
        const first = path.length > 1 ? path[1] : undefined;
        throw new ObtainError(`that's too many steps to work out at once${first ? `; get ${first} first` : ''}`, first);
      }
      if (r.why === 'unknown' && bot.registry.itemsByName[item] && !ctx.knowsRecipe(item)) throw new ObtainError(`I don't know how to make ${item}`);
      throw new ObtainError(`I don't know how to get ${item}`);
    }
    case 'gather': {
      if (r.tool) await acquire(ctx, r.tool, 1, depth + 1, next);
      ctx.progress(`obtain: gathering ${item}`);
      const res = await gather.run(ctx, { item, qty: qty - count(bot, item), maxDistance: 64 });
      if (!res.ok) throw new ObtainError(res.error ?? `could not gather ${item}`);
      return;
    }
    case 'smelt': {
      const need = qty - count(bot, item);
      await acquire(ctx, r.input, need, depth + 1, next);
      if (!hasStation(bot, 'furnace')) await acquire(ctx, 'furnace', 1, depth + 1, next);
      if (!hasFuel(bot)) await acquire(ctx, 'log', 1, depth + 1, next);
      const raw = bot.inventory.items().find((i) => itemMatcher(r.input, isFoodName(bot)).matches(i.name))?.name ?? r.input;
      ctx.progress(`obtain: smelting ${raw}`);
      const res = await smelt.run(ctx, { item: raw, qty: need });
      if (!res.ok) throw new ObtainError(res.error ?? `could not smelt ${raw}`);
      return;
    }
    case 'craft': {
      const need = qty - count(bot, item);
      const times = Math.ceil(need / Math.max(1, r.recipe.result.count));
      for (const d of r.recipe.delta) {
        if (d.count >= 0) continue;
        await acquire(ctx, nameOf(bot, d.id), -d.count * times, depth + 1, next);
      }
      if (r.recipe.requiresTable && !hasStation(bot, 'crafting_table')) await acquire(ctx, 'crafting_table', 1, depth + 1, next);
      ctx.progress(`obtain: crafting ${item}`);
      const res = await craft.run(ctx, { item, qty: need });
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
      await acquire(ctx, target, args.qty, 0, []);
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
