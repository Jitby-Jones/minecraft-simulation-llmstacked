// `pnpm start` (§23.2): one supervisor process runs the Minecraft server (a child process), the Hub, and one process
// per bot. Ctrl+C or SIGTERM shuts down gracefully (§23.4): bots flush their memory and write snapshots, the server
// saves and stops, roster.json is written. The next `pnpm start` resumes the same agents.
//
//   pnpm start [--population N] [--no-server]     (--no-server: use a server you run yourself, e.g. `pnpm run server`)

import fs from 'node:fs';
import path from 'node:path';
import {
  SeededRandom,
  createLogger,
  ensureDataDirs,
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
import { type Embedder, KeyLockError, QuotaGovernor, createEmbedder, createGuardedFetch, evaluateKeyLock, fetchUsage } from '@agora/llm';
import { Hub, type ManagedServer, Supervisor, nodeLauncher, startManagedServer } from '@agora/hub';
import { readRosterNames } from './lib/roster-names';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const paths = ensureDataDirs();
  const world = loadWorldConfig();
  const hubCfg = loadHubConfig();
  const versions = loadVersionsConfig();
  const models = loadModelsConfig();
  const logger = createLogger({ name: 'agora', logDir: paths.logs, console: true });

  // Layer 1 (§22.1), once for everyone: refuse to start with a key that can spend balance.
  const key = getNanoGptKey();
  let governor: QuotaGovernor | null = null;
  if (key) {
    const http = createGuardedFetch({});
    const usage = await fetchUsage(http, key, AbortSignal.timeout(15_000));
    const verdict = evaluateKeyLock(usage, models.llm.allowPaidKey);
    for (const w of verdict.warnings) logger.warn({ module: 'llm' }, w);
    if (!verdict.ok) throw new KeyLockError(verdict.fatal ?? 'NanoGPT key check failed');
    governor = new QuotaGovernor({
      fetchUsage: (signal) => fetchUsage(http, key, signal),
      pollMs: models.llm.usagePollSec * 1000,
      runtimeHoursPerWeek: models.llm.expectedRuntimeHoursPerWeek,
      logger,
    });
    governor.ingest(usage);
    governor.start();
  } else {
    logger.warn({ module: 'agora' }, 'NANOGPT_API_KEY is empty: every agent runs code-only (§22.4)');
  }

  let server: ManagedServer | null = null;
  if (!process.argv.includes('--no-server')) {
    server = await startManagedServer({
      paths,
      world,
      versions,
      rconPassword: process.env.RCON_PASSWORD ?? '',
      logger,
      botNames: readRosterNames(paths),
    });
  }

  const embedder: Embedder = await createEmbedder({ modelDir: path.join(paths.cache, 'models'), modelId: versions.embeddingModel.id, dims: versions.embeddingModel.dims, logger });
  const hub = new Hub({ config: hubCfg, logger, embedder, quota: () => governor?.status ?? null, runtimeHoursPerWeek: models.llm.expectedRuntimeHoursPerWeek });
  await hub.listen();
  hub.start();
  governor?.on('change', () => hub.broadcastBudget('quota change'));
  const telemetry = fs.createWriteStream(path.join(paths.logs, 'telemetry.jsonl'), { flags: 'a' });
  hub.on('telemetry', (s, m) => telemetry.write(`${JSON.stringify({ agent: s.username, ...m })}\n`));

  const population = arg('population');
  const supervisor = new Supervisor({
    hub,
    paths,
    world,
    sexDiffs: loadSexDifferences(),
    pool: loadPersonaPool(),
    launcher: nodeLauncher({ entry: path.join(repoRoot(), 'packages', 'agent', 'src', 'main.ts'), cwd: repoRoot(), hubUrl: `ws://127.0.0.1:${hub.port}`, logDir: path.join(paths.logs, 'bots') }),
    logger,
    rng: new SeededRandom(seedFromString(`${Date.now()}`)),
    ...(server ? { rcon: (c: string) => server.rcon.command(c) } : {}),
    ...(population !== undefined ? { initial: Number(population) } : {}),
  });

  let stopping = false;
  const stop = async (why: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ module: 'agora', why }, 'shutting down');
    await supervisor.shutdown(why);
    await hub.close();
    governor?.stop();
    telemetry.end();
    await server?.stop();
    logger.info({ module: 'agora' }, 'stopped; roster saved');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  server?.paper.on('exit', () => void stop('the Minecraft server exited'));

  logger.info({ module: 'agora', hub: `ws://${hubCfg.hub.host}:${hub.port}`, population: population ?? world.population.initial, mode: world.mode }, 'running');
  await supervisor.start();
}

main().catch((err: unknown) => {
  console.error(`[start] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
