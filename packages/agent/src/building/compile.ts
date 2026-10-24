// A design (design.ts) turned into blocks: the walls of its parts (one shell where parts meet, an L or a T), posts at
// the corners and beams between floors, floors and a ladder up, windows, the door with a light either side, the
// roof, what is inside, its features and details. Roofs of parts of one height are one surface: each column's height
// is the highest of the roofs over it, so where two gables meet there is a valley and a ridge, not two roofs through
// each other; a stair faces up the slope, ridges and peaks are slabs, gable ends are walled up under the slope. The
// blocks come in an order a builder can place them in: each one against one already there or on the ground, what
// hangs or stands on something after that thing; a roof with nothing to go against gets a block of its own under it.
// What can't be placed at all is an error of the design, said so (`problems`).
//
// Coordinates: x east, y up, z south. y 0 is the ground's top layer (the foundation goes in it), below 0 underground.

import { type Design, type Part, type Side } from './design';
import { type BlockState, type Facing, FACINGS, facingVec, formatState, opposite, parseState, turnRight } from './state';

export interface Cell {
  x: number;
  y: number;
  z: number;
}

export interface Placed extends Cell {
  state: string;
}

export interface Entrance extends Cell {
  /** The way out through the door. */
  out: Facing;
}

export interface Blueprint {
  name: string;
  /** Its extent: x (west to east) and z (north to south) from 0, y from the ground's top layer (0) up. */
  size: Cell;
  /** In placing order. */
  blocks: Placed[];
  /** Cells to be left empty (rooms, the way in): cleared if anything is there. */
  air: Cell[];
  /** The door's lower half. */
  entrance: Entrance | null;
  /** Every column the building takes, to clear and level a site. */
  footprint: { x: number; z: number }[];
  /** What is wrong with the design (empty when nothing is). */
  problems: string[];
  /** What was changed from the design to make it work (a door moved, a floating detail left out). */
  notes?: string[];
}

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'] as const;
const WOODS_LONGEST_FIRST = [...WOODS].sort((a, b) => b.length - a.length);

interface Family {
  block: string;
  stairs: string;
  slab: string;
  /** A wood's fence (a stone has none). */
  fence?: string;
}

const STONES: Readonly<Record<string, Family>> = {
  cobblestone: { block: 'cobblestone', stairs: 'cobblestone_stairs', slab: 'cobblestone_slab' },
  mossy_cobblestone: { block: 'mossy_cobblestone', stairs: 'mossy_cobblestone_stairs', slab: 'mossy_cobblestone_slab' },
  stone: { block: 'stone', stairs: 'stone_stairs', slab: 'stone_slab' },
  stone_brick: { block: 'stone_bricks', stairs: 'stone_brick_stairs', slab: 'stone_brick_slab' },
  mossy_stone_brick: { block: 'mossy_stone_bricks', stairs: 'mossy_stone_brick_stairs', slab: 'mossy_stone_brick_slab' },
  sandstone: { block: 'sandstone', stairs: 'sandstone_stairs', slab: 'sandstone_slab' },
  smooth_sandstone: { block: 'smooth_sandstone', stairs: 'smooth_sandstone_stairs', slab: 'smooth_sandstone_slab' },
  red_sandstone: { block: 'red_sandstone', stairs: 'red_sandstone_stairs', slab: 'red_sandstone_slab' },
  brick: { block: 'bricks', stairs: 'brick_stairs', slab: 'brick_slab' },
  deepslate_brick: { block: 'deepslate_bricks', stairs: 'deepslate_brick_stairs', slab: 'deepslate_brick_slab' },
  deepslate_tile: { block: 'deepslate_tiles', stairs: 'deepslate_tile_stairs', slab: 'deepslate_tile_slab' },
  cobbled_deepslate: { block: 'cobbled_deepslate', stairs: 'cobbled_deepslate_stairs', slab: 'cobbled_deepslate_slab' },
  mud_brick: { block: 'mud_bricks', stairs: 'mud_brick_stairs', slab: 'mud_brick_slab' },
  blackstone: { block: 'blackstone', stairs: 'blackstone_stairs', slab: 'blackstone_slab' },
  andesite: { block: 'andesite', stairs: 'andesite_stairs', slab: 'andesite_slab' },
  granite: { block: 'granite', stairs: 'granite_stairs', slab: 'granite_slab' },
  diorite: { block: 'diorite', stairs: 'diorite_stairs', slab: 'diorite_slab' },
  nether_brick: { block: 'nether_bricks', stairs: 'nether_brick_stairs', slab: 'nether_brick_slab' },
  prismarine: { block: 'prismarine', stairs: 'prismarine_stairs', slab: 'prismarine_slab' },
  quartz: { block: 'quartz_block', stairs: 'quartz_stairs', slab: 'quartz_slab' },
};

/** The roof materials there are, for a design's author. */
export const ROOF_MATERIALS: readonly string[] = [...WOODS, ...Object.keys(STONES)];

/** A roof material's block, stairs and slab (a wood's planks, a stone's own); null for none. */
export function family(material: string): Family | null {
  const m = material.replace(/^minecraft:/, '').replace(/_planks$/, '').replace(/s$/, '');
  if ((WOODS as readonly string[]).includes(m)) return { block: `${m}_planks`, stairs: `${m}_stairs`, slab: `${m}_slab`, fence: `${m}_fence` };
  return STONES[m] ?? STONES[material] ?? null;
}

/** The wood a design is of (its floors, door, tables), from its roof, posts or walls; oak otherwise. */
export function woodOf(...names: (string | undefined)[]): string {
  for (const n of names) {
    if (!n) continue;
    const m = n.replace(/^minecraft:/, '').replace(/^stripped_/, '');
    const w = WOODS_LONGEST_FIRST.find((x) => m === x || m.startsWith(`${x}_`));
    if (w) return w;
  }
  return 'oak';
}

