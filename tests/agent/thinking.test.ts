// The thinking agent (owner request, 2026-10-24: "agents need to think convincingly human and be able to learn how to
// play the game without being told directly"): what doesn't fit what it knows is possible is noticed (and gets less
// surprising each time, until it is known); what it sees is grouped and put into words; what it put off comes back
// to mind on its cue; lessons are kept; what it knows of the game is looked up for what matters; the packet carries
// its train of thought; and the steps it means to take next are taken without stopping to think.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { type AgentState, ModelsConfigSchema, PersonaSchema, type Scene, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { Vec3 } from '@agora/agent/body/bot';
import type { Body } from '@agora/agent/body/body';
import { AgentBus } from '@agora/agent/bus';
import { Expectations, KNOWN_AFTER } from '@agora/agent/mind/expectations';
import { GameKnowledge, type GameData, knowledgeLines } from '@agora/agent/mind/knowledge';
import { LaterWatch, cueCame, cueFrom } from '@agora/agent/mind/later';
import { Learning, addLesson, lessonsToCheck, matchTask, overlap, saysUnfinished, speaksOf } from '@agora/agent/mind/learning';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { buildPacket, placesFor, triedLately } from '@agora/agent/modules/bottleneck';
import { CognitiveController } from '@agora/agent/modules/cc';
import { tidyDecision } from '@agora/agent/modules/decisionTidy';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { nowLine, summaryMessages } from '@agora/agent/modules/selfMonitor';
import { type Motion, MotionTracker } from '@agora/agent/perception/motion';
import { FarLook, type Seen, SceneEyes, farWords, featureKindOf, featuresOf } from '@agora/agent/perception/scene';
import { noSuchItem, pocketPlan, resolveCraftTarget } from '@agora/agent/body/skills/crafting';
import { bearingOf, countOf, describeScene } from '@agora/agent/perception/sceneWords';
import { createInitialState } from '@agora/agent/state/initial';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, schemaNameOf, standardModels } from '../llm/fakeNanoGpt';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['curious'] });
const store = () => new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(import.meta.url);
const mcData = require(require.resolve('minecraft-data', { paths: [require.resolve('mineflayer', { paths: [`${process.cwd()}/packages/agent`] })] })) as (v: string) => GameData & {
  blocksByStateId: Record<number, { name: string } | undefined>;
  blocksByName: Record<string, { id: number; minStateId: number; name: string } | undefined>;
};
const data = mcData('26.1.2');

const motion = (m: Partial<Motion>): Motion => ({ id: 1, speed: 0, vy: 0, supported: true, airborneSec: 0, aboveGround: 0, medium: 'air', heading: null, motion: 'still', ...m });

function expectations(s: AgentStateStore, t = { now: 100_000 }) {
  return new Expectations({ state: () => s.state, learn: (f) => s.update('knowledge', (k) => f(k), 'test'), now: () => t.now });
}

