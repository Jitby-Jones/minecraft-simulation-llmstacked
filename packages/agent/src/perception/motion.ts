// Motion (owner request, 2026-10-24: complete senses). How each creature in view moves, as a player sees it: how fast
// and which way, on the ground or off it (how high, for how long, rising or falling), in water, on a ladder, riding,
// gliding; a jump from one place to another that no walking explains; something that turns up close by out of
// nowhere, or vanishes in plain sight. Code measures; what it means is for the mind (mind/expectations.ts weighs it
// against what the agent knows is possible, and the model makes sense of it).

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { MotionKind } from '@agora/shared';
import { Vec3 } from 'vec3';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  supported: boolean;
}

/** What a player sees of how something moves, now. */
export interface Motion {
  id: number;
  /** Horizontal speed, m/s, over about the last second. */
  speed: number;
  /**
   * Horizontal speed kept up over the last two seconds or so (absent until there are that many): a burst (a jump off
   * a sprint, a knock back, a lagging player catching up) is not something moving fast.
   */
  sustained?: number;
  /** Vertical speed, m/s (up is +). */
  vy: number;
  /** Standing on something (a block under its feet). */
  supported: boolean;
  /** Seconds off the ground with nothing under it (0 when on the ground). */
  airborneSec: number;
  /** Its feet above the first solid block under it (only measured off the ground). */
  aboveGround: number;
  medium: 'air' | 'water' | 'lava' | 'climbable' | 'riding' | 'gliding';
  /** Unit vector of where it is going (horizontal), when it moves. */
  heading: Vec3 | null;
  motion: MotionKind;
  /** It just moved this far in an instant, further than anything can walk, run or fall in that time. */
  jumpedM?: number;
  /** Where it was just before such a jump. */
  jumpedFrom?: Vec3;
  /** Inside a solid block (its feet and head both in one). */
  insideBlock?: string;
}

const KEEP_MS = 3000;
/** Speeds are measured over at least this long (one 250 ms tick is too noisy). */
const SPAN_MS = 700;
/** How long a speed is kept up to count as sustained. */
const SUSTAINED_MS = 2000;
/** Faster than this between two looks is no walk, run, fall or glide: something jumped there. */
const BLINK_MPS = 40;
const BLINK_MIN_M = 6;
const CLIMBABLE = /^(ladder|vine|scaffolding|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|cave_vines|cave_vines_plant)$/;
const FLUID = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;

function solid(bot: Bot, x: number, y: number, z: number): string | null {
  const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  if (!b || b.boundingBox !== 'block') return null;
  // Inside what the block takes up, not just its cell: a zombie among the thin points of a dripstone cave stands in
  // their cells (one was "inside solid pointed dripstone, right in the block", an urgent surprise, in the middle of a
  // fight).
  const shapes = (b as unknown as { shapes?: number[][] }).shapes;
  if (!shapes || shapes.length === 0) return b.name;
  const [lx, ly, lz] = [x - Math.floor(x), y - Math.floor(y), z - Math.floor(z)];
  return shapes.some((sh) => lx >= (sh[0] ?? 0) && lx <= (sh[3] ?? 1) && ly >= (sh[1] ?? 0) && ly <= (sh[4] ?? 1) && lz >= (sh[2] ?? 0) && lz <= (sh[5] ?? 1)) ? b.name : null;
}

/** Something under its feet: any block with a collision box beneath the corners of its footprint. */
export function isSupported(bot: Bot, e: Entity): boolean {
  const w = ((e as unknown as { width?: number }).width ?? 0.6) / 2 - 0.05;
  const p = e.position;
  const y = p.y - 0.08;
  for (const [dx, dz] of [
    [0, 0],
    [-w, -w],
    [w, -w],
    [-w, w],
    [w, w],
  ] as const) {
    if (solid(bot, p.x + dx, y, p.z + dz)) return true;
  }
  return false;
}

/** How far its feet are above the first solid block under it (up to `max`). */
export function heightAboveGround(bot: Bot, pos: { x: number; y: number; z: number }, max = 48): number {
  const x = Math.floor(pos.x);
  const z = Math.floor(pos.z);
  const top = Math.floor(pos.y - 0.01);
  for (let y = top; y > top - max; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return max;
    if (b.boundingBox === 'block' || b.name === 'water' || b.name === 'lava') return Math.max(0, Math.round((pos.y - (y + 1)) * 10) / 10);
  }
  return max;
}

function mediumOf(bot: Bot, e: Entity): Motion['medium'] {
  if ((e as unknown as { vehicle?: unknown }).vehicle) return 'riding';
  // Entity flags (metadata 0): 0x80 is gliding with elytra.
  const flags = (e.metadata as unknown[] | undefined)?.[0];
  if (typeof flags === 'number' && (flags & 0x80) !== 0) return 'gliding';
  const feet = bot.blockAt(e.position.floored());
  const body = bot.blockAt(e.position.offset(0, 0.9, 0).floored());
  const names = [feet?.name ?? '', body?.name ?? ''];
  if (names.some((n) => n === 'lava')) return 'lava';
  if (names.some((n) => FLUID.test(n)) || (feet as unknown as { getProperties?: () => Record<string, unknown> } | null)?.getProperties?.().waterlogged === true) return 'water';
  if (names.some((n) => CLIMBABLE.test(n))) return 'climbable';
  return 'air';
}

