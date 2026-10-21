// M4 (§10): memory (Summarize-and-Forget over SQLite with local embeddings), Goal Generation and code quirks, without
// Minecraft. Live behavior is in tests/live/m4-agent.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentState, ModelsConfigSchema, PersonaSchema, type Quirk, type Utterance, dataPaths, loadVersionsConfig, nullLogger } from '@agora/shared';
import { HashEmbedder, LocalEmbedder, LocalRateLimiter, cosine, fromBlob, startLlm, toBlob } from '@agora/llm';
import type { Body } from '@agora/agent/body/body';
import { AgentBus } from '@agora/agent/bus';
import { MemoryDB } from '@agora/agent/memory/db';
import { Memory, clusterVectors } from '@agora/agent/memory/memory';
import type { CognitiveController } from '@agora/agent/modules/cc';
import type { SkillExecutor } from '@agora/agent/modules/executor';
import { GoalGen, codeGoal } from '@agora/agent/modules/goalGen';
import { QuirkRunner } from '@agora/agent/modules/quirkRunner';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { pushWorkmem } from '@agora/agent/state/workmem';
import type { DecisionOutput } from '@agora/shared';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['curious'], lifeGoals: ['build a lighthouse by the sea'] });
const store = () => new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await wait(5);
  }
}

function memoryFor(s: AgentStateStore, opts: { recentCap?: number; now?: () => number } = {}) {
  const db = new MemoryDB(':memory:');
  const bus = new AgentBus();
  const memory = new Memory({ store: s, bus, logger: nullLogger(), db, embedder: new HashEmbedder(), llm: null, me: 'Pip', ...opts });
  return { db, bus, memory };
}

function withInventory(s: AgentState, items: Record<string, number>): AgentState {
  return { ...s, self: { ...s.self, inventory: Object.entries(items).map(([item, qty]) => ({ item, qty })) } };
}

describe('embeddings (§22.5)', () => {
  it('hashing fallback: normalized, and similar text scores higher than unrelated text', async () => {
    const e = new HashEmbedder();
    const [a, b, c] = await e.embed(['iron ore by the river', 'there is iron ore near the river', 'I like baking bread']);
    expect(cosine(a as Float32Array, a as Float32Array)).toBeCloseTo(1, 5);
    expect(cosine(a as Float32Array, b as Float32Array)).toBeGreaterThan(cosine(a as Float32Array, c as Float32Array));
  });

  it('round-trips vectors through SQLite blobs', () => {
    const v = new Float32Array([0.25, -1.5, 3, 0]);
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.25, -1.5, 3, 0]);
  });

  const versions = loadVersionsConfig();
  const modelRoot = path.join(dataPaths().cache, 'models');
  const installed = fs.existsSync(path.join(modelRoot, ...versions.embeddingModel.id.split('/'), 'onnx', 'model_quantized.onnx'));
  it.skipIf(!installed)(
    'local MiniLM runs offline, batches concurrent requests, and ranks paraphrases above unrelated text',
    async () => {
      const e = new LocalEmbedder({ modelDir: modelRoot, modelId: versions.embeddingModel.id, dims: versions.embeddingModel.dims, logger: nullLogger() });
      const [one, two] = await Promise.all([e.embed(['Bram found iron near the river']), e.embed(['there is iron ore by the river, says Bram', 'I want to bake some bread'])]);
      const [a] = one;
      const [b, c] = two;
      expect(a?.length).toBe(versions.embeddingModel.dims);
      expect(cosine(a as Float32Array, a as Float32Array)).toBeCloseTo(1, 3);
      expect(cosine(a as Float32Array, b as Float32Array)).toBeGreaterThan(cosine(a as Float32Array, c as Float32Array) + 0.2);
    },
    60_000,
  );
});