describe('expectations: what does not fit what is known to be possible stands out (the flyer)', () => {
  it('someone hanging in the air with nothing under them is a surprise; less so each time; then known', () => {
    const s = store();
    const t = { now: 100_000 };
    const ex = expectations(s, t);
    const hover = motion({ supported: false, airborneSec: 4, aboveGround: 7, vy: 0, motion: 'flying' });
    const first = ex.observe({ id: 7, name: 'Kelby', kind: 'player', type: 'player', motion: hover, distance: 12, visible: true });
    expect(first?.key).toBe('hover');
    expect(first?.text).toMatch(/^Kelby is 7 m up in the air with nothing under them, not falling \(4 s now\)\. You've never seen anyone do that\./);
    expect(first?.strength).toBeGreaterThanOrEqual(0.6);
    // The same one going on is not said again at once.
    t.now += 5000;
    expect(ex.observe({ id: 7, name: 'Kelby', kind: 'player', type: 'player', motion: hover, distance: 12, visible: true })).toBeNull();
    t.now += 30_000;
    const second = ex.observe({ id: 7, name: 'Kelby', kind: 'player', type: 'player', motion: hover, distance: 12, visible: true });
    expect(second?.seenBefore).toBe(1);
    expect(second?.strength).toBeLessThan(first?.strength ?? 0);
    for (let i = 0; i < KNOWN_AFTER; i++) {
      t.now += 30_000;
      ex.observe({ id: 7, name: 'Kelby', kind: 'player', type: 'player', motion: hover, distance: 12, visible: true });
    }
    expect(s.state.knowledge.beliefs).toContainEqual(expect.objectContaining({ about: 'Kelby', key: 'hover', text: 'can stay up in the air without falling' }));
    t.now += 30_000;
    const known = ex.observe({ id: 7, name: 'Kelby', kind: 'player', type: 'player', motion: hover, distance: 12, visible: true });
    expect(known?.strength).toBe(0);
    expect(known?.text).toMatch(/You know Kelby can stay up in the air without falling/);
  });

  it('what is in a creature\'s nature is no surprise: a bat flies, a chicken flaps down, an enderman blinks', () => {
    const ex = expectations(store());
    const hover = motion({ supported: false, airborneSec: 5, aboveGround: 6 });
    expect(ex.observe({ id: 1, name: 'bat', kind: 'passive', type: 'bat', motion: hover, distance: 5, visible: true })).toBeNull();
    expect(ex.observe({ id: 2, name: 'chicken', kind: 'passive', type: 'chicken', motion: { ...hover, vy: -0.5 }, distance: 5, visible: true })).toBeNull();
    expect(ex.observe({ id: 3, name: 'enderman', kind: 'hostile', type: 'enderman', motion: motion({ jumpedM: 20, jumpedFrom: new Vec3(0, 64, 0) }), distance: 9, visible: true })).toBeNull();
    // A jump is no surprise, nor a run.
    expect(ex.observe({ id: 4, name: 'Bo', kind: 'player', type: 'player', motion: motion({ supported: false, airborneSec: 0.5, aboveGround: 1, vy: 2, speed: 5.5 }), distance: 5, visible: true })).toBeNull();
    expect(ex.observe({ id: 4, name: 'Bo', kind: 'player', type: 'player', motion: motion({ speed: 5.6 }), distance: 5, visible: true })).toBeNull();
    // A climb up a tree or a pillar, a second up, is jumps landed on; a rise kept up for two is not.
    expect(ex.observe({ id: 5, name: 'Bram', kind: 'player', type: 'player', motion: motion({ supported: false, airborneSec: 1.1, aboveGround: 1.2, vy: 3 }), distance: 13, visible: true })).toBeNull();
    expect(ex.observe({ id: 6, name: 'Kelby', kind: 'player', type: 'player', motion: motion({ supported: false, airborneSec: 2, aboveGround: 5, vy: 3 }), distance: 13, visible: true })?.key).toBe('rise');
  });

  it('too fast for anyone, there in an instant, out of nowhere, inside a wall: each its own surprise', () => {
    const ex = expectations(store());
    // A burst is nothing (a sprint's jump, a knock back); kept up, it is.
    expect(ex.observe({ id: 1, name: 'Kelby', kind: 'player', type: 'player', motion: motion({ speed: 11, sustained: 6 }), distance: 8, visible: true })).toBeNull();
    expect(ex.observe({ id: 1, name: 'Kelby', kind: 'player', type: 'player', motion: motion({ speed: 11, sustained: 11 }), distance: 8, visible: true })?.text).toMatch(/has been moving at 11 m\/s, far faster than anyone can run/);
    expect(ex.observe({ id: 2, name: 'Kelby', kind: 'player', type: 'player', motion: motion({ jumpedM: 25, jumpedFrom: new Vec3(10, 64, 10) }), distance: 8, visible: true })?.text).toMatch(/just went 25 m in an instant, from 10,64,10/);
    expect(ex.appeared({ id: 3, name: 'zombie', kind: 'hostile', type: 'zombie', distance: 5, visible: true, baby: false })?.text).toMatch(/^A zombie appeared out of nowhere, 5 m from you/);
    expect(ex.appeared({ id: 4, name: 'cow', kind: 'passive', type: 'cow', distance: 3, visible: true, baby: true })).toBeNull();
    expect(ex.observe({ id: 5, name: 'Kelby', kind: 'player', type: 'player', motion: motion({ insideBlock: 'stone' }), distance: 4, visible: true })?.text).toMatch(/inside solid stone/);
  });

  it('what fits is learned too: the fastest seen of a kind widens what is expected of it', () => {
    const s = store();
    const ex = expectations(s);
    ex.observe({ id: 1, name: 'horse', kind: 'passive', type: 'horse', motion: motion({ speed: 7, sustained: 7 }), distance: 8, visible: true });
    expect(s.state.knowledge.envelopes?.horse?.ground).toBe(7);
    expect(ex.envelope('horse').ground).toBe(7);
  });
});

describe('motion, as a player sees it', () => {
  it('measures speed, time off the ground and height above it; a blink is a jump no walk explains', () => {
    const ground = 64;
    const bot = {
      blockAt: (p: Vec3) => (p.y < ground ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
    };
    const m = new MotionTracker(bot as never);
    const e = { id: 9, position: new Vec3(0, ground, 0), width: 0.6, metadata: [] } as never as { id: number; position: Vec3 };
    m.update([e as never], 0);
    e.position = new Vec3(4, ground, 0);
    m.update([e as never], 1000);
    expect(m.of(9)).toMatchObject({ speed: 4, supported: true, motion: 'walking' });
    e.position = new Vec3(4, ground + 7, 0);
    m.update([e as never], 1250);
    e.position = new Vec3(4, ground + 7, 0);
    m.update([e as never], 4000);
    expect(m.of(9)).toMatchObject({ supported: false, aboveGround: 7, motion: 'flying' });
    expect(m.of(9)?.airborneSec).toBeGreaterThan(2);
    e.position = new Vec3(60, ground + 7, 0);
    m.update([e as never], 4250);
    expect(m.of(9)?.jumpedM).toBe(56);
  });

  it('inside a block is inside what it takes up: in a stone, yes; among the thin points of dripstone, no', () => {
    const ground = 64;
    // Two pointed dripstones stacked over the ground, thin in the middle of their cells; a stone pillar beside them.
    const thin = [[0.3125, 0, 0.3125, 0.6875, 1, 0.6875]];
    const bot = {
      blockAt: (p: Vec3) => {
        if (p.y < ground) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        if (p.x === 0 && p.y < ground + 2) return { name: 'pointed_dripstone', boundingBox: 'block', shapes: thin };
        if (p.x === 3 && p.y < ground + 2) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        return { name: 'air', boundingBox: 'empty', shapes: [] };
      },
    };
    const m = new MotionTracker(bot as never);
    const zombie = { id: 7, position: new Vec3(0.1, ground, 0.1), width: 0.6, metadata: [] } as never as { id: number; position: Vec3 };
    const stuck = { id: 8, position: new Vec3(3.5, ground, 0.5), width: 0.6, metadata: [] } as never as { id: number; position: Vec3 };
    m.update([zombie as never, stuck as never], 0);
    m.update([zombie as never, stuck as never], 500);
    expect(m.of(7)?.insideBlock).toBeUndefined();
    expect(m.of(8)?.insideBlock).toBe('stone');
  });

  it('hop after hop is no time off the ground: the game shows each landing, though every look finds it in the air', () => {
    const ground = 64;
    const client = new EventEmitter();
    const bot = {
      _client: client,
      blockAt: (p: Vec3) => (p.y < ground ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
    };
    const m = new MotionTracker(bot as never);
    const e = { id: 4, position: new Vec3(0, ground + 1.25, 0), width: 0.6, metadata: [] } as never as { id: number; position: Vec3 };
    for (let t = 0; t <= 3000; t += 250) {
      // A landing between this look and the next (its packets say on the ground), then up again at the top of a hop.
      if (t % 500 === 0) client.emit('rel_entity_move', { entityId: 4, dX: 0, dY: 0, dZ: 0, onGround: true });
      m.update([e as never], t);
    }
    expect(m.of(4)).toMatchObject({ supported: false });
    expect(m.of(4)?.airborneSec ?? 0).toBeLessThan(0.6);
    // Without a landing, it has been up there all along.
    for (let t = 3250; t <= 6000; t += 250) m.update([e as never], t);
    expect(m.of(4)?.airborneSec ?? 0).toBeGreaterThan(2);
  });
});

/** A flat world of grass at y 63, with a few blocks of its own, for the eyes to look about in. */
function fakeWorld(extra: Record<string, string> = {}) {
  const blocks: Record<string, string> = { ...extra };
  const nameAt = (x: number, y: number, z: number) => blocks[`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`] ?? (Math.floor(y) === 63 ? 'grass_block' : null);
  const block = (p: Vec3) => {
    const n = nameAt(p.x, p.y, p.z);
    const b = n ? data.blocksByName[n] : undefined;
    return n && b ? { name: n, type: b.id, boundingBox: 'block', position: p.floored(), getProperties: () => ({}) } : null;
  };
  const inv: { name: string; count: number }[] = [];
  const entity = { id: 0, name: 'player', type: 'player', username: 'Pip', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: 0.6, yaw: 0, pitch: 0, metadata: [] };
  const entities: Record<number, unknown> = { 0: entity };
  const bot = Object.assign(new EventEmitter(), {
    registry: data,
    entity,
    entities,
    players: {},
    username: 'Pip',
    game: { dimension: 'overworld' },
    time: { timeOfDay: 1000 },
    isSleeping: false,
    isRaining: false,
    currentWindow: null,
    inventory: { items: () => inv, slots: [] },
    blockAt: block,
    world: { getBlockStateId: (p: Vec3) => { const n = nameAt(p.x, p.y, p.z); return n ? (data.blocksByName[n]?.minStateId ?? 0) : 0; }, getBiome: () => null },
    findBlock: (o: { point: Vec3; matching: number[]; maxDistance: number }) => {
      for (const [k, n] of Object.entries(blocks)) {
        const [x, y, z] = k.split(',').map(Number) as [number, number, number];
        const id = data.blocksByName[n]?.id;
        if (id !== undefined && o.matching.includes(id) && new Vec3(x, y, z).distanceTo(o.point) <= o.maxDistance) return block(new Vec3(x, y, z));
      }
      return null;
    },
    findBlocks: () => [],
  });
  const creature = (id: number, name: string, x: number, z: number) => ({ id, name, type: 'animal', position: new Vec3(x, 64, z), velocity: new Vec3(0, 0, 0), onGround: true, height: 0.6, width: 0.7, yaw: 0, pitch: 0, metadata: [] });
  return { bot, inv, creature };
}

describe('whether a monster near can get to one, as one sees it from where one is', () => {
  it('at the foot of the pillar one stands on: "no way up to you on foot"; down on the ground beside it, nothing so', () => {
    const w = fakeWorld();
    const base = w.bot.blockAt;
    w.bot.blockAt = (p: Vec3) => {
      const f = p.floored();
      if (f.x === 0 && f.z === 0 && f.y >= 64 && f.y <= 66) return { name: 'oak_planks', type: data.blocksByName.oak_planks?.id ?? 1, boundingBox: 'block', position: f, getProperties: () => ({}) };
      return base(p) ?? { name: 'air', type: 0, boundingBox: 'empty', position: f, getProperties: () => ({}) };
    };
    w.bot.entity.position = new Vec3(0.5, 67, 0.5);
    const zombie = { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(3.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.95, width: 0.6, yaw: 0, pitch: 0, metadata: [] };
    w.bot.entities[9] = zombie;
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    const seen: Seen[] = [{ e: zombie as never, kind: 'hostile', name: 'zombie', visible: true, distance: 4.2 }];
    t.now = 9000;
    eyes.tick(seen);
    expect(describeScene(s.state.scene, t.now).join('\n')).toContain('a zombie (hostile), 4 m east, 3 m down: standing still, no way up to you on foot');
    // Down on the ground beside it, the same zombie has its way.
    w.bot.entity.position = new Vec3(1.5, 64, 0.5);
    t.now = 13_000;
    eyes.tick(seen);
    expect(describeScene(s.state.scene, t.now).join('\n')).not.toContain('no way');
    // Hit twice (it flashes red each time): counted, as one fighting it counts; a minute on, forgotten.
    w.bot.emit('entityHurt', zombie);
    t.now = 13_500;
    w.bot.emit('entityHurt', zombie);
    t.now = 15_000;
    eyes.tick(seen);
    expect(describeScene(s.state.scene, t.now).join('\n')).toContain('a zombie (hostile), 4 m east: standing still, hit 2 times lately');
    t.now = 80_000;
    eyes.tick(seen);
    expect(describeScene(s.state.scene, t.now).join('\n')).not.toContain('hit 2 times');
    eyes.stop();
  });
});

describe('monsters coming about are noticed before they are on one', () => {
  it('two zombies coming into sight 15 m off: noticed, strongly enough to think about; not again at once', () => {
    // One exploring by day walked into an open cave, and its body met six zombies 5 m off at once.
    const w = fakeWorld();
    const zombie = (id: number, x: number) => ({ id, name: 'zombie', type: 'hostile', position: new Vec3(x, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.95, width: 0.6, yaw: 0, pitch: 0, metadata: [] });
    const a = zombie(11, 15.5);
    const b = zombie(12, 16.5);
    w.bot.entities[11] = a;
    w.bot.entities[12] = b;
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    t.now = 9000;
    eyes.tick([]);
    const seen: Seen[] = [
      { e: a as never, kind: 'hostile', name: 'zombie', visible: true, distance: 15 },
      { e: b as never, kind: 'hostile', name: 'zombie', visible: true, distance: 16 },
    ];
    t.now = 10_500;
    eyes.tick(seen);
    const n = eyes.recent().filter((x) => x.key === 'monsters');
    expect(n.map((x) => x.text)).toEqual(['Monsters about: 2 zombies 15-16 m east']);
    expect(n[0]?.strength).toBeGreaterThanOrEqual(0.6);
    // Still there a moment later, and one more: not told again so soon.
    const c = zombie(13, 18.5);
    w.bot.entities[13] = c;
    t.now = 12_000;
    eyes.tick([...seen, { e: c as never, kind: 'hostile', name: 'zombie', visible: true, distance: 18 }]);
    expect(eyes.recent().filter((x) => x.key === 'monsters')).toHaveLength(1);
    eyes.stop();
  });
});

describe('where one set things down, and what is out of sight, up and down as well as across', () => {
  it('a table set down is ours; 25 m under it, it is told; behind a wall it stays remembered; seen gone, forgotten', () => {
    // One set her crafting table down under her feet, dug on down, broke her last pickaxe 25 m below it, and was told
    // only of a table 75 m up and another 70 m off: on the map, the one overhead was near, so in sight.
    const w = fakeWorld();
    const st = { table: true, wall: false };
    const nameAt = (f: Vec3): string | null => {
      if (f.x === 2 && f.y === 64 && f.z === 0) return st.table ? 'crafting_table' : null;
      if (st.wall && f.x === 1 && (f.y === 64 || f.y === 65) && f.z >= -1 && f.z <= 1) return 'stone';
      return f.y === 63 ? 'grass_block' : null;
    };
    const blockAt = (p: Vec3) => {
      const f = p.floored();
      const n = nameAt(f);
      const b = n ? data.blocksByName[n] : undefined;
      return n && b ? { name: n, type: b.id, boundingBox: 'block', position: f, shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) } : { name: 'air', type: 0, boundingBox: 'empty', position: f, shapes: [], getProperties: () => ({}) };
    };
    w.bot.blockAt = blockAt;
    Object.assign(w.bot.world, {
      getBlockStateId: (p: Vec3) => {
        const n = nameAt(p.floored());
        return n ? (data.blocksByName[n]?.minStateId ?? 0) : 0;
      },
      raycast: (from: Vec3, dir: Vec3, range: number) => {
        for (let d = 0; d <= range; d += 0.05) {
          const b = blockAt(from.plus(dir.scaled(d)));
          if (b.boundingBox === 'block') return b;
        }
        return null;
      },
    });
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    const standAt = (x: number, y: number, z: number) => {
      w.bot.entity.position = new Vec3(x, y, z);
      s.update('self', (me) => ({ ...me, pos: { x, y, z } }), 'test');
      // Two looks round: the first may have begun where one stood before.
      for (let i = 0; i < 24; i++) {
        t.now += 300;
        eyes.tick([]);
      }
    };
    const table = () => (s.state.knowledge.places ?? []).find((p) => p.names.includes('crafting_table'));
    w.bot.emit('blockPlaced', null, { name: 'crafting_table', position: new Vec3(2, 64, 0) });
    expect(table()?.what).toBe('a crafting table you set down');
    // In view: seen, still ours, and not among what is out of sight.
    standAt(0.5, 64, 0.5);
    expect(s.state.scene.features.some((f) => f.blocks.crafting_table)).toBe(true);
    expect(table()?.what).toBe('a crafting table you set down');
    expect(placesFor(s.state, t.now)).toEqual([]);
    // 25 m below it, under the ground, 15 m off across: out of sight, and told.
    standAt(16.5, 39, 3.5);
    expect(placesFor(s.state, t.now).join('\n')).toMatch(/^a crafting table you set down: 15 m [a-z-]+, 25 m up \(2,64,0\), seen /);
    // Back beside it, a wall between, and the table taken away: for all one knows, it is still there.
    st.wall = true;
    st.table = false;
    standAt(0.5, 64, 0.5);
    expect(table()).toBeDefined();
    // The wall gone, the spot in view and nothing there: forgotten.
    st.wall = false;
    standAt(0.5, 64, 0.5);
    expect(table()).toBeUndefined();
    eyes.stop();
  });
});

describe('monsters about in the dark by day are seen to be where no sun gets at them', () => {
  it('two zombies in a cave at noon: "no sun gets at them where they are, so they will not burn"', () => {
    // Deep in a cave, told of a zombie, a skeleton and a creeper, one mined on "since monsters burn in daylight".
    const w = fakeWorld();
    const base = w.bot.blockAt;
    w.bot.blockAt = (p: Vec3) => {
      const f = p.floored();
      if (f.y === 70) return { name: 'stone', type: data.blocksByName.stone?.id ?? 1, boundingBox: 'block', position: f, getProperties: () => ({}) };
      return base(p) ?? { name: 'air', type: 0, boundingBox: 'empty', position: f, getProperties: () => ({}) };
    };
    const zombie = (id: number, x: number) => ({ id, name: 'zombie', type: 'hostile', position: new Vec3(x, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.95, width: 0.6, yaw: 0, pitch: 0, metadata: [] });
    const a = zombie(21, 15.5);
    const b = zombie(22, 16.5);
    w.bot.entities[21] = a;
    w.bot.entities[22] = b;
    const s = store();
    s.update('self', (x) => ({ ...x, isDay: true }), 'test');
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    t.now = 9000;
    eyes.tick([]);
    t.now = 10_500;
    eyes.tick([
      { e: a as never, kind: 'hostile', name: 'zombie', visible: true, distance: 15 },
      { e: b as never, kind: 'hostile', name: 'zombie', visible: true, distance: 16 },
    ]);
    expect(eyes.recent().find((x) => x.key === 'monsters')?.text).toBe('Monsters about: 2 zombies 15-16 m east; no sun gets at them where they are, so they will not burn');
    eyes.stop();
  });
});

describe('what the game does by itself is no surprise; what comes from nowhere is', () => {
  it('a bee out of its nest is nothing; a cow out of thin air is', () => {
    const w = fakeWorld({ '6,66,0': 'bee_nest' });
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    const seen: Seen[] = [];
    t.now = 9000;
    eyes.tick(seen);
    const bee = w.creature(7, 'bee', 5.5, 0.5);
    w.bot.entities[7] = bee;
    w.bot.emit('entitySpawn', bee);
    seen.push({ e: bee as never, kind: 'passive', name: 'bee', visible: true, distance: 5 });
    t.now = 9250;
    eyes.tick(seen);
    expect(eyes.recent().filter((n) => n.key === 'appear')).toEqual([]);
    const cow = w.creature(8, 'cow', 0.5, 6.5);
    w.bot.entities[8] = cow;
    w.bot.emit('entitySpawn', cow);
    seen.push({ e: cow as never, kind: 'passive', name: 'cow', visible: true, distance: 6 });
    t.now = 9500;
    eyes.tick(seen);
    expect(eyes.recent().filter((n) => n.key === 'appear').map((n) => n.about)).toEqual(['cow']);
    eyes.stop();
  });

  it('the sun getting low is noticed each evening, under the sky', () => {
    const w = fakeWorld();
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    w.bot.time.timeOfDay = 10_700;
    t.now = 9000;
    eyes.tick([]);
    w.bot.time.timeOfDay = 10_850;
    t.now = 10_000;
    eyes.tick([]);
    const dusk = eyes.recent().filter((n) => n.key === 'dusk');
    expect(dusk.map((n) => n.text)).toEqual(['The sun is getting low in the west: dark in about 2 min, and in the dark the monsters come out']);
    expect(dusk[0]?.strength).toBeGreaterThanOrEqual(0.6);
    eyes.stop();
  });

  it('coming out under the open sky at night is noticed, once (hands sent for a log went up 34 blocks into the dark)', () => {
    const w = fakeWorld();
    let roof = true;
    const base = w.bot.blockAt;
    w.bot.blockAt = (p: Vec3) => {
      const f = p.floored();
      if (roof && f.y === 67 && Math.abs(f.x) <= 3 && Math.abs(f.z) <= 3) return { name: 'stone', type: data.blocksByName.stone?.id ?? 1, boundingBox: 'block', position: f, getProperties: () => ({}) };
      // The sky's light is the ground's from before (a hut one built is still lit by the sky): the roof is what counts.
      if (f.x === 0 && f.y >= 64 && f.y <= 66 && f.z === 0) return { name: 'air', type: 0, boundingBox: 'empty', position: f, skyLight: 15, getProperties: () => ({}) } as never;
      return base(p);
    };
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    w.bot.time.timeOfDay = 14_000;
    const look = () => {
      for (let i = 0; i < 16; i++) {
        t.now += 250;
        eyes.tick([]);
      }
    };
    look();
    expect(eyes.recent().filter((n) => n.key === 'nightOut')).toEqual([]);
    roof = false;
    look();
    const out = eyes.recent().filter((n) => n.key === 'nightOut');
    expect(out.map((n) => n.text)).toEqual(['You have come out under the open sky, and it is night: dark all round until it gets light in about 8 min, and in the dark the monsters come out']);
    expect(out[0]?.strength).toBeGreaterThanOrEqual(0.6);
    // In and straight out again (a doorway): the same coming out.
    roof = true;
    look();
    roof = false;
    look();
    expect(eyes.recent().filter((n) => n.key === 'nightOut')).toHaveLength(1);
    // Out by day: nothing to notice.
    const day = fakeWorld();
    const eyes2 = new SceneEyes({ bot: day.bot as never, store: store(), bus: new AgentBus(), now: () => t.now });
    eyes2.start();
    look();
    expect(eyes2.recent().filter((n) => n.key === 'nightOut')).toEqual([]);
    eyes.stop();
    eyes2.stop();
  });

  it("a tool nearly worn out is noticed once, as its bar turns red; and its breaking, with none of its kind left", () => {
    const w = fakeWorld();
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    const pick = { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 90 };
    w.inv.push(pick);
    t.now = 9000;
    eyes.tick([]);
    expect(eyes.recent().filter((n) => n.key === 'worn')).toEqual([]);
    pick.durabilityUsed = 115;
    t.now = 10_000;
    eyes.tick([]);
    pick.durabilityUsed = 125;
    t.now = 11_000;
    eyes.tick([]);
    const worn = eyes.recent().filter((n) => n.key === 'worn');
    expect(worn.map((n) => n.text)).toEqual(['Your stone pickaxe is nearly worn out (12% left): it will break soon']);
    expect(worn[0]?.strength).toBeGreaterThanOrEqual(0.6);
    w.inv.splice(w.inv.indexOf(pick), 1);
    t.now = 12_000;
    eyes.tick([]);
    expect(eyes.recent().filter((n) => n.key === 'broke').map((n) => n.text)).toEqual(['Your stone pickaxe broke: you have no pickaxe now']);
    eyes.stop();
  });

  it('the pockets filling up is noticed once, as they fill; the packet says so, and what to do', () => {
    const w = fakeWorld();
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now });
    eyes.start();
    for (let i = 0; i < 35; i++) w.inv.push({ name: 'cobblestone', count: 64 });
    t.now = 9000;
    eyes.tick([]);
    w.inv.push({ name: 'granite', count: 64 });
    t.now = 10_000;
    eyes.tick([]);
    t.now = 11_000;
    eyes.tick([]);
    expect(eyes.recent().filter((n) => n.key === 'full').map((n) => n.text)).toEqual(["Your inventory is full: what you dig or pick up now won't fit"]);
    eyes.stop();
    s.update('self', (x) => ({ ...x, slotsFree: 0 }));
    expect(buildPacket({ state: s.state, levers: leversFor(0.5), reason: 'test', now: 0 })).toMatch(/Your inventory is full \(0 of 36 slots free\): what you dig or pick up next won't fit\. Drop what you don't need \(drop \{item, qty\}\)\./);
  });

  it('what our own hands made is no surprise, even landing after the skill is done; what turns up in our pockets with idle hands is', () => {
    const w = fakeWorld();
    const s = store();
    const t = { now: 0 };
    const eyes = new SceneEyes({ bot: w.bot as never, store: s, bus: new AgentBus(), now: () => t.now, handsBusy: () => false });
    eyes.start();
    t.now = 9000;
    eyes.tick([]);
    // A craft that took half a second, its furnace landing just after it ended.
    s.update('actionLog', (l) => [...l, { id: 'a1', skill: 'craft', args: { item: 'furnace' }, expected: '+1 furnace', observed: 'crafted 1 furnace', ok: true, ts: 9200, durationMs: 500 }], 'test');
    w.inv.push({ name: 'furnace', count: 1 });
    t.now = 10_000;
    eyes.tick([]);
    expect(eyes.recent().filter((n) => n.key === 'pockets')).toEqual([]);
    // A craft's result landing long after the craft (the window's sync): what one made, one knows.
    s.update('actionLog', (l) => [...l, { id: 'a2', skill: 'craft', args: { item: 'stone_shovel' }, expected: '+1 stone_shovel', observed: 'crafted 1 stone_shovel', ok: true, ts: 10_500, durationMs: 500 }], 'test');
    t.now = 11_500;
    eyes.tick([]);
    w.inv.push({ name: 'stone_shovel', count: 1 });
    t.now = 18_000;
    eyes.tick([]);
    expect(eyes.recent().filter((n) => n.key === 'pockets')).toEqual([]);
    // A gather of "log", cut short, its drops coming in after it: oak logs are logs.
    s.update('actionLog', (l) => [...l, { id: 'a3', skill: 'gather', args: { item: 'log', qty: 8 }, expected: '+8 log', observed: 'interrupted; +5 log', ok: false, ts: 18_500, durationMs: 500 }], 'test');
    t.now = 19_500;
    eyes.tick([]);
    w.inv.push({ name: 'oak_log', count: 2 });
    t.now = 23_000;
    eyes.tick([]);
    expect(eyes.recent().filter((n) => n.key === 'pockets')).toEqual([]);
    // Later, with idle hands: diamonds from nowhere (someone ran /give).
    w.inv.push({ name: 'diamond', count: 3 });
    t.now = 28_000;
    eyes.tick([]);
    expect(eyes.recent().filter((n) => n.key === 'pockets').map((n) => n.text)).toEqual([expect.stringMatching(/^3 diamond appeared in your inventory out of nowhere/)]);
    eyes.stop();
  });
});

describe('the hands make what is one craft away, as a player does without a thought', () => {
  const mineflayerDir = require.resolve('mineflayer', { paths: [`${process.cwd()}/packages/agent`] });
  const recipeLib = require(require.resolve('prismarine-recipe', { paths: [mineflayerDir] })) as (d: unknown) => { Recipe: { find(id: number, meta: number | null): { requiresTable: boolean }[] } };
  const { Recipe } = recipeLib(data);
  const pockets = (items: Record<string, number>) => ({
    registry: data,
    inventory: { items: () => Object.entries(items).map(([name, count]) => ({ name, count })), slots: [] },
    recipesAll: (id: number, meta: number | null, table: unknown) => Recipe.find(id, meta).filter((r) => table || !r.requiresTable),
  });
  const need = (name: string, count: number) => ({ name, count });
  const plan = (items: Record<string, number>, needs: { name: string; count: number }[], table = false) =>
    pocketPlan(pockets(items) as never, needs, table)?.map((s) => `${s.times}x ${s.name}`) ?? null;

  it('planks from the logs on hand for a table; sticks from planks, and planks from logs for those', () => {
    expect(plan({ oak_planks: 1, oak_log: 10 }, [need('oak_planks', 4)])).toEqual(['1x oak_planks']);
    expect(plan({ oak_log: 3 }, [need('oak_planks', 3), need('stick', 2)], true)).toEqual(['1x oak_planks', '1x oak_planks', '1x stick']);
    expect(plan({ oak_planks: 4, stick: 2 }, [need('oak_planks', 3), need('stick', 2)], true)).toEqual([]);
  });

  it('a kind of thing means it in the wood or colour on hand: a sign, a door, planks, a bed, wool', () => {
    const r = (items: Record<string, number>, what: string) => resolveCraftTarget(pockets(items) as never, what);
    expect(r({ spruce_planks: 6 }, 'sign')).toBe('spruce_sign');
    expect(r({ birch_log: 2 }, 'door')).toBe('birch_door');
    expect(r({}, 'boat')).toBe('oak_boat');
    // Planks come from logs: the logs' wood, whatever planks are about.
    expect(r({ spruce_planks: 2, birch_log: 3 }, 'planks')).toBe('birch_planks');
    // Of the woods on hand, the one there is most of (5 birch and 8 oak logs had made it birch, the first in the bag).
    expect(r({ birch_log: 5, oak_log: 8 }, 'planks')).toBe('oak_planks');
    expect(r({ oak_planks: 2, birch_log: 3 }, 'door')).toBe('birch_door');
    expect(r({ oak_planks: 20, birch_log: 3 }, 'door')).toBe('oak_door');
    expect(r({ red_wool: 3 }, 'bed')).toBe('red_bed');
    expect(r({}, 'wool')).toBe('white_wool');
    expect(r({}, 'stick')).toBe('stick');
    // The names of old: a "wooden door" is a door of the wood on hand; a wooden pickaxe is itself.
    expect(r({ birch_planks: 6 }, 'wooden_door')).toBe('birch_door');
    expect(r({}, 'wooden fence')).toBe('oak_fence');
    expect(r({}, 'wooden_pickaxe')).toBe('wooden_pickaxe');
    // No such thing: the names the game has with the same last word, to go by.
    const none = noSuchItem(pockets({}) as never, 'gold_door');
    expect(none).toMatch(/^there is no item called gold_door \(there is /);
    expect(none).toContain('oak_door');
    expect(none).toContain('iron_door');
  });

  it("never takes what the recipe itself needs, and nothing that would have to be got first", () => {
    // 3 planks and no logs: the pickaxe's planks can't also become its sticks.
    expect(plan({ oak_planks: 3 }, [need('oak_planks', 3), need('stick', 2)], true)).toBeNull();
    expect(plan({ oak_planks: 5 }, [need('oak_planks', 3), need('stick', 2)], true)).toEqual(['1x stick']);
    // Iron is smelted, not crafted: the pockets can't make it.
    expect(plan({ raw_iron: 3, stick: 2 }, [need('iron_ingot', 3), need('stick', 2)], true)).toBeNull();
  });
});

describe('the scene: blocks in view grouped as a player sees them', () => {
  it('trees, ore, a building and water, each with which way and how far', () => {
    const at = (name: string) => data.blocksByName[name]?.minStateId ?? 0;
    const hits = [
      ...[0, 1, 2, 3].flatMap((y) => [{ x: 10, y: 64 + y, z: -10, id: at('oak_log') }, { x: 14, y: 64 + y, z: -12, id: at('oak_log') }]),
      { x: -6, y: 60, z: 0, id: at('iron_ore') },
      { x: -6, y: 61, z: 0, id: at('deepslate_iron_ore') },
      ...[0, 1, 2].map((i) => ({ x: 0 + i, y: 64, z: 20, id: at('oak_planks') })),
      { x: 3, y: 64, z: 20, id: at('oak_door') },
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ x: -20 - (i % 4), y: 62, z: 5 + Math.floor(i / 4), id: at('water') })),
    ];
    const bot = { registry: data, blockAt: () => null };
    const f = featuresOf(bot as never, hits, new Vec3(0, 64, 0), false);
    const what = f.map((x) => `${x.kind}:${x.what}:${x.bearing}`);
    expect(what).toContain('trees:2 oak trees:north-east');
    expect(what).toContain('ore:iron ore (2 blocks):west');
    expect(what).toContain('built:something built of oak planks, with a door:south');
    expect(what).toContain('water:a pond:west');
    // A block or two put down is that, not something built: one at one health ran 15 m for "the cobblestone
    // structure" to shelter in, the one block it had put in a skeleton's way.
    const placed = new Set(['5,64,5']);
    const world = { registry: data, blockAt: (p: Vec3) => ({ name: placed.has(`${p.x},${p.y},${p.z}`) ? 'cobblestone' : 'air' }) };
    const one = featuresOf(world as never, [{ x: 5, y: 64, z: 5, id: at('cobblestone') }], new Vec3(0, 64, 0), false);
    expect(one[0]?.what).toBe('a cobblestone block, nothing more');
    for (const [x, y] of [[6, 64], [7, 64], [5, 65], [6, 65], [7, 65]]) placed.add(`${x},${y},5`);
    const wall = featuresOf(world as never, [{ x: 5, y: 64, z: 5, id: at('cobblestone') }, { x: 7, y: 65, z: 5, id: at('cobblestone') }], new Vec3(0, 64, 0), false);
    expect(wall[0]?.what).toBe('something built of cobblestone');
    expect(featureKindOf('grass_block')).toBe('ground');
    expect(featureKindOf('crafting_table')).toBe('station');
    expect(bearingOf({ x: 0, z: 0 }, { x: 0, z: -10 })).toBe('north');
    expect(countOf(3, 'sheep')).toBe('3 sheep');
    expect(countOf(1, 'iron_golem')).toBe('an iron golem');
  });

  it('far off, beyond the near view: land across the water, which way and how far, or none in sight', () => {
    // One lost on the sea saw only "a lake or river: right here", swam on away from the land she had come from, and
    // drowned 700 m out.
    const at = (name: string) => data.blocksByName[name]?.minStateId ?? 0;
    const sea = (beach: boolean) => ({
      registry: data,
      entity: { position: new Vec3(0.5, 62.1, 0.5), eyeHeight: 1.62 },
      world: {
        getBlockStateId: (p: Vec3) => {
          if (Math.abs(p.x) > 170 || Math.abs(p.z) > 170) return null;
          if (beach && p.x <= -100 && p.y <= 63) return at('sand');
          if (beach && p.x <= -110 && p.y >= 66 && p.y <= 68) return at('oak_leaves');
          return p.y <= 62 ? at('water') : at('air');
        },
      },
    });
    const look = (bot: object): FarLook => {
      const far = new FarLook(bot as never);
      for (let i = 0; i < 60 && !far.step(1000); i++);
      return far;
    };
    const land = farWords(look(sea(true)).seen, true) ?? '';
    expect(land).toMatch(/^land (south-west, )?west( and north-west)? \(1\d\d(-1\d\d)? m: (sand, trees|trees, sand)\)$/);
    expect(farWords(look(sea(false)).seen, true)).toBe('no land in sight: water all round, as far as you can see');
    // A look into the distance waits its time; one under way goes on.
    const far = look(sea(false));
    expect(far.step(5000)).toBe(false);
    // On land: what stands out far off, by which way.
    const hits = [
      { kind: 'trees' as const, d: 120, dy: 4, octant: 6 },
      { kind: 'trees' as const, d: 90, dy: 3, octant: 7 },
      { kind: 'water' as const, d: 70, dy: -2, octant: 0 },
      { kind: 'built' as const, d: 140, dy: 1, octant: 2 },
      { kind: 'rock' as const, d: 130, dy: 30, octant: 4 },
      { kind: 'ground' as const, d: 60, dy: 0, octant: 3 },
    ];
    expect(farWords(hits, false)).toBe('buildings south (140 m); water east (70 m); trees north and north-east (90-120 m); high ground west (130 m, up to 30 m up)');
    expect(farWords([{ kind: 'ground', d: 60, dy: 0, octant: 3 }], false)).toBeNull();
    expect(describeScene({ at: 1, where: 'In ocean, in the water, under the open sky', features: [], creatures: [], notices: [], far: land }, 2).join('\n')).toContain(`Far off: ${land}.`);
  });

  it('in words: where, what is in view, creatures of a kind together, what stood out', () => {
    const scene: Scene = {
      at: 1,
      where: 'In plains, standing on grass block, under the open sky',
      features: [{ kind: 'trees', what: '4 oak trees', blocks: { oak_log: 12 }, nearest: { x: 10, y: 64, z: -10 }, distance: 14, bearing: 'north-east', dy: 0, size: 12 }],
      creatures: [
        { id: 1, kind: 'passive', name: 'sheep', pos: { x: 0, y: 64, z: -12 }, distance: 12, bearing: 'north', dy: 0, motion: 'still', speed: 0, relations: [], details: ['white wool'], visible: true },
        { id: 2, kind: 'passive', name: 'sheep', pos: { x: 2, y: 64, z: -15 }, distance: 15, bearing: 'north', dy: 0, motion: 'walking', speed: 1, relations: [], details: ['white wool'], visible: true },
        { id: 3, kind: 'player', name: 'Kelby', pos: { x: 5, y: 71, z: 5 }, distance: 9, bearing: 'south-east', dy: 7, motion: 'flying', speed: 0.2, aboveGround: 7, airborneSec: 6, relations: ['looking at you'], details: [], visible: true },
      ],
      notices: [{ id: 'n', ts: 900, kind: 'surprise', about: 'Kelby', key: 'hover', text: 'Kelby is 7 m up in the air with nothing under them, not falling (6 s now). You\'ve never seen anyone do that.', strength: 0.8, seenBefore: 0 }],
    };
    const lines = describeScene(scene, 1000, { people: () => 'a new face' }).join('\n');
    expect(lines).toContain('Where you are: In plains, standing on grass block, under the open sky.');
    expect(lines).toContain('4 oak trees: 14 m north-east (10,64,-10)');
    expect(lines).toContain('2 sheep, 12-15 m north: standing still, white wool');
    expect(lines).toContain('Kelby (a new face), 9 m south-east, 7 m up: in the air 7 m above the ground, looking at you');
    expect(lines).toMatch(/What stood out:\n {2}Kelby is 7 m up in the air/);
  });
});

describe('putting things off until a cue (prospective memory)', () => {
  it('reads cues, and knows when one has come', () => {
    expect(cueFrom('see:Sheep', 0)).toEqual({ cue: 'see:sheep' });
    expect(cueFrom('have:shears', 0)).toEqual({ cue: 'have:shears' });
    expect(cueFrom('have:iron_ingot>=3', 0)).toEqual({ cue: 'have:iron_ingot>=3' });
    expect(cueFrom('minutes:10', 1000)).toEqual({ cue: 'minutes:10', due: 601_000 });
    expect(cueFrom('when I feel like it', 0)).toBeNull();
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    const seeing: AgentState = { ...s, scene: { ...s.scene, creatures: [{ id: 1, kind: 'passive', name: 'sheep', pos: { x: 0, y: 0, z: 0 }, distance: 14, bearing: 'north', dy: 0, motion: 'still', speed: 0, relations: [], details: [], visible: true }] } };
    expect(cueCame({ id: 'l', what: 'get wool', cue: 'see:sheep', since: 0 }, s, 0)).toBeNull();
    expect(cueCame({ id: 'l', what: 'get wool', cue: 'see:sheep', since: 0 }, seeing, 0)).toBe('there is a sheep 14 m north');
    expect(cueCame({ id: 'l', what: 'x', cue: 'have:shears', since: 0 }, { ...s, self: { ...s.self, inventory: [{ item: 'shears', qty: 1 }] } }, 0)).toBe('you have some shears');
  });

  it('the cue coming reminds the mind, once', () => {
    const s = store();
    const bus = new AgentBus();
    const cues: string[] = [];
    bus.on('cue', (e) => cues.push(`${e.deferred.what}: ${e.why}`));
    s.update('mind', (m) => ({ ...m, later: [{ id: 'l1', what: 'get wool', cue: 'see:sheep', since: 0 }] }), 'test');
    const w = new LaterWatch({ store: s, bus, logger: nullLogger(), now: () => 1000 });
    w.check();
    expect(cues).toEqual([]);
    s.update('scene', (x) => ({ ...x, creatures: [{ id: 1, kind: 'passive', name: 'sheep', pos: { x: 0, y: 0, z: 0 }, distance: 20, bearing: 'east', dy: 0, motion: 'still', speed: 0, relations: [], details: [], visible: true }] }), 'test');
    w.check();
    w.check();
    expect(cues).toEqual(['get wool: there is a sheep 20 m east']);
    expect(s.state.mind.later).toEqual([]);
  });

  it('"when it is day" said by day is the morning after the night, not now (and night by night the next)', () => {
    expect(cueFrom('day', 0, true)).toEqual({ cue: 'day', after: 'night' });
    expect(cueFrom('day', 0, false)).toEqual({ cue: 'day' });
    expect(cueFrom('night', 0, false)).toEqual({ cue: 'night', after: 'day' });
    const s = store();
    const bus = new AgentBus();
    const cues: string[] = [];
    bus.on('cue', (e) => cues.push(`${e.deferred.what}: ${e.why}`));
    const day = (isDay: boolean) => s.update('self', (x) => ({ ...x, isDay }), 'test');
    day(true);
    s.update('mind', (m) => ({ ...m, later: [{ id: 'l1', what: 'shear the sheep', ...(cueFrom('day', 0, true) as { cue: string }), since: 0 }] }), 'test');
    const w = new LaterWatch({ store: s, bus, logger: nullLogger(), now: () => 1000 });
    w.check();
    expect(cues).toEqual([]);
    // Dusk, then the night: still waiting, and no longer for a night.
    day(false);
    w.check();
    expect(cues).toEqual([]);
    expect(s.state.mind.later[0]?.after).toBeUndefined();
    // The morning.
    day(true);
    w.check();
    expect(cues).toEqual(['shear the sheep: it is day']);
  });
});

describe('lessons and tasks', () => {
  it('a lesson is kept once; the same lesson again only freshens it', () => {
    const s = store();
    expect(addLesson(s, 'Killing every sheep leaves none to shear; shearing keeps them.', 'thought', 1)).not.toBeNull();
    expect(addLesson(s, 'killing every sheep leaves none to shear: shearing keeps them', 'experience', 2)).toBeNull();
    expect(s.state.knowledge.lessons).toHaveLength(1);
    expect(s.state.knowledge.lessons?.[0]?.ts).toBe(2);
    expect(s.state.workmem.at(-1)?.text).toMatch(/^I learned: Killing every sheep/);
    expect(overlap('get 12 diamonds', 'the diamonds are done')).toBeGreaterThan(0.3);
  });

  it('a lesson shown wrong by what happened is unlearned, the right one kept (one learned beds will not go down on grass)', async () => {
    const s = store();
    addLesson(s, 'Leaves above the ground can block a bed even when the surface looks clear.', 'experience', 1);
    addLesson(s, "Beds won't place on short grass; always aim for bare dirt or another solid block.", 'experience', 2);
    for (let i = 0; i < 4; i++) {
      s.update('actionLog', (l) => [...l, { id: `a${i}`, skill: 'place', args: { block: 'red_bed' }, expected: '', observed: i < 3 ? 'placed red_bed at 4,64,7' : 'placed oak_planks', ok: true, ts: 10 + i, durationMs: 500 }], 'test');
    }
    const happened = ['place {"block":"red_bed"}: worked: placed red_bed at 4,64,7 on short grass'];
    // What is shown to be checked: what bears on it first.
    expect(lessonsToCheck(s.state.knowledge.lessons ?? [], happened)[0]?.text).toMatch(/^Beds won't place on short grass/);
    const fake = new FakeNanoGpt(standardModels());
    let asked = '';
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'review') return { text: '{}' };
      asked = JSON.stringify(body?.messages ?? '');
      const n = /(\d+)\. Beds won't place/.exec(asked)?.[1] ?? '0';
      return { text: JSON.stringify({ lessons: ['A bed goes down on grass fine: what stopped it was the head of it facing a tree.'], wrong: [Number(n)] }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const learning = new Learning({ store: s, bus: new AgentBus(), logger: nullLogger(), llm: rt.client, me: 'Pip', now: () => 0 });
    await learning.run('testing');
    expect(asked).toMatch(/give its number under \\"wrong\\"/);
    const texts = (s.state.knowledge.lessons ?? []).map((l) => l.text);
    expect(texts.some((t) => /^Beds won't place/.test(t))).toBe(false);
    expect(texts).toContain('A bed goes down on grass fine: what stopped it was the head of it facing a tree.');
    expect(texts).toContain('Leaves above the ground can block a bed even when the surface looks clear.');
    expect(s.state.workmem.some((w) => /^I was wrong about this: Beds won't place/.test(w.text))).toBe(true);
  });

  it('a task is found by its number or by what it says', () => {
    const tasks = [
      { id: 'a', text: 'Obtain 12 diamonds', from: 'op', at: 0, status: 'open' as const },
      { id: 'b', text: 'Make an enchanting table', from: 'op', at: 0, status: 'open' as const },
    ];
    expect(matchTask(tasks, 'the enchanting table is made and placed')?.id).toBe('b');
    expect(matchTask(tasks, 'task 1')?.id).toBe('a');
    expect(matchTask(tasks, '#2: it stands by the house')?.id).toBe('b');
    // A bare number may be a step of the plan, numbered the same way: the task only if what is said bears on it.
    expect(matchTask(tasks, '2: the enchanting table stands by the house')?.id).toBe('b');
    expect(matchTask(tasks, '2: stone pickaxe and stone axe crafted, tool role fulfilled')).toBeNull();
    expect(matchTask(tasks, '#1')?.id).toBe('a');
    expect(matchTask(tasks, '12 diamonds in my pockets now')?.id).toBe('a');
    expect(matchTask(tasks, 'something else entirely')).toBeNull();
    // A step of a plan that shares a word or two with a task is not that task.
    expect(matchTask(tasks, 'Craft planks and sticks, make a crafting table if needed, craft torches: I hold 16 torches')).toBeNull();
  });

  it('a task keeps its number as others close; a number said with the words of another task is that other one', () => {
    // Numbered by their place among the open ones, "#1: house task is in progress", said again once the house was
    // behind her, closed the romance that had become #1.
    const tasks = [
      { id: 'h', n: 1, text: 'Make a house.', from: 'op', at: 0, status: 'done' as const },
      { id: 'r', n: 2, text: 'Form a romantic relationship.', from: 'op', at: 0, status: 'open' as const },
      { id: 'f', n: 3, text: 'Secure a renewable source of food.', from: 'op', at: 0, status: 'open' as const },
    ];
    expect(matchTask(tasks, '#1: house task is in progress')).toBeNull();
    expect(matchTask(tasks, '#2: we are partners now')?.id).toBe('r');
    expect(matchTask(tasks, '#3: the wheat farm is planted and grows back')?.id).toBe('f');
    // The words of another open task, and none of the one numbered: the other.
    expect(matchTask(tasks, '#2: a renewable food source: wheat planted by the hut')?.id).toBe('f');
    // The words of one behind: none.
    expect(matchTask(tasks, '#3: the house has a door and a roof')).toBeNull();
  });

  it('a task said to be done while under way, or given up while only put off, is neither', () => {
    // Every task closed in two runs was closed so; none of them was done.
    for (const said of [
      '#1: making a house is in progress with Bram, but not finished yet',
      '#1: I am actively working to secure a house spot and gather wood; the task is in progress, not yet finished.',
      '#1: house task is in progress—wood gathering almost complete, design ready.',
      '#1: I have mutton to eat now and will hunt for wool; food source progress continues with cocoa and wheat later.',
      '#1: I have fish eaten and a plan for renewable food via wool and later wheat; the immediate need is shelter to survive the night.',
      "#2: I've gathered the dirt and am about to place the sign, then I'll be inside the hut out of harm's way.",
    ]) expect(saysUnfinished(said, 'done'), said).toBe(true);
    for (const said of [
      "#2: I have no iron ore yet, and making iron armor and tools requires mining it first—I'll tackle that after the hut is built.",
      "#1: I can't make progress on the house without more wood, so I'll focus on gathering oak first.",
      "#2: I'll secure renewable food tomorrow with fresh logs in daylight after clearing grass properly.",
      "#2: What? Go to the Nether? I'm in no state for that — still need iron tools and armor first.",
      "#1: Obtain 12 diamonds is still in progress, but I'm actively pursuing it now.",
    ]) expect(saysUnfinished(said, 'dropped'), said).toBe(true);
    // Done, said as done.
    for (const said of [
      '#1: I hold 12 diamonds',
      '#2: the cow pen is built next to the house and holds 2 cows',
      '#3: wheat planted on farmland by the water; it will keep growing back from its own seeds',
      '#4: Bram said yes: we are partners',
      '#5: I stood in the Nether and came back through the portal',
    ]) expect(saysUnfinished(said, 'done'), said).toBe(false);
    expect(saysUnfinished('#2: Bram built it already; it is not mine to do', 'dropped')).toBe(false);
    expect(saysUnfinished('#1: I have at least 20 logs mixed between oak and spruce, ready for planks and the village chest.', 'done')).toBe(true);
  });

  it('done is said of the task itself, not of what goes into it', () => {
    const house = { id: 'h', n: 1, text: 'Make a house.', from: 'op', at: 0, status: 'open' as const };
    expect(speaksOf(house, '#1: I have at least 20 logs mixed between oak and spruce')).toBe(false);
    expect(speaksOf(house, '#1: sealed shelter with Ada')).toBe(false);
    expect(speaksOf(house, '#1: the house stands, a door and a roof on it')).toBe(true);
    expect(speaksOf(house, '#1: done')).toBe(true);
    expect(speaksOf({ ...house, text: 'Secure a renewable source of food.' }, '#3: a renewable food source: wheat planted by the water')).toBe(true);
    expect(speaksOf({ ...house, text: 'Make a cow farm.' }, '#2: the pen holds two cows')).toBe(true);
  });
});

describe('what it knows of the game, looked up for what matters', () => {
  const k = new GameKnowledge(data);
  it('every way to an item: what the data says, and what it leaves out', () => {
    const wool = k.describe('white_wool') ?? '';
    expect(wool).toMatch(/^white wool: shear an adult sheep \(shears\): 1-3 wool/);
    expect(wool).toContain('kill a sheep that still has its wool: 1 wool, and that sheep is gone');
    expect(wool).toContain('craft from 4 string');
    expect(k.describe('shears')).toBe('shears: craft from 2 iron ingots');
    expect(k.describe('enchanting_table')).toBe('enchanting table: craft from 1 book + 2 diamonds + 4 obsidian (at a crafting table)');
    expect(k.describe('leather')).toMatch(/cow, donkey, hoglin, horse drop it when killed/);
    expect(k.itemsIn('Obtain 12 diamonds and make an enchanting table')).toEqual(['diamond', 'enchanting_table']);
    // A word for a kind of thing brings up one of its kind, as the novel test's tasks name them ("Catch a fish." named
    // no item, and nothing of how fish are caught came to mind).
    expect(k.itemsIn('Catch a fish.')).toEqual(['cod']);
    expect(k.itemsIn('Make a bed and sleep in it.')).toEqual(['red_bed']);
    expect(k.describe('cod')).toMatch(/kill one where it swims/);
    expect(k.topics('secure a renewable source of food').join(' ')).toMatch(/Food that keeps coming/);
    // Where ores are, as anyone who has mined knows (an agent dug 48 blocks at y 29 for iron, then wrote itself that iron is at -58).
    expect(k.topics('mine iron for a full set of armor').join(' ')).toMatch(/iron in two bands, richest around y 16/);
    // Where one is, in a dark forest: what its canopy does by day (two building there fought zombies at noon and died).
    expect(k.topics('In dark forest, standing on grass block, under the open sky').join(' ')).toMatch(/monsters spawn under it and walk about at noon/);
  });

  it('what one knows of a creature comes to mind on seeing one, nearest first', () => {
    // One broke into a cave of silverfish, spiders and a skeleton, mined the infested stone the silverfish came out of
    // and pillared up away from the spiders.
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    const seen = (name: string, distance: number, kind: 'hostile' | 'passive' = 'hostile') => ({
      id: distance,
      kind,
      name,
      pos: { x: distance, y: 0, z: 0 },
      distance,
      bearing: 'east',
      dy: 0,
      motion: 'walking' as const,
      speed: 1,
      relations: [],
      details: [],
      visible: true,
    });
    const st: AgentState = { ...s, scene: { ...s.scene, creatures: [seen('spider', 6), seen('silverfish', 1), seen('silverfish', 2), seen('skeleton', 20)] } };
    const lines = knowledgeLines(k, st);
    expect(lines[0]).toMatch(/^Silverfish hide in stone that looks like any other.*dig no more of that rock/);
    expect(lines[1]).toMatch(/^A spider is faster than you.*neither running nor a pillar keeps it off/);
    expect(lines.filter((l) => /^Skeletons shoot/.test(l))).toHaveLength(0);
    // A cow is no matter, nor one far off out of sight.
    const calm = knowledgeLines(k, { ...s, scene: { ...s.scene, creatures: [seen('cow', 3, 'passive'), { ...seen('creeper', 20), visible: false }] } });
    expect(calm.some((l) => /cow|creeper/i.test(l.split(':')[0] ?? ''))).toBe(false);
    expect(calm.some((l) => /^A creeper/.test(l))).toBe(false);
  });

  it('the self-summary is written from where one is now, as the senses have it', () => {
    // One wrote "I'm at the staircase top, y77, a safe spot" from her last summary while she stood in a cave at y34
    // with seven silverfish and a spider on her, and every thought in the danger began with it.
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    const fish = (id: number, distance: number) => ({ id, kind: 'hostile' as const, name: 'silverfish', pos: { x: distance, y: 34, z: 0 }, distance, bearing: 'south', dy: 0, motion: 'walking' as const, speed: 2, relations: [], details: [], visible: true });
    const st: AgentState = {
      ...s,
      self: { ...s.self, health: 14, food: 16, pos: { x: 18, y: 34, z: 41 }, time: 6000, isDay: true },
      flags: { ...s.flags, inDanger: true },
      scene: { ...s.scene, where: 'Deep under the cherry grove, standing on diorite, underground', creatures: [fish(1, 1), fish(2, 2), { ...fish(3, 30), name: 'spider' }] },
    };
    const now = nowLine(st);
    expect(now).toMatch(/^health 14\/20, food 16\/20, .*; at 18,34,41 \(Deep under the cherry grove, standing on diorite, underground\); in danger; monsters about: 2 silverfish$/);
    const m = summaryMessages(persona, [], { previous: "I'm at the staircase top, y77. Safe spot.", goal: '', recent: [], onMind: [], now });
    expect(m[1]?.content).toMatch(/Now, as your senses have it \(where the previous summary says otherwise, this is so\): health 14\/20/);
  });

  it('what failed lately and what the tasks name come first', () => {
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    const st: AgentState = {
      ...s,
      goals: { ...s.goals, tasks: [{ id: 't', text: 'make a full set of iron armor', from: 'op', at: 0, status: 'open' }] },
      actionLog: [{ id: 'a', skill: 'obtain', args: { item: 'white_wool', qty: 3 }, expected: '', observed: 'holding 0 white_wool', ok: false, ts: 0, durationMs: 1000, error: "haven't seen any white_wool around here" }],
    };
    const lines = knowledgeLines(k, st);
    expect(lines[0]).toMatch(/^white wool: shear an adult sheep/);
    expect(lines.join('\n')).toMatch(/a set is a helmet, a chestplate, leggings and boots; in iron that is 5 \+ 8 \+ 7 \+ 4 = 24 iron ingots/);
    // What armor does, as players know: each piece from the moment it is on (an agent carried 14 ingots and wore none).
    expect(lines.join('\n')).toMatch(/Armor: each piece takes part of every blow from the moment it is worn/);
  });

  it('what bears on the moment comes before what the tasks are about: down a mine, the dark', () => {
    const s = createInitialState({ persona, username: 'Pip', now: 0 });
    const many = ['Secure a renewable source of food.', 'Make a cow farm.', 'Go to the Nether.', 'Make an enchanting table.'].map((text, i) => ({ id: `t${i}`, text, from: 'op', at: 0, status: 'open' as const }));
    const st: AgentState = {
      ...s,
      goals: { ...s.goals, tasks: many, current: { id: 'g', text: 'Dig a staircase down, mining the coal and iron along the way', kind: 'current', createdAt: 0, status: 'active' } },
      scene: { ...s.scene, where: 'In stony peaks, standing on stone, underground, the ceiling 3 m up' },
    };
    const lines = knowledgeLines(k, st);
    expect(lines.some((l) => l.startsWith('Underground: it is dark down there at any hour'))).toBe(true);
    // Come the night, what the night means.
    const night = knowledgeLines(k, { ...st, self: { ...st.self, isDay: false, time: 14_000 }, scene: { ...st.scene, where: 'In plains, under the open sky' } });
    expect(night.some((l) => l.startsWith('Night: about 8 minutes of dark'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Ores by height'))).toBe(true);
    expect(lines.filter((l) => /^(Ores by height|Food that keeps coming|Animals|The Nether|Enchanting|Underground)/.test(l))).toHaveLength(3);
    // The hour first, however much the goal names: a goal of tools, a house, iron and diamonds had crowded the night out.
    const busy = { ...st, goals: { ...st.goals, current: { id: 'g', text: 'Make tools, build a house, then mine iron and diamonds', kind: 'current' as const, createdAt: 0, status: 'active' as const } } };
    const crowded = knowledgeLines(k, { ...busy, self: { ...busy.self, isDay: false, time: 14_000 }, scene: { ...busy.scene, where: 'In plains, under the open sky' } });
    expect(crowded.some((l) => l.startsWith('Night: about 8 minutes of dark'))).toBe(true);
    // Hungry, what one knows of food comes to mind (one starving among salmon in a river never thought of cooking,
    // fishing or going farther for animals); fed, it does not.
    const hungry = knowledgeLines(k, { ...st, self: { ...st.self, food: 9 } });
    expect(hungry.some((l) => l.startsWith('Food: health comes back by itself only while the food bar is at 18 of 20 or more'))).toBe(true);
    expect(hungry.join('\n')).toMatch(/Raw meat fills little and cooked much more/);
    expect(lines.some((l) => l.startsWith('Food:'))).toBe(false);
    // The bar going down with nothing to eat on one, food comes to mind before hunger does (an agent mined on for half
    // an hour with none, and met its first fight unfed); with a meal on one, not yet.
    expect(knowledgeLines(k, { ...st, self: { ...st.self, food: 19 } }).some((l) => l.startsWith('Food:'))).toBe(true);
    expect(knowledgeLines(k, { ...st, self: { ...st.self, food: 19, inventory: [{ item: 'bread', qty: 3 }] } }).some((l) => l.startsWith('Food:'))).toBe(false);
    // Down there, nothing to eat but what one brought.
    expect(lines.join('\n')).toMatch(/nothing to eat grows or lives down there/);
  });
});

describe('the packet: a train of thought, what it meant to do, what it tried, learned and remembers', () => {
  it('carries all of it, and the scene in place of the old lists', () => {
    const s0 = createInitialState({ persona, username: 'Pip', now: 0 });
    const now = 10 * 60_000;
    const s: AgentState = {
      ...s0,
      self: { ...s0.self, pos: { x: 0, y: 64, z: 0 } },
      mind: { thoughts: [{ ts: now - 30_000, text: 'The sheep are all gone from here; I should look for more out east.' }], intention: { aim: 'wool', steps: [{ skill: 'obtain', args: { item: 'shears', qty: 1 } }], from: 'd', at: now }, later: [{ id: 'l', what: 'get wool', cue: 'see:sheep', since: 0 }] },
      goals: { ...s0.goals, tasks: [{ id: 't', text: 'make a bed', from: 'the operator', at: now - 60_000, status: 'open' }] },
      knowledge: { ...s0.knowledge, lessons: [{ id: 'x', text: 'Shear sheep rather than kill them: they grow wool back.', ts: now - 1000, from: 'thought', uses: 0 }], places: [{ key: 'k', kind: 'animals', what: '5 sheep', pos: { x: 140, y: 64, z: 10 }, world: 'overworld', seenAt: now - 5 * 60_000, names: ['sheep'] }] },
      actionLog: [
        { id: 'a', skill: 'obtain', args: { item: 'white_wool', qty: 3 }, expected: '', observed: 'holding 0 white_wool', ok: false, ts: now - 120_000, durationMs: 1000, error: "haven't seen any white_wool around here" },
        { id: 'b', skill: 'obtain', args: { item: 'white_wool', qty: 3 }, expected: '', observed: 'holding 0 white_wool', ok: false, ts: now - 60_000, durationMs: 1000, error: "haven't seen any white_wool around here" },
      ],
      scene: { at: now, where: 'In plains, standing on grass block, under the open sky', features: [], creatures: [], notices: [] },
    };
    const p = buildPacket({ state: s, levers: leversFor(0.5), reason: 'what you were doing failed', knowledge: ['white wool: shear an adult sheep (shears): 1-3 wool'], now });
    expect(p).toContain('Your recent thoughts (oldest first):\n  - The sheep are all gone from here; I should look for more out east. (30s ago)');
    expect(p).toContain('Tasks you have taken on:\n  #1 make a bed (from the operator, 1m ago)');
    expect(p).toContain('You meant to do next: obtain {"item":"shears","qty":1}');
    expect(p).toContain('You put off: get wool (until see:sheep).');
    expect(p).toContain('Where you are: In plains, standing on grass block, under the open sky.');
    expect(p).toContain('Nothing moving around you.');
    expect(p).toContain('obtain white_wool: 2 times over 2 min, 0 worked, 2 failed (last: haven\'t seen any white_wool around here)');
    expect(p).toContain('Places you remember, out of sight now:\n  5 sheep: 140 m east (140,64,10), seen 5m ago');
    expect(p).toContain('What you know of the game that bears on this:\n  - white wool: shear an adult sheep');
    expect(p).toContain('What you have learned:\n  - Shear sheep rather than kill them');
    expect(p).toContain('Why you are thinking now: what you were doing failed.');
    expect(triedLately(s.actionLog, now)).toHaveLength(1);
    expect(placesFor(s, now)).toHaveLength(1);
  });
});

describe('the decision as thought out: tidied, taken in, and the next steps taken without stopping to think', () => {
  it('tidies the thinking fields: unknown skills out of what comes next, an empty lesson gone', () => {
    const d = tidyDecision(
      { option: 'work', task: { skill: 'obtain', args: { item: 'shears' } }, terminate: { maxSeconds: 60 }, rationale: 'x', thought: '  hmm  ', then: [{ skill: 'obtain', args: { item: 'white_wool' } }, { skill: 'teleport' }, 'jump'], lesson: 'none', later: { what: 'get wool', when: 'see:sheep' } },
      { me: 'Pip', isSkill: (n) => n === 'obtain' },
    ) as Record<string, unknown>;
    expect(d.thought).toBe('hmm');
    expect(d.then).toEqual([{ skill: 'obtain', args: { item: 'white_wool' } }]);
    expect(d.lesson).toBeUndefined();
    expect(d.later).toEqual({ what: 'get wool', when: 'see:sheep' });
  });

  it('keeps the thought, the steps meant, the lesson and what it put off; done, the next step runs without the model', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let calls = 0;
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      calls++;
      return {
        text: JSON.stringify({
          thought: 'No sheep left here. Shears first, then the herd I saw out east; and wool can wait until I see sheep again.',
          option: 'work',
          task: { skill: 'obtain', args: { item: 'shears', qty: 1 } },
          terminate: { maxSeconds: 300 },
          rationale: 'shears keep the sheep alive',
          then: [{ skill: 'explore', args: { direction: 'east', distance: 120 } }],
          lesson: 'Killing the sheep left none for wool; shearing would have kept them.',
          later: { what: 'shear sheep for wool', when: 'see:sheep' },
          taskDone: 'nothing yet',
        }),
      };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    cc.start();
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    const task = cc.giveTask('make a bed', 'the operator');
    expect(s.state.goals.tasks).toEqual([task]);
    for (let i = 0; i < 60 && decided.length === 0; i++) await wait(25);
    expect(decided).toEqual(['llm:obtain']);
    expect(s.state.mind.thoughts.at(-1)?.text).toMatch(/^No sheep left here/);
    expect(s.state.mind.intention?.steps).toEqual([{ skill: 'explore', args: { direction: 'east', distance: 120 } }]);
    expect(s.state.mind.later).toEqual([expect.objectContaining({ what: 'shear sheep for wool', cue: 'see:sheep' })]);
    expect(s.state.knowledge.lessons?.[0]?.text).toMatch(/^Killing the sheep left none/);
    // The sent prompt is the thinking one, with nothing of the old rules in it.
    const sys = String((fake.chatRequests()[0]?.body?.messages as { content: string }[] | undefined)?.[0]?.content);
    expect(sys).toContain('You have played Minecraft for years');
    expect(sys).toContain('Think it through as yourself');
    expect(sys).not.toMatch(/Night is dangerous|Hunger comes before work|Make your own tools/);
    // Done: on to the next step at once, no model asked.
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'work' });
    for (let i = 0; i < 40 && decided.length < 2; i++) await wait(25);
    expect(decided).toEqual(['llm:obtain', 'intention:explore']);
    expect(calls).toBe(1);
    expect(s.state.mind.intention).toBeNull();
    // A failure is thought about.
    bus.emit({ type: 'optionTerminated', reason: 'no way through', ok: false, option: 'work' });
    // (Thinking again waits out the 2 s between decisions that aren't urgent.)
    for (let i = 0; i < 160 && calls < 2; i++) await wait(25);
    expect(calls).toBe(2);
    // A panic that took over isn't what the steps followed on from: done, it is thought about (one ran from the hole it
    // was digging and went straight on to the mining meant for after the night).
    expect(s.state.mind.intention?.steps).toEqual([{ skill: 'explore', args: { direction: 'east', distance: 120 } }]);
    expect(cc.impulse({ option: 'flee', terminate: { maxSeconds: 10 }, rationale: 'panicked and ran' })).toBe(true);
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'flee' });
    for (let i = 0; i < 160 && calls < 3; i++) await wait(25);
    expect(calls).toBe(3);
    expect(decided.filter((d) => d.startsWith('intention:'))).toEqual(['intention:explore']);
    // The steps it meant were for the plan it had: with a new plan made since, done is thought about too.
    expect(s.state.mind.intention?.steps).toEqual([{ skill: 'explore', args: { direction: 'east', distance: 120 } }]);
    s.update('goals', (g) => ({ ...g, plan: { id: 'p2', aim: 'eat first', steps: [{ text: 'get food', status: 'doing' }], createdAt: Date.now() + 1, updatedAt: Date.now() + 1, discussedWith: [], source: 'llm' } }), 'test');
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'work' });
    for (let i = 0; i < 160 && calls < 4; i++) await wait(25);
    expect(calls).toBe(4);
    expect(decided.filter((d) => d.startsWith('intention:'))).toEqual(['intention:explore']);
    cc.stop();
  });

  it('a task said to be done in the thought that sets out to do it stays open, noted; said again later, or of what is not being set out to do, it is done', async () => {
    // One about to swim down to a cod put "Catch a fish" behind her as "killed a cod and picked it up", and never had a fish.
    const fake = new FakeNanoGpt(standardModels());
    const replies = [
      { thought: 'Down to the cod.', option: 'work', task: { skill: 'attack', args: { target: 'cod', seconds: 10 } }, then: [{ skill: 'pickup', args: {} }], terminate: { maxSeconds: 60 }, rationale: 'fish', taskDone: '#1: killed a cod and picked it up' },
      { thought: 'Got it. Cook it.', option: 'work', task: { skill: 'smelt', args: { item: 'cod', qty: 1 } }, terminate: { maxSeconds: 60 }, rationale: 'food', taskDone: '#1: caught a fish, a cod, and I have it now' },
    ];
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      return { text: JSON.stringify(replies.shift() ?? { option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'x' }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    cc.start();
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    const fish = cc.giveTask('Catch a fish.', 'the operator');
    for (let i = 0; i < 60 && decided.length === 0; i++) await wait(25);
    expect(decided).toEqual(['llm:attack']);
    const noted = s.state.goals.tasks?.find((t) => t.id === fish.id);
    expect(noted?.status).toBe('open');
    expect(noted?.note).toBe('you said it was done as you set out to do it: "#1: killed a cod and picked it up"');
    expect(buildPacket({ state: s.state, levers: leversFor(0.5), reason: 'x', now: Date.now() })).toContain('#1 Catch a fish. (from the operator, 0s ago) [you said it was done as you set out to do it:');
    // Said again in a later thought: done.
    bus.emit({ type: 'optionTerminated', reason: 'aborted', ok: false, option: 'work' });
    for (let i = 0; i < 160 && decided.length < 2; i++) await wait(25);
    expect(s.state.goals.tasks?.find((t) => t.id === fish.id)).toMatchObject({ status: 'done', note: '#1: caught a fish, a cod, and I have it now' });
    cc.stop();
  });

  it('a task said to be done while still under way stays open, noted; the numbers stay as tasks close', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const replies = [
      { thought: 'Wood first.', option: 'work', task: { skill: 'obtain', args: { item: 'oak_log', qty: 20 } }, terminate: { maxSeconds: 60 }, rationale: 'wood', taskDone: '#1: making a house is in progress with Bram, but not finished yet' },
      { thought: 'The cows are penned.', option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'done', taskDone: '#2: the pen is built and holds two cows' },
      { thought: 'More wood.', option: 'work', task: { skill: 'obtain', args: { item: 'oak_log', qty: 20 } }, terminate: { maxSeconds: 60 }, rationale: 'wood', taskDropped: "#1: I'll tackle that after the hut is built" },
    ];
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      return { text: JSON.stringify(replies.shift() ?? { option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'x' }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    const house = cc.giveTask('Make a house.', 'the operator');
    const cows = cc.giveTask('Make a cow farm.', 'the operator');
    const food = cc.giveTask('Secure a renewable source of food.', 'the operator');
    expect([house.n, cows.n, food.n]).toEqual([1, 2, 3]);
    cc.start();
    const decided: string[] = [];
    bus.on('decision', (e) => decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}`));
    // (The tasks came before it was listening: a failure has it think.)
    bus.emit({ type: 'optionTerminated', reason: 'aborted', ok: false, option: 'work' });
    for (let i = 0; i < 160 && decided.length === 0; i++) await wait(25);
    expect(s.state.goals.tasks?.find((t) => t.id === house.id)).toMatchObject({ status: 'open', note: 'still yours, under way as you said: "#1: making a house is in progress with Bram, but not finished yet"' });
    bus.emit({ type: 'optionTerminated', reason: 'aborted', ok: false, option: 'work' });
    for (let i = 0; i < 160 && decided.length < 2; i++) await wait(25);
    expect(s.state.goals.tasks?.find((t) => t.id === cows.id)?.status).toBe('done');
    // The cow farm behind, the food is still #3, and the house #1.
    const packet = buildPacket({ state: s.state, levers: leversFor(0.5), reason: 'x', now: Date.now() });
    expect(packet).toContain('#1 Make a house.');
    expect(packet).toContain('#3 Secure a renewable source of food.');
    expect(packet).toContain('Tasks behind you: #2 Make a cow farm. (done: #2: the pen is built and holds two cows).');
    bus.emit({ type: 'optionTerminated', reason: 'aborted', ok: false, option: 'rest' });
    for (let i = 0; i < 160 && decided.length < 3; i++) await wait(25);
    expect(s.state.goals.tasks?.find((t) => t.id === house.id)).toMatchObject({ status: 'open', note: 'still yours, put off as you said: "#1: I\'ll tackle that after the hut is built"' });
    cc.stop();
  });

  it('a step meant next waits for a thought already under way: what it decides comes first; going on with what is done, or no thought, and the step follows', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const pending: ((r: { text: string }) => void)[] = [];
    let calls = 0;
    let failing = false;
    fake.chat = ({ body }) => {
      if (schemaNameOf(body) !== 'decision') return { text: '{"summary":"ok"}' };
      calls++;
      if (calls === 1) {
        const then = [
          { skill: 'explore', args: { direction: 'east', distance: 120 } },
          { skill: 'obtain', args: { item: 'white_wool', qty: 3 } },
          { skill: 'obtain', args: { item: 'oak_log', qty: 4 } },
        ];
        return { text: JSON.stringify({ thought: 'Shears, then east for sheep.', option: 'work', task: { skill: 'obtain', args: { item: 'shears', qty: 1 } }, terminate: { maxSeconds: 300 }, rationale: 'shears keep the sheep alive', then }) };
      }
      if (failing && pending.length > 0) return { text: 'no idea' };
      return new Promise((resolve) => pending.push(resolve));
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    cc.start();
    const decided: string[] = [];
    bus.on('decision', (e) => {
      const a = e.decision.task?.args ?? {};
      const what = typeof a.item === 'string' ? a.item : typeof a.direction === 'string' ? a.direction : '';
      decided.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option}:${what}`);
    });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 80 && !ok(); i++) await wait(25);
    };
    cc.giveTask('make a bed', 'the operator');
    await until(() => decided.length === 1);
    expect(decided).toEqual(['llm:obtain:shears']);
    // Something to think about while the shears are got; the shears come before the thought does: the step waits.
    cc.giveTask('light the base', 'the operator');
    await until(() => pending.length === 1);
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'work' });
    await wait(200);
    expect(decided).toEqual(['llm:obtain:shears']);
    // It decides something else: that comes first, and the steps meant are still to come after it.
    pending.shift()?.({ text: JSON.stringify({ thought: 'Torches before I go.', option: 'work', task: { skill: 'obtain', args: { item: 'torch', qty: 4 } }, terminate: { maxSeconds: 120 }, rationale: 'light the base' }) });
    await until(() => decided.length === 2);
    expect(decided.at(-1)).toBe('llm:obtain:torch');
    expect(s.state.mind.intention?.steps[0]).toEqual({ skill: 'explore', args: { direction: 'east', distance: 120 } });
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'work' });
    await until(() => decided.length === 3);
    expect(decided.at(-1)).toBe('intention:explore:east');
    // A thought had while exploring that chose to go on exploring, come after the exploring is done: the thought is
    // kept, and the next step follows (not the exploring again).
    cc.giveTask('find a village', 'the operator');
    await until(() => pending.length === 1);
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'work' });
    pending.shift()?.({ text: JSON.stringify({ thought: 'Keep heading east; a village may be out there too.', option: 'work', task: { skill: 'explore', args: { direction: 'east', distance: 120 } }, terminate: { maxSeconds: 300 }, rationale: 'east' }) });
    await until(() => decided.length === 4);
    expect(decided.at(-1)).toBe('intention:obtain:white_wool');
    expect(s.state.mind.thoughts.at(-1)?.text).toBe('Keep heading east; a village may be out there too.');
    // No thought comes (the model's reply unusable): the step follows, with no fallback of the code's in its place.
    cc.giveTask('make a sign', 'the operator');
    await until(() => pending.length === 1);
    failing = true;
    bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'work' });
    pending.shift()?.({ text: 'no idea' });
    await until(() => decided.length === 5);
    expect(decided.at(-1)).toBe('intention:obtain:oak_log');
    expect(s.state.mind.intention).toBeNull();
    cc.stop();
  });

  it('doing now the step meant next takes it off what is to come', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = ({ body }) =>
      schemaNameOf(body) !== 'decision' ? { text: '{"summary":"ok"}' } : { text: JSON.stringify({ thought: 'The wool first after all.', option: 'work', task: { skill: 'obtain', args: { item: 'white_wool', qty: 3 } }, terminate: { maxSeconds: 300 }, rationale: 'wool' }) };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    s.update('mind', (m) => ({ ...m, intention: { aim: 'a bed', steps: [{ skill: 'obtain', args: { item: 'white_wool', qty: 3 } }, { skill: 'obtain', args: { item: 'oak_planks', qty: 3 } }], from: 'd0', at: Date.now() } }), 'test');
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false });
    cc.start();
    let n = 0;
    bus.on('decision', () => n++);
    cc.giveTask('make a bed', 'the operator');
    for (let i = 0; i < 80 && n === 0; i++) await wait(25);
    expect(s.state.mind.intention?.steps).toEqual([{ skill: 'obtain', args: { item: 'oak_planks', qty: 3 } }]);
    cc.stop();
  });
});