/** The words a player would use for it. */
function kindOfMotion(m: Omit<Motion, 'motion'>): MotionKind {
  if (m.medium === 'riding') return 'riding';
  if (m.medium === 'gliding') return 'gliding';
  if (m.medium === 'water' || m.medium === 'lava') return 'swimming';
  if (m.medium === 'climbable' && Math.abs(m.vy) > 0.3) return 'climbing';
  if (!m.supported) {
    if (m.vy < -2.5) return 'falling';
    if (m.airborneSec > 1.2) return 'flying';
    return 'jumping';
  }
  if (m.speed > 4.6) return 'running';
  if (m.speed > 0.6) return 'walking';
  return 'still';
}

/** The server's word on each move, that the one moving is on the ground. */
const MOVES = ['rel_entity_move', 'entity_move_look', 'sync_entity_position'] as const;

/** Tracks how every creature in view moves, one sample a perception tick. */
export class MotionTracker {
  private readonly samples = new Map<number, Sample[]>();
  private readonly offGroundSince = new Map<number, number>();
  private readonly last = new Map<number, Motion>();
  /**
   * Those the game showed on the ground since the last look. Hop after hop up a hill, each landing falls between two
   * looks: every look found it in the air, and agents took a zombie climbing a slope, a cow, Ada at work, for floating.
   */
  private readonly landed = new Set<number>();

  constructor(private readonly bot: Bot) {
    const client = (bot as unknown as { _client?: { on(ev: string, f: (p: { entityId?: number; onGround?: boolean }) => void): void } })._client;
    for (const ev of MOVES) {
      client?.on(ev, (p) => {
        if (p.onGround && p.entityId !== undefined) this.landed.add(p.entityId);
      });
    }
  }

  /** Takes a sample of each of these entities now, and forgets those no longer about. */
  update(entities: readonly Entity[], now: number): void {
    const alive = new Set<number>();
    for (const e of entities) {
      alive.add(e.id);
      const supported = isSupported(this.bot, e);
      // On the ground now, or at some moment since the last look.
      const grounded = this.landed.delete(e.id) || supported;
      const list = this.samples.get(e.id) ?? [];
      const prev = list.at(-1);
      list.push({ t: now, x: e.position.x, y: e.position.y, z: e.position.z, supported: grounded });
      while (list.length > 2 && now - (list[0] as Sample).t > KEEP_MS) list.shift();
      this.samples.set(e.id, list);
      if (grounded) this.offGroundSince.delete(e.id);
      else if (!this.offGroundSince.has(e.id)) this.offGroundSince.set(e.id, prev && !prev.supported ? prev.t : now);
      this.last.set(e.id, this.measure(e, list, now, supported));
    }
    for (const id of [...this.samples.keys()]) {
      if (alive.has(id)) continue;
      this.samples.delete(id);
      this.offGroundSince.delete(id);
      this.last.delete(id);
    }
    // Landings of those out of view are nothing to us.
    this.landed.clear();
  }

  of(id: number): Motion | undefined {
    return this.last.get(id);
  }

  private measure(e: Entity, list: readonly Sample[], now: number, supported: boolean): Motion {
    const cur = list.at(-1) as Sample;
    const prev = list.length > 1 ? (list.at(-2) as Sample) : null;
    // Speed over about the last second (at least SPAN_MS back), from where it was then.
    let base = cur;
    for (let i = list.length - 2; i >= 0; i--) {
      base = list[i] as Sample;
      if (now - base.t >= SPAN_MS) break;
    }
    const dt = Math.max(0.001, (cur.t - base.t) / 1000);
    const dx = cur.x - base.x;
    const dz = cur.z - base.z;
    let speed = base === cur ? 0 : Math.hypot(dx, dz) / dt;
    let vy = base === cur ? 0 : (cur.y - base.y) / dt;
    const far = list.find((s) => now - s.t <= SUSTAINED_MS + 400) ?? cur;
    const farDt = (cur.t - far.t) / 1000;
    let sustained = farDt * 1000 >= SUSTAINED_MS - 300 ? Math.hypot(cur.x - far.x, cur.z - far.z) / farDt : undefined;
    // A blink: further between two looks than anything moves.
    let jumpedM: number | undefined;
    let jumpedFrom: Vec3 | undefined;
    if (prev) {
      const d = Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z);
      const step = Math.max(0.05, (cur.t - prev.t) / 1000);
      if (d >= BLINK_MIN_M && d / step > BLINK_MPS) {
        jumpedM = Math.round(d);
        jumpedFrom = new Vec3(Math.round(prev.x), Math.round(prev.y), Math.round(prev.z));
        // The jump says nothing of how fast it moves.
        speed = 0;
        vy = 0;
        sustained = undefined;
      }
    }
    const off = this.offGroundSince.get(e.id);
    const airborneSec = supported || off === undefined ? 0 : Math.round(((now - off) / 1000) * 10) / 10;
    const medium = mediumOf(this.bot, e);
    const aboveGround = supported ? 0 : heightAboveGround(this.bot, e.position);
    const heading = speed > 0.4 ? new Vec3(dx, 0, dz).normalize() : null;
    const feet = solid(this.bot, e.position.x, e.position.y + 0.1, e.position.z);
    const head = solid(this.bot, e.position.x, e.position.y + 1.5, e.position.z);
    const m: Omit<Motion, 'motion'> = {
      id: e.id,
      speed: Math.round(speed * 10) / 10,
      ...(sustained !== undefined ? { sustained: Math.round(sustained * 10) / 10 } : {}),
      vy: Math.round(vy * 10) / 10,
      supported,
      airborneSec,
      aboveGround,
      medium,
      heading,
      ...(jumpedM !== undefined && jumpedFrom ? { jumpedM, jumpedFrom } : {}),
      ...(feet && head && feet === head ? { insideBlock: feet } : {}),
    };
    return { ...m, motion: kindOfMotion(m) };
  }
}
