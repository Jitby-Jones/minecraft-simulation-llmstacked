// Anvils and enchanting live (owner request, 2026-10-24): a sword named at an anvil in sight; with no anvil about, one
// made of 31 iron, put down and used; a sword enchanted at an enchanting table with lapis and experience; and without
// experience, a plain no.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { customNameOf, enchantsOf } from '@agora/agent/body/skills/enchanting';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const G = DEEP_GROUND_Y - 1;

describe.skipIf(!liveJavaPath())('Anvils and enchanting live', () => {
  let server: LiveServer;
  let pip: Body;
  let zoneIndex = 0;

  async function zone(): Promise<{ x: number; z: number }> {
    zoneIndex++;
    const x = zoneIndex * 300;
    const z = 0;
    await server.cmd(`forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    await server.cmd(`tp Pip ${x} ${DEEP_GROUND_Y} ${z}`);
    await waitFor(() => pip.bot.entity.position.distanceTo(new Vec3(x, DEEP_GROUND_Y, z)) < 2 && pip.bot.blockAt(new Vec3(x, G, z)) !== null, 15000, 'zone loaded');
    await sleep(800);
    await server.cmd('clear Pip');
    await server.cmd('xp set Pip 0 levels');
    await server.cmd('xp set Pip 0 points');
    return { x, z };
  }

  const run = async (skill: string, args: Record<string, unknown>) => {
    const r = await pip.run(skill, args, { signal: AbortSignal.timeout(180_000) });
    console.log(`[${skill}] ${JSON.stringify({ ok: r.ok, observed: r.observed, error: r.error })}`);
    return r;
  };

  beforeAll(async () => {
    server = await startLiveServer({ name: 'enchant', deepGround: true });
    await server.cmd('gamerule advance_time false');
    await server.cmd('time set 1000');
    const logger = createLogger({ name: 'enchant-live', console: false, level: 'debug', logDir: path.join(server.dir, '..', 'logs') });
    pip = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger });
    await sleep(1000);
  }, 300_000);

  afterAll(async () => {
    await pip?.disconnect();
    await server?.stop();
  });

  it('names a sword at an anvil in sight; without experience it says it needs some', async () => {
    const o = await zone();
    await server.cmd(`setblock ${o.x + 3} ${G + 1} ${o.z} minecraft:anvil`);
    await server.cmd('give Pip minecraft:iron_sword 1');
    await sleep(800);
    const no = await run('name', { item: 'sword', name: 'Hope' });
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/experience/);
    await server.cmd('xp add Pip 5 levels');
    await waitFor(() => pip.bot.experience.level >= 5, 5000, 'levels');
    const r = await run('name', { item: 'sword', name: 'Hope' });
    expect(r.ok).toBe(true);
    const sword = pip.bot.inventory.items().find((i) => i.name === 'iron_sword');
    expect(customNameOf(sword)).toBe('Hope');
    await waitFor(() => pip.bot.experience.level < 5, 5000, 'a level spent');
  });

  it('with no anvil seen but 31 iron, makes one, puts it down and names a pickaxe', async () => {
    await zone();
    await server.cmd('give Pip minecraft:iron_ingot 31');
    await server.cmd('give Pip minecraft:crafting_table 1');
    await server.cmd('give Pip minecraft:stone_pickaxe 1');
    await server.cmd('xp add Pip 5 levels');
    await sleep(800);
    const r = await run('name', { item: 'pickaxe', name: 'Digger' });
    expect(r.ok).toBe(true);
    expect(customNameOf(pip.bot.inventory.items().find((i) => i.name === 'stone_pickaxe'))).toBe('Digger');
    // The anvil stands where it was put down.
    const anvils = pip.bot.findBlocks({ matching: (b) => /anvil$/.test(b.name), maxDistance: 8, count: 2 });
    expect(anvils.length).toBe(1);
  });

  it('enchants a sword at an enchanting table with lapis and experience', async () => {
    const o = await zone();
    await server.cmd(`setblock ${o.x + 3} ${G + 1} ${o.z + 1} minecraft:enchanting_table`);
    await server.cmd('give Pip minecraft:iron_sword 1');
    await server.cmd('give Pip minecraft:lapis_lazuli 3');
    await server.cmd('xp add Pip 10 levels');
    await sleep(800);
    const r = await run('enchant', { item: 'sword' });
    expect(r.ok).toBe(true);
    const sword = pip.bot.inventory.items().find((i) => i.name === 'iron_sword');
    expect(enchantsOf(pip.bot, sword).length).toBeGreaterThan(0);
  });
});
