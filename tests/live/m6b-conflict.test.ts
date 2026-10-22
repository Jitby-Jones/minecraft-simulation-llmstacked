// M6b exit test (§17.12 scenario I, clash) on a real server, with code-only agents: two quarrelsome brutes who
// already can't stand each other (their history is seeded: low sentiment, an old insult, some logs taken) work the
// same small grove. Expected: hostile talk, then threats, then at most a brawl that ends in a yield (in words, or in
// deeds: stopping, running off); friction from working the same spot; nobody dies (maxRung 3: the lethal rung is
// off). A plain client, Wit, listens nearby; each of them also hears the other.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ActionRecord, type Logger, type Persona, PersonaSchema, WorldConfigSchema, createLogger, loadVersionsConfig, parseProximityLine, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { SURRENDER_RE } from '@agora/agent/body/skills/duel';
import { withGrievance } from '@agora/agent/social/math';
import { newSocialProfile } from '@agora/agent/state/social';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const world = WorldConfigSchema.parse({ conflict: { maxRung: 3, newcomerGraceSec: 0, pairCooldownSec: 300 } });
const Y = -60;
const PORT = 25575;

/** Talking's hostile and threatening lines (code-only agents use the canned ones). */
const HOSTILE_RE = /what do you want|leave me alone|keep your distance|get lost|back off|or else|don't push me|or we fight/i;

const brute = (name: string, sex: 'male' | 'female'): Persona =>
  PersonaSchema.parse({
    id: name.toLowerCase(),
    name,
    sex,
    traits: ['quarrelsome', 'proud'],
    big5: { agreeableness: 0.1, neuroticism: 0.6, extraversion: 0.6 },
    temperament: { aggression: 0.9, dominance: 0.85, vengefulness: 0.8, mercy: 0.3 },
    drives: { caution: 0.15 },
    abilities: { combat: 0.5, intelligence: 0.6 },
    mind: { impulsivity: 0.3 },
    social: { initiateChance: 0 },
  });

