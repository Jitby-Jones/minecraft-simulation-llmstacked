// Noticing what changes around us (owner request, 2026-10-23: agents didn't react to their shelter being broken): the
// blocks that change where an agent could tell, what it makes of them (where, who, whose), the packet's line, and the
// code default's patch. Live behavior is in tests/live/aware.test.ts.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { type BlockChange, PersonaSchema, nullLogger } from '@agora/shared';
import type { Bot } from '@agora/agent/body/bot';
import { Vec3 } from '@agora/agent/body/bot';
import { isShelterCell, shelterHole, whereFrom } from '@agora/agent/body/world';
import { AgentBus } from '@agora/agent/bus';
import { buildPacket } from '@agora/agent/modules/bottleneck';
import { codeDecision } from '@agora/agent/modules/cc';
import { leversFor } from '@agora/agent/modules/levers';
import { SurroundingsWatch, classify, describeChange, recentChanges } from '@agora/agent/perception/surroundings';
import { CC_POLICY } from '@agora/agent/state/policies';
import { createInitialState } from '@agora/agent/state/initial';
import { AgentStateStore } from '@agora/agent/state/store';

const persona = PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['careful'] });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('what changed, in words', () => {
  it('tells something gone, something set down, a door opened or shut; not plants, liquids or the same block', () => {
    expect(classify({ name: 'dirt' }, { name: 'air' })).toBe('broken');
    expect(classify({ name: 'air' }, { name: 'cobblestone' })).toBe('placed');
    expect(classify({ name: 'oak_door', open: false }, { name: 'oak_door', open: true })).toBe('opened');
    expect(classify({ name: 'oak_door', open: true }, { name: 'oak_door', open: false })).toBe('closed');
    expect(classify({ name: 'oak_leaves' }, { name: 'air' })).toBeNull();
    expect(classify({ name: 'water' }, { name: 'air' })).toBeNull();
    expect(classify({ name: 'air' }, { name: 'short_grass' })).toBeNull();
    expect(classify({ name: 'stone' }, { name: 'stone' })).toBeNull();
    // Water flowing into a hole is the hole.
    expect(classify({ name: 'dirt' }, { name: 'water' })).toBe('broken');
  });

  it('where, from where one stands; the cells of a dug-in shelter', () => {
    const feet = { x: 0, y: 64, z: 0 };
    expect(whereFrom(feet, { x: 0, y: 65, z: -1 })).toBe('beside you to the north, at head height');
    expect(whereFrom(feet, { x: 1, y: 64, z: 0 })).toBe('beside you to the east, at your feet');
    expect(whereFrom(feet, { x: 0, y: 66, z: 0 })).toBe('right over your head');
    expect(whereFrom(feet, { x: -3, y: 64, z: 1 })).toBe('3 m to the west');
    expect(isShelterCell(feet, { x: 0, y: 66, z: 0 })).toBe(true);
    expect(isShelterCell(feet, { x: -1, y: 65, z: 0 })).toBe(true);
    expect(isShelterCell(feet, { x: 1, y: 65, z: 1 })).toBe(false);
  });

  it('puts a change as one would', () => {
    const c: BlockChange = { pos: { x: 1, y: 65, z: 0 }, kind: 'broken', was: 'dirt', now: 'air', by: 'a zombie', ours: 'shelter', where: 'beside you to the east, at head height', ts: 0 };
    expect(describeChange(c)).toBe('the dirt of your shelter beside you to the east, at head height was broken by a zombie');
    expect(describeChange({ ...c, ours: undefined, by: 'Bram', was: 'stone', where: '4 m to the south' })).toBe('a stone 4 m to the south was broken by Bram');
    expect(describeChange({ ...c, kind: 'placed', was: 'air', now: 'cobblestone', ours: undefined, by: 'Bram', where: '2 m to the east' })).toBe('Bram set down cobblestone 2 m to the east');
    expect(describeChange({ ...c, kind: 'opened', was: 'oak_door', now: 'oak_door', ours: 'hut', where: '3 m to the west' })).toBe('the oak door of the hut 3 m to the west was opened by a zombie');
  });
});

