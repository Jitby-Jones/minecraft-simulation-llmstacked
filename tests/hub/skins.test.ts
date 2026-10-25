// §16.5 agents' skins: NameMC listings (fetched, or saved by the owner when NameMC turns us away), skin images,
// MineSkin's signed copies, the choice by sex, skins.tsv for the plugin, and the supervisor dressing each new
// agent before it first logs in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HubConfigSchema, PersonaSchema, SeededRandom, SexDifferencesSchema, WorldConfigSchema, dataPaths, ensureDataDirs, nullLogger, type Logger } from '@agora/shared';
import { HashEmbedder } from '@agora/llm';
import {
  type AgentSkin,
  Hub,
  type Launcher,
  MineSkinClient,
  MineSkinError,
  NameMcBlockedError,
  SkinImageError,
  SkinService,
  type SkinSource,
  Supervisor,
  fetchSkinImage,
  fetchTagPage,
  isChallenge,
  isSkinPng,
  loadRoster,
  ownerSkinIds,
  pngSize,
  skinIdsIn,
  skinIdsInList,
  skinsTsv,
} from '@agora/hub';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A PNG's first bytes: the signature and the IHDR chunk (what the checks read). */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(40)]);
}

const ID = (n: number) => n.toString(16).padStart(16, 'a');

/** A tag listing as NameMC lays it out: a card per skin, linking to its page, with a 3D render of it. */
function listing(ids: string[]): string {
  const cards = ids.map(
    (id) =>
      `<div class="col-4 col-md-2"><a href="/skin/${id}"><div class="card mb-2"><img class="drop-shadow" src="https://s.namemc.com/3d/skin/body.png?id=${id}&amp;model=classic&amp;width=150&amp;height=200" alt="Minecraft skin"></div></a></div>`,
  );
  return `<!DOCTYPE html><html><head><title>Boy Minecraft Skins | NameMC</title></head><body><a href="/profile/Notch.1"><img src="https://s.namemc.com/2d/skin/face.png?id=069a79f444e94726a5befca90e38aaf5&amp;scale=4"></a>${cards.join('')}<a href="?page=2">Next</a></body></html>`;
}

const CHALLENGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>';

function textures(url: string, model?: 'slim'): string {
  return Buffer.from(JSON.stringify({ timestamp: 1, profileId: 'x', profileName: 'y', textures: { SKIN: { url, ...(model ? { metadata: { model } } : {}) } } })).toString('base64');
}

