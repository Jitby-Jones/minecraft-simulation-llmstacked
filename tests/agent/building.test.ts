import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';
import { describe, expect, it } from 'vitest';
import { type Blueprint, compileDesign, family, otherHalf, support, woodOf } from '@agora/agent/building/compile';
import { DesignSchema, type DesignInput } from '@agora/agent/building/design';
import { billOf, difficulty, inShape, planMaterials, splitShape, substitute } from '@agora/agent/building/materials';
import { Repertoire, buildingsDir, describeBuilding } from '@agora/agent/building/repertoire';
import { formatState, itemFor, parseState, rotatePos, rotateState, secondHalf } from '@agora/agent/building/state';
import { Zip, blueprintFromStructure, listVanilla, openGameJar, vanillaKind } from '@agora/agent/building/vanilla';

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const N6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** Blocks a builder can't place in the order given: nothing to go against yet, or a second half not after its first. */
function unplaceable(bp: Blueprint): string[] {
  const cells = new Set(bp.blocks.map((b) => key(b.x, b.y, b.z)));
  const air = new Set(bp.air.map((a) => key(a.x, a.y, a.z)));
  const placed = new Set<string>();
  const bad: string[] = [];
  for (const [i, b] of bp.blocks.entries()) {
    const s = parseState(b.state);
    if (secondHalf(s)) {
      const prev = bp.blocks[i - 1];
      const first = prev ? otherHalf(prev, parseState(prev.state)) : null;
      if (!first || key(first.x, first.y, first.z) !== key(b.x, b.y, b.z)) bad.push(`${b.state} at ${b.x},${b.y},${b.z} is not right after its first half`);
      placed.add(key(b.x, b.y, b.z));
      continue;
    }
    const ground = b.y <= 0 || (b.y === 1 && !cells.has(key(b.x, 0, b.z)) && !air.has(key(b.x, 0, b.z)));
    const sup = support(s);
    let ok: boolean;
    if (sup === 'below') ok = ground || placed.has(key(b.x, b.y - 1, b.z));
    else if (sup === 'behind') {
      const f = s.props.facing;
      const v = f === 'north' ? [0, -1] : f === 'south' ? [0, 1] : f === 'east' ? [1, 0] : [-1, 0];
      ok = placed.has(key(b.x - (v[0] ?? 0), b.y, b.z - (v[1] ?? 0)));
    } else ok = ground || N6.some(([dx, dy, dz]) => placed.has(key(b.x + dx, b.y + dy, b.z + dz)));
    if (!ok) bad.push(`${b.state} at ${b.x},${b.y},${b.z}`);
    placed.add(key(b.x, b.y, b.z));
  }
  return bad;
}

const at = (bp: Blueprint, x: number, y: number, z: number) => bp.blocks.find((b) => b.x === x && b.y === y && b.z === z)?.state;
const design = (d: DesignInput) => DesignSchema.parse(d);
const box = (over: Partial<DesignInput> = {}, part: Record<string, unknown> = {}): DesignInput => ({
  name: 'test house',
  parts: [{ size: [5, 5], walls: 'cobblestone', roof: { style: 'gable', material: 'oak' }, ...part } as never],
  ...over,
});

