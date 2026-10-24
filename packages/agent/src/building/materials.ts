// What a building takes (owner request, 2026-10-24): its bill of materials, how hard each is to come by, a similar
// looking block for one too hard to get (stone bricks become cobblestone, glass a fence of the house's wood), and the
// crafting steps from what is gathered to what is placed (doors, fences, glass, stairs), so a builder can follow them
// and ask others for the raw materials. Worked out from the game's recipes (minecraft-data), not by a model.

import minecraftData from 'minecraft-data';
import { type Blueprint } from './compile';
import { formatState, itemFor, parseState, secondHalf } from './state';

type Data = ReturnType<typeof minecraftData>;
let cached: Data | null = null;
/** The game's data for the version the server runs (recipes, blocks, items). */
export function gameData(version = '26.1.2'): Data {
  cached ??= minecraftData(version);
  return cached;
}

/** Items to place, one per block (a door's top and a bed's head come with the first half). */
export function billOf(bp: Pick<Blueprint, 'blocks'>): Map<string, number> {
  const bill = new Map<string, number>();
  const add = (item: string, n = 1) => bill.set(item, (bill.get(item) ?? 0) + n);
  for (const b of bp.blocks) {
    const s = parseState(b.state);
    if (secondHalf(s)) continue;
    if (s.name.endsWith('_slab') && s.props.type === 'double') add(s.name, 2);
    else if (s.name.startsWith('potted_')) {
      add('flower_pot');
      add(s.name.replace(/^potted_/, ''));
    } else add(itemFor(s.name));
  }
  return bill;
}

/**
 * How hard one of each raw material is to come by, in rough minutes of a player's time: trees and stone are at hand,
 * ore is dug for, some things are found only in other places (sand by water or in deserts), and some can't be had
 * without what nobody has early on (silk touch for ice, the Nether for quartz).
 */
const RAW: Readonly<Record<string, number>> = {
  log: 0.5,
  cobblestone: 0.3,
  sandstone: 0.5,
  red_sandstone: 1.5,
  cobbled_deepslate: 0.6,
  dirt: 0.2,
  gravel: 0.3,
  sand: 0.4,
  red_sand: 1.5,
  andesite: 0.4,
  diorite: 0.5,
  granite: 0.5,
  tuff: 1,
  calcite: 3,
  clay_ball: 0.6,
  coal: 1,
  charcoal: 0.8,
  raw_iron: 3,
  raw_copper: 2,
  raw_gold: 6,
  diamond: 30,
  emerald: 30,
  lapis_lazuli: 3,
  redstone: 2,
  quartz: 25,
  obsidian: 15,
  white_wool: 1.5,
  string: 1.5,
  leather: 2,
  feather: 1,
  sugar_cane: 0.5,
  wheat: 0.5,
  wheat_seeds: 0.2,
  bamboo: 0.5,
  snowball: 0.2,
  ice: 60,
  packed_ice: 80,
  blue_ice: 100,
  netherrack: 25,
  blackstone: 30,
  basalt: 30,
  end_stone: 120,
  purpur_block: 150,
  prismarine_shard: 60,
  terracotta: 3,
  moss_block: 6,
  mud: 1,
  ink_sac: 2,
  bone_meal: 1,
  slime_ball: 8,
  honeycomb: 6,
  amethyst_shard: 10,
  copper_ingot: 2,
  flower: 0.5,
};
const WOODS = ['pale_oak', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'spruce', 'birch', 'jungle', 'acacia', 'oak'];
const NETHER_WOOD = /^(crimson|warped)_/;
const FLOWERS = /^(poppy|dandelion|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_sapling|fern|dead_bush|cactus|bamboo|.*_mushroom)$/;
const SMELTED: Readonly<Record<string, string>> = {
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  smooth_sandstone: 'sandstone',
  smooth_red_sandstone: 'red_sandstone',
  cracked_stone_bricks: 'stone_bricks',
  deepslate: 'cobbled_deepslate',
  brick: 'clay_ball',
  terracotta: 'clay',
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  charcoal: 'log',
  smooth_quartz: 'quartz_block',
};

