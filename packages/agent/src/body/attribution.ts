// Attack attribution (§17.6), from what this client sees: when an entity is hurt, the attacker is the nearest
// player within 4 blocks who swung an arm toward the victim in the last 400 ms; else a melee mob within 3
// blocks; for arrows, the nearest bow/crossbow holder (or ranged mob) in line of sight.

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

  attackerOf(victim: Entity): Attribution {
    const t = this.now();
    let best: Entity | null = null;
    let bestDist = Infinity;
    for (const e of Object.values(this.bot.entities)) {
      if (e.id === victim.id || !isPlayer(e)) continue;
      const d = e.position.distanceTo(victim.position);
      if (d > 4 || t - this.lastSwing(e.id) > 400) continue;
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
