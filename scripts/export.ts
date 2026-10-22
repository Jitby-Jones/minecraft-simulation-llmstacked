// `pnpm export [--hot] [--with-logs] [--out <file>]` (§23.4): the world, the agents, the graveyard, the roster and
// the config in export-<date>.tar.gz, to copy to another machine and `pnpm import` there. Not the .env, and not
// caches. While the system runs it refuses, unless --hot: then everyone saves first (Minecraft's save-all, every
// agent's snapshot and database checkpoint).

import path from 'node:path';
import { configDir, dataPaths, loadEnv, repoRoot } from '@agora/shared';
import { createExport } from './lib/archive';
import { ctlRequest } from './lib/ctl-client';

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const hot = argv.includes('--hot');
  const i = argv.indexOf('--out');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const outArg = i >= 0 ? argv[i + 1] : undefined;
  const out = path.resolve(outArg ?? path.join(repoRoot(), `export-${stamp}.tar.gz`));
  const status = await ctlRequest('status', [], 5000).catch(() => null);
  if (status) {
    if (!hot) {
      console.error('[export] agora is running. Stop it first (`pnpm ctl stop`), or use --hot to save everything and export while it runs.');
      process.exit(1);
    }
    const saved = await ctlRequest('save', [], 120_000);
    if (!saved?.ok) {
      console.error(`[export] could not save first: ${saved?.message ?? 'no answer'}`);
      process.exit(1);
    }
    console.log(`[export] ${saved.message}`);
  }
  const paths = dataPaths();
  const r = await createExport({ dataDir: paths.root, configDir: configDir(), out, withLogs: argv.includes('--with-logs') });
  console.log(`[export] wrote ${out} (${r.files} files, ${(r.bytes / 1e6).toFixed(1)} MB). .env is not in it: set NANOGPT_API_KEY again on the other machine.`);
}

main().catch((err: unknown) => {
  console.error(`[export] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
