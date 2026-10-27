// Whether something on foot could get to us (perception/reach.ts): said "no" only where our pocket is shut in.

import { describe, expect, it } from 'vitest';
import type { Bot } from '@agora/agent/body/bot';
import { Vec3 } from '@agora/agent/body/bot';
import { waysOnFoot } from '@agora/agent/perception/reach';

type Cell = string | { name: string; open: boolean };

/** Grass up to y 63, air over it, with `cells` set apart ("x,y,z"); null past x 40 (not loaded). */
function world(me: Vec3, cells: Record<string, Cell>, ground = (_x: number, _z: number) => 63): Bot {
  const blockAt = (p: Vec3) => {
    const f = p.floored();
    if (Math.abs(f.x) > 40) return null;
    const c = cells[`${f.x},${f.y},${f.z}`];
    const name = c === undefined ? (f.y <= ground(f.x, f.z) ? 'grass_block' : 'air') : typeof c === 'string' ? c : c.name;
    const open = typeof c === 'object' ? c.open : undefined;
    const empty = /^(air|short_grass|water|ladder)$/.test(name);
    return { name, position: f, boundingBox: empty ? 'empty' : 'block', getProperties: () => (open === undefined ? {} : { open }) };
  };
  return { entity: { position: me }, blockAt } as unknown as Bot;
}

const at = (x: number, y: number, z = 0) => new Vec3(x + 0.5, y, z + 0.5);

describe('whether something on foot could get to us', () => {
  it('up a pillar three high: no way up from anywhere round its foot', () => {
    const cells: Record<string, Cell> = { '0,64,0': 'oak_planks', '0,65,0': 'oak_planks', '0,66,0': 'oak_planks' };
    const bot = world(at(0, 67), cells);
    expect(waysOnFoot(bot, [at(1, 64), at(5, 64, 3)])).toEqual([false, false]);
  });

  it('two high is out of a blow too; one high is not (a step up, or a blow from beside it)', () => {
    const two = world(at(0, 66), { '0,64,0': 'dirt', '0,65,0': 'dirt' });
    expect(waysOnFoot(two, [at(1, 64)])).toEqual([false]);
    const one = world(at(0, 65), { '0,64,0': 'dirt' });
    expect(waysOnFoot(one, [at(2, 64)])).toEqual([true]);
  });

  it('out on open ground: a way, from near or far', () => {
    const bot = world(at(0, 64), {});
    expect(waysOnFoot(bot, [at(2, 64), at(9, 64, 4)])).toEqual([true, true]);
  });

  it('in a room shut on every side: no way in; its door open, a way', () => {
    // A room of stone, its floor at 64 from -1 to 1, walls two high round it, a roof over; the door on the east.
    const room = (open: boolean) => {
      const cells: Record<string, Cell> = {};
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++) {
          cells[`${x},66,${z}`] = 'stone';
          if (Math.abs(x) === 2 || Math.abs(z) === 2) for (const y of [64, 65]) cells[`${x},${y},${z}`] = 'stone';
        }
      cells['2,64,0'] = { name: 'oak_door', open };
      cells['2,65,0'] = { name: 'oak_door', open };
      return world(at(0, 64), cells);
    };
    expect(waysOnFoot(room(false), [at(5, 64)])).toEqual([false]);
    expect(waysOnFoot(room(true), [at(5, 64)])).toEqual([true]);
  });

  it('down a hole two deep: what stands at its rim is no blow from us', () => {
    const bot = world(at(0, 62), { '0,62,0': 'air', '0,63,0': 'air' });
    expect(waysOnFoot(bot, [at(1, 64)])).toEqual([false]);
  });

  it('a stair: a way up it', () => {
    // Steps cut into a hill of stone that rises to the east.
    const cells: Record<string, Cell> = {};
    for (let i = 0; i < 4; i++) for (let z = -1; z <= 1; z++) for (let y = 64; y < 64 + i; y++) cells[`${i},${y},${z}`] = 'stone';
    const bot = world(at(3, 67), cells);
    expect(waysOnFoot(bot, [at(-2, 64)])).toEqual([true]);
  });

  it('on top of a cliff wider than is looked at: nothing said of what is below it', () => {
    const bot = world(at(0, 68), {}, (x) => (x <= 2 ? 67 : 63));
    expect(waysOnFoot(bot, [at(5, 64)])).toEqual([null]);
  });

  it('a creature in the air, or nothing loaded about it: nothing said of it', () => {
    const bot = world(at(0, 64), {});
    expect(waysOnFoot(bot, [at(3, 70)])).toEqual([null]);
  });
});
