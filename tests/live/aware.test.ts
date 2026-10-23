// Noticing a shelter broken open (owner request, 2026-10-23: agents didn't react to their shelter being broken), on
// a real Paper server. Ada has no model (the code default is her whole brain), so at night she digs in. A wall of her
// shelter is knocked out beside her head: she notices it as her shelter's, her wait in it ends, and she patches the
// hole with dirt she carries. RCON only sets the scene and makes the hole, as a player breaking the block would.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BlockChange, PersonaSchema, WorldConfigSchema, createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { isEnclosed, isSolid } from '@agora/agent/body/world';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('live: noticing what changes around us', () => {
  let server: LiveServer;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'aware', port: 25610, rconPort: 25611, deepGround: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'difficulty peaceful']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('a wall of her shelter knocked out beside her at night: noticed as hers, the wait ends, and she patches it', async () => {
    const x = 2000;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    const logger = createLogger({ name: 'aware', console: process.env.AGORA_DEBUG === '1' });
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger });
    await server.cmd(`tp Ada ${x} ${Y} 0`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:dirt 8');
    await server.cmd('time set 18000');
    await sleep(2000);
    const ada = new Agent({
      body,
      persona: PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['careful'], social: { initiateChance: 0 } }),
      username: 'Ada',
      llm: null,
      logger,
      world: WorldConfigSchema.parse({}),
      goalGen: false,
      socialGoals: false,
    });
    ada.start();
    const t0 = Date.now();
    const at = () => `${Math.round((Date.now() - t0) / 1000)} s`;
    const log: string[] = [];
    ada.bus.on('decision', (e) => void log.push(`${at()} ${e.decision.option}${e.decision.task ? ` ${e.decision.task.skill} ${JSON.stringify(e.decision.task.args)}` : ''}: ${e.decision.rationale}`));
    ada.bus.on('actionRecorded', (e) => void log.push(`${at()}   ${e.record.skill}: ${e.record.ok ? 'ok' : 'FAILED'} ${e.record.observed}${e.record.error ? ` (${e.record.error})` : ''}`));
    const noticed: BlockChange[] = [];
    ada.bus.on('surroundingsChanged', (e) => {
      noticed.push(e.change);
      log.push(`${at()}   noticed: ${JSON.stringify(e.change)}`);
    });
    try {
      // Night, and no mind to choose otherwise: she digs in.
      await waitFor(() => ada.store.state.option?.skill === 'shelter' && isEnclosed(body.bot), 90_000, 'Ada dug in', 500);
      await sleep(2000);
      const feet = body.bot.entity.position.floored();
      const hole = feet.offset(1, 1, 0);
      // Digging in, what she dug herself was no news.
      expect(noticed).toEqual([]);
      log.push(`${at()} -- the wall beside her head knocked out at ${hole.toString()} --`);
      await server.cmd(`setblock ${hole.x} ${hole.y} ${hole.z} air`);
      // She notices it as her shelter's, and the wait in it is over (her mind moves on, or the skill sees the hole).
      await waitFor(() => noticed.some((c) => c.ours === 'shelter' && c.kind === 'broken'), 10_000, 'the hole noticed', 250);
      const seen = noticed.find((c) => c.ours === 'shelter');
      expect(seen?.pos).toEqual({ x: hole.x, y: hole.y, z: hole.z });
      expect(seen?.where).toBe('beside you to the east, at head height');
      await waitFor(() => ada.store.state.actionLog.some((r) => r.skill === 'shelter' && !r.ok), 10_000, 'the wait in the shelter over', 250);
      // And she patches it.
      await waitFor(() => isSolid(body.bot.blockAt(new Vec3(hole.x, hole.y, hole.z))), 45_000, 'the hole patched', 500);
      expect(ada.store.state.actionLog.some((r) => r.skill === 'place' && r.ok && r.args.x === hole.x && r.args.y === hole.y && r.args.z === hole.z)).toBe(true);
      expect(ada.store.state.workmem.some((w) => /I noticed the dirt of your shelter beside you to the east, at head height was broken/.test(w.text))).toBe(true);
      // Patched: no longer a change on her mind.
      expect(ada.store.state.perception.blockChanges.some((c) => c.ours === 'shelter' && c.kind === 'broken')).toBe(false);
    } finally {
      console.log(`[aware] ${log.join('\n  ')}`);
      await ada.stop();
      await body.disconnect();
    }
  }, 240_000);
});
