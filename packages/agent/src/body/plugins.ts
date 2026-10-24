// mineflayer plugins verified on 26.1 in M1 (pathfinder, pvp, collectblock). mineflayer-armor-manager did not
// equip on 26.1 and auto-eat timing must respect fights, so armor and eating are our own reflexes (§4.5).

import type { Quirk } from '@agora/shared';
import type { Bot } from 'mineflayer';
import pathfinderPkg, { type Movements as MovementsType } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { type PathCostRule, pathCostRules } from './quirks';

const { pathfinder, Movements, goals } = pathfinderPkg;

export interface PvpTuning {
  target?: Entity;
  attackRange: number;
  followRange: number;
  movements: MovementsType;
}

/** What is built, not found: a walk never breaks it to get through. */
const BUILT = /_planks$|_fence$|_fence_gate$|_door$|_trapdoor$|_bed$|_wall$|_slab$|_stairs$|glass|_pane$|_wool$|_carpet$|_concrete$|_bricks$|^bricks$|_sign$|_banner$|^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|anvil|enchanting_table|brewing_stand|bookshelf|torch|wall_torch|lantern|ladder|hay_block|farmland|wheat|carrots|potatoes|beetroots|composter|bell|smithing_table|cartography_table|fletching_table|loom|stonecutter|grindstone|lectern|jukebox|note_block|iron_bars|chain|scaffolding|rail|powered_rail|detector_rail|activator_rail|nether_portal|obsidian|crying_obsidian|end_portal_frame|beacon|cauldron)$|^stripped_|^polished_|^chiseled_|^cut_|^smooth_stone$|^potted_|_button$|_pressure_plate$/;

export function loadBodyPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);
  bot.loadPlugin(collectBlockPlugin);
  // Line-of-sight goals around foliage (upper tree logs) need more search than the 5 s default.
  bot.pathfinder.thinkTimeout = 10_000;
  bot.pathfinder.tickTimeout = 25;
  const pvp = (bot as unknown as { pvp: PvpTuning }).pvp;
  // Paper checks melee reach as 3.0 from the eyes to the target's hitbox; pvp's 3.5 between feet wastes swings.
  pvp.attackRange = 3;
  // pvp follows with a GoalFollow that re-aims only once the target strays farther than the follow range from where
  // it was last seen. At pvp's 2, two fighters could each "arrive" 3 blocks apart, out of reach, and stand there.
  pvp.followRange = 1;
  pvp.movements = createFightMovements(bot);
  keepPvpInReach(bot, pvp);
}

/** A fighter with a target, out of reach and standing still, whose follow goal is gone (a stop wiped it) or aims
 *  where the target no longer is: aim again, at most once a second. A goal that aims right but has no way there is
 *  left alone. */
export function keepPvpInReach(bot: Bot, pvp: PvpTuning): void {
  let last = 0;
  bot.on('physicsTick', () => {
    const t = pvp.target;
    if (!t || Date.now() - last < 1000) return;
    last = Date.now();
    if (bot.pathfinder.isMoving() || t.position.distanceTo(bot.entity.position) <= pvp.attackRange) return;
    const g = bot.pathfinder.goal as { entity?: unknown; x?: number; y?: number; z?: number } | null;
    const at = t.position.floored();
    if (g?.entity === t && g.x === at.x && g.y === at.y && g.z === at.z) return;
    bot.pathfinder.setGoal(new goals.GoalFollow(t, pvp.followRange), true);
  });
}

type GridNode = { x: number; y: number; z: number };

/** The gap a jump from `node` along `dir` would cross is deep: nothing to land on or in, within a fall that doesn't hurt, under its first two cells. */
export function deepGap(m: MovementsType, node: GridNode, dir: { x: number; z: number }): boolean {
  const get = (dx: number, dy: number, dz: number) => (m as unknown as { getBlock(n: GridNode, dx: number, dy: number, dz: number): { physical?: boolean; liquid?: boolean; name?: string } }).getBlock(node, dx, dy, dz);
  for (const d of [1, 2]) {
    const dx = dir.x * d;
    const dz = dir.z * d;
    // Ground where the gap would be: no gap there.
    if (get(dx, -1, dz).physical) return false;
    let safe = false;
    for (let dy = -2; dy >= -(m.maxDropDown + 2); dy--) {
      const b = get(dx, dy, dz);
      if (b.physical || b.liquid || b.name === 'water') {
        safe = true;
        break;
      }
    }
    if (!safe) return true;
  }
  return false;
}

