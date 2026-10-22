// Installs the pinned Paper jar, ProximityChat! and the local embedding model (§23.1 `pnpm run setup`).

import fs from 'node:fs';
import path from 'node:path';
import { type DataPaths, type VersionsConfig, repoRoot, writeFileAtomic } from '@agora/shared';
import { downloadVerified, fetchJson, fileMatches, hashFile } from './download';

interface FillBuild {
  id: number;
  channel: string;
  downloads: Record<string, { name: string; checksums: { sha256: string }; size: number; url: string }>;
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  files: { filename: string; url: string; hashes: { sha512: string; sha1: string } }[];
}

export interface InstallRecord {
  paperJar: string;
  paperSha256: string;
  paperVersion: string;
  paperBuild: number;
  pluginJar: string;
  pluginSha512: string;
  installedAt: number;
}

export function installRecordPath(paths: DataPaths): string {
  return path.join(paths.server, '.agora-install.json');
}

export function readInstallRecord(paths: DataPaths): InstallRecord | null {
  const file = installRecordPath(paths);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as InstallRecord;
  } catch {
    return null;
  }
}

export function paperJarName(v: VersionsConfig): string {
  return `paper-${v.paper.version}-${v.paper.build}.jar`;
}

export async function installPaper(
  v: VersionsConfig,
  paths: DataPaths,
  log: (msg: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const dest = path.join(paths.server, paperJarName(v));
  if (fileMatches(dest, 'sha256', v.paper.sha256)) {
    log(`Paper ${v.paper.version} build ${v.paper.build}: already installed (sha256 ok)`);
    return dest;
  }
  const api = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(v.paper.version)}/builds/${v.paper.build}`;
  const build = await fetchJson<FillBuild>(api, fetchImpl);
  const dl = build.downloads['server:default'];
  if (!dl) throw new Error(`PaperMC API has no server:default download for ${v.paper.version} build ${v.paper.build}`);
  if (dl.checksums.sha256 !== v.paper.sha256) {
    throw new Error(
      `PaperMC reports sha256 ${dl.checksums.sha256} for build ${v.paper.build}, but config/versions.yaml pins ` +
        `${v.paper.sha256}. Refusing to continue (§23.1).`,
    );
  }
  log(`Downloading ${dl.name} (${(dl.size / 1e6).toFixed(1)} MB) from PaperMC…`);
  await downloadVerified(dl.url, dest, 'sha256', v.paper.sha256, fetchImpl);
  log(`Paper verified: sha256 ${v.paper.sha256.slice(0, 16)}…`);
  return dest;
}

export async function installProximityChat(
  v: VersionsConfig,
  paths: DataPaths,
  log: (msg: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const dest = path.join(paths.plugins, v.proximityChat.filename);
  if (fileMatches(dest, 'sha512', v.proximityChat.sha512)) {
    log(`ProximityChat! ${v.proximityChat.filename}: already installed (sha512 ok)`);
    return dest;
  }
  const meta = await fetchJson<ModrinthVersion>(
    `https://api.modrinth.com/v2/version/${encodeURIComponent(v.proximityChat.versionId)}`,
    fetchImpl,
  );
  if (!meta.game_versions.includes(v.minecraft.version)) {
    log(`warning: Modrinth does not list ${v.minecraft.version} for ProximityChat! ${meta.version_number}`);
  }
  const file = meta.files.find((f) => f.filename === v.proximityChat.filename);
  if (!file) throw new Error(`Modrinth version ${v.proximityChat.versionId} has no file ${v.proximityChat.filename}`);
  if (file.hashes.sha512 !== v.proximityChat.sha512) {
    throw new Error(`Modrinth sha512 for ${file.filename} differs from the pinned value. Refusing to continue (§23.1).`);
  }
  log(`Downloading ${file.filename} from Modrinth…`);
  await downloadVerified(file.url, dest, 'sha512', v.proximityChat.sha512, fetchImpl);
  log('ProximityChat! verified (sha512).');
  return dest;
}

export function guardPluginSource(v: VersionsConfig): string {
  return path.join(repoRoot(), 'server-plugin', 'agora-guard', 'dist', v.guardPlugin.filename);
}

export function skinsPluginSource(v: VersionsConfig): string {
  return path.join(repoRoot(), 'server-plugin', 'agora-skins', 'dist', v.skinsPlugin.filename);
}

