// No x-ray (§13 rule 4): what a bot counts as seen. A tiny voxel world stands in for the client's: ground below
// y = 0, solid cells block rays, shapeless ones (flowers) let them through.

import { describe, expect, it } from 'vitest';
import type { Bot } from '@agora/agent/body/bot';
import { Vec3 } from '@agora/agent/body/bot';
import { isInferable } from '@agora/agent/body/sightings';
import { canSeeBlock } from '@agora/agent/body/world';

type Cell = 'solid' | 'air' | 'flower' | 'unloaded';

function fakeBot(overrides: Record<string, Cell>): Bot {
  const cell = (p: Vec3): Cell => overrides[`${p.x},${p.y},${p.z}`] ?? (p.y < 0 ? 'solid' : 'air');
  const blockAt = (p: Vec3) => {
    const f = p.floored();
    const c = cell(f);
    if (c === 'unloaded') return null;
    return { position: f, name: c === 'solid' ? 'stone' : c === 'flower' ? 'poppy' : 'air', shapes: c === 'solid' ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  const raycast = (from: Vec3, dir: Vec3, range: number) => {
    for (let d = 0; d <= range; d += 0.01) {
      const p = from.plus(dir.scaled(d)).floored();
      if (cell(p) === 'solid') return { position: p };
    }
    return null;
  };
  return { entity: { position: new Vec3(0.5, 0, 0.5), eyeHeight: 1.62 }, blockAt, world: { raycast } } as unknown as Bot;
}

describe('line of sight to blocks', () => {
  it('sees ore that shows its top, not ore under a cover', () => {
    expect(canSeeBlock(fakeBot({}), new Vec3(3, -1, 0))).toBe(true);
    expect(canSeeBlock(fakeBot({ '3,0,0': 'solid' }), new Vec3(3, -1, 0))).toBe(false);
    expect(canSeeBlock(fakeBot({}), new Vec3(3, -2, 0))).toBe(false);
  });

  it('sees a flower in the open but not behind a wall', () => {
    expect(canSeeBlock(fakeBot({ '3,0,0': 'flower' }), new Vec3(3, 0, 0))).toBe(true);
    expect(canSeeBlock(fakeBot({ '3,0,0': 'flower', '2,0,0': 'solid', '2,1,0': 'solid', '2,2,0': 'solid' }), new Vec3(3, 0, 0))).toBe(false);
  });

  it('sees nothing where the chunk is not loaded, and nothing past the range', () => {
    expect(canSeeBlock(fakeBot({ '3,-1,0': 'unloaded' }), new Vec3(3, -1, 0))).toBe(false);
    expect(canSeeBlock(fakeBot({}), new Vec3(40, -1, 0), 16)).toBe(false);
  });

  it('lets bots infer the ground and vegetation, but not rare blocks', () => {
    expect(isInferable('stone')).toBe(true);
    expect(isInferable('oak_log')).toBe(true);
    expect(isInferable('poppy')).toBe(false);
    expect(isInferable('diamond_ore')).toBe(false);
  });
});
