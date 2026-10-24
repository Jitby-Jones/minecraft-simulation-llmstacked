// Melee where agents died (owner request, 2026-10-24: agents that live through the night). In the long runs, agents
// with stone swords died to a lone zombie that came at them while they dug: in a tunnel, on a staircase down. A
// scripted body (reflexes as the agent has them; danger cuts the skill short, as the executor does) digging with a
// zombie coming up behind it. Each fight's record (swings made, blows landed) says how it went.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, repoRoot, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import type { DangerInfo } from '@agora/agent/body/reflexes';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('live: melee', () => {
  let server: LiveServer;
  let body: Body;
  const dangers: DangerInfo[] = [];
  let cut: AbortController | null = null;
  const logger = createLogger({ name: 'melee-live', logDir: path.join(repoRoot(), 'data', 'live-test', 'melee-agents'), console: process.env.AGORA_DEBUG === '1' });

  beforeAll(async () => {
    server = await startLiveServer({ name: 'melee', port: 25642, rconPort: 25643, deepGround: true, monsters: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 6000', 'difficulty easy']) await server.cmd(c);
    body = await Body.connect(
      { host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger },
      {
        caution: () => 0.62,
        combat: () => 0.5,
        onDanger: (d) => {
          dangers.push(d);
          cut?.abort();
        },
        onDangerCleared: () => undefined,
        isIdle: () => cut === null || cut.signal.aborted,
      },
    );
    await sleep(2000);
  }, 300_000);

  afterAll(async () => {
    await body?.disconnect();
    await server?.stop();
  });

  /** A tunnel dug into the stone, lit; the agent at its east end with a sword, a pickaxe and torches. */
  async function tunnel(x: number, y: number): Promise<void> {
    await server.cmd(`forceload add ${x - 16} -16 ${x + 40} 16`);
    await server.cmd(`fill ${x} ${y} 0 ${x + 6} ${y + 1} 0 air`);
    await server.cmd(`setblock ${x} ${y + 2} 0 glowstone`);
    await server.cmd(`setblock ${x + 6} ${y + 2} 0 glowstone`);
    await server.cmd(`tp Ada ${x + 6}.5 ${y} 0.5 -90 0`);
    await server.cmd('clear Ada');
    await server.cmd('effect clear Ada');
    for (const g of ['stone_sword 1', 'stone_pickaxe 1', 'torch 8']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(1500);
  }

  /** Runs `skill` until danger cuts it short; a zombie comes up behind after `delay`; then 30 s of the fight. */
  async function digWithZombie(skill: string, args: Record<string, unknown>, zombieAt: string): Promise<{ alive: boolean; zombie: boolean }> {
    body.reflexes.start();
    cut = new AbortController();
    const run = body.run(skill, args, { signal: cut.signal });
    await sleep(2500);
    await server.cmd(`summon zombie ${zombieAt} {PersistenceRequired:1b}`);
    const start = Date.now();
    const zombieNear = () => Boolean(body.bot.nearestEntity((e) => e.name === 'zombie' && e.position.distanceTo(body.bot.entity.position) < 24));
    while (Date.now() - start < 30_000 && body.bot.health > 0 && (zombieNear() || Date.now() - start < 3000)) await sleep(500);
    const result = { alive: body.bot.health > 0, zombie: zombieNear() };
    logger.info({ skill, health: body.bot.health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), fight: body.reflexes.fightRecord(), ...result }, 'melee');
    console.log(`[melee ${skill}] health ${body.bot.health}, zombie ${result.zombie ? 'still there' : 'dead'}, fight ${JSON.stringify(body.reflexes.fightRecord())}`);
    cut.abort();
    await run.catch(() => null);
    body.reflexes.stop();
    cut = null;
    return result;
  }

  it('digging a tunnel with a stone sword, a zombie behind: it turns, kills it, and lives', async () => {
    const x = 6200;
    const y = Y - 8;
    await tunnel(x, y);
    const r = await digWithZombie('prospect', { item: 'diamond_ore', direction: 'east', maxBlocks: 24 }, `${x}.5 ${y} 0.5`);
    expect(r.alive).toBe(true);
    expect(r.zombie).toBe(false);
  }, 120_000);

  it('digging a staircase down with a stone sword, a zombie coming down behind: it kills it, and lives', async () => {
    const x = 6400;
    const y = Y - 8;
    await tunnel(x, y);
    const r = await digWithZombie('prospect', { item: 'diamond_ore', maxBlocks: 24 }, `${x + 2}.5 ${y} 0.5`);
    expect(r.alive).toBe(true);
    expect(r.zombie).toBe(false);
  }, 120_000);
});