describe('block states and turning', () => {
  it('reads and writes block states', () => {
    expect(parseState('minecraft:oak_stairs[facing=north,half=bottom]')).toEqual({ name: 'oak_stairs', props: { facing: 'north', half: 'bottom' } });
    expect(formatState({ name: 'oak_door', props: { half: 'lower', facing: 'east' } })).toBe('oak_door[facing=east,half=lower]');
    expect(() => parseState('Not A Block!')).toThrow();
  });

  it('turns a building a quarter at a time, and back after four', () => {
    const s = parseState('oak_log[axis=x]');
    expect(rotateState(s, 1).props.axis).toBe('z');
    expect(rotateState(parseState('oak_stairs[facing=north]'), 1).props.facing).toBe('east');
    expect(rotateState(parseState('oak_stairs[facing=north]'), 4).props.facing).toBe('north');
    const p = { x: 1, y: 2, z: 0 };
    expect(rotatePos(p, 5, 3, 1)).toEqual({ x: 2, y: 2, z: 1 });
    let q = p;
    let w = 5;
    let d = 3;
    for (let i = 0; i < 4; i++) {
      q = rotatePos(q, w, d, 1);
      [w, d] = [d, w];
    }
    expect(q).toEqual(p);
  });

  it('knows what item places a block', () => {
    expect(itemFor('wall_torch')).toBe('torch');
    expect(itemFor('oak_wall_sign')).toBe('oak_sign');
    expect(itemFor('potted_poppy')).toBe('flower_pot');
    expect(itemFor('farmland')).toBe('dirt');
    expect(secondHalf(parseState('oak_door[half=upper]'))).toBe(true);
    expect(secondHalf(parseState('red_bed[part=head]'))).toBe(true);
    expect(secondHalf(parseState('red_bed[part=foot]'))).toBe(false);
  });

  it('names roof families and woods', () => {
    expect(family('spruce')).toMatchObject({ block: 'spruce_planks', stairs: 'spruce_stairs', slab: 'spruce_slab', fence: 'spruce_fence' });
    expect(family('stone_bricks')).toMatchObject({ block: 'stone_bricks', stairs: 'stone_brick_stairs' });
    expect(family('bricks')?.block).toBe('bricks');
    expect(family('gold')).toBeNull();
    expect(woodOf('dark_oak_log')).toBe('dark_oak');
    expect(woodOf('stripped_spruce_log')).toBe('spruce');
    expect(woodOf('cobblestone', undefined, 'birch_planks')).toBe('birch');
    expect(woodOf('cobblestone')).toBe('oak');
  });
});

