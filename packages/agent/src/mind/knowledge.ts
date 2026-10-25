// Game knowledge (owner request, 2026-10-24: "we expect them to be familiar with all minecraft mechanics"). The research
// behind the redesign found that telling a model it knows the game is not enough: the facts have to be at hand, as a
// player recalls them or looks them up on the wiki. This is that: for any item, the ways a long-time player knows to
// get it (its recipes, what it is smelted from, which blocks drop it and with what tool, which mobs drop it) from the
// game's own data, and a short list of what that data leaves out (shearing, milking, buckets, farming, breeding,
// trading, bartering, where things lie). It is looked up for what matters now and put in the mind's packet.
// Knowledge only: what to do with it is the mind's.

import type { AgentState } from '@agora/shared';
import { SMELTS } from '../body/skills/planner';

/** The parts of the game data this reads (minecraft-data, as `bot.registry`). */
export interface GameData {
  itemsByName: Record<string, { id: number; name: string } | undefined>;
  items: Record<number, { name: string } | undefined>;
  recipes: Record<number, Recipe[] | undefined>;
  blocksByName: Record<string, { name: string; harvestTools?: Record<string, boolean> } | undefined>;
  blockLoot?: Record<string, { drops: { item: string; dropChance: number; stackSizeRange?: (number | null)[]; silkTouch?: boolean; noSilkTouch?: boolean; playerKill?: boolean }[] } | undefined>;
  entityLoot?: Record<string, { drops: { item: string; dropChance: number; stackSizeRange?: (number | null)[]; playerKill?: boolean }[] } | undefined>;
}

interface Recipe {
  inShape?: (number | null)[][];
  ingredients?: (number | null)[];
  result: { id: number; count: number };
}

/** What the game's data doesn't say, said plainly. */
interface Fact {
  gives: RegExp;
  how: string;
}

const FACTS: readonly Fact[] = [
  { gives: /^white_wool$|_wool$/, how: 'shear an adult sheep (shears): 1-3 wool of its colour, and the sheep lives and grows its wool back after eating grass' },
  { gives: /_wool$/, how: 'kill a sheep that still has its wool: 1 wool, and that sheep is gone' },
  { gives: /_wool$|_bed$/, how: 'buy from a shepherd villager for emeralds' },
  { gives: /_bed$/, how: 'village houses have beds to take (break one and pick it up)' },
  { gives: /^string$/, how: 'spiders drop it (out at night, and in caves); cobwebs (in mineshafts) give it when cut with a sword or shears' },
  { gives: /^milk_bucket$/, how: 'use a bucket on a cow, goat or mooshroom' },
  { gives: /^water_bucket$/, how: 'use a bucket on water' },
  { gives: /^lava_bucket$/, how: 'use a bucket on a lava source' },
  { gives: /^obsidian$/, how: 'water poured onto still lava (a source block) turns it to obsidian; it takes a diamond pickaxe to mine (about 9 s a block); ruined portals have some' },
  { gives: /^crying_obsidian$/, how: 'ruined portals; piglins barter it for gold' },
  { gives: /^wheat_seeds$/, how: 'break grass (about 1 in 8 gives seeds); ripe wheat gives seeds back' },
  { gives: /^(wheat|carrot|potato|beetroot|beetroot_seeds)$/, how: 'farm it: a hoe turns dirt or grass into farmland (best within 4 blocks of water), plant the seeds (or a carrot or potato), wait while it grows (several minutes; bone meal hurries it), harvest it when fully grown and plant again' },
  { gives: /^(carrot|potato)$/, how: 'village farms grow them' },
  { gives: /^(melon_slice|pumpkin|melon)$/, how: 'grow from their seeds on farmland, with a free block beside each stem; found wild too' },
  { gives: /^egg$/, how: 'chickens lay one every 5-10 minutes' },
  { gives: /^(beef|leather|porkchop|mutton|chicken|feather|rabbit|rabbit_hide)$/, how: 'breed the animals for a steady supply: feed two adults of a kind their food (cows and sheep: wheat; pigs: carrots, potatoes or beetroot; chickens: any seeds; rabbits: carrots or dandelions) and a baby comes; it grows up in about 20 minutes' },
  { gives: /^bone_meal$/, how: 'craft from bones (skeletons drop them); a composter makes it from plants' },
  { gives: /^ender_pearl$/, how: 'endermen drop them; piglins barter them for gold; cleric villagers sell them' },
  { gives: /^blaze_rod$/, how: 'blazes drop them, in nether fortresses' },
  { gives: /^diamond$/, how: 'diamond ore lies deep: most between y -64 and -54 (best around y -59); it takes an iron pickaxe' },
  { gives: /^raw_iron$/, how: 'iron ore is common in caves and mountains, most around y 16 and high up in mountains; it takes a stone pickaxe' },
  { gives: /^coal$/, how: 'coal ore shows in bare stone, cliffs and caves; any pickaxe' },
  { gives: /^lapis_lazuli$/, how: 'lapis ore is most common around y 0; it takes a stone pickaxe' },
  { gives: /^redstone$/, how: 'redstone ore lies below y 16; it takes an iron pickaxe' },
  { gives: /^raw_gold$/, how: 'gold ore lies below y 32 (higher in badlands); it takes an iron pickaxe; nether gold ore gives nuggets to any pickaxe' },
  { gives: /^emerald$/, how: 'villagers pay emeralds for things they want; emerald ore is in mountains' },
  { gives: /^(diamond|raw_iron|raw_gold|coal|lapis_lazuli|redstone|emerald|raw_copper)$/, how: 'chests in villages, ruins, shipwrecks and temples sometimes hold some' },
  { gives: /^sugar_cane$/, how: 'grows on sand, dirt or grass right beside water; cut it above the bottom block and it grows back' },
  { gives: /^apple$/, how: 'oak and dark oak leaves now and then drop one when broken or when they decay' },
  { gives: /_sapling$/, how: 'leaves drop them; planted on dirt with room and light, they grow into trees' },
  { gives: /^(cod|salmon|tropical_fish|pufferfish)$/, how: 'fish with a fishing rod (3 sticks and 2 string) in open water' },
  { gives: /^(name_tag|saddle|nautilus_shell)$/, how: 'fishing, trades with villagers and chests in structures' },
  { gives: /^(honeycomb|honey_bottle)$/, how: 'from a full bee nest or hive (shears give honeycomb, a glass bottle honey); a campfire under it keeps the bees calm' },
  { gives: /^(glowstone_dust|quartz|netherrack|soul_sand|nether_wart|magma_cream|gold_nugget|ghast_tear)$/, how: 'from the Nether' },
];