/** The raw material an item is found as (a log of any wood is a log), or null if it is made. */
function rawOf(item: string): string | null {
  if (/_(log|stem|wood|hyphae)$/.test(item) && !item.startsWith('stripped_')) return NETHER_WOOD.test(item) ? 'netherrack' : 'log';
  if (item === 'bamboo') return 'bamboo';
  if (FLOWERS.test(item)) return 'flower';
  if (/_wool$/.test(item)) return 'white_wool';
  if (item in RAW) return item;
  return null;
}

export interface Need {
  item: string;
  count: number;
}

export interface Step {
  /** Gathered, crafted, smelted, or stripped (a log with an axe taken to it). */
  how: 'craft' | 'smelt' | 'gather' | 'strip';
  item: string;
  count: number;
  /** Crafting: how many times the recipe is made; smelting: how many go in. */
  times: number;
  from: Need[];
  /** A crafting table needed (more than 2×2). */
  table?: boolean;
}

export interface MaterialsPlan {
  /** What goes into the building itself. */
  bill: Need[];
  /** Raw materials in all, after crafting and smelting. */
  raw: Need[];
  /** In order: gathered first, then each crafted or smelted after what it is made of. */
  steps: Step[];
  /** Rough minutes of a player's time for all of it. */
  effort: number;
  /** Items with no known way to get them (to swap for something else). */
  unknown: string[];
}

interface Recipe {
  result: { id: number; count: number };
  inShape?: (number | null)[][];
  ingredients?: (number | null)[];
}

