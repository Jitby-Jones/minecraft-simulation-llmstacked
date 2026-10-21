// Rebuilds server-plugin/agora-guard/dist/agora-guard-<ver>.jar reproducibly (needs a JDK and a server that
// `pnpm run setup` + one boot have extracted, so the Paper API jar is on disk). Prints the new sha256 to pin
// in config/versions.yaml. Owners never need this: the built jar is committed and hash-checked by setup.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, loadVersionsConfig, repoRoot } from '@agora/shared';
import { hashFile } from '@agora/hub';

function findTool(name: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const home of [process.env.AGORA_JDK, process.env.JAVA_HOME].filter((v): v is string => Boolean(v))) {
    const p = path.join(home, 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  return exe;
}

function listJars(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listJars(full, out);
    else if (e.name.endsWith('.jar')) out.push(full);
  }
  return out;
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed (exit ${r.status})`);
}

const versions = loadVersionsConfig();
const pluginDir = path.join(repoRoot(), 'server-plugin', 'agora-guard');
const libs = listJars(path.join(dataPaths().server, 'libraries'));
if (!libs.some((j) => j.includes('paper-api'))) {
  console.error('paper-api jar not found under DATA_DIR/server/libraries: run `pnpm run setup` and boot the server once.');
  process.exit(1);
}
const build = path.join(pluginDir, 'build');
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(path.join(build, 'classes'), { recursive: true });
run(findTool('javac'), [
  '--release',
  '25',
  '-nowarn',
  '-cp',
  libs.join(path.delimiter),
  '-d',
  path.join(build, 'classes'),
  path.join(pluginDir, 'src', 'main', 'java', 'agora', 'guard', 'AgoraGuard.java'),
]);
fs.copyFileSync(path.join(pluginDir, 'src', 'main', 'resources', 'plugin.yml'), path.join(build, 'classes', 'plugin.yml'));
const out = path.join(pluginDir, 'dist', versions.guardPlugin.filename);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
run(findTool('jar'), ['--create', '--date=2026-01-01T00:00:00Z', '--no-manifest', '--file', out, '-C', path.join(build, 'classes'), '.']);
fs.rmSync(build, { recursive: true, force: true });
const sha = hashFile(out, 'sha256');
console.log(`built ${path.relative(repoRoot(), out)}\nsha256: ${sha}`);
if (sha !== versions.guardPlugin.sha256) console.log('NOTE: update guardPlugin.sha256 in config/versions.yaml to the value above.');