describe('the building language', () => {
  it('needs parts or a plot, and a door on a part there is', () => {
    expect(DesignSchema.safeParse({ name: 'nothing' }).success).toBe(false);
    expect(DesignSchema.safeParse({ ...box(), door: { part: 2 } }).success).toBe(false);
    expect(DesignSchema.safeParse(box()).success).toBe(true);
    expect(DesignSchema.safeParse({ ...box(), interior: ['bed@1', 'chest'] }).success).toBe(true);
    expect(DesignSchema.safeParse({ ...box(), interior: ['Bed!'] }).success).toBe(false);
  });

  it('compiles a one-room house: shell, door facing in, torches beside it, a roof over all of it', () => {
    const bp = compileDesign(design(box({ interior: ['bed', 'chest'] }, { windows: { every: 2 } })));
    expect(bp.problems).toEqual([]);
    expect(unplaceable(bp)).toEqual([]);
    // The walls stand on a foundation, the door in the middle of the south wall facing in.
    expect(bp.entrance).toMatchObject({ y: 1, out: 'south' });
    const e = bp.entrance;
    if (!e) throw new Error('no entrance');
    expect(at(bp, e.x, 1, e.z)).toMatch(/^oak_door\[facing=north,half=lower/);
    expect(at(bp, e.x, 2, e.z)).toMatch(/^oak_door\[facing=north,half=upper/);
    // Torches outside, either side of the door, hanging on the wall.
    expect(at(bp, e.x - 1, 2, e.z + 1)).toBe('wall_torch[facing=south]');
    expect(at(bp, e.x + 1, 2, e.z + 1)).toBe('wall_torch[facing=south]');
    // The way in is clear.
    expect(bp.air.some((a) => a.x === e.x && a.y === 1 && a.z === e.z + 1)).toBe(true);
    // A bed, foot and head, along one wall; a chest facing into the room.
    const bed = bp.blocks.filter((b) => b.state.startsWith('red_bed'));
    expect(bed.map((b) => parseState(b.state).props.part).sort()).toEqual(['foot', 'head']);
    expect(bp.blocks.some((b) => b.state.startsWith('chest['))).toBe(true);
    // Every column over the walls has roof above the walls.
    const top = 3;
    const footprint = bp.blocks.filter((b) => b.y === 0);
    for (const f of footprint) expect(bp.blocks.some((b) => b.x === f.x && b.z === f.z && b.y > top)).toBe(true);
  });

  it('roofs: gable ends walled up, a hip of rings, a flat roof with a rim, a shed of slabs', () => {
    for (const style of ['gable', 'hip', 'flat', 'shed'] as const) {
      const bp = compileDesign(design(box({}, { size: [7, 5], roof: { style, material: style === 'flat' ? 'stone_brick' : 'spruce' } })));
      expect(bp.problems, style).toEqual([]);
      expect(unplaceable(bp), style).toEqual([]);
      const roofy = bp.blocks.filter((b) => b.y > 3);
      expect(roofy.length, style).toBeGreaterThan(10);
      if (style === 'gable') {
        // Along x (the long way): the east and west ends walled up with the wall's own block.
        expect(roofy.some((b) => b.state === 'cobblestone')).toBe(true);
        expect(roofy.some((b) => /^spruce_stairs\[facing=south/.test(b.state))).toBe(true);
        expect(roofy.some((b) => /^spruce_stairs\[facing=north/.test(b.state))).toBe(true);
      }
      if (style === 'flat') expect(roofy.filter((b) => b.state.startsWith('stone_brick_slab')).length).toBeGreaterThan(10);
      if (style === 'shed') expect(roofy.every((b) => /slab|cobblestone/.test(b.state))).toBe(true);
    }
  });

  it('joins parts into one shell, and their roofs into one roof', () => {
    const d = design({
      name: 'ell',
      parts: [
        { at: [0, 0], size: [9, 5], walls: 'oak_planks', roof: { style: 'gable', material: 'oak', axis: 'x' } },
        { at: [0, 3], size: [5, 6], walls: 'cobblestone', roof: { style: 'gable', material: 'oak', axis: 'z' } },
      ],
      door: { part: 0, side: 'south', offset: 6 },
    });
    const bp = compileDesign(d);
    expect(bp.problems).toEqual([]);
    expect(unplaceable(bp)).toEqual([]);
    // Where the parts meet there is no wall between them: open floor at walking height (the roof's overhang moves
    // everything one east and one south).
    const inside = bp.blocks.filter((b) => b.y === 1 && b.x >= 2 && b.x <= 4 && b.z === 5);
    expect(bp.air.filter((a) => a.y === 1 && a.x >= 2 && a.x <= 4 && a.z === 5).length).toBe(3);
    expect(inside).toEqual([]);
  });

  it('two storeys: a floor between, a ladder up against a solid wall, furniture upstairs when asked', () => {
    const bp = compileDesign(design(box({ interior: ['bed@1', 'chest'] }, { size: [6, 6], floors: 2, walls: ['cobblestone', 'oak_planks'], windows: { every: 2 } })));
    expect(bp.problems).toEqual([]);
    expect(unplaceable(bp)).toEqual([]);
    const ladders = bp.blocks.filter((b) => b.state.startsWith('ladder'));
    expect(ladders.length).toBe(4);
    expect(bp.blocks.filter((b) => b.y === 4 && b.state === 'oak_planks').length).toBeGreaterThan(5);
    expect(bp.blocks.find((b) => b.state.startsWith('red_bed'))?.y).toBe(5);
    expect(bp.blocks.find((b) => b.state.startsWith('chest'))?.y).toBe(1);
  });

  it('a door asked for where a wing covers the wall goes to the nearest place that works, said so', () => {
    const bp = compileDesign(
      design({
        name: 'ell',
        parts: [
          { at: [0, 0], size: [9, 5], walls: 'oak_planks', roof: { style: 'gable', material: 'oak', axis: 'x' } },
          { at: [2, 3], size: [5, 6], walls: 'cobblestone', roof: { style: 'gable', material: 'oak', axis: 'z' } },
        ],
        // The middle of part 0's south wall is inside the wing.
        door: { part: 0, side: 'south' },
      }),
    );
    expect(bp.problems).toEqual([]);
    expect(unplaceable(bp)).toEqual([]);
    expect(bp.entrance).not.toBeNull();
    const e = bp.entrance;
    if (e) {
      const v = e.out === 'north' ? [0, -1] : e.out === 'south' ? [0, 1] : e.out === 'east' ? [1, 0] : [-1, 0];
      // Open ground before it.
      expect(bp.blocks.some((b) => b.x === e.x + (v[0] ?? 0) && b.z === e.z + (v[1] ?? 0) && b.y === 1)).toBe(false);
    }
    // Still on part 0's south side, beside the wing, or said where it went.
    expect(e?.out === 'south' || (bp.notes ?? []).some((n) => n.includes('the door went on'))).toBe(true);
  });

  it('a detail with nothing to go against is left out with a note, not an error', () => {
    const bp = compileDesign(design({ ...box(), details: [{ block: 'lantern[hanging=true]', at: [2, 5, 2] }, { block: 'oak_log', at: [9, 9, 9] }] }));
    expect(bp.problems).toEqual([]);
    expect((bp.notes ?? []).some((n) => n.includes('left out oak_log'))).toBe(true);
    expect(bp.blocks.some((b) => b.state === 'oak_log' && b.y === 9)).toBe(false);
  });

  it('reads blocks and things inside written loosely: case, the minecraft: prefix, a state, spaces', () => {
    const d = design({ ...box({ interior: ['Crafting Table', 'minecraft:chest', 'oak_stairs[facing=north]', 'bed@1'] }, { walls: 'Minecraft:Oak_Planks' }) });
    expect(d.interior).toEqual(['crafting_table', 'chest', 'oak_stairs', 'bed@1']);
    expect(d.parts[0]?.walls).toBe('oak_planks');
  });

  it('says what is wrong with a design rather than building it wrong', () => {
    const bp = compileDesign(design({ ...box({ interior: Array(24).fill('chest') }), parts: [{ size: [3, 3], walls: 'cobblestone', roof: { style: 'gable', material: 'gold' } }] as never }));
    expect(bp.problems.some((p) => p.includes('no roof of gold'))).toBe(true);
    expect(bp.problems.some((p) => p.includes('no room inside for chest'))).toBe(true);
  });

  it('plots: a farm round water, a pen with a gate, a well, a lamp', () => {
    const farm = compileDesign(design({ name: 'farm', kind: 'farm', plot: { type: 'farm', size: [9, 9] } }));
    expect(farm.blocks.filter((b) => b.state === 'farmland').length).toBe(48);
    expect(farm.blocks.filter((b) => b.state === 'water').length).toBe(1);
    expect(farm.entrance?.out).toBe('south');
    const pen = compileDesign(design({ name: 'pen', kind: 'pen', plot: { type: 'pen', size: [5, 6], material: 'spruce' } }));
    expect(pen.blocks.every((b) => /^spruce_fence/.test(b.state))).toBe(true);
    expect(unplaceable(pen)).toEqual([]);
    expect(compileDesign(design({ name: 'well', kind: 'well', plot: { type: 'well' } })).blocks.filter((b) => b.state === 'water').length).toBe(4);
  });
});

describe('the repertoire', () => {
  const rep = new Repertoire({ madeDir: path.join(os.tmpdir(), `agora-none-${process.pid}`), serverDir: '/nonexistent' }).load();

  it('has a dozen and more designs, each compiling cleanly and placeable in order', async () => {
    const all = rep.list({ vanilla: false });
    expect(all.length).toBeGreaterThanOrEqual(15);
    for (const b of all) {
      const bp = await rep.blueprint(b);
      expect(bp.problems, b.id).toEqual([]);
      expect(unplaceable(bp), b.id).toEqual([]);
      if (!b.design?.plot) expect(bp.entrance, b.id).not.toBeNull();
      expect(describeBuilding(b, bp)).toContain(b.id);
    }
    // Every file in the folder is one of them (none was skipped as unreadable).
    expect(fs.readdirSync(buildingsDir()).filter((f) => f.endsWith('.json')).length).toBe(all.length);
  });

  it('finds a building by id, name or kind', () => {
    expect(rep.find('plains-cottage')?.id).toBe('plains-cottage');
    expect(rep.find('Plains Cottage')?.id).toBe('plains-cottage');
    expect(rep.find('tower')?.id).toBe('stone-tower');
    expect(rep.find('farm')?.kind).toBe('farm');
    expect(rep.find('castle in the sky')).toBeUndefined();
  });

  it('keeps a design an agent made, for everyone, without taking another one\'s name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-made-'));
    const r = new Repertoire({ madeDir: dir, serverDir: '/nonexistent' }).load();
    const made = r.save(design({ ...box(), name: 'plains cottage' }), { by: 'Mira' });
    expect(made.id).toBe('plains-cottage-2');
    expect(made.source).toBe('designed by Mira');
    const again = new Repertoire({ madeDir: dir, serverDir: '/nonexistent' }).load();
    expect(again.find('plains-cottage-2')?.source).toBe('designed by Mira');
  });
});

describe('materials', () => {
  it('counts a door and a bed once, a double slab twice, a pot and its flower', () => {
    const bill = billOf({
      blocks: [
        { x: 0, y: 1, z: 0, state: 'oak_door[facing=north,half=lower]' },
        { x: 0, y: 2, z: 0, state: 'oak_door[facing=north,half=upper]' },
        { x: 1, y: 1, z: 0, state: 'red_bed[facing=east,part=foot]' },
        { x: 2, y: 1, z: 0, state: 'red_bed[facing=east,part=head]' },
        { x: 3, y: 1, z: 0, state: 'stone_slab[type=double]' },
        { x: 4, y: 1, z: 0, state: 'potted_poppy' },
        { x: 5, y: 2, z: 0, state: 'wall_torch[facing=north]' },
      ],
    });
    expect(Object.fromEntries(bill)).toEqual({ oak_door: 1, red_bed: 1, stone_slab: 2, flower_pot: 1, poppy: 1, torch: 1 });
  });

  it('works out the crafting from what is gathered, in the building\'s wood', () => {
    const p = planMaterials([{ item: 'spruce_door', count: 1 }, { item: 'glass_pane', count: 4 }, { item: 'stripped_spruce_log', count: 2 }], { wood: 'spruce' });
    expect(p.unknown).toEqual([]);
    const step = (item: string) => p.steps.find((s) => s.item === item);
    expect(step('spruce_door')).toMatchObject({ how: 'craft', times: 1, table: true });
    expect(step('spruce_door')?.from).toEqual([{ item: 'spruce_planks', count: 6 }]);
    expect(step('glass')).toMatchObject({ how: 'smelt', count: 6 });
    expect(step('stripped_spruce_log')).toMatchObject({ how: 'strip', count: 2 });
    expect(p.raw.map((r) => r.item).sort()).toEqual(['sand', 'spruce_log']);
    // Planks before the door made of them.
    expect(p.steps.findIndex((s) => s.item === 'spruce_planks')).toBeLessThan(p.steps.findIndex((s) => s.item === 'spruce_door'));
    // What is in hand is counted off first.
    expect(planMaterials([{ item: 'glass_pane', count: 4 }], { have: new Map([['glass_pane', 10]]) }).steps).toEqual([]);
  });

  it('rates how hard things are to get, and swaps the hard ones for lookalikes, keeping their shape', () => {
    expect(difficulty('packed_ice')).toBeGreaterThan(difficulty('lantern'));
    expect(difficulty('lantern')).toBeGreaterThan(difficulty('glass_pane'));
    expect(difficulty('glass', { raw: { sand: 40 } })).toBeGreaterThan(30);
    expect(splitShape('stone_brick_stairs')).toEqual({ material: 'stone_bricks', shape: 'stairs' });
    expect(inShape('cobblestone', 'stairs')).toBe('cobblestone_stairs');
    expect(inShape('snow_block', 'stairs')).toBeNull();
    const bp: Blueprint = {
      name: 't',
      size: { x: 3, y: 2, z: 1 },
      blocks: [
        { x: 0, y: 1, z: 0, state: 'packed_ice' },
        { x: 1, y: 1, z: 0, state: 'glass_pane' },
        { x: 2, y: 1, z: 0, state: 'quartz_stairs[facing=east,half=bottom]' },
      ],
      air: [],
      entrance: null,
      footprint: [],
      problems: [],
    };
    const { blueprint, swaps } = substitute(bp, { raw: { sand: 40, quartz: 40 } });
    expect(blueprint.blocks.map((b) => b.state)).toEqual(['snow_block', 'oak_fence', 'diorite_stairs[facing=east,half=bottom]']);
    expect(swaps.map((s) => s.from).sort()).toEqual(['glass_pane', 'packed_ice', 'quartz_stairs']);
    // Woods swapped for the one at hand.
    expect(substitute(bp, { wood: 'spruce', raw: { sand: 40, quartz: 40 } }).blueprint.blocks[1]?.state).toBe('spruce_fence');
  });
});

/** A zip of stored entries, written by hand. */
function zipOf(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    locals.push(l, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Object.keys(files).length, 8);
  e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

/** A tiny village house as the game saves one: a floor, a door facing in, a jigsaw at the step. */
function structureFile(): Buffer {
  const pal = (name: string, props?: Record<string, string>) =>
    props ? { Name: nbt.string(`minecraft:${name}`), Properties: nbt.comp(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, nbt.string(v)]))) } : { Name: nbt.string(`minecraft:${name}`) };
  const palette = [
    pal('cobblestone'),
    pal('air'),
    pal('oak_door', { facing: 'east', half: 'lower', hinge: 'left', open: 'false', powered: 'false' }),
    pal('oak_door', { facing: 'east', half: 'upper', hinge: 'left', open: 'false', powered: 'false' }),
    pal('jigsaw', { orientation: 'west_up' }),
    pal('grass_block', { snowy: 'false' }),
  ];
  const blocks: { pos: number[]; state: number; nbt?: object }[] = [];
  for (let x = 1; x <= 3; x++) for (let z = 0; z <= 2; z++) blocks.push({ pos: [x, 0, z], state: 0 });
  blocks.push({ pos: [0, 0, 0], state: 5 }, { pos: [0, 0, 2], state: 5 }, { pos: [0, 1, 0], state: 1 }, { pos: [2, 1, 1], state: 1 });
  blocks.push({ pos: [1, 1, 1], state: 2 }, { pos: [1, 2, 1], state: 3 });
  for (const z of [0, 2]) for (const y of [1, 2]) blocks.push({ pos: [1, y, z], state: 0 });
  for (let z = 0; z <= 2; z++) for (const y of [1, 2]) blocks.push({ pos: [3, y, z], state: 0 });
  const tag = nbt.comp({
    DataVersion: nbt.int(4790),
    size: nbt.list(nbt.int([4, 3, 3])),
    palette: nbt.list(nbt.comp(palette)),
    blocks: nbt.list(
      nbt.comp([
        ...blocks.map((b) => ({ pos: nbt.list(nbt.int(b.pos)), state: nbt.int(b.state) })),
        { pos: nbt.list(nbt.int([0, 0, 1])), state: nbt.int(4), nbt: nbt.comp({ final_state: nbt.string('minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]') }) },
      ]),
    ),
    entities: nbt.list(nbt.comp([])),
  }, '');
  return zlib.gzipSync(nbt.writeUncompressed(tag as never));
}

