// Switching between test and live mode (§16.3), for `pnpm server-mode` and `pnpm ctl mode`: rewrites the server's
// files for the mode (a live switch of an existing world needs --new-world, which starts a new one next time and
// keeps the old) and records the mode in config/world.yaml, comments preserved. Takes effect on the next start.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { configDir, dataPaths, ensureDataDirs, loadWorldConfig } from '@agora/shared';
import { applyServerFiles } from '@agora/hub';

export async function setWorldMode(mode: 'test' | 'live', newWorld: boolean): Promise<{ ok: boolean; message: string }> {
  const world = loadWorldConfig();
  const paths = ensureDataDirs(dataPaths());
  const res = await applyServerFiles(paths, { ...world, mode }, process.env.RCON_PASSWORD ?? '', { mode, newWorld });
  if (!res.ok) return { ok: false, message: res.message };
  const file = path.join(configDir(), 'world.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  doc.set('mode', mode);
  fs.writeFileSync(file, doc.toString({ lineWidth: 120 }));
  return { ok: true, message: `${res.message}. difficulty=hard, hardcore=${mode === 'live'}` };
}
