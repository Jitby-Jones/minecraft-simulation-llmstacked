// `pnpm run doctor` (§23.5): toolchain versions, RAM vs population, ports, disk, .env key and subscription
// lock, plugin/jar hashes, unsafe network binding, DATA_DIR write access. (`pnpm doctor` is a pnpm built-in.)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  dataPaths,
  getMineSkinKey,
  getNanoGptKey,
  loadEnv,
  loadHubConfig,
  loadModelsConfig,
  loadVersionsConfig,
  loadWorldConfig,
} from '@agora/shared';
import { bindingWarning, eulaAccepted, findJava, ownerSkinIds, readModeState, verifyInstall, worldExists } from '@agora/hub';
import { checkSubscriptionLock, checkTiers } from './lib/doctor-llm';

type Status = 'ok' | 'warn' | 'fail';
const results: { status: Status; label: string; detail: string }[] = [];
const report = (status: Status, label: string, detail: string): void => {
  results.push({ status, label, detail });
};

function semverGte(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function main(): Promise<void> {
  loadEnv();
  const versions = loadVersionsConfig();
  const world = loadWorldConfig();
  const hub = loadHubConfig();
  const models = loadModelsConfig();
  const paths = dataPaths();

  // Toolchain
  report(semverGte(process.version, versions.node.min) ? 'ok' : 'fail', 'Node', `${process.version} (need ${versions.node.min}+)`);
  const pnpm = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], { encoding: 'utf8' });
  report(pnpm.status === 0 ? 'ok' : 'warn', 'pnpm', pnpm.status === 0 ? pnpm.stdout.trim() : 'not found (use corepack enable)');
  const java = findJava(versions.java.minMajor, world.server.javaPath);
  report(
    java.found ? 'ok' : 'fail',
    'Java',
    java.found
      ? `${java.found.versionLine} (${java.found.path})`
      : `need ${versions.java.minMajor}+; found ${java.probed.map((j) => j.major).join(', ') || 'none'}`,
  );

  // Resources: ~3 GB for Paper + ~0.3 GB per bot (§23.5)
  const needGb = world.server.heapMb / 1024 + 0.3 * world.population.maxAlive + 1;
  const totalGb = os.totalmem() / 1024 ** 3;
  report(totalGb >= needGb ? 'ok' : 'warn', 'RAM', `${totalGb.toFixed(1)} GB total; ~${needGb.toFixed(1)} GB for maxAlive=${world.population.maxAlive}`);
  report(os.cpus().length >= 4 ? 'ok' : 'warn', 'CPU', `${os.cpus().length} cores (4+ recommended)`);
  try {
    const st = fs.statfsSync(fs.existsSync(paths.root) ? paths.root : path.dirname(paths.root));
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    report(freeGb >= 5 ? 'ok' : 'warn', 'Disk', `${freeGb.toFixed(1)} GB free at DATA_DIR`);
  } catch (err) {
    report('warn', 'Disk', `could not stat: ${(err as Error).message}`);
  }

  // DATA_DIR write access
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    const probe = path.join(paths.root, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    report('ok', 'DATA_DIR', `${paths.root} is writable`);
  } catch (err) {
    report('fail', 'DATA_DIR', `${paths.root} not writable: ${(err as Error).message}`);
  }

  // Ports
  for (const [label, host, port] of [
    ['Minecraft port', world.server.host, world.server.port],
    ['RCON port', '127.0.0.1', world.server.rconPort],
    ['Hub port', hub.hub.host, hub.hub.port],
    ['Dashboard port', hub.dashboard.host, hub.dashboard.port],
  ] as const) {
    const free = await portFree(host, port);
    report(free ? 'ok' : 'warn', label, `${host}:${port} ${free ? 'free' : 'in use (already running?)'}`);
  }

  // Binding safety (§23.3)
  for (const [label, host] of [
    ['Minecraft binding', world.server.host],
    ['Hub binding', hub.hub.host],
    ['Dashboard binding', hub.dashboard.host],
  ] as const) {
    const w = bindingWarning(host);
    report(w ? 'warn' : 'ok', label, w ?? `${host} (local only)`);
  }

  // Jars and server files
  const install = verifyInstall(paths, versions, !world.chat.allowPrivateMessages, world.skins.enabled);
  report(install.ok ? 'ok' : 'fail', 'Jars', install.ok ? "Paper, ProximityChat! and our plugins' hashes match" : install.problems.join('; '));
  report(eulaAccepted(paths) ? 'ok' : 'fail', 'EULA', eulaAccepted(paths) ? 'accepted' : 'run `pnpm run setup --accept-eula`');
  const mode = readModeState(paths);
  const testMode = (m: string) => (m === 'test' ? 'test mode on' : 'test mode off (hardcore)');
  const played = mode ? worldExists(paths, mode.levelName) : false;
  report(
    !mode ? 'fail' : mode.mode === world.mode ? 'ok' : played ? 'fail' : 'warn',
    'Mode',
    !mode
      ? 'run `pnpm run setup`'
      : mode.mode === world.mode
        ? `${testMode(world.mode)}, world "${mode.levelName}"`
        : played
          ? `config/world.yaml has ${testMode(world.mode)}, but world "${mode.levelName}" was played with ${testMode(mode.mode)}: \`pnpm test-mode ${world.mode === 'test' ? 'on' : 'off'} --new-world\` for a fresh world (the old one is kept), or \`pnpm test-mode ${world.mode === 'test' ? 'off' : 'on'}\` to keep it`
          : `config/world.yaml has ${testMode(world.mode)}; the server switches to it on the next start (world "${mode.levelName}" not played yet)`,
  );
  report(process.env.RCON_PASSWORD ? 'ok' : 'fail', 'RCON password', process.env.RCON_PASSWORD ? 'set in .env' : 'run `pnpm run setup`');

  // Agents' skins (§16.5): NameMC tags, owner-saved pages, MineSkin
  if (!world.skins.enabled) report('ok', 'Skins', 'off (skins.enabled: false): agents wear the default skin');
  else {
    const saved = Object.values(world.skins.tags).map((tag) => `${tag}: ${ownerSkinIds(path.join(paths.skins, 'namemc'), tag).length} saved`);
    const mineskin = getMineSkinKey() ? 'MineSkin key present (never logged)' : 'no MineSkin key: its anonymous limits apply';
    report('ok', 'Skins', `NameMC tags ${Object.values(world.skins.tags).join(', ')} (${saved.join(', ')}); ${mineskin}`);
  }

  // API key + subscription lock (§5, §22.1)
  const key = getNanoGptKey();
  if (!key) report('fail', 'NanoGPT key', 'NANOGPT_API_KEY is empty in .env');
  else {
    report('ok', 'NanoGPT key', 'present (never logged)');
    const lock = await checkSubscriptionLock(key, models);
    report(lock.status, 'Subscription lock', lock.detail);
  }
  const tiers = await checkTiers(models, key ?? undefined);
  report(tiers.status, 'Model tiers', tiers.detail);

  const icon: Record<Status, string> = { ok: ' OK ', warn: 'WARN', fail: 'FAIL' };
  for (const r of results) console.log(`[${icon[r.status]}] ${r.label.padEnd(18)} ${r.detail}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log(`\ndoctor: ${fails} failing, ${warns} warnings`);
  process.exitCode = fails > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(`[doctor] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
