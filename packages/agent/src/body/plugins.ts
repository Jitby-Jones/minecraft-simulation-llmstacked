// mineflayer plugins verified on 26.1 in M1 (pathfinder, pvp, collectblock). mineflayer-armor-manager did not
// equip on 26.1 and auto-eat timing must respect fights, so armor and eating are our own reflexes (§4.5).

import type { Quirk } from '@agora/shared';
import type { Bot } from 'mineflayer';
import pathfinderPkg, { type Movements as MovementsType } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import type { Block } from 'prismarine-block';
import { type PathCostRule, pathCostRules } from './quirks';

const { pathfinder, Movements } = pathfinderPkg;

export function loadBodyPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);
  bot.loadPlugin(collectBlockPlugin);
  // Line-of-sight goals around foliage (upper tree logs) need more search than the 5 s default.
  bot.pathfinder.thinkTimeout = 10_000;
  bot.pathfinder.tickTimeout = 25;
  // Paper checks melee reach as 3.0 from the eyes to the target's hitbox; pvp's 3.5 between feet wastes swings.
  (bot as unknown as { pvp: { attackRange: number } }).pvp.attackRange = 3;
}

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
  const rules: PathCostRule[] = pathCostRules(quirks);
  if (rules.length > 0) {
    m.exclusionAreasStep.push((block: Block) => {
      const env = {
        lightLevel: blockLight(block, bot.time.timeOfDay),
        timeOfDay: bot.time.timeOfDay,
        health: bot.health,
        food: bot.food,
        y: block.position.y,
      };
      let extra = 0;
      for (const r of rules) if (r.condition(env)) extra += r.extraCost;
      return extra;
    });
  }
  return m;
}
