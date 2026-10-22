// M9b exit test (§19.8 scenarios T and U) on a real server, with code-only agents.
//   T  reproduction, through the real Hub, supervisor and bot runtime: Ned and Ivy, partners for days and fond of
//      each other, with a home (two beds side by side by a chest) and food. One asks "want to start a family?" (whoever
//      gets there first; each checks it from their own side); the other, all being in place on their side too, says yes. At night both go to bed in the two beds; each, lying beside the
//      other asleep, reports it to the Hub, which pairs the two reports and, after gestation, brings a child into the
//      world at the beds. The child's first words name its parents ("Ned, Ivy: hi dad, hi mom!"), which is how they
//      know it for theirs. Its traits fall within the parents' ranges ± noise; it starts out knowing its family (kin,
//      sentiment 9, admiration 0.8) and no one else, with a memory of its own (none inherited).
//   U  feud transmission: Ned bears a grudge against Gorm, who attacked him. His newborn daughter Lily, who has never
//      met Gorm, greets him; he warns her about Gorm, and her view of Gorm sours, told and not seen. Later Gorm comes
//      by and gives her bread: her view of him mends somewhat (she may revise it after meeting him).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GAME_DAY_MS,
  HubConfigSchema,
  type Logger,
  ModelsConfigSchema,
  NUMERIC_TRAIT_KEYS,
  type Persona,
  PersonaSchema,
  SeededRandom,
  SexDifferencesSchema,
  WorldConfigSchema,
  agentDbPath,
  createLogger,
  dataPaths,
  ensureDataDirs,
  getTrait,
  loadVersionsConfig,
  parseProximityLine,
  setTrait,
  sleep,
} from '@agora/shared';
import { Hub, type Launcher, Supervisor, loadRoster } from '@agora/hub';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { type RunningBot, runBot } from '@agora/agent/hub/runtime';
import { MemoryDB } from '@agora/agent/memory/db';
import { newSocialProfile } from '@agora/agent/state/social';
import { withGrievance } from '@agora/agent/social/math';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const PORT = 25602;
const Y = DEEP_GROUND_Y;

const person = (o: { name: string; sex: 'male' | 'female'; familyName?: string; trait: number; openness?: number; inventory?: { item: string; qty: number }[] }): Persona => {
  const p = PersonaSchema.parse({
    id: o.name.toLowerCase(),
    name: o.name,
    sex: o.sex,
    orientation: 'hetero',
    traits: ['kind', 'steady'],
    ...(o.familyName ? { familyName: o.familyName } : {}),
    drives: { caution: 0.4 },
    abilities: { combat: 0.3, intelligence: 0.8 },
    social: { initiateChance: 0 },
    inventory: o.inventory ?? [],
  });
  // Parents apart on every numeric trait, so "within their ranges" means something.
  for (const k of NUMERIC_TRAIT_KEYS) setTrait(p, k, o.trait);
  if (o.openness !== undefined) setTrait(p, 'openness', o.openness);
  return p;
};