/** A bot in a dug-in shelter at 0,64,0: dirt all round at feet and head height and over the head, air elsewhere. */
function shelteredBot() {
  const solid = new Set<string>();
  for (const [x, y, z] of [[1, 64, 0], [-1, 64, 0], [0, 64, 1], [0, 64, -1], [1, 65, 0], [-1, 65, 0], [0, 65, 1], [0, 65, -1], [0, 66, 0]]) solid.add(`${x},${y},${z}`);
  const entities: Record<number, unknown> = {};
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 0, position: new Vec3(0.5, 64, 0.5), height: 1.8 },
    entities,
    targetDigBlock: null as { position: Vec3 } | null,
    world: { raycast: () => null },
    blockAt: (p: Vec3) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return solid.has(k) || p.y < 64 ? { name: 'dirt', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p.floored() } : { name: 'air', boundingBox: 'empty', shapes: [], position: p.floored() };
    },
    nearestEntity: (f: (e: unknown) => boolean) => Object.values(entities).find(f) ?? null,
  });
  const block = (name: string, x: number, y: number, z: number, open?: boolean) => ({ name, position: new Vec3(x, y, z), ...(open === undefined ? {} : { getProperties: () => ({ open }) }) });
  /** A block changes: the world first, then the event, as mineflayer does. */
  const change = (x: number, y: number, z: number, was: string, now: string) => {
    if (now === 'air') solid.delete(`${x},${y},${z}`);
    else solid.add(`${x},${y},${z}`);
    bot.emit('blockUpdate', block(was, x, y, z), block(now, x, y, z));
  };
  return { bot, solid, entities, block, change };
}

function watching(o: { sheltered?: boolean } = {}) {
  const w = shelteredBot();
  const store = new AgentStateStore(createInitialState({ persona, username: 'Ada', now: 0 }));
  const bus = new AgentBus();
  const told: BlockChange[] = [];
  bus.on('surroundingsChanged', (e) => void told.push(e.change));
  const placed = new Set<string>();
  const watch = new SurroundingsWatch({ bot: w.bot as unknown as Bot, store, bus, logger: nullLogger(), me: 'Ada', placed, inShelter: () => o.sheltered ?? true });
  watch.start();
  return { ...w, store, bus, told, placed, watch };
}

describe('noticing what changes around us', () => {
  it("a wall of the shelter we are in, broken by a zombie at it: noticed as ours, told, and on one's mind", async () => {
    const x = watching();
    x.entities[7] = { id: 7, type: 'hostile', name: 'zombie', position: new Vec3(2.5, 64, 0.5), height: 1.95 };
    x.change(1, 65, 0, 'dirt', 'air');
    await wait(500);
    x.watch.stop();
    expect(x.told).toHaveLength(1);
    expect(x.told[0]).toMatchObject({ kind: 'broken', was: 'dirt', ours: 'shelter', by: 'a zombie', where: 'beside you to the east, at head height', pos: { x: 1, y: 65, z: 0 } });
    expect(x.store.state.perception.blockChanges).toHaveLength(1);
    expect(x.store.state.workmem.at(-1)?.text).toBe('I noticed the dirt of your shelter beside you to the east, at head height was broken by a zombie.');
    expect(shelterHole(x.bot as unknown as Bot)).toBe('beside you to the east, at head height');
  });

  it('not what we dig or set down ourselves, nor plants, nor what is out of sight and reach', async () => {
    const x = watching();
    x.bot.targetDigBlock = { position: new Vec3(0, 66, 0) };
    x.change(0, 66, 0, 'dirt', 'air');
    x.bot.targetDigBlock = null;
    // Our own block: the body notes it just after it appears.
    x.change(0, 66, 0, 'air', 'cobblestone');
    x.placed.add('0,66,0');
    x.change(3, 64, 0, 'oak_leaves', 'air');
    x.change(30, 64, 0, 'stone', 'air');
    await wait(500);
    x.watch.stop();
    expect(x.told).toEqual([]);
    expect(x.store.state.perception.blockChanges).toEqual([]);
  });

  it('a hole patched (by anyone) is no longer kept; a blast is told as one; a door is told once', async () => {
    const x = watching();
    x.change(-1, 64, 0, 'dirt', 'air');
    await wait(500);
    expect(x.store.state.perception.blockChanges).toHaveLength(1);
    x.change(-1, 64, 0, 'air', 'dirt');
    await wait(50);
    expect(x.store.state.perception.blockChanges).toEqual([]);
    // Three blocks gone at once, nobody at them: an explosion.
    const y = watching({ sheltered: false });
    y.change(2, 64, 2, 'dirt', 'air');
    y.change(2, 64, 3, 'dirt', 'air');
    y.change(3, 64, 2, 'dirt', 'air');
    await wait(500);
    expect(y.told).toHaveLength(1);
    expect(y.store.state.perception.blockChanges.every((c) => c.by === 'an explosion')).toBe(true);
    // A door opened: its two halves are one change.
    y.bot.emit('blockUpdate', y.block('oak_door', -2, 64, 0, false), y.block('oak_door', -2, 64, 0, true));
    y.bot.emit('blockUpdate', y.block('oak_door', -2, 65, 0, false), y.block('oak_door', -2, 65, 0, true));
    await wait(500);
    x.watch.stop();
    y.watch.stop();
    expect(y.told.at(-1)).toMatchObject({ kind: 'opened', was: 'oak_door' });
    expect(y.store.state.perception.blockChanges.filter((c) => c.kind === 'opened')).toHaveLength(1);
  });
});