describe("the game's own buildings", () => {
  it('reads a zip in place: its directory and an entry', () => {
    const z = Zip.of(zipOf({ 'a.txt': Buffer.from('hello'), 'data/minecraft/structure/village/plains/houses/plains_small_house_9.nbt': Buffer.from('x') }));
    expect(z.read('a.txt')?.toString()).toBe('hello');
    expect(z.read('missing')).toBeNull();
    expect(listVanilla(z)).toEqual([{ id: 'vanilla:plains_small_house_9', biome: 'plains', file: 'plains_small_house_9', name: 'plains small house 9', kind: 'house' }]);
  });

  it('turns a structure file into a blueprint: ground at the door, the step from the jigsaw, the ground left as it is', async () => {
    const bp = await blueprintFromStructure('tiny', structureFile());
    expect(bp.problems).toEqual([]);
    expect(unplaceable(bp)).toEqual([]);
    // The door stands on the floor (y 0), facing in from the west; the way out is west.
    expect(bp.entrance).toMatchObject({ y: 1, out: 'west' });
    expect(at(bp, bp.entrance?.x ?? -1, 1, bp.entrance?.z ?? -1)).toBe('oak_door[facing=east,half=lower,hinge=left]');
    // The jigsaw became the step it said; grass in the ground layer is left to the site.
    expect(bp.blocks.some((b) => b.state === 'oak_stairs[facing=east,half=bottom]')).toBe(true);
    expect(bp.blocks.some((b) => b.state.startsWith('grass_block'))).toBe(false);
    // Air at ground level isn't dug out; air above it is cleared.
    expect(bp.air.every((a) => a.y >= 1)).toBe(true);
  });

  it('names what a village building is for', () => {
    expect(vanillaKind('plains_small_house_3')).toBe('house');
    expect(vanillaKind('desert_armorer_1')).toBe('smithy');
    expect(vanillaKind('taiga_large_farm_1')).toBe('farm');
    expect(vanillaKind('plains_stable_1')).toBe('barn');
  });

  const jarHere = fs.existsSync(path.join(process.cwd(), 'data', 'server', 'versions'));
  it.skipIf(!jarHere)("reads every village building of the owner's own server jar, when it is there", async () => {
    const jar = openGameJar(path.join(process.cwd(), 'data', 'server'));
    expect(jar).not.toBeNull();
    if (!jar) return;
    const list = listVanilla(jar);
    expect(list.length).toBeGreaterThan(100);
    const r = new Repertoire({ serverDir: path.join(process.cwd(), 'data', 'server'), madeDir: path.join(os.tmpdir(), 'agora-none') }).load();
    const small = r.find('vanilla:plains_small_house_1');
    expect(small).toBeDefined();
    if (small) {
      const bp = await r.blueprint(small);
      expect(bp.problems).toEqual([]);
      expect(bp.entrance?.out).toBe('west');
      expect(bp.blocks.some((b) => b.state.startsWith('oak_stairs'))).toBe(true);
    }
    r.close();
    jar.close();
  });
});

