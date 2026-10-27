// The room one stands in, seen from inside (a builder who could not fill his hut's doorway waited out the night beside
// it, believing himself sealed in), and the day as it is felt (in the evening, "until day" is the next morning). A tiny
// voxel world stands in for the client's: ground below y = 0.

import { describe, expect, it } from 'vitest';
import type { Bot } from '@agora/agent/body/bot';
import { Vec3 } from '@agora/agent/body/bot';
import { besideWords, daytime, goingFor, roomAround, roomBeside, roomWords } from '@agora/agent/body/world';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { SeededRandom, nullLogger } from '@agora/shared';
import { dropTheBodyTakes, goTo } from '@agora/agent/body/skills/movement';
import { createMovements } from '@agora/agent/body/plugins';
import { evalCondition } from '@agora/agent/modules/conditions';
import { openedUp, waysOut, whereNow } from '@agora/agent/perception/scene';
import { createInitialState } from '@agora/agent/state/initial';
import { PersonaSchema } from '@agora/shared';

type Cell = 'solid' | 'air' | 'door' | 'open_door';

function world(cells: Record<string, Cell>, at = new Vec3(0.5, 0, 0.5)): Bot {
  const cell = (p: Vec3): Cell => cells[`${p.x},${p.y},${p.z}`] ?? (p.y < 0 ? 'solid' : 'air');
  const blockAt = (p: Vec3) => {
    const f = p.floored();
    const c = cell(f);
    if (c === 'door' || c === 'open_door') return { position: f, name: 'oak_door', boundingBox: 'block', getProperties: () => ({ open: c === 'open_door' }) };
    return { position: f, name: c === 'solid' ? 'cobblestone' : 'air', boundingBox: c === 'solid' ? 'block' : 'empty', getProperties: () => ({}) };
  };
  return { entity: { position: at }, blockAt } as unknown as Bot;
}

/** A hut: walls two high around a room `w` across (its corner at 0,0), a roof over it all, a gap or door in the north wall. */
function hut(w: number, door: Cell | null): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (let x = -1; x <= w; x++) {
    for (let z = -1; z <= w; z++) {
      out[`${x},2,${z}`] = 'solid';
      const wall = x === -1 || x === w || z === -1 || z === w;
      for (const y of [0, 1]) out[`${x},${y},${z}`] = wall ? 'solid' : 'air';
    }
  }
  const mid = Math.floor((w - 1) / 2);
  if (door === 'door' || door === 'open_door') {
    out[`${mid},0,-1`] = door;
    out[`${mid},1,-1`] = door;
  } else if (door === 'air') {
    out[`${mid},0,-1`] = 'air';
    out[`${mid},1,-1`] = 'air';
  }
  return out;
}

describe('the room one stands in', () => {
  it('a hut one across with its doorway open: walled in but open to the north', () => {
    const r = roomAround(world(hut(1, 'air')));
    expect(r?.open).toEqual(['north']);
    expect(roomWords(r)).toBe('walled in but open to the north');
  });

  it('the doorway filled: walled in on every side', () => {
    expect(roomWords(roomAround(world(hut(1, null))))).toBe('walled in on every side');
  });

  it('a room three across with its door shut, and with it open', () => {
    const shut = roomAround(world(hut(3, 'door'), new Vec3(1.5, 0, 1.5)));
    expect(shut?.cells).toBe(9);
    expect(roomWords(shut)).toBe('inside a room, shut in on every side (a door to the north, shut)');
    const open = roomAround(world(hut(3, 'open_door'), new Vec3(1.5, 0, 1.5)));
    expect(roomWords(open)).toBe('inside a room, open to the north (the door to the north standing open)');
  });

  it('outside the hut, beside its wall: no room', () => {
    expect(roomAround(world(hut(1, 'air'), new Vec3(3.5, 0, 0.5)))).toBeNull();
  });

  it('just outside a hut: the room beside, which way, and whether it is shut (one who shut himself out waited the night "sealed in")', () => {
    const shut = world(hut(1, null), new Vec3(2.5, 0, 0.5));
    expect(roomAround(shut)).toBeNull();
    expect(besideWords(roomBeside(shut))).toBe('outside a room 2 m to the west, shut on every side');
    const open = world(hut(1, 'air'), new Vec3(2.5, 0, 0.5));
    expect(besideWords(roomBeside(open))).toBe('outside a room 2 m to the west, open to the north');
    // Out in a field, nothing.
    expect(roomBeside(world({}))).toBeNull();
  });

  it('a shut room opened up round one is seen at once; a door one opened, or a dig of one\'s own, is not that', () => {
    const at = new Vec3(1.5, 0, 1.5);
    const shut = roomAround(world(hut(3, null), at));
    expect(shut?.open).toEqual([]);
    // A creeper takes out the east wall at the feet and the head.
    const blown = { ...hut(3, null), '3,0,1': 'air' as const, '3,1,1': 'air' as const };
    const after = roomAround(world(blown, at));
    expect(openedUp(at, after, at, false)).toEqual(['east']);
    // Moved off since, or digging: not a breach seen from where one sat.
    expect(openedUp(at, after, new Vec3(5.5, 0, 1.5), false)).toBeNull();
    expect(openedUp(at, after, at, true)).toBeNull();
    // The door opened (by oneself, or anyone): a door, not a hole.
    expect(openedUp(at, roomAround(world(hut(3, 'open_door'), at)), at, false)).toBeNull();
    // Never shut: nothing opened.
    expect(openedUp(null, after, at, false)).toBeNull();
  });

  it('a cave too big to take in as a room: none', () => {
    const cave: Record<string, Cell> = {};
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) cave[`${x},4,${z}`] = 'solid';
    expect(roomAround(world(cave))).toBeNull();
  });
});