/** MineSkin's reply to a generate request. */
function generated(n: number, variant: 'classic' | 'slim' = 'classic', next = 6000): unknown {
  const url = `https://textures.minecraft.net/texture/${n.toString(16).padStart(64, '0')}`;
  return {
    success: true,
    skin: { uuid: 'u', variant, visibility: 'unlisted', texture: { data: { value: textures(url), signature: `c2lnbmF0dXJl${n}` }, url: { skin: url }, hash: { skin: 'h' } } },
    rateLimit: { next: { absolute: 0, relative: next }, delay: { millis: next, seconds: next / 1000 } },
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const bodyOf = (init: RequestInit | undefined): string => (typeof init?.body === 'string' ? init.body : '');

/** A stand-in for the network: NameMC's pages and images, MineSkin's generate endpoint. */
function network(o: { pages?: Record<string, string[] | 'blocked'>; images?: Record<string, Buffer>; mineskin?: (n: number, body: { url: string; name: string; visibility: string }) => { status: number; body: unknown; headers?: Record<string, string> } }) {
  const calls: Call[] = [];
  let signed = 0;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const u = new URL(url);
    const respond = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => Promise.resolve(new Response(body, { status, headers }));
    if (u.hostname === 'namemc.com') {
      const tag = decodeURIComponent(u.pathname.replace('/minecraft-skins/tag/', ''));
      const page = Number(u.searchParams.get('page') ?? '1');
      const p = o.pages?.[`${tag}:${page}`] ?? o.pages?.[tag];
      if (p === 'blocked') return respond(403, CHALLENGE, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      return respond(200, listing(page === 1 || o.pages?.[`${tag}:${page}`] ? (p ?? []) : []), { 'content-type': 'text/html' });
    }
    if (u.hostname === 's.namemc.com') {
      const id = u.pathname.replace('/i/', '').replace('.png', '');
      return respond(200, o.images?.[id] ?? png(64, 64), { 'content-type': 'image/png' });
    }
    if (u.hostname === 'api.mineskin.org') {
      signed++;
      const body = JSON.parse(bodyOf(init)) as { url: string; name: string; visibility: string };
      const r = o.mineskin?.(signed, body) ?? { status: 200, body: generated(signed) };
      return respond(r.status, JSON.stringify(r.body), { 'content-type': 'application/json', ...(r.headers ?? {}) });
    }
    return Promise.reject(new Error(`unexpected request to ${url}`));
  }) as typeof fetch;
  return { fetchImpl, calls, signedCount: () => signed };
}

/** A logger that keeps what was warned. */
function warnings(): { logger: Logger; warned: string[] } {
  const warned: string[] = [];
  const logger = { ...nullLogger(), warn: (_o: unknown, msg?: string) => void warned.push(msg ?? '') } as unknown as Logger;
  return { logger, warned };
}

describe('NameMC (§16.5)', () => {
  it('reads the skin ids off a tag listing, in page order, each once; a 32-digit profile id is not one', () => {
    const ids = [ID(1), ID(2), ID(3)];
    expect(skinIdsIn(listing(ids))).toEqual(ids);
    expect(skinIdsIn(listing([ID(1), ID(2), ID(1)]))).toEqual([ID(1), ID(2)]);
    expect(skinIdsIn('<img src="https://s.namemc.com/2d/skin/face.png?id=069a79f444e94726a5befca90e38aaf5&scale=4">')).toEqual([]);
  });

  it("reads the owner's lists: NameMC skin links or bare ids, one a line", () => {
    const text = `# boys I like\nhttps://namemc.com/skin/${ID(7)}\n  ${ID(8)}  \nnot an id\nhttps://namemc.com/skin/${ID(7)}\n`;
    expect(skinIdsInList(text)).toEqual([ID(7), ID(8)]);
  });

  it("tells a Cloudflare challenge from the page", () => {
    expect(isChallenge(403, new Headers(), CHALLENGE)).toBe(true);
    expect(isChallenge(200, new Headers({ 'cf-mitigated': 'challenge' }), '')).toBe(true);
    expect(isChallenge(200, new Headers(), listing([ID(1)]))).toBe(false);
    expect(isChallenge(403, new Headers(), '<html>Forbidden</html>')).toBe(false);
  });

  it('fetches a page of a listing as NameMC serves it, says so when it is turned away, and never follows a redirect', async () => {
    const net = network({ pages: { boy: [ID(1), ID(2)], girl: 'blocked' } });
    expect(await fetchTagPage('boy', 1, net.fetchImpl)).toEqual([ID(1), ID(2)]);
    expect(net.calls[0]?.url).toBe('https://namemc.com/minecraft-skins/tag/boy');
    expect(net.calls[0]?.init?.redirect).toBe('manual');
    expect(new Headers(net.calls[0]?.init?.headers).get('user-agent')).toMatch(/^agora-skins\//);
    await expect(fetchTagPage('girl', 2, net.fetchImpl)).rejects.toBeInstanceOf(NameMcBlockedError);
    expect(net.calls[1]?.url).toBe('https://namemc.com/minecraft-skins/tag/girl?page=2');
  });

  it("takes the owner's saved pages and lists from the tag's folder, in file-name order", () => {
    const dir = tmp('agora-skins-owner-');
    fs.mkdirSync(path.join(dir, 'boy'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'boy', 'b-page2.html'), listing([ID(3), ID(4)]));
    fs.writeFileSync(path.join(dir, 'boy', 'a-page1.htm'), listing([ID(1), ID(3)]));
    fs.writeFileSync(path.join(dir, 'boy', 'c-mine.txt'), `${ID(9)}\n`);
    fs.writeFileSync(path.join(dir, 'boy', 'notes.md'), ID(5));
    expect(ownerSkinIds(dir, 'boy')).toEqual([ID(1), ID(3), ID(4), ID(9)]);
    expect(ownerSkinIds(dir, 'girl')).toEqual([]);
  });

  it('accepts only a 64×64 or 64×32 PNG as a skin, and only from the image host', async () => {
    expect(pngSize(png(64, 32))).toEqual({ width: 64, height: 32 });
    expect(isSkinPng(png(64, 64))).toBe(true);
    expect(isSkinPng(png(64, 32))).toBe(true);
    expect(isSkinPng(png(128, 128))).toBe(false);
    expect(isSkinPng(Buffer.from('GIF89a......................'))).toBe(false);
    const net = network({ images: { [ID(2)]: Buffer.alloc(0) } });
    expect(isSkinPng(await fetchSkinImage(ID(1), net.fetchImpl))).toBe(true);
    expect(net.calls[0]?.url).toBe(`https://s.namemc.com/i/${ID(1)}.png`);
    expect(net.calls[0]?.init?.redirect).toBe('error');
    await expect(fetchSkinImage(ID(2), net.fetchImpl)).rejects.toBeInstanceOf(SkinImageError);
    await expect(fetchSkinImage('../../etc/passwd', net.fetchImpl)).rejects.toThrow(/not a NameMC skin id/);
  });
});

describe('MineSkin (§16.5)', () => {
  function client(net: ReturnType<typeof network>, key: string | null = null) {
    const t = { now: 1_000_000 };
    const slept: number[] = [];
    const c = new MineSkinClient({
      key,
      userAgent: 'agora-skins/test',
      fetchImpl: net.fetchImpl,
      now: () => t.now,
      sleep: (ms) => {
        slept.push(ms);
        t.now += ms;
        return Promise.resolve();
      },
    });
    return { c, slept };
  }

  it('signs a skin PNG sent as a data URL, without a key unless there is one, and paces requests as told', async () => {
    const net = network({ mineskin: (n) => ({ status: 200, body: generated(n, n === 2 ? 'slim' : 'classic', 6000) }) });
    const { c, slept } = client(net);
    const [a, b] = await Promise.all([c.sign(png(64, 64), { name: 'agora boy x', visibility: 'unlisted' }), c.sign(png(64, 32), { name: 'agora girl y', visibility: 'unlisted' })]);
    expect(a.url).toMatch(/^https:\/\/textures\.minecraft\.net\/texture\/0+1$/);
    expect(a).toMatchObject({ variant: 'classic', signature: 'c2lnbmF0dXJl1' });
    expect(b.variant).toBe('slim');
    expect(slept).toEqual([6000]);
    const req = net.calls[0];
    const body = JSON.parse(bodyOf(req?.init)) as { url: string; visibility: string; name: string };
    expect(body.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(body).toMatchObject({ visibility: 'unlisted', name: 'agora boy x' });
    expect(new Headers(req?.init?.headers).get('authorization')).toBeNull();
    const keyed = network({});
    await client(keyed, 'mk_secret_key').c.sign(png(64, 64), { name: 'n', visibility: 'public' });
    expect(new Headers(keyed.calls[0]?.init?.headers).get('authorization')).toBe('Bearer mk_secret_key');
  });

  it('waits out a 429 and tries again; a rejected image is bad for good; a refused key is not, and the key is never in the error', async () => {
    const limited = network({ mineskin: (n) => (n === 1 ? { status: 429, body: { success: false, errors: [{ code: 'rate_limit' }] }, headers: { 'retry-after': '12' } } : { status: 200, body: generated(n) }) });
    const l = client(limited);
    expect((await l.c.sign(png(64, 64), { name: 'n', visibility: 'unlisted' })).url).toContain('textures.minecraft.net');
    expect(l.slept).toEqual([12_000]);
    const rejected = network({ mineskin: () => ({ status: 400, body: { success: false, errors: [{ code: 'invalid_image', message: 'Invalid image' }] } }) });
    const r = await client(rejected).c.sign(png(64, 64), { name: 'n', visibility: 'unlisted' }).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(MineSkinError);
    expect(r).toMatchObject({ badImage: true, message: 'MineSkin: 400 Invalid image' });
    const refused = network({ mineskin: () => ({ status: 401, body: { success: false, errors: [{ code: 'invalid_api_key' }] } }) });
    const k = await client(refused, 'mk_secret_key').c.sign(png(64, 64), { name: 'n', visibility: 'unlisted' }).catch((e: unknown) => e);
    expect(k).toMatchObject({ badImage: false });
    expect(String((k as Error).message)).toMatch(/MINESKIN_API_KEY/);
    expect(String((k as Error).message)).not.toContain('mk_secret_key');
    // A texture hosted anywhere but Mojang's texture server is no use to a client.
    const odd = network({ mineskin: () => ({ status: 200, body: { skin: { variant: 'classic', texture: { data: { value: 'YQ==', signature: 'Yg==' }, url: { skin: 'https://example.com/x.png' } } } } }) });
    await expect(client(odd).c.sign(png(64, 64), { name: 'n', visibility: 'unlisted' })).rejects.toBeInstanceOf(MineSkinError);
  });
});

describe('the skin service (§16.5)', () => {
  function service(net: ReturnType<typeof network>, o: { exclude?: string[]; logger?: Logger; dirs?: { owner: string; cache: string; plugin: string } } = {}) {
    const root = o.dirs ? null : tmp('agora-skins-');
    const dirs = o.dirs ?? { owner: path.join(root as string, 'skins'), cache: path.join(root as string, 'cache'), plugin: path.join(root as string, 'plugins', 'AgoraSkins') };
    const config = WorldConfigSchema.parse({ skins: { pages: 2, exclude: o.exclude ?? [] } }).skins;
    const s = new SkinService({ config, ownerDir: dirs.owner, cacheDir: dirs.cache, pluginDir: dirs.plugin, logger: o.logger ?? nullLogger(), rng: new SeededRandom(3), fetchImpl: net.fetchImpl, sleep: () => Promise.resolve() });
    return { s, dirs };
  }

  it("dresses a man from the boy tag and a woman from the girl tag, each in a skin no one living wears, signing each skin once", async () => {
    const boys = [ID(1), ID(2), ID(3)];
    const net = network({ pages: { boy: boys, girl: [ID(10)] }, mineskin: (n) => ({ status: 200, body: generated(n, 'slim') }) });
    const { s, dirs } = service(net);
    const bram = await s.skinFor('male', new Set());
    expect(bram).toMatchObject({ source: 'namemc', tag: 'boy', variant: 'slim' });
    expect(boys).toContain(bram?.id);
    expect(net.calls.some((c) => c.url === 'https://namemc.com/minecraft-skins/tag/boy')).toBe(true);
    const tom = await s.skinFor('male', new Set([bram?.id ?? '']));
    expect(tom?.id).not.toBe(bram?.id);
    const ivy = await s.skinFor('female', new Set());
    expect(ivy).toMatchObject({ tag: 'girl', id: ID(10) });
    // Everyone else already wears a boy's skin: one is worn twice rather than none, and that one is signed already.
    const signedBefore = net.signedCount();
    const ned = await s.skinFor('male', new Set(boys));
    expect(boys).toContain(ned?.id);
    // The cache holds the listing and the signed copies: a new service asks NameMC and MineSkin for nothing.
    const net2 = network({});
    const again = service(net2, { dirs });
    expect((await again.s.skinFor('male', new Set()))?.url).toMatch(/textures\.minecraft\.net/);
    expect(net2.calls.filter((c) => c.url.includes('namemc.com/minecraft-skins') || c.url.includes('mineskin'))).toEqual([]);
    expect(net.signedCount() - signedBefore).toBeLessThanOrEqual(1);
    expect(fs.existsSync(path.join(dirs.cache, 'library.json'))).toBe(true);
  });

  it("turned away by NameMC, uses what the owner saved, says once how to save it, and doesn't knock again for hours", async () => {
    const { logger, warned } = warnings();
    const net = network({ pages: { boy: 'blocked' } });
    const { s, dirs } = service(net, { logger });
    expect(await s.skinFor('male', new Set())).toBeNull();
    expect(warned.filter((w) => /turned away/.test(w))).toHaveLength(1);
    expect(warned[0]).toContain('https://namemc.com/minecraft-skins/tag/boy');
    expect(warned[0]).toContain(path.join(dirs.owner, 'namemc', 'boy'));
    fs.mkdirSync(path.join(dirs.owner, 'namemc', 'boy'), { recursive: true });
    fs.writeFileSync(path.join(dirs.owner, 'namemc', 'boy', 'saved.html'), listing([ID(5)]));
    const pages = net.calls.filter((c) => c.url.includes('/minecraft-skins/')).length;
    expect(await s.skinFor('male', new Set())).toMatchObject({ id: ID(5), tag: 'boy' });
    expect(net.calls.filter((c) => c.url.includes('/minecraft-skins/')).length).toBe(pages);
    expect(warned.filter((w) => /turned away/.test(w))).toHaveLength(1);
  });

  it('skips an image that is no skin, and one MineSkin rejects, for good; skips excluded ones; gives up after a few tries', async () => {
    const net = network({
      pages: { boy: [ID(1), ID(2), ID(3), ID(4)] },
      images: { [ID(1)]: Buffer.alloc(0) },
      mineskin: (_n, body) => (body.name.endsWith(ID(2)) ? { status: 400, body: { success: false, errors: [{ message: 'Invalid image' }] } } : { status: 200, body: generated(9) }),
    });
    const { s, dirs } = service(net, { exclude: [ID(3)] });
    const got = await s.skinFor('male', new Set());
    expect(got?.id).toBe(ID(4));
    const lib = JSON.parse(fs.readFileSync(path.join(dirs.cache, 'library.json'), 'utf8')) as { bad: Record<string, unknown> };
    expect(Object.keys(lib.bad).sort()).toEqual([ID(1), ID(2)]);
    // MineSkin down: no skin for now, and the skins stay usable for later.
    const down = network({ pages: { boy: [ID(6)] }, mineskin: () => ({ status: 503, body: 'down' }) });
    const d = service(down);
    expect(await d.s.skinFor('male', new Set())).toBeNull();
    expect(fs.existsSync(path.join(d.dirs.cache, 'library.json'))).toBe(true);
    expect((JSON.parse(fs.readFileSync(path.join(d.dirs.cache, 'library.json'), 'utf8')) as { bad: object }).bad).toEqual({});
  });

  it('writes skins.tsv for the plugin: who wears which signed textures', () => {
    const skin = (n: number): AgentSkin => ({ source: 'namemc', id: ID(n), tag: 'boy', variant: 'classic', url: 'u', value: `dmFs${n}`, signature: `c2ln${n}` });
    const text = skinsTsv([{ username: 'Tom', skin: skin(2) }, { username: 'Ada', skin: skin(1) }, { username: 'Nobody' }, { username: 'bad name', skin: skin(3) }]);
    expect(text.split('\n')).toEqual(['# agora-skins (DESIGN.md §16.5), written by the Hub: username, textures value, signature', 'Ada\tdmFs1\tc2ln1', 'Tom\tdmFs2\tc2ln2', '']);
    const net = network({});
    const { s, dirs } = service(net);
    s.publish([{ username: 'Ada', skin: skin(1) }]);
    expect(fs.readFileSync(path.join(dirs.plugin, 'skins.tsv'), 'utf8')).toContain('Ada\tdmFs1\tc2ln1');
  });
});

describe('the supervisor dresses each new agent before it first logs in (§16.5)', () => {
  async function startHub(): Promise<Hub> {
    const hub = new Hub({ config: HubConfigSchema.parse({ hub: { host: '127.0.0.1', port: 8765 } }), logger: nullLogger(), embedder: new HashEmbedder(384), maxConcurrentFights: 2 });
    await hub.listen(0);
    cleanups.push(() => hub.close());
    return hub;
  }
  const persona = (name: string, sex: 'male' | 'female') => PersonaSchema.parse({ id: name.toLowerCase(), name, sex, traits: ['kind'] });
  const skin = (id: string, tag: string): AgentSkin => ({ source: 'namemc', id, tag, variant: 'classic', url: `https://textures.minecraft.net/texture/${id}`, value: 'dmFs', signature: 'c2ln' });

  async function setup(skins: SkinSource, waitSec = 5, rcon?: (cmd: string) => Promise<string>) {
    const paths = ensureDataDirs(dataPaths(tmp('agora-sup-skins-')));
    const hub = await startHub();
    const launched: { slot: string; skin: string | null }[] = [];
    let sup: Supervisor | null = null;
    const launcher: Launcher = (slot) => {
      const entry = sup?.rosterSnapshot.agents.find((a) => a.slot === slot);
      launched.push({ slot, skin: entry?.skin?.id ?? null });
      return { slot, pid: 1, kill: () => undefined, onExit: () => undefined };
    };
    const world = WorldConfigSchema.parse({ population: { initial: 2, minAlive: 2, maxAlive: 4, spawnStaggerSec: 0 }, skins: { waitSec } });
    const mk = () =>
      new Supervisor({
        hub,
        paths,
        world,
        sexDiffs: SexDifferencesSchema.parse({}),
        pool: [persona('Bram', 'male'), persona('Ivy', 'female')],
        launcher,
        logger: nullLogger(),
        rng: new SeededRandom(5),
        skins,
        ...(rcon ? { rcon } : {}),
      });
    sup = mk();
    return { sup, launched, paths, mk: () => (sup = mk()) };
  }

  it("gives each its skin by sex before launching it, keeps it in the roster, and doesn't dress anyone twice", async () => {
    const asked: { sex: string; taken: string[] }[] = [];
    const published: string[][] = [];
    const skins: SkinSource = {
      skinFor: (sex, taken) => {
        asked.push({ sex, taken: [...taken] });
        return Promise.resolve(skin(sex === 'male' ? 'aaaaaaaaaaaaaaa1' : 'aaaaaaaaaaaaaaa2', sex === 'male' ? 'boy' : 'girl'));
      },
      publish: (entries) => void published.push(entries.filter((e) => e.skin).map((e) => `${e.username}:${e.skin?.id}`)),
    };
    const s = await setup(skins);
    await s.sup.start();
    expect(s.launched).toEqual([
      { slot: 'a0', skin: 'aaaaaaaaaaaaaaa1' },
      { slot: 'a1', skin: 'aaaaaaaaaaaaaaa2' },
    ]);
    expect(asked).toEqual([
      { sex: 'male', taken: [] },
      { sex: 'female', taken: ['aaaaaaaaaaaaaaa1'] },
    ]);
    expect(published.at(-1)).toEqual(['Bram:aaaaaaaaaaaaaaa1', 'Ivy:aaaaaaaaaaaaaaa2']);
    expect(loadRoster(s.paths.roster).agents.map((a) => a.skin?.tag)).toEqual(['boy', 'girl']);
    // A new start resumes them in the same skins, without asking for new ones.
    await s.sup.shutdown('test', 100);
    const again = s.mk();
    await again.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(2);
    expect(s.launched.slice(2).map((l) => l.skin).sort()).toEqual(['aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2']);
    await again.shutdown('test', 100);
  });

  it('a skin slow to come: the agent logs in without it and puts it on when it comes; none at all, it logs in plain', async () => {
    let release!: (s: AgentSkin) => void;
    const rcon: string[] = [];
    const skins: SkinSource = {
      skinFor: (sex) => (sex === 'male' ? new Promise((r) => (release = r)) : Promise.reject(new Error('NameMC unreachable'))),
      publish: () => undefined,
    };
    const s = await setup(skins, 0.05, (cmd) => {
      rcon.push(cmd);
      return Promise.resolve('');
    });
    await s.sup.start();
    expect(s.launched).toEqual([
      { slot: 'a0', skin: null },
      { slot: 'a1', skin: null },
    ]);
    release(skin('aaaaaaaaaaaaaaa1', 'boy'));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.sup.living.find((a) => a.username === 'Bram')?.skin?.id).toBe('aaaaaaaaaaaaaaa1');
    expect(rcon).toEqual(['agoraskins reload']);
    await s.sup.shutdown('test', 100);
  });
});