const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
const isLog = (b: string) => /_(log|stem|wood|hyphae)$/.test(b) || b === 'bamboo_block';
/** Blocks a torch, a ladder or a sign can't hang on. */
const NOT_STURDY = /(_pane$|^glass_pane$|_fence$|_fence_gate$|_door$|_trapdoor$|_slab$|_stairs$|_wall$|torch$|lantern$|_bars$|^ladder$|_carpet$|_bed$|_sign$|_banner$|_plate$|_button$|flower_pot$|^potted_|chest$|^air$|^water$|^lava$|rail$|^lever$|^chain$|campfire$|^scaffolding$)/;
/** Stands on the block below it. */
const ON_BLOCK_BELOW = /(_door$|_bed$|_carpet$|_pressure_plate$|^torch$|^soul_torch$|^lantern$|^soul_lantern$|flower_pot$|^potted_|rail$|^campfire$|^soul_campfire$|^wheat$|^carrots$|^potatoes$|^beetroots$|_sapling$|^farmland$|^water$)/;
/** Hangs on the block behind it (`facing` points away from that block). */
const ON_BLOCK_BEHIND = /^(wall_torch|soul_wall_torch|redstone_wall_torch|ladder|.*_wall_sign|.*_wall_banner|.*_wall_hanging_sign)$/;
/** Faces the one who placed it (into the room, when set by a wall). */
const FACES_PLACER = /^(chest|trapped_chest|furnace|smoker|blast_furnace|lectern|loom|stonecutter|beehive|bee_nest|carved_pumpkin|jack_o_lantern|ender_chest)$/;

interface Built {
  states: Map<string, string>;
  air: Set<string>;
  /** Cells only a forced put may change: the door, the ladder, the way in. */
  fixed: Set<string>;
  problems: string[];
  /** What was changed from the design to make it work (a door moved, a floating detail left out). */
  notes: string[];
  /** Cells set by the design's own details: one with nothing to go against is left out, not an error. */
  details: Set<string>;
}

function put(b: Built, x: number, y: number, z: number, state: string, force = false): void {
  const key = k(x, y, z);
  if (b.fixed.has(key) && !force) return;
  b.states.set(key, state);
  b.air.delete(key);
}

function clear(b: Built, x: number, y: number, z: number, force = false): void {
  const key = k(x, y, z);
  if (b.fixed.has(key) && !force) return;
  b.states.delete(key);
  b.air.add(key);
}

function sturdyAt(b: Built, x: number, y: number, z: number): boolean {
  const s = b.states.get(k(x, y, z));
  return s !== undefined && !NOT_STURDY.test(parseState(s).name);
}

interface PartBox {
  i: number;
  p: Part;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** The top row of its walls. */
  top: number;
}

/** The building's outline at each height: the union of the parts that reach it. */
interface Shape {
  parts: PartBox[];
  inPart(q: PartBox, x: number, z: number): boolean;
  inUnion(y: number, x: number, z: number): boolean;
  partAt(y: number, x: number, z: number): PartBox | undefined;
  /** In the outline at y, with a side on the outside. */
  onEdge(y: number, x: number, z: number): boolean;
}

function shapeOf(parts: PartBox[]): Shape {
  const inPart = (q: PartBox, x: number, z: number) => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1;
  const partAt = (y: number, x: number, z: number) => parts.find((q) => q.top >= y && inPart(q, x, z));
  const inUnion = (y: number, x: number, z: number) => partAt(y, x, z) !== undefined;
  const onEdge = (y: number, x: number, z: number) => inUnion(y, x, z) && FACINGS.some((f) => !inUnion(y, x + facingVec(f).x, z + facingVec(f).z));
  return { parts, inPart, inUnion, partAt, onEdge };
}

/** The blocks of a design: a building of parts, or a plot. */
export function compileDesign(d: Design): Blueprint {
  const b: Built = { states: new Map(), air: new Set(), fixed: new Set(), problems: [], notes: [], details: new Set() };
  const entrance = d.plot ? compilePlot(d, b) : compileParts(d, b);
  for (const det of d.details) {
    const [x, y, z] = det.at;
    try {
      if (parseState(det.block).name === 'air') clear(b, x, y, z);
      else {
        put(b, x, y, z, det.block);
        b.details.add(k(x, y, z));
      }
    } catch {
      b.problems.push(`detail ${det.block} at ${det.at.join(',')} is not a block`);
    }
  }
  return finish(d.name, b, entrance);
}

