// Debug controls, the Hub's side: the operator's settings kept across restarts, the debug commands (`pnpm ctl` and the
// dashboard), a debug request's round trip to an agent over the Hub, and the supervisor adding, removing and
// restarting agents by name.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HubConfigSchema, PersonaSchema, SeededRandom, SexDifferencesSchema, WorldConfigSchema, dataPaths, ensureDataDirs, nullLogger } from '@agora/shared';
import { HashEmbedder } from '@agora/llm';
import { Hub, type Launcher, Supervisor, TuningStore, controlHandler, debugArgs } from '@agora/hub';
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
const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('the operator’s settings (TuningStore)', () => {
  it('everyone’s settings, one agent’s own on top; a change for everyone is a change for each; kept across restarts', () => {
    const file = path.join(tmp('agora-tuning-'), 'tuning.json');
    const t = new TuningStore(file);
    expect(t.for('Pip')).toEqual({ off: [], models: {}, tiers: {}, paused: false });
    t.setModule('Pip', 'romance', false);
    t.setModule('all', 'reflection', false);
    expect(t.for('Pip').off.sort()).toEqual(['reflection', 'romance']);
    expect(t.for('Bram').off).toEqual(['reflection']);
    t.setModule('all', 'reflection', true);
    expect(t.for('Pip').off).toEqual(['romance']);
    t.setModel('all', 'L2', 'p2-mid');
    t.setModel('Pip', 'L2', 'p3-mid');
    expect(t.for('Pip').models).toEqual({ L2: 'p3-mid' });
    expect(t.for('Bram').models).toEqual({ L2: 'p2-mid' });
    // For everyone: each agent's own setting of that tier gives way.
    t.setModel('all', 'L2', 'p1-mid');
    expect(t.for('Pip').models).toEqual({ L2: 'p1-mid' });
    t.setTier('all', 'talking', 'L3');
    t.setPaused('Bram', true);
    const again = new TuningStore(file);
    expect(again.for('Bram')).toEqual({ off: ['reflection'].filter(() => false), models: { L2: 'p1-mid' }, tiers: { talking: 'L3' }, paused: true });
    expect(again.for('Pip')).toMatchObject({ off: ['romance'], paused: false });
    again.reset('Pip');
    expect(again.for('Pip').off).toEqual([]);
    again.reset('all');
    expect(again.for('Bram')).toEqual({ off: [], models: {}, tiers: {}, paused: false });
  });
});

