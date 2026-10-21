// `pnpm server-mode test|live [--new-world]` (§16.3): rewrites server.properties for the mode and records it
// in config/world.yaml. Refuses to switch an existing world unless --new-world is given.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { configDir, dataPaths, ensureDataDirs, loadEnv, loadWorldConfig } from '@agora/shared';
import { applyServerFiles } from '@agora/hub';

function usage(): never {
  console.error('usage: pnpm server-mode test|live [--new-world]');
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv.find((a) => !a.startsWith('--'));
  if (mode !== 'test' && mode !== 'live') usage();
  const newWorld = argv.includes('--new-world');
  loadEnv();
  const world = loadWorldConfig();
  const paths = ensureDataDirs(dataPaths());
  const res = await applyServerFiles(paths, { ...world, mode }, process.env.RCON_PASSWORD ?? '', {
    mode,
    newWorld,
  });
  if (!res.ok) {
    console.error(`[server-mode] ${res.message}`);
    process.exit(1);
  }
  // Keep config/world.yaml in sync, preserving comments.
  const file = path.join(configDir(), 'world.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  doc.set('mode', mode);
  fs.writeFileSync(file, doc.toString({ lineWidth: 120 }));
  console.log(`[server-mode] ${res.message}. difficulty=hard, hardcore=${mode === 'live'}. Restart the server to apply.`);
}

main().catch((err: unknown) => {
  console.error(`[server-mode] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
