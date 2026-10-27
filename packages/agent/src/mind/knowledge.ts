// Game knowledge (owner request, 2026-10-24: "we expect them to be familiar with all minecraft mechanics"). The research
// behind the redesign found that telling a model it knows the game is not enough: the facts have to be at hand, as a
// player recalls them or looks them up on the wiki. This is that: for any item, the ways a long-time player knows to
// get it (its recipes, what it is smelted from, which blocks drop it and with what tool, which mobs drop it) from the
// game's own data, and a short list of what that data leaves out (shearing, milking, buckets, farming, breeding,
// trading, bartering, where things lie). It is looked up for what matters now and put in the mind's packet.
// Knowledge only: what to do with it is the mind's.

import type { AgentState } from '@agora/shared';
import { CATEGORIES, EDIBLE } from '../body/items';
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
  { gives: /^(cod|salmon|tropical_fish|pufferfish)$/, how: 'kill one where it swims (in reach in the water, a blow or two; each drops one), or fish with a fishing rod (3 sticks and 2 string) in any open water, slower but never running out' },
  { gives: /^(name_tag|saddle|nautilus_shell)$/, how: 'fishing, trades with villagers and chests in structures' },
  { gives: /^(honeycomb|honey_bottle)$/, how: 'from a full bee nest or hive (shears give honeycomb, a glass bottle honey); a campfire under it keeps the bees calm' },
  { gives: /^(glowstone_dust|quartz|netherrack|soul_sand|nether_wart|magma_cream|gold_nugget|ghast_tear)$/, how: 'from the Nether' },
];

/** Things about the game a player knows by heart, by what a task is about. */
const TOPICS: readonly { about: RegExp; text: string }[] = [
  {
    about: /\b(hungry|starving)\b/i,
    text: 'Food: health comes back by itself only while the food bar is at 18 of 20 or more, and fast while it is full just after a good meal: a steak or a cooked porkchop eaten when hurt brings back several hearts within seconds, so food carried is health in reserve; work, sprinting, fighting and healing burn the bar down. Raw meat fills little and cooked much more (raw beef 3, cooked 8; a furnace and any fuel cooks it); animals live out on grassy land and are not replaced once killed, so when those about are gone more are found farther off; tall grass drops seeds now and then, and wheat from them makes bread (3 a loaf); fish swim in rivers, lakes and the sea, and one killed in the water drops a raw fish (a fishing rod, 3 sticks and 2 string, catches them in any open water too); oak leaves sometimes drop apples; rotten flesh fills a little but often brings on hunger.',
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
    text: 'Armor: each piece takes part of every blow from the moment it is worn (an iron chestplate alone about a fifth of a zombie\'s, the whole iron set over half), so a piece helps long before the set is whole; a set is a helmet, a chestplate, leggings and boots; in iron that is 5 + 8 + 7 + 4 = 24 iron ingots (smelted from raw iron); the same set in copper ingots (from raw copper, common around y 48 and in dripstone caves) protects less than iron, more than leather, and far more than none.',
  },
  {
    about: /\btools?\b/i,
    text: 'Tools: a pickaxe takes 3 of its material, an axe 3, a shovel 1, a sword 2 and a hoe 2, with sticks; iron ones take iron ingots; copper ones, between stone and iron, take copper ingots.',
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
    text: 'Underground: it is dark down there at any hour, and monsters spawn in the dark (zombies, skeletons, spiders, creepers), so a cave is no safer at night than the open, and no sun reaches down there, so what is about in a cave does not burn by day; torches as you go (a coal or charcoal and a stick make 4) stop them spawning near you and mark the way back; nothing to eat grows or lives down there (zombies drop rotten flesh), so a meal there is one brought down; a block put in a tunnel behind you stops what follows; a spider is faster than you and climbs walls, so running from one rarely gets you away.',
  },
  {
    about: /\bdripstone\b/i,
    text: 'Dripstone caves: pointed dripstone hanging from the roof (stalactites) falls when the block it hangs from is broken, and one falling on you can kill you outright; stalagmites on the floor hurt to fall onto.',
  },
  {
    about: /\b(night|evening|dusk|nightfall)\b/i,
    text: 'Night: about 8 minutes of dark; monsters (zombies, skeletons, spiders, creepers) spawn in the dark all over the surface and come for anyone near, more of them the longer it lasts; a bed (3 wool and 3 planks) lets you sleep through it and sets where you wake after dying; walls and a roof keep them off (a hole sealed over too, for one caught out with nowhere else), and under a roof, or down a mine of one\'s own where it is dark at any hour anyway, the work goes on through the night as by day, so the night is not lost; zombies and skeletons burn when the sun comes up, unless they stand in shade or water; a torch only keeps them from spawning right beside it; bare-handed a zombie takes some 20 punches, with a wooden sword 5 blows, a stone or iron one 4.',
  },
  // Two building in a dark forest by day fought zombies there for three minutes, and both were killed.
  {
    about: /\b(dark forest|dark_forest|dark oak)\b/i,
    text: 'A dark forest: the dark oak canopy is so thick that it is dark beneath it by day, so monsters spawn under it and walk about at noon, and under the leaves they do not burn; out in the open beside it they do.',
  },
  // One out exploring in a thunderstorm at 10 health, hungry, met a zombie villager by day and was killed.
  {
    about: /\b(thunderstorm|thunder|storm)\b/i,
    text: 'A thunderstorm: the sky goes dark enough that monsters spawn and walk about by day as at night, and those out in it do not burn until it passes, a few minutes on; under a roof one is as safe as at night; lightning strikes now and then and can set things on fire.',
  },
  {
    about: /\b(romance|romantic|partner|relationship|love|date|marry|married|girlfriend|boyfriend)\b/i,
    text: 'People are won over by time spent together, kindness, small gifts and help, and by being asked when the time is right.',
  },
];