function compileParts(d: Design, b: Built): Entrance | null {
  const H = d.wallHeight;
  const L = H + 1;
  const parts: PartBox[] = d.parts.map((p, i) => ({ i, p, x0: p.at[0], z0: p.at[1], x1: p.at[0] + p.size[0] - 1, z1: p.at[1] + p.size[1] - 1, top: p.floors * L - 1 }));
  const S = shapeOf(parts);
  const first = d.parts[0];
  const wood = woodOf(first?.roof.material, first?.posts, first?.beams, ...(Array.isArray(first?.walls) ? first.walls : [first?.walls]));
  const wallOf = (q: PartBox, floor: number) => (Array.isArray(q.p.walls) ? (q.p.walls[Math.min(floor, q.p.walls.length - 1)] ?? 'cobblestone') : q.p.walls);
  const asWall = (block: string, axis: 'x' | 'y' | 'z') => (isLog(block) ? formatState({ name: block, props: { axis } }) : block);
  const minX = Math.min(...parts.map((q) => q.x0));
  const maxX = Math.max(...parts.map((q) => q.x1));
  const minZ = Math.min(...parts.map((q) => q.z0));
  const maxZ = Math.max(...parts.map((q) => q.z1));
  const maxTop = Math.max(...parts.map((q) => q.top));

  // The shell: the foundation, walls, a floor between storeys (beams round its edge), the rooms empty.
  for (let y = 0; y <= maxTop; y++) {
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const q = S.partAt(y, x, z);
        if (!q) continue;
        if (y === 0) {
          // The foundation under the walls; the floor within.
          put(b, x, y, z, S.onEdge(1, x, z) || !S.inUnion(1, x, z) ? q.p.foundation : (q.p.floor ?? q.p.foundation));
          continue;
        }
        const floor = Math.floor(y / L);
        if (!S.onEdge(y, x, z)) {
          if (y % L === 0) put(b, x, y, z, q.p.floor ?? `${wood}_planks`);
          else clear(b, x, y, z);
          continue;
        }
        // A log lies along its wall; at a corner it stands.
        const alongX = S.onEdge(y, x + 1, z) && S.onEdge(y, x - 1, z);
        const alongZ = S.onEdge(y, x, z + 1) && S.onEdge(y, x, z - 1);
        const axis = alongX && !alongZ ? 'x' : alongZ && !alongX ? 'z' : 'y';
        if (y % L === 0) put(b, x, y, z, asWall(q.p.beams ?? wallOf(q, floor - 1), axis));
        else put(b, x, y, z, asWall(wallOf(q, floor), axis));
      }
    }
  }
  // Posts at the outside corners of each part, the whole height.
  for (const q of parts) {
    if (!q.p.posts) continue;
    for (const [cx, cz] of [
      [q.x0, q.z0],
      [q.x1, q.z0],
      [q.x0, q.z1],
      [q.x1, q.z1],
    ] as const) {
      for (let y = 1; y <= q.top; y++) if (S.onEdge(y, cx, cz)) put(b, cx, y, cz, asWall(q.p.posts, 'y'));
    }
  }

  // Windows along each outside wall, centred, every few blocks, at eye height (two high in tall walls).
  for (const q of parts) {
    const w = q.p.windows;
    if (!w) continue;
    for (let floor = 0; floor < q.p.floors; floor++) {
      const rows = H >= 4 ? [floor * L + 2, floor * L + 3] : [floor * L + Math.min(2, H)];
      for (const side of FACINGS) {
        if (w.sides && !w.sides.includes(side)) continue;
        const out = facingVec(side);
        for (const c of windowCells(q, side, w.every)) {
          for (const y of rows) {
            if (!S.onEdge(y, c.x, c.z) || S.inUnion(y, c.x + out.x, c.z + out.z)) continue;
            put(b, c.x, y, c.z, w.block);
          }
        }
      }
    }
  }

  // The door, the step outside it kept clear and the one inside kept free. Where it was asked for if it fits there (in
  // an outside wall, not at a corner, open ground before it); else the nearest place on that side that does, then
  // another side, then another part, said so.
  let dq = parts[d.door.part] ?? parts[0];
  let entrance: Entrance | null = null;
  const reserved = new Set<string>();
  const doorCells: { x: number; z: number }[] = [];
  /** The wall either side of the door, along its side. */
  const besideDoor: { x: number; z: number }[] = [];
  if (dq) {
    const asked = dq;
    const width = d.door.double ? 2 : 1;
    const fits = (q: PartBox, side: Side, idx: number) => {
      const run = sideRun(q, side);
      if (idx < 1 || idx + width - 1 > run.length - 2) return null;
      const cells = run.slice(idx, idx + width);
      const v = facingVec(side);
      return cells.every((c) => S.onEdge(1, c.x, c.z) && S.onEdge(2, c.x, c.z) && !S.inUnion(1, c.x + v.x, c.z + v.z)) ? cells : null;
    };
    const tries: { q: PartBox; side: Side }[] = [
      { q: asked, side: d.door.side },
      ...FACINGS.filter((f) => f !== d.door.side).map((side) => ({ q: asked, side })),
      ...parts.filter((q) => q !== asked).flatMap((q) => FACINGS.map((side) => ({ q, side }))),
    ];
    let found: { q: PartBox; side: Side; idx: number; cells: { x: number; z: number }[] } | null = null;
    for (const t of tries) {
      const run = sideRun(t.q, t.side);
      const want = t.q === asked && t.side === d.door.side ? (d.door.offset ?? Math.floor((run.length - 1) / 2)) : Math.floor((run.length - width) / 2);
      const idxs = Array.from({ length: run.length }, (_, i) => i).sort((a, c) => Math.abs(a - want) - Math.abs(c - want));
      for (const i of idxs) {
        const cells = fits(t.q, t.side, i);
        if (cells) {
          found = { ...t, idx: i, cells };
          break;
        }
      }
      if (found) break;
    }
    if (!found) b.problems.push('no outside wall with room for a door');
    else {
      if (found.q !== asked || found.side !== d.door.side) b.notes.push(`the door went on the ${found.side} side${parts.length > 1 ? ` of part ${found.q.i}` : ''}: there was no room for it on the ${d.door.side} side`);
      dq = found.q;
      const side = found.side;
      const run = sideRun(found.q, side);
      for (const c of [run[found.idx - 1], run[found.idx + width]]) if (c) besideDoor.push(c);
      const v = facingVec(side);
      const name = `${d.door.material ?? wood}_door`;
      for (const [n, c] of found.cells.entries()) {
        // Placed from outside looking in; double doors open from the middle.
        const hinge = d.door.double && n === 1 ? 'right' : 'left';
        for (const [y, half] of [
          [1, 'lower'],
          [2, 'upper'],
        ] as const) {
          put(b, c.x, y, c.z, formatState({ name, props: { facing: opposite(side), half, hinge } }), true);
          b.fixed.add(k(c.x, y, c.z));
          clear(b, c.x + v.x, y, c.z + v.z, true);
          b.fixed.add(k(c.x + v.x, y, c.z + v.z));
        }
        reserved.add(k(c.x - v.x, 1, c.z - v.z));
        doorCells.push(c);
        entrance ??= { x: c.x, y: 1, z: c.z, out: side };
      }
    }
  }
  const doorSide = entrance?.out ?? d.door.side;

  roofs(b, S, wood, wallOf);

  // A ladder up through the floors of a part of more than one, against a wall with no window behind it.
  const ladders = new Set<string>();
  for (const q of parts) {
    if (q.p.floors < 2) continue;
    const topFloor = (q.p.floors - 1) * L;
    const spot = ringOf(S, q, 1, q === dq ? entrance : null).find(
      (c) => !reserved.has(k(c.x, 1, c.z)) && Array.from({ length: topFloor }, (_, i) => i + 1).every((y) => sturdyAt(b, c.x + facingVec(c.wall).x, y, c.z + facingVec(c.wall).z)),
    );
    if (!spot) {
      b.problems.push(`no wall inside part ${q.i} for a ladder up`);
      continue;
    }
    const facing = opposite(spot.wall);
    // Up through a flat roof too, to stand on it.
    const ladderTop = q.p.roof.style === 'flat' ? q.top + 1 : topFloor;
    if (q.p.roof.style === 'flat' && !Array.from({ length: q.top - topFloor }, (_, i) => topFloor + 1 + i).every((y) => sturdyAt(b, spot.x + facingVec(spot.wall).x, y, spot.z + facingVec(spot.wall).z))) {
      b.problems.push(`part ${q.i}: a window behind the ladder up to the roof`);
    }
    for (let y = 1; y <= ladderTop; y++) {
      put(b, spot.x, y, spot.z, formatState({ name: 'ladder', props: { facing } }), true);
      b.fixed.add(k(spot.x, y, spot.z));
    }
    ladders.add(`${spot.x},${spot.z}`);
    // Room to step on at the bottom and off at each floor.
    for (let f = 0; f < q.p.floors; f++) reserved.add(k(spot.x + facingVec(facing).x, f * L + 1, spot.z + facingVec(facing).z));
  }

  // What is inside, along the walls: the door's part first, from the wall facing the door; upstairs when that's full.
  const slots: Slot[] = [];
  const ordered = dq ? [dq, ...parts.filter((q) => q !== dq)] : parts;
  for (let f = 0; f < Math.max(...parts.map((q) => q.p.floors)); f++) {
    for (const q of ordered) {
      if (f >= q.p.floors) continue;
      const y = f * L + 1;
      for (const c of ringOf(S, q, y, q === dq ? entrance : null)) {
        if (!reserved.has(k(c.x, y, c.z)) && !ladders.has(`${c.x},${c.z}`) && !slots.some((s) => s.x === c.x && s.y === y && s.z === c.z)) slots.push({ ...c, y, used: false });
      }
    }
  }
  for (const entry of d.interior) {
    const [item = entry, at] = entry.split('@');
    const floor = at === undefined ? undefined : Number(at) * L + 1;
    // On the floor asked for if there's room, else anywhere.
    const placed = (floor !== undefined && furnish(b, item, slots.filter((s) => s.y === floor), wood)) || furnish(b, item, slots, wood);
    if (!placed) b.problems.push(`no room inside for ${item}`);
  }

  // Light: a torch either side of the door outside, and inside a few torches high on the walls (or lanterns on the floor).
  if (d.lights !== 'none' && doorCells.length > 0) {
    const side = doorSide;
    const v = facingVec(side);
    const ty = H >= 3 ? 2 : 1;
    for (const c of besideDoor) {
      if (sturdyAt(b, c.x, ty, c.z) && !b.states.has(k(c.x + v.x, ty, c.z + v.z))) put(b, c.x + v.x, ty, c.z + v.z, formatState({ name: 'wall_torch', props: { facing: side } }));
    }
  }
  if (d.lights !== 'none') {
    for (const q of parts) {
      for (let f = 0; f < q.p.floors; f++) {
        if (d.lights === 'lanterns') {
          const free = slots.filter((s) => !s.used && s.y === f * L + 1 && S.inPart(q, s.x, s.z));
          const corners = free.filter((s) => FACINGS.filter((g) => S.onEdge(s.y, s.x + facingVec(g).x, s.z + facingVec(g).z)).length >= 2);
          const n = Math.max(1, Math.round(free.length / 8));
          for (const s of [...corners, ...free.filter((x) => !corners.includes(x))].slice(0, n)) {
            put(b, s.x, s.y, s.z, formatState({ name: 'lantern', props: { hanging: 'false' } }));
            s.used = true;
          }
          continue;
        }
        const y = f * L + H;
        const spots = ringOf(S, q, y, null).filter((c) => !b.states.has(k(c.x, y, c.z)) && sturdyAt(b, c.x + facingVec(c.wall).x, y, c.z + facingVec(c.wall).z));
        const n = Math.min(spots.length, Math.max(1, Math.round(spots.length / 8)));
        for (let i = 0; i < n; i++) {
          const s = spots[Math.floor(((i + 0.5) * spots.length) / n)];
          if (s) put(b, s.x, y, s.z, formatState({ name: 'wall_torch', props: { facing: opposite(s.wall) } }));
        }
      }
    }
  }

  for (const f of d.features) feature(b, S, f, dq, wood, entrance, doorCells);
  return entrance;
}

