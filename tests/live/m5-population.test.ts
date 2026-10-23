// M5 exit test (§10, §16.4, §23.4): a population on a real server, run by the Hub and the supervisor.
//   1. Real processes: the supervisor launches two bot processes (code-only: no key here) that join through the Hub,
//      take their personas and play. A graceful shutdown writes each bot's snapshot and roster.json, and a second
//      start resumes the same agents with their memories.
//   2. Two agents meet and talk over proximity chat, thinking through the Hub (rate tokens, budgets, the shared
//      embedder) with a scripted model. The conversation ends by itself (repetition or turn cap) and nothing loops.
//   3. Scenario C (group chat): a question to everyone gets one answer, not one from each listener.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubConfigSchema,
  type Logger,
  ModelsConfigSchema,
  type Persona,
  PersonaSchema,
  SeededRandom,
  SexDifferencesSchema,
  WorldConfigSchema,
  agentDbPath,
  createLogger,
  dataPaths,
  ensureDataDirs,
  loadPersonaPool,
  loadVersionsConfig,
  parseProximityLine,
  repoRoot,
  sleep,
} from '@agora/shared';
import { type Embedder, type QuotaStatus, createEmbedder } from '@agora/llm';
import { Hub, type Launcher, Supervisor, loadRoster, nodeLauncher } from '@agora/hub';
import { Body } from '@agora/agent/body/body';
import { MemoryDB } from '@agora/agent/memory/db';
import { type RunningBot, runBot } from '@agora/agent/hub/runtime';
import { statedWork } from '@agora/agent/social/roles';
import { FakeNanoGpt, standardModels, schemaNameOf } from '../llm/fakeNanoGpt';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const PORT = 25571;
const Y = -60;
const OPEN_QUOTA: QuotaStatus = { level: 0, codeOnly: false, reason: 'test', resetAt: Date.now() + 100 * 3_600_000, weeklyPercent: 0.1, dailyPercent: null, remaining: 50_000_000, unknown: false, polledAt: Date.now() };

