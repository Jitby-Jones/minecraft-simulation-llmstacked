// The scene (owner request, 2026-10-24: "their senses should be fully complete ... they should know blocks in their
// view as well as entities, how these entities and blocks relate to them, or each other"). What a player sees when
// they look around, put the way they would take it in:
// - the blocks in view, from the agent's own eyes: rays cast all round (a look around every couple of seconds, never
//   through walls), the blocks they meet grouped into the things a player sees (a stand of oak trees to the north-east,
//   a pond below, iron ore showing in a cliff, a building of planks with a door), each with how far, which way and how
//   far up or down;
// - every creature and thing in sight (people, animals, monsters, items on the ground, boats, minecarts, primed TNT),
//   with how it moves (perception/motion.ts), what can be seen of it (a baby, a sheared sheep, iron armor) and how it
//   stands to the agent and to what is around it (coming toward you, going for Bo, next to the cow, in the water);
// - where the agent is: the biome, what it stands on, the open sky or a roof, inside or out, the weather;
// - what stood out: anything that doesn't fit what the agent knows is possible (mind/expectations.ts), and the first
//   of a remarkable kind of thing it ever saw.
// It describes and never tells the agent what to do.

import type { EntityKind, Logger, Notice, Place, Scene, SceneCreature, SceneFeature, SceneFeatureKind } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import type { AgentBus } from '../bus';
import { biomeAt, canSeeBlock, isEnclosed } from '../body/world';
import { Expectations, NOTICE_MS, URGENT_STRENGTH } from '../mind/expectations';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import { type Motion, MotionTracker } from './motion';
import { bearingOf, countOf } from './sceneWords';

export { bearingOf };


// ---- What a block is to the eye ----------------------------------------------------------------------------------

/** 0: nothing to see (air); 1: seen, and seen past (a flower, glass, a torch); 2: seen, and it blocks the view; 3: a liquid's surface. */
type Sight = 0 | 1 | 2 | 3;
const NOTHING = /^(air|cave_air|void_air|light|structure_void|barrier|moving_piston)$/;
const SEE_PAST = /glass|_pane$|^iron_bars$|_fence$|_fence_gate$|^chain$|^scaffolding$|_leaves$/;

const FLOWERS = /(_tulip|^dandelion|^poppy|_orchid$|^allium|_bluet$|_daisy$|^cornflower|^lily_of_the_valley|^sunflower|^lilac|^rose_bush|^peony|^torchflower$|^pink_petals|^wildflowers|^pitcher_plant)$/;
const ROCK = /^(stone|deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|basalt|smooth_basalt|blackstone|netherrack|end_stone|bedrock)$/;
const GROUND = /^(grass_block|dirt|podzol|mycelium|coarse_dirt|rooted_dirt|moss_block|mud|short_grass|tall_grass|fern|large_fern|dead_bush|seagrass|tall_seagrass|moss_carpet|soul_sand|soul_soil|crimson_nylium|warped_nylium|snow)$/;
const STATION = /^(crafting_table|furnace|blast_furnace|smoker|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|smithing_table|grindstone|stonecutter|loom|cartography_table|fletching_table|lectern|composter|cauldron|water_cauldron|lava_cauldron|bell|beacon|lodestone|respawn_anchor|crafter|jukebox|note_block)$/;
const CONTAINER = /^(chest|trapped_chest|barrel|ender_chest|hopper|dispenser|dropper|decorated_pot)$|shulker_box$/;
const CROPS = /^(wheat|carrots|potatoes|beetroots|nether_wart|pumpkin_stem|melon_stem|attached_pumpkin_stem|attached_melon_stem|torchflower_crop|pitcher_crop|farmland)$/;
const PLANTS = /^(sugar_cane|cactus|bamboo|pumpkin|carved_pumpkin|melon|sweet_berry_bush|cocoa|brown_mushroom|red_mushroom|cave_vines|cave_vines_plant|glow_lichen|kelp|kelp_plant|azalea|flowering_azalea|vine|lily_pad|big_dripleaf|small_dripleaf|spore_blossom|crimson_fungus|warped_fungus|chorus_plant|chorus_flower)$/;
const BUILT = /_planks$|_slab$|_stairs$|_fence$|_fence_gate$|_door$|_trapdoor$|_wall$|glass|_pane$|_wool$|_carpet$|_concrete$|_concrete_powder$|_bricks$|^stripped_|_sign$|_hanging_sign$|^polished_|^chiseled_|^cut_|^smooth_stone$|^(cobblestone|mossy_cobblestone|bricks|torch|wall_torch|soul_torch|soul_wall_torch|lantern|soul_lantern|ladder|hay_block|bookshelf|chiseled_bookshelf|dirt_path|iron_bars|chain|scaffolding|rail|powered_rail|detector_rail|activator_rail|glowstone|sea_lantern|redstone_lamp|lever|tnt|target|iron_block|gold_block|diamond_block|emerald_block|coal_block|copper_block|quartz_block|white_terracotta|terracotta_pot|flower_pot)$|^potted_|_banner$|_wall_banner$|_button$|_pressure_plate$/;

export function featureKindOf(name: string): SceneFeatureKind | null {
  if (NOTHING.test(name)) return null;
  if (name === 'water' || name === 'bubble_column') return 'water';
  if (name === 'lava') return 'lava';
  if (/_ore$|^ancient_debris$/.test(name)) return 'ore';
  if (/^(nether_portal|end_portal|end_portal_frame|end_gateway|obsidian|crying_obsidian)$/.test(name)) return 'portal';
  if (/^(spawner|trial_spawner|vault)$/.test(name)) return 'spawner';
  if (/^(fire|soul_fire|magma_block|powder_snow|wither_rose)$/.test(name)) return 'danger';
  if (/_bed$/.test(name)) return 'bed';
  if (STATION.test(name)) return 'station';
  if (CONTAINER.test(name)) return 'container';
  if (CROPS.test(name)) return 'crops';
  if (/_(log|stem|wood)$/.test(name) && !name.startsWith('stripped_')) return name === 'pumpkin_stem' || name === 'melon_stem' ? 'crops' : 'trees';
  if (/_leaves$/.test(name)) return null;
  if (PLANTS.test(name) || FLOWERS.test(name)) return 'plants';
  if (BUILT.test(name)) return 'built';
  if (ROCK.test(name)) return 'rock';
  if (/^(sand|red_sand|sandstone|red_sandstone|suspicious_sand)$/.test(name)) return 'sand';
  if (/^(gravel|suspicious_gravel)$/.test(name)) return 'gravel';
  if (name === 'clay') return 'clay';
  if (/^(snow_block|ice|packed_ice|blue_ice)$/.test(name)) return 'snow';
  if (GROUND.test(name)) return 'ground';
  if (name === 'cobweb') return 'other';
  return 'other';
}

