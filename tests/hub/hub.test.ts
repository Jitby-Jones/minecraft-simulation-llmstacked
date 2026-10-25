// M5 (§3, §8, §16, §23.4): the Hub over a real WebSocket and the supervisor with in-process stand-in bots: rate
// tokens, the global speech guard, the shared embedder, budgets, persona assignment, death and replacement, the
// graveyard, graceful shutdown and resume from roster.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HubConfigSchema, type Persona, PersonaSchema, SeededRandom, SexDifferencesSchema, WorldConfigSchema, agentDbPath, dataPaths, ensureDataDirs, nullLogger } from '@agora/shared';
import { HashEmbedder } from '@agora/llm';
import { Hub, type Launcher, type PersonaSource, Supervisor, type WriteContext, loadRoster } from '@agora/hub';
import { HubClient } from '@agora/agent/hub/client';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await wait(10);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startHub(speechPerSec = 5, maxConcurrentFights = 2): Promise<Hub> {
  const hub = new Hub({
    config: HubConfigSchema.parse({ hub: { host: '127.0.0.1', port: 8765 }, speech: { globalPerSec: speechPerSec } }),
    logger: nullLogger(),
    embedder: new HashEmbedder(384),
    maxConcurrentFights,
  });
  await hub.listen(0);
  cleanups.push(() => hub.close());
  return hub;
}

function client(hub: Hub, slot: string): HubClient {
  const c = new HubClient({ url: `ws://127.0.0.1:${hub.port}`, slot, logger: nullLogger(), requestTimeoutMs: 3000 });
  c.connect();
  cleanups.push(() => c.close());
  return c;
}

const persona = (name: string, sex: 'male' | 'female') => PersonaSchema.parse({ id: name.toLowerCase(), name, sex, traits: ['kind'], inventory: [{ item: 'bread', qty: 2 }] });

describe('Hub protocol (§8)', () => {
  it('assigns, grants rate tokens, guards speech globally and embeds', async () => {
    const hub = await startHub(3);
    hub.on('hello', (s) => s.send({ t: 'assign', persona: persona('Ada', 'female'), username: 'Ada', resume: false, giveStarterKit: false }));
    const c = client(hub, 'a0');
    const a = await c.assigned();
    expect(a.username).toBe('Ada');
    await c.tokenSource().acquire(100, undefined, 'talking');
    expect(hub.counters.llmGranted).toBe(1);
    const grants = await Promise.all([1, 2, 3, 4, 5].map(() => c.speechToken()));
    expect(grants.filter(Boolean).length).toBe(3);
    const [v] = await c.embedder(384, 'hash').embed(['iron by the river']);
    expect(v?.length).toBe(384);
  });
});

describe('fight slots (§17.10 maxConcurrentFights)', () => {
  it('lets only so many fights run at once, and frees a slot when a fight ends or its bot goes away', async () => {
    const hub = await startHub(5, 2);
    let n = 0;
    hub.on('hello', (s) => s.send({ t: 'assign', persona: persona(`F${n}`, 'male'), username: `Fay${n++}`, resume: false, giveStarterKit: false }));
    const [a, b, c] = [client(hub, 'f0'), client(hub, 'f1'), client(hub, 'f2')];
    await Promise.all([a.assigned(), b.assigned(), c.assigned()]);
    expect(await a.fightSlot()).toBe(true);
    expect(await a.fightSlot()).toBe(true); // the same fight asking again
    expect(await b.fightSlot()).toBe(true);
    expect(await c.fightSlot()).toBe(false);
    a.fightDone();
    await wait(50);
    expect(await c.fightSlot()).toBe(true);
    b.close();
    await wait(100);
    expect(await a.fightSlot()).toBe(true);
  });

  it('is always granted without a Hub (the cap exists only across a population)', async () => {
    const lone = new HubClient({ url: 'ws://127.0.0.1:9', slot: 'x', logger: nullLogger(), requestTimeoutMs: 200 });
    expect(await lone.fightSlot()).toBe(true);
  });
});

