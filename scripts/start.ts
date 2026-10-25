// `pnpm start` (§23.2): one supervisor process runs the Minecraft server (a child process), the Hub, the dashboard
// and one process per bot. Ctrl+C or SIGTERM shuts down gracefully (§23.4): bots flush their memory and write
// snapshots, the server saves and stops, roster.json is written. The next `pnpm start` resumes the same agents.
// `pnpm ctl restart` does the same and starts again: in this process when run by hand, or by exiting with 75 for
// systemd or Docker to restart it (AGORA_SUPERVISED=1).
//
//   pnpm start [--population N] [--no-server]     (--no-server: use a server you run yourself, e.g. `pnpm run server`)

import fs from 'node:fs';
import path from 'node:path';
import {
  type Logger,
  SeededRandom,
  createLogger,
  ensureDataDirs,
  getMineSkinKey,
  getNanoGptKey,
  loadEnv,
  loadHubConfig,
  loadModelsConfig,
  loadPersonaPool,
  loadSexDifferences,
  loadVersionsConfig,
  loadWorldConfig,
  repoRoot,
  seedFromString,
} from '@agora/shared';
import {
  type Embedder,
  KeyLockError,
  type LlmRuntime,
  QuotaWatch,
  createEmbedder,
  createGuardedFetch,
  describeQuota,
  evaluateKeyLock,
  fetchSubscriptionModels,
  fetchUsage,
  loadBenchFile,
  startLlm,
} from '@agora/llm';
import {
  ConsoleLog,
  DashboardModel,
  DashboardServer,
  Controller,
  Hub,
  type ManagedServer,
  PersonaWriter,
  SkinService,
  Supervisor,
  TuningStore,
  attachDashboard,
  controlHandler,
  nodeLauncher,
  startManagedServer,
} from '@agora/hub';
import { readRosterNames } from './lib/roster-names';
import { setWorldMode } from './lib/mode';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Ending = 'stop' | 'restart';