describe('what the mind makes of it', () => {
  const T = Date.now();
  const hole: BlockChange = { pos: { x: 1, y: 65, z: 0 }, kind: 'broken', was: 'dirt', now: 'air', ours: 'shelter', where: 'beside you to the east, at head height', ts: T };
  function state(o: { blocks?: number; zombieAt?: number } = {}) {
    const s = new AgentStateStore(createInitialState({ persona, username: 'Ada', now: 0 }));
    s.update('self', (x) => ({ ...x, isDay: false, time: 18000, pos: { x: 0.5, y: 64, z: 0.5 }, inventory: o.blocks === 0 ? [] : [{ item: 'dirt', qty: o.blocks ?? 6 }] }));
    s.update('perception', (p) => ({
      ...p,
      blockChanges: [hole],
      nearbyEntities:
        o.zombieAt === undefined ? [] : [{ id: 7, kind: 'hostile', name: 'zombie', pos: { x: o.zombieAt, y: 64, z: 0.5 }, distance: Math.abs(o.zombieAt), visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }],
    }));
    return s.state;
  }

  it('a decision being made when something of ours breaks is moot: it is made again with the hole in view', () => {
    const s = new AgentStateStore(createInitialState({ persona, username: 'Ada', now: 0 }));
    const guard = s.guard(CC_POLICY);
    s.update('perception', (p) => ({ ...p, blockChanges: [...p.blockChanges, { ...hole, ours: undefined, kind: 'placed' as const }] }), 'test');
    expect(guard.signal.aborted).toBe(false);
    s.update('perception', (p) => ({ ...p, blockChanges: [...p.blockChanges, hole] }), 'test');
    expect(guard.signal.aborted).toBe(true);
    guard.dispose();
  });

  it('the packet says what changed, ours first', () => {
    const s = state();
    const p = buildPacket({ state: s, levers: leversFor(0.6), reason: `you noticed ${describeChange(hole)}`, now: T + 5000 });
    expect(p).toMatch(/Changes around you:\n {2}the dirt of your shelter beside you to the east, at head height was broken, at 1,65,0 \(5s ago\)/);
    expect(p).toMatch(/Why you are thinking now: you noticed the dirt of your shelter/);
    const other: BlockChange = { ...hole, ours: undefined, by: 'Bram', was: 'stone', where: '4 m to the south', ts: T + 2000 };
    expect(recentChanges([other, hole], T + 5000).map((c) => c.ours ?? '-')).toEqual(['shelter', '-']);
    expect(recentChanges([hole], T + 6 * 60_000)).toEqual([]);
  });

  it('without a model: the hole is patched with a block carried; not with a monster in it, nor with nothing to patch it with', () => {
    expect(codeDecision(state(), {}, false, () => false, { candidates: [], roll: 0.5, codeOnly: true })).toMatchObject({ option: 'work', task: { skill: 'place', args: { block: 'dirt', x: 1, y: 65, z: 0 } } });
    // Mid-task, the change that just happened is seen to as well.
    expect(codeDecision(state(), { change: hole }, true, () => false, { candidates: [], roll: 0.5 })?.task?.skill).toBe('place');
    expect(codeDecision(state(), {}, true, () => false, { candidates: [], roll: 0.5 })).toBeNull();
    expect(codeDecision(state({ zombieAt: 2 }), {}, false, () => false, { candidates: [], roll: 0.5, codeOnly: true })?.task?.skill).not.toBe('place');
    expect(codeDecision(state({ blocks: 0 }), {}, false, () => false, { candidates: [], roll: 0.5, codeOnly: true })?.task?.skill).not.toBe('place');
    // A block of ours someone took (a crafting table, say) is news, not a hole to fill.
    const took = state();
    const table: BlockChange = { ...hole, ours: 'placed', was: 'crafting_table', pos: { x: 1, y: 64, z: 0 } };
    expect(codeDecision({ ...took, perception: { ...took.perception, blockChanges: [table] } }, {}, false, () => false, { candidates: [], roll: 0.5, codeOnly: true })?.task?.skill).not.toBe('place');
  });

  it("a hut's walls and roof are the hut's; the ground about it is not", async () => {
    const x = watching({ sheltered: false });
    // A hut on a rise, its door at y 65.
    x.store.update('village', (v) => ({ ...v, huts: [{ x: 3, y: 65, z: 0 }] }));
    x.change(4, 66, 1, 'cobblestone', 'air');
    x.change(4, 64, -1, 'dirt', 'air');
    await wait(500);
    x.watch.stop();
    expect(x.store.state.perception.blockChanges.map((c) => `${c.pos.y}:${c.ours ?? '-'}`).sort()).toEqual(['64:-', '66:hut']);
  });
});