/** Movements for going after someone in a fight: the safe defaults, but walking, jumping and sprinting only (no
 *  digging or towering one's way there). */
export function createFightMovements(bot: Bot): MovementsType {
  const m = createMovements(bot, [], { sprint: true });
  m.canDig = false;
  m.allow1by1towers = false;
  m.scafoldingBlocks = [];
  // No jumping gaps after someone: at a ravine's edge, closing in on a skeleton across it, an agent went over and fell
  // thirteen blocks into the zombies below.
  m.allowParkour = false;
  return m;
}

/** What the pathfinder hands a step hook: a block, or for one in an unloaded chunk a stand-in with no position. */
type StepBlock = Block | { position?: undefined };
const loaded = (b: StepBlock): b is Block => b.position !== undefined;

const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite'];

function blockLight(block: Block, timeOfDay: number): number {
  const b = block as unknown as { light?: number; skyLight?: number };
  const night = timeOfDay >= 13000 && timeOfDay < 23000;
  const sky = night ? Math.max(0, (b.skyLight ?? 15) - 11) : (b.skyLight ?? 15);
  return Math.max(b.light ?? 0, sky);
}

/** At this much health or less, a walk is a careful one. */
const CAREFUL_AT = 10;

/** What a walk opens to go through and shuts again behind it: wooden doors and gates (an iron door takes a button). */
const OPENS = /^(?!iron_)[a-z_]+_(door|fence_gate)$/;
/** A wooden door (an iron one takes a button or a lever). */
const DOOR = /^(?!iron_)[a-z_]+_door$/;

/**
 * Doors as a player goes through them: a shut wooden door on the way is opened on reaching it, and a door or gate a
 * walk opened is shut again once through. The pathfinder opens only gates, and leaves them open; a hut with its door
 * left open is no shelter (two agents sat "sealed in" while the zombies walked in), and a pen with its gate open keeps
 * no cows.
 */
export function doorsAsPlayers(bot: Bot): void {
  const opened = new Map<string, Vec3>();
  const lower = (b: Block) => (String(b.getProperties?.().half ?? 'lower') === 'upper' ? b.position.offset(0, -1, 0) : b.position);
  bot.on('blockUpdate', (old: Block | null, now: Block | null) => {
    if (!old || !now || !OPENS.test(now.name) || !bot.pathfinder?.isMoving()) return;
    if (old.getProperties?.().open !== false || now.getProperties?.().open !== true) return;
    if (now.position.distanceTo(bot.entity.position) > 3) return;
    const p = lower(now);
    opened.set(`${p.x},${p.y},${p.z}`, p);
  });
  let opening = false;
  // Looks in a row with the walk over: a walk between two paths is no stop.
  let still = 0;
  const inCell = (p: Vec3) => {
    const e = bot.entity.position;
    return e.x + 0.3 > p.x && e.x - 0.3 < p.x + 1 && e.z + 0.3 > p.z && e.z - 0.3 < p.z + 1 && e.y + 1.8 > p.y && e.y < p.y + 2;
  };
  const watch = setInterval(() => {
    still = bot.pathfinder?.isMoving() ? 0 : still + 1;
    // A shut door at hand while walking: opened, as one does going through.
    if (bot.pathfinder?.isMoving() && !opening && bot.entity) {
      const feet = bot.entity.position.floored();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]] as const) {
        const b = bot.blockAt(feet.offset(dx, 0, dz));
        if (!b || !DOOR.test(b.name) || b.getProperties?.().open !== false) continue;
        if (b.position.offset(0.5, 0, 0.5).distanceTo(bot.entity.position) > 1.6) continue;
        opening = true;
        void bot.activateBlock(b).catch(() => undefined).finally(() => (opening = false));
        break;
      }
    }
    for (const [k, p] of opened) {
      const b = bot.blockAt(p);
      if (!b || !OPENS.test(b.name) || b.getProperties?.().open !== true) {
        opened.delete(k);
        continue;
      }
      const d = bot.entity.position.distanceTo(p.offset(0.5, 0, 0.5));
      // Still at the doorway, or gone on out of reach of it. A walk that ended just inside (a hut one block across)
      // turns round and shuts it, as a player does: left open, the hut was no shelter.
      const stopped = still >= 2 && !inCell(p);
      if (d < 1.8 && !stopped) continue;
      opened.delete(k);
      if (d <= 4) void bot.activateBlock(b).catch(() => undefined);
    }
  }, 300);
  watch.unref();
  bot.once('end', () => clearInterval(watch));
}

