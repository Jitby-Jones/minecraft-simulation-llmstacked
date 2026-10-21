// M1 exit test (§10): a scripted bot — skills and reflexes, no LLM — survives a night with monsters around.
// RCON only sets the scene (time, monsters) and reads the outcome; nothing it sees reaches the bot.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import type { DangerInfo } from '@agora/agent/body/reflexes';
import type { SkillRunRecord } from '@agora/agent/body/skills/runner';
import { isEnclosed } from '@agora/agent/body/world';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = -60;

describe.skipIf(!liveJavaPath())('M1 live: a scripted bot survives a night', () => {
  let server: LiveServer;
  let wren: Body;
  let current: AbortController | null = null;
  let inDanger = false;
  let died = false;
  const dangers: DangerInfo[] = [];
  const news: string[] = [];

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm1-night', port: 25567, rconPort: 25577, monsters: true });
    await server.cmd('gamerule advance_weather false');
    await server.cmd('weather clear');
    await server.cmd('gamerule advance_time false');
    await server.cmd('time set 13000');
    const logger = createLogger({ name: 'm1-night', console: false });
    wren = await Body.connect(
      { host: server.host, port: server.port, username: 'Wren', version: versions.minecraft.version, logger },
      {
        caution: () => 0.3,
        combat: () => 0.5,
        // The script's whole policy: a danger interrupts whatever it is doing; the reflexes take over.
        onDanger: (d) => {
          dangers.push(d);
          inDanger = true;
          current?.abort();
        },
        onDangerCleared: () => {
          inDanger = false;
        },
        isIdle: () => current === null,
      },
    );
    wren.bot.on('death', () => {
      died = true;
    });
    wren.bot.on('messagestr', (m: string) => {
      if (m.includes('Wren')) news.push(m);
    });
    await server.cmd(`tp Wren 0 ${Y} 0`);
    for (const item of ['stone_sword', 'bread 6', 'leather_helmet', 'leather_chestplate']) await server.cmd(`give Wren minecraft:${item}`);
    wren.reflexes.start();
    await sleep(1500);
  });

  afterAll(async () => {
    await wren?.disconnect();
    await server?.stop();
  });

  it('fights off a zombie, shelters for the night and walks out alive in the morning', async () => {
    const bot = wren.bot;
    const zombieNear = (r: number) => bot.nearestEntity((e) => e.name === 'zombie' && e.position.distanceTo(bot.entity.position) < r);

    // Nightfall: a zombie finds it in the open. (Any NBT skips summon's random rolls: no babies or reinforcements.)
    await server.cmd(`summon minecraft:zombie 8 ${Y} 0 {PersistenceRequired:1b}`);
    await waitFor(() => dangers.some((d) => d.kind === 'fight'), 20_000, 'reflex fight');
    await waitFor(() => !inDanger && !zombieNear(12), 90_000, 'zombies dealt with', 250);
    expect(died).toBe(false);

    // The script: shelter until morning; after an interruption, try again once the reflexes are done.
    const runs: SkillRunRecord[] = [];
    const script = (async () => {
      for (let i = 0; i < 8; i++) {
        while (inDanger || wren.reflexes.upkeepBusy) await sleep(250);
        current = new AbortController();
        const r = await wren.run('shelter', { untilMorning: true }, { signal: current.signal });
        current = null;
        runs.push(r);
        console.log(`[night] shelter #${i + 1}: ${r.observed}${r.aborted ? ' (aborted)' : ''}${r.error ? ` — ${r.error}` : ''}`);
        if (!r.aborted) return r;
      }
      return runs.at(-1);
    })();
    let finished = false;
    void script.then(() => (finished = true));
    await waitFor(() => isEnclosed(bot) || finished, 60_000, 'sealed in', 250);
    expect(isEnclosed(bot)).toBe(true);
    const sealedHealth = bot.health;

    // Midnight with monsters at the door; the night is fast-forwarded (~70 s of real time).
    await server.cmd('gamerule advance_time true');
    await server.cmd('time set 18000');
    const p = bot.entity.position.floored();
    for (const [dx, dz] of [
      [2, 0],
      [-2, 0],
      [0, 2],
    ] as const) {
      await server.cmd(`summon minecraft:zombie ${p.x + dx} ${Y} ${p.z + dz} {PersistenceRequired:1b}`);
    }
    await sleep(2000);
    const nearby = await server.cmd(`execute at Wren if entity @e[type=minecraft:zombie,distance=..8]`);
    expect(nearby).toMatch(/count: [3-9]/i);
    let lowest = bot.health;
    const ff = setInterval(() => {
      if (isEnclosed(bot)) lowest = Math.min(lowest, bot.health);
      if (bot.time.timeOfDay >= 12_000 || bot.time.timeOfDay < 1500) void server.cmd('time add 100').catch(() => undefined);
    }, 1000);
    try {
      const r = await Promise.race([script, sleep(240_000).then(() => null)]);
      expect(r).not.toBeNull();
      if (!r) return;
      // The skill reports its postcondition: alive and it is day.
      expect(r.ok).toBe(true);
      expect(r.mismatch).toBe(false);
      expect(r.expected).toBe('alive and it is day');
      expect(r.observed).toMatch(/climbed out|already day/);
    } finally {
      clearInterval(ff);
    }
    // Nothing touched it while it was sealed in.
    expect(lowest).toBeGreaterThanOrEqual(sealedHealth - 0.01);

    // Out in the morning with whatever is left of the night; the reflexes keep it alive.
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 16);
      seen.push(`${bot.health.toFixed(0)}hp:${near.map((e) => `${e.name}@${e.position.distanceTo(bot.entity.position).toFixed(0)}`).join(',')}`);
    }
    if (died) console.log(`[night] died: ${news.join(' | ')}; dangers ${dangers.map((d) => `${d.kind}:${d.source}`).join(',')}; after exit ${seen.join(' ')}`);
    expect(died).toBe(false);
    expect(bot.health).toBeGreaterThan(0);
    // Out of the shelter (the climb leaves the top block of the shaft open, so allow one block).
    expect(isEnclosed(bot)).toBe(false);
    expect(bot.entity.position.y).toBeGreaterThanOrEqual(Y - 1.01);
    expect(bot.time.timeOfDay).toBeLessThan(12_000);
  }, 600_000);
});
