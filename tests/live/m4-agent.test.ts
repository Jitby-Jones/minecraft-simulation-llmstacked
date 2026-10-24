// M4 exit test (§10): memory, Goal Generation and quirks on a real server.
//   1. No x-ray (§13 rule 4): with iron hidden in the stone, `gather` won't target it; `prospect` digs until the ore
//      is in sight, and mines it there and then.
//   2. A told fact is recalled later: Bram tells Tobin where the diamonds are; the line drops out of working memory
//      into SQLite; asked much later, Tobin's Talking gets it back through the local embedder and repeats it with
//      attribution. Goal Gen makes Tobin's plan through L3. The model is a scripted stand-in (no key here).
//   3. Code-only Pip works through a plan on her own: given one the way an operator would (wooden pickaxe → stone
//      tools → furnace → iron pickaxe, the iron hidden in the ground), the code default carries it out step by step,
//      then she makes a plan of her own; and her quirks show: she picks the poppies she passes and hums when someone
//      is near. Capped at 25 minutes.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Logger,
  ModelsConfigSchema,
  type Persona,
  WorldConfigSchema,
  createLogger,
  dataPaths,
  loadPersonaPool,
  loadVersionsConfig,
  parseProximityLine,
  sleep,
} from '@agora/shared';
import { type Embedder, LocalRateLimiter, createEmbedder, startLlm } from '@agora/llm';
import { Agent, MemoryDB } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { countItem } from '@agora/agent/body/inventory';
import { debugOp } from '@agora/agent/hub/debug';
import { pushWorkmem } from '@agora/agent/state/workmem';
import { FakeNanoGpt, standardModels, schemaNameOf } from '../llm/fakeNanoGpt';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const world = WorldConfigSchema.parse({});
const Y = -60;
const pool = loadPersonaPool();
const persona = (id: string): Persona => {
  const p = pool.find((x) => x.id === id);
  if (!p) throw new Error(`persona ${id} missing`);
  return p;
};

/** Deterministic positions for hidden ore. */
function* lcg(seed: number): Generator<number> {
  let s = seed;
  for (;;) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    yield s / 2 ** 32;
  }
}