function ingredientsOf(r: Recipe): Map<number, number> {
  const m = new Map<number, number>();
  const ids = r.inShape ? r.inShape.flat() : (r.ingredients ?? []);
  for (const id of ids) if (id !== null && id !== undefined) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/**
 * The crafting and smelting from raw materials to everything on the bill, the wood of the building preferred where
 * a recipe takes any (a spruce door from spruce planks). `have` is what is in hand already (counted off first).
 */
export function planMaterials(bill: Map<string, number> | Need[], opts: { wood?: string; have?: Map<string, number>; raw?: Readonly<Record<string, number>>; version?: string } = {}): MaterialsPlan {
  const md = gameData(opts.version);
  const cost = costOf({ raw: opts.raw, version: opts.version });
  const want = Array.isArray(bill) ? new Map(bill.map((n) => [n.item, n.count])) : new Map(bill);
  const have = new Map(opts.have ?? []);
  const totals = new Map<string, { how: Step['how']; count: number; times: number; from: Map<string, number>; table: boolean; depth: number }>();
  const unknown = new Set<string>();
  const nameOf = (id: number) => md.items[id]?.name ?? `#${id}`;
  const woodScore = (r: Recipe) => {
    const names = [...ingredientsOf(r).keys()].map(nameOf);
    const w = names.map((n) => WOODS.find((x) => n.startsWith(`${x}_`))).filter((x): x is string => Boolean(x));
    if (w.length === 0) return 0;
    return w.every((x) => x === (opts.wood ?? 'oak')) ? 2 : w.every((x) => !NETHER_WOOD.test(`${x}_`)) ? 1 : -1;
  };
  /** Need `count` more of `item`, at `depth` in the tree (deeper ones are made first). */
  const need = (item: string, count: number, depth: number, stack: string[]) => {
    if (count <= 0) return;
    const held = have.get(item) ?? 0;
    if (held > 0) {
      const used = Math.min(held, count);
      have.set(item, held - used);
      count -= used;
      if (count <= 0) return;
    }
    if (stack.includes(item) || depth > 12) {
      unknown.add(item);
      return;
    }
    const raw = rawOf(item);
    const id = md.itemsByName[item]?.id;
    const recipes = id !== undefined ? ((md.recipes as unknown as Record<number, Recipe[]>)[id] ?? []) : [];
    const smeltFrom = SMELTED[item];
    // Found, not made (a log is not made of planks); smelted when it is something smelted; else crafted.
    if (raw !== null) {
      add(item, 'gather', count, count, new Map(), false, depth);
      return;
    }
    if (smeltFrom) {
      add(item, 'smelt', count, count, new Map([[smeltFrom, count]]), false, depth);
      need(smeltFrom, count, depth + 1, [...stack, item]);
      return;
    }
    const unstripped = /^stripped_/.test(item) ? item.replace(/^stripped_/, '') : null;
    if (unstripped) {
      add(item, 'strip', count, count, new Map([[unstripped, count]]), false, depth);
      need(unstripped, count, depth + 1, [...stack, item]);
      return;
    }
    if (recipes.length === 0) {
      unknown.add(item);
      return;
    }
    // Recipes not made of what we are after (no nuggets from the ingots wanted), the building's wood first.
    const usable = recipes.filter((r) => ![...ingredientsOf(r).keys()].some((i) => [...stack, item].includes(nameOf(i))));
    const recipeCost = (x: Recipe) => [...ingredientsOf(x)].reduce((a, [i, n]) => a + n * cost(nameOf(i)), 0) / x.result.count;
    const r = [...usable].sort((a, b) => woodScore(b) - woodScore(a) || recipeCost(a) - recipeCost(b) || ingredientsOf(a).size - ingredientsOf(b).size)[0];
    if (!r) {
      unknown.add(item);
      return;
    }
    const times = Math.ceil(count / r.result.count);
    const from = new Map<string, number>();
    for (const [i, n] of ingredientsOf(r)) from.set(nameOf(i), n * times);
    const table = r.inShape ? r.inShape.length > 2 || r.inShape.some((row) => row.length > 2) : (r.ingredients?.length ?? 0) > 4;
    add(item, 'craft', times * r.result.count, times, from, table, depth);
    for (const [i, n] of from) need(i, n, depth + 1, [...stack, item]);
  };
  function add(item: string, how: Step['how'], count: number, times: number, from: Map<string, number>, table: boolean, depth: number) {
    const t = totals.get(item);
    if (!t) {
      totals.set(item, { how, count, times, from, table, depth });
      return;
    }
    t.count += count;
    t.times += times;
    t.depth = Math.max(t.depth, depth);
    for (const [k, v] of from) t.from.set(k, (t.from.get(k) ?? 0) + v);
  }
  for (const [item, n] of want) need(item, n, 0, []);
  // Leftovers from crafting in batches are used before making more: planks made for a door also make the stairs.
  const steps: Step[] = [...totals.entries()]
    .sort((a, b) => b[1].depth - a[1].depth || (a[1].how === 'gather' ? -1 : 0) - (b[1].how === 'gather' ? -1 : 0))
    .map(([item, t]) => ({ how: t.how, item, count: t.count, times: t.times, from: [...t.from].map(([i, n]) => ({ item: i, count: n })), ...(t.table ? { table: true } : {}) }));
  const raw = steps.filter((s) => s.how === 'gather').map((s) => ({ item: s.item, count: s.count }));
  const effort = raw.reduce((a, r) => a + (opts.raw?.[rawOf(r.item) ?? r.item] ?? RAW[rawOf(r.item) ?? r.item] ?? 5) * r.count, 0) + steps.filter((s) => s.how !== 'gather').reduce((a, s) => a + 0.05 * s.times, 0);
  return { bill: [...want].map(([item, count]) => ({ item, count })), raw, steps, effort: Math.round(effort), unknown: [...unknown] };
}

/**
 * How hard one of this is to get, in rough minutes of a player's time: a raw material's own, a made thing's share of
 * what it is made of (one stair is a quarter of six planks). `raw` overrides what one raw material takes (sand is
 * dear where nobody has seen any).
 */
export function difficulty(item: string, opts: { raw?: Readonly<Record<string, number>>; version?: string } = {}): number {
  return costOf(opts)(item);
}

/** `difficulty` for many items at once (one memo). */
export function costOf(opts: { raw?: Readonly<Record<string, number>>; version?: string } = {}): (item: string) => number {
  const md = gameData(opts.version);
  const memo = new Map<string, number>();
  const nameOf = (id: number) => md.items[id]?.name ?? `#${id}`;
  const cost = (it: string, stack: string[]): number => {
    const hit = memo.get(it);
    if (hit !== undefined) return hit;
    if (stack.includes(it) || stack.length > 12) return Infinity;
    const raw = rawOf(it);
    let c: number;
    if (raw !== null) c = opts.raw?.[raw] ?? RAW[raw] ?? 5;
    else if (SMELTED[it]) c = cost(SMELTED[it], [...stack, it]) + 0.1;
    else if (/^stripped_/.test(it)) c = cost(it.replace(/^stripped_/, ''), [...stack, it]) + 0.05;
    else {
      const id = md.itemsByName[it]?.id;
      const recipes = id !== undefined ? ((md.recipes as unknown as Record<number, Recipe[]>)[id] ?? []) : [];
      c = Infinity;
      for (const r of recipes) {
        let sum = 0.02;
        for (const [i, n] of ingredientsOf(r)) sum += n * cost(nameOf(i), [...stack, it]);
        c = Math.min(c, sum / r.result.count);
      }
    }
    // A cycle cut short is not the item's true cost: kept for this path only.
    if (Number.isFinite(c) || stack.length === 0) memo.set(it, c);
    return c;
  };
  return (item) => cost(item, []);
}

// --- like for like ---------------------------------------------------------------------------------------------------

/** Blocks that look alike, best match first: one too hard to get is swapped for the first easier one in its group. */
const LOOKALIKES: readonly (readonly string[])[] = [
  ['stone_bricks', 'cracked_stone_bricks', 'mossy_stone_bricks', 'stone', 'smooth_stone', 'cobblestone', 'andesite', 'polished_andesite'],
  ['deepslate_bricks', 'deepslate_tiles', 'polished_deepslate', 'cobbled_deepslate', 'stone_bricks', 'cobblestone'],
  ['mossy_cobblestone', 'cobblestone'],
  ['smooth_sandstone', 'cut_sandstone', 'sandstone', 'chiseled_sandstone', 'birch_planks', 'stripped_birch_log'],
  ['smooth_red_sandstone', 'cut_red_sandstone', 'red_sandstone', 'terracotta', 'acacia_planks'],
  ['bricks', 'mud_bricks', 'granite', 'polished_granite', 'terracotta', 'spruce_planks'],
  ['nether_bricks', 'deepslate_bricks', 'bricks', 'cobbled_deepslate', 'dark_oak_planks'],
  ['quartz_block', 'smooth_quartz', 'quartz_bricks', 'calcite', 'diorite', 'polished_diorite', 'birch_planks', 'white_wool'],
  ['packed_ice', 'blue_ice', 'ice', 'snow_block', 'diorite', 'white_wool'],
  ['blackstone', 'polished_blackstone', 'polished_blackstone_bricks', 'cobbled_deepslate', 'cobblestone'],
  ['prismarine', 'prismarine_bricks', 'dark_prismarine', 'mossy_stone_bricks', 'mossy_cobblestone'],
  ['purpur_block', 'purpur_pillar', 'quartz_block', 'birch_planks'],
  ['end_stone_bricks', 'end_stone', 'sandstone', 'birch_planks'],
  ['hay_block', 'birch_planks'],
  ['glass', 'white_stained_glass', 'oak_fence'],
  ['glass_pane', 'white_stained_glass_pane', 'oak_fence'],
  ['lantern', 'torch'],
  ['soul_lantern', 'lantern', 'torch'],
  ['bookshelf', 'barrel', 'oak_planks'],
  ['iron_door', 'oak_door'],
  ['iron_bars', 'oak_fence'],
  ['iron_trapdoor', 'oak_trapdoor'],
  ['chain', 'oak_fence'],
];
/** Shapes a material comes in, and how the name is made (stone_bricks → stone_brick_stairs). */
const SHAPES = ['stairs', 'slab', 'wall', 'fence_gate', 'fence', 'door', 'trapdoor', 'pressure_plate', 'button', 'wall_sign', 'sign'] as const;

/** Splits "stone_brick_stairs" into its material ("stone_bricks") and shape ("stairs"); a plain block is its own material. */
export function splitShape(name: string, version?: string): { material: string; shape: string | null } {
  const md = gameData(version);
  for (const shape of SHAPES) {
    if (!name.endsWith(`_${shape}`)) continue;
    const stem = name.slice(0, -shape.length - 1);
    for (const m of [`${stem}_planks`, `${stem}s`, stem, `${stem}_block`]) if (md.blocksByName[m]) return { material: m, shape };
  }
  return { material: name, shape: null };
}

/** The material in a shape ("stone_bricks" as stairs: "stone_brick_stairs"), or null if the game has none. */
export function inShape(material: string, shape: string | null, version?: string): string | null {
  const md = gameData(version);
  if (shape === null) return md.blocksByName[material] ? material : null;
  const stem = material.replace(/_planks$/, '').replace(/_block$/, '').replace(/(brick|tile)s$/, '$1');
  for (const c of [`${stem}_${shape}`, `${material}_${shape}`]) if (md.blocksByName[c]) return c;
  return null;
}

/** Woods are interchangeable: the one at hand for the one asked for. */
function swapWood(name: string, wood: string): string {
  const w = WOODS.find((x) => name.startsWith(`${x}_`) || name.startsWith(`stripped_${x}_`));
  return w ? name.replace(w, wood) : name;
}

export interface Substitution {
  from: string;
  to: string;
  why: string;
}

/**
 * A blueprint with each block too hard to get (`tooHard` minutes for one) swapped for the first easier one that looks
 * like it, keeping its shape and its state (stairs stay stairs, facing as they were); the woods swapped for the wood
 * at hand when that is asked for. What was swapped, and why.
 */
export function substitute(
  bp: Blueprint,
  opts: { tooHard?: number; wood?: string; raw?: Readonly<Record<string, number>>; cost?: (item: string) => number; version?: string } = {},
): { blueprint: Blueprint; swaps: Substitution[] } {
  const tooHard = opts.tooHard ?? 10;
  const cost = opts.cost ?? costOf({ raw: opts.raw, version: opts.version });
  const memo = new Map<string, string>();
  const swaps = new Map<string, Substitution>();
  const pick = (name: string): string => {
    const hit = memo.get(name);
    if (hit) return hit;
    let out = opts.wood ? swapWood(name, opts.wood) : name;
    const item = itemFor(out);
    if (cost(item) > tooHard) {
      const { material, shape } = splitShape(out, opts.version);
      const group = LOOKALIKES.find((g) => g.includes(material) || g.includes(out));
      const start = group ? Math.max(0, group.indexOf(group.includes(material) ? material : out)) : 0;
      for (const alt of group?.slice(start + 1) ?? []) {
        const altName = shape ? inShape(opts.wood ? swapWood(alt, opts.wood) : alt, shape, opts.version) : opts.wood ? swapWood(alt, opts.wood) : alt;
        if (altName && cost(itemFor(altName)) <= tooHard) {
          swaps.set(out, { from: out, to: altName, why: `${out.replace(/_/g, ' ')} is hard to get` });
          out = altName;
          break;
        }
      }
    }
    memo.set(name, out);
    return out;
  };
  const blocks = bp.blocks.map((b) => {
    const s = parseState(b.state);
    const name = pick(s.name);
    if (name === s.name) return b;
    // The new block keeps only the state it has (a fence for a pane has no facing).
    const fresh = gameData(opts.version).blocksByName[name];
    const props = Object.fromEntries(Object.entries(s.props).filter(([k]) => fresh?.states?.some((st) => st.name === k) ?? false));
    return { ...b, state: formatState({ name, props }) };
  });
  return { blueprint: { ...bp, blocks }, swaps: [...swaps.values()] };
}
