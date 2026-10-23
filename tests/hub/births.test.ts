// M9b (§19.3, §19.4, §19.7) on the Hub's side: the rules for a birth (both partners' reports of the same night,
// room in the population, the couple's cooldown, nobody in their youth), and the supervisor acting on them with
// in-process stand-in bots: the child comes after gestation with its parents' traits, its starting knowledge on its
// first start, at the beds; a person playing as a partner is covered by our agent's report alone; a child on the way
// survives a restart; the child is drawn at conception and written by the master model while on the way (its birth
// waits for that a little). Nothing of this is ever sent to a bot except the child's own assignment.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type BirthFacts, HubConfigSchema, PersonaSchema, SeededRandom, SexDifferencesSchema, WorldConfigSchema, dataPaths, ensureDataDirs, nullLogger } from '@agora/shared';
import { HashEmbedder } from '@agora/llm';
import { type ConceptionReport, Hub, type Launcher, type PersonaSource, type RosterEntry, Supervisor, type WriteContext, loadRoster, matchReport, whyNoBirth } from '@agora/hub';
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

const persona = (name: string, sex: 'male' | 'female', familyName?: string) => PersonaSchema.parse({ id: name.toLowerCase(), name, sex, traits: ['kind'], ...(familyName ? { familyName } : {}) });
const bed = { x: 10, y: 64.56, z: -3 };

describe('the rules for a birth (§19.3)', () => {
  const report = (username: string, partner: string, at: number): ConceptionReport => ({ username, partner, partnerModel: {}, partnerSex: 'unknown', bedPos: bed, at });

  it('pairs the partners’ reports of the same night', () => {
    const reports = new Map([['Ivy', report('Ivy', 'Ned', 1000)]]);
    expect(matchReport(reports, report('Ned', 'Ivy', 2000))).toMatchObject({ username: 'Ivy' });
    expect(matchReport(reports, report('Ned', 'Ivy', 1000 + 16 * 60_000))).toBeNull(); // another night
    expect(matchReport(reports, report('Bo', 'Ivy', 2000))).toBeNull(); // Ivy lay beside Ned, not Bo
  });

  it('needs room in the population, the couple’s cooldown passed, and neither in their youth', () => {
    const w = (o: Record<string, unknown> = {}) => WorldConfigSchema.parse({ population: { initial: 2, minAlive: 2, maxAlive: 4 }, reproduction: { coupleCooldownSec: 100, youthSec: 50 }, ...o });
    const entry = (username: string, o: Partial<RosterEntry> = {}): RosterEntry => ({ username, persona: persona(username, 'male'), slot: username, bornAt: 0, status: 'alive', kitGiven: true, placed: true, ...o });
    const now = 1_000_000;
    const agents = [entry('Ned'), entry('Ivy')];
    const why = (o: { world?: ReturnType<typeof w>; agents?: RosterEntry[]; pending?: Parameters<typeof whyNoBirth>[0]['pending']; parents?: [string, string] } = {}) =>
      whyNoBirth({ world: o.world ?? w(), parents: o.parents ?? ['Ned', 'Ivy'], agents: o.agents ?? agents, pending: o.pending ?? [], now });
    expect(why()).toBeNull();
    expect(why({ world: w({ reproduction: { enabled: false } }) })).toMatch(/off/);
    expect(why({ agents: [...agents, entry('A'), entry('B')] })).toMatch(/maxAlive/);
    const coming = { parents: ['Ivy', 'Ned'] as [string, string], bedPos: bed, dueAt: now + 1, seen: {} };
    expect(why({ pending: [coming] })).toMatch(/already on the way/);
    expect(why({ agents: [...agents, entry('Lil', { parents: ['Ivy', 'Ned'], bornAt: now - 50_000 })] })).toMatch(/cooldown/);
    expect(why({ agents: [...agents, entry('Lil', { parents: ['Ivy', 'Ned'], bornAt: now - 200_000 })] })).toBeNull();
    // A child of theirs, still young, can't be a parent.
    const young = entry('Kid', { parents: ['A', 'B'], bornAt: now - 10_000 });
    expect(why({ agents: [...agents, young], parents: ['Kid', 'Ivy'] })).toMatch(/Kid too young/);
  });
});

