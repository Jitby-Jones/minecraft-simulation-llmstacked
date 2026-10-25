// `obtain {item, qty}`: a code planner over the verified skills (§13 rule 2, code before LLM). It works out how to
// get an item (gather, mine, craft or smelt), including the tools, stations and ingredients that needs, and runs
// the steps, checking the real inventory after each one. How many prerequisite levels it can plan through is the
// agent's planning horizon (§21.1): a sharp agent plans "stone pickaxe" in one go; a slower one is told which
// prerequisite to get first and works up to it. The CC decides *what*; this decides *how*.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { countItem, wearOfEach } from '../inventory';
import { CATEGORIES, SMELTS, itemMatcher, normalizeItemName } from '../items';
import { findKnownBlocks, isInferable } from '../sightings';
import { blockIdsDropping, canSee, isHostile } from '../world';
import { craft, noSuchItem, resolveCraftTarget, smelt } from './crafting';
import { gather, isFoodName, pickup } from './gathering';
import { attack } from './combat';
import { shearSheep, woollySheep } from './hands';
import { ANIMALS, hunt } from './village';
import { defineSkill, type SkillContext, SkillAbortedError, type SkillResult } from './types';
import { throwIfAborted, waitMs } from './util';

/** Furnace outputs the planner knows (items.ts). */
export { SMELTS };

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
  /** Wool off sheep in sight: shears, and the sheep live and grow it back (owner request, 2026-10-24). */
  | { kind: 'shear'; cost: number; height: number; colour: string | null }
  /** A creature in sight that drops it when killed (leather from a cow, string from a spider). */
  | { kind: 'mob'; cost: number; height: number; mob: string; passive: boolean }
  | { kind: 'none'; cost: number; height: number; why: 'circular' | 'unknown' | 'blocked' };

/** A route plus the prerequisite that made it as deep as it is (to name "get X first"). */
type Planned = Route & { deepest?: string; tainted?: boolean };

/**
 * How many prerequisite levels an agent plans through in one go. Everyone here is a long-time player (owner request,
 * 2026-10-24: "we expect them to be familiar with all minecraft mechanics"): an iron pickaxe from nothing is six levels
 * deep, which all but the slowest see at once; only very long chains are taken a part at a time.
 */
export function planDepthFor(intelligence: number): number {
  return 5 + Math.round(4 * Math.min(1, Math.max(0, intelligence)));
}

function nice(item: string): string {
  return item.replace(/_/g, ' ');
}

function count(bot: Bot, item: string): number {
  return countItem(bot, itemMatcher(item, isFoodName(bot)));
}

function nameOf(bot: Bot, id: number): string {
  return bot.registry.items[id]?.name ?? `item#${id}`;
}

/** Something to burn other than what is being cooked (charcoal is made of logs, so its logs are no fuel). */
function hasFuel(bot: Bot, cooking?: string): boolean {
  const cooked = cooking ? itemMatcher(cooking) : null;
  return bot.inventory
    .items()
    .some((i) => !cooked?.matches(i.name) && (FUEL.includes(i.name) || CATEGORIES.log?.(i.name) === true || CATEGORIES.planks?.(i.name) === true));
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
    if (!hasFuel(bot, input)) {
      const planks = resolveTarget(bot, 'planks');
      kids.push({ name: planks, r: await route(p, planks, next) });
    }
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

  // Wool off a sheep in sight that still has it (of that colour): shears, and the sheep lives.
  const colour = /_wool$/.test(item) ? item.replace(/_wool$/, '') : null;
  if (colour !== null && woollySheep(bot, item === 'wool' ? null : colour).length > 0) {
    const kids = count(bot, 'shears') > 0 ? [] : [{ name: 'shears', r: await route(p, 'shears', next) }];
    const d = deepen(kids);
    options.push({ kind: 'shear', cost: 2 + kids.reduce((a, k) => a + k.r.cost, 0), height: d.height, deepest: d.deepest, colour });
  }
  // A creature in sight that drops it.
  const mob = mobDropping(bot, item);
  if (mob) options.push({ kind: 'mob', cost: mob.passive ? 4 : 14, height: 0, mob: mob.name, passive: mob.passive });

  const best = options.filter((o) => Number.isFinite(o.cost)).sort((a, b) => a.cost - b.cost || a.height - b.height)[0];
  const result: Planned = best ? { ...best, tainted } : { kind: 'none', cost: INF, height: 0, why: options.length === 0 ? 'unknown' : 'blocked', tainted };
  if (!tainted) p.memo.set(item, result);
  return result;
}