/** Copies one of our own committed plugin jars into the server (hash-checked like any download), or removes it. */
function installOwnPlugin(src: string, pin: { filename: string; sha256: string }, paths: DataPaths, enabled: boolean, rebuild: string): string | null {
  const dest = path.join(paths.plugins, pin.filename);
  if (!enabled) {
    if (fs.existsSync(dest)) fs.rmSync(dest);
    return null;
  }
  if (!fileMatches(src, 'sha256', pin.sha256)) {
    throw new Error(`${src} is missing or its sha256 differs from config/versions.yaml (rebuild with \`${rebuild}\`)`);
  }
  if (!fileMatches(dest, 'sha256', pin.sha256)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return dest;
}

/**
 * Installs (or removes) our guard plugin that disables private chat commands for non-ops (§15.3).
 * The jar is built from server-plugin/agora-guard and committed; its hash is pinned like any download.
 */
export function installGuardPlugin(
  v: VersionsConfig,
  paths: DataPaths,
  enabled: boolean,
  log: (msg: string) => void,
): string | null {
  const dest = installOwnPlugin(guardPluginSource(v), v.guardPlugin, paths, enabled, 'pnpm build:guard-plugin');
  log(dest ? 'guard plugin installed: private chat commands disabled for non-ops' : 'guard plugin not installed (chat.allowPrivateMessages: true)');
  return dest;
}

/** Installs (or removes) our plugin that puts each agent's skin on it as it logs in (§16.5, skins.enabled). */
export function installSkinsPlugin(v: VersionsConfig, paths: DataPaths, enabled: boolean, log: (msg: string) => void): string | null {
  const dest = installOwnPlugin(skinsPluginSource(v), v.skinsPlugin, paths, enabled, 'pnpm build:skins-plugin');
  log(dest ? "skins plugin installed: agents log in wearing their skins" : 'skins plugin not installed (skins.enabled: false)');
  return dest;
}

export function embeddingModelDir(paths: DataPaths, v: VersionsConfig): string {
  return path.join(paths.cache, 'models', ...v.embeddingModel.id.split('/'));
}

export async function installEmbeddingModel(
  v: VersionsConfig,
  paths: DataPaths,
  log: (msg: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const dir = embeddingModelDir(paths, v);
  for (const f of v.embeddingModel.files) {
    const url = `https://huggingface.co/${v.embeddingModel.id}/resolve/${v.embeddingModel.revision}/${f.path}`;
    const r = await downloadVerified(url, path.join(dir, ...f.path.split('/')), 'sha256', f.sha256, fetchImpl);
    log(`embedding model ${f.path}: ${r}`);
  }
  return dir;
}

export function writeInstallRecord(paths: DataPaths, v: VersionsConfig, paperJar: string, pluginJar: string): InstallRecord {
  const rec: InstallRecord = {
    paperJar: path.basename(paperJar),
    paperSha256: hashFile(paperJar, 'sha256'),
    paperVersion: v.paper.version,
    paperBuild: v.paper.build,
    pluginJar: path.basename(pluginJar),
    pluginSha512: hashFile(pluginJar, 'sha512'),
    installedAt: Date.now(),
  };
  writeFileAtomic(installRecordPath(paths), JSON.stringify(rec, null, 2));
  return rec;
}

export interface InstallCheck {
  ok: boolean;
  problems: string[];
}

/** Startup check (§15.4): the Paper version is the pinned one and the ProximityChat! jar is present and intact. */
export function verifyInstall(paths: DataPaths, v: VersionsConfig, guardEnabled = true, skinsEnabled = false): InstallCheck {
  const problems: string[] = [];
  const guard = path.join(paths.plugins, v.guardPlugin.filename);
  if (guardEnabled && !fileMatches(guard, 'sha256', v.guardPlugin.sha256)) {
    problems.push(`guard plugin missing or modified: ${guard} (run \`pnpm run setup\`)`);
  }
  const skins = path.join(paths.plugins, v.skinsPlugin.filename);
  if (skinsEnabled && !fileMatches(skins, 'sha256', v.skinsPlugin.sha256)) {
    problems.push(`skins plugin missing or modified: ${skins} (run \`pnpm run setup\`)`);
  }
  const jar = path.join(paths.server, paperJarName(v));
  if (!fs.existsSync(jar)) problems.push(`Paper jar missing: ${jar} (run \`pnpm run setup\`)`);
  else if (!fileMatches(jar, 'sha256', v.paper.sha256)) problems.push(`Paper jar hash differs from config/versions.yaml`);
  const plugin = path.join(paths.plugins, v.proximityChat.filename);
  if (!fs.existsSync(plugin)) problems.push(`ProximityChat! jar missing: ${plugin} (run \`pnpm run setup\`)`);
  else if (!fileMatches(plugin, 'sha512', v.proximityChat.sha512)) problems.push('ProximityChat! jar hash differs from config/versions.yaml');
  const otherPaper = fs.existsSync(paths.server)
    ? fs.readdirSync(paths.server).filter((f) => /^paper-.*\.jar$/.test(f) && f !== paperJarName(v))
    : [];
  if (otherPaper.length > 0) problems.push(`unpinned Paper jars present: ${otherPaper.join(', ')}`);
  return { ok: problems.length === 0, problems };
}
