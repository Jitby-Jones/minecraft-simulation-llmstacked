// L0 reflexes (§4.5) — never an LLM. Run at 4 Hz and on damage events:
//   hazards (lava/fire, drowning) → threats (fight or flee: a caution-driven health threshold, creepers, and a
//   damage race we would lose) → defend allies (hook: sentiment ≥ 7) → idle upkeep (eat, pick up, armor) → unstick.
// Reflexes preempt the Skill Executor through hooks; the agent sets flags.inDanger and a canned busy line.

import { type Logger, type Quirk, clamp } from '@agora/shared';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { type AttackKind, SwingTracker } from './attribution';
import { armorPoints, asDifficulty, expectedFightDamage } from './combatOdds';
import { equippedArmor } from './inventory';
import { reflexDelta } from './quirks';
import { bestWeapon, equipBestWeapon, pvp } from './skills/combat';
import { bestFood, eatNow, equipBestArmor } from './skills/survival';
import { canSee, entityHealth, entityLabel, isEnclosed, isHostile, isPlayer, isSolid } from './world';

const { goals } = pathfinderPkg;

export type ReflexMode = 'idle' | 'fight' | 'flee' | 'escape' | 'swim';

export interface DangerInfo {
  kind: 'fight' | 'flee' | 'hazard' | 'defend';
  source: string;
  level: number;
  attacker?: string;
}

export interface ReflexHooks {
  /** drives.caution, 0..1 (§16.3). */
  caution: () => number;
  /** Social reflex: defend allies with sentiment ≥ 7 (§4.5). */
  shouldDefend: (username: string) => boolean;
  /** Self-defense against a person: allowed unless the agent is fleeing-only (youth, §19.5). */
  mayFightBack: (username: string) => boolean;
  quirks: () => readonly Quirk[];
  /** The executor is already running a deliberate fight; reflexes then only handle hazards and low health. */
  deliberateFight: () => boolean;
  /** Combat ability 0..1 (§21.3): reaction jitter. */
  combat: () => number;
  onDanger: (info: DangerInfo) => void;
  onDangerCleared: (summary: string) => void;
  onAttacked: (by: string | null, damage: number, kind: AttackKind) => void;
  onAllyAttacked?: (ally: string, by: string | null) => void;
  /** Short maintenance actions (eat/armor/pickup) pause the executor briefly. */
  onSoftPreempt?: (kind: 'eat' | 'armor' | 'unstick' | 'pickup') => void;
  onSoftResume?: (kind: 'eat' | 'armor' | 'unstick' | 'pickup') => void;
  /** True when no skill is driving the body: the collect reflex may walk over nearby drops (§6.6). */
  isIdle: () => boolean;
  /** Whether a drop is ours to take (not what someone else is digging or dropping). Default: yes. */
  mayPickUp?: (item: Entity) => boolean;
  /** Someone else hit a mob that was after us. */
  onHelpedFight?: (helper: string) => void;
  /** Extra health points of fear toward a threat (availability bias after a death to it, §18.4). */
  fearBoost?: (source: string) => number;
  /** In a duel, the health at which the duel gives up: the reflexes flee only below it (§17.6). */
  fightFloor?: () => number | null;
  /** We're running from a person: say we give up, so they know (§17.6 yield protocol). */
  onYield?: (to: string) => void;
  /** A fight with them was settled (a yield, a call-off, our duel's end) after `since`, their last blow (§17.6). */
  settled?: (username: string, since?: number) => boolean;
}

export interface ReflexOptions {
  tickMs?: number;
  /** Eat when food ≤ this (plus quirk delta). */
  eatAt?: number;
  /** Threat radius for hostile mobs. */
  threatRadius?: number;
  /** Item drops within this radius are picked up when idle (the receiver side of a toss, §6.6). */
  pickupRadius?: number;
}

interface RecentAttack {
  entity: Entity;
  ts: number;
}

const CANNED: Readonly<Record<string, string>> = {
  creeper: 'creeper! hang on',
  zombie: 'hang on, zombie!',
  skeleton: 'arrows! give me a sec',
  spider: 'spider! one sec',
  lava: 'ow, hot hot hot',
  fire: "I'm on fire!",
  water: 'blub, need air',
};