describe('names and enchantments on items', () => {
  it('reads a name however the game sends it', async () => {
    const { customNameOf } = await import('@agora/agent/body/skills/enchanting');
    const item = (customName: unknown) => ({ customName }) as never;
    expect(customNameOf(item('Hope'))).toBe('Hope');
    expect(customNameOf(item('{"text":"Digger"}'))).toBe('Digger');
    expect(customNameOf(item({ text: 'Ember' }))).toBe('Ember');
    expect(customNameOf(item({ type: 'compound', value: { text: { type: 'string', value: 'Frost' } } }))).toBe('Frost');
    expect(customNameOf(item(null))).toBeNull();
    expect(customNameOf(null)).toBeNull();
  });

  it('reads enchantments by name and level, from either shape', async () => {
    const { enchantsOf } = await import('@agora/agent/body/skills/enchanting');
    const bot = { registry: { enchantments: { 5: { name: 'sharpness' } } } } as never;
    expect(enchantsOf(bot, { enchants: [{ name: 'sharpness', lvl: 2 }] } as never)).toEqual([{ name: 'sharpness', lvl: 2 }]);
    expect(enchantsOf(bot, { enchants: { enchantments: [{ id: 5, level: 3 }] } } as never)).toEqual([{ name: 'sharpness', lvl: 3 }]);
    expect(enchantsOf(bot, { enchants: [{ id: 'minecraft:unbreaking', level: 1 }] } as never)).toEqual([{ name: 'unbreaking', lvl: 1 }]);
    expect(enchantsOf(bot, null)).toEqual([]);
  });
});

