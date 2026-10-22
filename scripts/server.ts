// `pnpm run server`: only the Minecraft server, in the foreground, with the same preflight checks as `pnpm start`.
// Type console commands on stdin; Ctrl+C saves and stops.

import readline from 'node:readline';
import { createLogger, dataPaths, loadEnv, loadVersionsConfig, loadWorldConfig } from '@agora/shared';
import { startManagedServer } from '@agora/hub';
import { readRosterNames } from './lib/roster-names';

async function main(): Promise<void> {
  loadEnv();
  const paths = dataPaths();
  const logger = createLogger({ name: 'server', logDir: paths.logs });
  const server = await startManagedServer({
    paths,
    world: loadWorldConfig(),
    versions: loadVersionsConfig(),
    rconPassword: process.env.RCON_PASSWORD ?? '',
    logger,
    botNames: readRosterNames(paths),
  });
  server.paper.on('line', (line: string) => process.stdout.write(`${line}\n`));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim()) server.paper.command(line.trim());
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    rl.close();
    void server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.paper.on('exit', () => process.exit(0));
}

main().catch((err: unknown) => {
  console.error(`[server] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