/** How salient a kind of thing in view is, before distance. */
const SALIENCE: Readonly<Record<SceneFeatureKind, number>> = {
  lava: 1, danger: 0.95, portal: 0.95, spawner: 0.95, ore: 0.9, container: 0.8, station: 0.8, bed: 0.8, built: 0.75, crops: 0.65,
  trees: 0.6, plants: 0.55, water: 0.55, other: 0.35, rock: 0.4, sand: 0.35, gravel: 0.3, clay: 0.4, snow: 0.3, ground: 0,
};

/** Remarkable kinds of thing: the first ever seen of one stands out (a cow does not; a diamond does). */
const REMARKABLE_BLOCK = /^(deepslate_)?(diamond|emerald|lapis|gold|redstone)_ore$|^(ancient_debris|nether_gold_ore|spawner|trial_spawner|vault|nether_portal|end_portal_frame|end_portal|bell|budding_amethyst|amethyst_cluster|suspicious_sand|suspicious_gravel|crying_obsidian|lodestone|beacon|enchanting_table|brewing_stand)$/;
const COMMON_ENTITY = new Set(['player', 'item', 'cow', 'pig', 'sheep', 'chicken', 'zombie', 'skeleton', 'spider', 'creeper', 'bat', 'squid', 'cod', 'salmon', 'rabbit', 'experience_orb', 'arrow', 'falling_block']);