/** The cells of a part's side, end to end (corners included), west to east or north to south. */
function sideRun(q: PartBox, side: Side): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  if (side === 'north' || side === 'south') for (let x = q.x0; x <= q.x1; x++) out.push({ x, z: side === 'north' ? q.z0 : q.z1 });
  else for (let z = q.z0; z <= q.z1; z++) out.push({ x: side === 'west' ? q.x0 : q.x1, z });
  return out;
}

/** Window cells along a side: centred, `every` apart, not at a corner nor (in a long wall) beside one. */
function windowCells(q: PartBox, side: Side, every: number): { x: number; z: number }[] {
  const run = sideRun(q, side);
  const n = run.length - 2;
  if (n < 1) return [];
  const centre = (n + 1) / 2;
  const out: { x: number; z: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const off = Math.abs(i - centre) - (n % 2 === 1 ? 0 : 0.5);
    if (off % every !== 0 || (n > 3 && (i === 1 || i === n))) continue;
    const c = run[i];
    if (c) out.push(c);
  }
  return out;
}

interface RingCell {
  x: number;
  z: number;
  /** The wall it is against. */
  wall: Facing;
}

/** The cells along the inside of a part's walls at height y, going round from the one farthest from the door. */
function ringOf(S: Shape, q: PartBox, y: number, door: { x: number; z: number } | null): RingCell[] {
  const x0 = q.x0 + 1;
  const x1 = q.x1 - 1;
  const z0 = q.z0 + 1;
  const z1 = q.z1 - 1;
  if (x1 < x0 || z1 < z0) return [];
  const cells: RingCell[] = [];
  const add = (x: number, z: number, wall: Facing) => {
    if (cells.some((c) => c.x === x && c.z === z)) return;
    const v = facingVec(wall);
    if (!S.inUnion(y, x, z) || S.onEdge(y, x, z) || !S.onEdge(y, x + v.x, z + v.z)) return;
    cells.push({ x, z, wall });
  };
  for (let x = x0; x <= x1; x++) add(x, z0, 'north');
  for (let z = z0; z <= z1; z++) add(x1, z, 'east');
  for (let x = x1; x >= x0; x--) add(x, z1, 'south');
  for (let z = z1; z >= z0; z--) add(x0, z, 'west');
  if (!door || cells.length === 0) return cells;
  const dist = (c: RingCell) => Math.abs(c.x - door.x) + Math.abs(c.z - door.z);
  const far = cells.reduce((best, c, i) => (dist(c) > dist(cells[best] ?? c) ? i : best), 0);
  return [...cells.slice(far), ...cells.slice(0, far)];
}

