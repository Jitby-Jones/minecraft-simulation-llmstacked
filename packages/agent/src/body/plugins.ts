// mineflayer plugins verified on 26.1 in M1 (pathfinder, pvp, collectblock). mineflayer-armor-manager did not
// equip on 26.1 and auto-eat timing must respect fights, so armor and eating are our own reflexes (§4.5).

import type { Quirk } from '@agora/shared';
import type { Bot } from 'mineflayer';
import pathfinderPkg, { type Movements as MovementsType } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
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

/** Movements for going after someone in a fight: the safe defaults, but walking, jumping and sprinting only (no
 *  digging or towering one's way there). */
export function createFightMovements(bot: Bot): MovementsType {
  const m = createMovements(bot, [], { sprint: true });
  m.canDig = false;
  m.allow1by1towers = false;
  m.scafoldingBlocks = [];
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
  // A walk digs through earth and stone, never through what someone built (a fence, a door, a wall of planks, a
  // bed, a chest, a field): a player goes round it, opens the gate or reaches over (owner request, 2026-10-24).
  for (const b of bot.registry.blocksArray) if (BUILT.test(b.name)) m.blocksCantBreak.add(b.id);
  // Through a gate, not over or through the fence (wooden gates only; Paper handles the click). The pathfinder takes
  // a block's collision from its type, not its state, so an open gate still reads as solid and, once it has opened one,
  // it stands before it: a block with nothing to collide with is passable, whatever its type.
  m.canOpenDoors = true;
  const getBlock = m.getBlock.bind(m);
  m.getBlock = (pos: Parameters<typeof getBlock>[0], dx: number, dy: number, dz: number) => {
    const b = getBlock(pos, dx, dy, dz) as ReturnType<typeof getBlock> & { openable?: boolean; shapes?: unknown[]; safe?: boolean; physical?: boolean };
    if (b.openable && Array.isArray(b.shapes) && b.shapes.length === 0) {
      b.safe = true;
      b.physical = false;
    }
    return b;
  };
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
