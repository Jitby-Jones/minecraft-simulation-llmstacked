// M0 exit test (§16.4, §15.1 smoke): bots join Paper 26.1.2, proximity chat ranges hold, the owner's spy sees
// everything, private chat commands are blocked for non-ops, and the basic interactions work on this version.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadVersionsConfig, parseProximityLine, sleep, type ParsedChatLine } from '@agora/shared';
import { type Bot, Vec3, connectBody, disconnectBody } from '@agora/agent/body/bot';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const GROUND_Y = -60; // superflat: grass at y = -61

interface Heard {
  line: ParsedChatLine;
  raw: string;
}

function listen(bot: Bot): Heard[] {
  const heard: Heard[] = [];
  bot.on('messagestr', (raw: string) => {
    heard.push({ line: parseProximityLine(raw), raw });
  });
  return heard;
}

function spoke(heard: Heard[], speaker: string, text: string): boolean {
  return heard.some((h) => h.line.kind === 'speech' && h.line.speaker === speaker && h.line.text === text);
}

describe.skipIf(!liveJavaPath())('M0 live: Paper 26.1.2 + mineflayer + ProximityChat!', () => {
  let server: LiveServer;
  const bots: Bot[] = [];

  async function join(name: string, x: number, z: number): Promise<{ bot: Bot; heard: Heard[] }> {
    const bot = await connectBody({ host: server.host, port: server.port, username: name, version: versions.minecraft.version });
    bots.push(bot);
    const heard = listen(bot);
    await server.cmd(`tp ${name} ${x} ${GROUND_Y} ${z}`);
    await waitFor(() => Math.abs(bot.entity.position.x - x) < 1.5 && Math.abs(bot.entity.position.z - z) < 1.5, 10000, `${name} at ${x},${z}`);
    return { bot, heard };
  }

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm0' });
    await server.cmd('gamerule advance_time false');
    await server.cmd('time set 1000');
    await server.cmd('gamerule show_death_messages true');
    await server.cmd('gamerule show_advancement_messages true');
  });

  afterAll(async () => {
    for (const b of bots) await disconnectBody(b);
    await server?.stop();
  });

  it('a bot joins and logs its position', async () => {
    const { bot } = await join('Pip', 0, 0);
    expect(bot.version).toBe('26.1');
    const p = bot.entity.position;
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    expect(bot.game.gameMode).toBe('survival');
  });

  it('two bots 10 blocks apart hear each other; one 30 blocks away does not', async () => {
    const pip = bots[0] as Bot;
    const pipHeard = listen(pip);
    const { bot: bram, heard: bramHeard } = await join('Bram', 10, 0);
    const { heard: farHeard } = await join('Lira', 30, 0);
    await sleep(500);
    pip.chat('hello there');
    await waitFor(() => spoke(bramHeard, 'Pip', 'hello there'), 5000, 'Bram hears Pip');
    bram.chat('hi Pip');
    await waitFor(() => spoke(pipHeard, 'Bram', 'hi Pip'), 5000, 'Pip hears Bram');
    await sleep(1500);
    expect(spoke(farHeard, 'Pip', 'hello there')).toBe(false);
    // Speech is a system line, so it parses as normal volume.
    const h = bramHeard.find((x) => x.line.kind === 'speech');
    expect(h?.line.kind === 'speech' && h.line.volume).toBe('normal');
  });

  it('whisper reaches 4 blocks but not 10; shout reaches 30', async () => {
    const pip = bots[0] as Bot;
    const { heard: nearHeard } = await join('Wren', 4, 0);
    const bramHeard = listen(bots[1] as Bot);
    const liraHeard = listen(bots[2] as Bot);
    pip.chat('#psst secret');
    await waitFor(() => nearHeard.some((h) => h.line.kind === 'speech' && h.line.volume === 'whisper'), 5000, 'whisper heard');
    await sleep(1000);
    expect(bramHeard.some((h) => h.line.kind === 'speech' && h.line.volume === 'whisper')).toBe(false);
    pip.chat('!everyone come here');
    await waitFor(
      () => liraHeard.some((h) => h.line.kind === 'speech' && h.line.volume === 'shout' && h.line.text === 'everyone come here'),
      5000,
      'shout heard at 30',
    );
  });

  it('the owner (op, spy on) sees out-of-range speech as [Spy]', async () => {
    const { bot: owner, heard: ownerHeard } = await join('OwnerTest', 200, 200);
    await server.cmd('op OwnerTest');
    await sleep(500);
    owner.chat('/pchat spy');
    await waitFor(() => ownerHeard.some((h) => /spy mode/i.test(h.raw)), 5000, 'spy enabled');
    (bots[1] as Bot).chat('can anyone hear me');
    await waitFor(
      () => ownerHeard.some((h) => h.line.kind === 'spy' && h.line.speaker === 'Bram' && h.line.text === 'can anyone hear me'),
      5000,
      '[Spy] line',
    );
  });

  it('blocks /msg for non-ops and allows it for ops', async () => {
    const pip = bots[0] as Bot;
    const bram = bots[1] as Bot;
    const bramHeard = listen(bram);
    const pipHeard = listen(pip);
    pip.chat('/msg Bram secret plan');
    await waitFor(() => pipHeard.some((h) => /Private messages are disabled/.test(h.raw)), 5000, 'guard reply');
    await sleep(1000);
    expect(bramHeard.some((h) => /secret plan/.test(h.raw))).toBe(false);
    pip.chat('/minecraft:tell Bram namespaced');
    await sleep(1500);
    expect(bramHeard.some((h) => /namespaced/.test(h.raw))).toBe(false);
    const owner = bots[bots.length - 1] as Bot;
    owner.chat('/msg Bram ops can whisper');
    await waitFor(() => bramHeard.some((h) => /ops can whisper/.test(h.raw)), 5000, 'op /msg delivered');
  });

  it('digs, places, opens a chest, crafts and clicks inventory windows on 26.1', async () => {
    const pip = bots[0] as Bot;
    await server.cmd(`tp Pip 0 ${GROUND_Y} 0`);
    await server.cmd('clear Pip');
    await server.cmd(`setblock 2 ${GROUND_Y} 0 minecraft:stone`);
    await server.cmd(`setblock 0 ${GROUND_Y} 2 minecraft:chest`);
    await server.cmd('give Pip minecraft:oak_log 2');
    await server.cmd('give Pip minecraft:dirt 3');
    await server.cmd('give Pip minecraft:wooden_pickaxe 1');
    await waitFor(() => pip.inventory.items().length >= 3, 5000, 'items given');

    // dig
    const stone = await waitFor(() => pip.blockAt(new Vec3(2, GROUND_Y, 0)), 5000, 'stone loaded');
    expect(stone.name).toBe('stone');
    const pick = pip.inventory.items().find((i) => i.name === 'wooden_pickaxe');
    if (pick) await pip.equip(pick, 'hand');
    await pip.dig(stone);
    expect(pip.blockAt(new Vec3(2, GROUND_Y, 0))?.name).toBe('air');

    // place
    const dirt = pip.inventory.items().find((i) => i.name === 'dirt');
    expect(dirt).toBeDefined();
    if (!dirt) return;
    await pip.equip(dirt, 'hand');
    const below = pip.blockAt(new Vec3(2, GROUND_Y - 1, 0));
    if (!below) throw new Error('no reference block');
    await pip.placeBlock(below, new Vec3(0, 1, 0));
    await waitFor(() => pip.blockAt(new Vec3(2, GROUND_Y, 0))?.name === 'dirt', 5000, 'dirt placed');

    // craft planks (2x2 inventory grid, no table)
    const planks = pip.registry.itemsByName.oak_planks;
    expect(planks).toBeDefined();
    if (!planks) return;
    const recipes = pip.recipesFor(planks.id, null, 1, null);
    expect(recipes.length).toBeGreaterThan(0);
    const recipe = recipes[0];
    if (!recipe) return;
    await pip.craft(recipe, 1, undefined);
    await waitFor(() => pip.inventory.items().some((i) => i.name === 'oak_planks' && i.count >= 4), 5000, 'planks crafted');

    // click inventory windows: move the planks into the hotbar's last slot
    const plankItem = pip.inventory.items().find((i) => i.name === 'oak_planks');
    if (!plankItem) throw new Error('planks missing');
    const destSlot = pip.inventory.hotbarStart + 8;
    await pip.moveSlotItem(plankItem.slot, destSlot);
    await waitFor(() => pip.inventory.slots[destSlot]?.name === 'oak_planks', 5000, 'slot click moved item');

    // open a chest and deposit
    const chestBlock = await waitFor(() => pip.blockAt(new Vec3(0, GROUND_Y, 2)), 5000, 'chest loaded');
    const chest = await pip.openContainer(chestBlock);
    const dirtLeft = pip.inventory.items().find((i) => i.name === 'dirt');
    if (dirtLeft) await chest.deposit(dirtLeft.type, null, 1);
    await chest.close();
    // RCON and the game connection are separate sockets: poll until the server has applied the clicks.
    let data = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !/dirt/.test(data)) {
      data = await server.cmd(`data get block 0 ${GROUND_Y} 2 Items`);
      if (!/dirt/.test(data)) await sleep(200);
    }
    expect(data).toMatch(/dirt/);
  });
});