interface Slot extends RingCell {
  y: number;
  used: boolean;
}

/** One thing set inside by a wall, in the first free slot (a bed takes two side by side along one wall). */
function furnish(b: Built, item: string, slots: Slot[], wood: string): boolean {
  for (const [i, c] of slots.entries()) {
    if (c.used || b.states.has(k(c.x, c.y, c.z))) continue;
    const room = opposite(c.wall);
    const take = (state: string, above?: string) => {
      put(b, c.x, c.y, c.z, state);
      if (above) put(b, c.x, c.y + 1, c.z, above);
      c.used = true;
      return true;
    };
    if (item === 'bed' || item.endsWith('_bed')) {
      // The head on the next cell along the same wall.
      const next = slots.slice(i + 1).find((s) => !s.used && s.y === c.y && s.wall === c.wall && Math.abs(s.x - c.x) + Math.abs(s.z - c.z) === 1 && !b.states.has(k(s.x, s.y, s.z)));
      if (!next) continue;
      const facing = facingFromTo(c, next);
      const name = item === 'bed' ? 'red_bed' : item;
      put(b, next.x, next.y, next.z, formatState({ name, props: { facing, part: 'head' } }));
      next.used = true;
      return take(formatState({ name, props: { facing, part: 'foot' } }));
    }
    if (item === 'table') return take(`${wood}_fence`, `${wood}_pressure_plate`);
    if (item === 'chair') return take(formatState({ name: `${wood}_stairs`, props: { facing: c.wall, half: 'bottom' } }));
    if (item === 'barrel') return take(formatState({ name: 'barrel', props: { facing: 'up' } }));
    if (FACES_PLACER.test(item)) return take(formatState({ name: item, props: { facing: room } }));
    // An anvil lies along the wall.
    if (item === 'anvil') return take(formatState({ name: 'anvil', props: { facing: turnRight(c.wall) } }));
    if (item === 'plant') return take('potted_poppy');
    // On the wall it stands by.
    if (item === 'ladder') return take(formatState({ name: 'ladder', props: { facing: room } }));
    if (item === 'torch' || item === 'wall_torch') {
      put(b, c.x, c.y + 1, c.z, formatState({ name: 'wall_torch', props: { facing: room } }));
      c.used = true;
      return true;
    }
    if (item === 'lamp' || item === 'lantern') return take(formatState({ name: 'lantern', props: { hanging: 'false' } }));
    return take(item);
  }
  return false;
}

function facingFromTo(a: { x: number; z: number }, b: { x: number; z: number }): Facing {
  if (b.x > a.x) return 'east';
  if (b.x < a.x) return 'west';
  return b.z > a.z ? 'south' : 'north';
}

const stairsOf = (f: Family, facing: Facing) => formatState({ name: f.stairs, props: { facing, half: 'bottom' } });
const slabOf = (f: Family, type: 'bottom' | 'top' = 'bottom') => formatState({ name: f.slab, props: { type } });
const perpendicular = (a: Facing, b: Facing) => (a === 'north' || a === 'south') !== (b === 'north' || b === 'south');

/**
 * Every part's roof. Gables and hips of parts of one height are one surface (each column the highest roof over it);
 * a flat roof is a layer with a rim, a shed one slope of slabs. Where a roof runs into a taller part, the taller
 * part's walls win. The walls are carried up under the slope where they are outside (gable ends, a shed's sides), and
 * a roof block with nothing to go against gets one under it.
 */
