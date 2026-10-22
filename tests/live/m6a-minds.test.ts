// M6a exit tests (§18.9) on a real server, with code-only agents and plain clients standing in for people:
//   Q impulse: an insult to a hothead (neurotic, impulsive, aggressive) gets an outburst within 2 s; the same
//     insult to a stoic gets an ordinary reply.
//   M halo: a vain agent rates a stranger in diamond armor above one in leather at first sight; a rational one
//     hardly at all. (The gap closing over interactions is checked against fakes in tests/agent/m6a.test.ts.)
//   N mob: three people turn on Rex in chat. An impulsive conformist joins in; a rational onlooker who knows Rex
//     to be fair speaks up for him.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Logger, type Persona, PersonaSchema, WorldConfigSchema, createLogger, loadVersionsConfig, parseProximityLine, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { newSocialProfile } from '@agora/agent/state/social';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
// Words and a punch at most here: the lethal rung (M8b) stays off.
const world = WorldConfigSchema.parse({ conflict: { maxRung: 3 } });
const Y = -60;
const PORT = 25574;

const hothead = (name: string): Persona =>
  PersonaSchema.parse({
    id: name.toLowerCase(),
    name,
    sex: 'male',
    traits: ['hot-tempered'],
    big5: { neuroticism: 0.95, agreeableness: 0.1, extraversion: 0.8 },
    temperament: { aggression: 0.85, vengefulness: 0.7 },
    mind: { impulsivity: 0.95, rationality: 0.1, conformity: 0.9, vanity: 0.9, biasProfile: { halo: 0.9, negativity: 0.6 } },
    insecurities: ['being called lazy'],
    social: { initiateChance: 0 },
  });
const stoic = (name: string): Persona =>
  PersonaSchema.parse({
    id: name.toLowerCase(),
    name,
    sex: 'female',
    traits: ['calm'],
    big5: { neuroticism: 0.05, agreeableness: 0.85, extraversion: 0.4, openness: 0.8 },
    temperament: { aggression: 0.05 },
    mind: { impulsivity: 0.05, rationality: 0.95, conformity: 0.1, vanity: 0.05, biasProfile: { halo: 0.1 } },
    social: { initiateChance: 0 },
  });

