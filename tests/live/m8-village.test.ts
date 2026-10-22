// M8 exit test (§10: "roles diverge in a 5-bot village over 60 min") on a real server, plus the notice board.
//   NB  the notice board (§6.8, §16.3): Ann sees Bodo die in lava by the village and posts it on a sign at the board;
//       Cyrus, who arrives later and never heard of it, reads the sign: it goes on his mind, and he grows more careful.
//   V   the village: five code-only agents (real bot processes, as in production) live together at the world spawn
//       with trees (and a wood farther out), a stone outcrop, animals and ore farther out, on ground above the
//       slime-chunk depth as on ordinary terrain; days and nights pass, with monsters at night. What each one takes
//       on for the village comes from what it sees: the village's needs, its own likings and who is already doing
//       what. The roles, read from each agent's last five social goals, must diverge: at least three
//       different roles among those with one, and the village shows the work. The run is 60 minutes
//       (AGORA_M8_MINUTES shortens it for a quick look); the timeline prints at the end.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubConfigSchema,
  type Logger,
  SeededRandom,
  SexDifferencesSchema,
  WorldConfigSchema,
  createLogger,
  dataPaths,
  ensureDataDirs,
  loadPersonaPool,
  loadVersionsConfig,
  repoRoot,
  sleep,
} from '@agora/shared';
import { type Embedder, createEmbedder } from '@agora/llm';
import { Hub, Supervisor, nodeLauncher } from '@agora/hub';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { roleEntropy } from '@agora/agent/social/village';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const PORT = 25590;
// The ground stands above the slime-chunk depth, as on ordinary terrain (no slimes by day).
const Y = DEEP_GROUND_Y;
const MINUTES = Number(process.env.AGORA_M8_MINUTES ?? 60);
const pool = loadPersonaPool();
const persona = (id: string) => {
  const p = pool.find((x) => x.id === id);
  if (!p) throw new Error(`no persona ${id}`);
  return p;
};

