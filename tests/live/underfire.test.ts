// A mind under fire, live, with the real model (owner, 2026-10-24: hurt among monsters in a cave, a player runs, digs
// into the wall and up to the surface; better still, has cooked food on them to heal with). Nothing here says what to
// do: she has her body, what she carries and her hands, and it is her mind's to think of a way. Each case only asks
// that she lives, and writes down what she thought and did.
// Spends real subscription quota: only with NANOGPT_API_KEY set and AGORA_LIVE_LLM=1.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Logger, PersonaSchema, WorldConfigSchema, createLogger, loadEnv, loadModelsConfigForRuns, loadVersionsConfig, repoRoot, sleep } from '@agora/shared';
import { type LlmRuntime, loadBenchFile, startLlm } from '@agora/llm';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

loadEnv();
const key = process.env.NANOGPT_API_KEY?.trim();
const withModel = Boolean(key) && process.env.AGORA_LIVE_LLM === '1';
const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

function real(logger: Logger): Promise<LlmRuntime> {
  return startLlm({ apiKey: key ?? '', config: loadModelsConfigForRuns(), logger, bench: loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'), logger), background: false, pollUsage: false });
}

describe.skipIf(!liveJavaPath() || !withModel)('live: a mind under fire', () => {
  let server: LiveServer;
  let rt: LlmRuntime;
  const logger = createLogger({ name: 'underfire-live', logDir: path.join(repoRoot(), 'data', 'live-test', 'underfire-agents'), console: process.env.AGORA_DEBUG === '1' });

  beforeAll(async () => {
    server = await startLiveServer({ name: 'underfire', port: 25660, rconPort: 25661, deepGround: true, monsters: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 6000', 'difficulty easy']) await server.cmd(c);
    rt = await real(logger);
  }, 300_000);

  afterAll(async () => {
    await server?.stop();
  });

  const agentFor = (body: Body, name: string) => {
    return new Agent({
      body,
      persona: PersonaSchema.parse({ name, sex: 'female', traits: ['practical', 'careful'], social: { initiateChance: 0 }, abilities: { intelligence: 0.7 } }),
      username: name,
      llm: rt.client,
      logger,
      world: WorldConfigSchema.parse({}),
      goalGen: false,
      socialGoals: false,
    });
  };

  /**
   * A dark cave room seven across, thirty down, with the tunnel she came by going off it to the west; she stands by its
   * mouth, hurt and hungry, with what she has on her. Zombies come at her from the far side. 90 s of it.
   */
  async function caught(x: number, kit: string[], zombies: number): Promise<{ alive: boolean; lowest: number; acts: string[]; thoughts: string[] }> {
    const y = Y - 30;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    await server.cmd(`fill ${x - 3} ${y} -3 ${x + 3} ${y + 2} 3 air`);
    await server.cmd(`fill ${x - 16} ${y} 0 ${x - 4} ${y + 1} 0 air`);
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger });
    await server.cmd(`tp Ada ${x - 2}.5 ${y} 0.5 90 0`);
    await server.cmd('clear Ada');
    await server.cmd('effect clear Ada');
    for (const g of kit) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(2000);
    // Hungry: under 18, so no health comes back by itself.
    await server.cmd('effect give Ada minecraft:hunger 10 200');
    await waitFor(() => body.bot.food <= 12, 20_000, 'hungry', 100);
    await server.cmd('effect clear Ada');
    await server.cmd('damage Ada 13 minecraft:generic');
    await sleep(1000);
    const ada = agentFor(body, 'Ada');
    const acts: string[] = [];
    const thoughts: string[] = [];
    ada.bus.on('actionRecorded', (e) => void acts.push(`${e.record.skill} ${JSON.stringify(e.record.args)} ${e.record.ok ? 'ok' : 'failed'}: ${(e.record.observed ?? '').slice(0, 120)}${e.record.error ? ` (${e.record.error.slice(0, 100)})` : ''}`));
    ada.bus.on('decision', (e) => {
      if (e.decision.source === 'llm') thoughts.push(`${e.decision.thought ?? ''} => ${e.decision.task ? `${e.decision.task.skill} ${JSON.stringify(e.decision.task.args)}` : e.decision.option} | ${e.decision.rationale}`);
    });
    ada.start();
    let lowest = body.bot.health;
    try {
      await sleep(4000);
      for (let i = 0; i < zombies; i++) await server.cmd(`summon zombie ${x + 3}.5 ${y} ${i - 1}.5 {PersistenceRequired:1b}`);
      const end = Date.now() + 90_000;
      while (Date.now() < end && body.bot.health > 0) {
        lowest = Math.min(lowest, body.bot.health);
        await sleep(500);
      }
      return { alive: body.bot.health > 0, lowest, acts, thoughts };
    } finally {
      logger.info({ alive: body.bot.health > 0, health: body.bot.health, food: body.bot.food, lowest, at: body.bot.entity.position.toString(), acts, thoughts }, 'under fire');
      process.stdout.write(`UNDERFIRE ${JSON.stringify({ alive: body.bot.health > 0, health: body.bot.health, food: body.bot.food, lowest, at: body.bot.entity.position.floored().toString(), acts, thoughts })}\n`);
      await server.cmd('kill @e[type=minecraft:zombie]');
      await ada.stop();
      await body.disconnect();
    }
  }

  it('hurt and hungry in a dark cave, three zombies coming, cooked beef, a sword and a pickaxe on her: she lives', async () => {
    const r = await caught(9000, ['stone_sword 1', 'stone_pickaxe 1', 'cooked_beef 6', 'cobblestone 32', 'torch 8'], 3);
    expect(r.thoughts.length).toBeGreaterThan(0);
    expect(r.alive).toBe(true);
  }, 300_000);

  it('hurt and hungry in a dark cave, five zombies coming, no food, a pickaxe and blocks on her: she lives', async () => {
    const r = await caught(9200, ['wooden_sword 1', 'stone_pickaxe 1', 'cobblestone 32'], 5);
    expect(r.thoughts.length).toBeGreaterThan(0);
    expect(r.alive).toBe(true);
  }, 300_000);
});