describe('where the hands are going', () => {
  /** Stone from y -40 to 40 with a mine at y 0, a tree's log out on the grass at 30,41,20 under the open sky. */
  function mine(): Bot {
    const blockAt = (p: Vec3) => {
      const f = p.floored();
      const log = f.x === 30 && f.y === 41 && f.z === 20;
      const tunnel = f.y >= 0 && f.y <= 1 && f.z === 0 && f.x >= 0 && f.x <= 40;
      const solid = log || (f.y <= 40 && f.y >= -40 && !tunnel);
      return { position: f, name: log ? 'oak_log' : solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', skyLight: solid ? 0 : f.y > 40 ? 15 : 0, getProperties: () => ({}) };
    };
    return { entity: { position: new Vec3(0.5, 0, 0.5) }, blockAt, game: { minY: -64, height: 384, dimension: 'overworld' }, world: {}, time: { timeOfDay: 1000 } } as unknown as Bot;
  }

  it('a block a walk away: how far, which way, how far up, and out under the open sky from down a mine', () => {
    expect(goingFor(mine(), new Vec3(30, 41, 20))).toBe('36 m south-east, 41 m up, out under the open sky');
    // Down the same tunnel, not under the sky.
    expect(goingFor(mine(), new Vec3(30, 0, 0))).toBe('30 m east');
    // Close by: nothing to say.
    expect(goingFor(mine(), new Vec3(3, 0, 0))).toBe('');
  });

  it('underground however low the ceiling, what it is, and how far up the sky is (a notch of a cave pond had been "under a roof")', () => {
    expect(whereNow(mine()).text).toContain('underground, the ceiling 2 m up (stone), the open sky some 41 blocks up');
  });
});

describe('the ways out, as a player sees them in a fight', () => {
  /**
   * Grass at y 63 under the feet at 0,64,0: a stone wall a block east (x 1, two high), water 5 m north, the ground ends
   * 4 m south over a 10 m drop, and open ground west.
   */
  function field(): Bot {
    const blockAt = (p: Vec3) => {
      const f = p.floored();
      const wall = f.x === 1 && f.z >= -1 && f.z <= 1 && f.y >= 64 && f.y <= 65;
      const water = f.z <= -5 && f.z >= -8 && f.y === 64 && Math.abs(f.x) <= 2;
      const ground = f.y === 63 && f.z <= 4;
      const deep = f.y === 53 && f.z > 4;
      const solid = wall || ground || deep;
      return { position: f, name: wall ? 'stone' : water ? 'water' : ground || deep ? 'grass_block' : 'air', boundingBox: solid ? 'block' : 'empty', getProperties: () => ({}) };
    };
    return { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt, game: { minY: -64, height: 384, dimension: 'overworld' } } as unknown as Bot;
  }

  it('up on a pillar, says so: how far above the ground it stands on every side; on the ground, nothing of the kind', () => {
    // Three blocks of planks on grass, the feet on top of them.
    const blockAt = (p: Vec3) => {
      const f = p.floored();
      const pillar = f.x === 0 && f.z === 0 && f.y >= 64 && f.y <= 66;
      const ground = f.y === 63;
      return { position: f, name: pillar ? 'oak_planks' : ground ? 'grass_block' : 'air', boundingBox: pillar || ground ? 'block' : 'empty', getProperties: () => ({}), skyLight: 15 };
    };
    const bot = (x: number, y: number) => ({ entity: { position: new Vec3(x, y, 0.5) }, blockAt, game: { minY: -64, height: 384, dimension: 'overworld' }, world: {}, time: { timeOfDay: 1000 } }) as unknown as Bot;
    expect(whereNow(bot(0.5, 67)).text).toContain('standing on oak planks, up 3 m above the ground on every side');
    // At its foot, on the grass beside it: nothing of the kind.
    expect(whereNow(bot(2.5, 64)).text).toContain('standing on grass block');
    expect(whereNow(bot(2.5, 64)).text).not.toContain('above the ground');
  });

  it('says how far each way goes on foot, and what stops it: a wall to dig into, water, a drop', () => {
    const w = waysOut(field()) ?? '';
    expect(w).toContain('west 16+ m');
    expect(w).toContain('north 4 m (then water)');
    expect(w).toMatch(/not .*east \(stone in the way right there\)/);
    expect(w).toContain('south 4 m (then a drop of 10 m)');
  });
});

describe('the drop the body can take', () => {
  it('is three blocks, and a block more for every three health on hand: a fall kept within a third of it', () => {
    expect(dropTheBodyTakes(20)).toBe(9);
    expect(dropTheBodyTakes(4)).toBe(4);
    expect(dropTheBodyTakes(2)).toBe(3);
    // A 9-block fall costs 6 health (3 free, then one for each block), a third of 20.
    expect(dropTheBodyTakes(20) - 3).toBeLessThanOrEqual(20 / 3);
  });

  it('is for that one way down: the walk settings every walk shares keep their usual drop after it', async () => {
    const shared = { maxDropDown: 3 };
    const tried: number[] = [];
    const bot = Object.assign(new EventEmitter(), {
      health: 20,
      entity: { position: new Vec3(0, 70, 0) },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      pathfinder: {
        setMovements: (m: { maxDropDown: number }) => tried.push(m.maxDropDown),
        goto: () => Promise.reject(new Error('No path to the goal!')),
        stop: () => undefined,
        setGoal: () => undefined,
      },
      clearControlStates: () => undefined,
    });
    const ctx = { bot: bot as unknown as Bot, signal: new AbortController().signal, logger: nullLogger(), rng: new SeededRandom(1), movements: () => shared, slip: null, progress: () => undefined };
    const r = await goTo.run(ctx as never, { x: 0, y: 64, z: 6, range: 1 });
    expect(r.ok).toBe(false);
    expect(tried).toContain(9);
    expect(shared.maxDropDown).toBe(3);
  });
});

describe('walks keep their heads above water', () => {
  it('a step with the head under water costs more than one with the head in the air, a wade or a swim at the top', () => {
    const require = createRequire(import.meta.url);
    const mcData = require(require.resolve('minecraft-data', { paths: [require.resolve('mineflayer', { paths: [`${process.cwd()}/packages/agent`] })] })) as (v: string) => { blocksByName: Record<string, { id: number } | undefined> };
    const registry = mcData('26.1.2');
    const water = registry.blocksByName.water?.id ?? -1;
    const air = registry.blocksByName.air?.id ?? -2;
    // Under at x 0 (water over water); at the top at x 1 (air over the water); dry ground at x 2.
    const world = new Map<string, number>([
      ['0,64,0', water],
      ['0,65,0', water],
      ['1,64,0', water],
    ]);
    const blockAt = (p: Vec3) => ({ type: world.get(`${p.x},${p.y},${p.z}`) ?? air, position: p, name: world.has(`${p.x},${p.y},${p.z}`) ? 'water' : 'air', boundingBox: 'empty' });
    const bot = { registry, blockAt, health: 20, time: { timeOfDay: 1000 }, entity: { position: new Vec3(0, 64, 0) } };
    const m = createMovements(bot as unknown as Bot) as unknown as { exclusionStep(b: unknown): number };
    const under = m.exclusionStep(blockAt(new Vec3(0, 64, 0)));
    expect(under).toBeGreaterThanOrEqual(4);
    expect(m.exclusionStep(blockAt(new Vec3(1, 64, 0)))).toBe(0);
    expect(m.exclusionStep(blockAt(new Vec3(2, 64, 0)))).toBe(0);
  });
});

describe('the day as it is felt', () => {
  it('daytime runs from first light to the evening', () => {
    expect(daytime(1000)).toBe(true);
    expect(daytime(9000)).toBe(true);
    expect(daytime(10_000)).toBe(false);
    expect(daytime(13_000)).toBe(false);
    expect(daytime(22_000)).toBe(false);
    expect(daytime(23_500)).toBe(true);
    expect(daytime(24_000 * 3 + 500)).toBe(true);
  });

  it('in the evening, "until day" is the next morning', () => {
    const s = createInitialState({ persona: PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['practical'] }), username: 'Ada', now: 0 });
    const evening = { ...s, self: { ...s.self, isDay: true, time: 10_500 } };
    expect(evalCondition('timeIs:day', evening)).toBe(false);
    expect(evalCondition('timeIs:day', { ...s, self: { ...s.self, isDay: true, time: 3000 } })).toBe(true);
  });
});
