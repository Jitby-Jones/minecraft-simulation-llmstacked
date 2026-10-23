// `pnpm run setup [--accept-eula] [--skip-model]` (§23.1): pinned, hash-verified downloads into DATA_DIR,
// generated server files, RCON password in .env. (`pnpm setup` is a pnpm built-in, hence `pnpm run setup`.)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataPaths,
  ensureDataDirs,
  loadEnv,
  loadVersionsConfig,
  loadWorldConfig,
  repoRoot,
  setEnvValue,
} from '@agora/shared';
import {
  acceptEula,
  applyServerFiles,
  eulaAccepted,
  findJava,
  installEmbeddingModel,
  installGuardPlugin,
  installPaper,
  installSkinsPlugin,
  installProximityChat,
  writeInstallRecord,
} from '@agora/hub';

const args = new Set(process.argv.slice(2));
const log = (msg: string): void => console.log(`[setup] ${msg}`);

async function main(): Promise<void> {
  const root = repoRoot();
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(root, '.env.example'), envFile);
    log('created .env from .env.example — put your NANOGPT_API_KEY there');
  }
  loadEnv(envFile);
  if (!process.env.RCON_PASSWORD) {
    const pw = crypto.randomBytes(18).toString('base64url');
    setEnvValue(envFile, 'RCON_PASSWORD', pw);
    process.env.RCON_PASSWORD = pw;
    log('generated RCON_PASSWORD into .env');
  }

  const versions = loadVersionsConfig();
  const world = loadWorldConfig();
  const paths = ensureDataDirs(dataPaths());
  log(`DATA_DIR = ${paths.root}`);

  const paper = await installPaper(versions, paths, log);
  const plugin = await installProximityChat(versions, paths, log);
  installGuardPlugin(versions, paths, !world.chat.allowPrivateMessages, log);
  installSkinsPlugin(versions, paths, world.skins.enabled, log);
  if (world.skins.enabled) {
    // Where the owner can drop NameMC pages saved from a browser, for when NameMC turns automated requests away.
    for (const tag of new Set(Object.values(world.skins.tags))) fs.mkdirSync(path.join(paths.skins, 'namemc', tag), { recursive: true });
    log(`agents' skins: NameMC tags ${Object.values(world.skins.tags).join(', ')}; saved pages go in ${path.join(paths.skins, 'namemc', '<tag>')}`);
  }
  if (!args.has('--skip-model')) await installEmbeddingModel(versions, paths, log);
  else log('skipping embedding model download (--skip-model); agents fall back to hashed embeddings');
  writeInstallRecord(paths, versions, paper, plugin);

  const applied = await applyServerFiles(paths, world, process.env.RCON_PASSWORD ?? '');
  if (!applied.ok) {
    console.error(`[setup] server files not written: ${applied.message}`);
    if (/--new-world/.test(applied.message)) {
      console.error(
        world.mode === 'live'
          ? '[setup] Test mode is off in config/world.yaml (hardcore): `pnpm test-mode off --new-world` starts a fresh hardcore world (the old one is kept), or `pnpm test-mode on` keeps playing this one.'
          : '[setup] Test mode is on in config/world.yaml: `pnpm test-mode on --new-world` starts a fresh world for it (the old one is kept), or `pnpm test-mode off` keeps this one.',
      );
    }
    process.exitCode = 1;
  } else log(`server files written: ${applied.message}`);

  if (args.has('--accept-eula')) {
    acceptEula(paths);
    log('Minecraft EULA accepted (https://aka.ms/MinecraftEULA)');
  } else if (!eulaAccepted(paths)) {
    log('NOTE: the Minecraft EULA is not accepted yet. Read https://aka.ms/MinecraftEULA, then run `pnpm run setup --accept-eula`.');
  }

  const java = findJava(versions.java.minMajor, world.server.javaPath);
  if (java.found) log(`Java OK: ${java.found.versionLine} (${java.found.path})`);
  else {
    const seen = java.probed.map((j) => `${j.major} at ${j.path}`).join(', ') || 'none';
    log(
      `WARNING: Paper ${versions.paper.version} needs Java ${versions.java.minMajor}+ (found: ${seen}). Install Temurin ` +
        `${versions.java.minMajor} and set JAVA_HOME, AGORA_JAVA or server.javaPath in config/world.yaml.`,
    );
  }
  log('done. Next: put NANOGPT_API_KEY in .env, then `pnpm run doctor` and `pnpm start`.');
}

main().catch((err: unknown) => {
  console.error(`[setup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