/**
 * What a player knows of a creature by heart, brought up by seeing one: how it comes at you, what keeps it off, what
 * it takes to kill. One who broke into a cave of silverfish, spiders and a skeleton mined the infested stone the
 * silverfish came out of, and pillared up away from the spiders; she was killed in thirty seconds.
 */
const CREATURES: readonly { kind: RegExp; text: string }[] = [
  {
    kind: /^(zombie|husk|zombie_villager)$/,
    text: 'Zombies walk at you and hit (a husk, in deserts, also makes you hungry); 4 blows of a stone or iron sword kill one, 5 of a wooden one, some 20 punches; they cannot climb, so a block in a one-wide way or a pillar 3 high keeps them off; they burn in the sun, unless in shade or water (husks never).',
  },
  {
    kind: /^drowned$/,
    text: 'A drowned is a zombie of the water: it swims after you, comes out onto land at night, and some throw tridents from afar; it does not burn while in the water.',
  },
  {
    kind: /^(skeleton|stray|bogged)$/,
    text: 'Skeletons shoot arrows from 15 m or so and keep their distance (a stray, in the snow, slows with its arrows; a bogged, in swamps, poisons); out of their sight, behind a block or round a corner, they cannot hit you, and a shield stops their arrows; closed in on, 3 or 4 sword blows kill one; they burn in the sun.',
  },
  {
    kind: /^spider$/,
    text: 'A spider is faster than you, jumps at you and climbs walls and pillars, so neither running nor a pillar keeps it off; it cannot get through a gap one block wide, nor into a one-wide hole with a roof over it; in daylight it leaves alone those who leave it alone; 3 or 4 sword blows kill one.',
  },
  {
    kind: /^cave_spider$/,
    text: 'Cave spiders live in old mineshafts, by cobwebs, where a spawner keeps making them until it is broken or lit all round with torches; small enough for a one-wide gap, and their bite poisons.',
  },
  {
    kind: /^creeper$/,
    text: 'A creeper walks up without a sound, hisses when it is close, and a second and a half later blows up, which can take most of your health and the ground under you; stepping back out of its reach while it hisses calms it, and a sword blow knocks it back; it does not burn in the sun.',
  },
  {
    kind: /^enderman$/,
    text: 'An enderman leaves you alone until you look it in the face or hit it; then it teleports at you and hits hard; it is three blocks tall, so it cannot follow you under a roof two blocks high, and water hurts it.',
  },
  {
    kind: /^witch$/,
    text: 'A witch throws potions that poison, slow and hurt, and drinks one to heal; get at her fast or from cover.',
  },
  {
    kind: /^silverfish$/,
    text: 'Silverfish hide in stone that looks like any other (in mountains and strongholds) and come out when it is broken; hitting one that lives wakes the others in the stone round about, so they come in swarms; each is weak (half a heart a bite) and dies to two sword blows; dig no more of that rock, and back off out of it to fight them where few can reach you at once, or wall them off.',
  },
  {
    kind: /^(slime|magma_cube)$/,
    text: 'A slime (a magma cube in the Nether) bounces at you and splits into smaller ones when killed, and those again; the smallest slimes do no harm.',
  },
  {
    kind: /^phantom$/,
    text: 'Phantoms swoop down from the night sky at those who have not slept for three nights or more; a night slept in a bed stops them coming; they burn in the sun.',
  },
  {
    kind: /^warden$/,
    text: 'A warden (in the deep dark, by sculk) is blind and finds you by sound and smell, and kills almost anyone in a few blows: walk away from it crouching, which makes no sound, and never fight it.',
  },
  {
    kind: /^(pillager|vindicator|evoker|ravager|illusioner)$/,
    text: 'Illagers come in patrols and raids: pillagers shoot crossbows, vindicators swing axes, evokers call up fangs from the ground and flying vexes; they are many, so cover and a door between you are worth more than a fight.',
  },
  {
    kind: /^(piglin|piglin_brute|zombified_piglin)$/,
    text: 'Piglins leave alone anyone wearing a piece of gold armor and take gold ingots in barter, but turn on one who opens a chest or mines gold near them (brutes attack anyone); zombified piglins are peaceful until one of them is hit, and then all of them come.',
  },
  {
    kind: /^ghast$/,
    text: 'A ghast floats far off over the Nether and spits fireballs that blow up where they land; a blow or an arrow sends the fireball back, and out of its sight it cannot aim at you.',
  },
  {
    kind: /^blaze$/,
    text: 'Blazes (in Nether fortresses) float and shoot volleys of fire; out of their sight round a corner they cannot, and snowballs hurt them; their rods make blaze powder.',
  },
  {
    kind: /^wither_skeleton$/,
    text: 'Wither skeletons (in Nether fortresses) are tall and hit hard, and their blows wither you (health drains for a while); a gap two blocks high is too low for them.',
  },
  {
    kind: /^hoglin$/,
    text: 'Hoglins (in crimson forests) charge and toss you into the air; they keep away from warped fungus.',
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
        // The thing itself, or one of a kind named as players name it ("catch a fish", "a bed"): the novel test's "Catch
        // a fish" named no item, and nothing of how fish are caught came to mind.
        const item = this.data.itemsByName[c] ? c : this.oneOfKind(c);
        if (item && !out.includes(item)) {
          out.push(item);
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

  private readonly kinds = new Map<string, string | null>();

  /** One item of the kind a word names (a fish: cod), or null. */
  private oneOfKind(word: string): string | null {
    const kind = CATEGORIES[word];
    if (!kind) return null;
    let one = this.kinds.get(word);
    if (one === undefined) {
      one = Object.keys(this.data.itemsByName).filter(kind).sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? null;
      this.kinds.set(word, one);
    }
    return one;
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

/** What one knows of the creatures in sight (or close by, unseen), nearest first: at most `max` of them. */
export function creatureLines(s: AgentState, max = 2): string[] {
  const out: string[] = [];
  const near = s.scene.creatures.filter((c) => c.kind !== 'player' && c.kind !== 'item' && c.distance <= 24 && (c.visible || c.distance <= 8));
  for (const c of [...near].sort((a, b) => a.distance - b.distance)) {
    const f = CREATURES.find((x) => x.kind.test(c.name));
    if (f && !out.includes(f.text)) out.push(f.text);
    if (out.length >= max) break;
  }
  return out;
}

/** What the agent knows that bears on now, as lines for the packet (what is about, the items that matter, and what its tasks are about). */
export function knowledgeLines(k: GameKnowledge, s: AgentState): string[] {
  // What is about comes to mind first, as seeing one does.
  const lines: string[] = creatureLines(s);
  for (const item of itemsThatMatter(k, s)) {
    const d = k.describe(item);
    if (d) lines.push(d);
  }
  // What bears on the moment first (the step at hand, the plan, where one is), then what the tasks are about.
  const hour = !s.self.isDay ? 'night' : s.self.time >= 9600 && s.self.time < 13_000 ? 'evening' : '';
  // Hunger is on one's mind as the hour is: under the 18 that healing needs, or hurt with nothing to heal on, or the bar
  // going down with nothing to eat on one (an agent mined on for half an hour with none, and met its first fight at
  // night unfed and out of food, 20 to 0).
  const carries = s.self.inventory.some((i) => EDIBLE.test(i.item));
  const hungry = s.self.food <= 14 || (s.self.food < 18 && s.self.health <= 14) || (s.self.food < 20 && !carries) ? 'hungry' : '';
  const now = [hour, hungry, s.goals.current?.text ?? '', s.goals.plan?.aim ?? '', s.scene.where].join('. ');
  const tasks = (s.goals.tasks ?? []).filter((t) => t.status === 'open').map((t) => t.text).join('. ');
  for (const t of [...new Set([...k.topics(now), ...k.topics(tasks)])].slice(0, 3)) lines.push(t);
  return lines;
}
