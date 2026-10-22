// M6 exit tests (§10, §11, §16): the social model, commitments and deaths on a real server.
//   A favor: Bram (scripted model) asks Pip (code-only, generous) for 8 logs. Pip promises, gathers and hands
//     them over; both sides record the commitment, it is kept, and Bram thinks better of Pip.
//   B broken promise: the same ask where Pip can't deliver; at the deadline Bram's trust drops and he has it on his
//     mind when someone talks to him.
//   D rumor: a player tells Pip there are diamonds nearby; Pip goes to look, finds none, and trusts the teller less.
//   E danger mid-conversation: a zombie interrupts a conversation; Pip answers with a canned line while fighting, the
//     conversation ends cleanly, and Pip talks normally afterwards.
//   G a peer with a plain client (here a bare body standing in for a human): the same request path as A.
//   T trade (§6.6): an offer made in chat is accepted, both halves are tossed over, and both promises are kept.
//   K help (§6.7): asked for a hand gathering wood, Pip works near the asker and hands what she gathered over.
//   H death: an agent killed in test mode is replaced within respawnDelaySec, and the survivors grow more cautious.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubConfigSchema,
  type Logger,
  ModelsConfigSchema,
  type Persona,
  SeededRandom,
  SexDifferencesSchema,
  WorldConfigSchema,
  createLogger,
  dataPaths,
  ensureDataDirs,
  loadPersonaPool,
  loadVersionsConfig,
  parseProximityLine,
  sleep,
} from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { Hub, type Launcher, Supervisor } from '@agora/hub';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { countItem } from '@agora/agent/body/inventory';
import { itemMatcher } from '@agora/agent/body/items';
import { type RunningBot, runBot } from '@agora/agent/hub/runtime';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
/** Any kind of log (a plain string counts one exact item name). */
const LOGS = itemMatcher('log');
const world = WorldConfigSchema.parse({});
const Y = -60;
const PORT = 25572;
const pool = loadPersonaPool();
const persona = (id: string): Persona => {
  const p = pool.find((x) => x.id === id);
  if (!p) throw new Error(`persona ${id} missing`);
  return p;
};

