// Inventory snapshots and diffs: the ground truth Action Awareness compares skill postconditions against (§4.6).

import type { ItemStack } from '@agora/shared';
import type { Bot } from 'mineflayer';
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
    const max = (it as unknown as { maxDurability?: number }).maxDurability;
    let used: number | undefined;
    try {
      used = (it as unknown as { durabilityUsed?: number }).durabilityUsed;
    } catch {
      used = undefined;
    }
    if (!max || typeof used !== 'number') continue;
    const left = Math.max(0, Math.round((1 - used / max) * 100) / 100);
    out.set(it.name, Math.max(out.get(it.name) ?? 0, left));
  }
  return out;
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