describe.skipIf(!liveJavaPath())('M8 live: social goals, roles and the notice board', () => {
  let server: LiveServer;
  let logger: Logger;
  let embedder: Embedder;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm8', port: PORT, rconPort: 25591, deepGround: true });
    logger = createLogger({ name: 'm8-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    // The bots' memories embed through the Hub, as in production.
    embedder = await createEmbedder({ modelDir: path.join(dataPaths().cache, 'models'), modelId: versions.embeddingModel.id, dims: versions.embeddingModel.dims, logger });
    for (const c of ['gamerule advance_weather false', 'weather clear', 'gamerule spawn_radius 0']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('NB: a death seen by the village goes on the board, and a newcomer learns of it from the sign', async () => {
    const x = 600;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    for (const c of ['gamerule advance_time false', 'time set 1000', `setworldspawn ${x} ${Y} 0`]) await server.cmd(c);
    // A lava pit a few steps from the village center.
    await server.cmd(`fill ${x + 5} ${Y - 2} 3 ${x + 6} ${Y - 1} 4 minecraft:lava`);
    const world = WorldConfigSchema.parse({ server: { host: '127.0.0.1', port: PORT } });
    const annBody = await Body.connect({ host: server.host, port: server.port, username: 'Ann', version: versions.minecraft.version, logger });
    const bodo = await Body.connect({ host: server.host, port: server.port, username: 'Bodo', version: versions.minecraft.version, logger });
    await server.cmd('give Ann minecraft:oak_sign 2');
    await sleep(1500);
    const ann = new Agent({ body: annBody, persona: persona('mira'), username: 'Ann', llm: null, logger, world, goalGen: false });
    ann.start();
    let cyrus: Agent | null = null;
    let cyBody: Body | null = null;
    try {
      await sleep(3000);
      // Bodo walks into the lava in front of Ann.
      await server.cmd(`tp Bodo ${x + 5.5} ${Y - 1} 3.5`);
      await waitFor(() => ann.store.state.perception.systemEvents.some((e) => e.kind === 'death' && e.subject === 'Bodo'), 30_000, "Bodo's death notice", 250);
      const death = ann.store.state.perception.systemEvents.find((e) => e.subject === 'Bodo');
      console.log(`[m8 NB] Ann heard: ${death?.text}; saw it: ${ann.perception.saw('Bodo', 'death', 60_000)}`);
      await bodo.disconnect();
      // Ann posts it at the board.
      const posted = await waitFor(() => ann.store.state.actionLog.find((a) => a.skill === 'sign' && a.ok), 90_000, 'a notice posted', 500);
      console.log(`[m8 NB] Ann: ${posted.observed}`);
      expect(String(posted.args.text)).toMatch(/^Bodo /);
      // Cyrus arrives later, knowing nothing of it.
      cyBody = await Body.connect({ host: server.host, port: server.port, username: 'Cyrus', version: versions.minecraft.version, logger });
      cyrus = new Agent({ body: cyBody, persona: persona('tobin'), username: 'Cyrus', llm: null, logger, world, goalGen: false });
      const before = cyrus.store.state.drives.caution;
      cyrus.start();
      const c = cyrus;
      const learned = await waitFor(() => c.store.state.workmem.find((w) => /a sign at the village board says "Bodo /.test(w.text)), 60_000, 'Cyrus reads the board', 250);
      console.log(`[m8 NB] Cyrus: ${learned.text}; caution ${before} → ${c.store.state.drives.caution}`);
      expect(learned.source).toBe('self_observed');
      expect(c.store.state.drives.caution).toBeGreaterThan(before);
      // The sign is the only way Cyrus could know: the death notice went out before Cyrus arrived.
      expect(c.store.state.perception.systemEvents.some((e) => e.subject === 'Bodo')).toBe(false);
      expect(c.store.state.village.board).not.toBeNull();
    } finally {
      await cyrus?.stop();
      await cyBody?.disconnect();
      await ann.stop();
      await annBody.disconnect();
    }
  }, 300_000);

  it(`V: in a five-agent village the roles diverge (${MINUTES} min)`, async () => {
    const x = 1600;
    const r = (n: number) => Math.round(n);
    await server.cmd(`forceload add ${x - 64} -64 ${x + 64} 64`);
    for (const c of ['time set 1000', 'gamerule advance_time true', 'gamerule spawn_monsters true', 'difficulty hard', `setworldspawn ${x} ${Y} 0`]) await server.cmd(c);
    // Trees around the village, a stone outcrop with some coal and iron, animals, and iron ore farther out.
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const d = 9 + (i % 4) * 5;
      await server.cmd(`place feature minecraft:oak ${r(x + Math.cos(a) * d)} ${Y} ${r(Math.sin(a) * d)}`);
    }
    // And a wood farther out, for when those are gone.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + 0.13;
      const d = 36 + (i % 5) * 6;
      await server.cmd(`place feature minecraft:oak ${r(x + Math.cos(a) * d)} ${Y} ${r(Math.sin(a) * d)}`);
    }
    await server.cmd(`fill ${x - 30} ${Y} -6 ${x - 22} ${Y + 2} 2 minecraft:stone`);
    for (const [dx, dz] of [[-24, -2], [-27, 0], [-29, -4]]) await server.cmd(`setblock ${x + (dx ?? 0)} ${Y + 2} ${dz ?? 0} minecraft:coal_ore`);
    await server.cmd(`setblock ${x - 25} ${Y + 1} 2 minecraft:iron_ore`);
    for (const [dx, dz] of [[40, 30], [41, 31], [40, 32]]) await server.cmd(`setblock ${x + (dx ?? 0)} ${Y} ${dz ?? 0} minecraft:iron_ore`);
    for (const [kind, n] of [['cow', 5], ['sheep', 4], ['pig', 4], ['chicken', 4]] as const) {
      for (let i = 0; i < n; i++) await server.cmd(`summon minecraft:${kind} ${x + 12 + i * 3} ${Y} ${-14 + (kind.length % 3) * 9} {PersistenceRequired:1b}`);
    }
    const dataDir = path.join(server.dir, '..', 'data-village');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(dataDir));
    const hub = new Hub({ config: HubConfigSchema.parse({}), logger, embedder, quota: () => null, runtimeHoursPerWeek: 30 });
    await hub.listen(0);
    hub.start();
    // What each agent reports to the dashboard (M7): its role, its part in the village, what it did.
    type Seen = { role: string | null; village: string[]; goal: string | null; isDay: boolean; at: number };
    const latest = new Map<string, Seen>();
    const timeline = new Map<string, (string | null)[]>();
    const work: { agent: string; skill: string; ok: boolean; observed: string }[] = [];
    const captured = fs.createWriteStream(path.join(server.dir, '..', 'village-telemetry.jsonl'));
    hub.on('telemetry', (s, m) => {
      const name = s.username;
      if (!name || m.t !== 'telemetry') return;
      captured.write(`${JSON.stringify({ agent: name, at: Date.now(), ...m })}\n`);
      const d = m.data;
      if (m.kind === 'state') latest.set(name, { role: (d.role as string | null) ?? null, village: (d.village as string[] | undefined) ?? [], goal: (d.goal as string | null) ?? null, isDay: d.isDay !== false, at: Date.now() });
      if (m.kind === 'skill' && ['deposit', 'build', 'patrol', 'attack', 'hunt', 'sign', 'give'].includes(String(d.skill))) work.push({ agent: name, skill: String(d.skill), ok: Boolean(d.ok), observed: String(d.observed) });
    });
    const w = WorldConfigSchema.parse({
      population: { initial: 5, minAlive: 5, maxAlive: 6, spawnStaggerSec: 3, respawnDelaySec: 30, spawnRadius: 0, starterKit: 'persona' },
      server: { host: '127.0.0.1', port: PORT },
    });
    const launcher = nodeLauncher({
      entry: path.join(repoRoot(), 'packages', 'agent', 'src', 'main.ts'),
      cwd: repoRoot(),
      hubUrl: `ws://127.0.0.1:${hub.port}`,
      logDir: path.join(paths.logs, 'bots'),
      env: { DATA_DIR: dataDir, AGORA_MC_PORT: String(PORT), NANOGPT_API_KEY: '' },
    });
    const five = pool.filter((p) => ['pip', 'bram', 'mira', 'wren', 'oswin'].includes(p.id ?? ''));
    const sup = new Supervisor({ hub, paths, world: w, sexDiffs: SexDifferencesSchema.parse({}), pool: five, launcher, logger, rng: new SeededRandom(8), rcon: (c) => server.cmd(c) });
    const t0 = Date.now();
    const living = () => new Set(hub.list().map((s) => s.username).filter((n): n is string => Boolean(n)));
    const joinedAt = new Map<string, number>();
    hub.on('ready', (_s, name) => joinedAt.set(name, Date.now()));
    try {
      await sup.start();
      await waitFor(() => living().size === 5, 180_000, 'five agents in the village', 1000);
      const end = t0 + MINUTES * 60_000;
      let minute = 0;
      while (Date.now() < end) {
        await sleep(Math.min(60_000, end - Date.now()));
        minute++;
        for (const name of living()) {
          const tl = timeline.get(name) ?? [];
          tl.push(latest.get(name)?.role ?? null);
          timeline.set(name, tl);
        }
        if (minute % 5 === 0) {
          const now = [...living()].map((n) => `${n}: ${latest.get(n)?.role ?? '-'} (${latest.get(n)?.goal ?? 'no goal'})`);
          const day = [...latest.values()].some((x) => x.isDay);
          console.log(`[m8 V] ${minute} min (${day ? 'day' : 'night'}): ${now.join('; ')}`);
        }
      }
      const names = [...living()];
      const roles = names.map((n) => latest.get(n)?.role ?? null);
      // Those who have lived in the village a while (a newcomer hasn't settled on anything yet).
      const settled = names.filter((n) => Date.now() - (joinedAt.get(n) ?? 0) >= 10 * 60_000);
      const settledRoles = settled.map((n) => latest.get(n)?.role ?? null);
      const entropy = roleEntropy(settledRoles);
      const ok = work.filter((x) => x.ok);
      const tally = (skill: string) => ok.filter((x) => x.skill === skill).length;
      console.log(`[m8 V] after ${MINUTES} min: ${names.map((n, i) => `${n} ${roles[i] ?? '-'}${settled.includes(n) ? '' : ' (new)'}`).join(', ')}; role entropy among the settled ${entropy} bits`);
      for (const [n, tl] of timeline) console.log(`[m8 V] ${n}: ${tl.map((x) => x ?? '-').join(' ')}`);
      console.log(`[m8 V] work done: ${['deposit', 'build', 'patrol', 'attack', 'hunt', 'sign', 'give'].map((k) => `${k} ${tally(k)}`).join(', ')}`);
      console.log(`[m8 V] deposits: ${ok.filter((x) => x.skill === 'deposit').slice(-6).map((x) => `${x.agent}: ${x.observed}`).join(' | ')}`);
      console.log(`[m8 V] deaths: ${sup.rosterSnapshot.agents.filter((a) => a.status === 'dead').map((a) => `${a.username} (${a.cause ?? '?'})`).join(', ') || 'none'}`);
      // Roles diverge: those who have lived here a while each have one, and they are not all the same.
      expect(settled.length).toBeGreaterThanOrEqual(3);
      expect(settledRoles.filter(Boolean).length).toBeGreaterThanOrEqual(Math.ceil(settled.length * 0.8));
      expect(new Set(settledRoles.filter(Boolean)).size).toBeGreaterThanOrEqual(3);
      expect(entropy).toBeGreaterThanOrEqual(1.3);
      // The village shows the work: goods handed in, and at least one other kind of village work done.
      expect(tally('deposit')).toBeGreaterThanOrEqual(2);
      expect(['build', 'patrol', 'hunt', 'sign'].filter((k) => tally(k) > 0).length).toBeGreaterThanOrEqual(1);
    } finally {
      await sup.shutdown('test done', 60_000);
      await hub.close();
      captured.end();
    }
  }, (MINUTES + 15) * 60_000);
});
