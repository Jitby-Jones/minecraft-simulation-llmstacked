// The architect (owner request, 2026-10-24): the agents' own buildings, drawn by a strong model in the building
// language with the repertoire as its framework, checked by the compiler and put right once, made buildable by code
// (lookalikes, a bill, crafting steps, whom to ask), kept for the village, and made the designer's plan.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelsConfigSchema, PersonaSchema, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { LANGUAGE, asksFor, buildingPlan, compactDesign, describeDesign, designBuilding, examplesFor, nearestDesign, type DesignRequest } from '@agora/agent/building/architect';
import { DesignSchema } from '@agora/agent/building/design';
import { Repertoire } from '@agora/agent/building/repertoire';
import { evalCondition } from '@agora/agent/modules/conditions';
import { biomeStyle } from '@agora/agent/body/skills/design';
import { createInitialState } from '@agora/agent/state/initial';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const repertoire = () => new Repertoire({ madeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agora-arch-')), serverDir: '/nonexistent' }).load();
const request = (over: Partial<DesignRequest> = {}): DesignRequest => ({
  purpose: 'a cosy house for me and Wren',
  by: 'Mira',
  persona: 'Mira: curious, warm',
  biome: 'plains',
  raw: { sand: 0.4 },
  materials: 'trees about: oak; sand near',
  village: [],
  helpers: [
    { name: 'Bram', does: 'miner' },
    { name: 'Pip', does: 'woodcutter' },
  ],
  ...over,
});

const cabin = {
  name: 'mira and wren house',
  kind: 'house',
  description: 'a birch and cobblestone house with a porch',
  wallHeight: 3,
  parts: [{ size: [7, 6], walls: 'birch_planks', posts: 'oak_log', foundation: 'cobblestone', floor: 'oak_planks', roof: { style: 'gable', material: 'oak' }, windows: { every: 2 } }],
  door: { side: 'south' },
  interior: ['bed', 'bed', 'chest', 'crafting_table', 'furnace'],
  features: [{ type: 'porch' }],
};

async function withModel(replies: (n: number) => unknown, run: (rt: Awaited<ReturnType<typeof startLlm>>) => Promise<void>): Promise<number> {
  const fake = new FakeNanoGpt(standardModels());
  let n = 0;
  fake.chat = () => ({ text: JSON.stringify(replies(n++)) });
  const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
  try {
    await run(rt);
  } finally {
    rt.stop();
  }
  return n;
}

describe('the architect', () => {
  it('shows the repertoire nearest to what is asked, and one of another shape', () => {
    const rep = repertoire();
    const ex = examplesFor(rep, request({ purpose: 'a smithy for the village', kind: 'smithy' }));
    expect(ex.length).toBe(3);
    expect(ex[0]?.id).toBe('smithy');
    expect(ex.some((b) => (b.design?.parts.length ?? 0) > 1)).toBe(true);
    // Compact: no ids, no empty lists.
    const text = compactDesign(ex[0]?.design ?? DesignSchema.parse(cabin));
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('[]');
    expect(LANGUAGE).toContain('"roof"');
    expect(nearestDesign(rep, request({ purpose: 'a wheat field' }))?.design?.plot?.type).toBe('farm');
  });

  it('asks whoever does that work for what it takes: the woodcutter the logs, the miner the stone', () => {
    const asks = asksFor(
      [
        { item: 'oak_log', count: 30 },
        { item: 'cobblestone', count: 50 },
        { item: 'sand', count: 6 },
      ],
      [
        { name: 'Pip', does: 'woodcutter' },
        { name: 'Bram', does: 'miner' },
        { name: 'Mira', does: 'woodcutter' },
      ],
      'Mira',
    );
    expect(asks).toEqual([
      { who: 'Bram', item: 'cobblestone', count: 50 },
      { who: 'Pip', item: 'oak_log', count: 30 },
    ]);
  });

  it('draws one, keeps it for the village, and works out what it takes and how', async () => {
    const rep = repertoire();
    let result: Awaited<ReturnType<typeof designBuilding>> | null = null;
    const calls = await withModel(
      () => ({ design: cabin, note: 'a porch to sit on' }),
      async (rt) => {
        result = await designBuilding(request(), { llm: rt.client, repertoire: rep, logger: nullLogger() });
      },
    );
    expect(calls).toBe(1);
    const r = result as unknown as Awaited<ReturnType<typeof designBuilding>>;
    expect(r.how).toBe('designed');
    expect(r.note).toBe('a porch to sit on');
    expect(r.building.id).toBe('mira-and-wren-house');
    expect(r.building.source).toBe('designed by Mira');
    expect(rep.find('mira-and-wren-house')).toBeDefined();
    expect(r.materials.raw.map((x) => x.item)).toContain('cobblestone');
    expect(r.materials.steps.some((s) => s.item === 'oak_door' && s.how === 'craft')).toBe(true);
    expect(r.asks.map((a) => a.who).sort()).toEqual(['Bram', 'Pip']);
    // The plan: get, ask, make, build.
    const plan = buildingPlan(r, 'a cosy house for me and Wren');
    expect(plan.aim).toMatch(/^build the mira and wren house/);
    expect(plan.steps.length).toBeLessThanOrEqual(6);
    expect(plan.steps.some((s) => s.doneWhen === 'talkedWith:Bram')).toBe(true);
    expect(plan.steps.at(-1)).toEqual({ text: 'build the mira and wren house', doneWhen: 'built:mira-and-wren-house' });
    expect(describeDesign(r)).toMatch(/designed the mira and wren house.*it takes about/);
  });

  it('sends back what does not work, once; a design that still will not do is the repertoire\'s nearest', async () => {
    const rep = repertoire();
    let repaired: Awaited<ReturnType<typeof designBuilding>> | null = null;
    const broken = { ...cabin, parts: [{ ...cabin.parts[0], roof: { style: 'gable', material: 'gold' } }] };
    const seen: string[] = [];
    await withModel(
      (n) => (n === 0 ? { design: broken, note: '' } : { design: cabin, note: 'put right' }),
      async (rt) => {
        repaired = await designBuilding(request(), { llm: rt.client, repertoire: rep, logger: nullLogger() });
      },
    );
    const r1 = repaired as unknown as Awaited<ReturnType<typeof designBuilding>>;
    expect(r1.how).toBe('repaired');
    expect(r1.problems.some((p) => p.includes('no roof of gold'))).toBe(true);
    void seen;
    let fallback: Awaited<ReturnType<typeof designBuilding>> | null = null;
    await withModel(
      () => ({ design: { name: 'x' }, note: '' }),
      async (rt) => {
        fallback = await designBuilding(request({ purpose: 'a smithy', kind: 'smithy' }), { llm: rt.client, repertoire: rep, logger: nullLogger() });
      },
    );
    const r2 = fallback as unknown as Awaited<ReturnType<typeof designBuilding>>;
    expect(r2.how).toBe('repertoire');
    expect(r2.building.id).toBe('smithy');
    // Without a model, the repertoire's nearest at once.
    const r3 = await designBuilding(request({ purpose: 'a lookout tower', kind: 'tower' }), { llm: null, repertoire: rep, logger: nullLogger() });
    expect(r3.how).toBe('repertoire');
    expect(r3.building.id).toBe('stone-tower');
  });

  it('a design too big for what was asked is made smaller', async () => {
    const rep = repertoire();
    const huge = { ...cabin, parts: [{ ...cabin.parts[0], size: [15, 15], floors: 3 }] };
    let r: Awaited<ReturnType<typeof designBuilding>> | null = null;
    await withModel(
      (n) => (n === 0 ? { design: huge, note: '' } : { design: cabin, note: 'smaller' }),
      async (rt) => {
        r = await designBuilding(request({ maxEffort: 60 }), { llm: rt.client, repertoire: rep, logger: nullLogger() });
      },
    );
    const res = r as unknown as Awaited<ReturnType<typeof designBuilding>>;
    expect(res.problems.some((p) => /make it smaller/.test(p))).toBe(true);
    expect(res.how).toBe('repaired');
  });

  it('a step to build it is done when a building of that design is finished', () => {
    const s = createInitialState({ persona: PersonaSchema.parse({ name: 'Mira', sex: 'female', traits: ['warm'] }), username: 'Mira', now: 0 });
    expect(evalCondition('built:mira-house', s)).toBe(false);
    s.village.projects.push({ design: 'mira-house', name: 'mira house', origin: { x: 0, y: 64, z: 0 }, turn: 0, size: { x: 9, z: 8 }, door: null, startedAt: 1, placed: 100, total: 100, missing: {}, swaps: {}, doneAt: 5 });
    expect(evalCondition('built:mira-house', s)).toBe(true);
    expect(biomeStyle('snowy_taiga')).toBe('taiga');
    expect(biomeStyle('snowy_plains')).toBe('snowy');
    expect(biomeStyle('badlands')).toBe('desert');
    expect(biomeStyle('flower_forest')).toBe('plains');
  });
});
