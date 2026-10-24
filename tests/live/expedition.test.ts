// Expeditions live (owner request, 2026-10-24): a portal built of 10 obsidian and lit; through it into the Nether, the
// way back remembered and taken; an End portal's twelve frames filled with eyes, and through it into the End, where
// there is no way out until the dragon is dead. (Eyes of ender lead to strongholds, which a flat test world has none
// of: that skill isn't tried here.)

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PortalNote, createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { dimensionOf } from '@agora/agent/body/skills/expedition';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const G = DEEP_GROUND_Y - 1;

describe.skipIf(!liveJavaPath())('Expeditions live', () => {
  let server: LiveServer;
  let pip: Body;
  const portals: PortalNote[] = [];
  const book = { list: () => portals, note: (p: PortalNote) => void portals.push(p) };

  const run = async (skill: string, args: Record<string, unknown>, ms = 180_000) => {
    const r = await pip.run(skill, args, { signal: AbortSignal.timeout(ms), portals: book });
    console.log(`[${skill}] ${JSON.stringify({ ok: r.ok, observed: r.observed, error: r.error })}`);
    return r;
  };

  beforeAll(async () => {
    server = await startLiveServer({ name: 'expedition', deepGround: true });
    await server.cmd('gamerule advance_time false');
    await server.cmd('time set 1000');
    const logger = createLogger({ name: 'expedition-live', console: false, level: 'debug', logDir: path.join(server.dir, '..', 'logs') });
    pip = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    await sleep(1000);
    // Nothing in the Nether may end the test early.
    await server.cmd('effect give Pip minecraft:fire_resistance infinite 0 true');
    await server.cmd('effect give Pip minecraft:resistance infinite 4 true');
  }, 300_000);

  afterAll(async () => {
    await pip?.disconnect();
    await server?.stop();
  });

  it('builds and lights a nether portal, goes into the Nether, and comes back the same way', async () => {
    await server.cmd('forceload add -16 -16 16 16');
    await server.cmd(`tp Pip 0 ${DEEP_GROUND_Y} 0`);
    await waitFor(() => pip.bot.entity.position.distanceTo(new Vec3(0, DEEP_GROUND_Y, 0)) < 2, 15000, 'in place');
    await server.cmd('clear Pip');
    await server.cmd('give Pip minecraft:obsidian 10');
    await server.cmd('give Pip minecraft:cobblestone 8');
    await server.cmd('give Pip minecraft:flint_and_steel 1');
    await server.cmd('give Pip minecraft:dirt 32');
    await sleep(800);
    const built = await run('portal', {});
    expect(built.ok).toBe(true);
    expect(portals.some((p) => p.dimension === 'overworld' && p.leadsTo === 'the_nether')).toBe(true);
    const there = await run('travel', { to: 'nether' });
    expect(there.ok).toBe(true);
    expect(dimensionOf(pip.bot)).toBe('the_nether');
    expect(portals.some((p) => p.dimension === 'the_nether' && p.leadsTo === 'overworld')).toBe(true);
    // Walked out of the portal, it doesn't take us back by itself.
    await sleep(6000);
    expect(dimensionOf(pip.bot)).toBe('the_nether');
    const back = await run('travel', { to: 'overworld' });
    expect(back.ok).toBe(true);
    expect(dimensionOf(pip.bot)).toBe('overworld');
    // Home stayed where it was: it's in the Overworld.
    expect(pip.home ? pip.home.distanceTo(new Vec3(0, DEEP_GROUND_Y, 0)) : 999).toBeLessThan(64);
  }, 600_000);

  it('fills an End portal with eyes, goes into the End, and finds no way out while the dragon lives', async () => {
    const x0 = 400;
    const z0 = 0;
    await server.cmd(`forceload add ${x0 - 16} ${z0 - 16} ${x0 + 16} ${z0 + 16}`);
    await server.cmd(`tp Pip ${x0 + 2} ${DEEP_GROUND_Y} ${z0 - 3}`);
    await waitFor(() => pip.bot.entity.position.distanceTo(new Vec3(x0 + 2, DEEP_GROUND_Y, z0 - 3)) < 2, 15000, 'in place');
    // The frame ring: three on each side, facing in.
    for (let i = 1; i <= 3; i++) {
      await server.cmd(`setblock ${x0 + i} ${G} ${z0} minecraft:end_portal_frame[facing=south]`);
      await server.cmd(`setblock ${x0 + i} ${G} ${z0 + 4} minecraft:end_portal_frame[facing=north]`);
      await server.cmd(`setblock ${x0} ${G} ${z0 + i} minecraft:end_portal_frame[facing=east]`);
      await server.cmd(`setblock ${x0 + 4} ${G} ${z0 + i} minecraft:end_portal_frame[facing=west]`);
    }
    await server.cmd(`fill ${x0 + 1} ${G} ${z0 + 1} ${x0 + 3} ${G} ${z0 + 3} minecraft:air`);
    await server.cmd(`fill ${x0 + 1} ${G - 1} ${z0 + 1} ${x0 + 3} ${G - 1} ${z0 + 3} minecraft:stone`);
    await server.cmd('clear Pip');
    await server.cmd('give Pip minecraft:ender_eye 12');
    await sleep(1000);
    const filled = await run('fill', {});
    expect(filled.ok).toBe(true);
    expect(filled.observed).toMatch(/open/);
    const end = await run('travel', { to: 'end' });
    expect(end.ok).toBe(true);
    expect(dimensionOf(pip.bot)).toBe('the_end');
    const out = await run('travel', { to: 'overworld' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/dragon/);
  }, 600_000);
});
