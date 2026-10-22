// One bot process (§3): `node --import tsx packages/agent/src/main.ts --slot a0 --hub ws://127.0.0.1:8765`.
// The supervisor (`pnpm start`) launches these; a bot learns who it is from the Hub's assign message.
// AGORA_MC_HOST / AGORA_MC_PORT point it at a server other than config/world.yaml's (a server run elsewhere, tests).

import { dataPaths, loadEnv, loadHubConfig, loadModelsConfig, loadVersionsConfig, loadWorldConfig } from '@agora/shared';
import { runBot } from './hub/runtime';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const hubCfg = loadHubConfig();
  const slot = arg('slot') ?? process.env.AGORA_SLOT;
  if (!slot) throw new Error('missing --slot');
  const base = loadWorldConfig();
  const world = {
    ...base,
    server: { ...base.server, host: process.env.AGORA_MC_HOST ?? base.server.host, port: Number(process.env.AGORA_MC_PORT ?? base.server.port) },
  };
  const bot = await runBot({
    hubUrl: arg('hub') ?? `ws://${hubCfg.hub.host}:${hubCfg.hub.port}`,
    slot,
    paths: dataPaths(),
    world,
    versions: loadVersionsConfig(),
    models: loadModelsConfig(),
    expectedBots: world.population.maxAlive,
    exit: (code) => process.exit(code),
  });
  // The supervisor normally asks over the Hub; a signal from the OS gets the same graceful stop.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void bot.stop(sig));
}

main().catch((err: unknown) => {
  console.error(`[bot] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