/** One run of the whole system; resolves once it has shut down, saying whether to start again. */
async function run(onStop: (stop: (why: string, how: Ending) => Promise<void>) => void): Promise<Ending> {
  loadEnv();
  const paths = ensureDataDirs();
  const configured = loadWorldConfig();
  // `--population N` means a fixed count (§19.7): initial = minAlive = N.
  const fixed = arg('population') === undefined ? null : Math.max(0, Number(arg('population')));
  const world =
    fixed === null || !Number.isFinite(fixed)
      ? configured
      : { ...configured, population: { ...configured.population, initial: fixed, minAlive: fixed, maxAlive: Math.max(configured.population.maxAlive, fixed) } };
  const hubCfg = loadHubConfig();
  // In a container (deploy/Dockerfile) Minecraft and the dashboard listen on every interface so their ports can be
  // published; deploy/compose.yaml publishes them on the host's loopback only (§23.3).
  if (process.env.AGORA_CONTAINER === '1') {
    world.server.host = '0.0.0.0';
    hubCfg.dashboard.host = '0.0.0.0';
  }
  const versions = loadVersionsConfig();
  const models = loadModelsConfig();
  const logger: Logger = createLogger({ name: 'agora', logDir: paths.logs, console: true });

  // Layer 1 (§22.1), once for everyone: refuse to start with a key that can spend balance.
  const key = getNanoGptKey();
  // The quota is read for the operator to see; it never limits thinking (owner request, 2026-10-25).
  let quota: QuotaWatch | null = null;
  if (key) {
    const http = createGuardedFetch({});
    const usage = await fetchUsage(http, key, AbortSignal.timeout(15_000));
    const verdict = evaluateKeyLock(usage, models.llm.allowPaidKey);
    for (const w of verdict.warnings) logger.warn({ module: 'llm' }, w);
    if (!verdict.ok) throw new KeyLockError(verdict.fatal ?? 'NanoGPT key check failed');
    quota = new QuotaWatch({ fetchUsage: (signal) => fetchUsage(http, key, signal), pollMs: models.llm.usagePollSec * 1000, logger });
    logger.info({ module: 'agora' }, describeQuota(quota.ingest(usage)));
    quota.start();
  } else {
    logger.warn({ module: 'agora' }, 'NANOGPT_API_KEY is empty: every agent runs code-only');
  }

  let server: ManagedServer | null = null;
  let serverState = 'not managed here (--no-server)';
  // The dashboard's console: what the server prints, and the commands run from the page with their answers.
  const consoleLog = new ConsoleLog();
  if (!process.argv.includes('--no-server')) {
    server = await startManagedServer({
      paths,
      world,
      versions,
      rconPassword: process.env.RCON_PASSWORD ?? '',
      logger,
      botNames: readRosterNames(paths),
    });
    server.paper.on('line', (line: string) => consoleLog.push('server', line));
    serverState = 'running';
  }

  const embedder: Embedder = await createEmbedder({ modelDir: path.join(paths.cache, 'models'), modelId: versions.embeddingModel.id, dims: versions.embeddingModel.dims, logger });
  const hub = new Hub({
    config: hubCfg,
    logger,
    embedder,
    maxConcurrentFights: world.conflict.maxConcurrentFights,
  });
  await hub.listen();
  const telemetry = fs.createWriteStream(path.join(paths.logs, 'telemetry.jsonl'), { flags: 'a' });
  hub.on('telemetry', (s, m) => telemetry.write(`${JSON.stringify({ agent: s.username, ...m })}\n`));

  // §16.5: each new agent's skin, from NameMC by its sex, put on by the agora-skins plugin as it logs in.
  const skins = world.skins.enabled
    ? new SkinService({
        config: world.skins,
        ownerDir: paths.skins,
        cacheDir: path.join(paths.cache, 'skins'),
        pluginDir: path.join(paths.plugins, 'AgoraSkins'),
        logger,
        rng: new SeededRandom(seedFromString(`skins-${Date.now()}`)),
        mineskinKey: getMineSkinKey(),
      })
    : null;
  const pool = loadPersonaPool();
  // The master model (§16.2, §20): writes each new person, and each child on the way, from numbers drawn by code. On
  // the agents' shared rate limit, at the lowest priority; without a key, code's own words stand.
  const master: LlmRuntime | null = key
    ? await startLlm({ apiKey: key, config: models, logger, bench: loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'), logger), limiter: hub.tokens(), background: false, pollUsage: false })
    : null;
  const writer = master ? new PersonaWriter({ llm: master.client, logger, rng: new SeededRandom(seedFromString(`personas-${Date.now()}`)) }) : null;
  const supervisor = new Supervisor({
    hub,
    paths,
    world,
    sexDiffs: loadSexDifferences(),
    pool,
    launcher: nodeLauncher({ entry: path.join(repoRoot(), 'packages', 'agent', 'src', 'main.ts'), cwd: repoRoot(), hubUrl: `ws://127.0.0.1:${hub.port}`, logDir: path.join(paths.logs, 'bots') }),
    logger,
    rng: new SeededRandom(seedFromString(`${Date.now()}`)),
    ...(server ? { rcon: (c: string) => server.rcon.command(c) } : {}),
    ...(skins ? { skins } : {}),
    ...(writer ? { writer } : {}),
  });

  let ending: Ending = 'stop';
  let resolveEnded!: () => void;
  const ended = new Promise<void>((r) => (resolveEnded = r));
  let stopping = false;
  // The dashboard (M7) and `pnpm ctl`: read-only views, plus control with the RCON password as the token.
  const startedAt = Date.now();
  const model = new DashboardModel({
    mode: () => world.mode,
    quota: () => quota?.view ?? null,
    personas: () => supervisor.rosterSnapshot.agents.map((a) => ({ username: a.username, traits: a.persona.traits, sex: a.persona.sex, status: a.status })),
  });
  const detachDashboard = attachDashboard(hub, model);
  // Debug controls: the operator's settings for the agents, sent to each as it starts and whenever they change.
  const tuning = new TuningStore(path.join(paths.agents, 'tuning.json'));
  hub.on('ready', (s, name) => s.send({ t: 'tuning', tuning: tuning.for(name) }));
  const sendTuning = (scope: string) => {
    for (const s of hub.list()) if (s.username && (scope === 'all' || s.username === scope)) s.send({ t: 'tuning', tuning: tuning.for(s.username) });
  };
  // The controller (owner request, 2026-10-24): the master model over all the agents, stepping in only when
  // something has plainly gone wrong (controller.ts); never for an agent it is switched off for, or a paused one.
  const controller = new Controller({
    llm: master?.client ?? null,
    logger,
    config: models.controller,
    send: (name, urge) => {
      const s = hub.byName(name);
      if (!s) return false;
      s.send({ t: 'urge', urge });
      return true;
    },
    leaveBe: (name) => {
      const t = tuning.for(name);
      return t.paused || t.off.includes('controller');
    },
    onStep: (step) => model.controllerStep(step),
  });
  hub.on('telemetry', (s, m) => {
    if (m.t === 'telemetry' && s.username) controller.observe(s.username, m.kind, m.data);
  });
  hub.on('died', (_s, m) => controller.gone(m.username));
  hub.on('bye', (_s, m) => controller.gone(m.username));
  controller.start();
  let modelList: { at: number; list: { id: string; capabilities: string[]; thinking: boolean }[] } | null = null;
  const subscriptionModels = async () => {
    if (!key) return null;
    if (!modelList || Date.now() - modelList.at > 10 * 60_000) {
      const ms = await fetchSubscriptionModels(createGuardedFetch({}), key, AbortSignal.timeout(15_000));
      modelList = { at: Date.now(), list: ms.filter((m) => m.chat).map((m) => ({ id: m.id, capabilities: [...m.capabilities], thinking: m.thinking })).sort((a, b) => a.id.localeCompare(b.id)) };
    }
    return modelList.list;
  };

  let dashboard: DashboardServer | null = null;
  const stop = async (why: string, how: Ending): Promise<void> => {
    if (stopping) return;
    stopping = true;
    ending = how;
    logger.info({ module: 'agora', why }, how === 'restart' ? 'restarting' : 'shutting down');
    controller.stop();
    await supervisor.shutdown(why);
    await dashboard?.close();
    detachDashboard();
    await hub.close();
    master?.stop();
    quota?.stop();
    telemetry.end();
    await server?.stop();
    serverState = 'stopped';
    logger.info({ module: 'agora' }, 'stopped; roster saved');
    resolveEnded();
  };
  onStop(stop);
  server?.paper.on('exit', () => {
    serverState = 'stopped';
    void stop('the Minecraft server exited', 'stop');
  });
  if (hubCfg.dashboard.enabled) {
    const url = `http://${hubCfg.dashboard.host === '0.0.0.0' ? '127.0.0.1' : hubCfg.dashboard.host}:${hubCfg.dashboard.port}`;
    dashboard = new DashboardServer({
      model,
      host: hubCfg.dashboard.host,
      port: hubCfg.dashboard.port,
      logger,
      control: {
        token: process.env.RCON_PASSWORD ?? '',
        handle: controlHandler({
          mode: () => world.mode,
          startedAt,
          supervisor,
          online: () => new Set(hub.list().map((s) => s.username).filter((n): n is string => Boolean(n))),
          snapshotAll: () => hub.snapshotAll(),
          ...(server ? { rcon: (c: string) => server.rcon.command(c), console: consoleLog } : {}),
          serverState: () => serverState,
          quota: () => quota?.view ?? null,
          dashboardUrl: url,
          setMode: (mode, newWorld) => setWorldMode(mode, newWorld),
          stop: (why) => void stop(why, 'stop'),
          restart: (why) => void stop(why, 'restart'),
          debug: {
            request: (name, op, args) => hub.request(name, op, args),
            tuning,
            sendTuning,
            addAgent: (o) => supervisor.addAgent(o),
            retireAgent: (name) => supervisor.retireAgent(name),
            restartAgent: (name) => supervisor.restartAgent(name),
            personas: () => pool.map((p) => ({ id: p.id ?? p.name, name: p.name, sex: p.sex, traits: p.traits })),
            models: subscriptionModels,
          },
        }),
      },
    });
    await dashboard.listen();
  }

  logger.info({ module: 'agora', hub: `ws://${hubCfg.hub.host}:${hub.port}`, population: world.population.initial, mode: world.mode }, 'running');
  await supervisor.start();
  await ended;
  return ending;
}

async function main(): Promise<void> {
  let current: ((why: string, how: Ending) => Promise<void>) | null = null;
  process.on('SIGINT', () => void current?.('SIGINT', 'stop'));
  process.on('SIGTERM', () => void current?.('SIGTERM', 'stop'));
  for (;;) {
    const how = await run((s) => (current = s));
    if (how !== 'restart') break;
    // Under systemd or Docker a fresh process is cleaner: exit 75 and let the manager start it again.
    if (process.env.AGORA_SUPERVISED === '1') process.exit(75);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`[start] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