/** What each body has put down itself ("x,y,z"): a walk goes round it rather than through it. */
const OWN = new WeakMap<Bot, ReadonlySet<string>>();
/** Digging through a block one put down oneself, on a walk, costs as much as this many blocks more of walking. */
const OWN_BLOCK_COST = 40;

/**
 * The blocks this body put down, for its walks to go round: told to walk to its hut's corner, an agent dug through the
 * hut's own wall to stand there, and spent the night outside it. Dear, not barred: one shut in by its own walls still
 * digs its way out.
 */
export function ownBlocks(bot: Bot, placed: ReadonlySet<string>): void {
  OWN.set(bot, placed);
}

/**
 * Hurt, one walks with care, as a player does: no jumps over gaps (a missed one is a fall; an agent at 8 health,
 * crossing a dripstone cave, fell to its death). Set on each use, since health changes as one goes.
 */
export function carefulWhenHurt(bot: Bot, m: MovementsType): MovementsType {
  m.allowParkour = bot.health > CAREFUL_AT;
  return m;
}

/**
 * Pathfinder movements with safe defaults (no >3-block drops, scaffolding) and quirk path costs (§7). A walk unless
 * `sprint`: sprinting is what makes one hungry (a food point every 40 blocks or so), so it is for running away and
 * fights; an agent sprinting everywhere starves by its first night.
 */