export function cannedBusyLine(source: string): string {
  return CANNED[source] ?? `hold on, ${source}!`;
}

export class ReflexController {
  mode: ReflexMode = 'idle';
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastThreatAt = 0;
  private lastHealth: number;
  /** Where we last stood on solid ground away from lava (the way out of a lava pool). */
  private lastSafe: Vec3 | null = null;
  private lastArmorCheck = 0;
  private fleePlannedAt = 0;
  private readonly recentAttackers = new Map<number, RecentAttack>();
  private readonly allyAttacks = new Map<number, { ally: string; attacker: Entity; ts: number }>();
  private readonly stuckResets: number[] = [];
  private currentSource = '';
  readonly swings: SwingTracker;

  constructor(
    private readonly bot: Bot,
    private hooks: ReflexHooks,
    private readonly logger: Logger,
    private readonly opts: ReflexOptions = {},
  ) {
    this.swings = new SwingTracker(bot);
    this.lastHealth = bot.health;
  }

  /** The agent plugs its state in after the body has connected. */
  setHooks(hooks: Partial<ReflexHooks>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  get active(): boolean {
    return this.mode !== 'idle';
  }

  /** True while a soft reflex (eat, pickup, armor, unstick) is using the body. */
  get upkeepBusy(): boolean {
    return this.busy;
  }

  private async waitIdle(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (!this.hooks.isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  start(): void {
    if (this.timer) return;
    this.bot.on('health', this.onHealth);
    this.bot.on('entityHurt', this.onEntityHurt);
    this.bot.on('path_reset', this.onPathReset);
    this.bot.on('playerCollect', this.onCollect);
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.logger.warn({ module: 'reflex', err: String(err) }, 'reflex tick failed'));
    }, this.opts.tickMs ?? 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bot.off('health', this.onHealth);
    this.bot.off('entityHurt', this.onEntityHurt);
    this.bot.off('path_reset', this.onPathReset);
    this.bot.off('playerCollect', this.onCollect);
  }

  fleeThreshold(): number {
    return clamp(6 + 8 * this.hooks.caution() + reflexDelta(this.hooks.quirks(), 'flee'), 3, 18);
  }

  private readonly onHealth = (): void => {
    const h = this.bot.health;
    if (h < this.lastHealth) {
      const att = this.swings.attackerOf(this.bot.entity);
      const name = att.attacker ? entityLabel(att.attacker) : null;
      if (att.attacker) this.recentAttackers.set(att.attacker.id, { entity: att.attacker, ts: Date.now() });
      this.hooks.onAttacked(name, this.lastHealth - h, att.kind);
    }
    this.lastHealth = h;
  };

  private readonly onEntityHurt = (e: Entity): void => {
    // A mob that was after us (or that we are fighting), hit by someone else: they helped us fight (§6.3 deed).
    const fighting = this.mode === 'fight' ? pvp(this.bot).target : undefined;
    if (!isPlayer(e) && (this.recentAttackers.has(e.id) || fighting?.id === e.id)) {
      const att = this.swings.attackerOf(e);
      if (att.attacker && att.attacker !== this.bot.entity && isPlayer(att.attacker) && att.attacker.username) this.hooks.onHelpedFight?.(att.attacker.username);
      return;
    }
    if (e === this.bot.entity || !isPlayer(e) || !e.username) return;
    if (!this.hooks.shouldDefend(e.username)) return;
    const att = this.swings.attackerOf(e);
    if (!att.attacker || att.attacker === this.bot.entity) return;
    this.allyAttacks.set(att.attacker.id, { ally: e.username, attacker: att.attacker, ts: Date.now() });
    this.hooks.onAllyAttacked?.(e.username, entityLabel(att.attacker));
  };

  private readonly onPathReset = (reason: string): void => {
    if (reason !== 'stuck') return;
    const t = Date.now();
    this.stuckResets.push(t);
    while (this.stuckResets.length > 0 && t - (this.stuckResets[0] ?? 0) > 10_000) this.stuckResets.shift();
    if (this.stuckResets.length >= 2) {
      this.stuckResets.length = 0;
      this.unstick();
    }
  };

  private readonly onCollect = (collector: Entity): void => {
    if (collector === this.bot.entity) this.lastArmorCheck = 0;
  };

  private unstick(): void {
    this.hooks.onSoftPreempt?.('unstick');
    this.bot.setControlState('back', true);
    this.bot.setControlState('jump', true);
    setTimeout(() => {
      this.bot.setControlState('back', false);
      this.bot.setControlState('jump', false);
      this.hooks.onSoftResume?.('unstick');
    }, 600);
  }

  private headInWater(): boolean {
    const head = this.bot.blockAt(this.bot.entity.position.offset(0, 1.6, 0));
    return head?.name === 'water';
  }

  private onFire(): boolean {
    const meta = (this.bot.entity as unknown as { metadata?: unknown[] }).metadata;
    const flags = typeof meta?.[0] === 'number' ? meta[0] : 0;
    return (flags & 0x01) !== 0;
  }

  private inLava(): boolean {
    const p = this.bot.entity.position;
    for (const dy of [0, 0.5, 1]) if (this.bot.blockAt(p.offset(0, dy, 0))?.name === 'lava') return true;
    return false;
  }

  /** Lava next to (or under) where we stand. */
  private lavaNear(): boolean {
    const p = this.bot.entity.position.floored();
    for (const n of [p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1), p.offset(0, -1, 0)]) {
      if (this.bot.blockAt(n)?.name === 'lava') return true;
    }
    return false;
  }