/** Things about the game a player knows by heart, by what a task is about. */
const TOPICS: readonly { about: RegExp; text: string }[] = [
  {
    about: /\b(hungry|starving)\b/i,
    text: 'Food: raw meat fills little and cooked much more (raw beef 3, cooked 8; a furnace and any fuel cooks it); animals live out on grassy land and are not replaced once killed, so when those about are gone more are found farther off; tall grass drops seeds now and then, and wheat from them makes bread (3 a loaf); a fishing rod (3 sticks and 2 string) catches fish in any open water; oak leaves sometimes drop apples; rotten flesh fills a little but often brings on hunger.',
  },
  {
    about: /\b(renewable|sustainable|steady|farm|food (source|supply)|never run out)\b/i,
    text: 'Food that keeps coming: crops planted on farmland by water grow again from their own seeds (wheat, carrots, potatoes, beetroot); animals fed their food breed (cows and sheep: wheat; pigs: carrots; chickens: seeds) and two kept fenced in give meat for good; sugar cane, melons, pumpkins and berry bushes grow back; cows give milk again and again.',
  },
  {
    about: /\b(cow|cows|sheep|pig|pigs|chicken|chickens|animal|animals|pen|breed|breeding|ranch|livestock)\b/i,
    text: 'Animals: cows, sheep, pigs and chickens follow you while you hold their food (wheat; wheat; carrots; seeds) and come along at their own slow pace, so you can lead them home; a fence (with a gate to get in) keeps them; feed two adults of a kind and a baby comes (each can breed again after 5 minutes); babies grow up in about 20 minutes.',
  },
  {
    about: /\bnether\b/i,
    text: 'The Nether: a portal is a frame of obsidian 4 wide and 5 tall (10 obsidian without the corners, 14 with), lit with flint and steel (an iron ingot and a flint); obsidian is made by water on still lava, or mined with a diamond pickaxe. Over there: lava everywhere, ghasts, piglins (they leave alone those wearing gold armor), and blazes and wither skeletons in fortresses.',
  },
  {
    about: /\benchant/i,
    text: 'Enchanting: an enchanting table is a book (3 paper from sugar cane, and a leather), 2 diamonds and 4 obsidian; it takes lapis lazuli and experience levels (from mining ore, smelting, killing mobs and breeding); bookshelves around it (one block away) allow stronger enchantments.',
  },
  {
    about: /\barmou?r\b/i,
    text: 'Armor: a set is a helmet, a chestplate, leggings and boots; in iron that is 5 + 8 + 7 + 4 = 24 iron ingots (smelted from raw iron).',
  },
  {
    about: /\btools?\b/i,
    text: 'Tools: a pickaxe takes 3 of its material, an axe 3, a shovel 1, a sword 2 and a hoe 2, with sticks; iron ones take iron ingots.',
  },
  {
    about: /\b(house|home|hut|shelter|cabin|cottage|base)\b/i,
    text: 'A house: walls, a roof, a door and some light keep monsters out (they spawn in the dark, at light 0); a bed inside lets you sleep through the night and sets where you come back after dying.',
  },
  {
    about: /\b(diamonds?)\b/i,
    text: 'Diamonds: deep down, most between y -64 and -54; strip or branch mining at around y -58 with tunnels a few blocks apart, or exploring deep caves, finds them; mind the lava there; it takes an iron pickaxe, and lots of torches help.',
  },
  {
    about: /\b(iron|gold|copper|coal|redstone|lapis|emeralds?|ore|ores|prospect|prospecting)\b/i,
    text: 'Ores by height (y; yours is the y of where you are): iron in two bands, richest around y 16, another high in mountains, and some at most heights below 72; coal at any height above 0, most high up and in cliffs; copper around y 48; gold below 32, most near -16 (and near the surface in badlands); redstone below 15, more toward the bottom; lapis around 0; emeralds only in mountains; below y 0 the stone is deepslate, slower to dig; a cave wall shows more ore in a minute than a tunnel dug blind.',
  },
  {
    about: /\b(diamonds?|iron|ore|ores|mine|mining|cave|caves|underground|dig|digging)\b/i,
    text: 'Underground: it is dark down there at any hour, and monsters spawn in the dark (zombies, skeletons, spiders, creepers), so a cave is no safer at night than the open, and no sun reaches down there, so what is about in a cave does not burn by day; torches as you go (a coal or charcoal and a stick make 4) stop them spawning near you and mark the way back; a block put in a tunnel behind you stops what follows; a spider is faster than you and climbs walls, so running from one rarely gets you away.',
  },
  {
    about: /\bdripstone\b/i,
    text: 'Dripstone caves: pointed dripstone hanging from the roof (stalactites) falls when the block it hangs from is broken, and one falling on you can kill you outright; stalagmites on the floor hurt to fall onto.',
  },
  {
    about: /\b(night|evening|dusk|nightfall)\b/i,
    text: 'Night: about 8 minutes of dark; monsters (zombies, skeletons, spiders, creepers) spawn in the dark all over the surface and come for anyone near, more of them the longer it lasts; a bed (3 wool and 3 planks) lets you sleep through it and sets where you wake after dying; walls and a roof, or a hole sealed over, keep them off; zombies and skeletons burn when the sun comes up, unless they stand in shade or water; a torch only keeps them from spawning right beside it; bare-handed a zombie takes some 20 punches, with a stone sword 4 blows.',
  },
  {
    about: /\b(romance|romantic|partner|relationship|love|date|marry|married|girlfriend|boyfriend)\b/i,
    text: 'People are won over by time spent together, kindness, small gifts and help, and by being asked when the time is right.',
  },
];

