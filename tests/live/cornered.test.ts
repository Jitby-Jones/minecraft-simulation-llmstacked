// Cornered (owner request, 2026-10-24: agents that live through the night). In the long runs an agent died in its own
// shelter hole, running from a zombie at its top: a run that can't get anywhere, and a fight from the bottom of a hole
// that can't be won. A player closes the hole over. A scripted body (reflexes only) in a hole two deep, unarmed but
// for a pickaxe, hurt enough to want to run, with a few blocks of dirt.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, repoRoot, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import type { DangerInfo } from '@agora/agent/body/reflexes';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('live: cornered', () => {
  let server: LiveServer;
  let body: Body;
  const dangers: DangerInfo[] = [];
  const logger = createLogger({ name: 'cornered-live', logDir: path.join(repoRoot(), 'data', 'live-test', 'cornered-agents'), console: process.env.AGORA_DEBUG === '1' });

  /** Every half second until `done`: where the agent is, its health and reflex, and the zombies about it. */
  async function watch(who: Body, done: () => boolean, ms: number): Promise<string[]> {
    const trace: string[] = [];
    const start = Date.now();
    while (Date.now() - start < ms && who.bot.health > 0 && !done()) {
      const me = who.bot.entity.position;
      const zombies = Object.values(who.bot.entities)
        .filter((e) => e.name === 'zombie' && e.position.distanceTo(me) < 16)
        .map((e) => `${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)}`);
      trace.push(`${((Date.now() - start) / 1000).toFixed(1)}s ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)} hp ${Math.round(who.bot.health)} ${who.reflexes.mode} z[${zombies.join(' ')}]`);
      await sleep(500);
    }
    return trace;
  }

  beforeAll(async () => {
    server = await startLiveServer({ name: 'cornered', port: 25640, rconPort: 25641, deepGround: true, monsters: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 18000', 'difficulty easy']) await server.cmd(c);
    body = await Body.connect(
      { host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger },
      { caution: () => 0.62, combat: () => 0.5, onDanger: (d) => void dangers.push(d), onDangerCleared: () => undefined, isIdle: () => true },
    );
    await sleep(2000);
  }, 300_000);

  afterAll(async () => {
    await body?.disconnect();
    await server?.stop();
  });

  it('in a hole two deep with a zombie at its top, blocks on hand: it gets out of it (towering, or closing it over) and lives', async () => {
    const x = 6000;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    // A one-wide hole two deep, the agent at its bottom; light it so nothing else spawns.
    await server.cmd(`fill ${x} ${Y - 2} 0 ${x} ${Y - 1} 0 air`);
    await server.cmd(`fill ${x - 6} ${Y - 1} -6 ${x + 6} ${Y - 1} 6 glowstone replace grass_block`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 2} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:wooden_pickaxe 1');
    await server.cmd('give Ada minecraft:dirt 4');
    await server.cmd('effect clear Ada');
    await sleep(1500);
    // Hurt to about 12 (the long run's), so a lone zombie is one to run from, unarmed.
    await server.cmd('damage Ada 8 minecraft:generic');
    await sleep(1000);
    body.reflexes.start();
    await server.cmd(`summon zombie ${x}.5 ${Y} 1.5 {PersistenceRequired:1b}`);
    const alive = () => body.bot.health > 0;
    // Thirty seconds of it: the agent lives, out of the hole or with it closed over.
    const trace = await watch(body, () => false, 30_000);
    const at = body.bot.entity.position.floored();
    const lid = body.bot.blockAt(new Vec3(x, Y, 0))?.name;
    logger.info({ health: body.bot.health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), at: at.toString(), lid, trace }, 'cornered');
    expect(alive()).toBe(true);
    const inHole = at.x === x && at.z === 0 && at.y < Y;
    expect(!inHole || lid === 'dirt').toBe(true);
  }, 120_000);

  it('cornered in the open by two zombies, hurt, cobblestone on hand: up a pillar out of their reach, and lives', async () => {
    // A body of its own: the hole above may have cost Ada hers.
    body.reflexes.stop();
    const bea = await Body.connect(
      { host: server.host, port: server.port, username: 'Bea', version: versions.minecraft.version, logger },
      { caution: () => 0.62, combat: () => 0.5, onDanger: (d) => void dangers.push(d), onDangerCleared: () => undefined, isIdle: () => true },
    );
    await sleep(2000);
    dangers.length = 0;
    const x = 6300;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    // A walled yard 11 across, lit, so running gets nowhere much and nothing else comes.
    await server.cmd(`fill ${x - 6} ${Y} -6 ${x + 6} ${Y + 2} 6 glass hollow`);
    await server.cmd(`fill ${x - 5} ${Y} -5 ${x + 5} ${Y + 2} 5 air`);
    await server.cmd(`fill ${x - 6} ${Y + 3} -6 ${x + 6} ${Y + 3} 6 air`);
    await server.cmd(`fill ${x - 6} ${Y - 1} -6 ${x + 6} ${Y - 1} 6 glowstone replace grass_block`);
    await server.cmd(`tp Bea ${x}.5 ${Y} 0.5`);
    await server.cmd('clear Bea');
    await server.cmd('give Bea minecraft:cobblestone 16');
    await server.cmd('effect clear Bea');
    await server.cmd('effect give Bea minecraft:instant_health 1 3');
    await sleep(1500);
    await server.cmd('damage Bea 10 minecraft:generic');
    await sleep(1000);
    bea.reflexes.start();
    await server.cmd(`summon zombie ${x + 5}.5 ${Y} 0.5 {PersistenceRequired:1b}`);
    await server.cmd(`summon zombie ${x - 5}.5 ${Y} 0.5 {PersistenceRequired:1b}`);
    const trace = await watch(bea, () => false, 30_000);
    const up = bea.bot.entity.position.y - Y;
    const health = bea.bot.health;
    logger.info({ health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), up, trace }, 'cornered in the open');
    bea.reflexes.stop();
    await bea.disconnect();
    expect(health).toBeGreaterThan(0);
    expect(up).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('in a tunnel with three zombies coming down it, no room overhead, a pickaxe and blocks: into the wall, shut behind, and lives', async () => {
    // One in a cave with five zombies coming and the ceiling 2 m up ran, the running failed, and she was killed with a
    // pickaxe and blocks on her.
    const cal = await Body.connect(
      { host: server.host, port: server.port, username: 'Cal', version: versions.minecraft.version, logger },
      { caution: () => 0.62, combat: () => 0.5, onDanger: (d) => void dangers.push(d), onDangerCleared: () => undefined, isIdle: () => true },
    );
    await sleep(2000);
    dangers.length = 0;
    const x = 6600;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    // Rock all round, and a tunnel one wide and two high through it, lit along its floor.
    await server.cmd(`fill ${x - 9} ${Y - 1} -3 ${x + 9} ${Y + 3} 3 stone`);
    await server.cmd(`fill ${x - 8} ${Y} 0 ${x + 8} ${Y + 1} 0 air`);
    await server.cmd(`fill ${x - 8} ${Y - 1} 0 ${x + 8} ${Y - 1} 0 glowstone`);
    await server.cmd(`tp Cal ${x + 6}.5 ${Y} 0.5`);
    await server.cmd('clear Cal');
    await server.cmd('give Cal minecraft:stone_pickaxe 1');
    await server.cmd('give Cal minecraft:cobblestone 8');
    await server.cmd('effect clear Cal');
    await sleep(1500);
    await server.cmd('damage Cal 10 minecraft:generic');
    await sleep(1000);
    cal.reflexes.start();
    for (const dx of [-6, -5, -4]) await server.cmd(`summon zombie ${x + dx}.5 ${Y} 0.5 {PersistenceRequired:1b}`);
    const trace = await watch(cal, () => false, 30_000);
    const at = cal.bot.entity.position.floored();
    const whole = (p: Vec3) => cal.bot.blockAt(p)?.boundingBox === 'block' && cal.bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'block';
    // Shut in a nook of its own, or a wall across the tunnel between it and every zombie.
    const shut = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].every((d) => whole(at.plus(d)));
    // The three in the tunnel (at night, others come out in the dark about the hill).
    const zombies = Object.values(cal.bot.entities).filter((e) => e.name === 'zombie' && Math.abs(e.position.z - 0.5) <= 1 && Math.abs(e.position.y - Y) < 1 && Math.abs(e.position.x - x) <= 9);
    const walled = zombies.every((z) => {
      const [lo, hi] = [Math.min(Math.floor(z.position.x), at.x), Math.max(Math.floor(z.position.x), at.x)];
      for (let wx = lo + 1; wx < hi; wx++) if (whole(new Vec3(wx, Y, 0))) return true;
      return false;
    });
    const health = cal.bot.health;
    logger.info({ health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), at: at.toString(), shut, walled, trace }, 'cornered in a tunnel');
    cal.reflexes.stop();
    await cal.disconnect();
    expect(health).toBeGreaterThan(0);
    expect(shut || walled).toBe(true);
  }, 120_000);

  it('in a tunnel off a cave room, zombies spread across the room beyond its mouth: a wall across the tunnel, and lives', async () => {
    // Five zombies across the cave room a tunnel came off: none stood in line with the tunnel, so no wall went up, and
    // she ran to its end and was killed there.
    const cal = await Body.connect(
      { host: server.host, port: server.port, username: 'Cal', version: versions.minecraft.version, logger },
      { caution: () => 0.62, combat: () => 0.5, onDanger: (d) => void dangers.push(d), onDangerCleared: () => undefined, isIdle: () => true },
    );
    await sleep(2000);
    dangers.length = 0;
    const x = 6800;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    // Rock all round; a room seven across east of x, lit; the tunnel one wide and two high going west from it.
    await server.cmd(`fill ${x - 11} ${Y - 1} -5 ${x + 9} ${Y + 3} 5 stone`);
    await server.cmd(`fill ${x + 1} ${Y} -3 ${x + 7} ${Y + 1} 3 air`);
    await server.cmd(`fill ${x - 10} ${Y} 0 ${x} ${Y + 1} 0 air`);
    await server.cmd(`fill ${x - 10} ${Y - 1} 0 ${x + 7} ${Y - 1} 0 glowstone`);
    await server.cmd(`tp Cal ${x - 2}.5 ${Y} 0.5`);
    await server.cmd('clear Cal');
    await server.cmd('give Cal minecraft:stone_pickaxe 1');
    await server.cmd('give Cal minecraft:cobblestone 8');
    await server.cmd('effect clear Cal');
    await sleep(1500);
    await server.cmd('damage Cal 10 minecraft:generic');
    await sleep(1000);
    cal.reflexes.start();
    for (const dz of [-2, 0, 2]) await server.cmd(`summon zombie ${x + 4}.5 ${Y} ${dz}.5 {PersistenceRequired:1b}`);
    const trace = await watch(cal, () => false, 30_000);
    const at = cal.bot.entity.position.floored();
    const whole = (p: Vec3) => cal.bot.blockAt(p)?.boundingBox === 'block' && cal.bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'block';
    const shut = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].every((d) => whole(at.plus(d)));
    // A wall in the tunnel between it and the room.
    let walled = false;
    for (let wx = at.x + 1; wx <= x; wx++) if (whole(new Vec3(wx, Y, 0))) walled = true;
    const health = cal.bot.health;
    logger.info({ health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), at: at.toString(), shut, walled, trace }, 'cornered in a tunnel off a room');
    cal.reflexes.stop();
    await cal.disconnect();
    expect(health).toBeGreaterThan(0);
    expect(shut || walled).toBe(true);
  }, 120_000);

  it('in a cave room, the ceiling far up, skeletons shooting across it, a pickaxe and blocks: into the wall, shut behind, and lives', async () => {
    // One on a ledge in a great cave, two skeletons shooting up at her from the water below, sat 40 s with "no way out
    // on foot" and bare stone beside her, and was shot dead: a nook was dug only with rock right over one's head.
    const cal = await Body.connect(
      { host: server.host, port: server.port, username: 'Cal', version: versions.minecraft.version, logger },
      { caution: () => 0.62, combat: () => 0.5, onDanger: (d) => void dangers.push(d), onDangerCleared: () => undefined, isIdle: () => true },
    );
    await sleep(2000);
    dangers.length = 0;
    const x = 7000;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    // Rock all round; a room 21 across and 10 high in it, its floor lit.
    await server.cmd(`fill ${x - 12} ${Y - 1} -10 ${x + 12} ${Y + 10} 10 stone`);
    await server.cmd(`fill ${x - 10} ${Y} -8 ${x + 10} ${Y + 9} 8 air`);
    await server.cmd(`fill ${x - 10} ${Y - 1} -8 ${x + 10} ${Y - 1} 8 glowstone`);
    await server.cmd(`tp Cal ${x}.5 ${Y} -7.5`);
    await server.cmd('clear Cal');
    await server.cmd('give Cal minecraft:stone_pickaxe 1');
    await server.cmd('give Cal minecraft:cobblestone 8');
    await server.cmd('effect clear Cal');
    // Whole first: what the cases before left of him carries over.
    await server.cmd('effect give Cal minecraft:instant_health 1 5');
    await sleep(1500);
    await server.cmd('damage Cal 10 minecraft:generic');
    await sleep(1000);
    cal.reflexes.start();
    for (const dx of [-4, 4]) await server.cmd(`summon skeleton ${x + dx}.5 ${Y} 4.5 {PersistenceRequired:1b}`);
    const trace = await watch(cal, () => false, 30_000);
    const at = cal.bot.entity.position.floored();
    const whole = (p: Vec3) => cal.bot.blockAt(p)?.boundingBox === 'block' && cal.bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'block';
    const shut = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].every((d) => whole(at.plus(d)));
    const health = cal.bot.health;
    logger.info({ health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), at: at.toString(), shut, trace }, 'cornered in a cave room by skeletons');
    process.stdout.write(`CAVE ${JSON.stringify({ health, at: at.toString(), shut, last: trace.slice(-3) })}\n`);
    await server.cmd(`kill @e[type=minecraft:skeleton]`);
    cal.reflexes.stop();
    await cal.disconnect();
    expect(health).toBeGreaterThan(0);
    expect(shut).toBe(true);
  }, 120_000);
});
