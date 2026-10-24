// A death ends every activity (owner request, 2026-10-24; §16.3), on a real Paper server. Ada has no model (the code
// default is her whole brain), so she strolls about as soon as she starts. She is killed mid-stroll: from then on she
// never moves, says nothing, decides nothing and runs no skill, and her body is not respawned (not at the spawn, and
// not as a spectator to wander off in). Bo, a plain client beside her, is the one who would hear her.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersonaSchema, WorldConfigSchema, createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { connectBody, disconnectBody } from '@agora/agent/body/bot';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('live: a death ends everything', () => {
  let server: LiveServer;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'death', port: 25612, rconPort: 25613, deepGround: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty peaceful', 'gamerule respawn_radius 0']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('killed mid-stroll: still, silent, no more decisions or skills, and never respawned', async () => {
    const x = 2200;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    await server.cmd(`setworldspawn ${x + 40} ${Y} 0`);
    const logger = createLogger({ name: 'death', console: process.env.AGORA_DEBUG === '1' });
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger });
    const bo = await connectBody({ host: server.host, port: server.port, username: 'Bo', version: versions.minecraft.version });
    await server.cmd(`tp Ada ${x} ${Y} 0`);
    await server.cmd(`tp Bo ${x + 3} ${Y} 0`);
    await sleep(1500);
    const ada = new Agent({
      body,
      persona: PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['curious'], social: { initiateChance: 1 } }),
      username: 'Ada',
      llm: null,
      logger,
      world: WorldConfigSchema.parse({}),
      goalGen: false,
      socialGoals: false,
    });
    const heard: string[] = [];
    bo.on('messagestr', (m: string) => void heard.push(m));
    const said: { text: string; at: number }[] = [];
    const chat = body.bot.chat.bind(body.bot);
    body.bot.chat = (m: string) => {
      said.push({ text: m, at: Date.now() });
      chat(m);
    };
    ada.start();
    const decisions: number[] = [];
    const runs: number[] = [];
    ada.bus.on('decision', () => void decisions.push(Date.now()));
    ada.bus.on('actionRecorded', () => void runs.push(Date.now()));
    try {
      // Up and about: a stroll (or a word to Bo) under way.
      await waitFor(() => ada.store.state.option?.status === 'running', 30_000, 'Ada doing something', 250);
      await sleep(1500);
      const diedAt = Date.now();
      await server.cmd('kill Ada');
      await waitFor(() => ada.isDead, 5000, 'Ada knows she died', 50);
      expect(body.dead).toBe(true);
      const fell = body.bot.entity.position.clone();
      // A while after: nothing of her acts.
      await sleep(8000);
      expect((body.bot as unknown as { isAlive: boolean }).isAlive).toBe(false);
      expect(body.bot.health).toBeLessThanOrEqual(0);
      expect(body.bot.entity.position.distanceTo(fell)).toBeLessThan(0.5);
      expect(said.filter((l) => l.at > diedAt)).toEqual([]);
      const lateDecisions = decisions.filter((t) => t > diedAt + 200);
      const lateRuns = runs.filter((t) => t > diedAt + 1500);
      expect(lateDecisions).toEqual([]);
      // A skill under way at death ends with it (recorded once, aborted); none starts after.
      expect(lateRuns).toEqual([]);
      expect((await body.run('wander', { radius: 8, seconds: 5 })).error).toBe('dead');
      // Bo heard her die, and never a word from her after.
      const deathLine = heard.findIndex((m) => /Ada/.test(m) && /killed|died|fell/i.test(m));
      expect(deathLine).toBeGreaterThanOrEqual(0);
      expect(heard.slice(deathLine + 1).filter((m) => /Ada/.test(m))).toEqual([]);
      console.log(`[death] Ada said ${said.length} line(s) in life; heard by Bo after: none; decisions after: ${lateDecisions.length}; skills after: ${lateRuns.length}`);
    } finally {
      await ada.stop();
      await body.disconnect();
      await disconnectBody(bo);
    }
  }, 120_000);
});
