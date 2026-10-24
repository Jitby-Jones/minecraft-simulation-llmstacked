// The hands a player has, live (owner request, 2026-10-24): right-click with an item on a creature or a block (shears
// on a sheep, wheat on two cows), lead an animal by holding out its food, pick a field and plant it again, get wool
// by shearing when there are sheep to shear (and they live), walk a chosen way, and light the way digging in the dark.
// Code only: what they are for is the mind's to know.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadVersionsConfig, repoRoot, sleep } from '@agora/shared';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { countItem } from '@agora/agent/body/inventory';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('live: the hands', () => {
  let server: LiveServer;
  let body: Body;
  const logger = createLogger({ name: 'hands-live', logDir: path.join(repoRoot(), 'data', 'live-test', 'hands-agents'), console: process.env.AGORA_DEBUG === '1' });
  const run = (skill: string, args: Record<string, unknown>) => body.run(skill, args, { signal: new AbortController().signal });
  const at = async (x: number, z: number) => {
    await server.cmd(`tp Ada ${x} ${Y} ${z}`);
    await server.cmd('clear Ada');
    await sleep(1500);
  };

  beforeAll(async () => {
    server = await startLiveServer({ name: 'hands', port: 25632, rconPort: 25633, deepGround: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty peaceful']) await server.cmd(c);
    await server.cmd('forceload add 4800 -64 5600 64');
    body = await Body.connect({ host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger });
    await sleep(2000);
  }, 300_000);

  afterAll(async () => {
    await body?.disconnect();
    await server?.stop();
  });

  it('shears on two sheep in a pen: wool, and two sheared sheep, alive', async () => {
    const x = 4800;
    await at(x, 0);
    await server.cmd(`fill ${x + 3} ${Y} -4 ${x + 9} ${Y} 4 oak_fence`);
    // A ring of fence: the inside cleared (a one-high hollow fill is solid).
    await server.cmd(`fill ${x + 4} ${Y} -3 ${x + 8} ${Y} 3 air`);
    await server.cmd(`setblock ${x + 3} ${Y} 0 oak_fence_gate[facing=west]`);
    for (const dz of [-2, 2]) await server.cmd(`summon sheep ${x + 6} ${Y} ${dz} {Color:0b}`);
    await server.cmd('give Ada minecraft:shears 1');
    await sleep(1500);
    const r = await run('use', { item: 'shears', on: 'sheep', times: 2 });
    logger.info({ r }, 'shear');
    expect(r.ok).toBe(true);
    await waitFor(() => countItem(body.bot, 'white_wool') >= 2 || Object.values(body.bot.entities).some((e) => e.name === 'item'), 10_000, 'wool', 250);
    // (The world has sheep of its own: those in the pen are the ones.)
    expect(Object.values(body.bot.entities).filter((e) => e.name === 'sheep' && Math.hypot(e.position.x - (x + 6), e.position.z) <= 9)).toHaveLength(2);
    expect(r.observed).toMatch(/used shears on 2 sheep/);
    expect(countItem(body.bot, 'white_wool')).toBeGreaterThanOrEqual(2);
    // Nothing of the pen was broken to get at them.
    expect(countItem(body.bot, 'oak_fence')).toBe(0);
  }, 120_000);

  it('wheat on two cows: they breed (a calf comes)', async () => {
    const x = 4900;
    await at(x, 0);
    await server.cmd(`fill ${x + 3} ${Y} -4 ${x + 9} ${Y} 4 oak_fence`);
    // A ring of fence: the inside cleared (a one-high hollow fill is solid).
    await server.cmd(`fill ${x + 4} ${Y} -3 ${x + 8} ${Y} 3 air`);
    await server.cmd(`setblock ${x + 3} ${Y} 0 oak_fence_gate[facing=west]`);
    for (const dz of [-1, 1]) await server.cmd(`summon cow ${x + 6} ${Y} ${dz}`);
    await server.cmd('give Ada minecraft:wheat 4');
    await sleep(1500);
    const cows = () => Object.values(body.bot.entities).filter((e) => e.name === 'cow' && Math.hypot(e.position.x - (x + 6), e.position.z) <= 5).length;
    const r = await run('use', { item: 'wheat', on: 'cow', times: 2 });
    logger.info({ r }, 'breed');
    expect(r.ok).toBe(true);
    await waitFor(() => cows() >= 3, 20_000, 'a calf', 500);
  }, 120_000);

  it('leads a cow home by holding out wheat', async () => {
    const x = 5000;
    await at(x, 0);
    await server.cmd(`summon cow ${x + 10} ${Y} 0`);
    await server.cmd('give Ada minecraft:wheat 2');
    await sleep(1500);
    const r = await run('lead', { animal: 'cow', x: x - 10, y: Y, z: 0 });
    logger.info({ r }, 'lead');
    expect(r.ok).toBe(true);
    const cows = Object.values(body.bot.entities).filter((e) => e.name === 'cow' && Math.hypot(e.position.x - (x - 10), e.position.z) <= 6);
    expect(cows.length).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('picks a ripe field and plants it again', async () => {
    const x = 5100;
    await at(x, 0);
    await server.cmd(`fill ${x + 2} ${Y - 1} -2 ${x + 4} ${Y - 1} 2 farmland[moisture=7]`);
    await server.cmd(`setblock ${x + 5} ${Y - 1} 0 water`);
    await server.cmd(`fill ${x + 2} ${Y} -2 ${x + 4} ${Y} 2 wheat[age=7]`);
    await server.cmd(`setblock ${x + 3} ${Y} 0 wheat[age=2]`);
    await sleep(1500);
    const r = await run('harvest', { radius: 10 });
    logger.info({ r }, 'harvest');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'wheat')).toBeGreaterThanOrEqual(10);
    const planted = [-2, -1, 0, 1, 2].flatMap((dz) => [2, 3, 4].map((dx) => body.bot.blockAt(new Vec3(x + dx, Y, dz))?.name));
    expect(planted.filter((n) => n === 'wheat').length).toBeGreaterThanOrEqual(13);
  }, 180_000);

  it('obtain wool with sheep about and iron for shears: makes shears and shears them (they live)', async () => {
    const x = 5200;
    await at(x, 0);
    await server.cmd(`fill ${x + 3} ${Y} -4 ${x + 9} ${Y} 4 oak_fence`);
    // A ring of fence: the inside cleared (a one-high hollow fill is solid).
    await server.cmd(`fill ${x + 4} ${Y} -3 ${x + 8} ${Y} 3 air`);
    await server.cmd(`setblock ${x + 3} ${Y} 0 oak_fence_gate[facing=west]`);
    for (const dz of [-2, 0, 2]) await server.cmd(`summon sheep ${x + 6} ${Y} ${dz} {Color:0b}`);
    await server.cmd('give Ada minecraft:iron_ingot 2');
    await sleep(1500);
    const r = await run('obtain', { item: 'white_wool', qty: 2 });
    logger.info({ r }, 'obtain wool');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'shears')).toBe(1);
    expect(Object.values(body.bot.entities).filter((e) => e.name === 'sheep' && Math.hypot(e.position.x - (x + 6), e.position.z) <= 9)).toHaveLength(3);
    expect(countItem(body.bot, 'oak_fence')).toBe(0);
  }, 180_000);

  it('in the dark underground, with torches on hand, lights the way as it digs', async () => {
    const x = 5500;
    await at(x, 0);
    // A sealed pocket in the stone, 11 blocks down: no sky, no light.
    await server.cmd(`fill ${x - 1} ${Y - 11} -1 ${x + 1} ${Y - 10} 1 air`);
    await server.cmd(`tp Ada ${x} ${Y - 11} 0`);
    await server.cmd('give Ada minecraft:torch 16');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(2500);
    const lit = () => body.bot.findBlocks({ matching: [body.bot.registry.blocksByName.torch?.id ?? -1, body.bot.registry.blocksByName.wall_torch?.id ?? -1], maxDistance: 24, count: 20 }).length;
    const feetBlock = body.bot.blockAt(body.bot.entity.position.floored());
    logger.info({ light: feetBlock?.light, skyLight: feetBlock?.skyLight, name: feetBlock?.name }, 'light at feet');
    expect(feetBlock?.skyLight).toBe(0);
    const r = await run('prospect', { item: 'diamond', maxBlocks: 16, direction: 'east' });
    logger.info({ r, torches: countItem(body.bot, 'torch'), lit: lit() }, 'dark dig');
    expect(lit()).toBeGreaterThanOrEqual(1);
    expect(countItem(body.bot, 'torch')).toBeLessThan(16);
  }, 240_000);

  it('charcoal with only logs on hand: planks are burned, not the logs being cooked', async () => {
    const x = 5600;
    await at(x, 0);
    await server.cmd('give Ada minecraft:oak_log 6');
    await server.cmd('give Ada minecraft:cobblestone 8');
    await sleep(1500);
    const r = await run('obtain', { item: 'charcoal', qty: 3 });
    logger.info({ r }, 'charcoal');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'charcoal')).toBeGreaterThanOrEqual(3);
  }, 240_000);

  it('smelting six logs to charcoal with nothing else to burn: one goes to planks for fuel, five cook, none is left behind', async () => {
    const x = 5700;
    await at(x, 0);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:oak_log 6');
    await server.cmd('give Ada minecraft:furnace 1');
    await sleep(1500);
    const r = await run('smelt', { item: 'oak_log', qty: 6 });
    logger.info({ r }, 'charcoal by smelting');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'charcoal')).toBeGreaterThanOrEqual(5);
    expect(r.observed).toMatch(/set the furnace down at/);
  }, 240_000);

  it('a crafting table far off, a log on hand: sets one down here rather than walk there', async () => {
    const x = 5700;
    await at(x, 0);
    await server.cmd(`setblock ${x + 16} ${Y} 0 crafting_table`);
    await server.cmd('give Ada minecraft:oak_log 2');
    await server.cmd('give Ada minecraft:cobblestone 3');
    await server.cmd('give Ada minecraft:stick 2');
    await sleep(1500);
    const t0 = Date.now();
    const r = await run('craft', { item: 'stone_pickaxe', qty: 1 });
    logger.info({ r, ms: Date.now() - t0 }, 'table here');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'stone_pickaxe')).toBe(1);
    // It stayed put: a new table within reach, not a walk of 16 blocks.
    expect(Math.abs(body.bot.entity.position.x - x)).toBeLessThan(4);
    expect(body.bot.findBlocks({ matching: [body.bot.registry.blocksByName.crafting_table?.id ?? -1], maxDistance: 5, count: 2 }).length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('in a tunnel with no room, a notch is dug in the wall to set a furnace down', async () => {
    const x = 5800;
    await at(x, 0);
    // A sealed pocket one wide, two high and one long in the stone: no free spot anywhere around.
    await server.cmd(`fill ${x} ${Y - 11} 0 ${x} ${Y - 10} 0 air`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 11} 0.5`);
    await server.cmd('give Ada minecraft:furnace 1');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(2000);
    const r = await run('place', { block: 'furnace' });
    logger.info({ r }, 'notch');
    expect(r.ok).toBe(true);
    expect(body.bot.findBlocks({ matching: [body.bot.registry.blocksByName.furnace?.id ?? -1], maxDistance: 3, count: 1 }).length).toBe(1);
  }, 120_000);

  it('explores a chosen way', async () => {
    const x = 5400;
    await at(x, 0);
    const r = await run('explore', { direction: 'east', distance: 64 });
    logger.info({ r }, 'explore');
    expect(r.ok).toBe(true);
    expect(body.bot.entity.position.x - x).toBeGreaterThan(40);
  }, 180_000);
});
