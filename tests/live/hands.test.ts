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

  it('in a meadow with a flower in every cell: a flower is picked and the crafting table goes in its place (one on a tulip was refused)', async () => {
    const x = 5750;
    await at(x, 0);
    await server.cmd(`fill ${x - 4} ${Y} -4 ${x + 4} ${Y + 3} 4 air`);
    await server.cmd(`fill ${x - 4} ${Y - 1} -4 ${x + 4} ${Y - 1} 4 grass_block`);
    await server.cmd(`fill ${x - 4} ${Y} -4 ${x + 4} ${Y} 4 red_tulip`);
    await server.cmd(`tp Ada ${x}.5 ${Y} 0.5`);
    for (const g of ['crafting_table 1', 'oak_planks 3', 'stick 2']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(1500);
    const r = await run('craft', { item: 'wooden_pickaxe', qty: 1 });
    logger.info({ r }, 'table in a meadow');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'wooden_pickaxe')).toBe(1);
    expect(body.bot.findBlocks({ matching: [body.bot.registry.blocksByName.crafting_table?.id ?? -1], maxDistance: 5, count: 1 }).length).toBe(1);
  }, 120_000);

  it('a bed in a nook: set down the way there is room for its head (one facing a hillside was refused five times at dusk)', async () => {
    const x = 5650;
    await server.cmd(`forceload add ${x - 8} -8 ${x + 8} 8`);
    // Rock all about at the feet and head, but for a cell north of where it stands and two south.
    await server.cmd(`fill ${x - 3} ${Y} -3 ${x + 3} ${Y + 1} 3 stone`);
    await server.cmd(`fill ${x} ${Y} -1 ${x} ${Y + 1} 2 air`);
    await server.cmd(`tp Ada ${x}.5 ${Y} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:red_bed 1');
    await sleep(1500);
    const r = await run('place', { block: 'red_bed' });
    logger.info({ r }, 'bed in a nook');
    expect(r.ok).toBe(true);
    expect(body.bot.blockAt(new Vec3(x, Y, 1))?.name).toBe('red_bed');
    expect(body.bot.blockAt(new Vec3(x, Y, 2))?.name).toBe('red_bed');
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

  it('on a block over a drop with no floor about, the furnace goes against its side and the iron is smelted', async () => {
    const x = 5850;
    await at(x, 0);
    // A cave: a hollow in the stone, and one block of it left to stand on, four over the hollow's floor.
    await server.cmd(`fill ${x - 3} ${Y - 12} -3 ${x + 3} ${Y - 3} 3 air`);
    await server.cmd(`setblock ${x} ${Y - 8} 0 stone`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 7} 0.5`);
    await server.cmd('give Ada minecraft:furnace 1');
    await server.cmd('give Ada minecraft:raw_iron 1');
    await server.cmd('give Ada minecraft:coal 1');
    await sleep(2000);
    const r = await run('smelt', { item: 'raw_iron', qty: 1 });
    logger.info({ r }, 'furnace over a drop');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'iron_ingot')).toBe(1);
    expect(body.bot.findBlocks({ matching: [body.bot.registry.blocksByName.furnace?.id ?? -1], maxDistance: 3, count: 1 }).length).toBe(1);
    // Still up on its block.
    expect(body.bot.entity.position.y).toBeGreaterThan(Y - 7.5);
  }, 120_000);

  it('from the floor of a deep hollow, it gets back up to the ground above (walks up from caves had timed out)', async () => {
    const x = 5950;
    await at(x, 0);
    // A hollow sixteen deep and five across in the stone, open to the sky; the agent on its floor.
    await server.cmd(`fill ${x - 2} ${Y - 16} -2 ${x + 2} ${Y - 1} 2 air`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 16} 0.5`);
    await server.cmd('give Ada minecraft:cobblestone 64');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(2000);
    const started = Date.now();
    const r = await run('goTo', { x: x + 6, y: Y, z: 0 });
    logger.info({ r, ms: Date.now() - started, at: body.bot.entity.position.toString() }, 'up from a hollow');
    expect(r.ok).toBe(true);
    expect(body.bot.entity.position.y).toBeGreaterThan(Y - 1.5);
  }, 240_000);

  it('dyes white wool red, and a white bed: any wool or bed takes any dye (the game data has each from black alone)', async () => {
    const x = 5900;
    await at(x, 0);
    await server.cmd('give Ada minecraft:white_wool 1');
    await server.cmd('give Ada minecraft:white_bed 1');
    await server.cmd('give Ada minecraft:red_dye 2');
    await sleep(1500);
    const wool = await run('craft', { item: 'red_wool', qty: 1 });
    const bed = await run('craft', { item: 'red_bed', qty: 1 });
    logger.info({ wool, bed }, 'dyeing');
    expect(countItem(body.bot, 'red_wool')).toBe(1);
    expect(countItem(body.bot, 'red_bed')).toBe(1);
  }, 120_000);

  it('a quick hut says where its room and its open doorway are; sent to its corner, it stands by the wall rather than dig into it', async () => {
    const x = 6100;
    await at(x, 0);
    await server.cmd('give Ada minecraft:cobblestone 80');
    await sleep(1500);
    const r = await run('build', { structure: 'hut' });
    logger.info({ r }, 'quick hut');
    expect(r.ok).toBe(true);
    const m = /its room inside at (-?\d+),(-?\d+),(-?\d+), its doorway at -?\d+,-?\d+,-?\d+ open/.exec(r.observed);
    expect(m).not.toBeNull();
    const room = new Vec3(Number(m?.[1]), Number(m?.[2]), Number(m?.[3]));
    const corner = room.offset(-2, 0, -2);
    const go = await run('goTo', { x: corner.x, y: corner.y, z: corner.z, range: 0 });
    logger.info({ go, at: body.bot.entity.position.toString() }, 'to the corner');
    // The wall is whole: the corner and the block over it are still stone.
    expect(body.bot.blockAt(corner)?.name).toBe('cobblestone');
    expect(body.bot.blockAt(corner.offset(0, 1, 0))?.name).toBe('cobblestone');
    expect(body.bot.entity.position.distanceTo(corner.offset(0.5, 0, 0.5))).toBeLessThan(2.5);
  }, 180_000);

  it("a night's hut for one, of the dirt a player has by dusk: up in a few seconds, and in it with the door shut it is walled in", async () => {
    const x = 6150;
    await at(x, 0);
    await server.cmd('give Ada minecraft:dirt 27');
    await server.cmd('give Ada minecraft:oak_door 1');
    await sleep(1500);
    const started = Date.now();
    const r = await run('build', { structure: 'hut', room: 1 });
    logger.info({ r, ms: Date.now() - started }, "a night's hut");
    expect(r.ok).toBe(true);
    const m = /its room inside at (-?\d+),(-?\d+),(-?\d+), a door in its doorway at/.exec(r.observed);
    expect(m).not.toBeNull();
    const room = new Vec3(Number(m?.[1]), Number(m?.[2]), Number(m?.[3]));
    const go = await run('goTo', { x: room.x, y: room.y, z: room.z, range: 0 });
    logger.info({ go, at: body.bot.entity.position.toString() }, 'into the hut');
    await sleep(1500);
    const feet = body.bot.entity.position.floored();
    expect(feet.equals(room)).toBe(true);
    // Walled in and roofed: dirt or the shut door on every side, the roof over the head.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const side = body.bot.blockAt(feet.offset(dx, 0, dz));
      expect(side?.name === 'dirt' || (side?.name === 'oak_door' && side.getProperties().open === false)).toBe(true);
    }
    expect(body.bot.blockAt(feet.offset(0, 2, 0))?.name).toBe('dirt');
  }, 180_000);

  it('prospecting with water beside the way: walls it off and digs on (a prospect in a wet cave gave up nine times on "water ahead")', async () => {
    const x = 6200;
    const y = 20;
    await at(x, 0);
    // A pocket in the stone to start from, and water standing in the rock beside where the tunnel will run.
    await server.cmd(`forceload add ${x - 8} -8 ${x + 24} 8`);
    await server.cmd(`fill ${x} ${y} 0 ${x} ${y + 1} 0 air`);
    await server.cmd(`fill ${x + 5} 17 1 ${x + 7} 18 1 water`);
    await server.cmd(`tp Ada ${x}.5 ${y} 0.5`);
    for (const g of ['stone_pickaxe 1', 'cobblestone 16', 'torch 8']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(2000);
    const r = await run('prospect', { item: 'coal', direction: 'east', maxBlocks: 12 });
    logger.info({ r, at: body.bot.entity.position.toString() }, 'wet prospect');
    expect(body.bot.entity.position.x).toBeGreaterThan(x + 8);
    for (let dx = 5; dx <= 7; dx++) for (const dy of [17, 18]) expect(body.bot.blockAt(new Vec3(x + dx, dy, 1))?.name).not.toBe('water');
  }, 180_000);

  it('prospecting with a pickaxe on its last uses: when it breaks the dig ends and says so (one dug on by hand till its time ran out)', async () => {
    const x = 6400;
    const y = 20;
    await at(x, 0);
    await server.cmd(`forceload add ${x - 8} -8 ${x + 40} 8`);
    await server.cmd(`fill ${x} ${y} 0 ${x} ${y + 1} 0 air`);
    await server.cmd(`tp Ada ${x}.5 ${y} 0.5`);
    // A wooden pickaxe (59 uses) with five left, and torches; no other tool.
    for (const g of ['wooden_pickaxe[damage=54] 1', 'torch 8']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(2000);
    const t0 = Date.now();
    const r = await run('prospect', { item: 'diamond_ore', direction: 'east', maxBlocks: 24 });
    const ms = Date.now() - t0;
    logger.info({ r, ms, at: body.bot.entity.position.toString() }, 'pickaxe worn out');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing left to dig the \w+ with/);
    expect(countItem(body.bot, 'wooden_pickaxe')).toBe(0);
    // Ended at once, not after minutes of stone by hand.
    expect(ms).toBeLessThan(40_000);
  }, 120_000);

  it('a dig for diamonds from the floor of the last one stays above the bedrock layers (each went three deeper, into it)', async () => {
    const x = 6500;
    await at(x, 0);
    await server.cmd(`forceload add ${x - 8} -8 ${x + 40} 8`);
    await server.cmd(`fill ${x} -57 0 ${x} -56 0 air`);
    await server.cmd(`tp Ada ${x}.5 -57 0.5`);
    for (const g of ['iron_pickaxe 1', 'torch 16']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(2000);
    const ys: number[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await run('prospect', { item: 'diamond_ore', direction: 'east', maxBlocks: 8 });
      ys.push(Math.floor(body.bot.entity.position.y));
      logger.info({ r, at: body.bot.entity.position.toString() }, 'dig for diamonds');
    }
    // Down to four over the bedrock's top patches (the world's floor is at -64) and no farther, dig after dig.
    expect(ys).toEqual([-59, -59]);
  }, 180_000);

  it('prospecting under a bed of gravel: what comes down is let come down and dug, never stepped in under, and it is unhurt', async () => {
    const x = 6300;
    const y = 20;
    await at(x, 0);
    // A pocket in the stone to start from, and gravel seven deep over the way the tunnel will go.
    await server.cmd(`forceload add ${x - 8} -8 ${x + 24} 8`);
    await server.cmd(`fill ${x} ${y} 0 ${x} ${y + 1} 0 air`);
    await server.cmd(`fill ${x + 1} ${y + 2} -1 ${x + 10} ${y + 8} 1 gravel`);
    await server.cmd(`tp Ada ${x}.5 ${y} 0.5`);
    await server.cmd('effect give Ada minecraft:instant_health 1 3');
    for (const g of ['stone_pickaxe 1', 'stone_shovel 1', 'cobblestone 16', 'torch 8']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(2000);
    const r = await run('prospect', { item: 'diamond_ore', direction: 'east', maxBlocks: 8 });
    logger.info({ r, at: body.bot.entity.position.toString(), health: body.bot.health }, 'gravel prospect');
    expect(body.bot.health).toBeGreaterThanOrEqual(18);
    const head = body.bot.blockAt(body.bot.entity.position.offset(0, 1.62, 0));
    expect(head?.name).not.toBe('gravel');
    // Through it, not turned back by it ("gravel keeps falling" after two blocks, before).
    expect(body.bot.entity.position.x).toBeGreaterThan(x + 5);
  }, 240_000);

  it('stone under a pond close by and dry stone a little farther: it mines the dry stone, as a player would', async () => {
    const x = 6400;
    await at(x, 0);
    // A pond two blocks off: stone at its bottom under three of water. Dry stone eight blocks off.
    await server.cmd(`fill ${x + 2} ${Y - 4} 0 ${x + 3} ${Y - 4} 1 stone`);
    await server.cmd(`fill ${x + 2} ${Y - 3} 0 ${x + 3} ${Y - 1} 1 water`);
    await server.cmd(`fill ${x + 8} ${Y} 0 ${x + 8} ${Y + 1} 1 stone`);
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(2000);
    const r = await run('mine', { block: 'stone', qty: 2 });
    logger.info({ r }, 'dry stone');
    expect(r.ok).toBe(true);
    for (let dx = 2; dx <= 3; dx++) for (let z = 0; z <= 1; z++) expect(body.bot.blockAt(new Vec3(x + dx, Y - 4, z))?.name).toBe('stone');
  }, 120_000);

  it('what a craft left in the 2x2 grid is given back first (coal left there made every craft after come out as nothing)', async () => {
    const x = 6500;
    await at(x, 0);
    await server.cmd('give Ada minecraft:coal 2');
    await server.cmd('give Ada minecraft:oak_log 2');
    await sleep(1500);
    const coal = body.bot.inventory.items().find((i) => i.name === 'coal');
    if (!coal) throw new Error('no coal given');
    await body.bot.clickWindow(coal.slot, 0, 0);
    await body.bot.clickWindow(1, 0, 0);
    await sleep(500);
    expect(body.bot.inventory.slots[1]?.name).toBe('coal');
    const r = await run('craft', { item: 'oak_planks', qty: 8 });
    logger.info({ r }, 'grid cleared');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'oak_planks')).toBe(8);
    expect(countItem(body.bot, 'coal')).toBe(2);
  }, 120_000);

  it('walks in through a door and shuts it behind (two agents sat "sealed in" outside a hut whose door was left open)', async () => {
    const x = 6700;
    await at(x, 0);
    // A room of planks with a door in its west wall; the agent outside it.
    await server.cmd(`fill ${x + 2} ${Y - 1} -2 ${x + 6} ${Y + 2} 2 oak_planks hollow`);
    await server.cmd(`setblock ${x + 2} ${Y} 0 oak_door[facing=east,half=lower]`);
    await server.cmd(`setblock ${x + 2} ${Y + 1} 0 oak_door[facing=east,half=upper]`);
    await sleep(1500);
    const r = await run('goTo', { x: x + 4, y: Y, z: 0, range: 0 });
    await sleep(1500);
    const door = body.bot.blockAt(new Vec3(x + 2, Y, 0));
    logger.info({ r, at: body.bot.entity.position.toString(), door: door?.name, open: door?.getProperties?.().open }, 'through a door');
    expect(body.bot.entity.position.x).toBeGreaterThan(x + 3);
    expect(door?.name).toBe('oak_door');
    expect(door?.getProperties?.().open).toBe(false);
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