describe('a nether portal frame', () => {
  it('is ten obsidian and four corners round a two-by-three opening, each block with something to stand on', async () => {
    const { portalBlueprint } = await import('@agora/agent/body/skills/expedition');
    const bp = portalBlueprint('cobblestone');
    const names = bp.blocks.map((b) => b.state);
    expect(names.filter((n) => n === 'obsidian')).toHaveLength(10);
    expect(names.filter((n) => n === 'cobblestone')).toHaveLength(4);
    expect(bp.air).toHaveLength(6);
    expect(bp.size).toEqual({ x: 4, y: 6, z: 1 });
    expect(bp.problems).toEqual([]);
  });
});

describe("what a model's design names, made real", () => {
  it('a porch or a fence of a wood by name is of that wood; a block the game lacks is reported', async () => {
    const { unknownBlocks } = await import('@agora/agent/building/materials');
    const design = DesignSchema.parse({
      name: 'birch porch house',
      kind: 'house',
      wallHeight: 3,
      parts: [{ size: [7, 6], walls: 'oak_planks', posts: 'oak_log', roof: { style: 'gable', material: 'birch' } }],
      door: { side: 'south', material: 'birch' },
      features: [{ type: 'porch', side: 'south', material: 'birch' }, { type: 'fence', material: 'spruce' }, { type: 'chimney', material: 'stone_brick' }],
    });
    const bp = compileDesign(design);
    const names = new Set(bp.blocks.map((b) => parseState(b.state).name));
    expect(unknownBlocks(bp)).toEqual([]);
    expect(names.has('birch_fence')).toBe(true);
    expect(names.has('birch_slab')).toBe(true);
    expect(names.has('spruce_fence')).toBe(true);
    expect(names.has('spruce_fence_gate')).toBe(true);
    expect(names.has('birch')).toBe(false);
    expect(unknownBlocks({ blocks: [{ x: 0, y: 1, z: 0, state: 'birch' }, { x: 1, y: 1, z: 0, state: 'oak_planks' }] })).toEqual(['birch']);
  });

  it('a trapdoor against the block above faces away from the one placing it; against a side, from that side', async () => {
    const { clickFor, yawOf } = await import('@agora/agent/body/skills/construct');
    const { Vec3 } = await import('@agora/agent/body/bot');
    const solidAt = (cells: string[]) =>
      ({
        blockAt: (p: { x: number; y: number; z: number }) => {
          const solid = cells.includes(`${p.x},${p.y},${p.z}`);
          return { position: new Vec3(p.x, p.y, p.z), name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
        },
      }) as never;
    const top = parseState('birch_trapdoor[facing=north,half=top]');
    // Only the block above to go against: clicked from below, the placer faces south.
    const above = clickFor(solidAt(['5,6,5']), new Vec3(5, 5, 5), top);
    expect(above?.face.equals(new Vec3(0, -1, 0))).toBe(true);
    expect(above?.yaw).toBe(yawOf('south'));
    // The block behind it (south) there: its north face, the top half, no turning needed.
    const side = clickFor(solidAt(['5,5,6', '5,6,5']), new Vec3(5, 5, 5), top);
    expect(side?.face.equals(new Vec3(0, 0, -1))).toBe(true);
    expect(side?.half).toBe('top');
    expect(side?.yaw).toBeUndefined();
  });

  it('a building asked for well above the ground goes down onto it; on it, or a block over it, it stays', async () => {
    const { onTheGround } = await import('@agora/agent/body/skills/construct');
    const { Vec3 } = await import('@agora/agent/body/bot');
    // Ground at 76 under a forest, its leaves from 80 to 83; a bank rising to 78 along the north edge.
    const world = {
      blockAt: (p: { x: number; y: number; z: number }) => {
        const ground = p.z === 0 ? 78 : 76;
        const name = p.y <= ground ? 'dirt' : p.y >= 80 && p.y <= 83 ? 'oak_leaves' : 'air';
        return { position: new Vec3(p.x, p.y, p.z), name, boundingBox: name === 'air' ? 'empty' : 'block' };
      },
    } as never;
    const size = { x: 5, z: 5 };
    expect(onTheGround(world, new Vec3(0, 82, 0), size).y).toBe(76);
    expect(onTheGround(world, new Vec3(0, 76, 0), size).y).toBe(76);
    expect(onTheGround(world, new Vec3(0, 77, 0), size).y).toBe(77);
    expect(onTheGround(world, new Vec3(0, 78, 0), size).y).toBe(78);
  });
});

describe("a building's needs said as kinds where any will do (one told \"1 red bed\" and \"1 oak door\" chased red dye and oak)", () => {
  it('a bed or wool of any colour, planks, a door or a log of any wood; the rest as they are', async () => {
    const { needLabel } = await import('@agora/agent/body/skills/construct');
    expect(needLabel('red_bed')).toBe('bed (any colour)');
    expect(needLabel('red_wool')).toBe('wool (any colour)');
    expect(needLabel('oak_door')).toBe('door (any wood)');
    expect(needLabel('oak_planks')).toBe('planks (any wood)');
    expect(needLabel('oak_log')).toBe('log (any wood)');
    expect(needLabel('cobblestone')).toBe('cobblestone');
    expect(needLabel('crafting_table')).toBe('crafting table');
  });
});

describe('shelter: until healed by day, until morning otherwise (asked to heal at 4 health, it said "it is already day")', () => {
  it('untilMorning is the default only when lying low until healed was not asked for', async () => {
    const { shelter } = await import('@agora/agent/body/skills/building');
    expect(shelter.parseArgs({})).toEqual({ ok: true, args: { untilMorning: true, untilHealed: false } });
    expect(shelter.parseArgs({ untilHealed: true })).toEqual({ ok: true, args: { untilMorning: false, untilHealed: true } });
    expect(shelter.parseArgs({ untilMorning: true, untilHealed: true })).toEqual({ ok: true, args: { untilMorning: true, untilHealed: true } });
  });
});