export function createMovements(bot: Bot, quirks: readonly Quirk[] = [], opts: { sprint?: boolean } = {}): MovementsType {
  const m = new Movements(bot);
  m.allowParkour = true;
  m.allowSprinting = opts.sprint === true;
  m.canDig = true;
  // Fall damage starts above 3 blocks: avoid falls (§4.5).
  m.maxDropDown = 3;
  m.infiniteLiquidDropdownDistance = true;
  m.dontCreateFlow = true;
  m.dontMineUnderFallingBlock = true;
  m.allow1by1towers = true;
  // A gap is jumped only where a miss lands safe (ground or water within a fall that doesn't hurt), as a player
  // jumps a ditch but not a ravine: a missed jump is a fall into the gap.
  const parkour = m.getMoveParkourForward.bind(m) as (node: GridNode, dir: { x: number; z: number }, neighbors: unknown[]) => void;
  (m as unknown as { getMoveParkourForward: typeof parkour }).getMoveParkourForward = (node, dir, neighbors) => {
    if (deepGap(m, node, dir)) return;
    parkour(node, dir, neighbors);
  };
  // A walk digs through earth and stone, never through what someone built (a fence, a door, a wall of planks, a
  // bed, a chest, a field): a player goes round it, opens the gate or reaches over (owner request, 2026-10-24).
  for (const b of bot.registry.blocksArray) if (BUILT.test(b.name)) m.blocksCantBreak.add(b.id);
  // Through a gate, not over or through the fence (wooden gates only; Paper handles the click). The pathfinder takes
  // a block's collision from its type, not its state, so an open gate still reads as solid and, once it has opened one,
  // it stands before it: a block with nothing to collide with is passable, whatever its type.
  m.canOpenDoors = true;
  const getBlock = m.getBlock.bind(m);
  m.getBlock = (pos: Parameters<typeof getBlock>[0], dx: number, dy: number, dz: number) => {
    const b = getBlock(pos, dx, dy, dz) as ReturnType<typeof getBlock> & { openable?: boolean; shapes?: unknown[]; safe?: boolean; physical?: boolean; name?: string };
    if (b.openable && Array.isArray(b.shapes) && b.shapes.length === 0) {
      b.safe = true;
      b.physical = false;
    }
    // A wooden door is a way through, shut or open: the body opens it on reaching it (`doorsAsPlayers`). To the
    // pathfinder a shut door was a wall (two agents could not walk into their own hut, and stood at its door opening
    // and shutting it).
    if (b.name && DOOR.test(b.name)) {
      b.openable = false;
      b.safe = true;
      b.physical = false;
    }
    return b;
  };
  // Never a step onto a stalagmite, nor a drop onto one: a fall onto a point is as one from three blocks higher, twice
  // over (a drop that does nothing elsewhere takes five hearts; an agent at 7 health walking down a dripstone cave
  // "fell from a high place").
  const pointId = bot.registry.blocksByName.pointed_dripstone?.id;
  if (pointId !== undefined) {
    const onPoint = (p: { x: number; y: number; z: number }) => bot.blockAt(new Vec3(p.x, p.y - 1, p.z))?.type === pointId;
    m.exclusionAreasStep.push((block: StepBlock) => (loaded(block) && onPoint(block.position) ? 100 : 0));
    const landing = (m as unknown as { getLandingBlock: (node: GridNode, dir: { x: number; z: number }) => (Block & { liquid?: boolean }) | null }).getLandingBlock.bind(m);
    (m as unknown as { getLandingBlock: typeof landing }).getLandingBlock = (node, dir) => {
      const b = landing(node, dir);
      return b?.position && !b.liquid && onPoint(b.position) ? null : b;
    };
  }
  m.scafoldingBlocks = SCAFFOLD.map((n) => bot.registry.itemsByName[n]?.id).filter((v): v is number => v !== undefined);
  // Keep a step away from lava: a slip or a failed jump next to it is deadly (the pathfinder only refuses
  // stepping into it).
  const lavaId = bot.registry.blocksByName.lava?.id;
  if (lavaId !== undefined) {
    m.exclusionAreasStep.push((block: StepBlock) => {
      if (!loaded(block)) return 0;
      const p = block.position;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]] as const) {
        if (bot.blockAt(p.offset(dx, dy, dz))?.type === lavaId) return 40;
      }
      return 0;
    });
  }
  // A cell the walk would dig through, of what we put down ourselves. Never our own door or gate: it is gone through,
  // not dug (the pathfinder charges this on every cell it passes, and an agent's own hut door, dear twice over, left
  // its search no way in).
  m.exclusionAreasStep.push((block: StepBlock) => {
    const own = OWN.get(bot);
    if (!own || !loaded(block) || block.boundingBox !== 'block' || OPENS.test(block.name)) return 0;
    const p = block.position;
    return own.has(`${p.x},${p.y},${p.z}`) ? OWN_BLOCK_COST : 0;
  });
  const rules: PathCostRule[] = pathCostRules(quirks);
  if (rules.length > 0) {
    // A quirk steers away from places that differ from where the bot stands ("afraid of the dark" avoids dark
    // areas while it's in the light). Where it already is in such a place, every path is equally bad; a uniform
    // penalty would only make the search crawl (superflat worlds lie below y=0; outdoors is dark at night).
    let here = { at: 0, active: rules.map(() => false) };
    const selfActive = (): boolean[] => {
      if (Date.now() - here.at < 1000) return here.active;
      const feet = bot.blockAt(bot.entity.position);
      const env = {
        lightLevel: feet ? blockLight(feet, bot.time.timeOfDay) : 15,
        timeOfDay: bot.time.timeOfDay,
        health: bot.health,
        food: bot.food,
        y: Math.floor(bot.entity.position.y),
      };
      here = { at: Date.now(), active: rules.map((r) => r.condition(env)) };
      return here.active;
    };
    m.exclusionAreasStep.push((block: StepBlock) => {
      if (!loaded(block)) return 0;
      const env = {
        lightLevel: blockLight(block, bot.time.timeOfDay),
        timeOfDay: bot.time.timeOfDay,
        health: bot.health,
        food: bot.food,
        y: block.position.y,
      };
      const self = selfActive();
      let extra = 0;
      rules.forEach((r, i) => {
        if (!self[i] && r.condition(env)) extra += r.extraCost;
      });
      return extra;
    });
  }
  return m;
}
