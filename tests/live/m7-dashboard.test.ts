// M7 exit test (§10: "you can see why each bot did what it did") on a real server: the Hub, the dashboard and two
// code-only agents as in production (the supervisor's bots run in-process here, as in M6 H). Through the dashboard's
// HTTP API: each agent's decisions with the reason for each and what came of them, the chat, who thinks what of
// whom; the page itself loads. `pnpm ctl`'s endpoint takes status, say, save and population with the token only.
// The telemetry seen is written to data/live-test/m7/telemetry.jsonl, to render the page from it afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HubConfigSchema, type Logger, ModelsConfigSchema, PersonaSchema, SeededRandom, SexDifferencesSchema, WorldConfigSchema, agentDbPath, configDir, createLogger, dataPaths, ensureDataDirs, loadPersonaPool, loadVersionsConfig } from '@agora/shared';
import { DashboardModel, DashboardServer, Hub, type Launcher, Supervisor, attachDashboard, controlHandler, loadRoster } from '@agora/hub';
import { MemoryDB } from '@agora/agent/memory/db';
import { type RunningBot, runBot } from '@agora/agent/hub/runtime';
import { createInitialState } from '@agora/agent/state/initial';
import { restoreSnapshot } from '@agora/agent/state/snapshot';
import { AgentStateStore } from '@agora/agent/state/store';
import { createExport, extractExport } from '../../scripts/lib/archive';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = -60;
const PORT = 25578;
const TOKEN = 'live-ctl-token';

