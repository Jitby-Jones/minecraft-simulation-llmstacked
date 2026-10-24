// L0 reflexes (§4.5) — never an LLM. Run at 4 Hz and on damage events:
//   hazards (lava/fire, drowning) → threats (fight or flee: a caution-driven health threshold, creepers, and a
//   damage race we would lose) → defend allies (hook: sentiment ≥ 7) → treading water when idle in it, and swimming
//   ashore → idle upkeep (eat, pick up, armor) → unstick.
// Reflexes preempt the Skill Executor through hooks; the agent sets flags.inDanger and a canned busy line.

import { type Logger, type Quirk, clamp } from '@agora/shared';
import type { Bot } from 'mineflayer';
import pathfinderPkg, { type Movements } from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { type AttackKind, SwingTracker } from './attribution';
import { armorPoints, asDifficulty, expectedFightDamage } from './combatOdds';
import { equippedArmor } from './inventory';
import { weaponTier } from './items';
import { reflexDelta } from './quirks';
import { bestToHitWith, bestWeapon, equipBestWeapon, pvp } from './skills/combat';
import { REGEN_PER_S, beaten, reckonBlow } from './skills/duel';
import { COOKS, bestFood, eatNow, equipBestArmor } from './skills/survival';
import { carefulWhenHurt, createMovements } from './plugins';
import { isCover, referenceFor } from './skills/building';
import { canSee, entityHealth, entityLabel, isAirLike, isEnclosed, isHostile, isPlayer, isSolid, wallsAround } from './world';

const { goals } = pathfinderPkg;

export type ReflexMode = 'idle' | 'fight' | 'flee' | 'escape' | 'swim';

/** One fight, as it goes (ReflexController.bout). */
interface Bout {
  foe: string;
  id: number;
  since: number;
  health: number;
  weapon: string;
  swings: number;
  landed: number;
  closest: number;
}

/** Mobs that shoot (fleeing across open ground from them only gives them a target). */
const ARCHERS = new Set(['skeleton', 'stray', 'bogged', 'pillager']);
/** Closing in on an archer that this long has not brought it within reach: it can't be got at. */
const ARCHER_CHASE_MS = 10_000;
/** One that couldn't be got at is run from, out of its sight, for this long. */
const ARCHER_AVOID_MS = 30_000;
/** A mob that shoots is a threat this far off, once it can see us: its range, not arm's length. */
const SHOT_RANGE = 16;

/** It hits from afar: an archer, or a drowned with a trident (it throws it from the water). */
export function shoots(e: Entity): boolean {
  if (ARCHERS.has(e.name ?? '')) return true;
  const ent = e as unknown as { heldItem?: { name: string } | null; equipment?: ({ name: string } | null | undefined)[] };
  return e.name === 'drowned' && (ent.heldItem?.name ?? ent.equipment?.[0]?.name) === 'trident';
}
/** A weapon this good (a stone sword or axe, or better) makes a monster worth fighting rather than running from. */
const ARMED_TIER = 2;

/** What no one stands and fights: a creeper about to go, a warden. */
function mustRun(bot: Bot, threats: readonly Entity[]): boolean {
  const me = bot.entity.position;
  return threats.some((e) => (e.name === 'creeper' && e.position.distanceTo(me) <= 5) || e.name === 'warden');
}
/** Grounded melee standing well below `me`: it can't reach up to us. */
function outOfReach(e: Entity, me: Vec3): boolean {
  return GROUNDED.test(e.name ?? '') && !shoots(e) && me.y - e.position.y >= OUT_OF_REACH;
}

/** Having called a fight off on someone, we fight on if they come back for more this soon after. */
const CALLED_OFF_MS = 30_000;
/** A head under water this long is a hazard, whatever the air reading says (air lasts 15 s). */
const SUBMERGED_MS = 6000;
/** Running that isn't working (still being hit, or nowhere to go) with the attacker close: stand and fight this long. */
const STAND_MS = 12_000;
/** The six cells beside one: the steps of a swim. */
const NEIGHBORS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
  [0, -1, 0],
] as const;
/** Where we walked lately: a way back we know is open, to run along. */
const TRAIL_MAX = 80;
/** Running, the way out keeps clear of every monster in sight this close, not only of those at hand. */
const RUN_AWARE = 16;
/** Melee that neither climbs, nor shoots, nor flies: what can't reach one standing a few blocks up. */
const GROUNDED = /^(zombie|husk|drowned|zombie_villager|zombified_piglin|piglin|piglin_brute|vindicator|hoglin|zoglin|silverfish|endermite|slime|magma_cube)$/;
/** This far above it, what is grounded can't reach (its reach is sideways, not up; live, two blocks kept two zombies off). */
const OUT_OF_REACH = 2;
/** One climb up a pillar at a time: after one that didn't get up, the next waits this long. */
const PERCH_MS = 5000;
/** A pillar is climbed with this much start on what chases (a climb out of reach takes a second; a zombie covers two
 * or three blocks in it, and a hit at the top of a jump knocks one off the pillar). */
const PERCH_START = 4;
/** How high the pillar goes: out of reach with a block to spare. */
const PERCH_HEIGHT = 3;
/** The eight columns about one's own. */
const AROUND = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
/** In the water this long with nothing to do: out to the nearest shore. */
const ASHORE_AFTER_MS = 8000;
/** Swimming for a shore this long without getting out: another look for one. */
const ASHORE_RETRY_MS = 20_000;

