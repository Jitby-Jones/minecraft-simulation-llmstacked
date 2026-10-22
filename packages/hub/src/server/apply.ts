// Writes every generated server file for the current config + mode. Used by setup, server-mode and start.

import fs from 'node:fs';
import path from 'node:path';
import { type DataPaths, type WorldConfig, writeFileAtomic } from '@agora/shared';
import {
  ensureOwnerOp,
  planModeSwitch,
  readModeState,
  worldExists,
  writeModeState,
  writeProximityChatConfig,
  type ModeState,
} from './files';
import { buildServerProperties, type Mode } from './properties';

export interface ApplyResult {
  ok: boolean;
  state: ModeState | null;
  message: string;
}

export async function applyServerFiles(
  paths: DataPaths,
  world: WorldConfig,
  rconPassword: string,
  opts: { mode?: Mode; newWorld?: boolean } = {},
): Promise<ApplyResult> {
  const requested = opts.mode ?? world.mode;
  const current = readModeState(paths);
  const plan = planModeSwitch(
    current,
    requested,
    world.server.levelName,
    (lvl) => worldExists(paths, lvl),
    opts.newWorld ?? false,
  );
  if (!plan.ok) return { ok: false, state: current, message: plan.reason };

  fs.mkdirSync(paths.server, { recursive: true });
  const propsFile = path.join(paths.server, 'server.properties');
  const existing = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : null;
  writeFileAtomic(
    propsFile,
    buildServerProperties(existing, { world, mode: requested, levelName: plan.levelName, rconPassword }),
  );
  writeProximityChatConfig(paths, world);
  await ensureOwnerOp(paths, world.owner.username);
  const state: ModeState = { mode: requested, levelName: plan.levelName, appliedAt: Date.now() };
  writeModeState(paths, state);
  return { ok: true, state, message: `${requested} mode, world "${plan.levelName}" (${plan.reason})` };
}
