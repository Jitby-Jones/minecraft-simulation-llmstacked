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
import { addLesson, matchTask, overlap } from '@agora/agent/mind/learning';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { buildPacket, placesFor, triedLately } from '@agora/agent/modules/bottleneck';
import { CognitiveController } from '@agora/agent/modules/cc';
import { tidyDecision } from '@agora/agent/modules/decisionTidy';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { type Motion, MotionTracker } from '@agora/agent/perception/motion';
import { type Seen, SceneEyes, featureKindOf, featuresOf } from '@agora/agent/perception/scene';
import { pocketPlan, resolveCraftTarget } from '@agora/agent/body/skills/crafting';
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
    // Later, with idle hands: diamonds from nowhere (someone ran /give).
    w.inv.push({ name: 'diamond', count: 3 });
    t.now = 24_000;
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
    expect(r({ red_wool: 3 }, 'bed')).toBe('red_bed');
    expect(r({}, 'wool')).toBe('white_wool');
    expect(r({}, 'stick')).toBe('stick');
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
    expect(featureKindOf('grass_block')).toBe('ground');
    expect(featureKindOf('crafting_table')).toBe('station');
    expect(bearingOf({ x: 0, z: 0 }, { x: 0, z: -10 })).toBe('north');
    expect(countOf(3, 'sheep')).toBe('3 sheep');
    expect(countOf(1, 'iron_golem')).toBe('an iron golem');
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

  it('a task is found by its number or by what it says', () => {
    const tasks = [
      { id: 'a', text: 'Obtain 12 diamonds', from: 'op', at: 0, status: 'open' as const },
      { id: 'b', text: 'Make an enchanting table', from: 'op', at: 0, status: 'open' as const },
    ];
    expect(matchTask(tasks, 'the enchanting table is made and placed')?.id).toBe('b');
    expect(matchTask(tasks, 'task 1')?.id).toBe('a');
    expect(matchTask(tasks, 'something else entirely')).toBeNull();
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
    expect(k.topics('secure a renewable source of food').join(' ')).toMatch(/Food that keeps coming/);
    // Where ores are, as anyone who has mined knows (an agent dug 48 blocks at y 29 for iron, then wrote itself that iron is at -58).
    expect(k.topics('mine iron for a full set of armor').join(' ')).toMatch(/iron in two bands, richest around y 16/);
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
    expect(lines.join('\n')).toMatch(/Armor: a set is a helmet, a chestplate, leggings and boots; in iron that is 5 \+ 8 \+ 7 \+ 4 = 24 iron ingots/);
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
    expect(p).toContain('Tasks you have taken on:\n  - make a bed (from the operator, 1m ago)');
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
});
