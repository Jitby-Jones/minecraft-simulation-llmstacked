// M1 live: every verified skill reports its postcondition on real Paper 26.1.2, and the L0 reflexes fight,
// flee, eat, wear armor and collect tossed items without an LLM. Each case runs in its own clean zone.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, repoRoot, sleep } from '@agora/shared';
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
  /** The rooms of huts Pip built (as the agent remembers them). */
  const rooms: Vec3[] = [];
  /** What the mind chose in a danger holds the body (as the agent's executor says), and what took it back. */
  let led: 'body' | 'legs' | 'hands' | null = null;
  const tookBack: string[] = [];
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
    // Kept, as the other suites keep theirs, to read what a failure did.
    const logger = createLogger({ name: 'm1-live', console: false, level: 'debug', logDir: path.join(repoRoot(), 'data', 'live-test', 'm1-agents') });
    pip = await Body.connect(
      { host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger, chat: { minIntervalMs: 300 } },
      { onDanger: (d) => dangers.push(d), onDangerCleared: (s) => cleared.push(s), caution: () => 0.3, rooms: () => rooms, mindLed: () => led, takeBack: (why) => tookBack.push(why) },
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

  it('mine digs stone with the pickaxe, makes the better pickaxe iron needs, and says which when it cannot', async () => {
    const o = await zone();
    await server.cmd(`fill ${o.x + 3} ${Y - 1} ${o.z + 3} ${o.x + 6} ${Y - 1} ${o.z + 3} minecraft:stone`);
    await sleep(500);
    const r = await run(pip, 'mine', { block: 'stone', qty: 2 });
    expect(r.ok).toBe(true);
    expect(countItem(pip.bot, 'cobblestone')).toBeGreaterThanOrEqual(2);
    // Iron wants a stone pickaxe: made of the stone still lying about (owner request, 2026-10-24: agents make their own
    // tools), then the ore mined.
    await server.cmd(`setblock ${o.x - 5} ${Y - 1} ${o.z - 5} minecraft:iron_ore`);
    await waitFor(() => pip.bot.blockAt(new Vec3(o.x - 5, Y - 1, o.z - 5))?.name === 'iron_ore', 5000, 'iron ore visible');
    const r2 = await run(pip, 'mine', { block: 'iron_ore', qty: 1 }, 150_000);
    expect(r2.ok).toBe(true);
    expect(countItem(pip.bot, 'stone_pickaxe')).toBe(1);
    expect(countItem(pip.bot, 'raw_iron')).toBeGreaterThanOrEqual(1);
    // With nothing to make one of (no stone left, no cobblestone, only a wooden pickaxe), it says which it needs.
    const o2 = await zone();
    await server.cmd('clear Pip');
    await server.cmd('give Pip minecraft:wooden_pickaxe 1');
    await server.cmd(`setblock ${o2.x - 5} ${Y - 1} ${o2.z - 5} minecraft:iron_ore`);
    await waitFor(() => pip.bot.blockAt(new Vec3(o2.x - 5, Y - 1, o2.z - 5))?.name === 'iron_ore', 5000, 'iron ore visible');
    const r3 = await run(pip, 'mine', { block: 'iron_ore', qty: 1 }, 120_000);
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/need a stone_pickaxe or better to harvest iron_ore/);
  }, 300_000);

  it('deposit with no chest about makes one and fills it; asked for one at a spot with none, it says so', async () => {
    const o = await zone();
    await server.cmd('clear Pip');
    await server.cmd('give Pip minecraft:oak_log 3');
    await server.cmd('give Pip minecraft:cobblestone 5');
    await sleep(800);
    // Owner request (2026-10-24): agents put things in chests that weren't there.
    const none = await run(pip, 'deposit', { item: 'cobblestone', x: o.x + 2, y: Y, z: o.z + 2 });
    expect(none.ok).toBe(false);
    expect(none.error).toBe(`there is no chest at ${o.x + 2},${Y},${o.z + 2}`);
    const r = await run(pip, 'deposit', { item: 'cobblestone' }, 150_000);
    expect(r.ok).toBe(true);
    expect(countItem(pip.bot, 'cobblestone')).toBe(0);
    const chest = r.data?.chest as { x: number; y: number; z: number } | undefined;
    expect(chest).toBeDefined();
    if (chest) expect(pip.bot.blockAt(new Vec3(chest.x, chest.y, chest.z))?.name).toBe('chest');
    expect(r.data?.contents).toMatchObject({ cobblestone: 5 });
  }, 200_000);

  it('hunt makes a sword first when it has none; gather makes an axe for a lot of wood and still brings the full count', async () => {
    const o = await zone();
    await server.cmd('clear Pip');
    await server.cmd('give Pip minecraft:oak_log 3');
    await server.cmd(`summon minecraft:cow ${o.x + 4} ${Y} ${o.z} {NoAI:1b}`);
    await sleep(800);
    const h = await run(pip, 'hunt', { animal: 'cow', qty: 1 }, 150_000);
    expect(h.ok).toBe(true);
    expect(countItem(pip.bot, 'wooden_sword')).toBe(1);
    const o2 = await zone();
    for (const [dx, dz] of [[8, -10], [8, -2], [8, 6], [14, -6], [14, 2]] as const) await server.cmd(`place feature minecraft:oak ${o2.x + dx} ${Y} ${o2.z + dz}`);
    await server.cmd('clear Pip');
    await sleep(1000);
    const g = await run(pip, 'gather', { item: 'oak_log', qty: 6 }, 240_000);
    expect(g.ok).toBe(true);
    expect(countItem(pip.bot, 'wooden_axe')).toBe(1);
    expect(countItem(pip.bot, 'oak_log')).toBeGreaterThanOrEqual(6);
  }, 400_000);

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

  it('a stack held over a window that has closed (dying mid-craft) fails to go back at once instead of spinning forever', async () => {
    // Our mineflayer patch: putSelectedItemRange clicked on whichever window was open now, so the closed window's
    // cursor never emptied and the loop, all microtasks, starved the process (seen in M6 scenario H). Bamboo planks,
    // which no other case uses, so nothing else here is disturbed.
    const { x, z } = await zone();
    await server.cmd('give Pip minecraft:bamboo_planks 16');
    await server.cmd(`setblock ${x + 2} ${Y} ${z} minecraft:crafting_table`);
    await waitFor(() => countItem(pip.bot, 'bamboo_planks') === 16 && pip.bot.blockAt(new Vec3(x + 2, Y, z))?.name === 'crafting_table', 10_000, 'planks and a table');
    const table = pip.bot.blockAt(new Vec3(x + 2, Y, z));
    if (!table) throw new Error('no table');
    const window = await pip.bot.openBlock(table);
    const slot = window.slots.findIndex((it, i) => i >= window.inventoryStart && it?.name === 'bamboo_planks');
    await pip.bot.clickWindow(slot, 0, 0);
    expect(window.selectedItem?.name).toBe('bamboo_planks');
    await pip.bot.closeWindow(window);
    const t0 = Date.now();
    await expect(pip.bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, null)).rejects.toThrow(/window is gone/);
    expect(Date.now() - t0).toBeLessThan(2000);
    // The server hands the closed window's cursor back to the inventory.
    await waitFor(() => countItem(pip.bot, 'bamboo_planks') === 16, 10_000, 'the planks back');
    await server.cmd('clear Pip minecraft:bamboo_planks');
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

    it('armed and not low on health, it fights a zombie rather than running (owner request, 2026-10-24)', async () => {
      const o = await zone();
      dangers.length = 0;
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await sleep(1000);
      await waitFor(() => pip.bot.health >= 19, 5000, 'full health');
      // Seven hearts and an iron sword: before, an agent this careful ran below eight and a half.
      await server.cmd('damage Pip 6');
      await waitFor(() => pip.bot.health <= 14.5, 5000, 'hurt a little');
      await server.cmd(`summon minecraft:zombie ${o.x + 4} ${Y} ${o.z} {PersistenceRequired:1b}`);
      await waitFor(() => dangers.some((d) => d.kind === 'fight' && d.source === 'zombie'), 10000, 'fight reflex');
      await waitFor(() => !pip.bot.nearestEntity((e) => e.name === 'zombie' && e.position.distanceTo(pip.bot.entity.position) < 16), 30000, 'zombie dead');
      expect(dangers.some((d) => d.kind === 'flee')).toBe(false);
      await waitFor(() => pip.reflexes.mode === 'idle', 10000, 'danger cleared');
    });

    it('flees instead of fighting when badly hurt', async () => {
      const o = await zone();
      dangers.length = 0;
      // From full health, whatever the zombie before did: 16 off a lower health would kill instead of hurt. The
      // instant effect lands on the next tick, so let it land before the damage (or it heals the damage away).
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await sleep(1000);
      await waitFor(() => pip.bot.health >= 19, 5000, 'full health');
      // Two hearts: low, sword or no sword.
      await server.cmd('damage Pip 16');
      await waitFor(() => pip.bot.health <= 5, 5000, 'hurt');
      await server.cmd(`summon minecraft:zombie ${o.x + 4} ${Y} ${o.z} {PersistenceRequired:1b}`);
      await waitFor(() => dangers.some((d) => d.kind === 'flee'), 10000, 'flee reflex');
      expect(pip.reflexes.mode).toBe('flee');
      await server.cmd('kill @e[type=minecraft:zombie]');
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await waitFor(() => pip.reflexes.mode === 'idle', 12000, 'got away');
    });

    it('caught out at night and hurt, it runs into its own hut, not off across the open', async () => {
      const o = await zone();
      dangers.length = 0;
      // Its hut 10 blocks north: cobblestone round a 3×3 room, a roof, an oak door in the south wall. The zombie
      // comes from the east: away from it alone is west, across the open.
      const c = { x: o.x - 2, z: o.z - 12 };
      const room = new Vec3(o.x, Y, o.z - 10);
      await server.cmd(`fill ${c.x} ${Y - 1} ${c.z} ${c.x + 4} ${Y + 3} ${c.z + 4} minecraft:cobblestone hollow`);
      await server.cmd(`setblock ${o.x} ${Y} ${c.z + 4} minecraft:oak_door[facing=south,half=lower]`);
      await server.cmd(`setblock ${o.x} ${Y + 1} ${c.z + 4} minecraft:oak_door[facing=south,half=upper]`);
      rooms.push(room);
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await sleep(1000);
      await waitFor(() => pip.bot.health >= 19, 5000, 'full health');
      await server.cmd('damage Pip 15');
      await waitFor(() => pip.bot.health <= 6, 5000, 'hurt');
      await server.cmd(`summon minecraft:zombie ${o.x + 4} ${Y} ${o.z} {PersistenceRequired:1b}`);
      // What the run did, said if it fails (the walk set a block up on the door's panel stood at its doorway to die).
      const trace: string[] = [];
      const t0 = Date.now();
      const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
      const onUpdate = (r: { status: string; path: readonly { x: number; y: number; z: number }[] }) => trace.push(`${at()} path ${r.status}: ${r.path.map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)},${n.z.toFixed(1)}`).join(' > ')}`);
      pip.bot.on('path_update', onUpdate);
      const tracer = setInterval(() => {
        const p = pip.bot.entity.position;
        const zb = Object.values(pip.bot.entities).find((e) => e.name === 'zombie');
        const door = pip.bot.blockAt(new Vec3(o.x, Y, c.z + 4))?.getProperties().open;
        trace.push(`${at()} ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} hp${Math.round(pip.bot.health)} ${pip.reflexes.mode} forward=${pip.bot.controlState.forward} door ${door ? 'open' : 'shut'} zombie ${zb ? zb.position.distanceTo(p).toFixed(1) : '-'}`);
      }, 500);
      try {
        await waitFor(() => dangers.some((d) => d.kind === 'flee'), 10000, 'flee reflex');
        const inside = () => Math.abs(pip.bot.entity.position.x - (room.x + 0.5)) <= 1.5 && Math.abs(pip.bot.entity.position.z - (room.z + 0.5)) <= 1.5;
        await waitFor(inside, 25000, 'in its hut');
        // The door shut behind it, and the zombie at it outside is no fight to go out to.
        await waitFor(() => pip.bot.blockAt(new Vec3(o.x, Y, c.z + 4))?.getProperties().open === false, 8000, 'door shut');
        await waitFor(() => pip.reflexes.mode === 'idle', 15000, 'safe inside');
        expect(inside()).toBe(true);
      } finally {
        clearInterval(tracer);
        pip.bot.removeListener('path_update', onUpdate);
        console.log(`[hut] room ${room.x},${room.z}\n${trace.join('\n')}`);
        rooms.length = 0;
        await server.cmd('kill @e[type=minecraft:zombie]');
        await server.cmd(`fill ${c.x} ${Y} ${c.z} ${c.x + 4} ${Y + 3} ${c.z + 4} minecraft:air`);
        await server.cmd('effect give Pip minecraft:instant_health 1 3');
      }
    });

    it('caught out at night and hurt, it runs into its own hut with no door and shuts the doorway behind it', async () => {
      // One built a hut at dusk with no door to it, ran into it from a zombie, and the zombie came in after her.
      const o = await zone();
      dangers.length = 0;
      const c = { x: o.x - 2, z: o.z - 12 };
      const room = new Vec3(o.x, Y, o.z - 10);
      const doorway = [new Vec3(o.x, Y, c.z + 4), new Vec3(o.x, Y + 1, c.z + 4)];
      await server.cmd(`fill ${c.x} ${Y - 1} ${c.z} ${c.x + 4} ${Y + 3} ${c.z + 4} minecraft:cobblestone hollow`);
      for (const d of doorway) await server.cmd(`setblock ${d.x} ${d.y} ${d.z} minecraft:air`);
      rooms.push(room);
      await server.cmd('give Pip minecraft:dirt 8');
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await sleep(1000);
      await waitFor(() => pip.bot.health >= 19, 5000, 'full health');
      await server.cmd('damage Pip 15');
      await waitFor(() => pip.bot.health <= 6, 5000, 'hurt');
      await server.cmd(`summon minecraft:zombie ${o.x + 4} ${Y} ${o.z} {PersistenceRequired:1b}`);
      try {
        await waitFor(() => dangers.some((d) => d.kind === 'flee'), 10000, 'flee reflex');
        const inside = () => Math.abs(pip.bot.entity.position.x - (room.x + 0.5)) <= 1.5 && Math.abs(pip.bot.entity.position.z - (room.z + 0.5)) <= 1.5;
        await waitFor(inside, 25000, 'in its hut');
        await waitFor(() => doorway.every((d) => pip.bot.blockAt(d)?.boundingBox === 'block'), 8000, 'doorway shut');
        await waitFor(() => pip.reflexes.mode === 'idle', 15000, 'safe inside');
        expect(inside()).toBe(true);
        expect(pip.bot.health).toBeGreaterThan(0);
      } finally {
        rooms.length = 0;
        await server.cmd('kill @e[type=minecraft:zombie]');
        await server.cmd(`fill ${c.x} ${Y} ${c.z} ${c.x + 4} ${Y + 3} ${c.z + 4} minecraft:air`);
        await server.cmd('clear Pip minecraft:dirt');
        await server.cmd('effect give Pip minecraft:instant_health 1 3');
      }
    });

    it("in a hut's room at night, its door shut, a zombie at the door outside is no fight to go out to", async () => {
      // One in her companion's hut went out of the door after a zombie at it, left it open, and was taken from 20 to 1.
      const o = await zone();
      dangers.length = 0;
      const c = { x: o.x - 2, z: o.z - 2 };
      await server.cmd(`fill ${c.x} ${Y - 1} ${c.z} ${c.x + 4} ${Y + 3} ${c.z + 4} minecraft:cobblestone hollow`);
      await server.cmd(`setblock ${o.x} ${Y} ${c.z + 4} minecraft:oak_door[facing=south,half=lower]`);
      await server.cmd(`setblock ${o.x} ${Y + 1} ${c.z + 4} minecraft:oak_door[facing=south,half=upper]`);
      await server.cmd(`tp Pip ${o.x} ${Y} ${o.z}`);
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await sleep(1500);
      const door = new Vec3(o.x, Y, c.z + 4);
      try {
        await server.cmd(`summon minecraft:zombie ${o.x} ${Y} ${c.z + 5} {PersistenceRequired:1b}`);
        const inside = () => Math.abs(pip.bot.entity.position.x - (o.x + 0.5)) <= 1.5 && Math.abs(pip.bot.entity.position.z - (o.z + 0.5)) <= 1.5;
        for (let i = 0; i < 20; i++) {
          await sleep(500);
          expect(inside()).toBe(true);
          expect(pip.bot.blockAt(door)?.getProperties().open).toBe(false);
        }
        expect(dangers.some((d) => d.kind === 'fight')).toBe(false);
      } finally {
        await server.cmd('kill @e[type=minecraft:zombie]');
        await server.cmd(`fill ${c.x} ${Y} ${c.z} ${c.x + 4} ${Y + 3} ${c.z + 4} minecraft:air`);
      }
    });

    it('while what the mind chose holds the body, a zombie at hand is no fight the reflexes start; a creeper about to go off takes it back', async () => {
      const o = await zone();
      dangers.length = 0;
      tookBack.length = 0;
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await server.cmd('effect give Pip minecraft:resistance 30 4');
      led = 'body';
      try {
        await server.cmd(`summon minecraft:zombie ${o.x + 2} ${Y} ${o.z} {PersistenceRequired:1b}`);
        await sleep(4000);
        expect(dangers.some((d) => d.kind === 'fight' || d.kind === 'flee')).toBe(false);
        expect(pip.reflexes.mode).not.toBe('fight');
        await server.cmd('kill @e[type=minecraft:zombie]');
        await server.cmd(`summon minecraft:creeper ${o.x + 3} ${Y} ${o.z} {PersistenceRequired:1b,NoAI:1b}`);
        await waitFor(() => tookBack.length > 0, 5000, 'took back');
        expect(tookBack[0]).toMatch(/creeper/);
      } finally {
        led = null;
        await server.cmd('kill @e[type=minecraft:creeper]');
        await server.cmd('kill @e[type=minecraft:zombie]');
        await server.cmd('effect clear Pip minecraft:resistance');
      }
      await waitFor(() => pip.reflexes.mode === 'idle', 10000, 'at rest');
    });

    it('while what the mind chose holds the body, hurt again and again by a zombie at hand, the body takes it back', async () => {
      // A hut begun under fire with a zombie at her back: 12 health to none while the next thought came.
      const o = await zone();
      dangers.length = 0;
      tookBack.length = 0;
      await server.cmd('effect give Pip minecraft:instant_health 1 3');
      await sleep(1000);
      led = 'body';
      try {
        await server.cmd(`summon minecraft:zombie ${o.x + 2} ${Y} ${o.z} {PersistenceRequired:1b}`);
        await waitFor(() => tookBack.length > 0, 20_000, 'took back');
        expect(tookBack[0]).toMatch(/hurt again/);
        expect(pip.bot.health).toBeGreaterThan(12);
      } finally {
        led = null;
        await server.cmd('kill @e[type=minecraft:zombie]');
      }
      await waitFor(() => pip.reflexes.mode === 'idle', 10000, 'at rest');
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