/** The nearest creature in sight that drops `item` when killed (by the game's loot data), and whether it is an animal. */
function mobDropping(bot: Bot, item: string): { name: string; passive: boolean } | null {
  const loot = (bot.registry as unknown as { entityLoot?: Record<string, { drops: { item: string; dropChance: number }[] } | undefined> }).entityLoot ?? {};
  const kinds = new Set(Object.entries(loot).filter(([m, l]) => m !== 'player' && l?.drops.some((d) => d.item === item && d.dropChance >= 0.2)).map(([m]) => m));
  if (kinds.size === 0) return null;
  const e = bot.nearestEntity((x) => x !== bot.entity && kinds.has(x.name ?? '') && x.position.distanceTo(bot.entity.position) <= 32 && canSee(bot, x, 33));
  if (!e?.name) return null;
  return { name: e.name, passive: !isHostile(e) };
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
      if (!bot.registry.itemsByName[item] && !CATEGORIES[item]) throw new ObtainError(noSuchItem(bot, item));
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
      if (!hasFuel(bot, r.input)) {
        // Planks to burn (a log makes four, each lasting as long as the log); made of what was to be cooked if
        // need be, which is then topped up.
        await acquire(ctx, scan, resolveTarget(bot, 'planks'), Math.ceil(need / 1.5), depth + 1, next);
        if (count(bot, r.input) < need) {
          try {
            await acquire(ctx, scan, r.input, need, depth + 1, next);
          } catch (err) {
            if (err instanceof SkillAbortedError || count(bot, r.input) === 0) throw err;
            need = count(bot, r.input);
          }
        }
      }
      const raw = bot.inventory.items().find((i) => itemMatcher(r.input, isFoodName(bot)).matches(i.name))?.name ?? r.input;
      ctx.progress(`obtain: smelting ${raw}`);
      const res = await smelt.run(ctx, { item: raw, qty: need });
      scan.forget();
      if (!res.ok) throw new ObtainError(res.error ?? `could not smelt ${raw}`);
      return;
    }
    case 'shear': {
      if (count(bot, 'shears') === 0) await acquire(ctx, scan, 'shears', 1, depth + 1, next);
      ctx.progress(`obtain: shearing sheep for ${item}`);
      const sheared = await shearSheep(ctx, item === 'wool' ? null : r.colour, () => count(bot, item) >= qty);
      // Wool lands a moment after it pops off: one more look for it.
      if (sheared > 0 && count(bot, item) < qty) {
        await waitMs(ctx, 800);
        await pickup.run(ctx, { item, radius: 12 });
      }
      scan.forget();
      if (count(bot, item) < qty) throw new ObtainError(sheared === 0 ? `no sheep with ${nice(item)} to shear in reach` : `sheared ${sheared} sheep; still short of ${qty} ${item}`);
      return;
    }
    case 'mob': {
      const need = qty - count(bot, item);
      ctx.progress(`obtain: killing ${r.mob} for ${item}`);
      const res = r.passive && (ANIMALS as readonly string[]).includes(r.mob) ? await hunt.run(ctx, { animal: r.mob as (typeof ANIMALS)[number], qty: Math.min(16, need) }) : await attack.run(ctx, { target: r.mob, seconds: 45 });
      if (!r.passive || !(ANIMALS as readonly string[]).includes(r.mob)) await pickup.run(ctx, { item, radius: 8 });
      scan.forget();
      if (count(bot, item) < qty) throw new ObtainError(res.ok ? `killed ${r.mob} but still short of ${qty} ${item}` : (res.error ?? `could not kill a ${r.mob}`));
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

/** Kinds of thing that are found as they come (any log, any flower), not made in one kind. */
const FOUND_KINDS = new Set(['log', 'flower', 'leaves', 'sapling']);

/** Planks said plainly: any wood's, as a hut takes them and a player builds with what the logs on hand make. */
const isAnyPlanks = (raw: string): boolean => normalizeItemName(raw) === 'planks';

function planksHeld(bot: Bot): number {
  return countItem(bot, itemMatcher('planks'));
}

/** The planks a log is cut into (oak_log, stripped_oak_wood: oak_planks; crimson_stem: crimson_planks). */
function plankOf(bot: Bot, log: string): string | null {
  const p = `${log.replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae)$/, '')}_planks`;
  return bot.registry.itemsByName[p] ? p : null;
}

/** The logs carried cut into planks, the kind there is most of first, until `qty` planks of any wood are held. */
async function cutLogs(ctx: SkillContext, qty: number): Promise<void> {
  const { bot } = ctx;
  const logs = new Map<string, number>();
  for (const i of bot.inventory.items()) if (CATEGORIES.log?.(i.name)) logs.set(i.name, (logs.get(i.name) ?? 0) + i.count);
  for (const [log, n] of [...logs].sort((a, b) => b[1] - a[1])) {
    const short = qty - planksHeld(bot);
    if (short <= 0) return;
    const planks = plankOf(bot, log);
    if (!planks) continue;
    const want = Math.min(n, Math.ceil(short / 4)) * 4;
    // A craft at a time makes at most a stack.
    for (let made = 0; made < want; made += 64) {
      const res = await craft.run(ctx, { item: planks, qty: Math.min(64, want - made) });
      if (!res.ok) throw new ObtainError(res.error ?? `could not cut ${log} into planks`);
    }
  }
}

/**
 * Planks of any wood: those carried, then those the logs on hand make, then logs of any tree for the rest. Asked for 42
 * with 8 oak and 5 birch logs on hand, the hands made it birch (the first logs in the bag), went for more birch up a
 * cliff they could not reach, and ran out of time four times over eight minutes.
 */
async function anyPlanks(ctx: SkillContext, qty: number): Promise<SkillResult> {
  const { bot } = ctx;
  const had = planksHeld(bot);
  if (had >= qty) return { ok: true, observed: `already holding ${had} planks: qty is how many in all, so that covers the ${qty} asked for (for more, ask for the total)` };
  try {
    await cutLogs(ctx, qty);
    const short = qty - planksHeld(bot);
    if (short > 0) {
      await acquire(ctx, WorldScan.for(bot), 'log', count(bot, 'log') + Math.ceil(short / 4), 0, []);
      await cutLogs(ctx, qty);
    }
  } catch (err) {
    if (err instanceof SkillAbortedError) throw err;
    return { ok: false, observed: `holding ${planksHeld(bot)} planks`, error: err instanceof Error ? err.message : String(err) };
  }
  const held = planksHeld(bot);
  return held >= qty ? { ok: true, observed: `holding ${held} planks` } : { ok: false, observed: `holding ${held} planks`, error: `made only ${held} of the ${qty} planks` };
}

function resolveTarget(bot: Bot, raw: string): string {
  const n = normalizeItemName(raw);
  if (CATEGORIES[n] && FOUND_KINDS.has(n)) return n;
  return resolveCraftTarget(bot, raw) ?? n;
}

export const obtain = defineSkill({
  name: 'obtain',
  description: 'obtain {item, qty} — have qty of an item in all (what you hold counts): get it any way you know: gather, mine, craft or smelt, including the tools and ingredients it needs',
  argsSchema: z.object({ item: z.string().min(1), qty: z.coerce.number().int().min(1).max(256).default(1) }),
  talkOverable: true,
  slipKinds: ['path'],
  expect: (args, _before, bot) => ({ kind: 'inventoryHas', item: isAnyPlanks(args.item) ? 'planks' : resolveTarget(bot, args.item), atLeast: args.qty }),
  async run(ctx, args) {
    if (isAnyPlanks(args.item)) return anyPlanks(ctx, args.qty);
    const target = resolveTarget(ctx.bot, args.item);
    // Asked for what is already held, it says so: "holding 2 iron_ingot" for one more asked as {qty: 1} three times
    // over taught an agent that obtain "doesn't conjure a third ingot".
    const had = count(ctx.bot, target);
    if (had >= args.qty) {
      // A tool's wear with it: "holding 2 stone_pickaxe" for fresh ones, both nearly worn through, was no news.
      const wear = wearOfEach(ctx.bot, target);
      const worn = wear.some((l) => l < 0.5) ? ` (wear left: ${wear.map((l) => `${Math.round(l * 100)}%`).join(', ')})` : '';
      return { ok: true, observed: `already holding ${had} ${target}${worn}: qty is how many in all, so that covers the ${args.qty} asked for (for more, ask for the total)` };
    }
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