function sightOf(bot: Bot, cache: Map<number, Sight>, id: number): Sight {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const b = (bot.registry as unknown as { blocksByStateId: Record<number, { name: string; boundingBox: string } | undefined> }).blocksByStateId[id];
  let s: Sight = 2;
  if (!b || NOTHING.test(b.name)) s = 0;
  else if (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') s = 3;
  else if (b.boundingBox === 'empty' || SEE_PAST.test(b.name)) s = /_leaves$/.test(b.name) ? 2 : 1;
  cache.set(id, s);
  return s;
}

// ---- The look around: rays from the eyes ---------------------------------------------------------------------------

/** Pitches of the rays, denser near the horizon, where most of what matters is. */
// Ground 10-50 m off lies within a few degrees below the horizon: the rows are densest there.
const PITCHES = [-72, -60, -48, -38, -30, -24, -19, -15.5, -12.5, -10, -8.3, -6.8, -5.5, -4.3, -3.2, -2.2, -1.2, -0.4, 1.5, 4, 8, 13, 20, 29, 41, 56];
const YAWS = 64;
const RANGE = 56;
const RAYS_PER_TICK = 170;
/** Seen-past things one ray records before giving up on it (a field of flowers). */
const MAX_PAST = 4;

type WorldIds = { getBlockStateId(p: Vec3): number | null | undefined };

interface Hit {
  x: number;
  y: number;
  z: number;
  id: number;
}

/** Casts rays all round from the eyes, a share each tick; once round, the blocks met are what is in view. */
export class LookAround {
  private readonly dirs: Vec3[] = [];
  private next = 0;
  private sweep = new Map<string, Hit>();
  private readonly sight = new Map<number, Sight>();
  /** The blocks in view as of the last full look around. */
  seen: Hit[] = [];

  constructor(private readonly bot: Bot) {
    for (const pitch of PITCHES) {
      const p = (pitch * Math.PI) / 180;
      // Fewer rays toward straight up and down, where the circle is small.
      const n = Math.max(12, Math.round(YAWS * Math.cos(p)));
      for (let i = 0; i < n; i++) {
        const yaw = (i / n) * Math.PI * 2;
        this.dirs.push(new Vec3(Math.cos(yaw) * Math.cos(p), Math.sin(p), Math.sin(yaw) * Math.cos(p)));
      }
    }
  }

  /** Casts the next share of rays; true when a whole look around is done (then `seen` is fresh). */
  step(budget = RAYS_PER_TICK): boolean {
    const bot = this.bot;
    const eye = bot.entity.position.offset(0, (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
    const world = bot.world as unknown as WorldIds;
    const end = Math.min(this.dirs.length, this.next + budget);
    for (; this.next < end; this.next++) this.cast(world, eye, this.dirs[this.next] as Vec3);
    if (this.next < this.dirs.length) return false;
    this.seen = [...this.sweep.values()];
    this.sweep = new Map();
    this.next = 0;
    return true;
  }

  private record(x: number, y: number, z: number, id: number): void {
    const k = `${x},${y},${z}`;
    if (!this.sweep.has(k)) this.sweep.set(k, { x, y, z, id });
  }

  /** One ray through the voxels it crosses (Amanatides–Woo), up to what blocks the view. */
  private cast(world: WorldIds, from: Vec3, d: Vec3): void {
    let x = Math.floor(from.x);
    let y = Math.floor(from.y);
    let z = Math.floor(from.z);
    const sx = d.x > 0 ? 1 : -1;
    const sy = d.y > 0 ? 1 : -1;
    const sz = d.z > 0 ? 1 : -1;
    const tdx = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
    const tdy = d.y !== 0 ? Math.abs(1 / d.y) : Infinity;
    const tdz = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
    let tx = d.x !== 0 ? (d.x > 0 ? x + 1 - from.x : from.x - x) * tdx : Infinity;
    let ty = d.y !== 0 ? (d.y > 0 ? y + 1 - from.y : from.y - y) * tdy : Infinity;
    let tz = d.z !== 0 ? (d.z > 0 ? z + 1 - from.z : from.z - z) * tdz : Infinity;
    const p = new Vec3(0, 0, 0);
    let past = 0;
    for (let t = 0, steps = 0; t <= RANGE && steps < 200; steps++) {
      if (tx < ty && tx < tz) {
        x += sx;
        t = tx;
        tx += tdx;
      } else if (ty < tz) {
        y += sy;
        t = ty;
        ty += tdy;
      } else {
        z += sz;
        t = tz;
        tz += tdz;
      }
      if (y < -64 || y > 320) return;
      p.set(x, y, z);
      const id = world.getBlockStateId(p);
      // Not loaded: nothing more to see that way.
      if (id === null || id === undefined) return;
      const s = sightOf(this.bot, this.sight, id);
      if (s === 0) continue;
      this.record(x, y, z, id);
      if (s >= 2) return;
      if (++past > MAX_PAST) return;
    }
  }
}

// ---- From blocks in view to the things a player sees ---------------------------------------------------------------

interface Group {
  kind: SceneFeatureKind;
  sub: string;
  cells: Set<string>;
  hits: Hit[];
}

const CELL = 3;

function nice(name: string): string {
  return name.replace(/^minecraft:/, '').replace(/_/g, ' ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a group of blocks is, in a player's words. */
function words(kind: SceneFeatureKind, blocks: Record<string, number>, hits: readonly Hit[], bot: Bot, roofed: boolean): string {
  const names = Object.entries(blocks).sort((a, b) => b[1] - a[1]);
  const total = hits.length;
  switch (kind) {
    case 'trees': {
      const trunks = new Set(hits.map((h) => `${h.x},${h.z}`)).size;
      const woods = [...new Set(names.map(([n]) => n.replace(/_(log|stem|wood)$/, '').replace(/^mushroom$/, 'mushroom')))].slice(0, 2);
      return `${plural(trunks, `${woods.join(' and ')} tree`)}`;
    }
    case 'water':
      if (roofed) return 'water';
      return total < 8 ? 'a little water' : total < 70 ? 'a pond' : 'a lake or river';
    case 'lava':
      return total < 4 ? 'lava' : 'a pool of lava';
    case 'ore': {
      const ore = (names[0]?.[0] ?? 'ore').replace(/^deepslate_/, '').replace(/_ore$/, ' ore');
      return `${nice(ore)} (${plural(total, 'block')})`;
    }
    case 'rock': {
      const ys = hits.map((h) => h.y);
      const tall = Math.max(...ys) - Math.min(...ys) >= 5;
      const what = nice(names[0]?.[0] ?? 'stone');
      return roofed ? `${what} walls` : tall ? `a ${what} cliff` : `bare ${what}`;
    }
    case 'crops': {
      const crops = names.filter(([n]) => n !== 'farmland');
      if (crops.length === 0) return 'tilled farmland';
      const [crop, n] = crops[0] as [string, number];
      let ripe = 0;
      for (const h of hits) {
        const b = bot.blockAt(new Vec3(h.x, h.y, h.z));
        if (!b || b.name !== crop) continue;
        const age = Number((b.getProperties?.() as Record<string, unknown> | undefined)?.age ?? -1);
        if ((crop === 'beetroots' || crop === 'nether_wart' ? age >= 3 : age >= 7) && age >= 0) ripe++;
      }
      return `${nice(crop)} growing (${plural(n, 'plant')}${ripe > 0 ? `, ${ripe} ripe` : ', none ripe yet'})`;
    }
    case 'plants': {
      const flowers = names.filter(([n]) => FLOWERS.test(n)).reduce((a, [, c]) => a + c, 0);
      const rest = names.filter(([n]) => !FLOWERS.test(n)).slice(0, 2).map(([n, c]) => `${nice(n)} (${c})`);
      return [...rest, ...(flowers > 0 ? [flowers > 6 ? 'lots of flowers' : 'flowers'] : [])].join(', ') || 'plants';
    }
    case 'built': {
      const parts: string[] = [];
      const has = (re: RegExp) => names.some(([n]) => re.test(n));
      if (has(/_door$/)) parts.push('a door');
      if (has(/glass|_pane$/)) parts.push('windows');
      if (has(/torch|lantern/)) parts.push('lights');
      const fenceOnly = names.every(([n]) => /_fence$|_fence_gate$/.test(n));
      if (fenceOnly) return `a fence${has(/_fence_gate$/) ? ' with a gate' : ''}`;
      if (names.every(([n]) => n === 'dirt_path')) return 'a path';
      const mats = names.filter(([n]) => !/_door$|torch|lantern|glass|_pane$/.test(n)).slice(0, 2).map(([n]) => nice(n));
      return `something built of ${mats.join(' and ') || 'blocks'}${parts.length > 0 ? `, with ${parts.join(' and ')}` : ''}`;
    }
    case 'station':
    case 'container':
    case 'spawner': {
      const [n, c] = names[0] ?? ['block', 1];
      return c === 1 ? `a ${nice(n)}` : `${c} ${nice(n)}s`;
    }
    case 'bed': {
      const [n, c] = names[0] ?? ['bed', 2];
      return Math.ceil(c / 2) <= 1 ? `a ${nice(n)}` : `${Math.ceil(c / 2)} beds`;
    }
    case 'portal':
      if (blocks.nether_portal) return 'a lit nether portal';
      if (blocks.end_portal) return 'an open end portal';
      if (blocks.end_portal_frame) return 'an end portal frame';
      return `obsidian (${plural(total, 'block')})`;
    case 'danger':
      return names.map(([n]) => nice(n)).slice(0, 2).join(' and ');
    case 'sand':
    case 'gravel':
    case 'clay':
    case 'snow':
    case 'ground':
    case 'other':
      return names.map(([n]) => nice(n)).slice(0, 2).join(' and ') || 'something';
  }
}

/** Groups the blocks in view into the things a player sees, the most salient first. */
export function featuresOf(bot: Bot, hits: readonly Hit[], feet: Vec3, roofed: boolean, max = 12): SceneFeature[] {
  const reg = bot.registry as unknown as { blocksByStateId: Record<number, { name: string } | undefined> };
  const groups = new Map<string, Group>();
  const cellOf = new Map<string, Group>();
  for (const h of hits) {
    const name = reg.blocksByStateId[h.id]?.name;
    if (!name) continue;
    const kind = featureKindOf(name);
    if (!kind || kind === 'ground') continue;
    // Ore, stations, containers and the like are told apart by kind of block; the rest by what they are.
    const sub = kind === 'ore' ? name.replace(/^deepslate_/, '') : kind === 'station' || kind === 'container' || kind === 'spawner' || kind === 'other' ? name : '';
    const cell = `${kind}|${sub}|${Math.floor(h.x / CELL)},${Math.floor(h.y / CELL)},${Math.floor(h.z / CELL)}`;
    let g = cellOf.get(cell);
    if (!g) {
      g = { kind, sub, cells: new Set([cell]), hits: [] };
      cellOf.set(cell, g);
      groups.set(cell, g);
    }
    g.hits.push(h);
  }
  // Neighbouring cells of the same thing are one thing (a stand of trees, one pond).
  const merged = new Set<Group>();
  for (const g of groups.values()) {
    if (merged.has(g)) continue;
    const [kind, sub, xyz] = [...g.cells][0]?.split('|') ?? [];
    if (!xyz) continue;
    const queue = [xyz];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const [cx, cy, cz] = (queue.shift() as string).split(',').map(Number) as [number, number, number];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const n = `${cx + dx},${cy + dy},${cz + dz}`;
            if (seen.has(n)) continue;
            seen.add(n);
            const other = cellOf.get(`${kind}|${sub}|${n}`);
            if (!other || other === g || merged.has(other)) continue;
            merged.add(other);
            g.hits.push(...other.hits);
            queue.push(n);
          }
        }
      }
    }
  }
  const out: { f: SceneFeature; score: number }[] = [];
  for (const g of groups.values()) {
    if (merged.has(g)) continue;
    const blocks: Record<string, number> = {};
    let nearest: Hit | null = null;
    let best = Infinity;
    for (const h of g.hits) {
      const name = reg.blocksByStateId[h.id]?.name ?? '';
      blocks[name] = (blocks[name] ?? 0) + 1;
      const d = Math.hypot(h.x + 0.5 - feet.x, h.y - feet.y, h.z + 0.5 - feet.z);
      if (d < best) {
        best = d;
        nearest = h;
      }
    }
    if (!nearest) continue;
    // A scrap of bare rock or sand far off is not worth a mention.
    if ((g.kind === 'rock' || g.kind === 'sand' || g.kind === 'gravel' || g.kind === 'snow' || g.kind === 'other') && g.hits.length < 4) continue;
    const f: SceneFeature = {
      kind: g.kind,
      what: words(g.kind, blocks, g.hits, bot, roofed),
      blocks,
      nearest: { x: nearest.x, y: nearest.y, z: nearest.z },
      distance: Math.round(best),
      bearing: bearingOf(feet, { x: nearest.x + 0.5, z: nearest.z + 0.5 }),
      dy: Math.round(nearest.y - Math.floor(feet.y)),
      size: g.hits.length,
    };
    out.push({ f, score: SALIENCE[g.kind] / (1 + best / 14) + Math.min(0.15, g.hits.length / 400) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.f);
}

// ---- Where we are --------------------------------------------------------------------------------------------------

/** The place, as a player would put it: the world or biome, what is underfoot, the sky or a roof, the weather. */
export function whereNow(bot: Bot): { text: string; roofed: boolean } {
  const feet = bot.entity.position.floored();
  const dim = String(bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, '');
  const biome = biomeAt(bot, feet);
  const place = dim === 'the_nether' ? `the Nether${biome ? ` (${nice(biome)})` : ''}` : dim === 'the_end' ? 'the End' : biome ? nice(biome) : 'the overworld';
  const under = bot.blockAt(feet.offset(0, -1, 0));
  const at = bot.blockAt(feet);
  let roof: number | null = null;
  for (let dy = 2; dy <= 40; dy++) {
    const b = bot.blockAt(feet.offset(0, dy, 0));
    if (!b) break;
    if (b.boundingBox === 'block' && !/_leaves$/.test(b.name)) {
      roof = dy;
      break;
    }
  }
  const sky = (at as unknown as { skyLight?: number } | null)?.skyLight ?? 15;
  const parts = [`In ${place}`];
  if (at?.name === 'water') parts.push('in the water');
  else if (at?.name === 'lava') parts.push('IN LAVA');
  else if (under && under.boundingBox === 'block') parts.push(`standing on ${nice(under.name)}`);
  else parts.push('with nothing underfoot');
  if (roof === null) parts.push(dim === 'overworld' ? 'under the open sky' : 'nothing overhead');
  else if (sky === 0 && roof > 2) parts.push(`underground, the ceiling ${roof} m up`);
  else parts.push(roof <= 4 ? 'under a roof' : `something overhead ${roof} m up`);
  if (isEnclosed(bot)) parts.push('walled in');
  if (dim === 'overworld') {
    if ((bot as unknown as { thunderState?: number }).thunderState) parts.push('a thunderstorm');
    else if (bot.isRaining) parts.push('raining');
  }
  return { text: parts.join(', '), roofed: roof !== null && roof <= 24 && sky < 8 };
}

// ---- Creatures and things in view ----------------------------------------------------------------------------------

/** One entity's metadata value by name (the indices differ by entity type and version). */
export function metaOf(bot: Bot, e: Entity, key: string): unknown {
  const keys = (bot.registry.entitiesByName[e.name ?? ''] as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys;
  const i = keys ? keys.indexOf(key) : -1;
  return i >= 0 ? (e.metadata as unknown[] | undefined)?.[i] : undefined;
}

const DYES = ['white', 'orange', 'magenta', 'light blue', 'yellow', 'lime', 'pink', 'gray', 'light gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

/** What a player can see of it: a baby, the colour of a sheep's wool, tame, armour, what it holds, on fire. */
export function detailsOf(bot: Bot, e: Entity, kind: EntityKind): string[] {
  const out: string[] = [];
  const flags = metaOf(bot, e, 'shared_flags');
  const f = typeof flags === 'number' ? flags : 0;
  if (metaOf(bot, e, 'baby') === true) out.push('a baby');
  if (e.name === 'sheep') {
    // The server leaves out what is as it always is: no wool byte is white wool, not sheared.
    const wool = metaOf(bot, e, 'wool');
    const w = typeof wool === 'number' ? wool : 0;
    out.push((w & 0x10) !== 0 ? 'sheared' : `${DYES[w & 0x0f] ?? 'white'} wool`);
  }
  const owner = metaOf(bot, e, 'owneruuid');
  if (owner !== undefined && owner !== null && owner !== '') out.push('tame');
  if ((f & 0x01) !== 0) out.push('on fire');
  if (kind === 'player' && (f & 0x02) !== 0) out.push('sneaking');
  const eq = (e as unknown as { equipment?: ({ name: string } | null | undefined)[] }).equipment ?? [];
  const held = eq[0]?.name;
  if (held && kind !== 'item') out.push(`holding ${held}`);
  const armor = eq.slice(2).filter((x): x is { name: string } => Boolean(x)).map((x) => x.name);
  if (armor.length > 0) {
    const mats = armor.map((a) => a.split('_')[0] ?? a);
    const top = mats.sort((a, b) => mats.filter((m) => m === b).length - mats.filter((m) => m === a).length)[0];
    out.push(armor.length >= 2 && mats.every((m) => m === top) ? `in ${top} armor` : `wearing ${armor.join(', ')}`);
  }
  return out;
}

/** The way someone faces, as a unit vector (mineflayer: yaw 0 looks north, −z; pitch up is +). */
function lookOf(e: Entity): Vec3 {
  const yaw = (e as unknown as { headYaw?: number }).headYaw ?? e.yaw;
  return new Vec3(-Math.sin(yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(yaw) * Math.cos(e.pitch));
}

export interface Seen {
  e: Entity;
  kind: EntityKind;
  name: string;
  visible: boolean;
  distance: number;
}

function labelOf(s: { kind: EntityKind; name: string }): string {
  return s.kind === 'player' ? s.name : `the ${nice(s.name)}`;
}

/** How it stands to us and to what is around it. */
function relationsOf(me: Entity, s: Seen, m: Motion | undefined, all: readonly Seen[]): string[] {
  const out: string[] = [];
  const pos = s.e.position;
  if (m?.medium === 'water') out.push('in the water');
  else if (m?.medium === 'lava') out.push('in lava');
  else if (m?.medium === 'climbable') out.push('on a ladder or vines');
  const vehicle = (s.e as unknown as { vehicle?: Entity }).vehicle;
  if (vehicle) out.push(`riding a ${nice(vehicle.name ?? 'thing')}`);
  // Looking at us: the way it faces points at our head.
  if ((s.kind === 'player' || s.kind === 'hostile' || s.kind === 'passive') && s.visible && s.distance <= 20) {
    const to = me.position.offset(0, 1.6, 0).minus(pos.offset(0, (s.e.height ?? 1.8) * 0.9, 0));
    const len = to.norm();
    if (len > 0.5) {
      const look = lookOf(s.e);
      const cos = (look.x * to.x + look.y * to.y + look.z * to.z) / len;
      if (cos > 0.97) out.push('looking at you');
    }
  }
  // Going after someone: moving their way, a hostile closing in.
  if (m?.heading && m.speed > 1) {
    let target: Seen | null = null;
    let best = 0.9;
    for (const o of all) {
      if (o === s || o.kind !== 'player' || o.e.position.distanceTo(pos) > 16) continue;
      const d = o.e.position.minus(pos);
      const len = Math.hypot(d.x, d.z);
      if (len < 0.5) continue;
      const cos = (m.heading.x * d.x + m.heading.z * d.z) / len;
      if (cos > best) {
        best = cos;
        target = o;
      }
    }
    if (target && s.kind === 'hostile') out.push(`going for ${target.name}`);
  }
  // Right beside someone or something.
  let near: Seen | null = null;
  let nearD = 3;
  for (const o of all) {
    if (o === s || o.kind === 'item' || o.kind === 'other') continue;
    const d = o.e.position.distanceTo(pos);
    if (d < nearD) {
      nearD = d;
      near = o;
    }
  }
  if (near) out.push(`next to ${labelOf(near)}`);
  return out;
}

/** One creature or thing as the agent sees it. */
export function creatureOf(bot: Bot, s: Seen, m: Motion | undefined, all: readonly Seen[]): SceneCreature {
  const me = bot.entity;
  const pos = s.e.position;
  let heading: SceneCreature['heading'];
  if (m?.heading && m.speed > 0.6) {
    const to = me.position.minus(pos);
    const len = Math.hypot(to.x, to.z);
    const cos = len > 0.5 ? (m.heading.x * to.x + m.heading.z * to.z) / len : 0;
    heading = cos > 0.7 ? 'toward you' : cos < -0.7 ? 'away from you' : 'across';
  }
  const dropped = s.kind === 'item' ? (s.e as unknown as { getDroppedItem?: () => { name: string; count: number } | null }).getDroppedItem?.() : null;
  return {
    id: s.e.id,
    kind: s.kind,
    name: s.name,
    pos: { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 },
    distance: Math.round(s.distance * 10) / 10,
    bearing: bearingOf(me.position, pos),
    dy: Math.round(pos.y - me.position.y),
    motion: m?.motion ?? 'still',
    speed: m?.speed ?? 0,
    ...(m && !m.supported && m.medium === 'air' ? { aboveGround: m.aboveGround, airborneSec: m.airborneSec } : {}),
    ...(heading ? { heading } : {}),
    relations: s.kind === 'item' ? [] : relationsOf(me, s, m, all),
    details: s.kind === 'item' ? [] : detailsOf(bot, s.e, s.kind),
    ...(dropped ? { count: dropped.count } : {}),
    visible: s.visible,
  };
}

// ---- The scene, kept up to date --------------------------------------------------------------------------------

/** The blocks under a creature's feet, at its middle and corners and two below: what our world has there. */
function underFoot(bot: Bot, e: Entity): string[] {
  const w = ((e as unknown as { width?: number }).width ?? 0.6) / 2 - 0.05;
  const p = e.position;
  const cells = [
    [0, -0.08, 0],
    [-w, -0.08, -w],
    [w, -0.08, -w],
    [-w, -0.08, w],
    [w, -0.08, w],
    [0, -1.08, 0],
    [0, -2.08, 0],
  ].map(([dx, dy, dz]) => new Vec3(Math.floor(p.x + (dx ?? 0)), Math.floor(p.y + (dy ?? 0)), Math.floor(p.z + (dz ?? 0))));
  return [...new Map(cells.map((c) => [c.toString(), c])).values()].map((c) => `${bot.blockAt(c)?.name ?? 'unloaded'}@${c.x},${c.y},${c.z}`);
}

export interface SceneOptions {
  bot: Bot;
  store: AgentStateStore;
  bus: AgentBus;
  now: () => number;
  /** Something that would put things in our pockets is going on (a craft, a pickup, a chest open): not a surprise. */
  handsBusy?: () => boolean;
  /** For what is worth a look afterwards (what was under someone seen up in the air). */
  logger?: Logger;
}

/** Blocks a look around also picks out one by one (small things the rays may pass between). */
const SMALL_BUT_NOTABLE = /_ore$|^ancient_debris$|_bed$|^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|anvil|enchanting_table|brewing_stand|spawner|nether_portal|sugar_cane|pumpkin|melon|sweet_berry_bush|cobweb|bell)$/;
/** Water and lava close by, looked for apart (a lake would crowd out the rest). */
const LIQUID = /^(water|lava)$/;
const CREATURES_MAX = 24;
/** What is worth remembering where it was. */
const PLACE_KINDS: ReadonlySet<SceneFeatureKind> = new Set(['ore', 'lava', 'portal', 'spawner', 'station', 'container', 'bed', 'built', 'crops', 'plants', 'trees', 'water', 'clay']);
const MAX_PLACES = 80;
const CREATURES_EVERY_MS = 1000;
/** When the sun is low enough to be noticed, with time left to get ready (dark at 13000 of the day's 24000 ticks; a minute is 1200). */
const DUSK_AT = 10_800;

export class SceneEyes {
  readonly motion: MotionTracker;
  readonly expectations: Expectations;
  private readonly look: LookAround;
  private features: SceneFeature[] = [];
  private where = '';
  private roofed = false;
  private lastCreaturesAt = 0;
  private lastKey = '';
  private notices: Notice[] = [];
  private readonly known = new Set<number>();
  private readonly offs: (() => void)[] = [];
  private notableIds: number[] | null = null;
  private liquidIds: number[] | null = null;
  private lastSelf: { pos: Vec3; t: number; time: number; items: Map<string, number>; dim: string } | null = null;
  private lastPickupAt = -Infinity;
  private lastHandsAt = -Infinity;
  private startedAt = 0;
  /** When each entity came into our client's world (it spawned, or came within tracking range). */
  private readonly spawned = new Map<number, number>();
  /** What we last saw of each, for telling a vanishing from a walk out of range. */
  private lastSeen = new Map<number, Seen>();
  private readonly died = new Map<number, number>();
  /** Who joined the game when (their name in the list of players). */
  private readonly joined = new Map<string, number>();
  /** What died or went lately, and where: what turns up there next may be what it became. */
  private ends: { type: string; pos: Vec3; t: number }[] = [];
  private readonly blockIds = new Map<string, number[]>();

  constructor(private readonly o: SceneOptions) {
    this.motion = new MotionTracker(o.bot);
    this.look = new LookAround(o.bot);
    this.expectations = new Expectations({
      state: () => o.store.state,
      learn: (f) => o.store.update('knowledge', (k) => f(k), 'learned what to expect'),
      now: o.now,
    });
  }

  start(): void {
    const bot = this.o.bot;
    this.startedAt = this.o.now();
    const on = <A extends unknown[]>(ev: string, fn: (...a: A) => void) => {
      (bot as unknown as { on(e: string, f: (...a: A) => void): void }).on(ev, fn);
      this.offs.push(() => (bot as unknown as { off(e: string, f: (...a: A) => void): void }).off(ev, fn));
    };
    on('playerCollect', (collector: Entity) => {
      if (collector === bot.entity) this.lastPickupAt = this.o.now();
    });
    on('entitySpawn', (e: Entity) => {
      this.spawned.set(e.id, this.o.now());
      if (this.spawned.size > 2000) for (const [id] of this.spawned) if (!bot.entities[id]) this.spawned.delete(id);
    });
    on('entityDead', (e: Entity) => {
      this.died.set(e.id, this.o.now());
      this.ended(e);
    });
    on('playerJoined', (p: { username: string }) => void this.joined.set(p.username, this.o.now()));
    on('entityGone', (e: Entity) => this.gone(e));
    // Our own world changed under us (a respawn, a portal): what is around is new, not a surprise.
    on('respawn', () => {
      this.lastSelf = null;
      this.startedAt = this.o.now();
    });
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Something we had in plain sight close by is gone: walked off, died, left, went through a portal, or vanished. */
  private gone(e: Entity): void {
    // A drop gone right at our feet is one we picked up (the pickup itself isn't always heard of).
    if ((e.name === 'item' || e.name === 'experience_orb') && this.o.bot.entity && e.position.distanceTo(this.o.bot.entity.position) < 2.5) this.lastPickupAt = this.o.now();
    const s = this.lastSeen.get(e.id);
    this.lastSeen.delete(e.id);
    this.spawned.delete(e.id);
    const now = this.o.now();
    const died = this.died.get(e.id);
    this.died.delete(e.id);
    if (!s || now - this.startedAt < 8000 || (died !== undefined && now - died < 5000)) return;
    const bot = this.o.bot;
    // Left the game (the list of players says so), or stood in a portal: no mystery.
    if (s.kind === 'player' && !bot.players[s.name]) return;
    const at = bot.blockAt(e.position.floored());
    if (at && /portal|end_gateway/.test(at.name)) return;
    this.ended(e);
    if (this.ordinary(e, s.kind, now)) return;
    if ((e as unknown as { vehicle?: unknown }).vehicle) return;
    this.add(this.expectations.vanished({ id: e.id, name: s.name, kind: s.kind, type: s.kind === 'player' ? 'player' : (e.name ?? s.name), distance: e.position.distanceTo(bot.entity.position), visible: s.visible }));
  }

  private ended(e: Entity): void {
    const now = this.o.now();
    if (e.name === 'item' || e.name === 'experience_orb') return;
    this.ends = [...this.ends.filter((x) => now - x.t < 5000), { type: e.name ?? '', pos: e.position.clone(), t: now }].slice(-20);
  }

  /**
   * What the game itself makes come and go, as anyone who has played knows: bees in and out of their nests, a
   * spawner's mobs, what comes through a portal, a player joining, silverfish out of stone, an evoker's vexes, a slime
   * split in two, a wandering trader and its llamas, a village's golems and cats, one creature turned into another
   * (a zombie drowned, a villager struck by lightning). None of it surprises a player.
   */
  private ordinary(e: Entity, kind: EntityKind, now: number): boolean {
    const bot = this.o.bot;
    const type = e.name ?? '';
    const near = (re: RegExp, r: number): boolean => {
      let ids = this.blockIds.get(re.source);
      if (!ids) {
        ids = bot.registry.blocksArray.filter((b) => re.test(b.name)).map((b) => b.id);
        this.blockIds.set(re.source, ids);
      }
      if (ids.length === 0) return false;
      try {
        return bot.findBlock({ point: e.position, matching: ids, maxDistance: r }) !== null;
      } catch {
        return false;
      }
    };
    const others = (re: RegExp, r: number) => Object.values(bot.entities).some((o) => o !== e && re.test(o.name ?? '') && o.position.distanceTo(e.position) <= r);
    if (near(/^(spawner|trial_spawner|nether_portal|end_portal|end_gateway)$/, 5)) return true;
    if (kind === 'player') return now - (this.joined.get(e.username ?? '') ?? -Infinity) < 8000;
    if (/^(silverfish|wandering_trader|trader_llama)$/.test(type)) return true;
    if (type === 'bee') return near(/^(bee_nest|beehive)$/, 5);
    if (type === 'vex') return others(/^evoker$/, 24);
    if (/^(iron_golem|cat)$/.test(type)) return others(/^villager$/, 32);
    if (/^(slime|magma_cube)$/.test(type) && this.ends.some((x) => x.type === type && now - x.t < 4000 && x.pos.distanceTo(e.position) <= 6)) return true;
    // (Whichever of the two the client hears of first.)
    if (this.ends.some((x) => x.type !== type && now - x.t < 4000 && x.pos.distanceTo(e.position) <= 2)) return true;
    return Object.values(bot.entities).some((o) => o !== e && o.name !== type && now - (this.spawned.get(o.id) ?? -Infinity) < 1500 && o.position.distanceTo(e.position) <= 2);
  }

  /** Recent notices, newest last. */
  recent(): Notice[] {
    return this.notices;
  }

  /** One perception tick: how things move, what doesn't fit, a share of the look around, and the scene written. */
  tick(seen: readonly Seen[]): void {
    const bot = this.o.bot;
    const now = this.o.now();
    this.motion.update(
      seen.map((s) => s.e),
      now,
    );
    const settled = now - this.startedAt > 8000;
    // Newcomers: something that turned up close by and in sight.
    const ids = new Set(seen.map((s) => s.e.id));
    this.lastSeen = new Map(seen.map((s) => [s.e.id, s] as const));
    for (const s of seen) {
      if (this.known.has(s.e.id)) continue;
      this.known.add(s.e.id);
      if (!settled) continue;
      const fresh = now - (this.spawned.get(s.e.id) ?? -Infinity) < 1500;
      if (!fresh || this.ordinary(s.e, s.kind, now)) continue;
      this.add(this.expectations.appeared({ id: s.e.id, name: s.name, kind: s.kind, type: s.e.name ?? s.name, distance: s.distance, visible: s.visible, baby: metaOf(bot, s.e, 'baby') === true }));
    }
    for (const id of [...this.known]) if (!ids.has(id) && !bot.entities[id]) this.known.delete(id);
    if (settled) {
      for (const s of seen) {
        const m = this.motion.of(s.e.id);
        if (!m) continue;
        const n = this.expectations.observe({ id: s.e.id, name: s.name, kind: s.kind, type: s.kind === 'player' ? 'player' : (s.e.name ?? s.name), motion: m, distance: s.distance, visible: s.visible });
        // Seen up in the air with nothing under it: what was under it, in our world, for a look afterwards (an agent took
        // another, at work in a tree, for floating).
        if (n?.key === 'hover') this.o.logger?.info({ module: 'perception', who: s.name, at: s.e.position.toString(), under: underFoot(bot, s.e) }, 'seen up in the air');
        this.add(n);
      }
      this.checkSelf(now);
    }
    // A share of the look around; once round, what is in view is grouped anew.
    if (this.look.step()) {
      const w = whereNow(bot);
      this.where = w.text;
      this.roofed = w.roofed;
      const hits = [...new Map([...this.look.seen, ...this.notableInSight()].map((h) => [`${h.x},${h.y},${h.z}`, h] as const)).values()];
      this.features = featuresOf(bot, hits, bot.entity.position, this.roofed);
      this.markFirsts(seen);
      this.remember(seen);
      this.write(seen, now, true);
      return;
    }
    if (now - this.lastCreaturesAt >= CREATURES_EVERY_MS) this.write(seen, now, false);
  }

  /** Small notable blocks in sight the rays may have passed between (one ore block far off). */
  private notableInSight(): { x: number; y: number; z: number; id: number }[] {
    const bot = this.o.bot;
    this.notableIds ??= bot.registry.blocksArray.filter((b) => SMALL_BUT_NOTABLE.test(b.name)).map((b) => b.id);
    this.liquidIds ??= bot.registry.blocksArray.filter((b) => LIQUID.test(b.name)).map((b) => b.id);
    const out: { x: number; y: number; z: number; id: number }[] = [];
    for (const [ids, count, range] of [
      [this.notableIds, 48, 24],
      [this.liquidIds, 24, 16],
    ] as const) {
      for (const p of bot.findBlocks({ matching: ids, maxDistance: range, count })) {
        if (!canSeeBlock(bot, p, range + 1)) continue;
        const id = (bot.world as unknown as WorldIds).getBlockStateId(p);
        if (id !== null && id !== undefined) out.push({ x: p.x, y: p.y, z: p.z, id });
      }
    }
    return out;
  }

  /**
   * Its map memory: where it saw things worth coming back to (ore, a building, crops, a herd of sheep, a wood), one per
   * patch of ground; what is no longer there when it comes by again is forgotten.
   */
  private remember(seen: readonly Seen[]): void {
    const bot = this.o.bot;
    const now = this.o.now();
    const world = String(bot.game?.dimension ?? 'overworld');
    const me = bot.entity.position;
    const fresh: Place[] = [];
    for (const f of this.features) {
      if (!PLACE_KINDS.has(f.kind)) continue;
      const cellSize = f.kind === 'trees' || f.kind === 'water' ? 48 : 24;
      const sub = f.kind === 'ore' || f.kind === 'station' || f.kind === 'container' || f.kind === 'plants' ? (Object.keys(f.blocks)[0] ?? '') : '';
      fresh.push({ key: `${world}|${f.kind}|${sub}|${Math.floor(f.nearest.x / cellSize)},${Math.floor(f.nearest.z / cellSize)}`, kind: f.kind, what: f.what, pos: f.nearest, world, seenAt: now, names: Object.keys(f.blocks) });
    }
    const herds = new Map<string, { n: number; pos: Vec3 }>();
    for (const s of seen) {
      if (s.kind !== 'passive' || !s.visible) continue;
      const type = s.e.name ?? s.name;
      const h = herds.get(type);
      if (h) h.n++;
      else herds.set(type, { n: 1, pos: s.e.position.floored() });
    }
    for (const [type, h] of herds) {
      fresh.push({ key: `${world}|animals|${type}|${Math.floor(h.pos.x / 32)},${Math.floor(h.pos.z / 32)}`, kind: 'animals', what: countOf(h.n, type), pos: { x: h.pos.x, y: h.pos.y, z: h.pos.z }, world, seenAt: now, names: [type] });
    }
    const keys = new Set(fresh.map((p) => p.key));
    const old = this.o.store.state.knowledge.places ?? [];
    // Close by and in this world, but not seen now: gone (mined out, eaten, wandered off).
    const gone = (p: Place) => p.world === world && !keys.has(p.key) && Math.hypot(p.pos.x - me.x, p.pos.z - me.z) < (p.kind === 'animals' ? 16 : 10);
    const kept = old.filter((p) => !keys.has(p.key) && !gone(p));
    if (fresh.length === 0 && kept.length === old.length) return;
    const places = [...kept, ...fresh].sort((a, b) => a.seenAt - b.seenAt).slice(-MAX_PLACES);
    this.o.store.update('knowledge', (k) => ({ ...k, places }), 'places seen');
  }

  /** The first of a remarkable kind of thing this agent ever saw. */
  private markFirsts(seen: readonly Seen[]): void {
    const first = this.o.store.state.knowledge.firstSeen ?? {};
    const now = this.o.now();
    const fresh: Record<string, number> = {};
    for (const f of this.features) {
      const name = Object.keys(f.blocks).find((n) => REMARKABLE_BLOCK.test(n));
      if (!name) continue;
      const k = `block:${name.replace(/^deepslate_/, '')}`;
      if (first[k] || fresh[k]) continue;
      fresh[k] = now;
      f.first = true;
      this.add({ id: `n${now.toString(36)}f${Object.keys(fresh).length}`, ts: now, kind: 'novel', about: name, key: 'first', text: `The first ${nice(name.replace(/^deepslate_/, ''))} you've ever seen: ${f.what}, ${f.distance} m ${f.bearing}`, strength: 0.45, seenBefore: 0 });
    }
    for (const s of seen) {
      if (!s.visible || s.kind === 'player' || s.kind === 'item' || s.kind === 'other') continue;
      const type = s.e.name ?? s.name;
      const k = `entity:${type}`;
      if (COMMON_ENTITY.has(type) || first[k] || fresh[k]) continue;
      fresh[k] = now;
      this.add({ id: `n${now.toString(36)}e${Object.keys(fresh).length}`, ts: now, kind: 'novel', about: type, key: 'first', text: `The first ${nice(type)} you've ever seen, ${Math.round(s.distance)} m ${bearingOf(this.o.bot.entity.position, s.e.position)}`, strength: 0.4, seenBefore: 0 });
    }
    // Everything already in view at the start is no news: only what comes after is.
    if (Object.keys(fresh).length > 0) this.o.store.update('knowledge', (k) => ({ ...k, firstSeen: { ...(k.firstSeen ?? {}), ...fresh } }), 'first seen');
  }

  /** What happened to us that doesn't fit: moved in an instant, the sky changed at once, things in our pockets from nowhere. */
  private checkSelf(now: number): void {
    const bot = this.o.bot;
    const pos = bot.entity.position.clone();
    const dim = String(bot.game?.dimension ?? 'overworld');
    const items = new Map<string, number>();
    for (const it of bot.inventory.items()) items.set(it.name, (items.get(it.name) ?? 0) + it.count);
    const time = bot.time.timeOfDay;
    const prev = this.lastSelf;
    this.lastSelf = { pos, t: now, time, items, dim };
    if (!prev || prev.dim !== dim) return;
    const dt = Math.max(0.05, (now - prev.t) / 1000);
    const moved = pos.distanceTo(prev.pos);
    if (moved >= 8 && moved / dt > 40 && !(bot.entity as unknown as { vehicle?: unknown }).vehicle) {
      this.add(this.expectations.aboutSelf('blink', `You were suddenly somewhere else: in an instant you went ${Math.round(moved)} m, from ${Math.round(prev.pos.x)},${Math.round(prev.pos.y)},${Math.round(prev.pos.z)} to ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`, 0.8));
    }
    // The sun getting low, seen from under the sky: anyone looks up and thinks of the night coming (not a surprise:
    // it comes every evening, and matters every evening).
    if (dim === 'overworld' && prev.time < DUSK_AT && time >= DUSK_AT && time < 13_000 && !this.roofed) {
      const min = Math.max(1, Math.round((13_000 - time) / 1200));
      this.add({ id: `n${now.toString(36)}dusk`, ts: now, kind: 'cue', about: 'the world', key: 'dusk', text: `The sun is getting low in the west: dark in about ${min} min, and in the dark the monsters come out`, strength: 0.65, seenBefore: 0 });
    }
    const skipped = (time - prev.time + 24000) % 24000;
    const sleeping = bot.isSleeping || Object.values(bot.entities).some((e) => e.type === 'player' && metaOf(bot, e, 'pose') === 2);
    if (skipped > 2400 && dt < 3 && !sleeping) {
      const part = (t: number) => (t < 12000 ? 'day' : t < 13000 ? 'evening' : t < 23000 ? 'night' : 'dawn');
      this.add(this.expectations.aboutWorld('time', `The sky changed in an instant: it was ${part(prev.time)}, now it is ${part(time)}`, 0.6));
    }
    // Our own hands put things in our pockets: while they work, and a little after (a craft's result can land after
    // the skill has ended, and a skill can start and end between two looks).
    const last = this.o.store.state.actionLog.at(-1);
    if ((this.o.handsBusy?.() ?? false) || bot.currentWindow) this.lastHandsAt = now;
    if (last) this.lastHandsAt = Math.max(this.lastHandsAt, last.ts + last.durationMs);
    if (now - this.lastPickupAt > 3000 && now - this.lastHandsAt > 3000) {
      // And what our own hands made or got lately, whenever it landed (a craft's result can reach the pockets well
      // after the window closed): what one just did, one knows.
      const ours = this.o.store.state.actionLog.filter((r) => now - (r.ts + r.durationMs) < 60_000).map((r) => `${JSON.stringify(r.args)} ${r.observed}`).join(' ');
      const gained = [...items]
        .filter(([n, c]) => c > (prev.items.get(n) ?? 0) && !ours.includes(n))
        .map(([n, c]) => `${c - (prev.items.get(n) ?? 0)} ${n}`);
      if (gained.length > 0) this.add(this.expectations.aboutSelf('pockets', `${gained.slice(0, 3).join(', ')} appeared in your inventory out of nowhere: you picked nothing up and made nothing`, 0.5));
    }
  }

  private add(n: Notice | null): void {
    if (!n) return;
    const now = this.o.now();
    this.notices = [...this.notices.filter((x) => now - x.ts < NOTICE_MS), n].slice(-8);
    const store = this.o.store;
    store.update('scene', (s) => ({ ...s, notices: this.notices }), `noticed: ${n.key}`);
    // What stands out stays on the mind a while, in the agent's own words.
    if (n.strength >= 0.3) pushWorkmem(store, n.text, Math.min(1, 0.4 + n.strength * 0.6), 'self_observed', { now });
    this.o.bus.emit({ type: 'noticed', notice: n });
  }

  private write(seen: readonly Seen[], now: number, features: boolean): void {
    this.lastCreaturesAt = now;
    const bot = this.o.bot;
    const order = (k: EntityKind) => (k === 'player' ? 0 : k === 'hostile' ? 1 : k === 'passive' ? 2 : k === 'item' ? 3 : 4);
    const shown = [...seen].sort((a, b) => order(a.kind) - order(b.kind) || a.distance - b.distance).slice(0, CREATURES_MAX);
    const creatures = shown.map((s) => creatureOf(bot, s, this.motion.of(s.e.id), seen));
    this.notices = this.notices.filter((x) => now - x.ts < NOTICE_MS);
    const key = [
      this.where,
      this.features.map((f) => `${f.what}@${f.distance}${f.bearing}`).join(';'),
      creatures.map((c) => `${c.id}:${Math.round(c.distance)}:${c.motion}:${c.heading ?? ''}:${c.relations.join(',')}:${c.details.join(',')}`).join(';'),
      this.notices.map((n) => n.id).join(','),
    ].join('|');
    if (key === this.lastKey && !features) return;
    this.lastKey = key;
    const scene: Scene = { at: now, where: this.where, features: this.features, creatures, notices: this.notices };
    this.o.store.update('scene', () => scene, 'scene');
  }
}

/** The scene's notice of a kind, worth stopping to think about. */
export function isUrgent(n: Notice): boolean {
  return n.strength >= URGENT_STRENGTH;
}