describe('memory: Summarize-and-Forget (§4.7)', () => {
  it('clusters by average linkage', () => {
    const v = (xs: number[]) => {
      const n = Math.hypot(...xs);
      return new Float32Array(xs.map((x) => x / n));
    };
    const groups = clusterVectors([v([1, 0, 0]), v([0.95, 0.05, 0]), v([0, 1, 0]), v([0, 0.9, 0.1])], 0.8);
    expect(groups.map((g) => [...g].sort()).sort()).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('moves what falls out of workmem into recentmem and replaces near-duplicates', async () => {
    const s = store();
    const { db, memory } = memoryFor(s);
    memory.start();
    for (let i = 0; i < 7; i++) pushWorkmem(s, `note number ${i} about the oak forest`, 0.5, 'self_observed', { now: i });
    await until(() => db.count('recent') === 2);
    expect(db.list('recent').map((r) => r.text)).toEqual(['note number 0 about the oak forest', 'note number 1 about the oak forest']);
    // The same fact again (punctuation aside) replaces the old row instead of piling up.
    await memory.ingest([{ id: 'x1', text: 'note number 0 about the oak forest!', ts: 10, salience: 0.5, source: 'self_observed' }]);
    expect(db.list('recent').filter((r) => r.text.startsWith('note number 0'))).toHaveLength(1);
    memory.stop();
  });

  it('keeps hearsay as hearsay: told_by source, confidence = trust × 0.8, labeled for the CC', async () => {
    const s = store();
    s.update('social', (x) => ({ ...x, Bram: { ...newSocialProfile('Bram', persona, 0), trust: 0.75 } }), 'met');
    const { db, bus, memory } = memoryFor(s);
    memory.start();
    const u: Utterance = { id: 'u1', convId: 'c1', from: 'Bram', to: ['Pip'], text: 'there are diamonds under the big oak', ts: 0, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true };
    bus.emit({ type: 'addressed', utterance: u });
    expect(s.state.workmem.at(-1)?.source).toBe('told_by:Bram');
    await memory.flush();
    const row = db.list('recent').find((r) => r.text.includes('diamonds'));
    expect(row?.source).toBe('told_by:Bram');
    expect(row?.confidence).toBeCloseTo(0.6, 5);
    const [top] = await memory.recall('where are the diamonds', 1);
    expect(top?.label).toContain('(heard from Bram, unverified)');
    memory.stop();
  });

  it('consolidates the older part of recentmem into longmem when it is full', async () => {
    const s = store();
    const { db, memory } = memoryFor(s, { recentCap: 6 });
    const items = [
      'chopped 3 oak logs near the hill',
      'chopped 4 oak logs near the hill',
      'chopped 5 oak logs near the hill',
      'Bram waved at me by the lake',
      'saw a creeper at night by the farm',
      'the furnace is next to the house door',
      'made a crafting table at the camp',
    ].map((text, i) => ({ id: `w${i}`, text, ts: i, salience: 0.4 + i * 0.05, source: 'self_observed' as const }));
    await memory.ingest(items);
    expect(db.count('long')).toBeGreaterThan(0);
    expect(db.count('recent')).toBeLessThan(7);
    const long = db.list('long');
    // The three near-identical chopping notes became one memory (code merge without an LLM).
    expect(long.filter((r) => r.text.includes('oak logs'))).toHaveLength(1);
    expect(long.find((r) => r.text.includes('oak logs'))?.importance).toBeCloseTo(0.5, 5);
    expect(db.count('long') + db.count('recent')).toBe(5);
  });

  it('recalls by relevance × recency × importance, never returns memories found false, and skips what is on mind', async () => {
    const t = { now: 1_000_000 };
    const s = store();
    const { db, memory } = memoryFor(s, { now: () => t.now });
    await memory.ingest([
      { id: 'a', text: 'Mira keeps iron in the chest by the well', ts: t.now, salience: 0.8, source: 'self_observed' },
      { id: 'b', text: 'the sunset over the plains was pretty', ts: t.now, salience: 0.3, source: 'self_observed' },
      { id: 'c', text: 'Tobin said the iron chest is empty', ts: t.now, salience: 0.5, source: 'told_by:Tobin' },
    ]);
    const top = await memory.recall('iron chest', 3);
    expect(top[0]?.text).toContain('Mira keeps iron');
    const empty = db.list().find((r) => r.text.includes('chest is empty'));
    db.markFalse(empty?.id ?? '');
    expect((await memory.recall('iron chest', 3)).some((m) => m.text.includes('empty'))).toBe(false);
    // Old memories fade but never vanish entirely (recency floor).
    t.now += 48 * 3_600_000;
    expect((await memory.recall('iron chest', 1))[0]?.score).toBeGreaterThan(0);
    // forPacket leaves out what is already in working memory.
    s.update('goals', (g) => ({ ...g, current: { id: 'g1', text: 'find iron', kind: 'current', createdAt: 0, status: 'active' } }), 'goal');
    pushWorkmem(s, 'Mira keeps iron in the chest by the well', 0.8, 'self_observed', { now: t.now });
    const packet = await memory.forPacket(3);
    expect(packet.some((m) => m.includes('Mira keeps iron'))).toBe(false);
  });
});

describe('goal generation (§4.2 module 10)', () => {
  it('code ladder: wooden pickaxe → stone tools → furnace → iron pickaxe → cobblestone → life goals', () => {
    const base = createInitialState({ persona, username: 'Pip', now: 0 });
    expect(codeGoal(base)).toEqual({ text: 'make a wooden pickaxe', doneWhen: 'inventoryHas:wooden_pickaxe>=1' });
    expect(codeGoal(withInventory(base, { wooden_pickaxe: 1 }))?.doneWhen).toBe('inventoryHas:stone_pickaxe>=1');
    expect(codeGoal(withInventory(base, { stone_pickaxe: 1 }))?.doneWhen).toBe('inventoryHas:furnace>=1');
    expect(codeGoal(withInventory(base, { stone_pickaxe: 1, furnace: 1 }))?.doneWhen).toBe('inventoryHas:iron_pickaxe>=1');
    expect(codeGoal(withInventory(base, { iron_pickaxe: 1, furnace: 1, cobblestone: 40 }))).toEqual({ text: 'build a lighthouse by the sea' });
    const busy = { ...base, goals: { ...base.goals, current: { id: 'g', text: 'x', kind: 'current' as const, createdAt: 0, status: 'active' as const } } };
    expect(codeGoal(busy)).toBeNull();
  });

  it('code-only: sets the next ladder goal', async () => {
    const s = store();
    const set: [string, string | undefined][] = [];
    const gg = new GoalGen({ store: s, bus: new AgentBus(), logger: nullLogger(), llm: null, me: 'Pip', setGoal: (t, d) => set.push([t, d]) });
    await gg.run('starting');
    expect(set).toEqual([['make a wooden pickaxe', 'inventoryHas:wooden_pickaxe>=1']]);
  });

  it('with a model: L3 goal with a checked doneWhen; an unparseable doneWhen is dropped; keep means keep', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const replies = [
      { keep: false, goal: { text: 'build a small hut by the lake', doneWhen: 'inventoryHas:oak_planks>=20', why: 'I want a home' } },
      { keep: false, goal: { text: 'make friends with Bram', doneWhen: 'whenever it feels right', why: 'he seems kind' } },
      { keep: true },
    ];
    const tiers: string[] = [];
    fake.chat = (c) => {
      tiers.push(c.model);
      return { text: JSON.stringify(replies.shift()) };
    };
    const rt = await startLlm({ apiKey: 'test', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 50 }) });
    try {
      const s = store();
      const set: [string, string | undefined][] = [];
      const gg = new GoalGen({
        store: s,
        bus: new AgentBus(),
        logger: nullLogger(),
        llm: rt.client,
        me: 'Pip',
        setGoal: (t, d) => {
          set.push([t, d]);
          s.update('goals', (g) => ({ ...g, current: { id: `g${set.length}`, text: t, kind: 'current', createdAt: 0, status: 'active', ...(d ? { doneWhen: d } : {}) } }), 'goal');
        },
      });
      await gg.run('starting');
      await gg.run('periodic');
      await gg.run('periodic');
      expect(set).toEqual([
        ['build a small hut by the lake', 'inventoryHas:oak_planks>=20'],
        ['make friends with Bram', undefined],
      ]);
      expect(fake.chatRequests()).toHaveLength(3);
      const sys = String((fake.chatRequests()[0]?.body?.messages as { content: string }[] | undefined)?.[0]?.content);
      expect(sys).toContain('Choose your next concrete goal');
    } finally {
      rt.stop();
    }
  });
});