describe.skipIf(!liveJavaPath())('M9b live: families', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm9b', port: PORT, rconPort: 25603, deepGround: true });
    logger = createLogger({ name: 'm9b-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false, level: process.env.AGORA_LIVE_DEBUG ? 'debug' : 'info' });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty peaceful', 'gamerule respawn_radius 0']) await server.cmd(c);
    // Two in bed shouldn't end the night for the world while the test watches.
    await server.cmd('gamerule players_sleeping_percentage 101').catch(() => '');
  });

  afterAll(async () => {
    await server?.stop();
  });

  /** Everyone's lines as one listener hears them (each once), and a timeline for the report. */
  function listen(bodies: Body[], t0: number) {
    const lines: { who: string; text: string; at: number }[] = [];
    const timeline: string[] = [];
    const at = () => `${Math.round((Date.now() - t0) / 1000)} s`;
    for (const b of bodies) {
      b.bot.on('messagestr', (m: string) => {
        const p = parseProximityLine(m);
        if (p.kind !== 'speech') return;
        if (lines.some((h) => h.who === p.speaker && h.text === p.text && Math.abs(h.at - Date.now()) < 2000)) return;
        lines.push({ who: p.speaker, text: p.text, at: Date.now() });
        timeline.push(`${at()} ${p.speaker}: "${p.text}"`);
      });
    }
    return { lines, timeline, at };
  }

  it('T: partners with a home ask, agree, sleep side by side, and a child comes, knowing its parents', async () => {
    const x = 600;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    // The home: two beds side by side (foot and head each), and a chest beside them.
    for (const bx of [x, x + 1]) {
      await server.cmd(`setblock ${bx} ${Y} 1 minecraft:red_bed[facing=south,part=head]`);
      await server.cmd(`setblock ${bx} ${Y} 0 minecraft:red_bed[facing=south,part=foot]`);
    }
    await server.cmd(`setblock ${x + 3} ${Y} 0 minecraft:chest`);
    const root = path.join(server.dir, '..', 'm9b-t');
    fs.rmSync(root, { recursive: true, force: true });
    const paths = ensureDataDirs(dataPaths(root));
    const hub = new Hub({ config: HubConfigSchema.parse({}), logger, embedder: null, quota: () => null, runtimeHoursPerWeek: 30 });
    await hub.listen(0);
    hub.start();
    const w = WorldConfigSchema.parse({
      population: { initial: 2, minAlive: 2, maxAlive: 4, spawnStaggerSec: 1, spawnRadius: 0, starterKit: 'persona' },
      server: { host: '127.0.0.1', port: server.port },
      conflict: { maxRung: 2 },
      romance: { partnerMinDays: 2 },
      reproduction: { gestationSec: 20, coupleCooldownSec: 7200, youthSec: 900, minFoodItems: 20 },
    });
    const running: RunningBot[] = [];
    const launcher: Launcher = (slot) => {
      let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
      let bot: RunningBot | null = null;
      void runBot({ hubUrl: `ws://127.0.0.1:${hub.port}`, slot, paths, world: w, versions, models: ModelsConfigSchema.parse({}), apiKey: '', logger: logger.child({ slot }) }).then((b) => {
        bot = b;
        running.push(b);
        void b.done.then(() => exit?.(0, null));
      });
      return { slot, pid: undefined, kill: () => void bot?.stop('killed'), onExit: (cb) => (exit = cb) };
    };
    const ned = person({ name: 'Ned', sex: 'male', familyName: 'Stark', trait: 0.35, inventory: [{ item: 'bread', qty: 24 }] });
    const ivy = person({ name: 'Ivy', sex: 'female', trait: 0.65, inventory: [{ item: 'bread', qty: 24 }] });
    const sup = new Supervisor({ hub, paths, world: w, sexDiffs: SexDifferencesSchema.parse({}), pool: [ned, ivy], launcher, logger, rng: new SeededRandom(19), rcon: (c) => server.cmd(c) });
    const watcher = await Body.connect({ host: server.host, port: server.port, username: 'Watcher', version: versions.minecraft.version, logger });
    const t0 = Date.now();
    const heard = listen([watcher], t0);
    const agentOf = (name: string) => running.find((b) => b.username === name)?.agent;
    const report = () => {
      console.log(`[m9b T] timeline:\n  ${heard.timeline.join('\n  ')}`);
      for (const b of running) {
        const f = b.agent.store.state.family;
        console.log(`[m9b T] ${b.username}: partner ${f.partner ?? '-'}, parents ${f.parents.join('+') || '-'}, children ${f.children.join('+') || '-'}, planning ${f.planning?.with ?? '-'}, asleep ${b.agent.store.state.self.isSleeping}`);
      }
      console.log(`[m9b T] roster: ${loadRoster(paths.roster).agents.map((a) => `${a.username}${a.parents ? ` (of ${a.parents.join(' and ')})` : ''}`).join(', ')}; pending ${loadRoster(paths.roster).pendingBirths.length}`);
    };
    try {
      await sup.start();
      await waitFor(() => agentOf('Ned') && agentOf('Ivy'), 120_000, 'Ned and Ivy running', 500);
      // Partners for three in-game days, fond of each other; at home.
      for (const [me, them, sex] of [
        ['Ned', 'Ivy', 'female'],
        ['Ivy', 'Ned', 'male'],
      ] as const) {
        const a = agentOf(me) as Agent;
        const t = Date.now();
        a.store.update('family', (f) => ({ ...f, partner: them }), 'partners');
        a.store.update(
          'social',
          (all) => ({
            ...all,
            [them]: { ...(all[them] ?? newSocialProfile(them, a.store.state.self.persona, t)), relationship: 'partner', relationshipSince: t - 3 * GAME_DAY_MS, sentiment: 9.5, evidence: 9.5, trust: 0.9, perceivedSex: sex, romanticInterest: 0.9 },
          }),
          'partners',
        );
      }
      // A day at home (code-only Goal Gen would send them off looking for trees on this treeless ground).
      for (const n of ['Ned', 'Ivy']) {
        const a = agentOf(n) as Agent;
        a.goalGen?.stop();
        a.store.update('goals', (g) => ({ ...g, current: null }), 'a day at home');
      }
      await server.cmd(`tp Ned ${x + 0.5} ${Y} 3.5`);
      await server.cmd(`tp Ivy ${x + 2.5} ${Y} 3.5`);
      await server.cmd(`tp Watcher ${x + 6.5} ${Y} 3.5`);
      // One asks (whoever gets there first); the other, all being in place on their side too, says yes: both are
      // planning a family.
      const ask = () => heard.lines.find((l) => (l.who === 'Ned' || l.who === 'Ivy') && /start a family\?/.test(l.text));
      await waitFor(() => Boolean(ask()), 240_000, 'one of them asking', 500);
      const asker = ask()?.who;
      await waitFor(() => heard.lines.some((l) => l.who !== asker && (l.who === 'Ned' || l.who === 'Ivy') && /yes, let'?s start a family/i.test(l.text)), 60_000, 'the other saying yes', 500);
      await waitFor(() => agentOf('Ned')?.store.state.family.planning && agentOf('Ivy')?.store.state.family.planning, 30_000, 'both planning', 500);
      // Night: both to bed, side by side; each reports it, and the Hub pairs the reports.
      await server.cmd('time set 13000');
      heard.timeline.push(`${heard.at()} -- night --`);
      await waitFor(() => loadRoster(paths.roster).pendingBirths.length === 1, 300_000, 'a child on the way', 1000);
      const pending = loadRoster(paths.roster).pendingBirths[0];
      expect(pending?.parents.slice().sort()).toEqual(['Ivy', 'Ned']);
      heard.timeline.push(`${heard.at()} -- conception reported by both --`);
      await server.cmd('time set 1000');
      // After gestation: the child, at the beds, greeting its parents by name.
      const child = await waitFor(() => loadRoster(paths.roster).agents.find((a) => a.parents), 120_000, 'the child born', 1000);
      const kid = await waitFor(() => agentOf(child.username), 120_000, 'the child running', 500);
      await waitFor(() => heard.lines.some((l) => l.who === child.username && /hi (dad|mom)/.test(l.text)), 60_000, 'the child greeting its parents', 500);
      await waitFor(() => agentOf('Ned')?.store.state.family.children.includes(child.username) && agentOf('Ivy')?.store.state.family.children.includes(child.username), 90_000, 'both parents knowing their child', 500);
      report();
      // At the beds.
      const at = kid.store.state.self.pos;
      expect(Math.hypot(at.x - (x + 1), at.z - 0.5)).toBeLessThan(6);
      // Its traits within the parents' range ± noise (one child: nearly all of them).
      const p = child.persona;
      const within = NUMERIC_TRAIT_KEYS.filter((k) => getTrait(p, k) >= 0.35 - 0.25 && getTrait(p, k) <= 0.65 + 0.25).length;
      console.log(`[m9b T] ${child.username} (${p.sex}, gen ${p.generation}, family ${p.familyName ?? '-'}): ${within}/${NUMERIC_TRAIT_KEYS.length} traits within the parents' range ± 0.25`);
      expect(within / NUMERIC_TRAIT_KEYS.length).toBeGreaterThanOrEqual(0.85);
      expect(p).toMatchObject({ source: 'born', generation: 1, familyName: 'Stark' });
      // It knows its family and no one else; its parents know it as theirs.
      const ks = kid.store.state;
      expect(ks.life.born).toBe(true);
      expect(ks.family.parents.slice().sort()).toEqual(['Ivy', 'Ned']);
      for (const parent of ['Ned', 'Ivy']) {
        expect(ks.social[parent]).toMatchObject({ kin: 'parent', admiration: 0.8 });
        expect(ks.social[parent]?.sentiment).toBeGreaterThanOrEqual(8.5);
        expect(agentOf(parent)?.store.state.social[child.username]?.kin).toBe('child');
      }
      expect(Object.values(ks.social).every((q) => q.grievances.length === 0)).toBe(true);
      // No memories inherited: its memory database is its own, new at its birth, with nothing long-term in it, and what
      // is on its mind is from its own short life.
      const db = new MemoryDB(agentDbPath(paths, child.username));
      try {
        expect(db.count('long')).toBe(0);
      } finally {
        db.close();
      }
      expect(ks.workmem.every((m) => m.ts >= child.bornAt - 1000)).toBe(true);
    } finally {
      report();
      await sup.shutdown('test', 20_000);
      for (const b of running) await b.stop('test over').catch(() => undefined);
      await watcher.disconnect();
      await hub.close();
    }
  }, 1_200_000);

  it('U: a parent warns his young daughter about the man who attacked him; she has never met him, and turns against him', async () => {
    const x = 900;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    const world = WorldConfigSchema.parse({ conflict: { maxRung: 2, newcomerGraceSec: 0 }, reproduction: { youthSec: 1800 } });
    const ned = person({ name: 'Ned', sex: 'male', familyName: 'Stark', trait: 0.5 });
    const lily = person({ name: 'Lily_S', sex: 'female', familyName: 'Stark', trait: 0.5, openness: 0.9 });
    const connect = (username: string) => Body.connect({ host: server.host, port: server.port, username, version: versions.minecraft.version, logger });
    const nedBody = await connect('Ned');
    const lilyBody = await connect('Lily_S');
    for (const n of ['Ned', 'Lily_S']) await server.cmd(`clear ${n}`);
    await server.cmd(`give Ned minecraft:bread 8`);
    await server.cmd(`tp Ned ${x} ${Y} 0`);
    await server.cmd(`tp Lily_S ${x + 4} ${Y} 0`);
    await sleep(1500);
    const t0 = Date.now();
    const heard = listen([nedBody, lilyBody], t0);
    const nedAgent = new Agent({ body: nedBody, persona: ned, username: 'Ned', llm: null, logger: logger.child({ agent: 'Ned' }), world, goalGen: false, socialGoals: false, rng: () => 0.99 });
    // Gorm attacked Ned and took his iron: a grudge (Gorm is nowhere near; he isn't even online).
    nedAgent.store.update(
      'social',
      (all) => {
        let g = { ...newSocialProfile('Gorm', ned, t0), sentiment: 2, evidence: 2 };
        g = withGrievance(g, 'attack', ned, { now: t0 - 10 * 60_000, witnessed: true, source: 'self_observed', note: 'Gorm attacked me' });
        g = withGrievance(g, 'theft', ned, { now: t0 - 5 * 60_000, witnessed: true, source: 'self_observed', note: 'Gorm took my iron' });
        return { ...all, Gorm: g, Ivy: { ...newSocialProfile('Ivy', ned, t0), sentiment: 9 } };
      },
      'a grudge',
    );
    nedAgent.store.update('family', (f) => ({ ...f, partner: 'Ivy' }), 'partner');
    const lilyAgent = new Agent({
      body: lilyBody,
      persona: lily,
      username: 'Lily_S',
      llm: null,
      logger: logger.child({ agent: 'Lily_S' }),
      world,
      goalGen: false,
      socialGoals: false,
      rng: () => 0.99,
      birth: { facts: { parents: [{ username: 'Ned', name: 'Ned', sex: 'male' }, { username: 'Ivy', name: 'Ivy', sex: 'female' }], siblings: [], home: { x, y: Y, z: 0 }, familyName: 'Stark' }, youthUntil: t0 + 30 * 60_000 },
    });
    const seenGorm = () => lilyAgent.store.state.perception.nearbyEntities.some((e) => e.name === 'Gorm');
    let everSawGorm = false;
    const look = setInterval(() => void (everSawGorm ||= seenGorm()), 500);
    const baseline = newSocialProfile('Gorm', lily, t0).sentiment;
    let gorm: Body | null = null;
    try {
      expect(nedAgent.conflict.resentmentOf('Gorm')).toBeGreaterThanOrEqual(0.5);
      nedAgent.start();
      lilyAgent.start();
      // Her first words; he knows her for his, looks after her, and warns her about Gorm.
      await waitFor(() => heard.lines.some((l) => l.who === 'Lily_S' && /hi dad/.test(l.text)), 60_000, 'Lily greeting her father', 500);
      await waitFor(() => nedAgent.store.state.family.children.includes('Lily_S'), 30_000, 'Ned knowing his daughter', 500);
      const warning = await waitFor(() => heard.lines.find((l) => l.who === 'Ned' && /watch out for Gorm/i.test(l.text)), 180_000, "Ned's warning", 500);
      await waitFor(() => (lilyAgent.store.state.social.Gorm?.sentiment ?? baseline) < baseline - 0.25, 30_000, 'Lily souring on Gorm', 500);
      const soured = lilyAgent.store.state.social.Gorm;
      console.log(`[m9b U] Ned: "${warning.text}"; Lily on Gorm: sentiment ${soured?.sentiment.toFixed(2)} (from ${baseline.toFixed(2)}), grievances ${soured?.grievances.map((g) => `${g.kind} ${g.source}`).join(', ')}`);
      expect(soured?.grievances.some((g) => g.source === 'told_by:Ned')).toBe(true);
      expect(everSawGorm).toBe(false);
      // Later, Gorm comes by and gives her bread: what she sees of him mends her view somewhat.
      const low = soured?.sentiment ?? baseline;
      gorm = await connect('Gorm');
      await server.cmd('clear Gorm');
      await server.cmd('give Gorm minecraft:bread 4');
      await server.cmd('execute at Lily_S run tp Gorm ~2 ~ ~');
      await sleep(1500);
      const lp = lilyBody.bot.entity.position;
      await gorm.bot.lookAt(lp.offset(0, 1.2, 0), true);
      const bread = gorm.bot.inventory.items().find((i) => i.name === 'bread');
      if (bread) await gorm.bot.toss(bread.type, null, 3);
      await waitFor(() => (lilyAgent.store.state.social.Gorm?.sentiment ?? 0) > low, 60_000, 'Lily thinking better of Gorm', 500);
      console.log(`[m9b U] after Gorm's gift, Lily on Gorm: ${lilyAgent.store.state.social.Gorm?.sentiment.toFixed(2)} (low ${low.toFixed(2)})`);
    } finally {
      clearInterval(look);
      console.log(`[m9b U] timeline:\n  ${heard.timeline.join('\n  ')}`);
      await nedAgent.stop();
      await lilyAgent.stop();
      await nedBody.disconnect();
      await lilyBody.disconnect();
      await gorm?.disconnect();
    }
  }, 600_000);
});
