// Item knowledge used by code (no LLM): gear tiers for perceived power (§17.4) and armor/weapon choice,
// plus fuzzy item-name resolution so the CC can say "logs" or "Oak Logs".

const MATERIAL_TIER: Readonly<Record<string, number>> = {
  leather: 1,
  wooden: 1,
  golden: 1.5,
  copper: 1.75,
  stone: 2,
  chainmail: 2.25,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet';

const ARMOR_SUFFIX: Readonly<Record<string, ArmorSlot>> = {
  helmet: 'head',
  chestplate: 'torso',
  leggings: 'legs',
  boots: 'feet',
};

export function armorSlotOf(itemName: string): ArmorSlot | null {
  if (itemName === 'turtle_helmet') return 'head';
  if (itemName === 'elytra') return 'torso';
  const m = /_(helmet|chestplate|leggings|boots)$/.exec(itemName);
  return m?.[1] ? (ARMOR_SUFFIX[m[1]] ?? null) : null;
}

export function materialTier(itemName: string): number {
  const mat = itemName.split('_')[0] ?? '';
  return MATERIAL_TIER[mat] ?? (itemName === 'turtle_helmet' ? 2 : 0);
}

export function armorTier(itemName: string): number {
  if (!armorSlotOf(itemName) || itemName === 'elytra') return 0;
  return materialTier(itemName);
}

/** Melee usefulness; swords and axes by material, plus a few specials. */
export function weaponTier(itemName: string | null | undefined): number {
  if (!itemName) return 0;
  if (itemName === 'trident' || itemName === 'mace') return 4;
  if (itemName === 'bow' || itemName === 'crossbow') return 2.5;
  if (itemName.endsWith('_sword')) return materialTier(itemName) + 0.25;
  if (itemName.endsWith('_axe')) return materialTier(itemName);
  if (/_(pickaxe|shovel|hoe)$/.test(itemName)) return Math.max(0.5, materialTier(itemName) - 1);
  return 0;
}

export function isWeapon(itemName: string): boolean {
  return weaponTier(itemName) >= 1 && (itemName.endsWith('_sword') || itemName.endsWith('_axe') || itemName === 'trident' || itemName === 'mace');
}

/**
 * Visible-gear score in 0..1 (§17.4): mean armor tier over 4 slots plus weapon tier, normalized by netherite.
 */
export function gearScore(armor: readonly string[], held: string | null | undefined): number {
  const slots: Partial<Record<ArmorSlot, number>> = {};
  for (const a of armor) {
    const s = armorSlotOf(a);
    if (s) slots[s] = Math.max(slots[s] ?? 0, armorTier(a));
  }
  const armorMean = ((slots.head ?? 0) + (slots.torso ?? 0) + (slots.legs ?? 0) + (slots.feet ?? 0)) / 4;
  return Math.min(1, (armorMean * 0.65 + weaponTier(held) * 0.35) / 5);
}

/** What can be eaten, raw or cooked. */
export const EDIBLE = /^(bread|apple|golden_apple|cooked_\w+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|carrot|golden_carrot|baked_potato|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|mushroom_stew|rabbit_stew|beetroot_soup|dried_kelp)$/;

const SYNONYMS: Readonly<Record<string, string>> = {
  wood: 'log',
  logs: 'log',
  log: 'log',
  plank: 'planks',
  planks: 'planks',
  wood_planks: 'planks',
  cobble: 'cobblestone',
  rock: 'cobblestone',
  rocks: 'cobblestone',
  stones: 'cobblestone',
  stick: 'stick',
  sticks: 'stick',
  iron: 'raw_iron',
  iron_ore: 'raw_iron',
  gold: 'raw_gold',
  copper: 'raw_copper',
  diamonds: 'diamond',
  coal_ore: 'coal',
  food: 'food',
  meat: 'food',
  table: 'crafting_table',
  workbench: 'crafting_table',
  bed: 'bed',
  torches: 'torch',
  wool: 'wool',
  seeds: 'wheat_seeds',
  flower: 'flower',
  flowers: 'flower',
  // Raw meat as players say it; the game's own name is the plain one ("eat raw_porkchop" found none, starving).
  raw_beef: 'beef',
  steak: 'cooked_beef',
  raw_porkchop: 'porkchop',
  raw_pork: 'porkchop',
  pork: 'porkchop',
  raw_chicken: 'chicken',
  raw_mutton: 'mutton',
  raw_rabbit: 'rabbit',
  raw_cod: 'cod',
  raw_salmon: 'salmon',
  // "Fish" as players say it: cod or salmon ("obtain fish" was told there is no item called fish).
  fish: 'fish',
  raw_fish: 'fish',
  cooked_fish: 'cooked_fish',
};

/**
 * Item names whose last word is plural in the game itself (iron_leggings, shears, wheat_seeds, oak_leaves): a plural
 * there is the name, not many of something, and stays as it is.
 */
const PLURAL_NAME = /(leggings|boots|shears|leaves|seeds|planks|bricks|stairs|bars|glass|moss|grass|beans|berries|roots|petals|sprouts|vines|_on_a_stick|sherds|tiles|_slabs?_?$)$/;

/** Normalizes "Oak Logs", "minecraft:oak_log", "oak log" → "oak_log"; "wood"/"logs" → "log" (a category). */
export function normalizeItemName(raw: string): string {
  let n = raw.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
  const direct = SYNONYMS[n];
  if (direct) return direct;
  // Said in the singular, a thing the game only names in the plural: "an oak plank" is of oak_planks (asked to place
  // "oak_plank" three times at 2 health, an agent was told each time it had none, 55 oak planks in its pockets).
  if (/^plank$/.test(n)) return 'planks';
  if (/_(plank|stair|legging|boot|bar)$/.test(n) || /_seed$/.test(n)) return `${n}s`;
  if (/_leaf$/.test(n)) return n.replace(/_leaf$/, '_leaves');
  if (PLURAL_NAME.test(n)) return n;
  if (n.endsWith('es') && SYNONYMS[n.slice(0, -2)]) return SYNONYMS[n.slice(0, -2)] ?? n;
  // "potatoes", "tomatoes": one potato.
  if (/oes$/.test(n)) return n.slice(0, -2);
  if (n.endsWith('s') && !n.endsWith('ss')) {
    const singular = n.slice(0, -1);
    n = SYNONYMS[singular] ?? singular;
  }
  return n;
}

/** Category names that match a family of items/blocks. */
export const CATEGORIES: Readonly<Record<string, (name: string) => boolean>> = {
  fish: (n) => n === 'cod' || n === 'salmon',
  cooked_fish: (n) => n === 'cooked_cod' || n === 'cooked_salmon',
  log: (n) => /_(log|stem)$/.test(n) && !n.startsWith('stripped_'),
  planks: (n) => n.endsWith('_planks'),
  wool: (n) => n.endsWith('_wool'),
  bed: (n) => n.endsWith('_bed'),
  flower: (n) =>
    ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley'].includes(n) ||
    n.endsWith('_tulip'),
  leaves: (n) => n.endsWith('_leaves'),
  sapling: (n) => n.endsWith('_sapling'),
  /** A sign to stand on the ground or hang on a wall (not the hanging kind). */
  sign: (n) => n.endsWith('_sign') && !n.endsWith('_hanging_sign'),
};

export interface ItemMatcher {
  label: string;
  matches(name: string): boolean;
}

/**
 * Normalizes a block name: case, namespace, spaces and plurals only. Item synonyms ("iron_ore" → "raw_iron")
 * must not apply here: a block is named for what it is, not for what it drops.
 */
export function normalizeBlockName(raw: string): string {
  let n = raw.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
  if (n === 'logs' || n === 'wood') return 'log';
  if (n.endsWith('s') && !n.endsWith('ss') && n !== 'glass' && !n.endsWith('_planks') && n !== 'planks' && !n.endsWith('_leaves')) n = n.slice(0, -1);
  return n;
}

export function blockMatcher(raw: string): ItemMatcher {
  const n = normalizeBlockName(raw);
  const cat = CATEGORIES[n];
  if (cat) return { label: n, matches: cat };
  // An ore is the same ore in stone or in deepslate, as a player says it ("mine iron_ore" found none, looking at
  // deepslate_iron_ore at y -4).
  const ore = /^(?:deepslate_)?(\w+_ore)$/.exec(n)?.[1];
  if (ore) return { label: n, matches: (x) => x === ore || x === `deepslate_${ore}` };
  return { label: n, matches: (x) => x === n };
}

export function itemMatcher(raw: string, isFood: (name: string) => boolean = () => false): ItemMatcher {
  const n = normalizeItemName(raw);
  if (n === 'food') return { label: 'food', matches: isFood };
  const cat = CATEGORIES[n];
  if (cat) return { label: n, matches: cat };
  return { label: n, matches: (x) => x === n };
}

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
