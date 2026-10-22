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
  const m = createMovements(bot);
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

/** Pathfinder movements with safe defaults (no >3-block drops, scaffolding) and quirk path costs (§7). */
export function createMovements(bot: Bot, quirks: readonly Quirk[] = []): MovementsType {
  const m = new Movements(bot);
  m.allowParkour = true;
  m.allowSprinting = true;
  m.canDig = true;
  // Fall damage starts above 3 blocks: avoid falls (§4.5).
  m.maxDropDown = 3;
  m.infiniteLiquidDropdownDistance = true;
  m.dontCreateFlow = true;
  m.dontMineUnderFallingBlock = true;
  m.allow1by1towers = true;
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