describe.skipIf(!liveJavaPath())('M6 live: social model, commitments and deaths', () => {
  let server: LiveServer;
  let logger: Logger;

  async function trees(x: number, z: number, n = 4): Promise<void> {
    await server.cmd(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    const spots = [
      [8, 6],
      [-8, 7],
      [7, -8],
      [-7, -7],
    ].slice(0, n);
    for (const [dx, dz] of spots) await server.cmd(`place feature minecraft:oak ${x + (dx ?? 0)} ${Y} ${z + (dz ?? 0)}`);
  }

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm6', port: PORT, rconPort: 25582 });
    logger = createLogger({ name: 'm6-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  /** A scripted Bram: asks Pip for 8 logs once, thanks her, and reads promises from what Pip says. */
  async function askingBram(dueInSec: number, talkPrompts: string[]) {
    const fake = new FakeNanoGpt(standardModels());
    let asked = false;
    let askedOut = false;
    fake.chat = ({ body }) => {
      const messages = body.messages as { role: string; content: string }[];
      const user = messages.at(-1)?.content ?? '';
      const schema = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
      if (schema === 'summary') return { text: JSON.stringify({ summary: 'I build things.' }) };
      if (schema === 'goal') return { text: JSON.stringify({ keep: true }) };
      if (schema === 'addressed') return { text: JSON.stringify({ addressedToMe: false }) };
      if (schema === 'social') return { text: JSON.stringify({ sentimentDelta: 0.3, summary: 'Pip seems helpful.' }) };
      if (schema === 'promises') {
        const promised = /Pip: [^\n]*8 logs/.test(user);
        return { text: JSON.stringify({ promises: promised ? [{ what: { kind: 'give', item: 'log', qty: 8, text: '8 logs' }, dueInSec }] : [] }) };
      }
      if (schema === 'decision') {
        if (!asked && /People near you:.*\bPip \(/.test(user)) {
          asked = true;
          return { text: JSON.stringify({ option: 'talk', target: { agent: 'Pip' }, speechIntent: { stance: 'ask', gist: 'ask Pip for 8 logs', mayCommit: false }, terminate: { maxSeconds: 90 }, rationale: 'I need wood' }) };
        }
        return { text: JSON.stringify({ option: 'rest', terminate: { maxSeconds: 30 }, rationale: 'waiting' }) };
      }
      talkPrompts.push(user);
      if (/bring you 8 logs/.test(user)) return { text: 'thanks, that would really help' };
      if (/ask Pip for 8 logs/.test(user) && !askedOut) {
        askedOut = true;
        return { text: 'Pip, can you give me 8 logs?' };
      }
      return { text: 'alright' };
    };
    return startLlm({ apiKey: 'scripted', config: ModelsConfigSchema.parse({}), logger, fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 50 }) });
  }

  it('A (favor): a generous agent promises 8 logs, gathers and delivers them; the asker thinks better of it', async () => {
    const x = 1500;
    await trees(x, 0);
    const talk: string[] = [];
    const rt = await askingBram(600, talk);
    const pipBody = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const bramBody = await Body.connect({ host: server.host, port: server.port, username: 'Bram', version: versions.minecraft.version, logger });
    await server.cmd(`tp Pip ${x} ${Y} 0`);
    await server.cmd(`tp Bram ${x + 4} ${Y} 2`);
    await sleep(1500);
    const pip = new Agent({ body: pipBody, persona: persona('pip'), username: 'Pip', llm: null, logger, world, goalGen: false });
    const bram = new Agent({ body: bramBody, persona: persona('bram'), username: 'Bram', llm: rt.client, logger, world, goalGen: false });
    pip.start();
    bram.start();
    try {
      await waitFor(() => bram.store.state.commitments.some((c) => c.debtor === 'Pip'), 150_000, "Bram records Pip's promise", 1000);
      const before = bram.store.state.social.Pip?.sentiment ?? 0;
      // Pickup courtesy: while Pip chops, Bram leaves her logs alone.
      await waitFor(() => pip.store.state.option?.skill === 'give' || countItem(bramBody.bot, LOGS) >= 8, 300_000, 'Pip ready to hand over', 500);
      const tookEarly = countItem(bramBody.bot, LOGS);
      await waitFor(() => countItem(bramBody.bot, LOGS) >= 8, 120_000, 'the logs delivered', 1000);
      await waitFor(() => bram.store.state.commitments.some((c) => c.debtor === 'Pip' && c.status === 'fulfilled'), 30_000, 'the promise kept', 500);
      const after = bram.store.state.social.Pip;
      console.log(`[m6 A] Bram's view of Pip: sentiment ${before.toFixed(1)} → ${after?.sentiment.toFixed(1)}, trust ${after?.trust.toFixed(2)}, kept ${after?.promisesKept}; logs Bram had before the hand-over: ${tookEarly}`);
      expect(after?.sentiment ?? 0).toBeGreaterThan(before);
      expect(after?.trust ?? 0).toBeGreaterThan(0.5);
      expect(pip.store.state.commitments.filter((c) => c.debtor === 'Pip' && c.creditor === 'Bram').map((c) => c.status)).toEqual(['fulfilled']);
      expect(bram.store.state.commitments.filter((c) => c.debtor === 'Pip')).toHaveLength(1);
      expect(bram.store.state.workmem.some((w) => /Pip kept their promise/.test(w.text))).toBe(true);
    } finally {
      await pip.stop();
      await bram.stop();
      await pipBody.disconnect();
      await bramBody.disconnect();
      rt.stop();
    }
  }, 480_000);

  it('B (broken promise): the deadline passes, trust drops, and the asker has it on his mind later', async () => {
    const x = 1800;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const talk: string[] = [];
    const rt = await askingBram(45, talk);
    const pipBody = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const bramBody = await Body.connect({ host: server.host, port: server.port, username: 'Bram', version: versions.minecraft.version, logger });
    const wit = await Body.connect({ host: server.host, port: server.port, username: 'Wit', version: versions.minecraft.version, logger });
    await server.cmd(`tp Pip ${x} ${Y} 0`);
    await server.cmd(`tp Bram ${x + 4} ${Y} 2`);
    await server.cmd(`tp Wit ${x + 40} ${Y} 0`);
    await sleep(1500);
    // No trees anywhere near: Pip can't keep this promise.
    const pip = new Agent({ body: pipBody, persona: persona('pip'), username: 'Pip', llm: null, logger, world, goalGen: false });
    const bram = new Agent({ body: bramBody, persona: persona('bram'), username: 'Bram', llm: rt.client, logger, world, goalGen: false });
    pip.start();
    bram.start();
    try {
      await waitFor(() => bram.store.state.commitments.some((c) => c.debtor === 'Pip'), 150_000, "Bram records Pip's promise", 1000);
      await waitFor(() => bram.store.state.commitments.some((c) => c.debtor === 'Pip' && c.status === 'broken'), 90_000, 'the promise broken', 1000);
      const p = bram.store.state.social.Pip;
      console.log(`[m6 B] Bram's view of Pip: trust ${p?.trust.toFixed(2)}, broken ${p?.promisesBroken}`);
      expect(p?.trust ?? 1).toBeLessThan(0.5);
      expect(bram.store.state.workmem.some((w) => /Pip broke their promise/.test(w.text))).toBe(true);
      // Later, when someone talks to Bram, it is on his mind.
      await server.cmd(`tp Wit ${x + 6} ${Y} 2`);
      await sleep(1500);
      const n = talk.length;
      await wit.say('Bram, how are things?');
      await waitFor(() => talk.length > n, 30_000, 'Bram composing a reply', 250);
      expect(talk.slice(n).some((t) => /Pip broke their promise/.test(t))).toBe(true);
    } finally {
      await pip.stop();
      await bram.stop();
      await pipBody.disconnect();
      await bramBody.disconnect();
      await wit.disconnect();
      rt.stop();
    }
  }, 420_000);

  it('D (rumor): told of diamonds nearby, Pip goes to look, finds none and trusts the teller less', async () => {
    const x = 2100;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const pipBody = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const wit = await Body.connect({ host: server.host, port: server.port, username: 'Wit', version: versions.minecraft.version, logger });
    await server.cmd(`tp Pip ${x} ${Y} 0`);
    await server.cmd(`tp Wit ${x + 3} ${Y} 0`);
    await sleep(1500);
    const pip = new Agent({ body: pipBody, persona: persona('pip'), username: 'Pip', llm: null, logger, world, goalGen: false });
    pip.start();
    try {
      await sleep(3000);
      await wit.say(`Pip, there are diamonds at ${x + 14}, ${Y - 1}, 6`);
      await waitFor(() => pip.claims.claims.some((c) => c.status !== 'open'), 120_000, 'the claim checked', 1000);
      const trust = pip.store.state.social.Wit?.trust ?? 1;
      console.log(`[m6 D] claim ${pip.claims.claims[0]?.status}; Pip's trust in Wit ${trust.toFixed(2)}`);
      expect(pip.claims.claims[0]?.status).toBe('false');
      expect(trust).toBeLessThan(0.5);
      expect(pip.store.state.workmem.some((w) => /Wit said there was diamond .* but there isn't/.test(w.text))).toBe(true);
    } finally {
      await pip.stop();
      await pipBody.disconnect();
      await wit.disconnect();
    }
  }, 240_000);

  it('E (danger mid-conversation): a zombie ends the conversation cleanly; Pip answers with a canned line and talks again after', async () => {
    const x = 2400;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const pipBody = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const wit = await Body.connect({ host: server.host, port: server.port, username: 'Wit', version: versions.minecraft.version, logger });
    await server.cmd(`tp Pip ${x} ${Y} 0`);
    await server.cmd(`tp Wit ${x + 4} ${Y} 0`);
    await server.cmd('give Pip minecraft:stone_sword');
    await server.cmd('gamemode creative Wit');
    await sleep(1500);
    const pipSaid: { text: string; at: number }[] = [];
    wit.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech' && p.speaker === 'Pip') pipSaid.push({ text: p.text, at: Date.now() });
    });
    const pip = new Agent({ body: pipBody, persona: persona('pip'), username: 'Pip', llm: null, logger, world, goalGen: false });
    pip.start();
    try {
      await wit.say('Pip, nice day, isn’t it?');
      await waitFor(() => pipSaid.length > 0, 30_000, 'a reply', 250);
      await server.cmd(`summon minecraft:zombie ${x + 3} ${Y} 3 {PersistenceRequired:1b}`);
      await waitFor(() => pip.store.state.flags.inDanger, 20_000, 'danger noticed', 100);
      const t0 = Date.now();
      await wit.say('Pip, are you alright?!');
      await waitFor(() => !pip.store.state.flags.inDanger, 90_000, 'the danger over', 500);
      const ended = Object.values(pip.store.state.conversations).filter((c) => c.status === 'ended').map((c) => c.endedReason);
      const busy = pipSaid.filter((s) => s.at > t0).map((s) => s.text);
      console.log(`[m6 E] ended: ${ended.join(', ')}; during the fight Pip said: ${busy.join(' | ')}`);
      expect(ended).toContain('danger');
      expect(busy).toContain('hang on, zombie!');
      await sleep(3000);
      const n = pipSaid.length;
      await wit.say('Pip, all good now?');
      await waitFor(() => pipSaid.length > n, 30_000, 'a normal reply after the fight', 250);
    } finally {
      await pip.stop();
      await pipBody.disconnect();
      await wit.disconnect();
    }
  }, 240_000);

  it('G (a peer with a plain client): the same request path; Pip hands over the bread she has', async () => {
    const x = 2700;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const pipBody = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const wit = await Body.connect({ host: server.host, port: server.port, username: 'Wit', version: versions.minecraft.version, logger });
    await server.cmd(`tp Pip ${x} ${Y} 0`);
    await server.cmd(`tp Wit ${x + 4} ${Y} 0`);
    await server.cmd('give Pip minecraft:bread 3');
    await server.cmd('clear Wit');
    await sleep(1500);
    const pip = new Agent({ body: pipBody, persona: persona('pip'), username: 'Pip', llm: null, logger, world, goalGen: false });
    pip.start();
    try {
      await sleep(2000);
      await wit.say('Pip, can you give me 2 bread?');
      await waitFor(() => countItem(wit.bot, 'bread') >= 2, 60_000, 'the bread handed over', 500);
      const k = pip.store.state.commitments.find((c) => c.creditor === 'Wit');
      console.log(`[m6 G] Pip's promise to Wit: ${k?.what.text} → ${k?.status}`);
      await waitFor(() => pip.store.state.commitments.some((c) => c.creditor === 'Wit' && c.status === 'fulfilled'), 20_000, 'the promise kept', 500);
    } finally {
      await pip.stop();
      await pipBody.disconnect();
      await wit.disconnect();
    }
  }, 180_000);

  it('T (trade over chat): an offer is accepted, both halves are tossed over and both promises are kept', async () => {
    const x = 3300;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const pipBody = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const wit = await Body.connect({ host: server.host, port: server.port, username: 'Wit', version: versions.minecraft.version, logger });
    await server.cmd(`tp Pip ${x} ${Y} 0`);
    await server.cmd(`tp Wit ${x + 4} ${Y} 0`);
    for (const c of ['clear Pip', 'clear Wit', 'give Pip minecraft:oak_log 8', 'give Wit minecraft:bread 6']) await server.cmd(c);
    await sleep(1500);
    const pip = new Agent({ body: pipBody, persona: persona('pip'), username: 'Pip', llm: null, logger, world, goalGen: false });
    pip.start();
    try {
      await sleep(2000);
      await wit.say("Pip, I'll give you 6 bread for 8 logs");
      await waitFor(() => countItem(wit.bot, LOGS) >= 8, 60_000, 'the logs handed over', 500);
      // Wit keeps their end: steps up to Pip and tosses the bread at her feet.
      const at = wit.bot.players.Pip?.entity?.position;
      if (!at) throw new Error('Pip is out of sight');
      await server.cmd(`tp Wit ${(at.x + 1.6).toFixed(2)} ${at.y.toFixed(2)} ${at.z.toFixed(2)}`);
      await sleep(800);
      await wit.bot.lookAt(at, true);
      await sleep(200);
      const bread = wit.bot.inventory.items().find((i) => i.name === 'bread');
      if (bread) await wit.bot.toss(bread.type, null, 6);
      await waitFor(() => countItem(pipBody.bot, 'bread') >= 6, 30_000, 'Pip picking up the bread', 500);
      await waitFor(() => pip.store.state.commitments.filter((c) => c.status === 'fulfilled').length === 2, 20_000, 'both halves kept', 500);
      const ks = pip.store.state.commitments.map((c) => `${c.debtor}>${c.creditor} ${c.what.text}: ${c.status}`);
      console.log(`[m6 T] ${ks.join('; ')}; Pip's view of Wit: trust ${pip.store.state.social.Wit?.trust.toFixed(2)}`);
      expect(ks.sort()).toEqual(['Pip>Wit 8 logs: fulfilled', 'Wit>Pip 6 bread: fulfilled']);
      expect(pip.store.state.social.Wit?.trust ?? 0).toBeGreaterThan(0.5);
    } finally {
      await pip.stop();
      await pipBody.disconnect();
      await wit.disconnect();
    }
  }, 180_000);

  it('K (help): asked for a hand gathering wood, Pip works near the asker and hands the logs over', async () => {
    const x = 3600;
    await trees(x, 0);
    const pipBody = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    const wit = await Body.connect({ host: server.host, port: server.port, username: 'Wit', version: versions.minecraft.version, logger });
    await server.cmd(`tp Pip ${x - 10} ${Y} 0`);
    await server.cmd(`tp Wit ${x + 3} ${Y} 1`);
    for (const c of ['clear Pip', 'clear Wit']) await server.cmd(c);
    await sleep(1500);
    const pip = new Agent({ body: pipBody, persona: persona('pip'), username: 'Pip', llm: null, logger, world, goalGen: false });
    const options: string[] = [];
    pip.bus.on('decision', (e) => options.push(e.decision.option));
    pip.start();
    try {
      await sleep(2000);
      await wit.say('Pip, can you help me gather wood?');
      await waitFor(() => options.includes('help'), 30_000, 'Pip deciding to help', 250);
      await waitFor(() => countItem(wit.bot, LOGS) >= 8, 300_000, 'the logs handed over', 1000);
      await waitFor(() => pip.store.state.commitments.some((c) => c.what.kind === 'help' && c.status === 'fulfilled'), 20_000, 'the help counted as given', 500);
      console.log(`[m6 K] options: ${options.join(', ')}; Wit holds ${countItem(wit.bot, LOGS)} logs`);
    } finally {
      await pip.stop();
      await pipBody.disconnect();
      await wit.disconnect();
    }
  }, 420_000);

  it('H (death): a killed agent is replaced within respawnDelaySec, and the survivors grow more cautious', async () => {
    const dataDir = path.join(server.dir, '..', 'data-death');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(dataDir));
    const x = 3000;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    await server.cmd(`setworldspawn ${x} ${Y} 0`);
    await server.cmd('gamerule respawn_radius 0');
    const h = new Hub({ config: HubConfigSchema.parse({}), logger, embedder: null, quota: () => null, runtimeHoursPerWeek: 30 });
    await h.listen(0);
    h.start();
    const w = WorldConfigSchema.parse({ population: { initial: 3, minAlive: 3, maxAlive: 5, spawnStaggerSec: 1, respawnDelaySec: 5, spawnRadius: 0 }, server: { host: '127.0.0.1', port: PORT } });
    const bots = new Map<string, RunningBot>();
    const launcher: Launcher = (slot) => {
      let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
      let running: RunningBot | null = null;
      void runBot({ hubUrl: `ws://127.0.0.1:${h.port}`, slot, paths, world: w, versions, models: ModelsConfigSchema.parse({}), apiKey: '', logger }).then((b) => {
        running = b;
        bots.set(b.username, b);
        void b.done.then(() => exit?.(0, null));
      });
      return { slot, pid: undefined, kill: () => void running?.stop('killed'), onExit: (cb) => (exit = cb) };
    };
    const sup = new Supervisor({ hub: h, paths, world: w, sexDiffs: SexDifferencesSchema.parse({}), pool: pool.filter((p) => ['pip', 'bram', 'mira', 'tobin'].includes(p.id ?? '')), launcher, logger, rng: new SeededRandom(6), rcon: (c) => server.cmd(c) });
    try {
      await sup.start();
      await waitFor(() => bots.size === 3, 90_000, 'three agents', 500);
      await sleep(4000);
      const [victim, ...rest] = [...bots.keys()];
      const before = new Map(rest.map((n) => [n, bots.get(n)?.agent.store.state.drives.caution ?? 0]));
      const t0 = Date.now();
      await server.cmd(`kill ${victim}`);
      await waitFor(() => sup.living.length === 3 && !sup.living.some((a) => a.username === victim) && bots.size >= 4, 60_000, 'a replacement', 500);
      const newcomer = sup.living.find((a) => !bots.has(a.username) || ![victim, ...rest].includes(a.username))?.username;
      console.log(`[m6 H] ${victim} died; replaced by ${newcomer ?? '?'} after ${Math.round((Date.now() - t0) / 1000)} s`);
      expect(Date.now() - t0).toBeLessThan((w.population.respawnDelaySec + 30) * 1000);
      expect(fs.readdirSync(paths.graveyard).some((f) => f.startsWith(`${victim ?? ''}-`))).toBe(true);
      for (const n of rest) {
        const a = bots.get(n)?.agent;
        expect(a?.store.state.drives.caution ?? 0, `${n} grew more cautious`).toBeGreaterThan(before.get(n) ?? 1);
        expect(a?.store.state.workmem.some((m) => m.text.startsWith(`${victim ?? ''} died`))).toBe(true);
      }
    } finally {
      await sup.shutdown('test done', 30_000);
      await h.close();
    }
  }, 300_000);
});