function nice(name: string): string {
  return name.replace(/_/g, ' ');
}

/** "an iron pickaxe", "a stone pickaxe". */
function a(thing: string): string {
  return `${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing}`;
}

const UNCOUNTABLE = /(obsidian|cobblestone|wool|string|leather|paper|sand|gravel|dirt|stone|glass|redstone|gunpowder|sugar|wheat|coal|charcoal|clay|snow|lapis lazuli|quartz|netherrack|kelp|bamboo|cane|planks|logs|meal)$/;

/** "2 iron ingots", "4 obsidian". */
function count(n: number, thing: string): string {
  if (n === 1 || UNCOUNTABLE.test(thing) || /s$/.test(thing)) return `${n} ${thing}`;
  return `${n} ${/(potato|tomato)$/.test(thing) ? `${thing}es` : `${thing}s`}`;
}

/** Planks of any wood read as planks (recipes list every wood as its own variant). */
function general(name: string): string {
  if (/_planks$/.test(name)) return 'planks';
  if (/_log$|_stem$/.test(name)) return 'logs';
  if (/^(cobblestone|cobbled_deepslate|blackstone)$/.test(name)) return 'cobblestone';
  return nice(name);
}

export interface Way {
  kind: 'craft' | 'smelt' | 'mine' | 'mob' | 'other';
  how: string;
}

export class GameKnowledge {
  private readonly cache = new Map<string, Way[]>();