function roofs(b: Built, S: Shape, wood: string, wallOf: (q: PartBox, floor: number) => string): void {
  const roofCells = new Map<string, Placed>();
  const set = (x: number, y: number, z: number, state: string) => {
    if (b.fixed.has(k(x, y, z))) return;
    put(b, x, y, z, state);
    roofCells.set(k(x, y, z), { x, y, z, state });
  };
  const famOf = (q: PartBox) => {
    const f = family(q.p.roof.material);
    if (!f) b.problems.push(`no roof of ${q.p.roof.material} (part ${q.i}): use one of ${ROOF_MATERIALS.join(', ')}`);
    return f;
  };
  const tallerOver = (q: PartBox, x: number, z: number) => S.parts.some((p) => p.top > q.top && S.inPart(p, x, z));
  // Carries the outside walls up to the roof's underside.
  const wallUp = (q: PartBox, x: number, z: number, under: number) => {
    const w = S.partAt(q.top, x, z);
    if (!w || w.top !== q.top || !S.onEdge(q.top, x, z)) return;
    const fam = family(w.p.roof.material);
    const block = wallOf(w, w.p.floors - 1);
    const gable = isLog(block) ? (fam?.block ?? `${wood}_planks`) : block;
    for (let y = q.top + 1; y < under; y++) put(b, x, y, z, gable);
  };

  const sloped = S.parts.filter((q) => q.p.roof.style === 'gable' || q.p.roof.style === 'hip');
  for (const top of [...new Set(sloped.map((q) => q.top))].sort((a, c) => a - c)) {
    const field = new Map<string, { x: number; z: number; h: number; q: PartBox }>();
    for (const q of sloped.filter((p) => p.top === top)) {
      const o = q.p.roof.overhang;
      const [X0, X1, Z0, Z1] = [q.x0 - o, q.x1 + o, q.z0 - o, q.z1 + o];
      const along = q.p.roof.axis ?? (q.x1 - q.x0 >= q.z1 - q.z0 ? 'x' : 'z');
      for (let x = X0; x <= X1; x++) {
        for (let z = Z0; z <= Z1; z++) {
          if (tallerOver(q, x, z)) continue;
          const d = q.p.roof.style === 'hip' ? Math.min(x - X0, X1 - x, z - Z0, Z1 - z) : along === 'x' ? Math.min(z - Z0, Z1 - z) : Math.min(x - X0, X1 - x);
          const h = top + 1 - o + d;
          const cur = field.get(`${x},${z}`);
          if (!cur || h > cur.h) field.set(`${x},${z}`, { x, z, h, q });
        }
      }
    }
    for (const c of field.values()) {
      const fam = famOf(c.q);
      if (!fam) continue;
      const up: Facing[] = [];
      const down: Facing[] = [];
      for (const f of FACINGS) {
        const v = facingVec(f);
        const n = field.get(`${c.x + v.x},${c.z + v.z}`);
        if (!n || n.h < c.h) down.push(f);
        else if (n.h > c.h) up.push(f);
      }
      const [u0, u1] = up;
      const [d0, d1] = down;
      // Where two eaves meet at an outside corner, a notch lower than both: left out.
      if (up.length >= 2 && !S.parts.some((p) => S.inPart(p, c.x, c.z))) continue;
      let state: string;
      if (u0 && (up.length === 1 || (up.length === 2 && u1 && perpendicular(u0, u1)))) state = stairsOf(fam, u0);
      else if (up.length >= 2) state = fam.block;
      else if (d0 && (down.length === 1 || (down.length === 2 && d1 && perpendicular(d0, d1)))) state = stairsOf(fam, opposite(d0));
      else state = slabOf(fam);
      set(c.x, c.h, c.z, state);
      wallUp(c.q, c.x, c.z, c.h);
    }
  }

  for (const q of S.parts) {
    const fam = q.p.roof.style === 'flat' || q.p.roof.style === 'shed' ? famOf(q) : null;
    if (!fam) continue;
    if (q.p.roof.style === 'flat') {
      // A layer over the walls, a rim round its outside edge.
      for (let x = q.x0; x <= q.x1; x++) {
        for (let z = q.z0; z <= q.z1; z++) {
          if (tallerOver(q, x, z) || b.states.has(k(x, q.top + 1, z))) continue;
          set(x, q.top + 1, z, fam.block);
          if (q.p.roof.rim && S.onEdge(q.top, x, z) && !b.states.has(k(x, q.top + 2, z))) set(x, q.top + 2, z, fam.fence ?? slabOf(fam));
        }
      }
      continue;
    }
    // A shed: one slope of slabs, half a block up for each block across, toward +axis (the short way by default).
    const o = q.p.roof.overhang;
    const rise = q.p.roof.axis ?? (q.x1 - q.x0 <= q.z1 - q.z0 ? 'x' : 'z');
    const [X0, X1, Z0, Z1] = [q.x0 - o, q.x1 + o, q.z0 - o, q.z1 + o];
    for (let x = X0; x <= X1; x++) {
      for (let z = Z0; z <= Z1; z++) {
        if (tallerOver(q, x, z)) continue;
        const i = rise === 'x' ? x - X0 : z - Z0;
        const last = rise === 'x' ? X1 - X0 : Z1 - Z0;
        // Slabs go in pairs, a bottom one and a top one at the same height; a last one with no pair stays level with the one before it.
        const h2raw = 2 * (q.top + 1) - o + i;
        const h2 = i === last && h2raw % 2 === 0 && i > 0 ? h2raw - 1 : h2raw;
        const y = Math.floor(h2 / 2);
        set(x, y, z, slabOf(fam, h2 % 2 === 0 ? 'bottom' : 'top'));
        wallUp(q, x, z, y);
      }
    }
  }

  // Roof blocks with nothing to go against (a hip's inner rings): one of the roof's own under the lowest, in the attic.
  for (let round = 0; round < 64; round++) {
    const reached = new Set<string>();
    const queue: Placed[] = [];
    const structure = (key: string) => b.states.has(key) && !roofCells.has(key);
    for (const c of roofCells.values()) {
      if (NEIGHBOURS.some(([dx, dy, dz]) => structure(k(c.x + dx, c.y + dy, c.z + dz)))) {
        reached.add(k(c.x, c.y, c.z));
        queue.push(c);
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      if (!c) break;
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const key = k(c.x + dx, c.y + dy, c.z + dz);
        const n = roofCells.get(key);
        if (n && !reached.has(key)) {
          reached.add(key);
          queue.push(n);
        }
      }
    }
    const lost = [...roofCells.values()].filter((c) => !reached.has(k(c.x, c.y, c.z))).sort((a, c) => a.y - c.y);
    const fix = lost.find((c) => {
      const tops = S.parts.filter((p) => S.inPart(p, c.x, c.z)).map((p) => p.top);
      if (tops.length === 0 || c.y - 1 <= Math.max(...tops) || b.states.has(k(c.x, c.y - 1, c.z))) return false;
      return NEIGHBOURS.some(([dx, dy, dz]) => {
        const key = k(c.x + dx, c.y - 1 + dy, c.z + dz);
        return reached.has(key) || structure(key);
      });
    });
    if (!fix) break;
    const q = S.parts.find((p) => S.inPart(p, fix.x, fix.z));
    const fam = q ? family(q.p.roof.material) : null;
    put(b, fix.x, fix.y - 1, fix.z, fam?.block ?? `${wood}_planks`);
  }
}