describe('code quirks (§7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function runner(quirks: Quirk[], opts: { people?: string[]; busy?: boolean } = {}) {
    const s = store();
    const said: string[] = [];
    const impulses: DecisionOutput[] = [];
    const t = { now: 0 };
    const body = { say: (x: string) => (said.push(x), Promise.resolve()) } as unknown as Body;
    const cc = { impulse: (d: DecisionOutput) => (impulses.push(d), true) } as unknown as CognitiveController;
    const executor = { busy: opts.busy ?? false, talkOverable: () => false } as unknown as SkillExecutor;
    const qr = new QuirkRunner({ store: s, bus: new AgentBus(), body, cc, executor, logger: nullLogger(), quirks, peopleInRange: () => opts.people ?? [], rng: () => 0, now: () => t.now });
    return { s, said, impulses, t, qr };
  }

  it('idleEmote: says a line every so often, only when idle and someone can hear', () => {
    vi.useFakeTimers();
    const lonely = runner([{ hook: 'idleEmote', everySec: 30, say: ['hm-hm-hmm'] }]);
    lonely.qr.start();
    lonely.t.now = 60_000;
    vi.advanceTimersByTime(2000);
    expect(lonely.said).toEqual([]);
    lonely.qr.stop();

    const heard = runner([{ hook: 'idleEmote', everySec: 30, say: ['hm-hm-hmm'] }], { people: ['Bram'] });
    heard.qr.start();
    heard.t.now = 10_000;
    vi.advanceTimersByTime(1000);
    expect(heard.said).toEqual([]);
    heard.t.now = 30_000;
    vi.advanceTimersByTime(1000);
    expect(heard.said).toEqual(['hm-hm-hmm']);
    heard.t.now = 31_000;
    vi.advanceTimersByTime(1000);
    expect(heard.said).toHaveLength(1);
    heard.qr.stop();

    const busy = runner([{ hook: 'idleEmote', everySec: 30, say: ['hm'] }], { people: ['Bram'], busy: true });
    busy.qr.start();
    busy.t.now = 90_000;
    vi.advanceTimersByTime(1000);
    expect(busy.said).toEqual([]);
    busy.qr.stop();
  });

  it('distraction: one roll per creature seen, an approach impulse, then a cooldown', () => {
    vi.useFakeTimers();
    const r = runner([{ hook: 'distraction', chance: 0.5, onSee: ['sheep'], action: 'approach' }]);
    const seen = (id: number, name: string, distance: number) => ({
      id,
      kind: 'passive' as const,
      name,
      pos: { x: 10, y: -60, z: 3 },
      distance,
      visible: true,
      heldItem: null,
      armor: [],
      lastSeen: 0,
      hurtRecently: false,
    });
    r.s.update('perception', (p) => ({ ...p, nearbyEntities: [seen(1, 'cow', 4), seen(2, 'sheep', 20)] }), 'see');
    r.qr.start();
    r.t.now = 61_000;
    vi.advanceTimersByTime(1000);
    expect(r.impulses).toEqual([]);
    r.s.update('perception', (p) => ({ ...p, nearbyEntities: [seen(2, 'sheep', 8)] }), 'see');
    vi.advanceTimersByTime(1000);
    expect(r.impulses).toHaveLength(1);
    expect(r.impulses[0]).toMatchObject({ option: 'move', target: { pos: { x: 10, y: -60, z: 3 } }, terminate: { maxSeconds: 15 } });
    expect(r.s.state.workmem.at(-1)?.text).toBe('got distracted by a sheep');
    // A new sheep inside the cooldown is ignored; after it, it can pull the agent away again.
    r.s.update('perception', (p) => ({ ...p, nearbyEntities: [seen(3, 'sheep', 6)] }), 'see');
    r.t.now = 90_000;
    vi.advanceTimersByTime(1000);
    expect(r.impulses).toHaveLength(1);
    r.s.update('perception', (p) => ({ ...p, nearbyEntities: [seen(4, 'sheep', 6)] }), 'see');
    r.t.now = 125_000;
    vi.advanceTimersByTime(1000);
    expect(r.impulses).toHaveLength(2);
    r.qr.stop();
  });
});