describe.skipIf(!liveJavaPath())('M4 live: memory, goals and quirks', () => {
  let server: LiveServer;
  let logger: Logger;
  let embedder: Embedder;
  let memDir: string;

  /** Superflat with a 21×21 stone patch two blocks deep (iron hidden in its lower layer), oaks and poppies around. */
  async function village(x: number, z: number, ores: number): Promise<void> {
    await server.cmd(`forceload add ${x - 28} ${z - 28} ${x + 28} ${z + 28}`);
    for (const [dx, dz] of [
      [14, 6],
      [-14, -5],
      [6, 14],
      [-5, -14],
    ] as const) {
      await server.cmd(`place feature minecraft:oak ${x + dx} ${Y} ${z + dz}`);
    }
    await server.cmd(`fill ${x - 10} ${Y - 2} ${z - 10} ${x + 10} ${Y - 1} ${z + 10} minecraft:stone`);
    const r = lcg(x * 31 + z);
    for (let i = 0; i < ores; i++) {
      const ox = x - 10 + Math.floor((r.next().value as number) * 21);
      const oz = z - 10 + Math.floor((r.next().value as number) * 21);
      await server.cmd(`setblock ${ox} ${Y - 2} ${oz} minecraft:iron_ore`);
    }
    await server.cmd(`setblock ${x + 13} ${Y} ${z + 2} minecraft:poppy`);
    await server.cmd(`setblock ${x - 13} ${Y} ${z - 1} minecraft:poppy`);
    await server.cmd(`setblock ${x + 2} ${Y} ${z + 13} minecraft:poppy`);
  }

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm4', port: 25570, rconPort: 25580 });
    logger = createLogger({ name: 'm4-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    memDir = path.join(server.dir, '..', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    embedder = await createEmbedder({ modelDir: path.join(dataPaths().cache, 'models'), modelId: versions.embeddingModel.id, dims: versions.embeddingModel.dims, logger });
    await server.cmd('gamerule advance_time false');
    await server.cmd('gamerule advance_weather false');
    await server.cmd('weather clear');
    await server.cmd('time set 1000');
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('no x-ray: hidden iron is not a target until prospecting brings it into sight', async () => {
    const x = 1200;
    const z = 0;
    await server.cmd(`forceload add ${x - 16} ${z - 16} ${x + 32} ${z + 16}`);
    // A stone hill 10 high; iron in its side at tunnel level, and more iron right under the start, both hidden.
    await server.cmd(`fill ${x - 3} ${Y} ${z - 3} ${x + 20} ${Y + 10} ${z + 3} minecraft:stone`);
    await server.cmd(`setblock ${x + 10} ${Y + 8} ${z + 1} minecraft:iron_ore`);
    await server.cmd(`setblock ${x} ${Y + 7} ${z} minecraft:iron_ore`);
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Ruth', version: versions.minecraft.version, logger });
    try {
      await server.cmd(`tp Ruth ${x}.5 ${Y + 11} ${z}.5`);
      await server.cmd('give Ruth minecraft:stone_pickaxe');
      await server.cmd('give Ruth minecraft:cobblestone 16');
      await sleep(2000);
      const blind = await body.run('gather', { item: 'raw_iron', qty: 1 });
      expect(blind.ok).toBe(false);
      expect(blind.error).toMatch(/haven't seen any iron_ore around here; raw_iron comes from mining it/);
      const p = await body.run('prospect', { item: 'raw_iron', direction: 'east' });
      console.log(`[m4 prospect] ${p.ok ? 'ok' : 'FAIL'}: ${p.observed} ${p.error ?? ''}`);
      expect(p.ok).toBe(true);
      expect(p.observed).toMatch(/found iron_ore at \(1210, -52, 1\)/);
      // What it went looking for, found, is mined there and then.
      expect(countItem(body.bot, 'raw_iron')).toBe(1);
      // The ore right under the start was never seen, so it is still there.
      expect(body.bot.blockAt(new Vec3(x, Y + 7, z))?.name).toBe('iron_ore');
    } finally {
      await body.disconnect();
    }
  }, 240_000);

  it('recalls a told fact much later and repeats it with attribution (scripted model, real embedder)', async () => {
    const x = 900;
    const z = 0;
    await village(x, z, 0);
    const fake = new FakeNanoGpt(standardModels());
    const talkPrompts: string[] = [];
    let goalCalls = 0;
    fake.chat = ({ body }) => {
      const messages = body.messages as { role: string; content: string }[];
      const user = messages.at(-1)?.content ?? '';
      const schema = schemaNameOf(body);
      if (schema === 'summary') return { text: JSON.stringify({ summary: 'I like an easy life and a good joke.' }) };
      if (schema === 'memory') return { text: JSON.stringify({ text: messages.at(-1)?.content.split('\n')[0]?.slice(2) ?? 'stuff happened' }) };
      if (schema === 'plan') {
        goalCalls++;
        return {
          text: JSON.stringify(
            goalCalls === 1
              ? { keep: false, plan: { aim: 'better tools', steps: [{ text: 'get stone tools', doneWhen: 'inventoryHas:stone_pickaxe>=1' }, { text: 'look around', doneWhen: 'explored:2' }], why: 'less work later' } }
              : { keep: true },
          ),
        };
      }
      if (schema === 'decision') {
        if (/Current goal: none set/.test(user)) return { text: JSON.stringify({ option: 'rest', terminate: { maxSeconds: 30 }, rationale: 'nothing to do' }) };
        const lastObtain = [...user.matchAll(/obtain \{"item":"([a-z_]+)"[^}]*\}: (ok|FAILED)[^\n]*/g)].at(-1);
        const first = lastObtain?.[2] === 'FAILED' ? /get ([a-z_]+) first/.exec(lastObtain[0])?.[1] : undefined;
        const item = first ?? 'stone_pickaxe';
        return { text: JSON.stringify({ option: 'work', task: { skill: 'obtain', args: { item, qty: 1 } }, terminate: { maxSeconds: 600 }, rationale: `need ${item}` }) };
      }
      talkPrompts.push(user);
      if (/You remember:[\s\S]*diamonds are buried/.test(user)) return { text: "Bram says they're buried under the big oak by the lake." };
      return { text: 'heh, nice one!' };
    };
    const rt = await startLlm({ apiKey: 'scripted', config: ModelsConfigSchema.parse({}), logger, fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 50 }) });
    const db = new MemoryDB(path.join(memDir, 'Tobin.sqlite'));
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Tobin', version: versions.minecraft.version, logger });
    const bram = await Body.connect({ host: server.host, port: server.port, username: 'Bram', version: versions.minecraft.version, logger });
    await server.cmd(`tp Tobin ${x} ${Y} ${z}`);
    await server.cmd(`tp Bram ${x + 3} ${Y} ${z}`);
    await sleep(1500);
    const tobinSaid: string[] = [];
    bram.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech' && p.speaker === 'Tobin') tobinSaid.push(p.text);
    });
    const agent = new Agent({ body, persona: persona('tobin'), username: 'Tobin', llm: rt.client, logger, world, memory: { db, embedder } });
    agent.start();
    try {
      await waitFor(() => agent.store.state.goals.current?.text === 'get stone tools', 30_000, 'a plan from Goal Gen');
      expect(agent.store.state.goals.current?.doneWhen).toBe('inventoryHas:stone_pickaxe>=1');
      expect(agent.store.state.goals.plan).toMatchObject({ aim: 'better tools', source: 'llm' });
      await server.cmd('tp Bram Tobin');
      await sleep(1000);
      await bram.say('Tobin, the diamonds are buried under the big oak by the lake.');
      await waitFor(() => agent.store.state.workmem.some((w) => w.source === 'told_by:Bram' && /diamonds/.test(w.text)), 15_000, 'the fact on his mind');
      await waitFor(() => tobinSaid.length > 0, 30_000, 'a reply');
      // A busy stretch: enough new things on his mind that the fact drops out of working memory into SQLite.
      for (const note of ['the oak bark felt rough today', 'a cow wandered past the field', 'my sticks are running low', 'clouds over the plains', 'stone is slow to dig by hand', 'I nearly tripped in a hole']) {
        pushWorkmem(agent.store, note, 0.3, 'self_observed');
        await sleep(200);
      }
      expect(agent.store.state.workmem.some((w) => /diamonds/.test(w.text))).toBe(false);
      await waitFor(() => db.list().some((r) => /diamonds/.test(r.text) && r.source === 'told_by:Bram'), 20_000, 'the fact stored as hearsay');
      const stored = db.list().find((r) => /diamonds/.test(r.text));
      expect(stored?.confidence).toBeCloseTo(0.4, 5);
      // Bram leaves; the conversation ends, so the question comes later, in a new one.
      await server.cmd(`tp Bram ${x - 26} ${Y} ${z + 26}`);
      await waitFor(() => Object.values(agent.store.state.conversations).every((c) => c.status !== 'active'), 60_000, 'the conversation to end', 500);
      await sleep(3000);
      await server.cmd('tp Bram Tobin');
      await sleep(1000);
      const before = tobinSaid.length;
      await bram.say('Tobin, do you remember where the diamonds are?');
      await waitFor(() => tobinSaid.length > before && tobinSaid.slice(before).some((t) => /big oak/.test(t)), 30_000, 'the fact repeated');
    } finally {
      console.log(`[m4 told] Tobin said: ${tobinSaid.join(' | ')}`);
      console.log(`[m4 told] last talk prompt: ${JSON.stringify(talkPrompts.at(-1) ?? '')}`);
      await agent.stop();
      db.close();
      await body.disconnect();
      await bram.disconnect();
      rt.stop();
    }
    // The answer came from memory: the new conversation's transcript doesn't hold the told line.
    const answer = talkPrompts.find((t) => /diamonds are buried/.test(t) && /Reply to: Bram: "Tobin, do you remember/.test(t)) ?? '';
    expect(answer).toContain('(heard from Bram, unverified)');
    expect(answer.split('Conversation so far:')[1] ?? '').not.toContain('diamonds are buried');
    expect(goalCalls).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it('code-only: works through a plan up to an iron pickaxe, then makes her own; visible quirks', async () => {
    const x = 600;
    const z = 0;
    await village(x, z, 44);
    const db = new MemoryDB(path.join(memDir, 'Pip.sqlite'));
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const bram = await Body.connect({ host: server.host, port: server.port, username: 'Bram', version: versions.minecraft.version, logger });
    await server.cmd('gamemode creative Bram');
    await server.cmd(`tp Pip ${x} ${Y} ${z}`);
    await sleep(1500);
    const pipSaid: string[] = [];
    bram.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech' && p.speaker === 'Pip') pipSaid.push(p.text);
    });
    // The village's work, which comes into plans now and then, is M8's test.
    const agent = new Agent({ body, persona: persona('pip'), username: 'Pip', llm: null, logger, world, memory: { db, embedder }, socialGoals: false });
    const decisions: string[] = [];
    agent.bus.on('decision', (e) => decisions.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option} ${JSON.stringify(e.decision.task?.args ?? {})}`));
    const actions: string[] = [];
    agent.bus.on('actionRecorded', (e) => actions.push(`${e.record.skill}${JSON.stringify(e.record.args)}:${e.record.ok ? 'ok' : `FAIL(${e.record.error ?? ''})`}`));
    const started = Date.now();
    agent.start();
    // The plan, given as an operator would (the dashboard's Plan box): the code default's own plans are drawn by
    // chance, so this one is set to test a long chain of real work.
    const given = await debugOp(agent, 'plan', {
      aim: 'an iron pickaxe',
      steps: [
        { text: 'make a wooden pickaxe', doneWhen: 'inventoryHas:wooden_pickaxe>=1' },
        { text: 'make a stone pickaxe', doneWhen: 'inventoryHas:stone_pickaxe>=1' },
        { text: 'make a furnace', doneWhen: 'inventoryHas:furnace>=1' },
        { text: 'make an iron pickaxe', doneWhen: 'inventoryHas:iron_pickaxe>=1' },
      ],
    });
    expect(given.ok).toBe(true);
    // Bram keeps her company, floating just above her (creative), so there is someone to hum to.
    const company = setInterval(() => void server.cmd('execute at Pip run tp Bram ~ ~3 ~').catch(() => undefined), 15_000);
    try {
      await waitFor(
        () => agent.store.state.goals.history.some((g) => g.doneWhen === 'inventoryHas:iron_pickaxe>=1' && g.status === 'done'),
        25 * 60_000,
        'the iron pickaxe goal done',
        2000,
      );
      // The plan done, she makes one of her own (the code default's, drawn from her needs and leanings).
      await waitFor(() => agent.store.state.goals.plan?.source === 'default', 30_000, 'a plan of her own');
    } finally {
      clearInterval(company);
      const goals = agent.store.state.goals.history.map((g) => `${g.text}:${g.status}`);
      console.log(`[m4 chain] ${Math.round((Date.now() - started) / 1000)} s; goals: ${goals.join(' → ')}; plan now: ${JSON.stringify(agent.store.state.goals.plan?.aim ?? null)}`);
      console.log(`[m4 chain] decisions (${decisions.length}): ${decisions.join(' | ')}`);
      console.log(`[m4 chain] actions (${actions.length}): ${actions.join(', ')}`);
      console.log(`[m4 chain] Pip said: ${pipSaid.join(' | ')}; poppies: ${countItem(body.bot, 'poppy')}; memories: ${db.count('recent')} recent, ${db.count('long')} long`);
      await agent.stop();
      db.close();
      await body.disconnect();
      await bram.disconnect();
    }
    const done = agent.store.state.goals.history.filter((g) => g.status === 'done').map((g) => g.doneWhen);
    expect(done).toEqual(['inventoryHas:wooden_pickaxe>=1', 'inventoryHas:stone_pickaxe>=1', 'inventoryHas:furnace>=1', 'inventoryHas:iron_pickaxe>=1']);
    expect(decisions.every((d) => d.startsWith('default:') || d.startsWith('impulse:'))).toBe(true);
    // Quirks: flowers picked on the way, and humming for company.
    expect(countItem(body.bot, 'poppy')).toBeGreaterThanOrEqual(1);
    expect(pipSaid.some((t) => t.includes('*hums*'))).toBe(true);
    // No loops (§13 rule 6): nothing repeats back to back more than a few times.
    let run = 1;
    for (let i = 1; i < actions.length; i++) {
      run = actions[i] === actions[i - 1] ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(4);
    }
  }, 27 * 60_000);
});
