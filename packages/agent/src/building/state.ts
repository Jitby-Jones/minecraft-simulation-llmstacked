// Block states as builders write them ("oak_stairs[facing=north,half=bottom]"), the items they are made of, and the
// turns a building takes to face another way. Coordinates: x east, y up, z south; a facing is a compass direction.

export type Facing = 'north' | 'east' | 'south' | 'west';
export const FACINGS: readonly Facing[] = ['north', 'east', 'south', 'west'];

export interface BlockState {
  name: string;
  props: Record<string, string>;
}

/** "oak_stairs[facing=north,half=bottom]" → { name: 'oak_stairs', props: { facing: 'north', half: 'bottom' } }. */
export function parseState(s: string): BlockState {
  const m = /^\s*(?:minecraft:)?([a-z0-9_]+)\s*(?:\[([^\]]*)\])?\s*$/.exec(s);
  if (!m?.[1]) throw new Error(`not a block state: "${s}"`);
  const props: Record<string, string> = {};
  for (const kv of (m[2] ?? '').split(',')) {
    const [k, v] = kv.split('=').map((x) => x.trim());
    if (k && v) props[k] = v;
  }
  return { name: m[1], props };
}

export function formatState(b: BlockState): string {
  const keys = Object.keys(b.props).sort();
  return keys.length === 0 ? b.name : `${b.name}[${keys.map((k) => `${k}=${b.props[k]}`).join(',')}]`;
}

/** The unit step a facing points along. */
export function facingVec(f: Facing): { x: number; z: number } {
  return f === 'north' ? { x: 0, z: -1 } : f === 'south' ? { x: 0, z: 1 } : f === 'east' ? { x: 1, z: 0 } : { x: -1, z: 0 };
}

export function opposite(f: Facing): Facing {
  return f === 'north' ? 'south' : f === 'south' ? 'north' : f === 'east' ? 'west' : 'east';
}

/** A quarter turn clockwise, seen from above. */
export function turnRight(f: Facing): Facing {
  return FACINGS[(FACINGS.indexOf(f) + 1) % 4] ?? f;
}

const isFacing = (v: string | undefined): v is Facing => v === 'north' || v === 'east' || v === 'south' || v === 'west';

/** The state turned a quarter clockwise (`times` quarters): facings turn, an x axis becomes z and back. */
export function rotateState(b: BlockState, times: number): BlockState {
  const n = ((times % 4) + 4) % 4;
  if (n === 0) return b;
  const props = { ...b.props };
  const was = props.facing;
  if (isFacing(was)) {
    let f: Facing = was;
    for (let i = 0; i < n; i++) f = turnRight(f);
    props.facing = f;
  }
  if (n % 2 === 1 && (props.axis === 'x' || props.axis === 'z')) props.axis = props.axis === 'x' ? 'z' : 'x';
  // Connections (fences, panes) are worked out by the game itself.
  for (const k of ['north', 'east', 'south', 'west']) delete props[k];
  return { name: b.name, props };
}

/** A position within a w×d footprint turned a quarter clockwise `times` (the footprint becomes d×w when odd). */
export function rotatePos(p: { x: number; y: number; z: number }, w: number, d: number, times: number): { x: number; y: number; z: number } {
  let { x, z } = p;
  let cw = w;
  let cd = d;
  for (let i = 0; i < ((times % 4) + 4) % 4; i++) {
    [x, z] = [cd - 1 - z, x];
    [cw, cd] = [cd, cw];
  }
  return { x, y: p.y, z };
}

/** Blocks that are two cells tall or long and placed as one item (the second half comes with it). */
export function secondHalf(b: BlockState): boolean {
  return (b.props.half === 'upper' && /_door$|^tall_|_tall$|^(sunflower|lilac|rose_bush|peony|large_fern|tall_grass)$/.test(b.name)) || (b.props.part === 'head' && /_bed$/.test(b.name));
}

/** The item a block is placed from ("wall_torch" from "torch", a door from one door item). */
export function itemFor(name: string): string {
  if (name === 'wall_torch') return 'torch';
  if (name === 'soul_wall_torch') return 'soul_torch';
  if (name === 'redstone_wall_torch') return 'redstone_torch';
  const sign = /^(.+)_wall_sign$/.exec(name);
  if (sign?.[1]) return `${sign[1]}_sign`;
  const hanging = /^(.+)_wall_hanging_sign$/.exec(name);
  if (hanging?.[1]) return `${hanging[1]}_hanging_sign`;
  if (name === 'grass_block' || name === 'dirt_path' || name === 'farmland') return 'dirt';
  if (name === 'water') return 'water_bucket';
  if (name.startsWith('potted_')) return 'flower_pot';
  return name;
}