describe('debug commands', () => {
  it('reads key=value pairs (words after one belong to it) or one JSON object', () => {
    expect(debugArgs(['text=Mira', 'hid', 'iron', 'importance=0.8'])).toEqual({ text: 'Mira hid iron', importance: '0.8' });
    expect(debugArgs(['{"decision":{"option":"explore"}}'])).toEqual({ decision: { option: 'explore' } });
    expect(debugArgs(['look', 'at', 'the', 'well'])).toEqual({ text: 'look at the well' });
    expect(debugArgs([])).toEqual({});
  });

  it('switches, models, tiers and pause go to the agents; requests are passed through; bad input is refused', async () => {
    const tuning = new TuningStore(path.join(tmp('agora-ctl-'), 'tuning.json'));
    const sent: string[] = [];
    const requests: [string, string, Record<string, unknown>][] = [];
    const added: unknown[] = [];
    const handle = controlHandler({
      mode: () => 'live',
      startedAt: 0,
      supervisor: { living: [{ username: 'Pip', slot: 'a0', bornAt: 0 }, { username: 'Bram', slot: 'a1', bornAt: 0 }], targetPopulation: 2, setPopulation: () => undefined },
      online: () => new Set(['Pip']),
      snapshotAll: () => Promise.resolve(0),
      rcon: (c) => Promise.resolve(c === 'kill Bram' ? 'Killed Bram' : ''),
      serverState: () => 'running',
      quota: () => null,
      dashboardUrl: 'http://127.0.0.1:8080',
      setMode: (mode, newWorld) => Promise.resolve(newWorld || mode === 'test' ? { ok: true, message: `${mode} mode, world "w"` } : { ok: false, message: 'refusing to switch existing world "world" from test to live; pass --new-world' }),
      stop: () => undefined,
      restart: () => undefined,
      debug: {
        request: (name, op, args) => {
          requests.push([name, op, args]);
          return Promise.resolve({ ok: true, message: `${name} did ${op}` });
        },
        tuning,
        sendTuning: (scope) => sent.push(scope),
        addAgent: (o) => {
          added.push(o);
          return Promise.resolve(o.name === 'Bad Name' ? 'bad name' : { username: o.name ?? 'Newbie' });
        },
        retireAgent: (n) => (n === 'Pip' ? null : 'no'),
        restartAgent: () => null,
        personas: () => [{ id: 'mira', name: 'Mira', sex: 'female', traits: ['precise'] }],
        models: () => Promise.resolve([{ id: 'p1-mid', capabilities: ['structured_output'], thinking: false }]),
      },
    });
    expect(await handle('module', ['Pip', 'romance', 'off'])).toMatchObject({ ok: true, message: 'romance off for Pip' });
    expect(tuning.for('Pip').off).toEqual(['romance']);
    expect(await handle('module', ['Pip', 'teleport', 'off'])).toMatchObject({ ok: false });
    expect(await handle('module', ['Nobody', 'romance', 'off'])).toMatchObject({ ok: false, message: 'no living agent Nobody' });
    expect(await handle('model', ['all', 'L2', 'p1-mid'])).toMatchObject({ ok: true });
    expect(await handle('model', ['all', 'L2', 'openai/gpt-paid-only'])).toMatchObject({ ok: false, message: expect.stringContaining('not a subscription model') as string });
    expect(await handle('tier', ['Bram', 'talking', 'L3'])).toMatchObject({ ok: true });
    expect(tuning.for('Bram').tiers).toEqual({ talking: 'L3' });
    expect(await handle('pause', ['all'])).toMatchObject({ ok: true });
    expect(tuning.for('Pip').paused).toBe(true);
    expect(sent).toEqual(['Pip', 'all', 'Bram', 'all']);
    expect(await handle('agent', ['pip', 'memory.add', 'text=the', 'well', 'is', 'dry'])).toMatchObject({ ok: true, message: 'Pip did memory.add' });
    expect(requests).toEqual([['Pip', 'memory.add', { text: 'the well is dry' }]]);
    expect(await handle('add', ['mira', '--sex', 'female'])).toMatchObject({ ok: true });
    expect(added).toEqual([{ persona: 'mira', sex: 'female' }]);
    expect(await handle('add', ['--name', 'Bad Name'])).toMatchObject({ ok: false, message: 'bad name' });
    expect(await handle('remove', ['Pip'])).toMatchObject({ ok: true });
    expect(await handle('kill', ['Bram'])).toMatchObject({ ok: true, message: expect.stringContaining('Killed Bram') as string });
    expect((await handle('agents', [])).message).toContain('● Pip (paused) off: romance');
    expect(await handle('test-mode', ['off'])).toMatchObject({ ok: false, message: expect.stringContaining('a fresh world for it') as string });
    expect(await handle('test-mode', ['off', '--new-world'])).toMatchObject({ ok: true, message: expect.stringContaining('test mode off') as string });
    expect(await handle('test-mode', ['maybe'])).toMatchObject({ ok: false });
  });
});

describe('a debug request over the Hub', () => {
  it('goes to the named agent and comes back with its answer; one that is not here, or silent, says so', async () => {
    const hub = new Hub({ config: HubConfigSchema.parse({ hub: { host: '127.0.0.1', port: 8765 } }), logger: nullLogger(), embedder: new HashEmbedder(384), quota: () => null, runtimeHoursPerWeek: 30 });
    await hub.listen(0);
    cleanups.push(() => hub.close());
    hub.on('hello', (s) => s.send({ t: 'assign', persona: PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['kind'] }), username: 'Pip', resume: false, giveStarterKit: false }));
    const tunings: unknown[] = [];
    hub.on('ready', (s) => s.send({ t: 'tuning', tuning: { off: ['romance'], models: {}, tiers: {}, paused: false } }));
    const c = new HubClient({ url: `ws://127.0.0.1:${hub.port}`, slot: 'a0', logger: nullLogger() });
    cleanups.push(() => c.close());
    c.connect();
    await c.assigned();
    c.on('tuning', (m) => tunings.push(m.tuning));
    c.on('debug', (m) => c.send({ t: 'debugResult', reqId: m.reqId, ok: true, message: `${m.op}: ${JSON.stringify(m.args)}`, data: { n: 1 } }));
    c.send({ t: 'ready', username: 'Pip' });
    await until(() => tunings.length > 0);
    expect(tunings[0]).toEqual({ off: ['romance'], models: {}, tiers: {}, paused: false });
    expect(await hub.request('pip', 'inspect', { x: 1 })).toEqual({ ok: true, message: 'inspect: {"x":1}', data: { n: 1 } });
    expect(await hub.request('Nobody', 'inspect')).toEqual({ ok: false, message: 'Nobody is not connected' });
    const quiet = new HubClient({ url: `ws://127.0.0.1:${hub.port}`, slot: 'a1', logger: nullLogger() });
    cleanups.push(() => quiet.close());
    hub.removeAllListeners('hello');
    hub.on('hello', (s) => s.send({ t: 'assign', persona: PersonaSchema.parse({ name: 'Rex', sex: 'male', traits: ['gruff'] }), username: 'Rex', resume: false, giveStarterKit: false }));
    quiet.connect();
    await quiet.assigned();
    quiet.send({ t: 'ready', username: 'Rex' });
    await until(() => hub.byName('Rex') !== undefined);
    expect(await hub.request('Rex', 'inspect', {}, 200)).toEqual({ ok: false, message: 'Rex did not answer in 0 s' });
  });
});