describe.skipIf(!liveJavaPath())('M5 live: a population through the Hub', () => {
  let server: LiveServer;
  let logger: Logger;
  let embedder: Embedder;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm5', port: PORT, rconPort: 25581 });
    logger = createLogger({ name: 'm5-live', logDir: path.join(server.dir, '..', 'test-logs'), console: false });
    embedder = await createEmbedder({ modelDir: path.join(dataPaths().cache, 'models'), modelId: versions.embeddingModel.id, dims: versions.embeddingModel.dims, logger });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', `setworldspawn 0 ${Y} 0`]) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  function world(initial: number) {
    return WorldConfigSchema.parse({
      population: { initial, minAlive: initial, maxAlive: initial + 2, spawnStaggerSec: 2, respawnDelaySec: 5, spawnRadius: 0 },
      server: { host: '127.0.0.1', port: PORT },
    });
  }

  async function hub(quota: QuotaStatus | null): Promise<Hub> {
    const h = new Hub({ config: HubConfigSchema.parse({}), logger, embedder, quota: () => quota, runtimeHoursPerWeek: 30 });
    await h.listen(0);
    h.start();
    return h;
  }

  it('real bot processes join through the Hub, shut down gracefully and resume as the same agents', async () => {
    const dataDir = path.join(server.dir, '..', 'data-procs');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(dataDir));
    const h = await hub(null);
    const launcher = nodeLauncher({
      entry: path.join(repoRoot(), 'packages', 'agent', 'src', 'main.ts'),
      cwd: repoRoot(),
      hubUrl: `ws://127.0.0.1:${h.port}`,
      logDir: path.join(paths.logs, 'bots'),
      env: { DATA_DIR: dataDir, AGORA_MC_PORT: String(PORT), NANOGPT_API_KEY: '' },
    });
    const pool = loadPersonaPool().filter((p) => ['pip', 'bram'].includes(p.id ?? ''));
    // §23.5: measure what a bot process costs.
    const pids: number[] = [];
    const counted: Launcher = (slot) => {
      const proc = launcher(slot);
      if (proc.pid) pids.push(proc.pid);
      return proc;
    };
    const rssMb = (pid: number) => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024;
    const mk = () => new Supervisor({ hub: h, paths, world: world(2), sexDiffs: SexDifferencesSchema.parse({}), pool, launcher: counted, logger, rng: new SeededRandom(2), rcon: (c) => server.cmd(c) });
    const ready = new Set<string>();
    h.on('ready', (_s, name) => ready.add(name));
    try {
      const sup = mk();
      await sup.start();
      await waitFor(() => ready.size === 2, 120_000, 'two bots ready', 500);
      expect([...ready].sort()).toEqual(['Bram', 'Pip']);
      const list = await server.cmd('list');
      expect(list).toMatch(/Pip/);
      expect(list).toMatch(/Bram/);
      await sleep(20_000);
      if (process.platform === 'linux') console.log(`[m5 procs] bot RSS: ${pids.map((p) => `${rssMb(p).toFixed(0)} MB`).join(', ')}`);
      await sup.shutdown('test shutdown', 60_000);
      for (const name of ['Pip', 'Bram']) {
        const db = new MemoryDB(agentDbPath(paths, name));
        const snap = db.getKV('stateSnapshot');
        db.close();
        expect(snap, `${name} wrote a snapshot`).not.toBeNull();
      }
      const roster = loadRoster(paths.roster);
      expect(roster.agents.filter((a) => a.status === 'alive').map((a) => a.username).sort()).toEqual(['Bram', 'Pip']);
      for (let i = 0; i < 60 && /Pip|Bram/.test(await server.cmd('list')); i++) await sleep(500);
      expect(await server.cmd('list')).not.toMatch(/Pip|Bram/);

      ready.clear();
      const sup2 = mk();
      await sup2.start();
      await waitFor(() => ready.size === 2, 120_000, 'the same two bots back', 500);
      expect([...ready].sort()).toEqual(['Bram', 'Pip']);
      await sleep(3000);
      const log = fs.readFileSync(path.join(paths.logs, 'agents', 'agent-Pip.log'), 'utf8');
      expect(log).toMatch(/"msg":"resumed"/);
      await sup2.shutdown('test done', 60_000);
    } finally {
      await h.close();
    }
  }, 420_000);

  /** In-process bots under the supervisor, thinking through the Hub with a scripted model. */
  function inProcess(h: Hub, dataDir: string, fake: FakeNanoGpt, bots: Map<string, RunningBot>): Launcher {
    const paths = ensureDataDirs(dataPaths(dataDir));
    return (slot) => {
      let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
      let running: RunningBot | null = null;
      void runBot({
        hubUrl: `ws://127.0.0.1:${h.port}`,
        slot,
        paths,
        world: world(2),
        versions,
        models: ModelsConfigSchema.parse({}),
        apiKey: 'scripted',
        fetch: fake.fetch,
        logger,
      }).then((b) => {
        running = b;
        bots.set(b.username, b);
        void b.done.then(() => exit?.(0, null));
      });
      return { slot, pid: undefined, kill: () => void running?.stop('killed'), onExit: (cb) => (exit = cb) };
    };
  }

  const chatter = (name: string, sex: 'male' | 'female', extraversion: number): Persona =>
    PersonaSchema.parse({ id: name.toLowerCase(), name, sex, traits: ['friendly'], big5: { extraversion }, social: { initiateChance: 0.9 } });

  it('two agents meet and talk through the Hub; the conversation ends by itself and nothing loops', async () => {
    const dataDir = path.join(server.dir, '..', 'data-talk');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(dataDir));
    const h = await hub(OPEN_QUOTA);
    const fake = new FakeNanoGpt(standardModels());
    const talkLines: Record<string, string[]> = {
      Juno: ['hi! nice day for it', 'I was looking for sheep around here', 'have you seen any?', 'I might try the hills', 'well, good luck to you'],
      Rook: ['hey there', 'no sheep on my side, sorry', 'the hills sound right', 'I am mostly digging stone', 'see you around'],
    };
    const said: Record<string, number> = { Juno: 0, Rook: 0 };
    const talked = new Set<string>();
    fake.chat = ({ body }) => {
      const messages = body.messages as { role: string; content: string }[];
      const system = messages[0]?.content ?? '';
      const user = messages.at(-1)?.content ?? '';
      const schema = schemaNameOf(body);
      const me = /You are (\w+)/.exec(system)?.[1] ?? /decide what (\w+) does/.exec(system)?.[1] ?? '';
      if (schema === 'summary') return { text: JSON.stringify({ summary: 'I like a chat.' }) };
      if (schema === 'plan') return { text: JSON.stringify({ keep: true }) };
      if (schema === 'addressed') return { text: JSON.stringify({ addressedToMe: false }) };
      if (schema === 'decision') {
        const other = me === 'Juno' ? 'Rook' : 'Juno';
        if (new RegExp(`People near you:.*\\b${other} \\(`).test(user) && !talked.has(me) && !/Doing now: talk/.test(user)) {
          talked.add(me);
          return { text: JSON.stringify({ option: 'talk', target: { agent: other }, speechIntent: { stance: 'chat', gist: 'say hi', mayCommit: false }, terminate: { maxSeconds: 120 }, rationale: `${other} is here` }) };
        }
        return { text: JSON.stringify({ option: 'rest', terminate: { maxSeconds: 30 }, rationale: 'taking it easy' }) };
      }
      // Talking: five fresh lines, then the same one again (repetition ends it).
      const lines = talkLines[me] ?? ['hm'];
      const i = Math.min(said[me] ?? 0, lines.length - 1);
      said[me] = (said[me] ?? 0) + 1;
      return { text: lines[i] ?? 'hm' };
    };
    const bots = new Map<string, RunningBot>();
    const sup = new Supervisor({
      hub: h,
      paths,
      world: world(2),
      sexDiffs: SexDifferencesSchema.parse({}),
      pool: [chatter('Juno', 'female', 0.7), chatter('Rook', 'male', 0.6)],
      launcher: inProcess(h, dataDir, fake, bots),
      logger,
      rng: new SeededRandom(3),
    });
    const ear = await Body.connect({ host: server.host, port: server.port, username: 'Wit', version: versions.minecraft.version, logger });
    const heard: string[] = [];
    ear.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech') heard.push(`${p.speaker}: ${p.text}`);
    });
    try {
      await sup.start();
      await waitFor(() => bots.size === 2, 90_000, 'two agents', 500);
      await server.cmd(`tp Juno 0 ${Y} 0`);
      await server.cmd(`tp Rook 4 ${Y} 0`);
      await server.cmd(`tp Wit 2 ${Y} 6`);
      const ended = () => [...bots.values()].flatMap((b) => Object.values(b.agent.store.state.conversations)).filter((c) => c.status === 'ended');
      await waitFor(() => ended().length >= 2, 180_000, 'both sides to end the conversation', 1000);
      const reasons = ended().map((c) => c.endedReason ?? '');
      console.log(`[m5 talk] heard: ${heard.join(' | ')}`);
      console.log(`[m5 talk] ended: ${reasons.join(', ')}; hub granted ${h.counters.llmGranted} LLM tokens, ${h.counters.speechGranted} speech tokens`);
      expect(reasons.some((r) => ['repetition', 'turn cap', 'partner silent', 'partner left'].includes(r))).toBe(true);
      expect(heard.filter((x) => x.startsWith('Juno:')).length).toBeGreaterThanOrEqual(2);
      expect(heard.filter((x) => x.startsWith('Rook:')).length).toBeGreaterThanOrEqual(2);
      expect(h.counters.llmGranted).toBeGreaterThan(4);
      expect(h.counters.speechGranted).toBeGreaterThanOrEqual(4);
      // No loops: a minute later the pair cooldown holds and nobody keeps talking. (Saying what one does for the
      // village, M8, is no talk with anyone: it is said at a lull, the first one often after the conversation.)
      const at = heard.length;
      await sleep(60_000);
      const after = heard.slice(at);
      console.log(`[m5 talk] a minute after: ${after.join(' | ') || 'nothing'}`);
      expect(after.filter((x) => !statedWork(x.slice(x.indexOf(': ') + 2))).length).toBeLessThanOrEqual(2);
    } finally {
      await sup.shutdown('test done', 30_000);
      await ear.disconnect();
      await h.close();
    }
  }, 420_000);

  it('scenario C (group chat): with three listeners in range, a question gets at most two replies within 5 s', async () => {
    const dataDir = path.join(server.dir, '..', 'data-group');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(dataDir));
    const h = await hub(OPEN_QUOTA);
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = ({ body }) => {
      const messages = body.messages as { role: string; content: string }[];
      const schema = schemaNameOf(body);
      if (schema === 'summary') return { text: JSON.stringify({ summary: 'I keep busy.' }) };
      if (schema === 'plan') return { text: JSON.stringify({ keep: true }) };
      if (schema === 'addressed') return { text: JSON.stringify({ addressedToMe: false }) };
      if (schema === 'decision') return { text: JSON.stringify({ option: 'rest', terminate: { maxSeconds: 60 }, rationale: 'resting' }) };
      return { text: messages.length > 0 ? 'I have a few logs to spare' : 'hm' };
    };
    const bots = new Map<string, RunningBot>();
    const quiet = (name: string, sex: 'male' | 'female') => PersonaSchema.parse({ id: name.toLowerCase(), name, sex, traits: ['helpful'], social: { initiateChance: 0 } });
    const sup = new Supervisor({
      hub: h,
      paths,
      world: world(3),
      sexDiffs: SexDifferencesSchema.parse({}),
      pool: [quiet('Opal', 'female'), quiet('Moss', 'male'), quiet('Kit', 'female')],
      launcher: inProcess(h, dataDir, fake, bots),
      logger,
      rng: new SeededRandom(4),
    });
    const asker = await Body.connect({ host: server.host, port: server.port, username: 'Dara', version: versions.minecraft.version, logger });
    const heard: { who: string; text: string; at: number }[] = [];
    asker.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech') heard.push({ who: p.speaker, text: p.text, at: Date.now() });
    });
    try {
      await sup.start();
      await waitFor(() => bots.size === 3, 120_000, 'three agents', 500);
      await server.cmd(`tp Opal 100 ${Y} 0`);
      await server.cmd(`tp Moss 104 ${Y} 0`);
      await server.cmd(`tp Kit 102 ${Y} -3`);
      await server.cmd(`tp Dara 102 ${Y} 3`);
      await sleep(4000);
      let answers = 0;
      for (const q of ['anyone got some wood?', 'does anybody know where the river is?']) {
        const t0 = Date.now();
        await asker.say(q);
        await sleep(12_000);
        const replies = heard.filter((x) => x.at > t0 && x.who !== 'Dara');
        console.log(`[m5 group] "${q}" → ${replies.map((r) => `${r.who} +${((r.at - t0) / 1000).toFixed(1)}s: ${r.text}`).join(' | ') || 'no answer'}`);
        // §11 C: at most two replies within 5 s (floor control: unaddressed listeners wait and yield), and the
        // group doesn't run away afterwards (each listener chimes in at most once per three lines).
        expect(replies.filter((r) => r.at - t0 <= 5000).length).toBeLessThanOrEqual(2);
        expect(replies.length).toBeLessThanOrEqual(4);
        answers += replies.length;
        await sleep(5000);
      }
      expect(answers).toBeGreaterThanOrEqual(1);
      // The conversations end by themselves (Dara never answers back): within the turn caps or by silence.
      const convs = () => [...bots.values()].flatMap((b) => Object.values(b.agent.store.state.conversations));
      await waitFor(() => convs().length > 0 && convs().every((c) => c.status === 'ended'), 90_000, 'the group conversations to end', 1000);
    } finally {
      await sup.shutdown('test done', 30_000);
      await asker.disconnect();
      await h.close();
    }
  }, 300_000);
});