describe.skipIf(!liveJavaPath())('M7 live: the dashboard and ctl', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm7', port: PORT, rconPort: 25588 });
    logger = createLogger({ name: 'm7-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('shows what each agent decided and why, and what came of it; ctl works with the token only', async () => {
    const x = 400;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    for (const [dx, dz] of [
      [6, 4],
      [-5, 6],
      [7, -6],
    ]) {
      await server.cmd(`place feature minecraft:oak ${x + (dx ?? 0)} ${Y} ${dz ?? 0}`);
    }
    await server.cmd(`setworldspawn ${x} ${Y} 0`);
    await server.cmd('gamerule respawn_radius 0');
    const dataDir = path.join(server.dir, '..', 'data-m7');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(dataDir));
    const hub = new Hub({ config: HubConfigSchema.parse({}), logger, embedder: null });
    await hub.listen(0);
    const captured = fs.createWriteStream(path.join(server.dir, '..', 'telemetry.jsonl'));
    hub.on('telemetry', (s, m) => void captured.write(`${JSON.stringify({ agent: s.username, at: Date.now(), ...m })}\n`));
    const w = WorldConfigSchema.parse({ population: { initial: 2, minAlive: 1, maxAlive: 4, spawnStaggerSec: 1, respawnDelaySec: 5, spawnRadius: 0 }, server: { host: '127.0.0.1', port: PORT } });
    const bots = new Map<string, RunningBot>();
    const launcher: Launcher = (slot) => {
      let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
      let running: RunningBot | null = null;
      void runBot({ hubUrl: `ws://127.0.0.1:${hub.port}`, slot, paths, world: w, versions, models: ModelsConfigSchema.parse({}), apiKey: '', logger }).then((b) => {
        running = b;
        bots.set(b.username, b);
        void b.done.then(() => exit?.(0, null));
      });
      return { slot, pid: undefined, kill: () => void running?.stop('killed'), onExit: (cb) => (exit = cb) };
    };
    const pool = loadPersonaPool().filter((p) => ['pip', 'bram'].includes(p.id ?? ''));
    const sup = new Supervisor({ hub, paths, world: w, sexDiffs: SexDifferencesSchema.parse({}), pool, launcher, logger, rng: new SeededRandom(7), rcon: (c) => server.cmd(c) });
    const model = new DashboardModel({ mode: () => 'test', quota: () => null, personas: () => sup.rosterSnapshot.agents.map((a) => ({ username: a.username, traits: a.persona.traits, sex: a.persona.sex, status: a.status })) });
    const detach = attachDashboard(hub, model);
    const dash = new DashboardServer({
      model,
      host: '127.0.0.1',
      port: 0,
      logger,
      control: {
        token: TOKEN,
        handle: controlHandler({
          mode: () => 'test',
          startedAt: Date.now(),
          supervisor: sup,
          online: () => new Set(hub.list().map((s) => s.username).filter((n): n is string => Boolean(n))),
          snapshotAll: () => hub.snapshotAll(),
          rcon: (c) => server.cmd(c),
          serverState: () => 'running',
          quota: () => null,
          dashboardUrl: '',
          setMode: async () => ({ ok: false, message: 'not in this test' }),
          stop: () => undefined,
          restart: () => undefined,
        }),
      },
    });
    await dash.listen(0);
    const base = `http://127.0.0.1:${dash.port}`;
    const get = async <T>(p: string): Promise<T> => (await (await fetch(`${base}${p}`)).json()) as T;
    const ctl = async (cmd: string, args: string[] = [], token = TOKEN) => {
      const r = await fetch(`${base}/api/ctl`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ cmd, args }) });
      return { status: r.status, body: (await r.json()) as { ok: boolean; message: string; data?: { living?: { username: string; online: boolean }[] } } };
    };
    type Summary = { name: string; online: boolean; goal: string | null; lastDecision: { rationale: string; source: string } | null };
    type Detail = { decisions: { rationale: string; option: string; source: string }[]; actions: { kind: string; skill?: string; ok?: boolean; observed?: string; reason?: string }[] };
    try {
      await sup.start();
      await waitFor(() => (model.overview() as { online: number }).online === 2, 120_000, 'two agents on the dashboard', 500);
      const names = (model.overview() as { agents: Summary[] }).agents.map((a) => a.name);
      // Each one has decided something, with a reason, and something has come of it.
      await waitFor(
        () =>
          names.every((n) => {
            const d = model.agent(n) as unknown as Detail | null;
            return d && d.decisions.some((x) => x.rationale.length > 0) && d.actions.length > 0;
          }),
        180_000,
        'decisions with reasons and their outcomes',
        1000,
      );
      const o = await get<{ agents: Summary[] }>('/api/overview');
      for (const a of o.agents) {
        const d = await get<Detail>(`/api/agents/${a.name}`);
        console.log(`[m7] ${a.name}: goal "${a.goal ?? '-'}"; why: ${d.decisions.slice(0, 3).map((x) => `[${x.source}] ${x.rationale}`).join(' | ')}; did: ${d.actions.slice(0, 3).map((x) => (x.kind === 'option' ? `ended ${x.reason ?? ''}` : `${x.skill ?? ''} ${x.ok ? 'ok' : 'failed'}: ${x.observed ?? ''}`)).join(' | ')}`);
        expect(a.lastDecision?.rationale.length ?? 0).toBeGreaterThan(0);
        expect(d.decisions[0]?.rationale.length ?? 0).toBeGreaterThan(0);
        expect(d.actions.length).toBeGreaterThan(0);
      }
      // The page and its script.
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect((await fetch(`${base}/app.js`)).status).toBe(200);
      // Social: they spawned together, so each has a first impression of the other.
      await waitFor(() => model.social().cells.length >= 2, 60_000, 'first impressions on the dashboard', 1000);
      // ctl: wrong token refused; status, say and save work; population 1 retires one agent.
      expect((await ctl('status', [], 'nope')).status).toBe(401);
      const st = await ctl('status');
      expect(st.body.data?.living?.length).toBe(2);
      expect((await ctl('say', ['hello from the operator'])).body.ok).toBe(true);
      const saved = await ctl('save');
      console.log(`[m7] save: ${saved.body.message}`);
      expect(saved.body.message).toMatch(/2 agent snapshots written/);
      // A hot export right after the save carries both agents, their memories and snapshots (§23.4).
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-m7-export-'));
      try {
        const out = path.join(tmp, 'export.tar.gz');
        await createExport({ dataDir, configDir: configDir(), out });
        const restored = path.join(tmp, 'restored');
        await extractExport({ file: out, dataDir: restored, configDir: path.join(tmp, 'config') });
        const roster = loadRoster(dataPaths(restored).roster);
        const alive = roster.agents.filter((a) => a.status === 'alive');
        expect(alive.map((a) => a.username).sort()).toEqual([...names].sort());
        for (const a of alive) {
          const db = new MemoryDB(agentDbPath(dataPaths(restored), a.username));
          const store = new AgentStateStore(createInitialState({ persona: PersonaSchema.parse(a.persona), username: a.username, now: 0 }));
          expect(restoreSnapshot(db, store), `${a.username}'s snapshot`).not.toBeNull();
          db.close();
        }
        console.log(`[m7] export: ${fs.statSync(out).size} bytes, ${alive.length} agents restored with snapshots`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      expect((await ctl('rcon', ['op', names[0] ?? ''])).body.ok).toBe(false);
      expect((await ctl('population', ['1'])).body.message).toBe('population target is now 1');
      await waitFor(() => (model.overview() as { online: number }).online === 1, 60_000, 'one agent retired', 500);
      const ev = (model.overview() as { events: { what: string; agent?: string }[] }).events.map((e) => `${e.agent ?? ''} ${e.what}`);
      console.log(`[m7] events: ${ev.slice(0, 8).join(', ')}`);
      expect(ev.some((e) => e.endsWith(' left'))).toBe(true);
    } finally {
      await sup.shutdown('test done', 30_000);
      await dash.close();
      detach();
      await hub.close();
      captured.end();
    }
  }, 600_000);
});
