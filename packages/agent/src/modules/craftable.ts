// What the recipe book shows one could make from what one carries, of what keeps one alive: gear better than what one
// has, a shield, and food cooked or baked (owner request, 2026-10-24: think, don't follow directives). A sense, as the
// game's own recipe book is, never what to make: one agent carried 14 iron ingots, wore no armor and fought with a
// wooden axe; another held 9 ingots in a cave at 8 health. Neither had anything to say a chestplate was there to make.

import type { AgentState, ItemStack } from '@agora/shared';

/** Each piece of armor, its slot's word, and how many of its material it takes. */
const PIECES = [
  { slot: 'chestplate', n: 8 },
  { slot: 'leggings', n: 7 },
  { slot: 'helmet', n: 5 },
  { slot: 'boots', n: 4 },
] as const;
/** Armor materials, the best first: the names' prefix and what the pieces are made of. */
const ARMOR_KINDS = [
  { prefix: 'diamond', from: 'diamond', tier: 5 },
  { prefix: 'iron', from: 'iron_ingot', tier: 4 },
  { prefix: 'copper', from: 'copper_ingot', tier: 2.5 },
  { prefix: 'golden', from: 'gold_ingot', tier: 2 },
  { prefix: 'leather', from: 'leather', tier: 1 },
] as const;
const ARMOR_TIER: Record<string, number> = { leather: 1, turtle: 2, golden: 2, copper: 2.5, chainmail: 3, iron: 4, diamond: 5, netherite: 6 };
/** Sword materials, the best first. */
const SWORD_KINDS = [
  { prefix: 'diamond', from: 'diamond', tier: 4 },
  { prefix: 'iron', from: 'iron_ingot', tier: 3 },
  { prefix: 'copper', from: 'copper_ingot', tier: 2.5 },
  { prefix: 'stone', from: 'cobblestone', tier: 2 },
  { prefix: 'wooden', from: 'planks', tier: 1 },
] as const;
const SWORD_TIER: Record<string, number> = { wooden: 1, golden: 1, stone: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 };
/** What raw food cooks into, in a furnace. */
const COOKS: Record<string, string> = { beef: 'steak', porkchop: 'cooked porkchop', chicken: 'cooked chicken', mutton: 'cooked mutton', rabbit: 'cooked rabbit', cod: 'cooked cod', salmon: 'cooked salmon', potato: 'baked potato' };
const LOG = /_(log|wood|stem|hyphae)$/;
const FUEL = /^(coal|charcoal|coal_block|lava_bucket|blaze_rod)$|_planks$|_(log|wood|stem|hyphae)$/;

function amounts(inv: readonly ItemStack[]): (name: string) => number {
  const of = (test: (n: string) => boolean) => inv.filter((i) => test(i.item)).reduce((a, i) => a + i.qty, 0);
  return (name) => {
    if (name === 'planks') return of((n) => n.endsWith('_planks')) + 4 * of((n) => LOG.test(n));
    if (name === 'cobblestone') return of((n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone');
    return of((n) => n === name);
  };
}

const article = (s: string) => (/(leggings|boots)$/.test(s) ? s : /^[aeiou]/.test(s) ? `an ${s}` : `a ${s}`);
/** Said as counted: "8 iron ingots", "1 diamond"; leather, planks and cobblestone go uncounted. */
const UNCOUNTED = new Set(['leather', 'planks', 'cobblestone']);
const mat = (n: number, from: string) => `${n} ${from.replace(/_/g, ' ')}${UNCOUNTED.has(from) || n === 1 ? '' : 's'}`;

/** The line (null: nothing better to make from what one carries). */
export function craftableNow(s: AgentState, most = 6): string | null {
  const inv = s.self.inventory;
  const have = amounts(inv);
  const owned = [...s.self.armor, ...inv.map((i) => i.item)];
  const tierOf = (names: readonly string[], tiers: Record<string, number>) => Math.max(0, ...names.map((n) => tiers[n.split('_')[0] ?? ''] ?? 0));
  const out: string[] = [];
  // The pieces better than what one has on, each in the best material there is enough of, said by material.
  const pieces = new Map<string, (typeof PIECES)[number][]>();
  for (const p of PIECES) {
    const worn = tierOf(owned.filter((n) => n.endsWith(`_${p.slot}`)), ARMOR_TIER);
    const best = ARMOR_KINDS.find((k) => k.tier > worn && have(k.from) >= p.n);
    if (best) pieces.set(best.prefix, [...(pieces.get(best.prefix) ?? []), p]);
  }
  for (const k of ARMOR_KINDS) {
    const ps = pieces.get(k.prefix);
    if (ps) out.push(`${k.prefix} armor from your ${mat(have(k.from), k.from)} (${ps.map((p, i) => `${article(p.slot)}${i === 0 ? ' takes' : ''} ${p.n}`).join(', ')})`);
  }
  // A sword takes 2 of its material and a stick (2 planks make 4).
  const sword = tierOf(owned.filter((n) => n.endsWith('_sword')), SWORD_TIER);
  const blade = SWORD_KINDS.find((k) => k.tier > sword && have(k.from) >= 2 && (have('stick') >= 1 || have('planks') >= (k.from === 'planks' ? 4 : 2)));
  if (blade) out.push(`${article(`${blade.prefix} sword`)} (${mat(2, blade.from)} and a stick)`);
  if (!owned.includes('shield') && have('iron_ingot') >= 1 && have('planks') >= 6) out.push('a shield (6 planks and an iron ingot)');
  const fuel = inv.some((i) => FUEL.test(i.item));
  for (const [raw, cooked] of Object.entries(COOKS)) if (fuel && have(raw) > 0) out.push(`${cooked} from your ${have(raw)} ${raw} (in a furnace)`);
  if (have('wheat') >= 3) out.push(`bread (3 wheat a loaf; you have ${have('wheat')})`);
  return out.length > 0 ? `From what you carry you could make: ${out.slice(0, most).join(', ')}.` : null;
}
