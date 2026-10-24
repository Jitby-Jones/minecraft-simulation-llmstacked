// The tool a player takes to a block (owner request, 2026-10-24: think, don't follow directives; a player's hands
// know their tools): the quickest that can take it, but one nearly worn out is spared where a sound one does the job,
// and none is worn where it is no quicker than a bare hand.

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';
import { WORN } from './inventory';

/** How much of a tool's wear is left, 0..1 (undefined: no wear to it). */
export function wearLeft(i: Item): number | undefined {
  const max = (i as unknown as { maxDurability?: number }).maxDurability;
  let used: number | undefined;
  try {
    used = (i as unknown as { durabilityUsed?: number }).durabilityUsed;
  } catch {
    used = undefined;
  }
  if (!max || typeof used !== 'number') return undefined;
  return Math.max(0, 1 - used / max);
}

function enchantsOf(item: Item | null): unknown[] {
  try {
    return (item as unknown as { enchants?: unknown[] } | null)?.enchants ?? [];
  } catch {
    return [];
  }
}

function digTime(bot: Bot, block: Block, item: Item | null): number {
  const b = block as unknown as { digTime(type: number | null, creative: boolean, inWater: boolean, notOnGround: boolean, enchants: unknown[], effects: unknown): number };
  return b.digTime(item ? item.type : null, false, false, false, enchantsOf(item), bot.entity.effects);
}

/**
 * What to dig `block` with, of what is carried. An agent told itself to save its nearly worn iron pickaxe for the
 * diamonds and dig the deepslate with stone, and the hands took the iron to it anyway, and it broke.
 */
export function toolFor(bot: Bot, block: Block): Item | null {
  const items = bot.inventory.items();
  if (items.length === 0) return null;
  const needs = Boolean((block as unknown as { harvestTools?: object }).harvestTools);
  const can = needs ? items.filter((i) => block.canHarvest(i.type)) : items;
  if (can.length === 0) return null;
  const scored = can.map((i) => ({ i, t: digTime(bot, block, i), left: wearLeft(i) }));
  scored.sort((a, b) => a.t - b.t || (a.left === undefined ? -1 : b.left === undefined ? 1 : b.left - a.left));
  const best = scored[0];
  if (!best) return null;
  // No quicker than a bare hand: nothing worn for it.
  if (!needs && best.t >= digTime(bot, block, null)) return scored.find((x) => x.left === undefined)?.i ?? best.i;
  // The quickest nearly gone, and a sound one that takes it too: the sound one.
  if (best.left !== undefined && best.left < WORN) return scored.find((x) => x.left !== undefined && x.left >= WORN)?.i ?? best.i;
  return best.i;
}
