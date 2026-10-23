// M10 exit test (§10: "new skill written, verified and reused"; §1.4, §9, §21.1) on a real Paper server. Ada
// (intelligence 0.9, on this private server, the skill writer on) is told by her scripted model to stock up logs with
// a skill she doesn't have. Her CC refuses the decision and wants the skill written; L3 (the same scripted stand-in;
// no key here) writes it from her verified skills; it is tried out at once in the world, its check holds
// (inventoryHas:oak_log>={qty}), and it is kept in her memory database. Later the CC reaches for it again, for more
// logs, and it runs as a skill she has, without being written again.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentEvent, type Logger, ModelsConfigSchema, PersonaSchema, WorldConfigSchema, createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { type Embedder, LocalRateLimiter, startLlm } from '@agora/llm';
import { Agent, MemoryDB } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { countItem } from '@agora/agent/body/inventory';
import { FakeNanoGpt, standardModels, schemaNameOf } from '../llm/fakeNanoGpt';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = -60;
const world = WorldConfigSchema.parse({ skillWriter: { enabled: true } });
const ada = PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['inventive', 'patient'], abilities: { intelligence: 0.9 }, social: { initiateChance: 0 } });
/** The memory database needs an embedder; any fixed vector does here. */
const embedder: Embedder = { dims: 3, model: 'fixed', embed: (texts) => Promise.resolve(texts.map(() => new Float32Array([1, 0, 0]))) };

const SKILL = {
  name: 'stock_up_logs',
  description: 'gathers oak logs until I hold enough',
  args: { qty: 'number' },
  check: 'inventoryHas:oak_log>={qty}',
  code: [
    'const have = api.look().inventory.oak_log || 0;',
    "if (have >= args.qty) return { ok: true, observed: 'already holding ' + have + ' oak_log' };",
    "const r = await api.skill('gather', { item: 'oak_log', qty: args.qty - have });",
    'api.log(r.observed);',
    'return { ok: r.ok, observed: r.observed };',
  ].join('\n'),
};

