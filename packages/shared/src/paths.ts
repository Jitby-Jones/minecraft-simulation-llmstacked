// All mutable state lives under one DATA_DIR (§23.1). Paths are built with path.join only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: three levels up from packages/shared/src. Override with AGORA_ROOT. */
export function repoRoot(): string {
  const override = process.env.AGORA_ROOT;
  if (override && override.length > 0) return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export interface DataPaths {
  root: string;
  server: string;
  plugins: string;
  agents: string;
  graveyard: string;
  logs: string;
  cache: string;
  /** What the owner drops in for agents' skins (§16.5): NameMC tag pages saved from a browser, lists of skin ids. */
  skins: string;
  roster: string;
  ctlSocket: string;
}

/** DATA_DIR env (absolute, or relative to the repo root) or `<repo>/data`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATA_DIR;
  if (raw && raw.trim().length > 0) {
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(repoRoot(), raw);
  }
  return path.join(repoRoot(), 'data');
}

export function dataPaths(root: string = dataDir()): DataPaths {
  const server = path.join(root, 'server');
  return {
    root,
    server,
    plugins: path.join(server, 'plugins'),
    agents: path.join(root, 'agents'),
    graveyard: path.join(root, 'graveyard'),
    logs: path.join(root, 'logs'),
    cache: path.join(root, 'cache'),
    skins: path.join(root, 'skins'),
    roster: path.join(root, 'agents', 'roster.json'),
    // Windows needs a named pipe; elsewhere a unix socket inside DATA_DIR.
    ctlSocket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\agora-ctl-${Buffer.from(root).toString('hex').slice(-16)}`
        : path.join(root, 'ctl.sock'),
  };
}

export function ensureDataDirs(paths: DataPaths = dataPaths()): DataPaths {
  for (const dir of [paths.root, paths.server, paths.plugins, paths.agents, paths.graveyard, paths.logs, paths.cache]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function configDir(): string {
  return path.join(repoRoot(), 'config');
}

export function personasDir(): string {
  return path.join(repoRoot(), 'personas');
}

/** Agent memory DB path for a living agent. */
export function agentDbPath(paths: DataPaths, username: string): string {
  return path.join(paths.agents, `${username}.db`);
}

/** Write a file atomically (write temp + rename) so crashes never leave half-written JSON. */
export function writeFileAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}
