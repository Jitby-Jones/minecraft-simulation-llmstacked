// M1 live: every verified skill reports its postcondition on real Paper 26.1.2, and the L0 reflexes fight,
// flee, eat, wear armor and collect tossed items without an LLM. Each case runs in its own clean zone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { countItem } from '@agora/agent/body/inventory';
import type { DangerInfo } from '@agora/agent/body/reflexes';
import { isEnclosed } from '@agora/agent/body/world';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = -60;

describe.skipIf(!liveJavaPath())('M1 live: skills and reflexes', () => {
  let server: LiveServer;
  let pip: Body;
  let bram: Body;
  const dangers: DangerInfo[] = [];
  const cleared: string[] = [];
  let zoneIndex = 0;

  /** Teleports the bots to a fresh, flat area and returns its origin. */
  async function zone(withBram = false): Promise<{ x: number; z: number }> {
    zoneIndex++;
    const x = zoneIndex * 200;
    const z = 0;
    await server.cmd(`forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    await server.cmd(`tp Pip ${x} ${Y} ${z}`);
    if (withBram) await server.cmd(`tp Bram ${x + 4} ${Y} ${z}`);
    await waitFor(() => pip.bot.entity.position.distanceTo(new Vec3(x, Y, z)) < 2 && pip.bot.blockAt(new Vec3(x, Y - 1, z)) !== null, 15000, 'zone loaded');
    await sleep(800);
    return { x, z };
  }

  const run = async (b: Body, skill: string, args: unknown, timeoutMs = 90_000) => {
    const r = await b.run(skill, args, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) console.log(`[${skill}] ${JSON.stringify(r)}`);
    return r;
  };

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm1' });
    await server.cmd('gamerule advance_time false');
    await server.cmd('gamerule advance_weather false');
    await server.cmd('weather clear');
    await server.cmd('time set 1000');
    const logger = createLogger({ name: 'm1-live', console: false });
    pip = await Body.connect(
      { host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger, chat: { minIntervalMs: 300 } },
      { onDanger: (d) => dangers.push(d), onDangerCleared: (s) => cleared.push(s), caution: () => 0.3 },
    );
    bram = await Body.connect({ host: server.host, port: server.port, username: 'Bram', version: versions.minecraft.version, logger });
    await sleep(1000);
  });

  afterAll(async () => {
    await pip?.disconnect();
    await bram?.disconnect();
    await server?.stop();
  });

  it('goTo walks to a position and to a person, including up a step', async () => {
    const o = await zone(true);
    await server.cmd(`fill ${o.x + 10} ${Y} ${o.z - 2} ${o.x + 14} ${Y} ${o.z + 2} minecraft:stone`);
    const r = await run(pip, 'goTo', { x: o.x + 12, y: Y + 1, z: o.z, range: 0 });
    expect(r.ok).toBe(true);
    expect(pip.bot.entity.position.y).toBeCloseTo(Y + 1, 1);
    const r2 = await run(pip, 'goTo', { agent: 'Bram', range: 2 });
    expect(r2.ok).toBe(true);
  });

  it('gather collects logs from real trees and reports +N', async () => {
    const o = await zone();
    await server.cmd(`place feature minecraft:oak ${o.x + 8} ${Y} ${o.z + 8}`);
    await server.cmd(`place feature minecraft:oak ${o.x + 8} ${Y} ${o.z - 8}`);
    await sleep(1000);
    const r = await run(pip, 'gather', { item: 'logs', qty: 4 });
    expect(r.ok).toBe(true);
    expect(r.expected).toBe('+4 log');
    expect(countItem(pip.bot, 'oak_log')).toBeGreaterThanOrEqual(4);
  });

  it('crafts planks, sticks, a table and (placing the table) a wooden pickaxe', async () => {
    await zone();
    await server.cmd('clear Pip');
    await server.cmd('give Pip minecraft:oak_log 4');
    await sleep(800);
    expect((await run(pip, 'craft', { item: 'planks', qty: 12 })).ok).toBe(true);
    expect((await run(pip, 'craft', { item: 'sticks', qty: 4 })).ok).toBe(true);
    expect((await run(pip, 'craft', { item: 'crafting_table', qty: 1 })).ok).toBe(true);
    const r = await run(pip, 'craft', { item: 'wooden_pickaxe', qty: 1 });
    expect(r.ok).toBe(true);
    expect(countItem(pip.bot, 'wooden_pickaxe')).toBe(1);
  });

  it('refuses recipes the agent does not know (§21.2 gate) and names missing ingredients', async () => {
    const r = await pip.run('craft', { item: 'stone_pickaxe' }, { knowsRecipe: (i) => i !== 'stone_pickaxe' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/don't know how to make stone_pickaxe/);
    const r2 = await pip.run('craft', { item: 'stone_pickaxe' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/3 cobblestone/);
  });

  it('mine digs stone with the pickaxe and explains missing tools', async () => {
    const o = await zone();
    await server.cmd(`fill ${o.x + 3} ${Y - 1} ${o.z + 3} ${o.x + 6} ${Y - 1} ${o.z + 3} minecraft:stone`);
    await sleep(500);
    const r = await run(pip, 'mine', { block: 'stone', qty: 2 });
    expect(r.ok).toBe(true);
    expect(countItem(pip.bot, 'cobblestone')).toBeGreaterThanOrEqual(2);
    await server.cmd(`setblock ${o.x - 5} ${Y - 1} ${o.z - 5} minecraft:iron_ore`);
    await waitFor(() => pip.bot.blockAt(new Vec3(o.x - 5, Y - 1, o.z - 5))?.name === 'iron_ore', 5000, 'iron ore visible');
    const r2 = await run(pip, 'mine', { block: 'iron_ore', qty: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/need a stone_pickaxe or better to harvest iron_ore/);
  });

  it('smelts raw iron in a furnace it places', async () => {
    await zone();
    await server.cmd('give Pip minecraft:furnace 1');
    await server.cmd('give Pip minecraft:raw_iron 2');
    await server.cmd('give Pip minecraft:coal 1');
    await sleep(800);
    const r = await run(pip, 'smelt', { item: 'raw_iron', qty: 2 }, 60_000);
    expect(r.ok).toBe(true);
    expect(countItem(pip.bot, 'iron_ingot')).toBe(2);
  });

  it('places blocks and stores/takes from a chest', async () => {
    const o = await zone();
    await server.cmd('give Pip minecraft:dirt 8');
    await sleep(500);
    const r = await run(pip, 'place', { block: 'dirt', x: o.x + 2, y: Y, z: o.z });
    expect(r.ok).toBe(true);
    await server.cmd(`setblock ${o.x - 6} ${Y} ${o.z - 6} minecraft:chest`);
    await sleep(500);
    expect((await run(pip, 'deposit', { item: 'dirt', qty: 2 })).ok).toBe(true);
    expect((await run(pip, 'withdraw', { item: 'dirt', qty: 1 })).ok).toBe(true);
  });

  it('digs a sealed shelter', async () => {
    await zone();
    await server.cmd('give Pip minecraft:dirt 4');
    await sleep(500);
    const s = await run(pip, 'shelter', { untilMorning: false });
    expect(s.ok).toBe(true);
    const feet = pip.bot.entity.position.floored();
    expect(feet.y).toBeLessThanOrEqual(Y - 2);
    expect(isEnclosed(pip.bot)).toBe(true);
    expect(pip.bot.blockAt(feet.offset(0, 2, 0))?.name).toMatch(/dirt|grass_block|cobblestone/);
  });

  it('eats, equips armor and gives items to another player (who collects them)', async () => {
    await zone(true);
    bram.reflexes.start();
    try {
      await server.cmd('give Pip minecraft:bread 6');
      await server.cmd('effect give Pip minecraft:hunger 3 255');
      await waitFor(() => pip.bot.food < 18, 15000, 'hunger');
      await server.cmd('effect clear Pip');
      const before = pip.bot.food;
      const eat = await run(pip, 'eat', {});
      expect(eat.ok).toBe(true);
      expect(pip.bot.food).toBeGreaterThan(before);
      await server.cmd('give Pip minecraft:iron_chestplate 1');
      await sleep(500);
      const eq = await run(pip, 'equip', { item: 'iron_chestplate' });
      expect(eq.ok).toBe(true);
      expect(pip.bot.inventory.slots[6]?.name).toBe('iron_chestplate');
      const breadBefore = countItem(bram.bot, 'bread');
      const g = await run(pip, 'give', { to: 'Bram', item: 'bread', qty: 2 });
      expect(g.ok).toBe(true);
      await waitFor(() => countItem(bram.bot, 'bread') >= breadBefore + 2, 10000, 'Bram picks up the bread');
    } finally {
      bram.reflexes.stop();
    }
  });

  it('follow keeps up with a moving person', async () => {
    const o = await zone(true);
    const ac = new AbortController();
    const following = bram.run('follow', { agent: 'Pip', distance: 2 }, { signal: ac.signal });
    await run(pip, 'goTo', { x: o.x, y: Y, z: o.z + 20, range: 1 });
    await sleep(2500);
    const d = bram.bot.entity.position.distanceTo(pip.bot.entity.position);
    ac.abort('done');
    const r = await following;
    expect(d).toBeLessThan(5);
    expect(r.ok).toBe(true);
  });

  it('say, look, wait and explore', async () => {
    await zone(true);
    expect((await run(pip, 'say', { text: 'hello world' })).ok).toBe(true);
    expect((await run(pip, 'look', { agent: 'Bram' })).ok).toBe(true);
    expect((await run(pip, 'wait', { seconds: 1 })).ok).toBe(true);
    const start = pip.bot.entity.position.clone();
    const r = await run(pip, 'explore', { distance: 16 });
    expect(r.ok).toBe(true);
    expect(pip.bot.entity.position.distanceTo(start)).toBeGreaterThan(5);
  });

  it('attack kills a zombie', async () => {
    const o = await zone();
    await server.cmd('time set 18000');
    await server.cmd('give Pip minecraft:iron_sword 1');
    await server.cmd(`summon minecraft:zombie ${o.x + 5} ${Y} ${o.z} {PersistenceRequired:1b}`);
    await sleep(800);
    const r = await run(pip, 'attack', { target: 'zombie', seconds: 30 });
    expect(r.ok).toBe(true);
    await server.cmd('time set 1000');
  });

  it('sleeps in a bed at night', async () => {
    const o = await zone();
    await server.cmd('gamerule players_sleeping_percentage 1');
    await server.cmd(`setblock ${o.x + 2} ${Y} ${o.z} minecraft:red_bed[facing=east,part=foot]`);
    await server.cmd(`setblock ${o.x + 3} ${Y} ${o.z} minecraft:red_bed[facing=east,part=head]`);
    // Sleeping only skips the night while time advances (vanilla: no skip with advance_time false).
    await server.cmd('gamerule advance_time true');
    await server.cmd('time set 13500');
    await sleep(800);
    const r = await run(pip, 'sleep', {}, 30_000);
    await server.cmd('gamerule advance_time false');
    expect(r.ok).toBe(true);
    await server.cmd('time set 1000');
  });

  describe('reflexes (§4.5)', () => {
    beforeAll(async () => {
      await server.cmd('time set 18000');
      await server.cmd('clear Pip');
      await server.cmd('give Pip minecraft:iron_sword 1');
      await server.cmd('give Pip minecraft:bread 8');
      await sleep(600);
      pip.reflexes.start();
    });

    afterAll(async () => {
      pip.reflexes.stop();
      await server.cmd('time set 1000');
    });

    it('fights a nearby zombie on its own and reports danger', async () => {
      const o = await zone();
      dangers.length = 0;
      await server.cmd(`summon minecraft:zombie ${o.x + 4} ${Y} ${o.z} {PersistenceRequired:1b}`);
      await waitFor(() => dangers.some((d) => d.kind === 'fight' && d.source === 'zombie'), 10000, 'fight reflex');
      await waitFor(() => !pip.bot.nearestEntity((e) => e.name === 'zombie' && e.position.distanceTo(pip.bot.entity.position) < 16), 30000, 'zombie dead');
      await waitFor(() => pip.reflexes.mode === 'idle', 10000, 'danger cleared');
      expect(cleared.length).toBeGreaterThan(0);
    });

    it('flees instead of fighting when badly hurt', async () => {
      const o = await zone();
      dangers.length = 0;
      await server.cmd('damage Pip 13');
      await waitFor(() => pip.bot.health <= 8, 5000, 'hurt');
      await server.cmd(`summon minecraft:zombie ${o.x + 4} ${Y} ${o.z} {PersistenceRequired:1b}`);
      await waitFor(() => dangers.some((d) => d.kind === 'flee'), 10000, 'flee reflex');
      expect(pip.reflexes.mode).toBe('flee');
      await server.cmd('kill @e[type=minecraft:zombie]');
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await waitFor(() => pip.reflexes.mode === 'idle', 12000, 'got away');
    });

    it('eats when hungry and wears better armor', async () => {
      await zone();
      await server.cmd('effect give Pip minecraft:hunger 4 255');
      await waitFor(() => pip.bot.food <= 12, 20000, 'hungry');
      await server.cmd('effect clear Pip minecraft:hunger');
      await waitFor(() => pip.bot.food > 14, 20000, 'ate');
      await server.cmd('give Pip minecraft:iron_helmet 1');
      await waitFor(() => pip.bot.inventory.slots[5]?.name === 'iron_helmet', 15000, 'helmet worn');
    });
  });
});
