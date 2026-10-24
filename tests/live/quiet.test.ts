// A question met with silence by someone standing right there (owner request, 2026-10-24: agents kept asking people
// they could see whether they were still there, which broke the flow of talk). Ada asks Bo something in real chat;
// Bo, in plain sight, says nothing. Ada asks nothing more of him, least of all whether he is still there, and the talk
// ends quietly. (With a key, tests/live/real-models.test.ts has the same with the speech models.)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersonaSchema, WorldConfigSchema, createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { DEEP_GROUND_Y, type LiveServer, PRESENCE_CHECK, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('live: a question met with silence by someone in sight', () => {
  let server: LiveServer;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'quiet', port: 25622, rconPort: 25623, deepGround: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'difficulty peaceful', 'time set 1000']) await server.cmd(c);
  }, 300_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('asks nothing more, never whether he is still there, and the talk ends quietly', async () => {
    const x = 3000;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    const logger = createLogger({ name: 'quiet-live', console: process.env.AGORA_DEBUG === '1' });
    const adaBody = await Body.connect({ host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger });
    const bo = await Body.connect({ host: server.host, port: server.port, username: 'Bo', version: versions.minecraft.version, logger });
    await server.cmd(`tp Ada ${x} ${Y} 0`);
    await server.cmd(`tp Bo ${x + 3} ${Y} 0`);
    await sleep(2000);
    const ada = new Agent({
      body: adaBody,
      persona: PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['chatty'], social: { initiateChance: 0 } }),
      username: 'Ada',
      llm: null,
      logger,
      world: WorldConfigSchema.parse({}),
      goalGen: false,
      socialGoals: false,
    });
    const heard: string[] = [];
    bo.bot.on('messagestr', (m: string) => void heard.push(m));
    const ends: string[] = [];
    ada.bus.on('conversationEnded', (e) => void ends.push(e.reason));
    ada.start();
    try {
      const why = ada.cc.force({
        option: 'talk',
        target: { agent: 'Bo' },
        speechIntent: { stance: 'ask', gist: 'ask Bo whether he wants to go mining together', mayCommit: false },
        terminate: { maxSeconds: 60 },
        rationale: 'mining is better with two',
      });
      expect(why).toBeNull();
      await waitFor(() => heard.some((m) => /Ada/.test(m)), 20_000, 'Bo heard Ada', 250);
      const asked = Date.now();
      // Bo stands right there and says nothing.
      await waitFor(() => ends.includes('partner silent') || null, 45_000, 'the talk ended quietly', 500);
      expect(Date.now() - asked).toBeLessThan(40_000);
      await sleep(5000);
      const fromAda = heard.filter((m) => /Ada/.test(m));
      console.log(`[quiet] Bo heard: ${fromAda.join(' | ')}; ends: ${ends.join(', ')}`);
      expect(fromAda.some((m) => PRESENCE_CHECK.test(m))).toBe(false);
    } finally {
      await ada.stop();
      await adaBody.disconnect();
      await bo.disconnect();
    }
  }, 180_000);
});