describe.skipIf(!liveJavaPath())('M10 live: a skill written, verified and reused', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm10', port: 25604, rconPort: 25605 });
    logger = createLogger({ name: 'm10-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('wants a skill it lacks, writes it, tries it in the world, keeps it, and uses it again', async () => {
    const x = 1500;
    const z = 0;
    await server.cmd(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    // A grove of bare oak trunks, two logs high, a few steps away.
    for (const [dx, dz] of [
      [4, 0],
      [5, 3],
      [3, -3],
      [-4, 1],
      [-3, -4],
      [2, 5],
    ] as const) {
      await server.cmd(`fill ${x + dx} ${Y} ${z + dz} ${x + dx} ${Y + 1} ${z + dz} minecraft:oak_log`);
    }
    // The scripted model: the CC first reaches for a skill there is none of, then waits; once the skill is learned,
    // it reaches for it again (for six logs); L3 writes the skill when asked.
    let phase: 'want' | 'wait' | 'reuse' | 'done' = 'want';
    const fake = new FakeNanoGpt(standardModels());
    const decisionSystems: string[] = [];
    fake.chat = ({ body }) => {
      const messages = body.messages as { role: string; content: string }[];
      const schema = schemaNameOf(body);
      const rest = { option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'waiting a bit' };
      switch (schema ?? '') {
        case 'decision': {
          decisionSystems.push(messages[0]?.content ?? '');
          if (phase === 'want') {
            phase = 'wait';
            return { text: JSON.stringify({ option: 'work', task: { skill: 'stock_up_logs', args: { qty: 3 } }, terminate: { maxSeconds: 300 }, rationale: 'I need a few logs put by' }) };
          }
          if (phase === 'reuse') {
            phase = 'done';
            return { text: JSON.stringify({ option: 'work', task: { skill: 'stock_up_logs', args: { qty: 6 } }, terminate: { maxSeconds: 300 }, rationale: 'more logs for the build' }) };
          }
          return { text: JSON.stringify(rest) };
        }
        case 'skill':
          return { text: JSON.stringify({ skill: SKILL }) };
        case 'summary':
          return { text: JSON.stringify({ summary: 'Getting logs together, one way or another.' }) };
        case 'memory':
          return { text: JSON.stringify({ text: messages.at(-1)?.content.split('\n')[0]?.slice(2) || 'worked on logs' }) };
        case 'audit':
          return { text: JSON.stringify({ corrections: [] }) };
        case 'annotation':
          return { text: JSON.stringify({ key: null, annotation: null }) };
        default:
          return { text: JSON.stringify(rest) };
      }
    };
    const rt = await startLlm({ apiKey: 'scripted', config: ModelsConfigSchema.parse({}), logger, fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 50 }) });
    const memDir = path.join(server.dir, '..', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const file = path.join(memDir, 'Ada.sqlite');
    fs.rmSync(file, { force: true });
    const db = new MemoryDB(file);
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger });
    await server.cmd(`tp Ada ${x} ${Y} ${z}`);
    await sleep(1500);
    const agent = new Agent({ body, persona: ada, username: 'Ada', llm: rt.client, logger, world, memory: { db, embedder }, goalGen: false });
    const events: AgentEvent[] = [];
    for (const type of ['skillWanted', 'skillLearned', 'actionRecorded'] as const) agent.bus.on(type, (e: AgentEvent) => events.push(e));
    const runs = () => events.flatMap((e) => (e.type === 'actionRecorded' && e.record.skill === 'stock_up_logs' ? [e.record] : []));
    const writes = () => fake.chatRequests().filter((r) => schemaNameOf(r.body) === 'skill');
    agent.start();
    const t0 = Date.now();
    const at = () => `${Math.round((Date.now() - t0) / 1000)} s`;
    try {
      agent.cc.trigger('the logs are running low', { urgent: true });
      await waitFor(() => events.some((e) => e.type === 'skillWanted' && e.name === 'stock_up_logs'), 60_000, 'the skill wanted');
      console.log(`[m10] ${at()} wanted: stock_up_logs`);
      await waitFor(() => events.some((e) => e.type === 'skillLearned'), 300_000, 'the skill learned', 500);
      const first = runs()[0];
      console.log(`[m10] ${at()} trial: ${first?.ok ? 'ok' : 'FAILED'}, ${first?.observed ?? ''} (${first?.expected ?? ''}); oak_log held: ${countItem(body.bot, 'oak_log')}`);
      // Written once, by L3, and tried in the world: its check held, so it was kept, in her memory database too.
      expect(writes()).toHaveLength(1);
      expect(writes()[0]?.body?.model).toBe('p1-big');
      expect(first).toMatchObject({ ok: true, expected: 'holding 3 oak_log' });
      expect(countItem(body.bot, 'oak_log')).toBeGreaterThanOrEqual(3);
      expect(agent.skills.get('stock_up_logs')).toMatchObject({ uses: 1, successes: 1 });
      expect(db.skills().find((r) => r.name === 'stock_up_logs')?.verified).not.toBeNull();
      expect(agent.store.state.workmem.some((w) => /new skill: stock_up_logs/.test(w.text))).toBe(true);
      // Reused: the CC reaches for it as a skill she has, and it runs again, not written again.
      phase = 'reuse';
      agent.cc.trigger('more logs wanted for the build', { urgent: true });
      await waitFor(() => runs().length >= 2, 300_000, 'the skill used again', 500);
      const again = runs()[1];
      console.log(`[m10] ${at()} reused: ${again?.ok ? 'ok' : 'FAILED'}, ${again?.observed ?? ''}; oak_log held: ${countItem(body.bot, 'oak_log')}`);
      expect(again).toMatchObject({ ok: true, expected: 'holding 6 oak_log' });
      expect(countItem(body.bot, 'oak_log')).toBeGreaterThanOrEqual(6);
      expect(writes()).toHaveLength(1);
      expect(agent.skills.get('stock_up_logs')).toMatchObject({ uses: 2, successes: 2 });
      expect(decisionSystems.at(-1)).toMatch(/- stock_up_logs \{qty: number\} — gathers oak logs until I hold enough \(a skill you wrote\)/);
      expect(decisionSystems[0]).not.toMatch(/stock_up_logs/);
    } finally {
      await agent.stop();
      await body.disconnect();
      rt.stop();
      db.close();
    }
    // Kept for good: the database holds it, verified, with both runs counted.
    const reopened = new MemoryDB(file);
    expect(reopened.skills()).toEqual([expect.objectContaining({ name: 'stock_up_logs', uses: 2, successes: 2, check: 'inventoryHas:oak_log>={qty}' })]);
    reopened.close();
  }, 900_000);
});
