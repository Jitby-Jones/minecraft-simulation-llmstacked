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
import { underTheSky } from '@agora/agent/body/skills/digging';
import { isIndoors, isSolid, roomAround, roomWords } from '@agora/agent/body/world';
import { whereNow } from '@agora/agent/perception/scene';
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
    // Coal: a few steps down from here, then the tunnel (a dig for diamonds goes down to their depth first).
    const r = await run('prospect', { item: 'coal', maxBlocks: 16, direction: 'east' });
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

  it('"smelt charcoal", named by what comes out as players say it: the logs on hand are cooked (asked three times, it said there was no charcoal to smelt)', async () => {
    const x = 5650;
    await at(x, 8);
    await server.cmd('give Ada minecraft:oak_log 5');
    await server.cmd('give Ada minecraft:furnace 1');
    await sleep(1500);
    const r = await run('smelt', { item: 'charcoal', qty: 3 });
    logger.info({ r, charcoal: countItem(body.bot, 'charcoal') }, 'smelt charcoal');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'charcoal')).toBeGreaterThanOrEqual(3);
  }, 240_000);

  it('a copper helmet from raw copper: smelted and made, armor of this version short of iron', async () => {
    const x = 9100;
    await at(x, 8);
    for (const g of ['raw_copper 5', 'coal 3', 'furnace 1', 'crafting_table 1']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(1500);
    const r = await run('obtain', { item: 'copper_helmet', qty: 1 });
    logger.info({ r }, 'copper helmet');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'copper_helmet')).toBe(1);
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

  it('down off a pillar ringed with stalagmites: by the stair, never a drop onto a point (one at 7 health "fell from a high place" so)', async () => {
    const x = 5600;
    await server.cmd(`forceload add ${x - 12} -12 ${x + 12} 12`);
    await server.cmd(`fill ${x - 6} ${Y} -6 ${x + 10} ${Y + 6} 6 air`);
    // A pillar three high, points all round its foot, and a stair down its west side.
    await server.cmd(`fill ${x} ${Y} 0 ${x + 2} ${Y + 2} 2 stone`);
    await server.cmd(`fill ${x - 1} ${Y} -1 ${x + 3} ${Y} 3 pointed_dripstone[vertical_direction=up] replace air`);
    await server.cmd(`setblock ${x - 1} ${Y} 1 stone`);
    await server.cmd(`setblock ${x - 1} ${Y + 1} 1 stone`);
    await server.cmd(`setblock ${x - 2} ${Y} 1 stone`);
    await server.cmd(`tp Ada ${x + 1}.5 ${Y + 3} 1.5`);
    await server.cmd('clear Ada');
    await server.cmd('effect give Ada minecraft:instant_health 1 3');
    await sleep(2000);
    const before = body.bot.health;
    // Where it stands, every tick of the walk: never over a point.
    const over: string[] = [];
    const look = () => {
      const under = body.bot.blockAt(body.bot.entity.position.offset(0, -0.2, 0));
      if (under?.name === 'pointed_dripstone') over.push(body.bot.entity.position.toString());
    };
    body.bot.on('physicsTick', look);
    const r = await run('goTo', { x: x + 7, y: Y, z: 1, range: 1 });
    body.bot.off('physicsTick', look);
    await sleep(1000);
    logger.info({ r, before, health: body.bot.health, over: over.slice(0, 5), at: body.bot.entity.position.toString() }, 'off the pillar');
    expect(r.ok).toBe(true);
    expect(over).toEqual([]);
    expect(body.bot.health).toBe(before);
  }, 120_000);

  it('pockets full of cobblestone: a dig says the inventory is full; some dropped, the dig goes on, and what was dropped stays dropped', async () => {
    const x = 5550;
    await at(x, 0);
    await server.cmd(`fill ${x - 3} ${Y} -3 ${x + 3} ${Y + 3} 3 air`);
    await server.cmd(`setblock ${x + 2} ${Y} 0 stone`);
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await server.cmd('give Ada minecraft:cobblestone 2240');
    await sleep(2000);
    expect(body.bot.inventory.items().length).toBe(36);
    const full = await run('mine', { block: 'stone', qty: 1 });
    logger.info({ full }, 'full pockets');
    expect(full.ok).toBe(false);
    expect(full.error).toMatch(/^your inventory is full/);
    const dropped = await run('drop', { item: 'cobblestone', qty: 128 });
    expect(dropped.ok).toBe(true);
    expect(dropped.observed).toMatch(/^dropped 128 cobblestone/);
    const r = await run('mine', { block: 'stone', qty: 1 });
    logger.info({ dropped, r }, 'room made');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'cobblestone')).toBe(2240 - 128 + 1);
  }, 120_000);

  it('an iron pickaxe nearly gone is spared where a stone one does the job, and used when it is all there is', async () => {
    const x = 5500;
    await at(x, 0);
    await server.cmd(`fill ${x - 3} ${Y} -3 ${x + 3} ${Y + 3} 3 air`);
    await server.cmd(`fill ${x + 2} ${Y} -2 ${x + 2} ${Y} 2 stone`);
    for (const g of ['iron_pickaxe[damage=230] 1', 'stone_pickaxe 1']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(2000);
    const used = (name: string) => (body.bot.inventory.items().find((i) => i.name === name) as unknown as { durabilityUsed?: number } | undefined)?.durabilityUsed ?? -1;
    expect(used('iron_pickaxe')).toBe(230);
    const r = await run('mine', { block: 'stone', qty: 3 });
    logger.info({ r, iron: used('iron_pickaxe'), stone: used('stone_pickaxe') }, 'worn pickaxe spared');
    expect(r.ok).toBe(true);
    expect(used('iron_pickaxe')).toBe(230);
    expect(used('stone_pickaxe')).toBeGreaterThanOrEqual(3);
    // The stone one gone: the worn iron one it is.
    await server.cmd('clear Ada minecraft:stone_pickaxe');
    await sleep(1000);
    const again = await run('mine', { block: 'stone', qty: 1 });
    expect(again.ok).toBe(true);
    expect(used('iron_pickaxe')).toBe(231);
  }, 120_000);

  it('a hut asked for at a spot goes up there, not by home (one asked for at its feet went up 40 blocks off)', async () => {
    const x = 5200;
    await at(x, 0);
    await server.cmd(`fill ${x - 4} ${Y} -8 ${x + 20} ${Y + 6} 8 air`);
    await server.cmd('give Ada minecraft:dirt 64');
    await sleep(1500);
    const r = await run('build', { structure: 'hut', room: 1, x: x + 12, y: Y, z: 0 });
    logger.info({ r }, 'hut where asked');
    expect(r.ok).toBe(true);
    const corner = (r.data as { corner?: { x: number; z: number } } | undefined)?.corner;
    expect(Math.abs((corner?.x ?? 1e9) - (x + 12))).toBeLessThanOrEqual(3);
    expect(Math.abs(corner?.z ?? 1e9)).toBeLessThanOrEqual(3);
  }, 120_000);

  it("a night's hut on a slope with no level spot anywhere: a bump or two dug out of the way, and up it goes", async () => {
    const x = 5300;
    const R = 28;
    await server.cmd(`forceload add ${x - R - 4} ${-R - 4} ${x + R + 4} ${R + 4}`);
    await server.cmd(`fill ${x - R} ${Y} ${-R} ${x + R} ${Y + R + 4} ${R} air`);
    // Ground a block higher every two east, farther than a hut is looked for.
    for (let dx = -R; dx <= R; dx++) {
      const h = Math.floor((dx + R) / 2);
      if (h > 0) await server.cmd(`fill ${x + dx} ${Y} ${-R} ${x + dx} ${Y + h - 1} ${R} dirt`);
    }
    await server.cmd(`tp Ada ${x}.5 ${Y + Math.floor(R / 2) + 1} 0.5`);
    await server.cmd('clear Ada');
    for (const g of ['dirt 64', 'stone_shovel 1']) await server.cmd(`give Ada minecraft:${g}`);
    await sleep(2000);
    const r = await run('build', { structure: 'hut', room: 1 });
    logger.info({ r }, 'hut on a slope');
    expect(r.ok).toBe(true);
    expect(r.observed).toMatch(/^built a hut/);
    // On the slope, not on level ground beyond it.
    const corner = (r.data as { corner?: { x: number; z: number } } | undefined)?.corner;
    expect(Math.abs((corner?.x ?? 1e9) - x)).toBeLessThan(R - 4);
    expect(Math.abs(corner?.z ?? 1e9)).toBeLessThan(R - 4);
  }, 180_000);

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
    // A few steps over the diamonds' depth: the stair down runs under the gravel.
    const y = -50;
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

  it('up out of the stone 24 deep: dug up and pillared, each block set once the feet are clear of its cell', async () => {
    // A walk up from a tunnel had 198 refused placements in two minutes: each block was sent while the feet were still
    // in its cell, refused, and the climb planned again.
    const x = 6900;
    await server.cmd(`tp Ada ${x} ${Y - 24} 0`);
    await server.cmd(`fill ${x} ${Y - 24} 0 ${x} ${Y - 23} 0 air`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await server.cmd('give Ada minecraft:cobblestone 64');
    await sleep(2000);
    let refused = 0;
    const onReset = (why: string) => {
      if (why === 'place_error') refused++;
    };
    body.bot.on('path_reset', onReset);
    const t0 = Date.now();
    const r = await run('goTo', { x: x + 3, y: Y, z: 0, range: 1 });
    body.bot.removeListener('path_reset', onReset);
    logger.info({ r, refused, s: (Date.now() - t0) / 1000 }, 'up out of the stone');
    expect(r.ok).toBe(true);
    expect(refused).toBeLessThanOrEqual(3);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it('an egg is no food: eating it is refused, and what can be eaten is named (one starving threw its egg trying)', async () => {
    const x = 7500;
    await at(x, 0);
    await server.cmd('give Ada minecraft:egg 1');
    await server.cmd('give Ada minecraft:bread 1');
    await sleep(1500);
    const r = await run('eat', { item: 'egg' });
    logger.info({ r }, 'an egg');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/egg can't be eaten; the food you carry: bread/);
    expect(countItem(body.bot, 'egg')).toBe(1);
  }, 120_000);

  it('what was eaten is said so, though its count drops a moment after the bite ("still on hand", it had said)', async () => {
    await at(7550, 0);
    await server.cmd('difficulty easy');
    await server.cmd('give Ada minecraft:bread 2');
    // Hungry: strong hunger a second at a time until the bar is down a good way.
    for (let i = 0; i < 8 && body.bot.food > 14; i++) {
      await server.cmd('effect give Ada minecraft:hunger 1 255');
      await sleep(1500);
    }
    await server.cmd('effect clear Ada');
    await sleep(500);
    const before = body.bot.food;
    const r = await run('eat', { item: 'bread' });
    await server.cmd('difficulty peaceful');
    logger.info({ r, before }, 'bread eaten');
    expect(before).toBeLessThan(20);
    expect(r.ok).toBe(true);
    expect(r.observed).toMatch(/^ate bread, food \d+/);
    expect(countItem(body.bot, 'bread')).toBe(1);
  }, 120_000);

  it('a hunt for a cow in view 45 m off: it walks to it and brings back the beef', async () => {
    const x = 7400;
    await at(x, 0);
    await server.cmd('difficulty peaceful');
    await server.cmd(`summon cow ${x + 45} ${Y} 0 {NoAI:1b}`);
    await server.cmd('give Ada minecraft:stone_sword 1');
    await sleep(2000);
    const r = await run('hunt', { animal: 'cow', qty: 1 });
    logger.info({ r }, 'a cow far off');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'beef')).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('smelting with no furnace near: one made of the cobblestone on hand at the table carried; without stone, it says what is short', async () => {
    const x = 7300;
    await at(x, 0);
    await server.cmd('give Ada minecraft:raw_iron 2');
    await server.cmd('give Ada minecraft:coal 1');
    await sleep(1500);
    const none = await run('smelt', { item: 'raw_iron', qty: 2 });
    logger.info({ none }, 'smelt, nothing for a furnace');
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/need a furnace, and could not make one: .*cobblestone/);
    await server.cmd('give Ada minecraft:cobblestone 8');
    await server.cmd('give Ada minecraft:crafting_table 1');
    await sleep(1500);
    const r = await run('smelt', { item: 'raw_iron', qty: 2 });
    logger.info({ r }, 'smelt, a furnace made');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'iron_ingot')).toBe(2);
  }, 180_000);

  it('a hut of what the digging brought: granite and andesite', async () => {
    // Prospectors carried dozens of granite and andesite and were told they needed more building blocks.
    const x = 7200;
    await at(x, 0);
    await server.cmd('give Ada minecraft:granite 14');
    await server.cmd('give Ada minecraft:andesite 14');
    await sleep(1500);
    const r = await run('build', { structure: 'hut', room: 1 });
    logger.info({ r }, 'a hut of granite');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'granite') + countItem(body.bot, 'andesite')).toBeLessThan(28);
  }, 180_000);

  it('"mine cobblestone" in a pit in the stone: it mines the stone cobblestone comes from', async () => {
    // Told to mine cobblestone, an agent standing on stone was told it had seen none around.
    const x = 7100;
    await at(x, 0);
    await server.cmd(`fill ${x - 2} ${Y - 4} -2 ${x + 2} ${Y - 1} 2 air`);
    await server.cmd(`tp Ada ${x} ${Y - 4} 0`);
    await server.cmd('give Ada minecraft:wooden_pickaxe 1');
    await sleep(2000);
    const r = await run('mine', { block: 'cobblestone', qty: 3 });
    logger.info({ r }, 'mine cobblestone');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'cobblestone')).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('one ingot short: the craft says how many in all and how many on hand; obtain, asked for what is held, says so', async () => {
    // "missing 1 iron_ingot" with 2 on hand was read as wanting 1 in all: obtain {qty: 1} found 2 there, three times.
    const x = 7000;
    await at(x, 0);
    await server.cmd('give Ada minecraft:iron_ingot 2');
    await server.cmd('give Ada minecraft:stick 2');
    await server.cmd(`setblock ${x + 2} ${Y} 0 crafting_table`);
    await sleep(1500);
    const r = await run('craft', { item: 'iron_pickaxe', qty: 1 });
    logger.info({ r }, 'one ingot short');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing 1 more iron_ingot \(3 needed, 2 on hand\)/);
    const o = await run('obtain', { item: 'iron_ingot', qty: 1 });
    expect(o.ok).toBe(true);
    expect(o.observed).toMatch(/already holding 2 iron_ingot: qty is how many in all/);
    // A tool held, nearly worn through: its wear with it ("holding 2 stone_pickaxe" was no news of two spent ones).
    await server.cmd('give Ada minecraft:stone_pickaxe[damage=110] 1');
    await sleep(1000);
    const p = await run('obtain', { item: 'stone_pickaxe', qty: 1 });
    expect(p.observed).toMatch(/already holding 1 stone_pickaxe \(wear left: 16%\)/);
  }, 120_000);

  it('a long way up out of the deep: 40 blocks down in the stone to a spot on the surface 40 blocks off', async () => {
    // One search for the whole way up ran out of time ("took too long to decide"), and a zombie found the one waiting.
    const x = 7600;
    await server.cmd(`forceload add ${x - 8} -48 ${x + 56} 16`);
    await server.cmd(`tp Ada ${x} ${Y - 40} 0`);
    await server.cmd(`fill ${x} ${Y - 40} 0 ${x} ${Y - 39} 0 air`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_pickaxe 2');
    await server.cmd('give Ada minecraft:cobblestone 64');
    await sleep(3000);
    const t0 = Date.now();
    const r = await run('goTo', { x: x + 40, y: Y, z: 0, range: 2 });
    logger.info({ r, s: (Date.now() - t0) / 1000, at: body.bot.entity.position.toString() }, 'a long way up');
    expect(r.ok).toBe(true);
  }, 400_000);

  it('torches with too little coal: it makes what it can and says it is the coal that is short', async () => {
    const x = 6800;
    await at(x, 0);
    await server.cmd('give Ada minecraft:coal 2');
    await server.cmd('give Ada minecraft:stick 10');
    await sleep(1500);
    const r = await run('craft', { item: 'torch', qty: 24 });
    logger.info({ r }, 'torches short of coal');
    expect(countItem(body.bot, 'torch')).toBe(8);
    expect(r.observed).toMatch(/crafted 8 torch; short of 4 coal for all 24/);
  }, 120_000);

  it("in a hut one across, a hair over the doorway's edge: the doorway is filled from inside, and the room is walled in (one refused twice went out to wait the night beside it)", async () => {
    const x = 6180;
    await at(x, 0);
    await server.cmd('give Ada minecraft:dirt 40');
    await sleep(1500);
    const r = await run('build', { structure: 'hut', room: 1 });
    logger.info({ r }, 'a hut one across');
    expect(r.ok).toBe(true);
    const m = /its room inside at (-?\d+),(-?\d+),(-?\d+), its doorway at (-?\d+),(-?\d+),(-?\d+) open/.exec(r.observed);
    expect(m).not.toBeNull();
    const room = new Vec3(Number(m?.[1]), Number(m?.[2]), Number(m?.[3]));
    const doorway = new Vec3(Number(m?.[4]), Number(m?.[5]), Number(m?.[6]));
    await run('goTo', { x: room.x, y: room.y, z: room.z, range: 0 });
    // Standing in the room, over the doorway's edge.
    const d = doorway.minus(room);
    await server.cmd(`tp Ada ${room.x + 0.5 + d.x * 0.3} ${room.y} ${room.z + 0.5 + d.z * 0.3}`);
    await sleep(1500);
    expect(roomWords(roomAround(body.bot))).toMatch(/^walled in but open to the/);
    const p = await run('place', { block: 'dirt', x: doorway.x, y: doorway.y, z: doorway.z });
    await sleep(1000);
    logger.info({ p, at: body.bot.entity.position.toString(), where: whereNow(body.bot).text }, 'the doorway filled from inside');
    expect(p.ok).toBe(true);
    expect(body.bot.blockAt(doorway)?.name).toBe('dirt');
    expect(body.bot.entity.position.floored().equals(room)).toBe(true);
    expect(whereNow(body.bot).text).toContain('walled in on every side');
  }, 180_000);

  it('seeds on farmland where two of four cells are sown already: the two free ones are sown (sown ones came to nothing four times over)', async () => {
    const x = 8900;
    await at(x, 0);
    // Four farmland cells in a row by water, the nearest two already sown.
    await server.cmd(`fill ${x + 1} ${Y - 1} 0 ${x + 4} ${Y - 1} 0 farmland`);
    await server.cmd(`setblock ${x + 1} ${Y - 1} 1 water`);
    await server.cmd(`setblock ${x + 1} ${Y} 0 wheat`);
    await server.cmd(`setblock ${x + 2} ${Y} 0 wheat`);
    await server.cmd('give Ada minecraft:wheat_seeds 4');
    await sleep(1500);
    const r = await run('use', { item: 'wheat_seeds', on: 'farmland', times: 2 });
    logger.info({ r, seeds: countItem(body.bot, 'wheat_seeds') }, 'seeds on part-sown farmland');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'wheat_seeds')).toBe(2);
    for (let dx = 1; dx <= 4; dx++) expect(body.bot.blockAt(new Vec3(x + dx, Y, 0))?.name).toBe('wheat');
  }, 120_000);

  it('a cow attacked and killed: what it dropped is walked over and taken (a salmon killed in a river was hunted for again and again)', async () => {
    const x = 8800;
    await at(x, 0);
    await server.cmd('give Ada minecraft:stone_sword 1');
    await server.cmd(`summon cow ${x + 4} ${Y} 0`);
    await sleep(1500);
    const r = await run('attack', { target: 'cow', seconds: 30 });
    await sleep(500);
    logger.info({ r, beef: countItem(body.bot, 'beef'), leather: countItem(body.bot, 'leather') }, 'a cow attacked');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'beef')).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('a rod on a pond: cast from the bank, pulled in when a fish bites, and the catch in hand', async () => {
    const x = 8700;
    await at(x, 0);
    // A pond seven across and three deep, its surface level with the ground, a step east of where she stands.
    await server.cmd(`fill ${x + 2} ${Y - 3} -3 ${x + 8} ${Y - 1} 3 water`);
    await server.cmd('give Ada minecraft:fishing_rod 1');
    await sleep(1500);
    const started = Date.now();
    const r = await run('use', { item: 'fishing_rod', on: 'water', times: 4 });
    logger.info({ r, ms: Date.now() - started, rod: countItem(body.bot, 'fishing_rod'), bobbers: Object.values(body.bot.entities).filter((e) => e.name === 'fishing_bobber').length }, 'fishing');
    expect(r.ok).toBe(true);
    expect(r.observed).toMatch(/bite/);
    // The line pulled in: no bobber left out on the water.
    expect(Object.values(body.bot.entities).some((e) => e.name === 'fishing_bobber')).toBe(false);
  }, 300_000);

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
    // Inside, the room is seen as it is, and the hand on the door says which side of it one is on.
    expect(whereNow(body.bot).text).toContain('inside a room, shut in on every side (a door to the west, shut)');
    const opened = await run('use', { on: 'door' });
    await sleep(500);
    expect(opened.observed).toMatch(/opened, with you inside/);
    expect(whereNow(body.bot).text).toContain('inside a room, open to the west (the door to the west standing open)');
    // Out, and the door shut from there: outside it, as the hand and the eyes both say.
    await server.cmd(`tp Ada ${x + 1}.5 ${Y} 0.5`);
    await sleep(1500);
    const shut = await run('use', { on: 'door' });
    await sleep(500);
    logger.info({ shut, where: whereNow(body.bot).text }, 'a door shut from outside');
    expect(shut.observed).toMatch(/shut, with you outside/);
    expect(whereNow(body.bot).text).toMatch(/under the open sky, outside a room \d m to the east, shut on every side/);
  }, 120_000);

  it('from a pocket 30 down in the stone, a stair dug up comes out under the open sky', async () => {
    // A player deep in a cave with the way back lost digs a stair up; an agent hurt down there had no hands for it.
    const x = 7800;
    await server.cmd(`forceload add ${x - 8} -48 ${x + 48} 48`);
    await server.cmd(`fill ${x} ${Y - 30} 0 ${x} ${Y - 29} 0 air`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 30} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_pickaxe 2');
    await server.cmd('give Ada minecraft:cobblestone 16');
    await sleep(3000);
    const t0 = Date.now();
    const r = await run('tunnel', { direction: 'up' });
    logger.info({ r, s: (Date.now() - t0) / 1000, at: body.bot.entity.position.toString() }, 'a stair up to the sky');
    expect(r.ok).toBe(true);
    expect(underTheSky(body.bot)).toBe(true);
    expect(body.bot.entity.position.y).toBeGreaterThan(Y - 1.5);
  }, 400_000);

  it('in a cave, dug two blocks into the wall with the way behind closed: out of reach in the rock', async () => {
    const x = 7900;
    // A cave room five across and three high, twenty down; the agent at its east wall.
    await server.cmd(`fill ${x - 2} ${Y - 20} -2 ${x + 2} ${Y - 18} 2 air`);
    await server.cmd(`tp Ada ${x + 2}.5 ${Y - 20} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await server.cmd('give Ada minecraft:cobblestone 16');
    await sleep(2500);
    const r = await run('tunnel', { direction: 'east', blocks: 2, close: true });
    const feet = body.bot.entity.position.floored();
    logger.info({ r, at: feet.toString() }, 'into the wall');
    expect(r.ok).toBe(true);
    expect(r.observed).toMatch(/the way behind closed/);
    expect(feet.x).toBe(x + 4);
    // The way in, where the room was: stone at the feet and at the head now.
    expect(isSolid(body.bot.blockAt(new Vec3(x + 2, Y - 20, 0)))).toBe(true);
    expect(isSolid(body.bot.blockAt(new Vec3(x + 2, Y - 19, 0)))).toBe(true);
    expect(isIndoors(body.bot)).toBe(true);
  }, 120_000);

  it('a stair up out of a cave room with the way behind closed: nothing can come up after', async () => {
    const x = 8000;
    await server.cmd(`fill ${x - 2} ${Y - 12} -2 ${x + 2} ${Y - 10} 2 air`);
    await server.cmd(`tp Ada ${x + 2}.5 ${Y - 12} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await server.cmd('give Ada minecraft:cobblestone 16');
    await sleep(2500);
    const r = await run('tunnel', { direction: 'up', close: true, toward: 'east' });
    logger.info({ r, at: body.bot.entity.position.toString() }, 'a stair up, closed behind');
    expect(r.ok).toBe(true);
    expect(r.observed).toMatch(/the way behind closed/);
    // The first step's way in from the room, at what were its feet and head: closed.
    expect(isSolid(body.bot.blockAt(new Vec3(x + 2, Y - 11, 0)))).toBe(true);
    expect(isSolid(body.bot.blockAt(new Vec3(x + 2, Y - 10, 0)))).toBe(true);
    expect(underTheSky(body.bot)).toBe(true);
  }, 300_000);

  it('a stair down six steps into the stone', async () => {
    const x = 8100;
    await at(x, 0);
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(1000);
    const r = await run('tunnel', { direction: 'down', blocks: 6 });
    logger.info({ r, at: body.bot.entity.position.toString() }, 'a stair down');
    expect(r.ok).toBe(true);
    expect(Math.floor(body.bot.entity.position.y)).toBe(Y - 6);
  }, 120_000);

  it('a block put toward a way, and again: at the feet, then at the head, a wall that way', async () => {
    // Asked to "block the arrows" with no spot, one went down anywhere and the skeleton shot on.
    const x = 8200;
    await at(x, 0);
    await server.cmd('give Ada minecraft:cobblestone 4');
    await sleep(1000);
    const feet = body.bot.entity.position.floored();
    const r1 = await run('place', { block: 'cobblestone', toward: 'east' });
    const r2 = await run('place', { block: 'cobblestone', toward: 'east' });
    logger.info({ r1: r1.observed, r2: r2.observed }, 'a wall toward the east');
    expect(r1.ok && r2.ok).toBe(true);
    expect(body.bot.blockAt(feet.offset(1, 0, 0))?.name).toBe('cobblestone');
    expect(body.bot.blockAt(feet.offset(1, 1, 0))?.name).toBe('cobblestone');
    // Up: over one's head, in a hole three deep (its lid in the ground's top layer).
    await server.cmd(`fill ${x + 4} ${Y - 3} 0 ${x + 4} ${Y - 1} 0 air`);
    await server.cmd(`tp Ada ${x + 4}.5 ${Y - 3} 0.5`);
    await sleep(1500);
    const r3 = await run('place', { block: 'cobblestone', toward: 'up' });
    logger.info({ r3: r3.observed, err: r3.error }, 'a lid over the head');
    expect(r3.ok).toBe(true);
    expect(body.bot.blockAt(new Vec3(x + 4, Y - 1, 0))?.name).toBe('cobblestone');
    // Closed over already: said so, not "no up in sight".
    const r4 = await run('place', { block: 'cobblestone', toward: 'up' });
    logger.info({ r4: r4.observed, err: r4.error, at: body.bot.entity.position.toString() }, 'a lid there already');
    expect(r4.ok).toBe(true);
    expect(r4.observed).toMatch(/over your head already/);
  }, 60_000);

  it('hunting 30 down in the stone: none in sight, and it says how far up the sky is, where the animals are', async () => {
    // At dawn, at 9 health with no food, one hunted 50 blocks down, found nothing, and went off exploring the caves.
    const x = 8300;
    await server.cmd(`fill ${x} ${Y - 30} 0 ${x} ${Y - 29} 0 air`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 30} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_sword 1');
    await sleep(2000);
    const r = await run('hunt', { qty: 2 });
    logger.info({ r }, 'a hunt underground');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/you are underground, the open sky some 3\d blocks up: animals live up on the surface/);
  }, 60_000);

  it('sent for a log from 30 down, the hands say where it is: up, out under the open sky', async () => {
    // Told only "digging 1 oak_log", a mind did not know its hands were taking it 34 blocks up to a tree at night.
    const x = 9300;
    await server.cmd(`tp Ada ${x}.5 ${Y + 2} 0.5`);
    await sleep(2000);
    // Set once the chunks are loaded round her (a setblock in an unloaded chunk does nothing).
    await server.cmd(`fill ${x} ${Y - 30} 0 ${x} ${Y - 29} 0 air`);
    await server.cmd(`setblock ${x + 12} ${Y} 6 minecraft:oak_log`);
    await server.cmd(`tp Ada ${x}.5 ${Y - 30} 0.5`);
    await server.cmd('clear Ada');
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(2000);
    const notes: string[] = [];
    const ac = new AbortController();
    const r = await body
      .run('gather', { item: 'oak_log', qty: 1 }, {
        signal: ac.signal,
        progress: (n) => {
          notes.push(n);
          if (/digging/.test(n)) ac.abort();
        },
      })
      .catch((e: unknown) => String(e));
    logger.info({ notes, r }, 'a log from down a mine');
    expect(notes.find((n) => /digging/.test(n))).toBe('digging 1 oak_log, 13 m south-east, 30 m up, out under the open sky');
  }, 90_000);

  it('planks said plainly are any wood\'s: 42 from 5 birch and 8 oak logs on hand, nothing gathered', async () => {
    // Made birch (the first logs in the bag), the hands went up a cliff for more birch and timed out four times.
    await at(9400, 0);
    await server.cmd('give Ada minecraft:birch_log 5');
    await server.cmd('give Ada minecraft:oak_log 8');
    await sleep(1000);
    const r = await run('obtain', { item: 'planks', qty: 42 });
    logger.info({ r }, 'any planks');
    expect(r.ok).toBe(true);
    const items = body.bot.inventory.items();
    const planks = items.filter((i) => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
    expect(planks).toBeGreaterThanOrEqual(42);
    // The oak, there being most of it, went first: all 8 cut, and of the birch only what was short.
    expect(items.filter((i) => i.name === 'oak_log')).toHaveLength(0);
    expect(items.find((i) => i.name === 'birch_log')?.count ?? 0).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('coal over a stalagmite close by and coal on clear ground farther: the clear one, as a player would', async () => {
    // Coal up a dripstone cave's wall: a fall of three blocks onto a point, then hop after hop on it, "impaled".
    const x = 9500;
    await at(x, 0);
    // The point beside the coal's column, not under it (a block a stalactite hangs from is passed over already).
    await server.cmd(`setblock ${x + 3} ${Y} 1 minecraft:pointed_dripstone[vertical_direction=up,thickness=tip]`);
    await server.cmd(`setblock ${x + 3} ${Y + 1} 0 minecraft:coal_ore`);
    await server.cmd(`setblock ${x + 10} ${Y} 4 minecraft:coal_ore`);
    await server.cmd('give Ada minecraft:stone_pickaxe 1');
    await sleep(2000);
    const r = await run('mine', { block: 'coal_ore', qty: 1 });
    logger.info({ r }, 'clear coal');
    expect(r.ok).toBe(true);
    expect(body.bot.blockAt(new Vec3(x + 3, Y + 1, 0))?.name).toBe('coal_ore');
    expect(body.bot.blockAt(new Vec3(x + 10, Y, 4))?.name).not.toBe('coal_ore');
  }, 120_000);

  it('down off a roof of its own with no way down: the drop the body can take, as a player jumps', async () => {
    // Planks can't be dug through (what was built is gone round), and no drop over three blocks is taken while there
    // is another way: here there is none, six blocks up.
    const x = 9600;
    await at(x, 0);
    await server.cmd(`fill ${x - 2} ${Y + 5} -2 ${x + 2} ${Y + 5} 2 minecraft:oak_planks`);
    await server.cmd(`tp Ada ${x} ${Y + 6} 0`);
    await sleep(1500);
    const before = body.bot.health;
    const r = await run('goTo', { x: x + 6, y: Y, z: 0, range: 1 });
    logger.info({ r, health: body.bot.health }, 'off the roof');
    expect(r.ok).toBe(true);
    expect(r.observed).toMatch(/a drop of up to \d+/);
    expect(body.bot.entity.position.y).toBeLessThan(Y + 1);
    expect(body.bot.health).toBeGreaterThan(before - 8);
  }, 120_000);

  it('a torch toward a wall right at its side goes on that wall, in the cell it stands in, as a player lights a tunnel', async () => {
    // In a tunnel, "a torch toward north" was told both cells that way were taken: the wall it would have gone on.
    const x = 9700;
    await at(x, 0);
    await server.cmd(`fill ${x - 1} ${Y - 1} -1 ${x + 1} ${Y + 2} 1 minecraft:stone hollow`);
    await server.cmd('give Ada minecraft:torch 4');
    await sleep(1500);
    const r = await run('place', { block: 'torch', toward: 'north' });
    logger.info({ r }, 'torch at its side');
    expect(r.ok).toBe(true);
    const lit = [body.bot.blockAt(new Vec3(x, Y + 1, 0))?.name, body.bot.blockAt(new Vec3(x, Y, 0))?.name];
    expect(lit.some((n) => n === 'wall_torch' || n === 'torch')).toBe(true);
    await server.cmd(`fill ${x - 1} ${Y - 1} -1 ${x + 1} ${Y + 2} 1 minecraft:air`);
  }, 120_000);

  it('a block down, three of them: up a pillar on what it carries, as a player towers up out of reach', async () => {
    // One running from a zombie at night with 21 dirt on him had no way to ask his hands for it.
    const x = 9800;
    await at(x + 0.5, 0.5);
    await server.cmd('give Ada minecraft:dirt 8');
    await sleep(1500);
    const from = body.bot.entity.position.y;
    const r = await run('place', { block: 'dirt', toward: 'down', count: 3 });
    logger.info({ r, y: body.bot.entity.position.y }, 'a pillar under the feet');
    console.log(`[pillar] ${r.observed}`);
    expect(r.ok).toBe(true);
    expect(body.bot.entity.position.y - from).toBeGreaterThan(2.9);
    expect(r.observed).toContain('up 3 m above the ground on every side');
    await server.cmd(`fill ${x} ${Y} 0 ${x} ${Y + 4} 0 minecraft:air`);
    await server.cmd(`tp Ada ${x + 2} ${Y} 0`);
  }, 120_000);

  it('a torch down goes on the floor where it stands, not up a pillar', async () => {
    // Asked so in a mine, one was told there was "no down in sight within 32 blocks".
    const x = 9900;
    await at(x + 0.5, 0.5);
    await server.cmd('give Ada minecraft:torch 2');
    await sleep(1500);
    const from = body.bot.entity.position.y;
    const r = await run('place', { block: 'torch', toward: 'down' });
    logger.info({ r }, 'a torch down');
    expect(r.ok).toBe(true);
    expect(body.bot.blockAt(new Vec3(x, Y, 0))?.name).toBe('torch');
    expect(Math.abs(body.bot.entity.position.y - from)).toBeLessThan(0.5);
    await server.cmd(`setblock ${x} ${Y} 0 minecraft:air`);
  }, 120_000);

  it('no pickaxe left: a tunnel says how long rock takes by hand, and on bare-handed it digs through', async () => {
    // One at y -45 with its last pickaxe worn out and no wood sat waiting there, its tunnel refusing to dig.
    const x = 10000;
    await at(x + 0.5, 0.5);
    await server.cmd(`fill ${x + 1} ${Y} 0 ${x + 4} ${Y + 1} 0 minecraft:stone`);
    await sleep(1500);
    const no = await run('tunnel', { direction: 'east', blocks: 1 });
    logger.info({ no }, 'a tunnel with no pickaxe');
    expect(no.ok).toBe(false);
    expect(no.error ?? '').toMatch(/by hand a block of it takes about \d+ s and drops nothing/);
    const yes = await run('tunnel', { direction: 'east', blocks: 1, byHand: true });
    logger.info({ yes }, 'a tunnel by hand');
    expect(yes.ok).toBe(true);
    expect(body.bot.blockAt(new Vec3(x + 1, Y, 0))?.name).toBe('air');
    await server.cmd(`fill ${x + 1} ${Y} 0 ${x + 4} ${Y + 1} 0 minecraft:air`);
  }, 120_000);

  it('a hunt for fish: a salmon in a pond is killed in the water and the fish taken; a villager is no game', async () => {
    // One at 4 health with nothing to eat saw a salmon 28 m off, took it for scenery, and hunting knew only farm animals.
    const x = 10100;
    await at(x + 0.5, 0.5);
    await server.cmd('difficulty peaceful');
    // A pond five across and two deep, its surface level with the ground, a step east of where she stands.
    await server.cmd(`fill ${x + 2} ${Y - 2} -2 ${x + 6} ${Y - 1} 2 water`);
    await server.cmd(`summon salmon ${x + 4} ${Y - 2} 0 {NoAI:1b}`);
    await server.cmd('give Ada minecraft:stone_sword 1');
    await sleep(2000);
    const no = await run('hunt', { animal: 'villager', qty: 1 });
    expect(no.ok).toBe(false);
    expect(no.error ?? '').toMatch(/drops nothing to eat/);
    const r = await run('hunt', { animal: 'fish', qty: 1 });
    logger.info({ r, salmon: countItem(body.bot, 'salmon') }, 'a salmon hunted');
    expect(r.ok).toBe(true);
    expect(countItem(body.bot, 'salmon')).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('explores a chosen way', async () => {
    const x = 5400;
    await at(x, 0);
    const r = await run('explore', { direction: 'east', distance: 64 });
    logger.info({ r }, 'explore');
    expect(r.ok).toBe(true);
    expect(body.bot.entity.position.x - x).toBeGreaterThan(40);
  }, 180_000);
});