describe.skipIf(!liveJavaPath())('M6b live: conflict', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm6b', port: PORT, rconPort: 25585 });
    logger = createLogger({ name: 'm6b-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty normal']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  const connect = (username: string) => Body.connect({ host: server.host, port: server.port, username, version: versions.minecraft.version, logger });

  it('I (clash): hostile talk, threats, at most a brawl that ends in a yield, friction from sharing the grove, and no deaths', async () => {
    const x = 500;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    for (const [dx, dz] of [
      [4, 3],
      [-3, 4],
      [4, -4],
      [-4, -3],
      [0, 6],
      [6, 0],
    ]) {
      await server.cmd(`place feature minecraft:oak ${x + (dx ?? 0)} ${Y} ${dz ?? 0}`);
    }
    const bodies = { Gorm: await connect('Gorm'), Brak: await connect('Brak') };
    const wit = await connect('Wit');
    await server.cmd(`tp Gorm ${x - 1} ${Y} 0`);
    await server.cmd(`tp Brak ${x + 1} ${Y} 1`);
    await server.cmd(`tp Wit ${x + 12} ${Y} 0`);
    for (const c of ['clear Gorm', 'clear Brak', 'clear Wit']) await server.cmd(c);
    await sleep(1500);

    const t0 = Date.now();
    const at = () => `${Math.round((Date.now() - t0) / 1000)} s`;
    const timeline: string[] = [];
    const heard: { who: string; text: string; at: number }[] = [];
    const hear = (who: string, text: string) => {
      // Wit and the other one may both hear a line: count it once.
      if (heard.some((h) => h.who === who && h.text === text && Math.abs(h.at - Date.now()) < 1500)) return;
      heard.push({ who, text, at: Date.now() });
      timeline.push(`${at()} ${who}: "${text}"`);
    };
    wit.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech' && (p.speaker === 'Gorm' || p.speaker === 'Brak')) hear(p.speaker, p.text);
    });
    const deaths: string[] = [];
    const agents: Agent[] = [];
    for (const [name, other, sex] of [
      ['Gorm', 'Brak', 'male'],
      ['Brak', 'Gorm', 'male'],
    ] as const) {
      const body = bodies[name];
      body.bot.on('death', () => void deaths.push(name));
      const p = brute(name, sex);
      const a = new Agent({ body, persona: p, username: name, llm: null, logger, world, goalGen: false, rng: () => 0.99 });
      // Their history: they already can't stand each other.
      const now = Date.now();
      let o = { ...newSocialProfile(other, p, now), sentiment: 2 };
      o = withGrievance(o, 'insult', p, { now: now - 3_600_000, witnessed: true, source: 'self_observed', note: `${other} called me a fool` });
      o = withGrievance(o, 'theft', p, { now: now - 1_800_000, witnessed: true, source: 'self_observed', note: `${other} took my logs` });
      a.store.update('social', (all) => ({ ...all, [other]: o }), 'history');
      a.bus.on('rungChanged', (e) => void timeline.push(`${at()} ${name} → ${e.name}: rung ${e.from} → ${e.to}`));
      a.bus.on('heard', (e) => {
        if (e.utterance.from === other) hear(other, e.utterance.text);
      });
      a.bus.on('actionRecorded', (e) => {
        if (e.record.skill === 'duel') timeline.push(`${at()} ${name}'s duel: ${e.record.observed} (${JSON.stringify(e.record.data ?? {})})`);
      });
      agents.push(a);
    }
    const [gorm, brak] = agents as [Agent, Agent];
    const duels = () => agents.flatMap((a) => a.store.state.actionLog.filter((r) => r.skill === 'duel').map((r): [string, ActionRecord] => [a.name, r]));
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      console.log(`[m6b I] timeline:\n  ${timeline.join('\n  ')}`);
      for (const a of agents) {
        const other = a.name === 'Gorm' ? 'Brak' : 'Gorm';
        const p = a.store.state.social[other];
        console.log(
          `[m6b I] ${a.name} on ${other}: sentiment ${p?.sentiment.toFixed(1)}, friction ${p?.friction.toFixed(2)}, fear ${p?.fearOf.toFixed(2)}, rung ${a.conflict.rungOf(other)}, last fight ${p?.lastFight?.outcome ?? '-'}, health ${a.store.state.self.health}`,
        );
      }
    };
    for (const a of agents) a.start();
    for (const a of agents) a.setGoal('gather wood for a house', 'inventoryHas:oak_log>=12');
    try {
      await waitFor(() => heard.some((h) => HOSTILE_RE.test(h.text)), 90_000, 'hostile talk', 500);
      await waitFor(() => duels().length > 0, 180_000, 'a brawl', 500);
      // However it went, it ends in a yield: someone says so, or stops fighting back, or runs off; nobody dies.
      const ended = () => heard.some((h) => SURRENDER_RE.test(h.text)) || duels().some(([, r]) => ['won', 'yielded', 'gone'].includes(String(r.data?.outcome)) || r.data?.why === 'fizzled out');
      await waitFor(ended, 90_000, 'the brawl to end in a yield', 500);
      // Then they go back to the grove: friction from working the same spot, and no second brawl (pair cooldown).
      await waitFor(
        () => (gorm.store.state.social.Brak?.friction ?? 0) > 0 || (brak.store.state.social.Gorm?.friction ?? 0) > 0,
        150_000,
        'friction from sharing the grove',
        1000,
      );
      await sleep(10_000);
      report();
      expect(heard.some((h) => HOSTILE_RE.test(h.text))).toBe(true);
      // At most one brawl between them: one duel each at most (they may both have gone at it at once).
      for (const name of ['Gorm', 'Brak']) expect(duels().filter(([n]) => n === name).length).toBeLessThanOrEqual(1);
      // A brawl ends in a yield (in words or deeds), or fizzles out with no winner; never in a death.
      for (const [, r] of duels()) expect(r.data?.outcome === 'interrupted' ? r.data.why : r.data?.outcome).toMatch(/^(won|yielded|gone|fizzled out|called off)$/);
      // No double victories, and a winner never also gives up (both may give up at once: an even fight).
      const winners = duels().filter(([, r]) => r.data?.outcome === 'won').map(([n]) => n);
      expect(winners.length).toBeLessThanOrEqual(1);
      const yielders = new Set(heard.filter((h) => SURRENDER_RE.test(h.text)).map((h) => h.who));
      for (const w of winners) expect(yielders.has(w)).toBe(false);
      expect(Math.max(...agents.flatMap((a) => Object.values(a.store.state.conflict.rungs)))).toBeLessThanOrEqual(3);
      expect(deaths).toEqual([]);
      for (const b of Object.values(bodies)) expect(b.bot.health).toBeGreaterThan(0);
      // The one who lost knows it, and fears the winner a little more.
      const fought = agents.map((a) => a.store.state.social[a.name === 'Gorm' ? 'Brak' : 'Gorm']?.lastFight?.outcome);
      expect(fought.some((o) => o === 'won' || o === 'yielded')).toBe(true);
    } finally {
      report();
      for (const a of agents) await a.stop();
      for (const b of Object.values(bodies)) await b.disconnect();
      await wit.disconnect();
    }
  }, 600_000);
});
