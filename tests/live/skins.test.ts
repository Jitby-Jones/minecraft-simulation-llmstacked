// §16.5 live, on Paper 26.1.2: agents' skins. A NameMC skin for each by sex: from NameMC's "boy" and "girl"
// listings if NameMC serves them to us, otherwise from what the owner saved (here, one NameMC skin link for each
// tag). Each is signed through MineSkin (the real service) and put on by the agora-skins plugin as the player logs
// in; one dressed while online puts it on at once. What clients get is checked in another player's packets: the
// textures property, signed, and the signature good under Mojang's published keys, as a client checks it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubConfigSchema,
  type Logger,
  ModelsConfigSchema,
  SeededRandom,
  SexDifferencesSchema,
  WorldConfigSchema,
  createLogger,
  dataPaths,
  ensureDataDirs,
  getMineSkinKey,
  loadEnv,
  loadPersonaPool,
  loadVersionsConfig,
  nullLogger,
  sleep,
} from '@agora/shared';
import { type AgentSkin, Hub, type Launcher, SkinService, Supervisor, loadRoster, skinsPluginSource } from '@agora/hub';
import { type Bot, connectBody, disconnectBody } from '@agora/agent/body/bot';
import { type RunningBot, runBot } from '@agora/agent/hub/runtime';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
/** NameMC skins tagged "boy" and "girl" (namemc.com/skin/<id>), the owner's saved picks here. */
const BOY = '2316fdbaf24ee09d';
const GIRL = 'ab87de696cfca859';

interface Seen {
  value: string;
  signature: string | undefined;
}

/** The textures property of each player, as this bot's client receives it in player info. */
function watchTextures(bot: Bot): Map<string, Seen> {
  const seen = new Map<string, Seen>();
  bot._client.on('player_info', (packet: { action: { add_player?: boolean }; data: { player?: { name: string; properties?: { name: string; value: string; signature?: string }[] } }[] }) => {
    if (!packet.action.add_player) return;
    for (const item of packet.data) {
      const p = item.player;
      if (!p) continue;
      const t = p.properties?.find((x) => x.name === 'textures');
      if (t) seen.set(p.name, { value: t.value, signature: t.signature });
      else seen.delete(p.name);
    }
  });
  return seen;
}

/** Mojang's keys for profile properties: what a client checks a skin's signature against. */
async function mojangKeys(): Promise<crypto.KeyObject[]> {
  const res = await fetch('https://api.minecraftservices.com/publickeys');
  const body = (await res.json()) as { profilePropertyKeys: { publicKey: string }[] };
  return body.profilePropertyKeys.map((k) => crypto.createPublicKey({ key: Buffer.from(k.publicKey, 'base64'), format: 'der', type: 'spki' }));
}

const signedByMojang = (keys: crypto.KeyObject[], s: Seen | undefined) =>
  Boolean(s?.signature) && keys.some((k) => crypto.createVerify('RSA-SHA1').update(s?.value ?? '').verify(k, s?.signature ?? '', 'base64'));

/** The texture a URL on Mojang's texture server names (the signed payload says http://, MineSkin's field https://). */
const hashOf = (url: string | undefined) => url?.split('/texture/')[1];
/** The skin texture a player is seen in: from the textures property clients get. */
const texture = (s: Seen | undefined) =>
  hashOf(s ? (JSON.parse(Buffer.from(s.value, 'base64').toString('utf8')) as { textures?: { SKIN?: { url?: string } } }).textures?.SKIN?.url : undefined);