export interface DangerInfo {
  kind: 'fight' | 'flee' | 'hazard' | 'defend';
  source: string;
  level: number;
  attacker?: string;
}

export interface ReflexHooks {
  /** drives.caution, 0..1 (§16.3). */
  caution: () => number;
  /** Social reflex: defend allies with sentiment ≥ 7 (§4.5), from this attacker (a person's name, if one). */
  shouldDefend: (ally: string, attacker?: string) => boolean;
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
  /** Nothing at all under way (the mind deciding what's next): the head turns about now and then, as people's do. */
  between?: () => boolean;
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
  /** We stopped fighting back someone who has taken a beating: say it's over (§17.6). */
  onCallOff?: (to: string) => void;
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
  private lastGlance = 0;
  private glanceEvery = 3000;
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
  /** The blows seen landing on each person we fought back (by entity), reckoned as a duel does (§17.6). */
  private readonly dealt = new Map<number, { dealt: number; last: number; at: number; calledOffAt?: number }>();
  private readonly stuckResets: number[] = [];
  private currentSource = '';
  /** Since when the head has been under water, and the body in it with nothing driving it (null: not now). */
  private underSince: number | null = null;
  /** Under water with a roof over it: the place to breathe being swum for. */
  private airAt: Vec3 | null = null;
  /** The last climb up a pillar out of reach: when (the next waits PERCH_MS). */
  private perchSince = 0;
  /** Archers closed in on in vain, each until when it is run from instead (an agent "fought" one for 81 s, never
   * nearer than 9 blocks, shot from 20 health to 8). */
  private unreachable = new Map<number, number>();
  private wetSince: number | null = null;
  /** Holding jump to keep the head above water. */
  private treading = false;
  /** The shore being swum for, and since when. */
  private ashore: { at: Vec3; since: number } | null = null;
  /** Movements for running away (made the first time). */
  private running: Movements | null = null;
  /** Blows taken while running away, lately. */
  private fleeHits: number[] = [];
  /** When this flight began. */
  private fleeSince = 0;
  /** Since when a flight has been going nowhere (the pathfinder not moving), or null. */
  private fleeStillSince: number | null = null;
  /** Until when we stand and fight because running isn't working. */
  private standUntil = 0;
  /** Where we stood lately, on the ground, a couple of blocks apart. */
  private trail: Vec3[] = [];
  /** The fight under way, for the record: whom, from what health, the swings made and the blows that landed. */
  private bout: Bout | null = null;
  /** The last fight, as recorded when it ended. */
  private lastBout: Record<string, unknown> | null = null;
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
    // mineflayer-pvp's own event, once for each swing it makes.
    (this.bot as unknown as NodeJS.EventEmitter).on('attackedTarget', this.onSwing);
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.logger.warn({ module: 'reflex', err: String(err) }, 'reflex tick failed'));
    }, this.opts.tickMs ?? 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Nothing of a danger outlives the watch on it: started again, it begins from nothing. Said to no one: one stopped
    // by a death got away from nothing.
    if (this.mode !== 'idle') this.reset('stopped');
    this.bot.off('health', this.onHealth);
    this.bot.off('entityHurt', this.onEntityHurt);
    this.bot.off('path_reset', this.onPathReset);
    this.bot.off('playerCollect', this.onCollect);
    (this.bot as unknown as NodeJS.EventEmitter).off('attackedTarget', this.onSwing);
  }

  private readonly onSwing = (): void => {
    if (this.bout) this.bout.swings++;
  };

  /** The fight under way, or else the last one, as a record: for a death's post-mortem. */
  fightRecord(): Record<string, unknown> | null {
    return this.bout ? { ...this.describeBout(this.bout), ended: 'under way' } : this.lastBout;
  }

  private describeBout(b: Bout): Record<string, unknown> {
    return {
      foe: b.foe,
      seconds: Math.round((Date.now() - b.since) / 100) / 10,
      health: `${Math.round(b.health)} to ${Math.round(this.bot.health)}`,
      weapon: b.weapon,
      swings: b.swings,
      landed: b.landed,
      closest: Math.round(b.closest * 10) / 10,
    };
  }

  private endBout(ended: string): void {
    if (!this.bout) return;
    this.lastBout = { ...this.describeBout(this.bout), ended };
    this.bout = null;
    this.logger.info({ module: 'reflex', ...this.lastBout }, 'a fight');
  }

  /**
   * The health at or below which we run. Against monsters only, a weapon in hand lowers it (owner request, 2026-10-24:
   * a zombie or a skeleton killed beats running from it, armed and not low on health): with a stone weapon or better,
   * an average agent fights on down to about three hearts; with a wooden one, four; unarmed, or with a person among
   * them, as before.
   */
  fleeThreshold(threats: readonly Entity[] = []): number {
    const caution = this.hooks.caution();
    const quirk = reflexDelta(this.hooks.quirks(), 'flee');
    const mobsOnly = threats.length > 0 && !threats.some(isPlayer);
    const tier = mobsOnly ? weaponTier(bestWeapon(this.bot)?.name) : 0;
    if (tier >= ARMED_TIER) return clamp(4 + 4 * caution + quirk, 3, 10);
    if (tier >= 1) return clamp(5 + 6 * caution + quirk, 3, 14);
    return clamp(6 + 8 * caution + quirk, 3, 18);
  }

  private readonly onHealth = (): void => {
    const h = this.bot.health;
    if (h < this.lastHealth) {
      const damage = this.lastHealth - h;
      if (this.mode === 'flee') this.fleeHits = [...this.fleeHits.filter((x) => Date.now() - x < 10_000), Date.now()];
      this.swings.attribute(this.bot.entity, (att) => {
        if (!this.timer) return;
        const name = att.attacker ? entityLabel(att.attacker) : null;
        if (att.attacker) this.recentAttackers.set(att.attacker.id, { entity: att.attacker, ts: Date.now() });
        this.hooks.onAttacked(name, damage, att.kind);
      });
    }
    this.lastHealth = h;
  };

  private readonly onEntityHurt = (e: Entity): void => {
    if (this.bout && e.id === this.bout.id) this.bout.landed++;
    // A mob that was after us (or that we are fighting), hit by someone else: they helped us fight (§6.3 deed).
    const fighting = this.mode === 'fight' ? pvp(this.bot).target : undefined;
    if (!isPlayer(e) && (this.recentAttackers.has(e.id) || fighting?.id === e.id)) {
      this.swings.attribute(e, ({ attacker }) => {
        if (this.timer && attacker && attacker !== this.bot.entity && isPlayer(attacker) && attacker.username) this.hooks.onHelpedFight?.(attacker.username);
      });
      return;
    }
    const ally = e.username;
    if (e === this.bot.entity || !isPlayer(e) || !ally) return;
    if (this.mode === 'fight' && pvp(this.bot).target?.id === e.id) this.reckon(e);
    this.swings.attribute(e, ({ attacker }) => {
      // Asked once the attacker is known: whether to step in can depend on who is attacking.
      if (!this.timer || !attacker || attacker === this.bot.entity || !this.hooks.shouldDefend(ally, isPlayer(attacker) ? attacker.username : undefined)) return;
      this.allyAttacks.set(attacker.id, { ally, attacker, ts: Date.now() });
      this.hooks.onAllyAttacked?.(ally, entityLabel(attacker));
    });
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

  /** Water up from the head to a solid block, with no air between: a roof over it. */
  private roofedWater(): boolean {
    const head = this.bot.entity.position.offset(0, 1.6, 0).floored();
    for (let dy = 1; dy <= 6; dy++) {
      const b = this.bot.blockAt(head.offset(0, dy, 0));
      if (!b) return false;
      if (b.name === 'water') continue;
      return isSolid(b);
    }
    return false;
  }

  /**
   * The nearest place to breathe that can be swum to: through water and air only (not through the roof), the first cell
   * found with open air at head height, within `radius` across and four up or two down.
   */
  airSpot(radius = 10): Vec3 | null {
    const bot = this.bot;
    const start = bot.entity.position.floored();
    const passable = (c: Vec3) => {
      const b = bot.blockAt(c);
      return b !== null && !isSolid(b) && b.name !== 'lava';
    };
    const seen = new Set<string>([start.toString()]);
    const queue: Vec3[] = [start];
    // Every loop has a cap (§13): the box searched is at most 21 × 21 × 7.
    for (let i = 0; i < queue.length && i < 4000; i++) {
      const c = queue[i];
      if (!c) break;
      if (i > 0 && isAirLike(bot.blockAt(c.offset(0, 1, 0)))) return c;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const n = c.offset(dx, dy, dz);
        const k = n.toString();
        if (seen.has(k) || Math.abs(n.x - start.x) > radius || Math.abs(n.z - start.z) > radius || n.y - start.y > 4 || start.y - n.y > 2) continue;
        seen.add(k);
        if (passable(n)) queue.push(n);
      }
    }
    return null;
  }

  private headInWater(): boolean {
    const head = this.bot.blockAt(this.bot.entity.position.offset(0, 1.6, 0));
    return head?.name === 'water';
  }

  private inWater(): boolean {
    const e = this.bot.entity as unknown as { isInWater?: boolean };
    return e.isInWater === true || this.bot.blockAt(this.bot.entity.position)?.name === 'water';
  }

  /**
   * In the water with nothing driving the body: tread water, head up (a player holds jump, or sinks; a long wait for
   * the next thought would drown them), and after a while with nothing to do, swim for the nearest shore: straight
   * there, facing it with forward and jump held, as a player swims (the pathfinder plans no way through deep water).
   * Tick by tick, so a threat still comes first.
   */
  private tread(now: number): void {
    const bot = this.bot;
    const adrift = this.hooks.isIdle() && !bot.pathfinder.isMoving() && this.inWater();
    if (!adrift) {
      if (this.treading) bot.setControlState('jump', false);
      if (this.ashore) bot.setControlState('forward', false);
      this.treading = false;
      this.wetSince = null;
      this.ashore = null;
      return;
    }
    this.wetSince ??= now;
    // Every tick: something else (a stop, an unstick) may have let go of it.
    bot.setControlState('jump', true);
    this.treading = true;
    if (now - this.wetSince < ASHORE_AFTER_MS) return;
    // A shore picked again now and then: one that can't be climbed out onto is given up for another look.
    if (!this.ashore || now - this.ashore.since > ASHORE_RETRY_MS) {
      const spot = this.safeSpot(6) ?? this.shoreSpot();
      this.ashore = spot ? { at: spot, since: now } : null;
      if (spot) this.logger.info({ module: 'reflex', shore: spot.toString() }, 'swimming ashore');
    }
    if (!this.ashore) return;
    void bot.lookAt(this.ashore.at.offset(0.5, 1, 0.5), true).catch(() => undefined);
    bot.setControlState('forward', true);
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

  /**
   * The nearest dry ground across open water: along 16 headings, the first column within 32 blocks whose top isn't
   * water, with room to stand on it (a lake wider than `safeSpot` looks).
   */
  private shoreSpot(): Vec3 | null {
    const me = this.bot.entity.position;
    let best: Vec3 | null = null;
    let bestR = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (let r = 2; r <= 32 && r < bestR; r++) {
        const x = Math.floor(me.x + Math.cos(a) * r);
        const z = Math.floor(me.z + Math.sin(a) * r);
        let top: Vec3 | null = null;
        let unloaded = false;
        for (let y = Math.floor(me.y) + 4; y >= Math.floor(me.y) - 6; y--) {
          const b = this.bot.blockAt(new Vec3(x, y, z));
          if (!b) {
            unloaded = true;
            break;
          }
          if (b.name === 'water' || b.name === 'lava' || !isAirLike(b)) {
            top = b.name === 'water' || b.name === 'lava' ? null : new Vec3(x, y + 1, z);
            break;
          }
        }
        if (unloaded) break;
        if (!top) continue;
        if (isAirLike(this.bot.blockAt(top)) && isAirLike(this.bot.blockAt(top.offset(0, 1, 0)))) {
          best = top;
          bestR = r;
        }
        break;
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
      // Grounded and well below us (we are up on something): it can't reach.
      if (outOfReach(e, me)) continue;
      const r = e.name === 'creeper' ? radius + 2 : shoots(e) ? Math.max(radius, SHOT_RANGE) : radius;
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
      if (outOfReach(cur, me)) continue;
      if (cur.username && this.hooks.settled?.(cur.username, a.ts)) continue;
      out.set(id, cur);
    }
    return [...out.values()].sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  }

  private shouldFlee(threats: Entity[]): boolean {
    const me = this.bot.entity.position;
    const health = this.bot.health;
    const fleeAt = this.fleeThreshold(threats) + Math.max(0, ...threats.map((t) => this.hooks.fearBoost?.(entityLabel(t)) ?? 0));
    if (health <= fleeAt) return true;
    if (threats.some((e) => e.name === 'creeper' && e.position.distanceTo(me) <= 5)) return true;
    if (threats.some((e) => e.name === 'warden')) return true;
    // Archers shoot whoever runs across open ground: armed and well enough, close in on them instead. Not on a
    // drowned: closing in on one is going into the water after it.
    // One that couldn't be got at lately is run from: out of its sight is what stops the arrows.
    const now = Date.now();
    if (threats.some((e) => (this.unreachable.get(e.id) ?? 0) > now)) return true;
    if (threats.every((e) => shoots(e) && e.name !== 'drowned') && bestWeapon(this.bot)) return false;
    if (threats.some((e) => e.name === 'drowned' && shoots(e))) return true;
    const players = threats.filter(isPlayer);
    if (players.some((p) => !this.hooks.mayFightBack(p.username ?? ''))) return true;
    // A damage race we would lose before reaching the flee threshold: cautious people want a wider margin. Those in
    // sight count too, joining in as the fight goes on: one zombie is a fight, three about at night are not (an agent
    // took on one with a pickaxe, the second came, and running was too late).
    const expected = expectedFightDamage({
      threats: this.inTheWay(threats).map((e) => ({
        name: isPlayer(e) ? 'player' : (e.name ?? ''),
        heldItem: (e as unknown as { heldItem?: { name: string } | null }).heldItem?.name ?? null,
        // A person's hearts can't be seen (§17.4): reckon them at full health.
        hp: isPlayer(e) ? undefined : entityHealth(this.bot, e),
      })),
      weapon: bestToHitWith(this.bot)?.name ?? null,
      armor: armorPoints(equippedArmor(this.bot)),
      combat: this.hooks.combat(),
      difficulty: asDifficulty(this.bot.game.difficulty),
    });
    return expected > (health - fleeAt) * (1.3 - 0.6 * this.hooks.caution());
  }

  /** §21.3: novices hit whatever is nearest; trained fighters finish their target unless an attacker is closer. */
  /** A blow landed on someone we're fighting back: reckoned from our weapon and the armor they visibly wear. */
  private reckon(e: Entity): void {
    const eq = (e as unknown as { equipment?: ({ name: string } | null | undefined)[] }).equipment ?? [];
    const blow = reckonBlow(this.bot.heldItem?.name, eq.slice(2).filter((i): i is { name: string } => Boolean(i)).map((i) => i.name), this.hooks.combat());
    const now = Date.now();
    const d = this.dealt.get(e.id);
    this.dealt.set(e.id, { dealt: this.reckoned(e.id, now) + blow, last: blow, at: now, ...(d?.calledOffAt !== undefined ? { calledOffAt: d.calledOffAt } : {}) });
  }

  private reckoned(id: number, now: number): number {
    const d = this.dealt.get(id);
    return d ? Math.max(0, d.dealt - (REGEN_PER_S * (now - d.at)) / 1000) : 0;
  }

  /** One more blow, a critical one, could finish them, and we haven't called it off on them already lately. */
  private beatenFoe(e: Entity): boolean {
    const d = this.dealt.get(e.id);
    const now = Date.now();
    if (!d || (d.calledOffAt !== undefined && now - d.calledOffAt < CALLED_OFF_MS)) return false;
    return beaten(this.reckoned(e.id, now), d.last);
  }

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
    this.reset(summary);
    this.hooks.onDangerCleared(summary);
  }

  /** A danger let go of: the fight, the run and the controls with it. */
  private reset(summary: string): void {
    this.endBout(summary);
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
    this.airAt = null;
    this.perchSince = 0;
    this.currentSource = '';
    this.fleeHits = [];
    this.fleeStillSince = null;
    this.standUntil = 0;
  }

  private fight(target: Entity, kind: 'fight' | 'defend'): void {
    const p = pvp(this.bot);
    if (p.target?.id === target.id && this.mode === 'fight') return;
    this.mode = 'fight';
    this.announce(kind, target.name === 'player' ? 'attacker' : (target.name ?? 'mob'), target);
    if (this.bout?.id !== target.id) {
      this.endBout('another foe');
      this.bout = { foe: entityLabel(target), id: target.id, since: Date.now(), health: this.bot.health, weapon: 'hand', swings: 0, landed: 0, closest: target.position.distanceTo(this.bot.entity.position) };
    }
    // Reaction jitter: 400 ms × (1 − combat) + 50 ms (§21.3).
    const delay = 400 * (1 - this.hooks.combat()) + 50;
    setTimeout(() => {
      void equipBestWeapon(this.bot)
        .catch(() => null)
        .then(() => {
          if (this.bout?.id === target.id) this.bout.weapon = this.bot.heldItem?.name ?? 'hand';
          if (this.mode === 'fight') p.attack(target);
        });
    }, delay);
  }

  /** Getting away begins (a run, a hole closed over, a climb): the mode, a fresh count of hits, the alarm raised. */
  private takeFlight(threats: readonly Entity[]): void {
    const nearest = threats[0];
    if (!nearest || this.mode === 'flee') return;
    try {
      // At once: pvp's stop() leaves the pathfinder a stop that would wipe the flight's first goal.
      pvp(this.bot).forceStop();
    } catch {
      // not fighting
    }
    this.mode = 'flee';
    this.fleePlannedAt = 0;
    this.fleeHits = [];
    this.fleeStillSince = null;
    this.fleeSince = Date.now();
    // Running away is a run: the skills walk (sprinting costs food). And a run, not a dig: stopping to mine a way
    // through stone with something at your back is no escape.
    if (!this.running) {
      this.running = createMovements(this.bot, this.hooks.quirks(), { sprint: true });
      this.running.canDig = false;
    }
    this.bot.pathfinder.setMovements(carefulWhenHurt(this.bot, this.running));
    this.announce('flee', nearest.name === 'player' ? 'attacker' : (nearest.name ?? 'mob'), nearest);
    const person = threats.find((t) => isPlayer(t) && t.username);
    if (person?.username) this.hooks.onYield?.(person.username);
  }

  private flee(threats: Entity[]): void {
    const nearest = threats[0];
    if (!nearest) return;
    this.takeFlight(threats);
    // Re-plan as the chasers move; a fixed spot beats GoalInvert, which stalls on open ground.
    const now = Date.now();
    const moving = this.bot.pathfinder.isMoving();
    this.fleeStillSince = moving ? null : (this.fleeStillSince ?? now);
    if (now - this.fleePlannedAt < 1500 && moving) return;
    this.fleePlannedAt = now;
    // Back the way we came first: ground we know is open. Clear of the others in sight too: an agent knocked away by
    // one creeper ran back along its trail into a second.
    const avoid = this.inTheWay(threats);
    const back = this.trailSpot(avoid);
    if (back) {
      this.bot.pathfinder.setGoal(new goals.GoalNear(back.x, back.y, back.z, 1));
      return;
    }
    const spot = this.fleeSpot(avoid);
    if (spot) this.bot.pathfinder.setGoal(new goals.GoalXZ(spot.x, spot.z));
    else this.bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(nearest, 20)), true);
  }

  /**
   * Still being caught (two blows in six seconds, once the run has had a fair start) or going nowhere, with the
   * attacker close. The blows of the moment one turns to run don't say the run is failing.
   */
  private cornered(now: number, threats: readonly Entity[]): boolean {
    const me = this.bot.entity.position;
    if (now - this.fleeSince < 2500 || !threats.some((t) => t.position.distanceTo(me) < 4)) return false;
    const hits = this.fleeHits.filter((x) => now - x < 6000 && x - this.fleeSince > 1500).length;
    const stuck = this.fleeStillSince !== null && now - this.fleeStillSince > 2000;
    return hits >= 2 || stuck;
  }

  /**
   * What pillarUp needs: only what can't climb nor shoot after us, and none of it above us (up out of a hole is up into
   * what waits at its mouth); a start on it; three blocks on hand, ground under and room over.
   */
  private canPillar(threats: readonly Entity[]): boolean {
    const bot = this.bot;
    if (threats.length === 0 || !threats.every((t) => GROUNDED.test(t.name ?? '') && !shoots(t))) return false;
    if (bot.inventory.items().filter((i) => isCover(i.name)).reduce((a, i) => a + i.count, 0) < PERCH_HEIGHT) return false;
    const me = bot.entity.position;
    const base = me.floored();
    if (threats.some((t) => t.position.y > base.y + 0.5)) return false;
    if (threats.some((t) => Math.hypot(t.position.x - me.x, t.position.z - me.z) < PERCH_START)) return false;
    for (let dy = 2; dy <= PERCH_HEIGHT + 1; dy++) if (!isAirLike(bot.blockAt(base.offset(0, dy, 0)))) return false;
    // Open ground about it: something to stand on beside the pillar's top is a way to reach across (one pillared on a
    // hillside, its top no higher than the ground a step uphill, and the zombies hit it from there).
    for (const [dx, dz] of AROUND) for (let dy = 1; dy <= PERCH_HEIGHT; dy++) if (isSolid(bot.blockAt(base.offset(dx, dy, dz)))) return false;
    return isSolid(bot.blockAt(base.offset(0, -1, 0)));
  }

  /**
   * From what neither climbs nor shoots (zombies and the like), with blocks on hand and room overhead: three blocks up
   * on a pillar of them, out of its reach, as a player does: look down, jump, a block under the feet at the top of the
   * jump (one running from a zombie at night was caught, at 5 health, with 20 cobblestone on her). True if up.
   */
  private async pillarUp(threats: readonly Entity[]): Promise<boolean> {
    const bot = this.bot;
    if (!this.canPillar(threats)) return false;
    const block = () => bot.inventory.items().find((i) => isCover(i.name));
    const base = bot.entity.position.floored();
    this.busy = true;
    this.perchSince = Date.now();
    try {
      try {
        pvp(bot).forceStop();
      } catch {
        // not fighting
      }
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      // A run's way on carries the jump off the block being placed (one sprinting climbed its pillar a block and a
      // half from where it began, onto the hillside): standing still first.
      for (let t = 0; t < 16 && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.03; t++) await new Promise((r) => setTimeout(r, 25));
      for (let tries = 0; tries < PERCH_HEIGHT + 2 && bot.entity.position.y - base.y < PERCH_HEIGHT - 0.01; tries++) {
        const item = block();
        if (!item) break;
        await bot.equip(item, 'hand');
        const from = bot.entity.position.floored();
        const ground = bot.blockAt(from.offset(0, -1, 0));
        if (!ground || !isSolid(ground)) break;
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        bot.setControlState('jump', true);
        const t0 = Date.now();
        while (bot.entity.position.y < from.y + 1.05 && Date.now() - t0 < 700) await new Promise((r) => setTimeout(r, 25));
        bot.setControlState('jump', false);
        await bot.placeBlock(ground, new Vec3(0, 1, 0)).catch(() => undefined);
        const t1 = Date.now();
        while (!bot.entity.onGround && Date.now() - t1 < 700) await new Promise((r) => setTimeout(r, 25));
      }
      return bot.entity.position.y - base.y >= OUT_OF_REACH;
    } catch (err) {
      this.logger.debug({ module: 'reflex', err: String(err) }, 'could not get up a pillar');
      return false;
    } finally {
      bot.clearControlStates();
      this.busy = false;
    }
  }

  /**
   * Walled in on every side with what threatens us above (at a hole's mouth): a block over our head shuts it out, if
   * we carry one. True if the hole was closed.
   */
  private canSeal(threats: readonly Entity[]): boolean {
    const bot = this.bot;
    const feet = bot.entity.position.floored();
    if (threats.length === 0 || !wallsAround(bot, feet)) return false;
    if (!threats.every((t) => t.position.y >= feet.y + 1)) return false;
    const top = feet.offset(0, 2, 0);
    return isAirLike(bot.blockAt(top)) && Boolean(bot.inventory.items().find((i) => isCover(i.name))) && Boolean(referenceFor(bot, top));
  }

  private async sealAbove(threats: readonly Entity[]): Promise<boolean> {
    const bot = this.bot;
    if (!this.canSeal(threats)) return false;
    const top = bot.entity.position.floored().offset(0, 2, 0);
    const block = bot.inventory.items().find((i) => isCover(i.name));
    const r = referenceFor(bot, top);
    if (!block || !r) return false;
    this.busy = true;
    try {
      try {
        pvp(bot).forceStop();
      } catch {
        // not fighting
      }
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // not moving
      }
      bot.clearControlStates();
      await bot.equip(block, 'hand');
      await bot.placeBlock(r.ref, r.face);
      return isSolid(bot.blockAt(top));
    } catch (err) {
      this.logger.debug({ module: 'reflex', err: String(err) }, 'could not close the hole');
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** What the way out keeps clear of: the threats, and every other monster in sight within RUN_AWARE. */
  private inTheWay(threats: readonly Entity[]): Entity[] {
    const me = this.bot.entity.position;
    const out = new Map(threats.map((t) => [t.id, t]));
    for (const e of Object.values(this.bot.entities)) {
      if (e === this.bot.entity || out.has(e.id) || !isHostile(e)) continue;
      if (e.position.distanceTo(me) <= RUN_AWARE && canSee(this.bot, e, RUN_AWARE + 1)) out.set(e.id, e);
    }
    return [...out.values()];
  }

  /** A spot on the way we came, well away from what chases us and not past it: the farthest from them we can reach. */
  private trailSpot(threats: readonly Entity[]): Vec3 | null {
    const me = this.bot.entity.position;
    let best: Vec3 | null = null;
    let bestScore = -Infinity;
    for (const p of this.trail) {
      const d = p.distanceTo(me);
      if (d < 6 || d > 24) continue;
      const fromThem = Math.min(...threats.map((t) => t.position.distanceTo(p)));
      // Not towards them nor past them: farther from each than we are now, and none of them on the way there.
      if (threats.some((t) => t.position.distanceTo(p) <= t.position.distanceTo(me))) continue;
      const way = p.minus(me);
      if (
        threats.some((t) => {
          const to = t.position.minus(me);
          const cos = (to.x * way.x + to.z * way.z) / Math.max(0.01, Math.hypot(to.x, to.z) * Math.hypot(way.x, way.z));
          return cos > 0.5 && Math.hypot(to.x, to.z) < Math.hypot(way.x, way.z);
        })
      )
        continue;
      if (fromThem < 8) continue;
      const score = fromThem - d * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /**
   * A point 14 blocks away, roughly opposite the threats (weighted by closeness), in a loaded chunk; from archers,
   * one out of their line of fire (a tree or a wall between) if there is such a point, nearer ones first.
   */
  private fleeSpot(threats: Entity[]): Vec3 | null {
    const archers = threats.filter(shoots);
    const away = this.fleeSpotAway(threats);
    if (archers.length === 0) return away;
    const me = this.bot.entity.position;
    for (const r of [6, 10, 14]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const p = new Vec3(me.x + Math.cos(a) * r, me.y, me.z + Math.sin(a) * r);
        if (threats.some((t) => t.position.distanceTo(p) < 6) || !this.bot.blockAt(p.floored())) continue;
        if (archers.every((t) => !this.inLineOfFire(t, p))) return p;
      }
    }
    return away;
  }

  /** Whether `shooter` can see a body standing at `p` (an unbroken line from its eyes to head height there). */
  private inLineOfFire(shooter: Entity, p: Vec3): boolean {
    const from = shooter.position.offset(0, 1.5, 0);
    const to = p.offset(0, 1.5, 0);
    const delta = to.minus(from);
    const dist = delta.norm();
    if (dist === 0) return true;
    const hit = (this.bot.world as unknown as { raycast(from: Vec3, dir: Vec3, range: number): { position: Vec3 } | null }).raycast(from, delta.normalize(), dist);
    return !hit;
  }

  private fleeSpotAway(threats: Entity[]): Vec3 | null {
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

  /**
   * Getting away, a place out of reach comes before a run where there is one, as a player takes it: in a hole with it
   * at the mouth, the hole closed over (climbing out is climbing up to it); in the open, from what can't climb nor
   * shoot, up a pillar. True if there.
   */
  private async refuge(threats: Entity[]): Promise<boolean> {
    const bot = this.bot;
    if (this.canSeal(threats)) {
      this.takeFlight(threats);
      if (await this.sealAbove(threats)) {
        this.logger.info({ module: 'reflex', health: Math.round(bot.health), from: threats[0]?.name }, 'in a hole with it at the mouth: closed it over');
        this.clear('closed the hole over');
        return true;
      }
    }
    if (Date.now() - this.perchSince < PERCH_MS || !this.canPillar(threats)) return false;
    this.takeFlight(threats);
    if (await this.pillarUp(threats)) {
      this.logger.info({ module: 'reflex', health: Math.round(bot.health), from: threats[0]?.name }, 'up a pillar out of reach');
      return true;
    }
    // A climb that didn't get up: the run starts now, and with it the count of what catches us running.
    this.fleeSince = Date.now();
    this.fleeHits = [];
    return false;
  }

  private async tick(): Promise<void> {
    const bot = this.bot;
    if (this.busy || !bot.entity || bot.health <= 0) return;
    // 1. Hazards.
    const lava = this.inLava();
    if (!lava && bot.entity.onGround && !this.lavaNear()) this.lastSafe = bot.entity.position.clone();
    if (!lava && bot.entity.onGround && this.mode !== 'flee') {
      const last = this.trail.at(-1);
      if (!last || last.distanceTo(bot.entity.position) >= 2) this.trail = [...this.trail, bot.entity.position.floored()].slice(-TRAIL_MAX);
    }
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
    // Drowning. The air reading alone isn't to be trusted: in a live run three agents drowned without this firing
    // (why is not known; in a test lake the reading falls as it should), so a head under water long enough counts too.
    const now = Date.now();
    const under = this.headInWater();
    const since = under ? (this.underSince ?? now) : null;
    this.underSince = since;
    if (since !== null && (bot.oxygenLevel < 8 || now - since >= SUBMERGED_MS)) {
      this.mode = 'swim';
      this.announce('hazard', 'water');
      bot.setControlState('jump', true);
      // Under a roof, up gets nowhere (an agent drowned in a flooded tunnel holding jump against the stone): swim for
      // the nearest place to breathe, the way we came first.
      if (this.roofedWater()) {
        if (!this.airAt || bot.entity.position.distanceTo(this.airAt) < 0.8) {
          this.airAt = this.airSpot();
          if (this.airAt) this.logger.info({ module: 'reflex', air: this.airAt.toString() }, 'under water with a roof over it: swimming for air');
        }
        if (this.airAt) {
          void bot.lookAt(this.airAt.offset(0.5, 1.2, 0.5), true).catch(() => undefined);
          bot.setControlState('forward', true);
        }
      }
      return;
    }
    if (this.mode === 'escape' || this.mode === 'swim') {
      // Swimming up until the head is out of the water.
      if (this.mode === 'swim' && under) return;
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
    // Fighting back is a brawl too, never to the death: once one more blow, a critical one, could finish them by our
    // reckoning, we call it off (the duel's rule). Should they come at us again, we fight on.
    if (foe?.username && isPlayer(foe) && this.beatenFoe(foe)) {
      const d = this.dealt.get(foe.id);
      if (d) d.calledOffAt = Date.now();
      this.recentAttackers.delete(foe.id);
      this.hooks.onCallOff?.(foe.username);
      this.clear('fight over');
      return;
    }
    const threats = this.threats(this.mode === 'flee' ? 16 : undefined);
    if (threats.length > 0) {
      this.lastThreatAt = Date.now();
      // Once running, keep running until nothing chases within 16 blocks: turning back whenever a straggler
      // drops out of range makes a bot dither between the two.
      const standing = now < this.standUntil && !mustRun(bot, threats);
      if (!standing && (this.mode === 'flee' || this.shouldFlee(threats))) {
        if (await this.refuge(threats)) return;
        // Running that isn't working (it keeps catching us, or there is nowhere to go) turns into a fight, as with
        // anyone cornered: a spider outruns a player, and a tunnel ends.
        if (!(this.mode === 'flee' && !mustRun(bot, threats) && this.cornered(Date.now(), threats))) {
          this.flee(threats);
          return;
        }
        this.standUntil = Date.now() + STAND_MS;
        this.fleeHits = [];
        this.logger.info({ module: 'reflex', health: Math.round(bot.health), from: threats[0]?.name }, 'running is not working: standing to fight');
      }
      const target = this.pickTarget(threats);
      // Closing in on an archer that hasn't come within reach: it can't be got at from here (standing at the edge of what
      // parts us is no fight, and gives it a target).
      const b = this.bout;
      if (target && b && b.id === target.id && shoots(target) && Date.now() - b.since > ARCHER_CHASE_MS && b.closest > 4) {
        this.unreachable.set(target.id, Date.now() + ARCHER_AVOID_MS);
        this.logger.info({ module: 'reflex', health: Math.round(bot.health), from: target.name, closest: Math.round(b.closest) }, 'an archer out of reach: out of its sight instead');
        this.standUntil = 0;
        this.flee(threats);
        return;
      }
      if (target) this.fight(target, 'fight');
      const foeNow = pvp(bot).target;
      if (this.bout && foeNow?.id === this.bout.id) this.bout.closest = Math.min(this.bout.closest, foeNow.position.distanceTo(bot.entity.position));
      return;
    }
    // 3. Defend allies.
    for (const [id, a] of this.allyAttacks) {
      const cur = bot.entities[id];
      if (!cur || now - a.ts > 6000 || cur.position.distanceTo(bot.entity.position) > 16 || (cur.username && this.hooks.settled?.(cur.username, a.ts))) {
        this.allyAttacks.delete(id);
        continue;
      }
      if (bot.health > this.fleeThreshold([cur]) && (!isPlayer(cur) || this.hooks.mayFightBack(cur.username ?? ''))) {
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
    this.tread(now);
    // 5. Upkeep (eat, pick up, armor) only while no skill holds the hands: an equip in the middle of a skill's
    // equip-then-use would place bread instead of dirt. Starving is the exception; the skill is asked to yield.
    const eatAt = (this.opts.eatAt ?? 14) + reflexDelta(this.hooks.quirks(), 'eat');
    const hungry = bot.food <= eatAt || (bot.health < 14 && bot.food < 18);
    const starving = bot.food <= 6 || (bot.health < 8 && bot.food < 18);
    const idle = this.hooks.isIdle();
    if (hungry && (idle || starving)) {
      const food = bestFood(bot, bot.food <= 6);
      // Raw meat that cooks waits for the furnace while hunger isn't pressing, as a player keeps it.
      if (food && (!COOKS.has(food.name) || bot.food <= 8 || bot.health < 10)) {
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
    // Between options (thinking what to do next), not frozen: a glance at someone near, or just around.
    if (this.hooks.between?.() && now - this.lastGlance > this.glanceEvery) {
      this.lastGlance = now;
      this.glanceEvery = 2000 + Math.random() * 3000;
      const me = bot.entity.position;
      const someone = Object.values(bot.players)
        .map((p) => p.entity)
        .filter((e): e is Entity => Boolean(e) && e !== bot.entity && e.position.distanceTo(me) <= 10)
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
      const look = someone && Math.random() < 0.7 ? bot.lookAt(someone.position.offset(0, someone.height ?? 1.6, 0), false) : bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.6, (Math.random() - 0.6) * 0.4, false);
      await look.catch(() => undefined);
      return;
    }
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
