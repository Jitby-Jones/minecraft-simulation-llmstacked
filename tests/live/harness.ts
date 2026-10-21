// Live-test harness: an isolated Paper server under data/live-test/<name>/ built from the verified install in
// DATA_DIR/server (run `pnpm run setup` and boot once first). Requires AGORA_JAVA (Java 25+).
// RCON is used only to set up scenarios — never to feed information to agents.

import fs from 'node:fs';
import path from 'node:path';
import {
  type Logger,
  WorldConfigSchema,
  createLogger,
  dataPaths,
  loadVersionsConfig,
  renderProximityChatConfig,
  repoRoot,
  sleep,
} from '@agora/shared';
import { PaperProcess, RconClient, findJava, managedProperties, paperJarName, renderProperties } from '@agora/hub';

export interface LiveServerOptions {
  name: string;
  port?: number;
  rconPort?: number;
  flat?: boolean;
  /** Extra server.properties overrides. */
  props?: Record<string, string>;
  /** Extra plugin jars to install (debug tooling). */
  extraPlugins?: string[];
  /** Natural monster spawning (off by default so scenarios stay deterministic). */
  monsters?: boolean;
}

export interface LiveServer {
  dir: string;
  host: string;
  port: number;
  rcon: RconClient;
  paper: PaperProcess;
  logger: Logger;
  cmd(command: string): Promise<string>;
  stop(): Promise<void>;
}

const RCON_PASSWORD = 'live-test-rcon';

export function liveJavaPath(): string | null {
  const v = loadVersionsConfig();
  return findJava(v.java.minMajor, process.env.AGORA_JAVA).found?.path ?? null;
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
}

export async function startLiveServer(opts: LiveServerOptions): Promise<LiveServer> {
  const java = liveJavaPath();
  if (!java) throw new Error('No Java 25+ found: set AGORA_JAVA to a Java 25 binary to run live tests.');
  const versions = loadVersionsConfig();
  const main = dataPaths();
  const base = path.join(repoRoot(), 'data', 'live-test', opts.name);
  const dir = path.join(base, 'server');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const jar = paperJarName(versions);
  fs.copyFileSync(path.join(main.server, jar), path.join(dir, jar));
  for (const sub of ['cache', 'libraries', 'versions']) copyDir(path.join(main.server, sub), path.join(dir, sub));
  for (const f of [versions.proximityChat.filename, versions.guardPlugin.filename]) {
    fs.copyFileSync(path.join(main.plugins, f), path.join(dir, 'plugins', f));
  }
  for (const jarPath of opts.extraPlugins ?? []) fs.copyFileSync(jarPath, path.join(dir, 'plugins', path.basename(jarPath)));
  const world = WorldConfigSchema.parse({});
  fs.mkdirSync(path.join(dir, 'plugins', 'ProximityChat'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugins', 'ProximityChat', 'config.yml'),
    renderProximityChatConfig({ normalRange: 15, whisperRange: 5, shoutRange: 48, fadeStart: 0.6, cooldownSec: 0 }),
  );
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  const port = opts.port ?? 25566;
  const rconPort = opts.rconPort ?? 25576;
  const props = managedProperties({
    world: { ...world, server: { ...world.server, port, rconPort } },
    mode: 'test',
    levelName: 'world',
    rconPassword: RCON_PASSWORD,
  });
  if (opts.flat ?? true) {
    props.set('level-type', 'minecraft\\:flat');
    props.set('generate-structures', 'false');
  }
  props.set('max-players', '20');
  for (const [k, v] of Object.entries(opts.props ?? {})) props.set(k, v);
  fs.writeFileSync(path.join(dir, 'server.properties'), renderProperties(props, 'live test'));

  const logger = createLogger({ name: `live-${opts.name}`, logDir: path.join(base, 'logs'), console: false });
  const paper = new PaperProcess({ javaPath: java, jarPath: jar, cwd: dir, heapMb: 2048, logger });
  paper.start();
  await paper.waitReady(240_000);
  const rcon = new RconClient('127.0.0.1', rconPort, RCON_PASSWORD);
  await rcon.connect();
  // 26.1 replaced the spawn-monsters property with a gamerule.
  await rcon.command(`gamerule spawn_monsters ${opts.monsters ? 'true' : 'false'}`);
  return {
    dir,
    host: '127.0.0.1',
    port,
    rcon,
    paper,
    logger,
    cmd: (c) => rcon.command(c),
    async stop() {
      rcon.close();
      await paper.stop(60_000);
    },
  };
}

export async function waitFor<T>(
  check: () => T | undefined | null | false,
  timeoutMs: number,
  label: string,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = check();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}