describe.skipIf(!liveJavaPath())('skins live: NameMC skins by sex, signed through MineSkin, on agents as they log in (§16.5)', () => {
  let server: LiveServer;
  const bots: Bot[] = [];

  beforeAll(async () => {
    loadEnv();
    server = await startLiveServer({ name: 'skins', port: 25600, rconPort: 25601, extraPlugins: [skinsPluginSource(versions)] });
  });

  afterAll(async () => {
    for (const b of bots) await disconnectBody(b);
    await server?.stop();
  });

  async function join(name: string): Promise<Bot> {
    const bot = await connectBody({ host: server.host, port: server.port, username: name, version: versions.minecraft.version });
    bots.push(bot);
    return bot;
  }

  it('a man wears a boy skin and a woman a girl skin as they log in; one dressed while online puts it on at once', async () => {
    const root = path.join(server.dir, '..', 'skins-data');
    for (const [tag, id] of [['boy', BOY], ['girl', GIRL]] as const) {
      fs.mkdirSync(path.join(root, 'skins', 'namemc', tag), { recursive: true });
      fs.writeFileSync(path.join(root, 'skins', 'namemc', tag, 'picks.txt'), `https://namemc.com/skin/${id}\n`);
    }
    const said: string[] = [];
    const note = (level: string) => (o: unknown, msg?: string) => void said.push(`${level}: ${msg ?? ''} ${JSON.stringify(o)}`);
    const logger = { ...nullLogger(), info: note('info'), warn: note('warn') } as unknown as Logger;
    const skins = new SkinService({
      config: WorldConfigSchema.parse({ skins: { pages: 1 } }).skins,
      ownerDir: path.join(root, 'skins'),
      cacheDir: path.join(root, 'cache'),
      pluginDir: path.join(server.dir, 'plugins', 'AgoraSkins'),
      logger,
      rng: new SeededRandom(1),
      mineskinKey: getMineSkinKey(),
    });
    const bram = (await skins.skinFor('male', new Set())) as AgentSkin;
    const ivy = (await skins.skinFor('female', new Set())) as AgentSkin;
    console.log(`[skins] what the service said:\n  ${said.join('\n  ')}`);
    expect(bram).toMatchObject({ source: 'namemc', tag: 'boy' });
    expect(ivy).toMatchObject({ source: 'namemc', tag: 'girl' });
    expect(bram.url).toMatch(/^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]+$/);
    // NameMC's listing, if it served it, or the owner's pick when it turned us away.
    const listed = said.some((s) => /NameMC listing read/.test(s));
    if (!listed) {
      expect(said.some((s) => /turned away/.test(s))).toBe(true);
      expect([bram.id, ivy.id]).toEqual([BOY, GIRL]);
    }
    skins.publish([
      { username: 'Bram', skin: bram },
      { username: 'Ivy', skin: ivy },
    ]);

    const keys = await mojangKeys();
    const obs = await join('Obs');
    const seen = watchTextures(obs);
    await join('Bram');
    await join('Ivy');
    await waitFor(() => texture(seen.get('Bram')) === hashOf(bram.url) && texture(seen.get('Ivy')) === hashOf(ivy.url), 20_000, 'Bram and Ivy seen in their skins', 250);
    expect(signedByMojang(keys, seen.get('Bram'))).toBe(true);
    expect(signedByMojang(keys, seen.get('Ivy'))).toBe(true);
    expect(seen.has('Obs')).toBe(false); // not an agent: no skin given
    console.log(`[skins] Bram in ${bram.id} (${bram.variant}), Ivy in ${ivy.id} (${ivy.variant}): ${bram.url}, ${ivy.url}`);

    // Tom logs in before his skin is ready, then gets it: on at once, for everyone who sees him.
    await join('Tom');
    await sleep(1500);
    expect(seen.has('Tom')).toBe(false);
    const tom = (await skins.skinFor('male', new Set([bram.id]))) as AgentSkin;
    expect(tom.tag).toBe('boy');
    skins.publish([
      { username: 'Bram', skin: bram },
      { username: 'Ivy', skin: ivy },
      { username: 'Tom', skin: tom },
    ]);
    expect(await server.cmd('agoraskins reload')).toMatch(/3 on file, 1 applied to players online/);
    await waitFor(() => texture(seen.get('Tom')) === hashOf(tom.url), 20_000, 'Tom seen in his skin', 250);
    expect(signedByMojang(keys, seen.get('Tom'))).toBe(true);

    // Only the console may reload: a player trying is told so.
    const told: string[] = [];
    obs.on('messagestr', (m: string) => void told.push(m));
    obs.chat('/agoraskins reload');
    await waitFor(() => told.some((m) => /permission|console|Unknown/i.test(m)), 10_000, 'the player refused', 250);
    console.log(`[skins] a player asking: "${told.find((m) => /permission|console|Unknown/i.test(m))}"`);
    for (const b of bots.splice(0)) await disconnectBody(b);
  }, 240_000);

  it('the supervisor dresses each agent it creates, by sex, before it first logs in', async () => {
    const root = path.join(server.dir, '..', 'skins-sup');
    fs.rmSync(root, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(root));
    for (const [tag, id] of [['boy', BOY], ['girl', GIRL]] as const) {
      fs.mkdirSync(path.join(paths.skins, 'namemc', tag), { recursive: true });
      fs.writeFileSync(path.join(paths.skins, 'namemc', tag, 'picks.txt'), `https://namemc.com/skin/${id}\n`);
    }
    const logger = createLogger({ name: 'skins-live', logDir: path.join(root, 'logs'), console: false });
    const hub = new Hub({ config: HubConfigSchema.parse({}), logger, embedder: null });
    await hub.listen(0);
    const w = WorldConfigSchema.parse({ population: { initial: 2, minAlive: 1, maxAlive: 4, spawnStaggerSec: 1, spawnRadius: 0 }, server: { host: '127.0.0.1', port: server.port }, skins: { pages: 1 } });
    const skins = new SkinService({ config: w.skins, ownerDir: paths.skins, cacheDir: path.join(paths.cache, 'skins'), pluginDir: path.join(server.dir, 'plugins', 'AgoraSkins'), logger, rng: new SeededRandom(2), mineskinKey: getMineSkinKey() });
    const running: RunningBot[] = [];
    const launcher: Launcher = (slot) => {
      let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
      let bot: RunningBot | null = null;
      void runBot({ hubUrl: `ws://127.0.0.1:${hub.port}`, slot, paths, world: w, versions, models: ModelsConfigSchema.parse({}), apiKey: '', logger }).then((b) => {
        bot = b;
        running.push(b);
        void b.done.then(() => exit?.(0, null));
      });
      return { slot, pid: undefined, kill: () => void bot?.stop('killed'), onExit: (cb) => (exit = cb) };
    };
    const pool = loadPersonaPool().filter((p) => ['pip', 'bram'].includes(p.id ?? ''));
    const sup = new Supervisor({ hub, paths, world: w, sexDiffs: SexDifferencesSchema.parse({}), pool, launcher, logger, rng: new SeededRandom(9), rcon: (c) => server.cmd(c), skins });
    const obs = await join('Watcher');
    const seen = watchTextures(obs);
    try {
      await sup.start();
      const roster = () => loadRoster(paths.roster).agents;
      await waitFor(() => roster().length === 2 && roster().every((a) => a.skin && texture(seen.get(a.username)) === hashOf(a.skin.url)), 120_000, 'both agents seen in their skins', 500);
      for (const a of roster()) {
        expect(a.skin?.tag).toBe(a.persona.sex === 'male' ? 'boy' : 'girl');
        console.log(`[skins] ${a.username} (${a.persona.sex}) created in NameMC skin ${a.skin?.id} (${a.skin?.tag}, ${a.skin?.variant})`);
      }
      const keys = await mojangKeys();
      expect(roster().every((a) => signedByMojang(keys, seen.get(a.username)))).toBe(true);
    } finally {
      await sup.shutdown('test', 20_000);
      for (const b of running) await b.stop('test over').catch(() => undefined);
      await hub.close();
    }
  }, 300_000);
});