describe.skipIf(!liveJavaPath())('M6a live: emotions, impressions, mobs', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm6a', port: PORT, rconPort: 25584 });
    logger = createLogger({ name: 'm6a-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  const connect = (username: string) => Body.connect({ host: server.host, port: server.port, username, version: versions.minecraft.version, logger });

  /** Lines a person said, as heard by `ear`, with when they arrived. */
  function listen(ear: Body, speaker: string): { text: string; at: number; shout: boolean }[] {
    const out: { text: string; at: number; shout: boolean }[] = [];
    ear.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech' && p.speaker === speaker) out.push({ text: p.text, at: Date.now(), shout: p.volume === 'shout' });
    });
    return out;
  }

  it('Q (impulse): a hothead snaps back at an insult within 2 s; a stoic answers it calmly', async () => {
    const x = 500;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const kaiBody = await connect('Kai');
    const solBody = await connect('Sol');
    const wit = await connect('Wit');
    await server.cmd(`tp Kai ${x} ${Y} 0`);
    await server.cmd(`tp Sol ${x} ${Y} 40`);
    await server.cmd(`tp Wit ${x + 3} ${Y} 0`);
    await sleep(1500);
    const kai = new Agent({ body: kaiBody, persona: hothead('Kai'), username: 'Kai', llm: null, logger, world, goalGen: false, rng: () => 0 });
    const sol = new Agent({ body: solBody, persona: stoic('Sol'), username: 'Sol', llm: null, logger, world, goalGen: false, rng: () => 0 });
    const kaiSaid = listen(wit, 'Kai');
    const solSaid = listen(wit, 'Sol');
    kai.start();
    sol.start();
    try {
      await sleep(2000);
      const t0 = Date.now();
      await wit.say('Kai, you are so lazy');
      const sentAt = Date.now();
      await waitFor(() => kaiSaid.length > 0, 10_000, 'a reply from Kai', 50);
      const first = kaiSaid[0];
      console.log(`[m6a Q] Kai said "${first?.text}"${first?.shout ? ' (shouting)' : ''} ${((first?.at ?? 0) - sentAt) / 1000} s after the insult; anger ${kai.store.state.emotions.anger.toFixed(2)}, at Wit ${kai.feelings.angerToward('Wit').toFixed(2)}`);
      expect((first?.at ?? Infinity) - t0).toBeLessThan(2000 + (sentAt - t0));
      expect(first?.text).toMatch(/excuse me|dare you|watch your mouth|who do you think|how dare/i);
      expect(kai.store.state.emotions.anger).toBeGreaterThan(0.7);

      await server.cmd(`tp Wit ${x + 3} ${Y} 40`);
      await sleep(1500);
      await wit.say('Sol, you are so lazy');
      await waitFor(() => solSaid.length > 0, 10_000, 'a reply from Sol', 50);
      console.log(`[m6a Q] Sol said "${solSaid[0]?.text}"; anger ${sol.store.state.emotions.anger.toFixed(2)}`);
      expect(solSaid[0]?.text).not.toMatch(/excuse me|dare you|watch your mouth|who do you think|how dare/i);
      expect(sol.store.state.emotions.anger).toBeLessThan(0.3);
    } finally {
      await kai.stop();
      await sol.stop();
      await kaiBody.disconnect();
      await solBody.disconnect();
      await wit.disconnect();
    }
  }, 120_000);

  it('M (halo): diamond armor impresses a vain agent at first sight; a rational one hardly at all', async () => {
    const x = 800;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const kaiBody = await connect('Kai');
    const solBody = await connect('Sol');
    await server.cmd(`tp Kai ${x} ${Y} 0`);
    await server.cmd(`tp Sol ${x + 2} ${Y} 0`);
    await sleep(1000);
    const kai = new Agent({ body: kaiBody, persona: hothead('Kai'), username: 'Kai', llm: null, logger, world, goalGen: false, rng: () => 0.99 });
    const sol = new Agent({ body: solBody, persona: stoic('Sol'), username: 'Sol', llm: null, logger, world, goalGen: false, rng: () => 0.99 });
    kai.start();
    sol.start();
    const dia = await connect('Dia');
    const lea = await connect('Lea');
    try {
      for (const slot of ['head', 'chest', 'legs', 'feet'] as const) {
        const piece = { head: 'helmet', chest: 'chestplate', legs: 'leggings', feet: 'boots' }[slot];
        await server.cmd(`item replace entity Dia armor.${slot} with minecraft:diamond_${piece}`);
        await server.cmd(`item replace entity Lea armor.${slot} with minecraft:leather_${piece}`);
      }
      await server.cmd('item replace entity Dia weapon.mainhand with minecraft:diamond_sword');
      await server.cmd(`tp Dia ${x + 1} ${Y} 5`);
      await server.cmd(`tp Lea ${x - 1} ${Y} 5`);
      await waitFor(() => ['Dia', 'Lea'].every((n) => kai.store.state.social[n] && sol.store.state.social[n]), 20_000, 'both strangers seen', 250);
      // Impressions are formed on the next look (once a second).
      await sleep(2500);
      const seen = kai.store.state.perception.nearbyEntities.filter((e) => e.kind === 'player').map((e) => `${e.name}: ${e.visible ? 'visible' : 'hidden'} armor [${e.armor.join(', ')}] held ${e.heldItem ?? '-'}`);
      console.log(`[m6a M] Kai sees: ${seen.join('; ')}`);
      const view = (a: Agent) => ({ dia: a.store.state.social.Dia, lea: a.store.state.social.Lea });
      const k = view(kai);
      const s = view(sol);
      console.log(
        `[m6a M] Kai (vain): Dia ${k.dia?.sentiment.toFixed(2)} adm ${k.dia?.admiration.toFixed(2)} vs Lea ${k.lea?.sentiment.toFixed(2)}; Sol (rational): Dia ${s.dia?.sentiment.toFixed(2)} vs Lea ${s.lea?.sentiment.toFixed(2)}`,
      );
      const gap = (v: { dia?: { sentiment: number }; lea?: { sentiment: number } }) => (v.dia?.sentiment ?? 0) - (v.lea?.sentiment ?? 0);
      expect(gap(k)).toBeGreaterThan(1);
      expect(Math.abs(gap(s))).toBeLessThan(0.5);
      expect(k.dia?.admiration ?? 0).toBeGreaterThan(0.5);
    } finally {
      await kai.stop();
      await sol.stop();
      await kaiBody.disconnect();
      await solBody.disconnect();
      await dia.disconnect();
      await lea.disconnect();
    }
  }, 120_000);

  it('N (mob): three people turn on Rex; an impulsive conformist joins in, a rational onlooker who knows Rex objects', async () => {
    const x = 1100;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    const kaiBody = await connect('Kai');
    const solBody = await connect('Sol');
    await server.cmd(`tp Kai ${x} ${Y} 0`);
    await server.cmd(`tp Sol ${x + 3} ${Y} 0`);
    await sleep(1000);
    const kai = new Agent({ body: kaiBody, persona: hothead('Kai'), username: 'Kai', llm: null, logger, world, goalGen: false, rng: () => 0.99 });
    const sol = new Agent({ body: solBody, persona: stoic('Sol'), username: 'Sol', llm: null, logger, world, goalGen: false, rng: () => 0.99 });
    // Sol's history with Rex: three promises kept, always fair.
    sol.store.update('social', (all) => ({ ...all, Rex: { ...newSocialProfile('Rex', sol.store.state.self.persona, Date.now()), sentiment: 7, evidence: 8, trust: 0.8, promisesKept: 3, interactions: 6, anchorCount: 2 } }));
    kai.start();
    sol.start();
    const mob = await Promise.all(['Ann', 'Ben', 'Cid', 'Rex'].map((n) => connect(n)));
    const kaiSaid = listen(mob[0] as Body, 'Kai');
    const solSaid = listen(mob[0] as Body, 'Sol');
    try {
      await server.cmd(`tp Ann ${x + 1} ${Y} 3`);
      await server.cmd(`tp Ben ${x + 2} ${Y} 4`);
      await server.cmd(`tp Cid ${x - 1} ${Y} 3`);
      await server.cmd(`tp Rex ${x + 10} ${Y} 6`);
      await sleep(2000);
      const lines: [number, string][] = [
        [0, 'Rex is a thief!'],
        [1, 'yeah, Rex stole my iron'],
        [2, 'Rex is a liar, everyone knows it'],
      ];
      for (const [i, text] of lines) {
        await (mob[i] as Body).say(text);
        await sleep(2500);
      }
      await waitFor(() => kaiSaid.some((l) => /Rex is no good/.test(l.text)) && solSaid.some((l) => /Rex has always been fair/.test(l.text)), 30_000, 'Kai joining in and Sol objecting', 250);
      console.log(
        `[m6a N] Kai: ${kaiSaid.map((l) => l.text).join(' | ')} (feels ${kai.store.state.social.Rex?.sentiment.toFixed(1)} about Rex); Sol: ${solSaid.map((l) => l.text).join(' | ')} (feels ${sol.store.state.social.Rex?.sentiment.toFixed(1)})`,
      );
      expect(kai.store.state.social.Rex?.sentiment ?? 10).toBeLessThan(4.5);
      expect(sol.store.state.social.Rex?.sentiment ?? 0).toBeGreaterThan(6);
    } finally {
      await kai.stop();
      await sol.stop();
      await kaiBody.disconnect();
      await solBody.disconnect();
      for (const b of mob) await b.disconnect();
    }
  }, 120_000);
});
