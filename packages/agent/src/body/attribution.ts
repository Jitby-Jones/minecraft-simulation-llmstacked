// Attack attribution (§17.6), from what this client sees: when an entity is hurt, the attacker is the nearest
// player within 4 blocks who swung an arm toward the victim in the last 400 ms; else a melee mob within 3
// blocks; for arrows, the nearest bow/crossbow holder (or ranged mob) in line of sight. The server often sends the
// hurt a moment before the swing that caused it (same tick, later packet), so a blow is looked at again shortly.

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { angleToTarget } from '@agora/shared';
import { canSee, isHostile, isPlayer } from './world';

export type AttackKind = 'melee' | 'ranged' | 'mob' | 'unknown';

export interface Attribution {
  attacker: Entity | null;
  kind: AttackKind;
}

const RANGED_MOBS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'piglin', 'blaze', 'ghast', 'witch', 'drowned', 'breeze']);
const RANGED_ITEMS = new Set(['bow', 'crossbow', 'trident']);
/** How long after a hurt its swing may still arrive. */
export const SWING_LAG_MS = 150;

export class SwingTracker {
  private readonly swings = new Map<number, number>();

  constructor(
    private readonly bot: Bot,
    private readonly now: () => number = () => Date.now(),
  ) {
    bot.on('entitySwingArm', (e: Entity) => {
      this.swings.set(e.id, this.now());
    });
  }

  lastSwing(id: number): number {
    return this.swings.get(id) ?? 0;
  }

  /** Who struck the victim just now; if no swing has been seen yet, looks again once it may have arrived. */
  attribute(victim: Entity, cb: (a: Attribution) => void): void {
    const at = this.now();
    const a = this.attackerOf(victim, at);
    if (a.kind === 'melee') {
      cb(a);
      return;
    }
    setTimeout(() => cb(this.attackerOf(victim, at)), SWING_LAG_MS).unref();
  }

  /** The attacker of a hurt seen at `at` (now by default): a swing up to 400 ms before it, or just after. */
  attackerOf(victim: Entity, at = this.now()): Attribution {
    let best: Entity | null = null;
    let bestDist = Infinity;
    for (const e of Object.values(this.bot.entities)) {
      if (e.id === victim.id || !isPlayer(e)) continue;
      const d = e.position.distanceTo(victim.position);
      const swung = this.lastSwing(e.id) - at;
      if (d > 4 || swung < -400 || swung > SWING_LAG_MS + 50) continue;
      if (angleToTarget(e.position, e.yaw, victim.position) > Math.PI / 3) continue;
      if (d < bestDist) {
        best = e;
        bestDist = d;
      }
    }
    if (best) return { attacker: best, kind: 'melee' };
    for (const e of Object.values(this.bot.entities)) {
      if (e.id === victim.id || !isHostile(e) || RANGED_MOBS.has(e.name ?? '')) continue;
      const d = e.position.distanceTo(victim.position);
      if (d <= 3 && d < bestDist) {
        best = e;
        bestDist = d;
      }
    }
    if (best) return { attacker: best, kind: 'mob' };
    for (const e of Object.values(this.bot.entities)) {
      if (e.id === victim.id) continue;
      const holdsRanged = isPlayer(e) && RANGED_ITEMS.has(e.heldItem?.name ?? '');
      const rangedMob = isHostile(e) && RANGED_MOBS.has(e.name ?? '');
      if (!holdsRanged && !rangedMob) continue;
      const d = e.position.distanceTo(victim.position);
      if (d > 32 || d >= bestDist) continue;
      if (!canSee(this.bot, e, 48)) continue;
      best = e;
      bestDist = d;
    }
    if (best) return { attacker: best, kind: 'ranged' };
    return { attacker: null, kind: 'unknown' };
  }
}
