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
  /**
   * A flat world whose ground stands at DEEP_GROUND_Y, above the slime-chunk depth (slimes spawn below Y 40 at any
   * light level), as on ordinary terrain: plain superflat ground is at Y −60, where slimes come out in daylight.
   */
  deepGround?: boolean;
  /** Extra server.properties overrides. */
  props?: Record<string, string>;
  /** Extra plugin jars to install (debug tooling). */
  extraPlugins?: string[];
  /** Natural monster spawning (off by default so scenarios stay deterministic). */
  monsters?: boolean;
}

/** Where one stands on a `deepGround` world: grass at Y 40 over 100 layers of stone. */
export const DEEP_GROUND_Y = 41;
const DEEP_FLAT = JSON.stringify({
  layers: [
    { block: 'minecraft:bedrock', height: 1 },
    { block: 'minecraft:stone', height: 100 },
    { block: 'minecraft:dirt', height: 3 },
    { block: 'minecraft:grass_block', height: 1 },
  ],
  biome: 'minecraft:plains',
});

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
/** A command the server can't parse is a bug in the test, not a state of the world (26.1 renamed gamerules). */
const MALFORMED = /^(Incorrect argument for command|Unknown or incomplete command|Unknown command)/;

export function liveJavaPath(): string | null {
  const v = loadVersionsConfig();
  return findJava(v.java.minMajor, process.env.AGORA_JAVA).found?.path ?? null;
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
}

/**
 * A server left running in this folder by a test worker that died (out of memory): it holds the port, and the next one
 * exits at once ("Paper exited before ready"). Killed before a new one starts. Linux only (it reads /proc).
 */
async function killStaleServer(dir: string): Promise<void> {
  if (process.platform !== 'linux') return;
  let killed = 0;
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '');
      if (cwd === dir && /java/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) {
        process.kill(Number(pid), 'SIGKILL');
        killed++;
      }
    } catch {
      // gone already, or not ours to look at
    }
  }
  if (killed > 0) await new Promise((r) => setTimeout(r, 2000));
}

export async function startLiveServer(opts: LiveServerOptions): Promise<LiveServer> {
  const java = liveJavaPath();
  if (!java) throw new Error('No Java 25+ found: set AGORA_JAVA to a Java 25 binary to run live tests.');
  const versions = loadVersionsConfig();
  const main = dataPaths();
  const base = path.join(repoRoot(), 'data', 'live-test', opts.name);
  const dir = path.join(base, 'server');
  await killStaleServer(dir);
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
    if (opts.deepGround) props.set('generator-settings', DEEP_FLAT);
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
  const cmd = async (c: string): Promise<string> => {
    const r = await rcon.command(c);
    if (MALFORMED.test(r)) throw new Error(`the server rejected "${c}": ${r}`);
    return r;
  };
  // 26.1 replaced the spawn-monsters property with a gamerule.
  await cmd(`gamerule spawn_monsters ${opts.monsters ? 'true' : 'false'}`);
  return {
    dir,
    host: '127.0.0.1',
    port,
    rcon,
    paper,
    logger,
    cmd,
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

/** Lines that ask whether someone is there: what nobody says to someone they can see (owner request, 2026-10-24). */
export const PRESENCE_CHECK = /\b(still (there|here|around)|are (you|u) (there|here|around)|(you|u|r u) there|anyone (there|here)|can (you|u) hear|hello\?|hellooo+|you around\?|u around\?)/i;
