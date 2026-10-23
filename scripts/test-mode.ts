// `pnpm test-mode [on|off] [--new-world]` (§16.3): test mode on is `mode: test` (hard, not hardcore: a death ends the
// agent's life all the same, the server just doesn't enforce it; agents start with their persona's kit). Off is
// `mode: live`: hardcore, real permadeath for everyone (people playing too), no starter kits. Hardcore only takes on a
// fresh world, so turning test mode off on a world that was already played needs --new-world (the old world is kept
// in its folder). With no argument, says which it is. Takes effect the next time the server starts.

import { loadEnv, loadWorldConfig } from '@agora/shared';
import { setWorldMode } from './lib/mode';

function usage(): never {
  console.error('usage: pnpm test-mode [on|off] [--new-world]');
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const which = argv.find((a) => !a.startsWith('--'));
  loadEnv();
  if (!which) {
    const mode = loadWorldConfig().mode;
    console.log(`[test-mode] ${mode === 'test' ? 'on (mode test: hard, simulated permadeath, starter kits)' : 'off (mode live: hardcore, real permadeath, no starter kits)'}`);
    return;
  }
  if (which !== 'on' && which !== 'off') usage();
  const res = await setWorldMode(which === 'on' ? 'test' : 'live', argv.includes('--new-world'));
  if (!res.ok) {
    console.error(`[test-mode] ${res.message}`);
    if (/--new-world/.test(res.message)) console.error('[test-mode] Run it again with --new-world to start a fresh world for it (the old world stays in its folder).');
    process.exit(1);
  }
  console.log(`[test-mode] ${which}: ${res.message}. Restart (pnpm ctl restart, or pnpm start) to apply.`);
}

main().catch((err: unknown) => {
  console.error(`[test-mode] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
