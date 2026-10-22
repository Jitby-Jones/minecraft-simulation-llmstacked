// `pnpm server-mode test|live [--new-world]` (§16.3): rewrites server.properties for the mode and records it
// in config/world.yaml. Refuses to switch an existing world unless --new-world is given.

import { loadEnv } from '@agora/shared';
import { setWorldMode } from './lib/mode';

function usage(): never {
  console.error('usage: pnpm server-mode test|live [--new-world]');
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv.find((a) => !a.startsWith('--'));
  if (mode !== 'test' && mode !== 'live') usage();
  loadEnv();
  const res = await setWorldMode(mode, argv.includes('--new-world'));
  if (!res.ok) {
    console.error(`[server-mode] ${res.message}`);
    process.exit(1);
  }
  console.log(`[server-mode] ${res.message}. Restart the server to apply.`);
}

main().catch((err: unknown) => {
  console.error(`[server-mode] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