  constructor(private readonly data: GameData) {}

  private name(id: number | null | undefined): string | null {
    return id === null || id === undefined ? null : (this.data.items[id]?.name ?? null);
  }

  /** The cheapest tool that can harvest a block, in words; null if hands will do. */
  private tool(block: string): string | null {
    const tools = this.data.blocksByName[block]?.harvestTools;
    if (!tools) return null;
    const names = Object.keys(tools)
      .map((id) => this.name(Number(id)))
      .filter((n): n is string => Boolean(n));
    for (const m of ['wooden', 'stone', 'iron', 'diamond', 'netherite']) {
      const n = names.find((x) => x.startsWith(`${m}_`));
      if (n) return nice(n);
    }
    return names[0] ? nice(names[0]) : null;
  }

  /** Every way a player knows to get the item. */
  waysToGet(item: string): Way[] {
    const hit = this.cache.get(item);
    if (hit) return hit;
    const ways: Way[] = [];
    const id = this.data.itemsByName[item]?.id;
    // Crafting: the distinct ingredient lists (woods and colours alike count once).
    const seen = new Set<string>();
    for (const r of id !== undefined ? (this.data.recipes[id] ?? []) : []) {
      const cells = r.inShape ? r.inShape.flat() : (r.ingredients ?? []);
      const counts = new Map<string, number>();
      for (const c of cells) {
        const n = this.name(c);
        if (n) counts.set(general(n), (counts.get(general(n)) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      const parts = [...counts].map(([n, c]) => count(c, n)).join(' + ');
      if (seen.has(parts)) continue;
      seen.add(parts);
      const table = r.inShape ? r.inShape.length > 2 || (r.inShape[0]?.length ?? 0) > 2 : cells.length > 4;
      ways.push({ kind: 'craft', how: `craft${r.result.count > 1 ? ` ${r.result.count}` : ''} from ${parts}${table ? ' (at a crafting table)' : ''}` });
      if (seen.size >= 2) break;
    }
    const raw = SMELTS[item];
    if (raw) ways.push({ kind: 'smelt', how: `smelt ${nice(raw)} in a furnace (with fuel: coal, charcoal or wood)` });
    // Blocks found in the world that drop it (not those that need silk touch for it, nor ones that are made, like an
    // ender chest's obsidian); a crop drops its own kind when ripe.
    const blocks: string[] = [];
    for (const [block, loot] of Object.entries(this.data.blockLoot ?? {})) {
      if (!loot) continue;
      const drops = loot.drops.filter((d) => d.item === item && !d.silkTouch);
      if (drops.length === 0) continue;
      const crop = drops.some((d) => (d as { blockAge?: number }).blockAge !== undefined);
      if (block === item && !crop) continue;
      const made = this.data.itemsByName[block] && (this.data.recipes[this.data.itemsByName[block]?.id ?? -1] ?? []).length > 0;
      if (made && !crop) continue;
      blocks.push(crop ? `ripe ${block}` : block);
    }
    const byBase = new Map<string, string[]>();
    for (const b of blocks) {
      const base = b.replace(/^deepslate_/, '');
      byBase.set(base, [...(byBase.get(base) ?? []), b]);
    }
    for (const [base] of [...byBase].slice(0, 3)) {
      const tool = this.tool(base.replace(/^ripe /, ''));
      ways.push({ kind: 'mine', how: `break ${nice(base)}${tool ? ` (needs ${a(tool)} or better)` : ''}` });
    }
    // Mobs that drop it: those that always do, then those that rarely do.
    const loot = Object.entries(this.data.entityLoot ?? {})
      .map(([m, l]) => ({ m, d: l?.drops.find((d) => d.item === item) }))
      .filter((x): x is { m: string; d: NonNullable<typeof x.d> } => Boolean(x.d) && x.m !== 'player');
    const often = loot.filter((x) => x.d.dropChance >= 0.2).map((x) => nice(x.m)).slice(0, 4);
    const rarely = loot.filter((x) => x.d.dropChance < 0.2).map((x) => nice(x.m)).slice(0, 3);
    if (often.length > 0) ways.push({ kind: 'mob', how: `${often.join(', ')} drop it when killed` });
    if (rarely.length > 0) ways.push({ kind: 'mob', how: `${rarely.join(', ')} now and then drop it` });
    for (const f of FACTS) if (f.gives.test(item)) ways.push({ kind: 'other', how: f.how });
    // A block with no other way to it is dug up where it lies.
    if (ways.length === 0 && this.data.blocksByName[item]) {
      const tool = this.tool(item);
      ways.push({ kind: 'mine', how: `dig it up where it lies${tool ? ` (needs ${a(tool)} or better)` : ''}` });
    }
    this.cache.set(item, ways);
    return ways;
  }

  /** "white wool: shear an adult sheep ...; craft from 4 string; ..." or null when nothing is known of it. */
  describe(item: string, max = 6): string | null {
    const ways = this.waysToGet(item);
    if (ways.length === 0) return null;
    // What the data can't tell first (it is what is least obvious), then crafting, smelting, digging, hunting.
    const order: Way['kind'][] = ['other', 'craft', 'smelt', 'mine', 'mob'];
    const sorted = [...ways].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, max);
    return `${nice(item)}: ${sorted.map((w) => w.how).join('; ')}`;
  }

  /** Items named in a text ("12 diamonds", "an enchanting table"), as item names. */
  itemsIn(text: string): string[] {
    const words = text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
    const out: string[] = [];
    const add = (w: string) => {
      for (const c of [w, w.replace(/s$/, ''), w.replace(/es$/, '')]) {
        if (this.data.itemsByName[c] && !out.includes(c)) {
          out.push(c);
          return true;
        }
      }
      return false;
    };
    for (let i = 0; i < words.length; i++) {
      const two = i + 1 < words.length ? `${words[i]}_${words[i + 1]}` : '';
      if (two && add(two)) {
        i++;
        continue;
      }
      const one = words[i] as string;
      if (one.length >= 3 && !COMMON_WORD.has(one)) add(one);
    }
    return out;
  }

  /** What a player knows about what a task is about (a renewable food supply, the Nether, armor). */
  /** The topics the text is about, in the order it comes to them (the hour, said first, before what the plan names). */
  topics(text: string): string[] {
    return TOPICS.map((t) => ({ t, at: text.search(t.about) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((x) => x.t.text);
  }
}

/** Words that are item names but rarely mean the item in a sentence. */
const COMMON_WORD = new Set(['map', 'light', 'fire', 'air', 'barrier', 'structure_void', 'jigsaw', 'set', 'full', 'make', 'form', 'farm']);

/** The items that matter to the agent now: what failed lately, what its goal and tasks name, what it meant to do next. */
export function itemsThatMatter(k: GameKnowledge, s: AgentState, max = 4): string[] {
  const out: string[] = [];
  const add = (x: unknown) => {
    if (typeof x !== 'string') return;
    const n = x.toLowerCase();
    if (k.waysToGet(n).length > 0 && !out.includes(n)) out.push(n);
  };
  for (const a of [...s.actionLog].reverse().slice(0, 8)) {
    if (a.ok) continue;
    add(a.args.item);
    add(a.args.block);
    for (const m of (a.error ?? '').matchAll(/(?:haven't seen any|get|no|need an?|need) ([a-z0-9_]+)/g)) add(m[1]);
  }
  const want = /^inventoryHas:([a-z0-9_]+)/i.exec(s.goals.current?.doneWhen ?? '')?.[1];
  add(want);
  for (const step of s.mind.intention?.steps ?? []) add(step.args?.item);
  const texts = [...(s.goals.tasks ?? []).filter((t) => t.status === 'open').map((t) => t.text), s.goals.current?.text ?? '', ...s.mind.later.map((l) => l.what)];
  for (const t of texts) for (const item of k.itemsIn(t)) add(item);
  return out.slice(0, max);
}

/** What the agent knows that bears on now, as lines for the packet (the items that matter, and what its tasks are about). */
export function knowledgeLines(k: GameKnowledge, s: AgentState): string[] {
  const lines: string[] = [];
  for (const item of itemsThatMatter(k, s)) {
    const d = k.describe(item);
    if (d) lines.push(d);
  }
  // What bears on the moment first (the step at hand, the plan, where one is), then what the tasks are about.
  const hour = !s.self.isDay ? 'night' : s.self.time >= 9600 && s.self.time < 13_000 ? 'evening' : '';
  // Hunger is on one's mind as the hour is: under the 18 that healing needs, or hurt with nothing to heal on.
  const hungry = s.self.food <= 14 || (s.self.food < 18 && s.self.health <= 14) ? 'hungry' : '';
  const now = [hour, hungry, s.goals.current?.text ?? '', s.goals.plan?.aim ?? '', s.scene.where].join('. ');
  const tasks = (s.goals.tasks ?? []).filter((t) => t.status === 'open').map((t) => t.text).join('. ');
  for (const t of [...new Set([...k.topics(now), ...k.topics(tasks)])].slice(0, 3)) lines.push(t);
  return lines;
}
