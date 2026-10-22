// Preflight checks (§15.4 "fail fast") and a managed Paper start used by `pnpm start` and `pnpm run server`.

import path from 'node:path';
import type { DataPaths, Logger, VersionsConfig, WorldConfig } from '@agora/shared';
import { applyServerFiles } from './apply';
import { eulaAccepted, opsContainingBots, readModeState } from './files';
import { verifyInstall, paperJarName } from './install';
import { findJava, type JavaInfo } from './java';
import { PaperProcess } from './process';
import { bindingWarning } from './properties';
import { RconClient } from './rcon';

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  java: JavaInfo | null;
}

export interface ManagedServerOptions {
  paths: DataPaths;
  world: WorldConfig;
  versions: VersionsConfig;
  rconPassword: string;
  logger: Logger;
  /** Every bot username ever used (living and dead); none may be op. */
  botNames: Iterable<string>;
}

/** §15.4 startup checks: pinned Paper, plugin present, EULA, Java, mode consistency, no bot is op. */
export function preflightServer(opts: ManagedServerOptions): PreflightResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const install = verifyInstall(opts.paths, opts.versions, !opts.world.chat.allowPrivateMessages, opts.world.skins.enabled);
  problems.push(...install.problems);
  if (!eulaAccepted(opts.paths)) problems.push('Minecraft EULA not accepted: run `pnpm run setup --accept-eula`');
  const java = findJava(opts.versions.java.minMajor, opts.world.server.javaPath).found;
  if (!java) problems.push(`Java ${opts.versions.java.minMajor}+ not found (set JAVA_HOME, AGORA_JAVA or server.javaPath)`);
  const mode = readModeState(opts.paths);
  if (!mode) problems.push('server files not generated: run `pnpm run setup`');
  else if (mode.mode !== opts.world.mode) {
    problems.push(`config/world.yaml says mode ${opts.world.mode} but the server is set up for ${mode.mode}: run \`pnpm server-mode ${opts.world.mode}\``);
  }
  const opBots = opsContainingBots(opts.paths, opts.botNames);
  if (opBots.length > 0) problems.push(`bot usernames are op (never allowed, §13 rule 10): ${opBots.join(', ')}`);
  if (!opts.rconPassword) problems.push('RCON_PASSWORD is empty: run `pnpm run setup` to generate one into .env');
  const bind = bindingWarning(opts.world.server.host);
  if (bind) warnings.push(bind);
  return { ok: problems.length === 0, problems, warnings, java };
}

export interface ManagedServer {
  paper: PaperProcess;
  rcon: RconClient;
  stop(): Promise<void>;
}

export const STARTUP_GAMERULES: readonly string[] = [
  // Public news, the same for humans and bots (§15.4, §16.3). 26.1 renamed gamerules to snake_case.
  'gamerule show_death_messages true',
  'gamerule show_advancement_messages true',
  // Formerly server.properties keys (pvp, enable-command-block), gamerules since 26.1.
  'gamerule pvp true',
  'gamerule command_blocks_work false',
];

export async function startManagedServer(opts: ManagedServerOptions): Promise<ManagedServer> {
  const pre = preflightServer(opts);
  for (const w of pre.warnings) opts.logger.warn({ module: 'server' }, w);
  if (!pre.ok || !pre.java) throw new Error(`server preflight failed:\n  - ${pre.problems.join('\n  - ')}`);
  const applied = await applyServerFiles(opts.paths, opts.world, opts.rconPassword);
  if (!applied.ok) throw new Error(applied.message);
  const paper = new PaperProcess({
    javaPath: pre.java.path,
    jarPath: path.join(opts.paths.server, paperJarName(opts.versions)),
    cwd: opts.paths.server,
    heapMb: opts.world.server.heapMb,
    logger: opts.logger,
  });
  paper.start();
  await paper.waitReady();
  const rcon = new RconClient('127.0.0.1', opts.world.server.rconPort, opts.rconPassword);
  await rcon.connect();
  for (const cmd of STARTUP_GAMERULES) {
    const r = await rcon.command(cmd);
    opts.logger.info({ module: 'server', cmd, r }, 'gamerule');
  }
  return {
    paper,
    rcon,
    async stop() {
      try {
        await rcon.command('save-all flush');
      } catch {
        // server may already be stopping
      }
      rcon.close();
      await paper.stop();
    },
  };
}
