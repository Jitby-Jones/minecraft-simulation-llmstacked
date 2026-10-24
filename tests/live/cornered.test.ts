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
    await server.cmd(`fill ${x - 6} ${Y} -6 ${x + 6} ${Y} 6 glowstone replace grass_block`);
    await server.cmd(`fill ${x} ${Y} 0 ${x} ${Y} 0 air`);
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
    const start = Date.now();
    while (Date.now() - start < 30_000 && alive()) await sleep(500);
    const at = body.bot.entity.position.floored();
    const lid = body.bot.blockAt(new Vec3(x, Y, 0))?.name;
    logger.info({ health: body.bot.health, dangers: dangers.map((d) => `${d.kind}:${d.source}`), at: at.toString(), lid }, 'cornered');
    expect(alive()).toBe(true);
    const inHole = at.x === x && at.z === 0 && at.y < Y;
    expect(!inHole || lid === 'dirt').toBe(true);
  }, 120_000);
});
