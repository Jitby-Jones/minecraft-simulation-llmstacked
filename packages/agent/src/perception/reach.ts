// Whether something on foot could get to us from where it stands, as a player sees it from where they are: up a
// pillar, down a hole, in a room shut on every side. The walk is worked out back from the cells beside us where a body
// two high could strike us (no higher or lower than a block), over the cells such a body can stand in, the way one walks:
// a step up, a drop of up to three, wading and swimming, a ladder or vines, an open door or gate. Nothing dug, built,
// jumped across or opened. Only a pocket shut in and searched to its end says there is no way; out in the open nothing
// is said. A sense, never what to do about it.

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

type Kind = 'free' | 'fluid' | 'solid' | 'tall' | 'bad' | 'unloaded';

/** How far round us the walk is looked at, across and up or down. */
const ACROSS = 12;
const UPDOWN = 8;
/** At most this many cells: past it, nothing is said. */
const MAX_CELLS = 3000;
const FLUID = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass|ladder|vine|scaffolding|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|cave_vines|cave_vines_plant)$/;
const BAD = /^(lava|fire|soul_fire|powder_snow)$/;
/** Too high to step up onto: a fence, a wall, a gate. */
const TALL = /(_fence|_wall|_fence_gate)$/;
const OPENS = /(_door|_fence_gate|_trapdoor)$/;
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

class Ground {
  private readonly kinds = new Map<string, Kind>();
  constructor(private readonly bot: Bot) {}

  kind(x: number, y: number, z: number): Kind {
    const k = keyOf(x, y, z);
    let v = this.kinds.get(k);
    if (v === undefined) {
      v = this.read(x, y, z);
      this.kinds.set(k, v);
    }
    return v;
  }

  private read(x: number, y: number, z: number): Kind {
    const b = this.bot.blockAt(new Vec3(x, y, z));
    if (!b) return 'unloaded';
    if (FLUID.test(b.name)) return 'fluid';
    if (BAD.test(b.name)) return 'bad';
    if (OPENS.test(b.name)) {
      const open = (b as unknown as { getProperties?: () => Record<string, unknown> }).getProperties?.().open;
      if (open === true || open === 'true') return 'free';
      return TALL.test(b.name) ? 'tall' : 'solid';
    }
    if (b.boundingBox === 'empty') return 'free';
    return TALL.test(b.name) ? 'tall' : 'solid';
  }

  passable(x: number, y: number, z: number): boolean {
    const k = this.kind(x, y, z);
    return k === 'free' || k === 'fluid';
  }

  /** A body two high can be here: room for it, and ground under it (or water or a ladder to hold it). */
  standable(x: number, y: number, z: number): boolean {
    if (!this.passable(x, y, z) || !this.passable(x, y + 1, z)) return false;
    return this.kind(x, y, z) === 'fluid' || this.kind(x, y - 1, z) === 'solid';
  }

  /** Something here we can't see past (the ground not loaded). */
  unknown(x: number, y: number, z: number): boolean {
    return this.kind(x, y, z) === 'unloaded' || this.kind(x, y + 1, z) === 'unloaded' || this.kind(x, y - 1, z) === 'unloaded';
  }
}

/** The cell a body standing at `pos` is in (a slab or a jump allowed for); null if none. */
function cellOf(g: Ground, pos: Vec3): Vec3 | null {
  const x = Math.floor(pos.x);
  const z = Math.floor(pos.z);
  const y0 = Math.floor(pos.y + 0.5);
  for (const y of [y0, y0 - 1, y0 - 2]) if (g.standable(x, y, z)) return new Vec3(x, y, z);
  return null;
}

/** A body at `p` gets into `q` beside it in one move: a walk, a step up with room to jump, or a drop down open air. */
function moves(g: Ground, p: Vec3, q: Vec3): boolean {
  if (q.y === p.y) return true;
  if (q.y === p.y + 1) return g.passable(p.x, p.y + 2, p.z);
  for (let y = q.y + 2; y <= p.y + 1; y++) if (!g.passable(q.x, y, q.z)) return false;
  return true;
}

/**
 * For each place asked about (where a creature stands): true if a body could walk from there to within a blow of us,
 * false if there is no way (our pocket shut in and searched to its end), null if that can't be told.
 */
export function waysOnFoot(bot: Bot, from: readonly Vec3[]): (boolean | null)[] {
  const g = new Ground(bot);
  const me = cellOf(g, bot.entity.position);
  if (!me) return from.map(() => null);
  const cells = from.map((p) => cellOf(g, p));
  const wanted = new Set(cells.filter((c): c is Vec3 => c !== null && Math.abs(c.x - me.x) <= ACROSS && Math.abs(c.z - me.z) <= ACROSS).map((c) => keyOf(c.x, c.y, c.z)));
  const reached = new Set<string>();
  const queue: Vec3[] = [];
  let complete = true;
  const reach = (c: Vec3) => {
    const k = keyOf(c.x, c.y, c.z);
    if (reached.has(k)) return;
    reached.add(k);
    wanted.delete(k);
    queue.push(c);
    // At the edge of what is looked at: what lies past it is not known.
    if (Math.abs(c.x - me.x) >= ACROSS || Math.abs(c.z - me.z) >= ACROSS || Math.abs(c.y - me.y) >= UPDOWN || g.unknown(c.x, c.y, c.z)) complete = false;
  };
  // Within a blow of us: a cell beside us, no more than a block higher or lower (a zombie two below one's feet can't
  // reach up to strike); not our own, which we stand in.
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dz === 0) continue;
        const c = me.offset(dx, dy, dz);
        if (g.standable(c.x, c.y, c.z)) reach(c);
      }
  for (let i = 0; i < queue.length; i++) {
    if (wanted.size === 0) break;
    if (i >= MAX_CELLS) {
      complete = false;
      break;
    }
    const q = queue[i] as Vec3;
    for (const [dx, dz] of SIDES) {
      for (const dy of [-1, 0, 1, 2, 3]) {
        const p = q.offset(dx, dy, dz);
        if (reached.has(keyOf(p.x, p.y, p.z)) || !g.standable(p.x, p.y, p.z) || !moves(g, p, q)) continue;
        reach(p);
      }
    }
    // Up or down through water or a ladder.
    for (const dy of [-1, 1]) {
      const p = q.offset(0, dy, 0);
      const wet = (c: Vec3) => g.kind(c.x, c.y, c.z) === 'fluid';
      if (reached.has(keyOf(p.x, p.y, p.z)) || !g.standable(p.x, p.y, p.z)) continue;
      if (dy < 0 ? wet(p) : wet(q) || wet(p)) reach(p);
    }
  }
  if (wanted.size > 0 && queue.length > MAX_CELLS) complete = false;
  return cells.map((c) => {
    if (!c) return null;
    if (reached.has(keyOf(c.x, c.y, c.z))) return true;
    if (Math.abs(c.x - me.x) > ACROSS || Math.abs(c.z - me.z) > ACROSS) return null;
    return complete ? false : null;
  });
}
