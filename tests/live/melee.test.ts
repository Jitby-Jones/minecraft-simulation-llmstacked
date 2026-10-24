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

  it('a skeleton across a trench it cannot cross: it gives up closing in and gets out of its sight, and lives', async () => {
    const x = 6600;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 32} 24`);
    // An island in a trench five wide and six deep, roofed against the sun, a skeleton on it; the agent nine blocks off.
    await server.cmd(`fill ${x + 5} ${Y - 6} -6 ${x + 17} ${Y - 1} 6 air`);
    await server.cmd(`fill ${x + 10} ${Y - 6} -1 ${x + 12} ${Y - 1} 1 stone`);
    await server.cmd(`fill ${x + 10} ${Y + 7} -1 ${x + 12} ${Y + 7} 1 stone`);
    await server.cmd(`tp Ada ${x + 2}.5 ${Y} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('effect clear Ada');
    await server.cmd('effect give Ada minecraft:instant_health 1 3');
    await server.cmd('give Ada minecraft:stone_sword 1');
    await sleep(1500);
    dangers.length = 0;
    body.reflexes.start();
    await server.cmd(`summon skeleton ${x + 11}.5 ${Y} 0.5 {PersistenceRequired:1b}`);
    const start = Date.now();
    let gaveUp = false;
    while (Date.now() - start < 45_000 && body.bot.health > 0) {
      await sleep(500);
      if (body.reflexes.mode === 'flee') gaveUp = true;
    }
    const health = body.bot.health;
    logger.info({ health, gaveUp, dangers: dangers.map((d) => `${d.kind}:${d.source}`), fight: body.reflexes.fightRecord(), at: body.bot.entity.position.toString() }, 'unreachable archer');
    body.reflexes.stop();
    await server.cmd('kill @e[type=minecraft:skeleton]');
    expect(health).toBeGreaterThan(0);
    expect(gaveUp).toBe(true);
  }, 120_000);

  it("zombies one at a time on open ground, a stone sword: each met at a sword's length and killed, for little health", async () => {
    const x = 6800;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    // Open ground under a roof (no sun to burn them), lit so nothing else comes.
    await server.cmd(`fill ${x - 12} ${Y} -12 ${x + 12} ${Y + 4} 12 air`);
    await server.cmd(`fill ${x - 12} ${Y + 5} -12 ${x + 12} ${Y + 5} 12 glowstone`);
    await server.cmd(`tp Ada ${x}.5 ${Y} 0.5 -90 0`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_sword 1');
    await sleep(1500);
    const lost: number[] = [];
    for (let i = 0; i < 3; i++) {
      await server.cmd('effect give Ada minecraft:instant_health 1 3');
      await server.cmd('effect give Ada minecraft:saturation 1 5');
      await sleep(1000);
      const before = body.bot.health;
      const p = body.bot.entity.position;
      await server.cmd(`summon zombie ${Math.floor(p.x) + 7}.5 ${Y} ${Math.floor(p.z)}.5 {PersistenceRequired:1b,IsBaby:0b}`);
      await sleep(1000);
      const r = await body.run('attack', { target: 'zombie', seconds: 30 }, { signal: new AbortController().signal });
      lost.push(Math.round((before - body.bot.health) * 10) / 10);
      logger.info({ fight: i, ok: r.ok, observed: r.observed, health: body.bot.health, lost: lost.at(-1) }, 'zombie on open ground');
      console.log(`[melee open ground ${i}] ${r.observed}, health ${before} to ${body.bot.health}`);
      expect(r.ok).toBe(true);
      expect(body.bot.health).toBeGreaterThan(0);
    }
    // A player meets them at a sword's length: a blow taken now and then, not two or three a zombie.
    expect(lost.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9);
  }, 240_000);

  it('gravel comes down on its head in a tunnel: dug out and a step aside, and it lives', async () => {
    const x = 7200;
    const y = Y - 8;
    await tunnel(x, y);
    dangers.length = 0;
    body.reflexes.start();
    await sleep(1000);
    // Its head in gravel, and a column of it over that (a tunnel's roof opened under one).
    await server.cmd(`fill ${x + 6} ${y + 1} 0 ${x + 6} ${y + 6} 0 gravel`);
    const start = Date.now();
    while (Date.now() - start < 20_000 && body.bot.health > 0) await sleep(500);
    const head = body.bot.blockAt(body.bot.entity.position.offset(0, 1.62, 0));
    logger.info({ health: body.bot.health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), at: body.bot.entity.position.toString(), head: head?.name }, 'gravel on the head');
    body.reflexes.stop();
    expect(dangers.some((d) => d.source === 'suffocation')).toBe(true);
    expect(body.bot.health).toBeGreaterThan(12);
    expect(head?.name).not.toBe('gravel');
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