  /** Nearest walkable spot away from lava within `radius`. */
  private safeSpot(radius = 6): Vec3 | null {
    const me = this.bot.entity.position.floored();
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const p = me.offset(dx, dy, dz);
          const feet = this.bot.blockAt(p);
          const head = this.bot.blockAt(p.offset(0, 1, 0));
          const below = this.bot.blockAt(p.offset(0, -1, 0));
          if (!feet || !head || feet.name !== 'air' || head.name !== 'air' || !isSolid(below)) continue;
          let nearLava = false;
          for (const n of [p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1), p.offset(0, -1, 0)]) {
            if (this.bot.blockAt(n)?.name === 'lava') nearLava = true;
          }
          if (nearLava) continue;
          const d = p.distanceTo(me);
          if (d < bestD) {
            best = p;
            bestD = d;
          }
        }
      }
    }
    return best;
  }

  /** Hostiles that matter now. While fleeing, anything chasing within 16 blocks still counts. */
  private threats(radius = this.opts.threatRadius ?? 6): Entity[] {
    const t = Date.now();
    const me = this.bot.entity.position;
    const out = new Map<number, Entity>();
    // Sealed in a shelter, a mob we can't see can't reach us either; fighting it would dig us out.
    const sealed = isEnclosed(this.bot);
    for (const e of Object.values(this.bot.entities)) {
      if (e === this.bot.entity || !isHostile(e)) continue;
      const d = e.position.distanceTo(me);
      // Creepers matter a bit farther away; anything within 3 blocks is a threat even behind a wall corner, but not
      // one under the floor or over the ceiling (a mob in a tunnel below can't reach us).
      const r = e.name === 'creeper' ? radius + 2 : radius;
      const seen = d <= r && canSee(this.bot, e, r + 1);
      if (seen || (d <= 3 && !sealed && Math.abs(e.position.y - me.y) < 2)) out.set(e.id, e);
    }
    for (const [id, a] of this.recentAttackers) {
      const cur = this.bot.entities[id];
      if (!cur || t - a.ts > 5000 || cur.position.distanceTo(me) > 16) {
        this.recentAttackers.delete(id);
        continue;
      }
      if (sealed && !canSee(this.bot, cur, 17)) continue;
      if (cur.username && this.hooks.settled?.(cur.username, a.ts)) continue;
      out.set(id, cur);
    }
    return [...out.values()].sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  }

  private shouldFlee(threats: Entity[]): boolean {
    const me = this.bot.entity.position;
    const health = this.bot.health;
    const fleeAt = this.fleeThreshold() + Math.max(0, ...threats.map((t) => this.hooks.fearBoost?.(entityLabel(t)) ?? 0));
    if (health <= fleeAt) return true;
    if (threats.some((e) => e.name === 'creeper' && e.position.distanceTo(me) <= 5)) return true;
    if (threats.some((e) => e.name === 'warden')) return true;
    const players = threats.filter(isPlayer);
    if (players.some((p) => !this.hooks.mayFightBack(p.username ?? ''))) return true;
    // A damage race we would lose before reaching the flee threshold: cautious people want a wider margin.
    const expected = expectedFightDamage({
      threats: threats.map((e) => ({
        name: isPlayer(e) ? 'player' : (e.name ?? ''),
        heldItem: (e as unknown as { heldItem?: { name: string } | null }).heldItem?.name ?? null,
        // A person's hearts can't be seen (§17.4): reckon them at full health.
        hp: isPlayer(e) ? undefined : entityHealth(this.bot, e),
      })),
      weapon: bestWeapon(this.bot)?.name ?? null,
      armor: armorPoints(equippedArmor(this.bot)),
      combat: this.hooks.combat(),
      difficulty: asDifficulty(this.bot.game.difficulty),
    });
    return expected > (health - fleeAt) * (1.3 - 0.6 * this.hooks.caution());
  }

  /** §21.3: novices hit whatever is nearest; trained fighters finish their target unless an attacker is closer. */
  private pickTarget(threats: Entity[]): Entity | undefined {
    const me = this.bot.entity.position;
    const nearest = threats[0];
    if (this.hooks.combat() < 0.3) return nearest;
    const preferred = threats.find((e) => this.recentAttackers.has(e.id) && e.position.distanceTo(me) <= 4) ?? nearest;
    const current = this.mode === 'fight' ? pvp(this.bot).target : undefined;
    const cur = current ? threats.find((e) => e.id === current.id) : undefined;
    if (cur && preferred && cur.position.distanceTo(me) <= preferred.position.distanceTo(me) + 1) return cur;
    return preferred;
  }

  private announce(kind: DangerInfo['kind'], source: string, attacker?: Entity): void {
    if (this.currentSource === `${kind}:${source}`) return;
    this.currentSource = `${kind}:${source}`;
    this.hooks.onDanger({
      kind,
      source,
      level: kind === 'hazard' ? 0.8 : clamp(1 - this.bot.health / 20 + 0.3, 0, 1),
      attacker: attacker ? entityLabel(attacker) : undefined,
    });
  }

  private clear(summary: string): void {
    if (this.mode === 'idle') return;
    try {
      pvp(this.bot).forceStop();
    } catch {
      // not fighting
    }
    try {
      this.bot.pathfinder.setGoal(null);
    } catch {
      // not moving
    }
    this.bot.clearControlStates();
    this.mode = 'idle';
    this.currentSource = '';
    this.hooks.onDangerCleared(summary);
  }

  private fight(target: Entity, kind: 'fight' | 'defend'): void {
    const p = pvp(this.bot);
    if (p.target?.id === target.id && this.mode === 'fight') return;
    this.mode = 'fight';
    this.announce(kind, target.name === 'player' ? 'attacker' : (target.name ?? 'mob'), target);
    // Reaction jitter: 400 ms × (1 − combat) + 50 ms (§21.3).
    const delay = 400 * (1 - this.hooks.combat()) + 50;
    setTimeout(() => {
      void equipBestWeapon(this.bot)
        .catch(() => null)
        .then(() => {
          if (this.mode === 'fight') p.attack(target);
        });
    }, delay);
  }

  private flee(threats: Entity[]): void {
    const nearest = threats[0];
    if (!nearest) return;
    if (this.mode !== 'flee') {
      try {
        // At once: pvp's stop() leaves the pathfinder a stop that would wipe the flight's first goal.
        pvp(this.bot).forceStop();
      } catch {
        // not fighting
      }
      this.mode = 'flee';
      this.fleePlannedAt = 0;
      this.announce('flee', nearest.name === 'player' ? 'attacker' : (nearest.name ?? 'mob'), nearest);
      const person = threats.find((t) => isPlayer(t) && t.username);
      if (person?.username) this.hooks.onYield?.(person.username);
    }
    // Re-plan as the chasers move; a fixed spot beats GoalInvert, which stalls on open ground.
    const now = Date.now();
    if (now - this.fleePlannedAt < 1500 && this.bot.pathfinder.isMoving()) return;
    this.fleePlannedAt = now;
    const spot = this.fleeSpot(threats);
    if (spot) this.bot.pathfinder.setGoal(new goals.GoalXZ(spot.x, spot.z));
    else this.bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(nearest, 20)), true);
  }

  /** A point 14 blocks away, roughly opposite the threats (weighted by closeness), in a loaded chunk. */
  private fleeSpot(threats: Entity[]): Vec3 | null {
    const me = this.bot.entity.position;
    let dx = 0;
    let dz = 0;
    for (const t of threats) {
      const d = Math.max(0.5, t.position.distanceTo(me));
      dx += (me.x - t.position.x) / (d * d);
      dz += (me.z - t.position.z) / (d * d);
    }
    const base = Math.atan2(dz, dx);
    for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6]) {
      const a = base + off;
      const p = new Vec3(me.x + Math.cos(a) * 14, me.y, me.z + Math.sin(a) * 14);
      if (threats.some((t) => t.position.distanceTo(p) < 10)) continue;
      if (!this.bot.blockAt(p.floored())) continue;
      return p;
    }
    return null;
  }

  /** Walks over one visible item drop nearby. Returns true if it moved. */
  private async pickupNearbyDrop(): Promise<boolean> {
    const bot = this.bot;
    const radius = this.opts.pickupRadius ?? 4;
    const drop = bot.nearestEntity(
      (e) =>
        e.name === 'item' &&
        e.position.distanceTo(bot.entity.position) <= radius &&
        Math.abs(e.position.y - bot.entity.position.y) < 2 &&
        (this.hooks.mayPickUp?.(e) ?? true),
    );
    if (!drop || drop.position.distanceTo(bot.entity.position) < 0.8 || !canSee(this.bot, drop.position.offset(0, 0.25, 0), radius + 1)) return false;
    this.busy = true;
    this.hooks.onSoftPreempt?.('pickup');
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    } catch (err) {
      this.logger.debug({ module: 'reflex', err: String(err) }, 'pickup move failed');
    } finally {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // not moving
      }
      this.busy = false;
      this.hooks.onSoftResume?.('pickup');
    }
    return true;
  }

  private async tick(): Promise<void> {
    const bot = this.bot;
    if (this.busy || !bot.entity || bot.health <= 0) return;
    // 1. Hazards.
    const lava = this.inLava();
    if (!lava && bot.entity.onGround && !this.lavaNear()) this.lastSafe = bot.entity.position.clone();
    if (lava) {
      // Straight back to where we last stood safely: the pathfinder won't plan a way through lava.
      this.mode = 'escape';
      this.announce('hazard', 'lava');
      const back = this.lastSafe && this.lastSafe.distanceTo(bot.entity.position) <= 8 ? this.lastSafe : this.safeSpot();
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // not pathing
      }
      if (back) void bot.lookAt(back.offset(0.5, 1.4, 0.5), true).catch(() => undefined);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      bot.setControlState('sprint', true);
      return;
    }
    if (this.onFire() && !(bot.entity as unknown as { isInWater?: boolean }).isInWater) {
      this.mode = 'escape';
      this.announce('hazard', 'fire');
      const spot = this.safeSpot();
      if (spot) bot.pathfinder.setGoal(new goals.GoalNear(spot.x, spot.y, spot.z, 0));
      else {
        bot.setControlState('jump', true);
        bot.setControlState('forward', true);
      }
      return;
    }
    if (this.headInWater() && bot.oxygenLevel < 8) {
      this.mode = 'swim';
      this.announce('hazard', 'water');
      bot.setControlState('jump', true);
      return;
    }
    if (this.mode === 'escape' || this.mode === 'swim') {
      if (this.mode === 'swim' && bot.oxygenLevel < 15 && this.headInWater()) return;
      this.clear('out of danger');
      return;
    }
    // 2. Threats.
    if (this.hooks.deliberateFight()) {
      if (bot.health <= (this.hooks.fightFloor?.() ?? this.fleeThreshold())) {
        const t = this.threats();
        if (t.length > 0) this.flee(t);
      }
      return;
    }
    // §17.6: a fight we're in ends the moment it's settled; no more swings at someone who yielded or stopped.
    const foe = this.mode === 'fight' ? pvp(bot).target : undefined;
    if (foe?.username && this.hooks.settled?.(foe.username, this.recentAttackers.get(foe.id)?.ts ?? 0)) {
      this.recentAttackers.delete(foe.id);
      this.clear(`${foe.username} gave up`);
      return;
    }
    const threats = this.threats(this.mode === 'flee' ? 16 : undefined);
    if (threats.length > 0) {
      this.lastThreatAt = Date.now();
      // Once running, keep running until nothing chases within 16 blocks: turning back whenever a straggler
      // drops out of range makes a bot dither between the two.
      if (this.mode === 'flee' || this.shouldFlee(threats)) this.flee(threats);
      else {
        const target = this.pickTarget(threats);
        if (target) this.fight(target, 'fight');
      }
      return;
    }
    // 3. Defend allies.
    const now = Date.now();
    for (const [id, a] of this.allyAttacks) {
      const cur = bot.entities[id];
      if (!cur || now - a.ts > 6000 || cur.position.distanceTo(bot.entity.position) > 16 || (cur.username && this.hooks.settled?.(cur.username, a.ts))) {
        this.allyAttacks.delete(id);
        continue;
      }
      if (bot.health > this.fleeThreshold() && (!isPlayer(cur) || this.hooks.mayFightBack(cur.username ?? ''))) {
        this.lastThreatAt = now;
        this.fight(cur, 'defend');
        return;
      }
    }
    // 4. Clear danger after a quiet moment.
    if ((this.mode === 'fight' || this.mode === 'flee') && now - this.lastThreatAt > 3000) {
      this.clear(this.mode === 'fight' ? 'fight over' : 'got away');
      return;
    }
    if (this.mode !== 'idle') return;
    // 5. Upkeep (eat, pick up, armor) only while no skill holds the hands: an equip in the middle of a skill's
    // equip-then-use would place bread instead of dirt. Starving is the exception; the skill is asked to yield.
    const eatAt = (this.opts.eatAt ?? 14) + reflexDelta(this.hooks.quirks(), 'eat');
    const hungry = bot.food <= eatAt || (bot.health < 14 && bot.food < 18);
    const starving = bot.food <= 6 || (bot.health < 8 && bot.food < 18);
    const idle = this.hooks.isIdle();
    if (hungry && (idle || starving)) {
      const food = bestFood(bot, bot.food <= 6);
      if (food) {
        this.busy = true;
        this.hooks.onSoftPreempt?.('eat');
        try {
          if (!idle) await this.waitIdle(2000);
          await eatNow(bot, food);
        } catch (err) {
          this.logger.debug({ module: 'reflex', err: String(err) }, 'eat failed');
        } finally {
          this.busy = false;
          this.hooks.onSoftResume?.('eat');
        }
        return;
      }
    }
    if (!idle) return;
    if (await this.pickupNearbyDrop()) return;
    if (now - this.lastArmorCheck > 10_000) {
      this.lastArmorCheck = now;
      this.busy = true;
      try {
        const changed = await equipBestArmor(bot);
        if (changed.length > 0) this.logger.info({ module: 'reflex', changed }, 'wearing better armor');
      } catch (err) {
        this.logger.debug({ module: 'reflex', err: String(err) }, 'armor equip failed');
      } finally {
        this.busy = false;
      }
    }
  }
}