describe('supervisor (§16.2, §16.3, §23.4)', () => {
  /** In-process stand-in bots: connect, say ready, die on request, exit on shutdown. */
  function fakeBots(hubUrl: () => string) {
    const live = new Map<string, { client: HubClient; exit: (code: number) => void; username?: string; resume?: boolean; shifts: number[] }>();
    const launcher: Launcher = (slot) => {
      let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
      const c = new HubClient({ url: hubUrl(), slot, logger: nullLogger() });
      const exit = (code: number) => {
        live.delete(slot);
        c.close();
        setTimeout(() => onExit?.(code, null), 10);
      };
      const shifts: number[] = [];
      c.on('cautionShift', (m) => shifts.push(m.shift));
      live.set(slot, { client: c, exit, shifts });
      c.connect();
      void c.assigned().then((a) => {
        const me = live.get(slot);
        if (me) {
          me.username = a.username;
          me.resume = a.resume;
        }
        c.send({ t: 'ready', username: a.username });
      });
      c.on('shutdown', () => {
        const me = live.get(slot);
        if (me?.username) c.send({ t: 'bye', username: me.username, reason: 'shutdown' });
        setTimeout(() => exit(0), 20);
      });
      return { slot, pid: 1, kill: () => exit(137), onExit: (cb) => (onExit = cb) };
    };
    return { launcher, live };
  }

  it('fills the population from the pool then generated personas, replaces the dead, archives them, and resumes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-sup-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const paths = ensureDataDirs(dataPaths(dir));
    const world = WorldConfigSchema.parse({ population: { initial: 3, minAlive: 3, maxAlive: 5, spawnStaggerSec: 0, respawnDelaySec: 0.1 } });
    const hub = await startHub();
    const kits: string[] = [];
    const bots = fakeBots(() => `ws://127.0.0.1:${hub.port}`);
    const mk = () =>
      new Supervisor({
        hub,
        paths,
        world,
        sexDiffs: SexDifferencesSchema.parse({}),
        pool: [persona('Ada', 'female'), persona('Bram', 'male')],
        launcher: bots.launcher,
        logger: nullLogger(),
        rng: new SeededRandom(5),
        rcon: (cmd) => {
          kits.push(cmd);
          return Promise.resolve('');
        },
      });
    const sup = mk();
    await sup.start();
    await until(() => bots.live.size === 3 && [...bots.live.values()].every((b) => b.username));
    const names = sup.living.map((a) => a.username);
    expect(names.slice(0, 2)).toEqual(['Ada', 'Bram']);
    expect(sup.living[2]?.persona.source).toBe('generated');
    await until(() => kits.length === 3);
    expect(kits.every((k) => /^give \w+ minecraft:bread 2$/.test(k))).toBe(true);

    // Bram dies: his memory goes to the graveyard and a newcomer with a new name takes the place.
    const bram = [...bots.live.entries()].find(([, b]) => b.username === 'Bram');
    expect(bram).toBeTruthy();
    const [bramSlot, bramBot] = bram as [string, { client: HubClient; exit: (c: number) => void }];
    fs.writeFileSync(agentDbPath(paths, 'Bram'), 'memories');
    bramBot.client.send({ t: 'died', username: 'Bram', cause: 'was slain by Zombie', pos: null, aliveSec: 60, inventory: [] });
    await wait(50);
    bramBot.exit(0);
    await until(() => sup.living.length === 3 && !sup.living.some((a) => a.username === 'Bram'));
    expect(fs.readdirSync(paths.graveyard).some((f) => f.startsWith('Bram-'))).toBe(true);
    expect(fs.existsSync(agentDbPath(paths, 'Bram'))).toBe(false);
    await until(() => bots.live.size === 3);
    expect([...bots.live.keys()]).not.toContain(bramSlot);
    const roster = loadRoster(paths.roster);
    expect(roster.usedNames).toContain('Bram');
    expect(roster.agents.find((a) => a.username === 'Bram')?.status).toBe('dead');

    // A crash is not a death: the same agent comes back.
    const ada = [...bots.live.entries()].find(([, b]) => b.username === 'Ada');
    ada?.[1].exit(1);
    await until(() => [...bots.live.values()].some((b) => b.username === 'Ada'), 8000);

    // Graceful shutdown writes the roster; a new supervisor resumes the same living agents.
    await sup.shutdown('test', 3000);
    expect(bots.live.size).toBe(0);
    const before = loadRoster(paths.roster);
    const living = before.agents.filter((a) => a.status === 'alive').map((a) => a.username);
    fs.writeFileSync(agentDbPath(paths, 'Ada'), 'memories');
    const sup2 = mk();
    await sup2.start();
    await until(() => bots.live.size === 3 && [...bots.live.values()].every((b) => b.username));
    const resumes = Object.fromEntries([...bots.live.values()].map((b) => [b.username ?? '', b.resume ?? false]));
    expect(Object.keys(resumes).sort()).toEqual([...living].sort());
    // Ada has a memory file to come back to; the others (no DB written here) start their memory afresh.
    expect(resumes.Ada).toBe(true);
    await sup2.shutdown('test', 3000);
  }, 30_000);

  it("with personas 'generated', every newcomer is drawn by code and written by the master model; if it fails, code's words stand", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-written-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const paths = ensureDataDirs(dataPaths(dir));
    const world = WorldConfigSchema.parse({ personas: 'generated', population: { initial: 3, minAlive: 3, maxAlive: 5, spawnStaggerSec: 0 } });
    const hub = await startHub();
    const bots = fakeBots(() => `ws://127.0.0.1:${hub.port}`);
    const asked: { draft: Persona; ctx: WriteContext }[] = [];
    const given = ['Oriel', 'Pell'];
    const writer: PersonaSource = {
      write: (draft, ctx) => {
        asked.push({ draft, ctx });
        const name = ctx.keepName ? draft.name : given[asked.length - 1];
        if (!name) return Promise.reject(new Error('the model is away'));
        return Promise.resolve({ ...draft, name, description: `${name} came over the hills.` });
      },
    };
    const sup = new Supervisor({ hub, paths, world, sexDiffs: SexDifferencesSchema.parse({}), pool: [persona('Ada', 'female'), persona('Bram', 'male')], launcher: bots.launcher, logger: nullLogger(), rng: new SeededRandom(5), writer });
    await sup.start();
    await until(() => bots.live.size === 3 && [...bots.live.values()].every((b) => b.username));
    // Nobody from the pool: each newcomer drawn by code and written, told who is here and every name taken.
    expect(sup.living.map((a) => a.username).slice(0, 2)).toEqual(['Oriel', 'Pell']);
    expect(sup.living.every((a) => a.persona.source === 'generated')).toBe(true);
    expect(sup.living[0]?.persona.description).toBe('Oriel came over the hills.');
    expect(asked[1]?.ctx.living.map((p) => p.name)).toEqual(['Oriel']);
    expect(asked[1]?.ctx.takenNames.has('Oriel')).toBe(true);
    // The third: the model was away, so code drew and worded it.
    expect(sup.living[2]?.persona).toEqual(asked[2]?.draft);
    // The operator's name is kept, and is told to the writer as such.
    const added = await sup.addAgent({ name: 'Zed' });
    expect(typeof added === 'string' ? added : added.username).toBe('Zed');
    expect(asked[3]?.ctx.keepName).toBe(true);
    // Two asked for at once with room for one (each written first): just the one comes in.
    const both = await Promise.all([sup.addAgent(), sup.addAgent()]);
    expect(both.filter((x) => typeof x === 'string')).toEqual([expect.stringMatching(/maxAlive/)]);
    expect(sup.living).toHaveLength(5);
    await sup.shutdown('test', 3000);
  }, 30_000);

  it('applies the extinction brake (§17.10): too many deaths in an hour make every agent more careful for a while', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-brake-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const paths = ensureDataDirs(dataPaths(dir));
    const world = WorldConfigSchema.parse({
      population: { initial: 3, minAlive: 3, maxAlive: 5, spawnStaggerSec: 0, respawnDelaySec: 0.1 },
      conflict: { extinctionBrake: { deathsPerHourMax: 1, cautionShift: 0.25, durationSec: 600 } },
    });
    const hub = await startHub();
    const bots = fakeBots(() => `ws://127.0.0.1:${hub.port}`);
    const sup = new Supervisor({ hub, paths, world, sexDiffs: SexDifferencesSchema.parse({}), pool: [], launcher: bots.launcher, logger: nullLogger(), rng: new SeededRandom(7) });
    await sup.start();
    await until(() => bots.live.size === 3 && [...bots.live.values()].every((b) => b.username));
    const firstThree = [...bots.live.values()];
    const die = async (bot: (typeof firstThree)[number] | undefined) => {
      if (!bot?.username) throw new Error('no bot');
      bot.client.send({ t: 'died', username: bot.username, cause: 'was slain by Zombie', pos: null, aliveSec: 60, inventory: [] });
      await wait(50);
      bot.exit(0);
    };
    // One death is within the limit: nobody is told anything.
    await die(firstThree[0]);
    await wait(100);
    expect(firstThree.every((b) => b.shifts.length === 0)).toBe(true);
    // A second in the hour trips the brake: every living agent gets the same shift for the next ten minutes.
    await die(firstThree[1]);
    const survivor = firstThree[2];
    await until(() => (survivor?.shifts.length ?? 0) > 0);
    expect(survivor?.shifts).toEqual([0.25]);
    // A newcomer born during it is told too, when it is ready.
    await until(() => [...bots.live.values()].filter((b) => !firstThree.includes(b) && b.username).length >= 1);
    const newcomer = [...bots.live.values()].find((b) => !firstThree.includes(b) && b.username);
    await until(() => (newcomer?.shifts.length ?? 0) > 0);
    expect(newcomer?.shifts).toEqual([0.25]);
    await sup.shutdown('test', 3000);
  }, 30_000);
});
