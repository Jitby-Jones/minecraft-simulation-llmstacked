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

/** The server's own word on a hurt (1.19.4+): who it was hurt by (its "cause", none for a fall or a fire) and how. */
interface Told {
  at: number;
  cause: number;
  direct: number;
}

export class SwingTracker {
  private readonly swings = new Map<number, number>();
  private readonly told = new Map<number, Told>();
  /** Whether this server says who hurt whom: then its word goes before any guess from swings. */
  private serverSays = false;

  constructor(
    private readonly bot: Bot,
    private readonly now: () => number = () => Date.now(),
  ) {
    bot.on('entitySwingArm', (e: Entity) => {
      this.swings.set(e.id, this.now());
    });
    // Two chopping one tree each lost a heart to something else (a drop from its trunk) and each, guessing from the
    // other's swings at the log, took it for a blow: a fight, a yield, and a bad first impression.
    const client = (bot as unknown as { _client?: { on(e: string, cb: (p: { entityId: number; sourceCauseId: number; sourceDirectId: number }) => void): void } })._client;
    client?.on('damage_event', (p) => {
      this.serverSays = true;
      this.told.set(p.entityId, { at: this.now(), cause: p.sourceCauseId - 1, direct: p.sourceDirectId - 1 });
    });
  }

  /** What the server said of the victim's hurt at about `at` (null: it said nothing about it). */
  private toldOf(victim: Entity, at: number): Attribution | null {
    const t = this.told.get(victim.id);
    if (!t || Math.abs(t.at - at) > 500) return null;
    // Each hurt has its own word: once taken for one, it is not taken for the next.
    this.told.delete(victim.id);
    const cause = t.cause >= 0 ? (this.bot.entities[t.cause] ?? null) : null;
    // No one: a fall, a fire, a cactus, hunger, a wall one is caught in.
    if (!cause) return { attacker: null, kind: 'unknown' };
    const ranged = t.direct >= 0 && t.direct !== t.cause;
    return { attacker: cause, kind: ranged ? 'ranged' : isPlayer(cause) ? 'melee' : 'mob' };
  }

  lastSwing(id: number): number {
    return this.swings.get(id) ?? 0;
  }

  /** Who struck the victim just now; if no swing has been seen yet, looks again once it may have arrived. */
  attribute(victim: Entity, cb: (a: Attribution) => void): void {
    const at = this.now();
    const told = this.toldOf(victim, at);
    if (told) {
      cb(told);
      return;
    }
    // The server's word can trail the health it took: looked for again in a moment, and only then a guess.
    if (this.serverSays) {
      setTimeout(() => cb(this.toldOf(victim, at) ?? this.attackerOf(victim, at)), SWING_LAG_MS).unref();
      return;
    }
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