function feature(b: Built, S: Shape, f: Design['features'][number], q: PartBox | undefined, wood: string, door: Entrance | null, doorCells: { x: number; z: number }[]): void {
  if (!q) return;
  const minX = Math.min(...S.parts.map((p) => p.x0));
  const maxX = Math.max(...S.parts.map((p) => p.x1));
  const minZ = Math.min(...S.parts.map((p) => p.z0));
  const maxZ = Math.max(...S.parts.map((p) => p.z1));
  const columnTop = (x: number, z: number) => {
    let top = 0;
    for (const key of b.states.keys()) {
      const [cx, cy, cz] = key.split(',').map(Number);
      if (cx === x && cz === z && (cy ?? 0) > top) top = cy ?? 0;
    }
    return top;
  };
  switch (f.type) {
    case 'chimney': {
      // Up the middle of a wall (a gable end, if the side isn't said) to two above whatever is highest there.
      const side = f.side ?? (door ? turnRight(door.out) : 'west');
      const run = sideRun(q, side);
      const c = run[Math.floor(run.length / 2)];
      if (!c || !S.onEdge(1, c.x, c.z)) return;
      const top = columnTop(c.x, c.z) + 2;
      for (let y = 1; y <= top; y++) put(b, c.x, y, c.z, f.material ?? 'cobblestone');
      return;
    }
    case 'porch': {
      // A roof out over the door on two posts.
      if (!door || doorCells.length === 0) return;
      const v = facingVec(door.out);
      const along = facingVec(turnRight(door.out));
      const ends = [doorCells[0], doorCells[doorCells.length - 1]];
      const lo = Math.min(...ends.map((c) => (c ? c.x * along.x + c.z * along.z : 0))) - 2;
      const hi = Math.max(...ends.map((c) => (c ? c.x * along.x + c.z * along.z : 0))) + 2;
      const at = (a: number, o: number) => ({ x: along.x !== 0 ? a * along.x : door.x + v.x * o, z: along.z !== 0 ? a * along.z : door.z + v.z * o });
      const roofY = q.top + 1;
      for (const a of [lo, hi]) {
        const p = at(a, 2);
        for (let y = 1; y < roofY; y++) put(b, p.x, y, p.z, f.material ?? `${wood}_fence`);
      }
      for (let a = lo; a <= hi; a++) {
        for (let o = 1; o <= 2; o++) {
          const p = at(a, o);
          if (!b.states.has(k(p.x, roofY, p.z))) put(b, p.x, roofY, p.z, formatState({ name: `${wood}_slab`, props: { type: 'bottom' } }));
        }
      }
      return;
    }
    case 'fence': {
      // Round the whole building two out, a gate in line with the door.
      const [x0, x1, z0, z1] = [minX - 2, maxX + 2, minZ - 2, maxZ + 2];
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (x === x0 || x === x1 || z === z0 || z === z1) put(b, x, 1, z, f.material ?? `${wood}_fence`);
      if (door) {
        const gx = door.out === 'east' ? x1 : door.out === 'west' ? x0 : door.x;
        const gz = door.out === 'south' ? z1 : door.out === 'north' ? z0 : door.z;
        put(b, gx, 1, gz, formatState({ name: `${wood}_fence_gate`, props: { facing: door.out } }));
      }
      return;
    }
    case 'path': {
      if (!door) return;
      const v = facingVec(door.out);
      for (let o = 1; o <= 3; o++) put(b, door.x + v.x * o, 0, door.z + v.z * o, f.material ?? 'gravel');
      return;
    }
    case 'lamp': {
      // A lantern on a post, out front to one side.
      if (!door) return;
      const v = facingVec(door.out);
      const along = facingVec(turnRight(door.out));
      const p = { x: door.x + along.x * 3 + v.x * 3, z: door.z + along.z * 3 + v.z * 3 };
      put(b, p.x, 1, p.z, `${wood}_fence`);
      put(b, p.x, 2, p.z, `${wood}_fence`);
      put(b, p.x, 3, p.z, formatState({ name: 'lantern', props: { hanging: 'false' } }));
      return;
    }
  }
}

/** A plot: a farm, a pen, a well or a lamp post. */
function compilePlot(d: Design, b: Built): Entrance | null {
  const p = d.plot;
  if (!p) return null;
  const [w, dd] = p.size;
  const wood = woodOf(p.material);
  const ring = (x: number, z: number) => x === 0 || x === w - 1 || z === 0 || z === dd - 1;
  const gate = (): Entrance => {
    const gx = p.side === 'east' ? w - 1 : p.side === 'west' ? 0 : Math.floor((w - 1) / 2);
    const gz = p.side === 'south' ? dd - 1 : p.side === 'north' ? 0 : Math.floor((dd - 1) / 2);
    put(b, gx, 1, gz, formatState({ name: `${wood}_fence_gate`, props: { facing: p.side } }), true);
    b.fixed.add(k(gx, 1, gz));
    return { x: gx, y: 1, z: gz, out: p.side };
  };
  switch (p.type) {
    case 'pen': {
      const fence = p.material && /_(fence|wall)$/.test(p.material) ? p.material : `${wood}_fence`;
      for (let x = 0; x < w; x++) for (let z = 0; z < dd; z++) if (ring(x, z)) put(b, x, 1, z, fence);
      return gate();
    }
    case 'farm': {
      // Tilled ground round water in the middle, fenced, with a gate.
      const cx = Math.floor(w / 2);
      const cz = Math.floor(dd / 2);
      for (let x = 0; x < w; x++) {
        for (let z = 0; z < dd; z++) {
          if (ring(x, z)) put(b, x, 1, z, `${wood}_fence`);
          else {
            put(b, x, 0, z, x === cx && z === cz ? 'water' : 'farmland');
            clear(b, x, 1, z);
          }
        }
      }
      return gate();
    }
    case 'well': {
      // Stone round water, a post at each corner and a roof of slabs.
      const stone = p.material ?? 'cobblestone';
      for (let x = 0; x < 4; x++) {
        for (let z = 0; z < 4; z++) {
          const edge = x === 0 || x === 3 || z === 0 || z === 3;
          put(b, x, -1, z, stone);
          put(b, x, 0, z, edge ? stone : 'water');
          if (edge) put(b, x, 1, z, stone);
          else clear(b, x, 1, z);
        }
      }
      for (const [x, z] of [
        [0, 0],
        [3, 0],
        [0, 3],
        [3, 3],
      ] as const) {
        for (let y = 2; y <= 3; y++) put(b, x, y, z, `${wood}_fence`);
      }
      for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) put(b, x, 4, z, formatState({ name: `${wood}_slab`, props: { type: 'bottom' } }));
      return null;
    }
    case 'lamp': {
      put(b, 0, 1, 0, `${wood}_fence`);
      put(b, 0, 2, 0, `${wood}_fence`);
      put(b, 0, 3, 0, formatState({ name: 'lantern', props: { hanging: 'false' } }));
      return null;
    }
  }
}

