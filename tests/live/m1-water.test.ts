// Water (owner report, 2026-10-23): in a hardcore run three agents drowned. Each time a walk ended in a lake the
// body sank while the mind took its time over what next, and the swim reflex keyed on an air reading that never
// came (on 26.1 the server's air supply doesn't reach mineflayer's oxygenLevel). Now a head under water long enough
// is a hazard whatever the reading, an idle body treads water and swims for the shore, and walks aren't aimed at the
// middle of a lake. RCON only sets the scene and reads the outcome.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import type { DangerInfo } from '@agora/agent/body/reflexes';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('M1 live: not drowning', () => {
  let server: LiveServer;
  let finn: Body;
  let died = false;
  let busy: AbortController | null = null;
  const dangers: DangerInfo[] = [];

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm1-water', port: 25606, rconPort: 25607, deepGround: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty hard']) await server.cmd(c);
    const logger = createLogger({ name: 'm1-water', console: process.env.AGORA_DEBUG === '1' });
    finn = await Body.connect(
      { host: server.host, port: server.port, username: 'Finn', version: versions.minecraft.version, logger },
      {
        caution: () => 0.4,
        combat: () => 0.5,
        onDanger: (d) => {
          dangers.push(d);
          busy?.abort();
        },
        onDangerCleared: () => undefined,
        // Nothing driving the body: the mind is thinking what to do next (a slow model, a long wait).
        isIdle: () => busy === null,
      },
    );
    finn.bot.on('death', () => {
      died = true;
    });
    // A lake 25 across and 8 deep, its floor at Y 33 (the ground around stands at Y 41), dug once Finn is there to
    // keep its chunks loaded.
    await server.cmd(`tp Finn -16 ${Y} 0`);
    await sleep(1500);
    const filled = await server.cmd(`fill -12 ${Y - 8} -12 12 ${Y - 1} 12 minecraft:water`);
    console.log(`[m1 water] fill: ${filled}`);
    finn.reflexes.start();
    await sleep(1000);
  });

  afterAll(async () => {
    await finn?.disconnect();
    await server?.stop();
  });

  const inWater = () => finn.bot.blockAt(finn.bot.entity.position)?.name === 'water';

  it('held at the bottom of a lake full of fish (a skill holding the body, not treading), the swim reflex brings it up', async () => {
    for (let i = 0; i < 6; i++) await server.cmd(`summon minecraft:cod ${-4 + i} ${Y - 6} 2 {PersistenceRequired:1b}`);
    await server.cmd(`summon minecraft:squid 2 ${Y - 5} -2 {PersistenceRequired:1b}`);
    busy = new AbortController();
    await server.cmd(`tp Finn 0 ${Y - 8} 0`);
    await sleep(500);
    const air: number[] = [];
    const t0 = Date.now();
    const log = setInterval(() => air.push(finn.bot.oxygenLevel), 1000);
    const headOut = () => finn.bot.blockAt(finn.bot.entity.position.offset(0, 1.6, 0))?.name !== 'water';
    try {
      await waitFor(() => dangers.some((d) => d.kind === 'hazard' && d.source === 'water'), 15_000, 'the swim reflex');
      await waitFor(headOut, 20_000, 'the head out of the water', 250);
    } finally {
      clearInterval(log);
      busy = null;
      console.log(`[m1 water] held under: hazard after ${Math.round((Date.now() - t0) / 1000)} s; health ${finn.bot.health}; air readings ${air.join(' ')}`);
    }
    expect(died).toBe(false);
    expect(finn.bot.health).toBeGreaterThan(14);
    dangers.length = 0;
  }, 60_000);

  it('left on the bottom of a deep lake with nothing to do, it comes up, treads water and swims ashore', async () => {
    expect(finn.bot.blockAt(new Vec3(0, Y - 4, 0))?.name).toBe('water');
    await server.cmd(`tp Finn 0 ${Y - 8} 0`);
    await sleep(500);
    const air: number[] = [];
    const t0 = Date.now();
    const log = setInterval(() => air.push(finn.bot.oxygenLevel), 1000);
    try {
      // Treading brings the head up within seconds (before the swim reflex is needed), then it makes for the shore.
      await waitFor(() => finn.bot.blockAt(finn.bot.entity.position.offset(0, 1.6, 0))?.name !== 'water', 8000, 'the head above water', 250);
      await waitFor(() => !inWater() && finn.bot.entity.onGround, 45_000, 'out of the water', 500);
    } finally {
      clearInterval(log);
      console.log(`[m1 water] ashore after ${Math.round((Date.now() - t0) / 1000)} s at ${finn.bot.entity.position.floored().toString()}; health ${finn.bot.health}; air readings ${air.join(' ')}`);
    }
    expect(died).toBe(false);
    expect(finn.bot.health).toBeGreaterThan(14);
    // Out on the shore, beyond the lake's edge.
    const p = finn.bot.entity.position;
    expect(Math.max(Math.abs(p.x), Math.abs(p.z))).toBeGreaterThan(12);
    expect(p.y).toBeGreaterThanOrEqual(Y - 0.5);
  }, 90_000);

  it('walks from the shore end on dry ground, not out in the lake', async () => {
    await server.cmd(`tp Finn -14 ${Y} 0`);
    await sleep(1000);
    const ends: string[] = [];
    for (let i = 0; i < 5; i++) {
      busy = new AbortController();
      const r = await finn.run('explore', { distance: 12 }, { signal: busy.signal });
      busy = null;
      ends.push(`${finn.bot.entity.position.floored().toString()}${inWater() ? ' (in the water)' : ''} ${r.ok ? '' : r.error ?? ''}`);
      expect(inWater()).toBe(false);
    }
    console.log(`[m1 water] explore ended at: ${ends.join(' | ')}`);
    expect(died).toBe(false);
  }, 120_000);
});
