// `pnpm agent`: runs one agent against the configured server (the M3 single-agent demo). With NANOGPT_API_KEY set
// it thinks through the subscription-locked LLM layer; without one (or with --code-only) it runs on its code
// defaults (§22.4). The Hub (M5) runs a whole population; this is for one bot.
//
//   pnpm agent --persona pip [--goal "get stone tools" --done "inventoryHas:stone_pickaxe>=1"] [--code-only]
//              [--username Pip] [--host 127.0.0.1] [--port 25565]

import path from 'node:path';
import {
  type Persona,
  createLogger,
  dataPaths,
  getNanoGptKey,
  isValidUsername,
  loadEnv,
  loadModelsConfig,
  loadPersonaPool,
  loadVersionsConfig,
  loadWorldConfig,
  repoRoot,
} from '@agora/shared';
import { type LlmRuntime, loadBenchFile, startLlm } from '@agora/llm';
import { Agent, Body } from '@agora/agent';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const world = loadWorldConfig();
  const versions = loadVersionsConfig();
  const models = loadModelsConfig();
  const pool = loadPersonaPool();
  const wanted = (arg('persona') ?? pool[0]?.id ?? '').toLowerCase();
  const persona: Persona | undefined = pool.find((p) => p.id === wanted || p.name.toLowerCase() === wanted);
  if (!persona) throw new Error(`no persona "${wanted}" in personas/ (have: ${pool.map((p) => p.id).join(', ')})`);
  const username = arg('username') ?? persona.name;
  if (!isValidUsername(username)) throw new Error(`"${username}" is not a valid player name (3–16 letters, digits or _; nothing bot-like)`);
  const logger = createLogger({ name: `agent-${username}`, logDir: path.join(dataPaths().logs, 'agents'), console: true });

  let rt: LlmRuntime | null = null;
  const key = getNanoGptKey();
  if (key && !process.argv.includes('--code-only')) {
    rt = await startLlm({ apiKey: key, config: models, logger, bench: loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'), logger) });
  } else {
    logger.warn({ module: 'agent' }, key ? 'code-only by request' : 'NANOGPT_API_KEY is empty: running code-only (no LLM)');
  }

  const body = await Body.connect({
    host: arg('host') ?? (world.server.host === '0.0.0.0' ? '127.0.0.1' : world.server.host),
    port: Number(arg('port') ?? world.server.port),
    username,
    version: versions.minecraft.version,
    logger,
  });
  const agent = new Agent({ body, persona, username, llm: rt?.client ?? null, logger, world, governor: rt?.governor });
  agent.start();
  const goal = arg('goal');
  if (goal) agent.setGoal(goal, arg('done'));

  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ module: 'agent', why }, 'stopping');
    agent.stop();
    await body.disconnect('bye');
    rt?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  body.bot.on('end', () => void stop('disconnected'));
}

main().catch((err: unknown) => {
  console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
