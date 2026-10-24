// Lighting the way (owner request, 2026-10-24: agents play as the experienced players they are). Anyone who has mined
// puts a torch down every so often in the dark underground, without stopping to think: nothing spawns at their back,
// and the way out stays lit. Only with torches on hand; making them is the mind's to think of.

import type { Vec3 } from 'vec3';
import { isAirLike, sturdy } from '../world';
import { placeItemAt } from './building';
import { errMsg } from './util';
import type { SkillContext } from './types';

const TORCHES = ['torch', 'soul_torch'];
/** Darker than this at our feet (as the world was when it came into view), it is dark here. */
const DARK_BELOW = 4;
/**
 * What lights a place; one this close and there is light enough. The client's light levels are those the ground came
 * with and don't follow what changes (a tunnel dug, a torch put down), so the last light behind us is what counts, as
 * for a player: a torch every ten blocks or so.
 */
const LIGHTS = /^(torch|wall_torch|soul_torch|soul_wall_torch|lantern|soul_lantern|glowstone|sea_lantern|shroomlight|jack_o_lantern|lava|campfire|soul_campfire|froglight|ochre_froglight|verdant_froglight|pearlescent_froglight)$/;
const LIT_WITHIN = 9;
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Puts a torch down beside us (on a floor, else a wall) if it is dark here underground and we carry one. True if one went down. */
export async function lightTheWay(ctx: SkillContext): Promise<boolean> {
  const { bot } = ctx;
  const feet = bot.entity.position.floored();
  const here = bot.blockAt(feet);
  // Under the open sky (or no light known): not this habit.
  if (!here || here.light === undefined || here.skyLight === undefined || here.skyLight > 0 || here.light >= DARK_BELOW) return false;
  const torch = bot.inventory.items().find((i) => TORCHES.includes(i.name));
  if (!torch) return false;
  const lights = bot.registry.blocksArray.filter((b) => LIGHTS.test(b.name)).map((b) => b.id);
  if (bot.findBlock({ matching: lights, maxDistance: LIT_WITHIN })) return false;
  // Beside us at the feet or head: on a floor first (the step behind, in a stairway down), else on a wall.
  const around: Vec3[] = [];
  for (const dy of [0, 1]) for (const [dx, dz] of SIDES) around.push(feet.offset(dx, dy, dz));
  const floored = (c: Vec3) => sturdy(bot.blockAt(c.offset(0, -1, 0)));
  const cells = around.filter((c) => isAirLike(bot.blockAt(c))).sort((a, b) => Number(floored(b)) - Number(floored(a)));
  for (const cell of cells) {
    try {
      await placeItemAt(ctx, torch.name, cell);
      return true;
    } catch (err) {
      ctx.logger.debug({ module: 'skill', err: errMsg(err), at: cell.toString() }, 'a torch would not go down there');
    }
  }
  return false;
}