describe('the supervisor, by name (debug controls)', () => {
  function fakeBots(hubUrl: () => string) {
    const live = new Map<string, { client: HubClient; exit: (code: number) => void; username?: string; retired?: boolean }>();
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
        if (me) me.username = a.username;
        c.send({ t: 'ready', username: a.username });
      });
      for (const t of ['shutdown', 'retire'] as const) {
        c.on(t, () => {
          const me = live.get(slot);
          if (me) me.retired = t === 'retire';
          setTimeout(() => exit(0), 20);
        });
      }
      return { slot, pid: 1, kill: () => exit(143), onExit: (cb) => (onExit = cb) };
    };
    return { launcher, live };
  }

  it('adds one from the pool or generated, removes one for good (no replacement), restarts one as itself', async () => {
    const paths = ensureDataDirs(dataPaths(tmp('agora-sup-dbg-')));
    const world = WorldConfigSchema.parse({ population: { initial: 1, minAlive: 1, maxAlive: 3, spawnStaggerSec: 0, respawnDelaySec: 0.1 } });
    const hub = new Hub({ config: HubConfigSchema.parse({ hub: { host: '127.0.0.1', port: 8765 } }), logger: nullLogger(), embedder: new HashEmbedder(384), quota: () => null, runtimeHoursPerWeek: 30 });
    await hub.listen(0);
    cleanups.push(() => hub.close());
    const bots = fakeBots(() => `ws://127.0.0.1:${hub.port}`);
    const pool = [PersonaSchema.parse({ id: 'ada', name: 'Ada', sex: 'female', traits: ['kind'] }), PersonaSchema.parse({ id: 'bram', name: 'Bram', sex: 'male', traits: ['terse'] })];
    const sup = new Supervisor({ hub, paths, world, sexDiffs: SexDifferencesSchema.parse({}), pool, launcher: bots.launcher, logger: nullLogger(), rng: new SeededRandom(3) });
    cleanups.push(() => sup.shutdown('test', 2000));
    await sup.start();
    await until(() => sup.living.length === 1 && [...bots.live.values()].every((b) => b.username));
    expect(await sup.addAgent({ persona: 'nobody' })).toMatch(/no persona "nobody"/);
    const bram = await sup.addAgent({ persona: 'bram' });
    expect(typeof bram === 'string' ? bram : bram.username).toBe('Bram');
    expect(await sup.addAgent({ name: 'Ada' })).toMatch(/can't be used/);
    const gen = await sup.addAgent({ name: 'Wren_7', sex: 'female' });
    expect(typeof gen === 'string' ? gen : [gen.username, gen.persona.sex]).toEqual(['Wren_7', 'female']);
    expect(sup.targetPopulation).toBe(3);
    expect(await sup.addAgent({})).toMatch(/maxAlive/);
    await until(() => bots.live.size === 3 && [...bots.live.values()].every((b) => b.username));
    // Removed for good: it leaves, and nobody takes its place.
    expect(sup.retireAgent('nobody')).toMatch(/no living agent/);
    expect(sup.retireAgent('bram')).toBeNull();
    await until(() => bots.live.size === 2);
    await wait(300);
    expect(bots.live.size).toBe(2);
    expect(sup.targetPopulation).toBe(2);
    expect(sup.living.map((a) => a.username).sort()).toEqual(['Ada', 'Wren_7']);
    // Restarted: the same agent comes back.
    const slotOf = (n: string) => [...bots.live.entries()].find(([, b]) => b.username === n)?.[0];
    const before = slotOf('Wren_7');
    expect(sup.restartAgent('Wren_7')).toBeNull();
    await until(() => !bots.live.has(before ?? '') || bots.live.get(before ?? '')?.username === undefined);
    await until(() => slotOf('Wren_7') === before, 8000);
  }, 20_000);
});
