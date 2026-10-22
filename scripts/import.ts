// `pnpm import <export-file.tar.gz> [--force]` (§23.4): unpacks an export into DATA_DIR and config/. Refuses while
// the system runs, and if this machine already has agents or a world, unless --force, which first moves them
// aside (DATA_DIR.bak-<date>, config.bak-<date>) instead of deleting anything.

import fs from 'node:fs';
import { configDir, dataPaths, loadEnv } from '@agora/shared';
import { extractExport } from './lib/archive';
import { ctlRequest } from './lib/ctl-client';

/** Something worth keeping is already there: agents, a roster, or a world. */
function inUse(dataDir: string): boolean {
  const p = dataPaths(dataDir);
  const has = (d: string) => fs.existsSync(d) && fs.readdirSync(d).length > 0;
  return fs.existsSync(p.roster) || has(p.agents) || has(p.graveyard) || fs.existsSync(`${p.server}/world`);
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file || !fs.existsSync(file)) {
    console.error('usage: pnpm import <export-file.tar.gz> [--force]');
    process.exit(2);
  }
  if (await ctlRequest('status', [], 5000).catch(() => null)) {
    console.error('[import] agora is running here. Stop it first: `pnpm ctl stop`.');
    process.exit(1);
  }
  const paths = dataPaths();
  const cfg = configDir();
  if (inUse(paths.root)) {
    if (!argv.includes('--force')) {
      console.error(`[import] ${paths.root} already holds a world or agents. Use --force to move them aside first.`);
      process.exit(1);
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    fs.renameSync(paths.root, `${paths.root}.bak-${stamp}`);
    fs.cpSync(cfg, `${cfg}.bak-${stamp}`, { recursive: true });
    console.log(`[import] moved the old data to ${paths.root}.bak-${stamp} and copied the config to ${cfg}.bak-${stamp}`);
  }
  fs.mkdirSync(paths.root, { recursive: true });
  const r = await extractExport({ file, dataDir: paths.root, configDir: cfg });
  if (r.skipped.length > 0) console.log(`[import] skipped ${r.skipped.length} entries that were not plain files under data/ or config/`);
  console.log(`[import] restored ${r.data} data files and ${r.config} config files.`);
  console.log('[import] next: put NANOGPT_API_KEY in .env, then `pnpm run setup` (downloads Paper and the plugins again) and `pnpm start`.');
}

main().catch((err: unknown) => {
  console.error(`[import] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
