// Inventory snapshots and diffs: the ground truth Action Awareness compares skill postconditions against (§4.6).

import type { ItemStack } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { ItemMatcher } from './items';

export type InventorySnapshot = ReadonlyMap<string, number>;

export function snapshotInventory(bot: Bot): InventorySnapshot {
  const m = new Map<string, number>();
  for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  // Armor and off-hand are part of what we own.
  for (const slot of [5, 6, 7, 8, 45]) {
    const it = bot.inventory.slots[slot];
    if (it) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  }
  return m;
}

export function countIn(snapshot: InventorySnapshot, matcher: ItemMatcher | string): number {
  let total = 0;
  for (const [name, n] of snapshot) {
    if (typeof matcher === 'string' ? name === matcher : matcher.matches(name)) total += n;
  }
  return total;
}

export function countItem(bot: Bot, matcher: ItemMatcher | string): number {
  return countIn(snapshotInventory(bot), matcher);
}

export function diffInventory(before: InventorySnapshot, after: InventorySnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (d !== 0) out.set(name, d);
  }
  return out;
}

export function describeDiff(diff: ReadonlyMap<string, number>): string {
  if (diff.size === 0) return 'no inventory change';
  return [...diff.entries()].map(([n, d]) => `${d > 0 ? '+' : ''}${d} ${n}`).join(', ');
}

export function inventoryStacks(bot: Bot): ItemStack[] {
  const wear = toolWear(bot);
  return [...snapshotInventory(bot).entries()].map(([item, qty]) => {
    const left = wear.get(item);
    return left === undefined ? { item, qty } : { item, qty, left };
  });
}

/** Free slots of the 36 in the inventory and hotbar. */
export function freeSlots(bot: Bot): number {
  return Math.max(0, 36 - bot.inventory.items().length);
}

/** What a full inventory is to a player, said so (a plugin's "There are no defined chest locations!" said nothing). */
export const INVENTORY_FULL = "your inventory is full (no free slot): nothing more fits until you drop what you don't need (drop {item, qty})";

/** Items one threw away oneself, left where they lie rather than picked up again (by entity id, till when). */
const thrown = new WeakMap<Bot, Map<number, number>>();
const THROWN_MS = 10 * 60_000;

export function markThrown(bot: Bot, ids: Iterable<number>, now = Date.now()): void {
  const m = thrown.get(bot) ?? new Map<number, number>();
  for (const id of ids) m.set(id, now + THROWN_MS);
  for (const [id, until] of m) if (until < now) m.delete(id);
  thrown.set(bot, m);
}

export function wasThrown(bot: Bot, id: number, now = Date.now()): boolean {
  return (thrown.get(bot)?.get(id) ?? 0) > now;
}

/** Below this much of its wear left, a tool is nearly worn out (a player sees the bar turn red). */
export const WORN = 0.2;

/**
 * What a player sees of each tool's wear (its durability bar): how much is left of the best of a kind, the one there is
 * to rely on. An agent's iron pickaxe broke halfway to its diamonds, with nothing to tell it that it was going; and one
 * told the most worn of eight stone pickaxes was nearly gone took all eight for spent and made more.
 */
export function toolWear(bot: Bot): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of bot.inventory.items()) {
    const left = wearLeft(it);
    if (left !== null) out.set(it.name, Math.max(out.get(it.name) ?? 0, left));
  }
  return out;
}

/** How much of one item's durability is left (0..1, to the hundredth), or null for what doesn't wear. */
function wearLeft(it: Item): number | null {
  const max = (it as unknown as { maxDurability?: number }).maxDurability;
  let used: number | undefined;
  try {
    used = (it as unknown as { durabilityUsed?: number }).durabilityUsed;
  } catch {
    used = undefined;
  }
  if (!max || typeof used !== 'number') return null;
  return Math.max(0, Math.round((1 - used / max) * 100) / 100);
}

/** What is left of each one of a kind held, most worn first ([] for what doesn't wear). */
export function wearOfEach(bot: Bot, name: string): number[] {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .map(wearLeft)
    .filter((l): l is number => l !== null)
    .sort((a, b) => a - b);
}

/** One-line digest for the CC packet ("12 oak_log, 3 bread, iron_pickaxe"); a tool nearly worn out says so. */
export function inventoryDigest(stacks: readonly ItemStack[], max = 10): string {
  if (stacks.length === 0) return 'empty';
  const sorted = [...stacks].sort((a, b) => b.qty - a.qty);
  const shown = sorted.slice(0, max).map((s) => `${s.qty > 1 ? `${s.qty} ${s.item}` : s.item}${s.left !== undefined && s.left < WORN ? ' (worn)' : ''}`);
  return sorted.length > max ? `${shown.join(', ')}, +${sorted.length - max} more` : shown.join(', ');
}

export function equippedArmor(bot: Bot): string[] {
  const out: string[] = [];
  for (const slot of [5, 6, 7, 8]) {
    const it = bot.inventory.slots[slot];
    if (it) out.push(it.name);
  }
  return out;
}
