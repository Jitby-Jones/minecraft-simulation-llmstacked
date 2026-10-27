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

  it('a creeper on open ground, a stone sword: hit and backed off from while it hisses, it dies without going off', async () => {
    // Fought as a zombie is, standing and swinging, one blew up and took its fighter from 20 health to 7.
    const x = 7800;
    await server.cmd(`forceload add ${x - 24} -24 ${x + 24} 24`);
    await server.cmd(`fill ${x - 12} ${Y} -12 ${x + 12} ${Y + 4} 12 air`);
    await server.cmd(`fill ${x - 12} ${Y + 5} -12 ${x + 12} ${Y + 5} 12 glowstone`);
    await server.cmd(`tp Ada ${x}.5 ${Y} 0.5 -90 0`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_sword 1');
    await server.cmd('effect give Ada minecraft:instant_health 1 3');
    await sleep(1500);
    const before = body.bot.health;
    await server.cmd(`summon creeper ${x + 7}.5 ${Y} 0.5 {PersistenceRequired:1b}`);
    await sleep(1000);
    const r = await body.run('attack', { target: 'creeper', seconds: 60 }, { signal: new AbortController().signal });
    logger.info({ ok: r.ok, observed: r.observed, health: body.bot.health }, 'creeper on open ground');
    console.log(`[melee creeper] ${r.observed}, health ${before} to ${body.bot.health}`);
    expect(r.ok).toBe(true);
    // Killed, not blown up: a blast would have left a crater and taken most of the health.
    expect(body.bot.health).toBeGreaterThanOrEqual(14);
    expect(body.bot.blockAt(body.bot.entity.position.floored().offset(0, -1, 0))?.name).not.toBe('air');
  }, 120_000);

  it('a block put toward "the nearest zombie", as said: it goes between, on that side', async () => {
    // Asked so in a cave, one was told there was no "nearest zombie" in sight, and took it that it was under a roof.
    const x = 7900;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    await server.cmd(`fill ${x - 8} ${Y} -8 ${x + 8} ${Y + 4} 8 air`);
    await server.cmd(`fill ${x - 8} ${Y + 5} -8 ${x + 8} ${Y + 5} 8 glowstone`);
    await server.cmd(`tp Ada ${x}.5 ${Y} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:cobblestone 4');
    await server.cmd(`summon zombie ${x + 5}.5 ${Y} 0.5 {PersistenceRequired:1b,NoAI:1b}`);
    await sleep(1500);
    try {
      const r = await body.run('place', { block: 'cobblestone', toward: 'the nearest zombie' }, { signal: new AbortController().signal });
      logger.info({ ok: r.ok, observed: r.observed, err: r.error }, 'a block toward the nearest zombie');
      expect(r.ok).toBe(true);
      expect(body.bot.blockAt(body.bot.entity.position.floored().offset(1, 0, 0))?.name).toBe('cobblestone');
    } finally {
      await server.cmd('kill @e[type=minecraft:zombie]');
    }
  }, 60_000);

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

  it('on a stair dug up under gravel, it comes down on its head: back down the step it came up, before the column follows', async () => {
    // One dug at such a column for nine seconds (19 health to 3), the step it had come up from open behind it.
    const x = 7300;
    const y = Y - 12;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    await server.cmd(`fill ${x - 2} ${y - 2} -2 ${x + 6} ${y + 12} 2 stone`);
    // Four steps up to the east, each with room to stand and to jump; a light at the bottom.
    for (let i = 0; i < 4; i++) await server.cmd(`fill ${x + i} ${y + i} 0 ${x + i} ${y + i + 2} 0 air`);
    await server.cmd(`setblock ${x - 1} ${y + 1} 0 glowstone`);
    await server.cmd(`tp Ada ${x + 3}.5 ${y + 3} 0.5 -90 0`);
    await server.cmd('clear Ada');
    await server.cmd('effect clear Ada');
    await server.cmd('effect give Ada minecraft:instant_health 1 3');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(1500);
    dangers.length = 0;
    body.reflexes.start();
    await sleep(1000);
    await server.cmd(`fill ${x + 3} ${y + 4} 0 ${x + 3} ${y + 9} 0 gravel`);
    const start = Date.now();
    while (Date.now() - start < 15_000 && body.bot.health > 0) await sleep(500);
    const at = body.bot.entity.position;
    const head = body.bot.blockAt(at.offset(0, 1.62, 0));
    logger.info({ health: body.bot.health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), at: at.toString(), head: head?.name }, 'gravel on the head on a stair');
    console.log(`[stair gravel] health ${body.bot.health}, at ${at.toString()}, head in ${head?.name}`);
    body.reflexes.stop();
    expect(dangers.some((d) => d.source === 'suffocation')).toBe(true);
    expect(body.bot.health).toBeGreaterThan(16);
    expect(head?.name).not.toBe('gravel');
  }, 120_000);

  it('in a flooded pit with steep walls all round: it gets out onto dry ground (one was in one six minutes, and died there)', async () => {
    const x = 7400;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    // A pit three across and eight deep in the stone, five of it water.
    await server.cmd(`fill ${x - 1} ${Y - 8} -1 ${x + 1} ${Y - 1} 1 air`);
    await server.cmd(`fill ${x - 1} ${Y - 8} -1 ${x + 1} ${Y - 4} 1 water`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 6} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('effect clear Ada');
    await server.cmd('effect give Ada minecraft:instant_health 1 3');
    for (const g of ['stone_pickaxe 1', 'dirt 16']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(1500);
    dangers.length = 0;
    body.reflexes.start();
    const start = Date.now();
    let tries = 0;
    // As the mind would: the walk out again whenever something cut it short.
    while (Date.now() - start < 120_000 && body.bot.entity.position.y < Y - 0.5 && body.bot.health > 0) {
      tries++;
      cut = new AbortController();
      const r = await body.run('goTo', { x: x + 5, y: Y, z: 0, range: 2 }, { signal: cut.signal });
      logger.info({ tries, ok: r.ok, observed: r.observed, error: r.error, at: body.bot.entity.position.toString(), dangers: dangers.map((d) => `${d.kind}:${d.source}`) }, 'out of the pit');
      await sleep(500);
    }
    cut = null;
    body.reflexes.stop();
    logger.info({ tries, at: body.bot.entity.position.toString(), health: body.bot.health, ms: Date.now() - start }, 'flooded pit');
    expect(body.bot.health).toBeGreaterThan(0);
    expect(body.bot.entity.position.y).toBeGreaterThan(Y - 0.5);
  }, 180_000);

  it('digging a staircase down with a stone sword, a zombie coming down behind: it kills it, and lives', async () => {
    const x = 6400;
    const y = Y - 8;
    await tunnel(x, y);
    const r = await digWithZombie('prospect', { item: 'diamond_ore', maxBlocks: 24 }, `${x + 2}.5 ${y} 0.5`);
    expect(r.alive).toBe(true);
    expect(r.zombie).toBe(false);
  }, 120_000);

  it('by day down in the dark with monsters about, the shelter is dug and kept until they have gone', async () => {
    // At 1.5 health among zombies in a cave by day, an agent was told "it is already day", twice, and died.
    const x = 3400;
    const y = Y - 30;
    await tunnel(x, y);
    // Zombies in a closed pocket of the stone 6 blocks off: about, not at hand.
    await server.cmd(`fill ${x + 6} ${y} 6 ${x + 7} ${y + 1} 7 air`);
    for (let i = 0; i < 2; i++) await server.cmd(`summon zombie ${x + 6}.5 ${y} 6.5 {PersistenceRequired:1b}`);
    for (const g of ['cobblestone 16']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(1500);
    const run = body.run('shelter', { untilMorning: true }, { signal: AbortSignal.timeout(90_000) });
    await sleep(8000);
    const feet = body.bot.entity.position.floored();
    const sealed = body.bot.blockAt(feet.offset(0, 2, 0));
    logger.info({ at: feet.toString(), over: sealed?.name }, 'dug in by day');
    expect(sealed?.name).not.toBe('air');
    await server.cmd('kill @e[type=minecraft:zombie]');
    const r = await run;
    logger.info({ r }, 'shelter by day with monsters about');
    expect(r.ok).toBe(true);
    expect(r.observed).toMatch(/the monsters about gone/);
  }, 150_000);
});