describe('births in the supervisor (§19.3, §19.4)', () => {
  /** In-process stand-in bots that keep each assignment they get. */
  function fakeBots(hubUrl: () => string) {
    const live = new Map<string, { client: HubClient; exit: (code: number) => void; username?: string; birthFacts?: BirthFacts; spawnAt?: { x: number; y: number; z: number } }>();
    const launcher: Launcher = (slot) => {
      let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
      const c = new HubClient({ url: hubUrl(), slot, logger: nullLogger() });
      const exit = (code: number) => {
        live.delete(slot);
        c.close();
        setTimeout(() => onExit?.(code, null), 10);
      };
      live.set(slot, { client: c, exit });
      c.connect();
      void c.assigned().then((a) => {
        const me = live.get(slot);
        if (me) Object.assign(me, { username: a.username, ...(a.birthFacts ? { birthFacts: a.birthFacts } : {}), ...(a.spawnAt ? { spawnAt: a.spawnAt } : {}) });
        c.send({ t: 'ready', username: a.username });
      });
      c.on('shutdown', () => setTimeout(() => exit(0), 20));
      return { slot, pid: 1, kill: () => exit(137), onExit: (cb) => (onExit = cb) };
    };
    const bot = (name: string) => [...live.values()].find((b) => b.username === name);
    const conceive = (from: string, partner: string, partnerSex: 'male' | 'female' | 'unknown' = 'unknown', model: Record<string, number> = {}) =>
      bot(from)?.client.send({ t: 'conception', username: from, partner, partnerModel: model, partnerSex, bedPos: bed, ts: Date.now() });
    return { launcher, live, bot, conceive };
  }

  async function setup(o: { gestationSec?: number; maxAlive?: number; writer?: PersonaSource } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-births-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const paths = ensureDataDirs(dataPaths(dir));
    const world = WorldConfigSchema.parse({
      population: { initial: 2, minAlive: 2, maxAlive: o.maxAlive ?? 4, spawnStaggerSec: 0 },
      reproduction: { gestationSec: o.gestationSec ?? 0.2, coupleCooldownSec: 7200, youthSec: 1800 },
    });
    const hub = new Hub({ config: HubConfigSchema.parse({ hub: { host: '127.0.0.1', port: 8765 } }), logger: nullLogger(), embedder: new HashEmbedder(384), quota: () => null, runtimeHoursPerWeek: 30 });
    await hub.listen(0);
    cleanups.push(() => hub.close());
    const bots = fakeBots(() => `ws://127.0.0.1:${hub.port}`);
    const rcon: string[] = [];
    const mk = () =>
      new Supervisor({
        hub,
        paths,
        world,
        sexDiffs: SexDifferencesSchema.parse({}),
        pool: [persona('Ned', 'male', 'Stark'), persona('Ivy', 'female')],
        launcher: bots.launcher,
        logger: nullLogger(),
        rng: new SeededRandom(21),
        rcon: (cmd) => (rcon.push(cmd), Promise.resolve('')),
        ...(o.writer ? { writer: o.writer } : {}),
      });
    const sup = mk();
    cleanups.push(() => sup.shutdown('test', 2000));
    await sup.start();
    await until(() => bots.live.size === 2 && [...bots.live.values()].every((b) => b.username));
    return { paths, world, hub, bots, rcon, sup, mk };
  }

  it('brings a child after both partners report the bed ritual, with its parents’ traits, knowing its family, at their beds', async () => {
    const r = await setup();
    r.bots.conceive('Ned', 'Ivy', 'female');
    await wait(400);
    expect(r.sup.living).toHaveLength(2); // one report: waiting for Ivy's
    r.bots.conceive('Ivy', 'Ned', 'male');
    await until(() => r.sup.living.length === 3, 5000);
    const child = r.sup.living.find((a) => a.parents);
    expect(child?.parents?.slice().sort()).toEqual(['Ivy', 'Ned']);
    expect(child?.persona).toMatchObject({ source: 'born', generation: 1, familyName: 'Stark', inventory: [] });
    expect(child?.username).toMatch(/_S$/);
    expect(child?.spawnAt).toEqual(bed);
    // Its first assignment carries what it starts out knowing and where it appears; it is put there once ready.
    await until(() => Boolean(r.bots.bot(child?.username ?? '')?.birthFacts));
    const b = r.bots.bot(child?.username ?? '');
    expect(b?.birthFacts?.parents.map((p) => [p.username, p.sex]).sort()).toEqual([
      ['Ivy', 'female'],
      ['Ned', 'male'],
    ]);
    expect(b?.birthFacts).toMatchObject({ siblings: [], home: bed, familyName: 'Stark' });
    expect(b?.spawnAt).toEqual(bed);
    await until(() => r.rcon.some((c) => c.startsWith(`tp ${child?.username ?? ''} `)));
    expect(r.rcon).toContain(`tp ${child?.username ?? ''} 10.00 64.56 -3.00`);
    // No starter kit for a newborn.
    expect(r.rcon.some((c) => c.startsWith(`give ${child?.username ?? ''}`))).toBe(false);
    // The same couple again right away: not before their cooldown.
    r.bots.conceive('Ned', 'Ivy');
    r.bots.conceive('Ivy', 'Ned');
    await wait(500);
    expect(r.sup.living).toHaveLength(3);
    // The child, in its youth, can't be a parent.
    r.bots.conceive(child?.username ?? '', 'Someone');
    await wait(400);
    expect(r.sup.living).toHaveLength(3);
  }, 20_000);

  it('a partner who is a person playing (no bot of ours): our agent’s report is enough, and what it believes of them stands in', async () => {
    const r = await setup();
    r.bots.conceive('Ivy', 'Sam', 'male', { openness: 0.9 });
    await until(() => r.sup.living.length === 3, 5000);
    const child = r.sup.living.find((a) => a.parents);
    expect(child?.parents).toEqual(['Ivy', 'Sam']);
    expect(child?.birthFacts?.parents).toEqual([
      { username: 'Ivy', name: 'Ivy', sex: 'female' },
      { username: 'Sam', name: 'Sam', sex: 'male' },
    ]);
  }, 20_000);

  it('the child is drawn at conception and written by the master model while on the way; its birth waits for it', async () => {
    const asked: { draft: RosterEntry['persona']; ctx: WriteContext }[] = [];
    const writer: PersonaSource = {
      write: async (draft, ctx) => {
        asked.push({ draft, ctx });
        await wait(600); // longer than the gestation (0.2 s)
        return { ...draft, name: 'Wren_S', description: 'Wren has her father’s patience and her mother’s laugh.' };
      },
    };
    const r = await setup({ writer });
    r.bots.conceive('Ned', 'Ivy', 'female');
    r.bots.conceive('Ivy', 'Ned', 'male');
    // Drawn at once: its numbers from its parents, its name kept for it.
    await until(() => asked.length === 1);
    const drawn = loadRoster(r.paths.roster).pendingBirths[0]?.persona;
    expect(drawn).toMatchObject({ source: 'born', generation: 1, familyName: 'Stark' });
    expect(loadRoster(r.paths.roster).usedNames).toContain(drawn?.name);
    // The writer knows the parents, and the child's own name isn't taken from it.
    expect(asked[0]?.ctx.parents?.map((p) => p.name).sort()).toEqual(['Ivy', 'Ned']);
    expect(asked[0]?.ctx.takenNames.has(drawn?.name ?? '')).toBe(false);
    expect(asked[0]?.ctx.takenNames.has('Ned')).toBe(true);
    // Due before the writing is done: the birth waits for it.
    await wait(300);
    expect(r.sup.living).toHaveLength(2);
    await until(() => r.sup.living.length === 3, 5000);
    const child = r.sup.living.find((a) => a.parents);
    expect(child?.username).toBe('Wren_S');
    expect(child?.persona.description).toMatch(/^Wren has/);
    // The name drawn at first is let go (nobody ever had it); the child's is kept.
    const used = loadRoster(r.paths.roster).usedNames;
    expect(used).toContain('Wren_S');
    expect(used).not.toContain(drawn?.name);
  }, 20_000);

  it('a child on the way survives a restart, and no child comes when the population is full at birth', async () => {
    const r = await setup({ gestationSec: 2 });
    r.bots.conceive('Ned', 'Ivy');
    r.bots.conceive('Ivy', 'Ned');
    await until(() => loadRoster(r.paths.roster).pendingBirths.length === 1);
    await r.sup.shutdown('restart', 2000);
    expect(loadRoster(r.paths.roster).pendingBirths).toHaveLength(1);
    const sup2 = r.mk();
    cleanups.push(() => sup2.shutdown('test', 2000));
    await sup2.start();
    await until(() => sup2.living.length === 3, 8000);
    expect(loadRoster(r.paths.roster).pendingBirths).toEqual([]);

    const full = await setup({ maxAlive: 2 });
    full.bots.conceive('Ned', 'Ivy');
    full.bots.conceive('Ivy', 'Ned');
    await wait(600);
    expect(full.sup.living).toHaveLength(2);
    expect(loadRoster(full.paths.roster).pendingBirths).toEqual([]);
  }, 30_000);
});