/** What a block must be placed against: the block below it, the one behind it, or any next to it. */
export function support(state: BlockState): 'below' | 'behind' | 'any' {
  if (ON_BLOCK_BEHIND.test(state.name)) return 'behind';
  if (state.name === 'lantern' || state.name === 'soul_lantern') return state.props.hanging === 'true' ? 'any' : 'below';
  if (ON_BLOCK_BELOW.test(state.name)) return 'below';
  return 'any';
}

const NEIGHBOURS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** The cell of a door's or a bed's other half, which the game places with it. */
export function otherHalf(c: Cell, s: BlockState): Cell | null {
  if (s.name.endsWith('_door')) return s.props.half === 'upper' ? null : { x: c.x, y: c.y + 1, z: c.z };
  if (s.name.endsWith('_bed') && s.props.part !== 'head') {
    const v = facingVec((s.props.facing as Facing | undefined) ?? 'north');
    return { x: c.x + v.x, y: c.y, z: c.z + v.z };
  }
  return null;
}

/** The key of a cell in the maps a blueprint is made from. */
export const cellKey = k;

/** A blueprint from blocks by cell (`cellKey`) and the cells to leave empty: as a design compiles, or as a structure file reads. */
export function blueprintOf(name: string, states: Map<string, string>, air: Set<string>, entrance: Entrance | null, problems: string[] = []): Blueprint {
  return finish(name, { states, air, fixed: new Set(), problems, notes: [], details: new Set() }, entrance);
}

/** The blocks in an order they can be placed in, from the ground up, each against one already there. */
function finish(name: string, b: Built, entrance: Entrance | null): Blueprint {
  const problems = [...b.problems];
  const cells = new Map<string, Placed & { s: BlockState }>();
  for (const [key, state] of b.states) {
    const [x = 0, y = 0, z = 0] = key.split(',').map(Number);
    cells.set(key, { x, y, z, state, s: parseState(state) });
  }
  // A door's top and a bed's head come with their first half.
  const second = new Map<string, string>();
  for (const c of cells.values()) {
    const o = otherHalf(c, c.s);
    if (!o) continue;
    const key = k(o.x, o.y, o.z);
    if (cells.has(key)) second.set(k(c.x, c.y, c.z), key);
    else problems.push(`${c.state} at ${c.x},${c.y},${c.z} has no room for its other half`);
  }
  const seconds = new Set(second.values());
  for (const c of cells.values()) {
    const half = (c.s.name.endsWith('_door') && c.s.props.half === 'upper') || (c.s.name.endsWith('_bed') && c.s.props.part === 'head');
    if (half && !seconds.has(k(c.x, c.y, c.z))) problems.push(`${c.state} at ${c.x},${c.y},${c.z} is half of something with no other half`);
  }
  const placed = new Set<string>();
  const order: Placed[] = [];
  // On the ground: in it, under it, or on it where the design has nothing below.
  const onGround = (c: Cell) => c.y <= 0 || (c.y === 1 && !cells.has(k(c.x, 0, c.z)) && !b.air.has(k(c.x, 0, c.z)));
  let pending = [...cells.values()].filter((c) => !seconds.has(k(c.x, c.y, c.z))).sort((a, c) => a.y - c.y || a.x - c.x || a.z - c.z);
  for (let round = 0; pending.length > 0 && round < 256; round++) {
    const left: typeof pending = [];
    for (const c of pending) {
      const sup = support(c.s);
      let ok: boolean;
      if (sup === 'below') ok = onGround(c) || placed.has(k(c.x, c.y - 1, c.z));
      else if (sup === 'behind') {
        const v = facingVec((c.s.props.facing as Facing | undefined) ?? 'north');
        ok = placed.has(k(c.x - v.x, c.y, c.z - v.z));
      } else ok = onGround(c) || NEIGHBOURS.some(([dx, dy, dz]) => placed.has(k(c.x + dx, c.y + dy, c.z + dz)));
      if (!ok) {
        left.push(c);
        continue;
      }
      placed.add(k(c.x, c.y, c.z));
      order.push({ x: c.x, y: c.y, z: c.z, state: c.state });
      const other = second.get(k(c.x, c.y, c.z));
      const o = other ? cells.get(other) : undefined;
      if (o && other) {
        placed.add(other);
        order.push({ x: o.x, y: o.y, z: o.z, state: o.state });
      }
    }
    if (left.length === pending.length) break;
    pending = left;
  }
  const notes = [...b.notes];
  for (const c of pending) {
    if (b.details.has(k(c.x, c.y, c.z))) notes.push(`left out ${c.state} at ${c.x},${c.y},${c.z}: nothing to go against`);
    else problems.push(`${c.state} at ${c.x},${c.y},${c.z} has nothing to go against`);
  }

  // From the north-west corner (heights stay as they are: 0 is the ground).
  const all = [...order, ...[...b.air].map((key) => key.split(',').map(Number) as [number, number, number]).map(([x, y, z]) => ({ x, y, z }))];
  const minX = all.length > 0 ? Math.min(...all.map((c) => c.x)) : 0;
  const minZ = all.length > 0 ? Math.min(...all.map((c) => c.z)) : 0;
  const shift = <T extends Cell>(c: T): T => ({ ...c, x: c.x - minX, z: c.z - minZ });
  const blocks = order.map(shift);
  const columns = new Map<string, { x: number; z: number }>();
  for (const c of blocks) columns.set(`${c.x},${c.z}`, { x: c.x, z: c.z });
  return {
    name,
    size: {
      x: Math.max(0, ...all.map((c) => c.x - minX + 1)),
      y: Math.max(0, ...all.map((c) => c.y + 1)),
      z: Math.max(0, ...all.map((c) => c.z - minZ + 1)),
    },
    blocks,
    air: [...b.air].map((key) => {
      const [x = 0, y = 0, z = 0] = key.split(',').map(Number);
      return shift({ x, y, z });
    }),
    entrance: entrance ? shift(entrance) : null,
    footprint: [...columns.values()],
    problems: [...new Set(problems)],
    notes,
  };
}
