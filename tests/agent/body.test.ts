import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SeededRandom, nullLogger } from '@agora/shared';
import type { Bot } from '@agora/agent/body/bot';
import { Vec3 } from '@agora/agent/body/bot';
import { ChatOut } from '@agora/agent/body/chatOut';
import { countIn, describeDiff, diffInventory, inventoryDigest } from '@agora/agent/body/inventory';
import { armorSlotOf, blockMatcher, gearScore, itemMatcher, normalizeItemName, weaponTier } from '@agora/agent/body/items';
import { compileCondition, pathCostRules, reflexDelta } from '@agora/agent/body/quirks';
import { SKILLS, getSkill, skillCatalog } from '@agora/agent/body/skills/registry';
import { describeMissing } from '@agora/agent/body/skills/crafting';
import { eatNow } from '@agora/agent/body/skills/survival';
import { bodyNote, checkExpectation, describeExpectation, runSkill } from '@agora/agent/body/skills/runner';
import { SkillAbortedError, defineSkill } from '@agora/agent/body/skills/types';
import { SwingTracker } from '@agora/agent/body/attribution';
import { ReflexController, shoots } from '@agora/agent/body/reflexes';
import { wetAt } from '@agora/agent/body/world';
import { armorPoints, asDifficulty, expectedFightDamage, weaponStats } from '@agora/agent/body/combatOdds';
import { z } from 'zod';

describe('item names and tiers', () => {
  it('normalizes what a CC might say', () => {
    expect(normalizeItemName('Oak Logs')).toBe('oak_log');
    expect(normalizeItemName('minecraft:stone')).toBe('stone');
    expect(normalizeItemName('wood')).toBe('log');
    expect(normalizeItemName('logs')).toBe('log');
    expect(normalizeItemName('Sticks')).toBe('stick');
    expect(normalizeItemName('glass')).toBe('glass');
    expect(normalizeItemName('oak_planks')).toBe('oak_planks');
    expect(normalizeItemName('iron')).toBe('raw_iron');
    // In the singular, what the game only names in the plural (one asked three times for "oak_plank", 55 on hand).
    expect(normalizeItemName('oak_plank')).toBe('oak_planks');
    expect(normalizeItemName('oak plank')).toBe('oak_planks');
    expect(normalizeItemName('plank')).toBe('planks');
    expect(normalizeItemName('cobblestone_stair')).toBe('cobblestone_stairs');
    expect(normalizeItemName('oak_leaf')).toBe('oak_leaves');
    expect(normalizeItemName('wheat_seed')).toBe('wheat_seeds');
    expect(normalizeItemName('iron_boot')).toBe('iron_boots');
    expect(normalizeItemName('iron_bar')).toBe('iron_bars');
    // What is an item in the singular stays so.
    expect(normalizeItemName('nether_brick')).toBe('nether_brick');
    expect(normalizeItemName('brick')).toBe('brick');
  });

  it('matches categories without false positives', () => {
    const log = itemMatcher('logs');
    expect(log.matches('oak_log')).toBe(true);
    expect(log.matches('crimson_stem')).toBe(true);
    expect(log.matches('stripped_oak_log')).toBe(false);
    expect(log.matches('oak_planks')).toBe(false);
    expect(itemMatcher('planks').matches('birch_planks')).toBe(true);
    expect(itemMatcher('oak_log').matches('birch_log')).toBe(false);
    // Fish as players say it: cod or salmon ("obtain fish" was told there is no item called fish).
    expect(itemMatcher('fish').matches('salmon')).toBe(true);
    expect(itemMatcher('raw fish').matches('cod')).toBe(true);
    expect(itemMatcher('fish').matches('tropical_fish')).toBe(false);
    expect(itemMatcher('cooked fish').matches('cooked_cod')).toBe(true);
    // An ore is the same ore in deepslate, either way it is named; other blocks are what they are named.
    expect(blockMatcher('iron_ore').matches('deepslate_iron_ore')).toBe(true);
    // Raw meat as players say it is the game's plain name; raw iron stays raw iron.
    expect(normalizeItemName('raw_porkchop')).toBe('porkchop');
    expect(normalizeItemName('raw beef')).toBe('beef');
    expect(normalizeItemName('raw_chickens')).toBe('chicken');
    expect(normalizeItemName('raw_iron')).toBe('raw_iron');
    expect(blockMatcher('deepslate_diamond_ore').matches('diamond_ore')).toBe(true);
    expect(blockMatcher('iron_ore').matches('gold_ore')).toBe(false);
    expect(blockMatcher('stone').matches('deepslate')).toBe(false);
  });

  it('scores gear monotonically', () => {
    expect(gearScore([], null)).toBe(0);
    const leather = gearScore(['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'], 'wooden_sword');
    const iron = gearScore(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], 'iron_sword');
    const neth = gearScore(['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], 'netherite_sword');
    expect(leather).toBeLessThan(iron);
    expect(iron).toBeLessThan(neth);
    expect(neth).toBeLessThanOrEqual(1);
    expect(armorSlotOf('diamond_leggings')).toBe('legs');
    expect(armorSlotOf('diamond_sword')).toBeNull();
    expect(weaponTier('iron_sword')).toBeGreaterThan(weaponTier('stone_sword'));
  });
});

describe('quirks (§7)', () => {
  it('compiles the condition grammar', () => {
    const dark = compileCondition('lightLevel<7');
    expect(dark({ lightLevel: 3, timeOfDay: 0, health: 20, food: 20, y: 64 })).toBe(true);
    expect(dark({ lightLevel: 9, timeOfDay: 0, health: 20, food: 20, y: 64 })).toBe(false);
    expect(compileCondition('y<=0')({ lightLevel: 15, timeOfDay: 0, health: 20, food: 20, y: 0 })).toBe(true);
    expect(() => compileCondition('process.exit()')).toThrow();
  });

  it('turns quirks into path costs and reflex biases', () => {
    const rules = pathCostRules([{ hook: 'pathCost', when: 'lightLevel<7', multiplier: 3 }]);
    expect(rules[0]?.extraCost).toBe(2);
    expect(reflexDelta([{ hook: 'reflexBias', reflex: 'flee', delta: 2 }, { hook: 'reflexBias', reflex: 'flee', delta: 1 }], 'flee')).toBe(3);
  });
});

describe('inventory diffs', () => {
  it('diffs snapshots and digests stacks', () => {
    const before = new Map([['oak_log', 2], ['bread', 3]]);
    const after = new Map([['oak_log', 6], ['bread', 2], ['stick', 4]]);
    const d = diffInventory(before, after);
    expect(Object.fromEntries(d)).toEqual({ oak_log: 4, bread: -1, stick: 4 });
    expect(describeDiff(d)).toContain('+4 oak_log');
    expect(countIn(after, itemMatcher('log'))).toBe(6);
    expect(inventoryDigest([{ item: 'bread', qty: 2 }, { item: 'iron_pickaxe', qty: 1 }])).toBe('2 bread, iron_pickaxe');
    expect(inventoryDigest([])).toBe('empty');
  });
});

function fakeChatBot(): { bot: Bot; sent: { text: string; at: number }[] } {
  const sent: { text: string; at: number }[] = [];
  const bot = { chat: (text: string) => sent.push({ text, at: Date.now() }), _client: { ended: false } } as unknown as Bot;
  return { bot, sent };
}

describe('chat output guards (§6.2, §15.3, §16.1)', () => {
  it('spaces messages, refuses commands and prefixes volume', async () => {
    const { bot, sent } = fakeChatBot();
    const out = new ChatOut(bot, { minIntervalMs: 120, msPerChar: 0 });
    await out.say('hello');
    await out.say('/op me');
    await out.say('come here', 'shout');
    expect(sent.map((s) => s.text)).toEqual(['hello', '!come here']);
    expect((sent[1]?.at ?? 0) - (sent[0]?.at ?? 0)).toBeGreaterThanOrEqual(110);
  });

  it('splits long lines at sentence boundaries under 256 chars', async () => {
    const { bot, sent } = fakeChatBot();
    const out = new ChatOut(bot, { minIntervalMs: 0, msPerChar: 0 });
    await out.say(`${'This is a fairly long sentence about mining. '.repeat(10)}`);
    expect(sent.length).toBeGreaterThan(1);
    for (const s of sent) expect(s.text.length).toBeLessThanOrEqual(256);
  });

  it('enforces the per-pair cap and the global token', async () => {
    const { bot, sent } = fakeChatBot();
    const out = new ChatOut(bot, { minIntervalMs: 0, msPerChar: 0, pairLimit: { count: 2, windowMs: 60_000 } });
    for (let i = 0; i < 4; i++) await out.say(`line ${i}`, 'normal', ['Bram']);
    expect(sent.length).toBe(2);
    expect(out.guardHitCount).toBe(2);
    const denied = new ChatOut(bot, { minIntervalMs: 0, msPerChar: 0, acquireGlobalToken: async () => false });
    expect((await denied.say('hi')).reason).toBe('global');
  });

  it('says an urgent line at once, ahead of what waits, and drops what waited', async () => {
    const { bot, sent } = fakeChatBot();
    const out = new ChatOut(bot, { minIntervalMs: 2000, msPerChar: 40 });
    const t0 = Date.now();
    const threat = out.say('back off, or else.');
    const giveUp = out.say('ok ok, I yield!', 'normal', [], undefined, true);
    expect((await giveUp).sent).toBe(true);
    expect(Date.now() - t0).toBeLessThan(100);
    // "back off, or else" after "I yield" would be a lie.
    expect((await threat).reason).toBe('superseded');
    expect(sent.map((s) => s.text)).toEqual(['ok ok, I yield!']);
  });

  it('applies a typing delay of ~40 ms/char capped at 3 s', async () => {
    const { bot, sent } = fakeChatBot();
    const out = new ChatOut(bot, { minIntervalMs: 0, msPerChar: 10, maxTypingMs: 150 });
    const t0 = Date.now();
    await out.say('x'.repeat(50));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(sent.length).toBe(1);
  });
});

describe('skill registry', () => {
  it('has unique names, aliases and a catalog line per skill', () => {
    const names = SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(getSkill('collect')?.name).toBe('gather');
    expect(getSkill('goto')?.name).toBe('goTo');
    expect(getSkill('nope')).toBeNull();
    const catalog = skillCatalog();
    for (const s of SKILLS.filter((x) => !x.codeOnly)) expect(catalog).toContain(`- ${s.name} `);
    // The mind's hands, not the code's routines: the night's hole is the code-only brain's, and "hide" names nothing.
    expect(catalog).not.toContain('- shelter ');
    expect(catalog).toContain('- tunnel {');
    expect(getSkill('hide')).toBeNull();
    expect(getSkill('tunnel')?.name).toBe('tunnel');
  });

  it('validates arguments', () => {
    const gather = getSkill('gather');
    expect(gather?.parseArgs({ item: 'oak_log', qty: '8' })).toMatchObject({ ok: true, args: { item: 'oak_log', qty: 8 } });
    expect(gather?.parseArgs({ qty: 3 }).ok).toBe(false);
    expect(getSkill('goTo')?.parseArgs({ x: 1, y: 64, z: 2 }).ok).toBe(true);
    expect(getSkill('goTo')?.parseArgs({ agent: 'Bram' }).ok).toBe(true);
    expect(getSkill('say')?.parseArgs({ text: 'hi', volume: 'scream' }).ok).toBe(false);
  });
});

function fakeBody(): Bot {
  const items: { name: string; count: number; type: number; slot: number }[] = [];
  return {
    inventory: { items: () => items, slots: [] as unknown[] },
    entity: { position: new Vec3(0, 64, 0) },
    food: 20,
    health: 20,
    registry: { foodsByName: {} },
    __items: items,
  } as unknown as Bot;
}

describe('crafting shopping list', () => {
  it('names the everyday variant and lists one-for-one alternatives', () => {
    const best = [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }];
    const others = [
      [{ name: 'cobbled_deepslate', count: 3 }, { name: 'stick', count: 2 }],
      [{ name: 'blackstone', count: 3 }, { name: 'stick', count: 2 }],
      [{ name: 'blackstone', count: 3 }],
    ];
    expect(describeMissing(best, others)).toBe('3 cobblestone (or cobbled_deepslate/blackstone), 2 stick');
    expect(describeMissing([{ name: 'stick', count: 1 }], [])).toBe('1 stick');
    // Some on hand: how many more, in all, and on hand.
    expect(describeMissing([{ name: 'iron_ingot', count: 1, have: 2 }], [])).toBe('1 more iron_ingot (3 needed, 2 on hand)');
    expect(describeMissing([], [])).toBe('');
  });
});

describe('eating', () => {
  it('one bite at a time: a second eat while one is under way waits for it, never cutting it off', async () => {
    let consumes = 0;
    const bot = {
      equip: async () => undefined,
      consume: async () => {
        consumes++;
        await new Promise((r) => setTimeout(r, 30));
      },
    } as unknown as Bot;
    const item = { name: 'salmon', count: 1 } as never;
    await Promise.all([eatNow(bot, item), eatNow(bot, item)]);
    expect(consumes).toBe(1);
    // Once it is over, the next is a bite of its own.
    await eatNow(bot, item);
    expect(consumes).toBe(2);
  });
});

describe('skill runner postconditions (§4.6)', () => {
  const deps = (bot: Bot, signal = new AbortController().signal) => ({
    bot,
    logger: nullLogger(),
    rng: new SeededRandom(1),
    signal,
    movements: () => {
      throw new Error('no movements in unit tests');
    },
    knowsRecipe: () => true,
    say: async () => undefined,
    slipChance: 0,
  });

  it('flags a mismatch when the skill claims success but the inventory disagrees', async () => {
    const liar = defineSkill({
      name: 'liar',
      description: 'claims logs',
      argsSchema: z.object({}),
      talkOverable: false,
      slipKinds: [],
      expect: () => ({ kind: 'inventoryGain', item: 'oak_log', atLeast: 2 }),
      run: async () => ({ ok: true, observed: 'got logs' }),
    });
    const r = await runSkill(liar, {}, deps(fakeBody()));
    expect(r.ok).toBe(false);
    expect(r.mismatch).toBe(true);
    expect(r.expected).toBe('+2 oak_log');
    expect(r.error).toMatch(/expected \+2 oak_log/);
  });

  it('passes when the world agrees', async () => {
    const bot = fakeBody();
    const honest = defineSkill({
      name: 'honest',
      description: 'really gets logs',
      argsSchema: z.object({}),
      talkOverable: false,
      slipKinds: [],
      expect: () => ({ kind: 'inventoryGain', item: 'log', atLeast: 2 }),
      run: async () => {
        (bot as unknown as { __items: unknown[] }).__items.push({ name: 'birch_log', count: 3, type: 1, slot: 9 });
        return { ok: true, observed: 'chopped' };
      },
    });
    const r = await runSkill(honest, {}, deps(bot));
    expect(r.ok).toBe(true);
    expect(r.observed).toContain('+3 log');
  });

  it('reports aborts and bad args without throwing', async () => {
    const ac = new AbortController();
    const slow = defineSkill({
      name: 'slow',
      description: 'waits',
      argsSchema: z.object({ n: z.number() }),
      talkOverable: true,
      slipKinds: [],
      expect: () => ({ kind: 'none' }),
      run: async () => {
        ac.abort('danger');
        throw new SkillAbortedError('danger');
      },
    });
    const bad = await runSkill(slow, { n: 'x' }, deps(fakeBody(), ac.signal));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/bad arguments/);
    const r = await runSkill(slow, { n: 1 }, deps(fakeBody(), ac.signal));
    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('describes expectations readably', () => {
    expect(describeExpectation({ kind: 'near', pos: new Vec3(1, 2, 3), within: 2 })).toBe('within 2 of 1,2,3');
    const bot = fakeBody();
    const snap = { inventory: new Map([['bread', 1]]), pos: new Vec3(0, 0, 0), food: 10, health: 20, ts: 0 };
    expect(checkExpectation(bot, { kind: 'foodAbove', value: 10 }, snap, { ...snap, food: 15 }).ok).toBe(true);
  });
});

describe('fight-or-flight odds (§4.5, §21.3)', () => {
  const zombie = { name: 'zombie' };
  const leather = armorPoints(['leather_helmet', 'leather_chestplate']);
  const odds = (n: number, weapon: string | null, combat = 0.5, difficulty: 'easy' | 'normal' | 'hard' = 'hard') =>
    expectedFightDamage({ threats: Array.from({ length: n }, () => zombie), weapon, armor: leather, combat, difficulty });

  it('reads gear the way vanilla counts it', () => {
    expect(leather).toBe(4);
    expect(armorPoints(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'])).toBe(15);
    expect(armorPoints(['diamond_chestplate', 'netherite_chestplate', 'netherite_chestplate'])).toBe(20);
    expect(weaponStats('stone_sword')).toEqual({ dmg: 5, speed: 1.6 });
    expect(weaponStats(null)).toEqual({ dmg: 1, speed: 4 });
    expect(asDifficulty('hard')).toBe('hard');
    expect(asDifficulty(3)).toBe('normal');
  });

  it('one zombie with a sword is a fight; a crowd or bare hands is a run', () => {
    // Budget at full health for caution 0.3: (20 − 8.4) × 1.12 ≈ 13.
    expect(odds(1, 'stone_sword')).toBeLessThan(5);
    expect(odds(3, 'stone_sword')).toBeGreaterThan(20);
    expect(odds(1, null)).toBeGreaterThan(13);
    expect(odds(2, 'stone_sword')).toBeGreaterThan(odds(2, 'diamond_sword'));
  });

  it('skill, difficulty and a wounded enemy all lower the cost', () => {
    expect(odds(2, 'stone_sword', 0.9)).toBeLessThan(odds(2, 'stone_sword', 0.1));
    expect(odds(2, 'stone_sword', 0.5, 'easy')).toBeLessThan(odds(2, 'stone_sword', 0.5, 'hard'));
    const wounded = expectedFightDamage({ threats: [{ name: 'zombie', hp: 4 }, zombie], weapon: 'stone_sword', armor: 4, combat: 0.5, difficulty: 'hard' });
    expect(wounded).toBeLessThan(odds(2, 'stone_sword'));
  });
});

describe('attack attribution (§17.6)', () => {
  function fakeWorld() {
    const em = new EventEmitter();
    const entities: Record<number, unknown> = {};
    const bot = Object.assign(em, { entities, entity: { id: 0, position: new Vec3(0, 64, 0) } }) as unknown as Bot;
    return { bot, entities, em };
  }

  it('blames the nearest player who swung toward the victim within 400 ms', () => {
    const { bot, entities, em } = fakeWorld();
    let now = 1000;
    const tracker = new SwingTracker(bot, () => now);
    const victim = { id: 1, type: 'player', username: 'Pip', position: new Vec3(0, 64, 0), yaw: 0 };
    // Bram stands at +z facing -z (yaw 0 faces -z), i.e. toward the victim.
    const bram = { id: 2, type: 'player', username: 'Bram', position: new Vec3(0, 64, 2), yaw: 0 };
    const lira = { id: 3, type: 'player', username: 'Lira', position: new Vec3(3, 64, 0), yaw: Math.PI / 2 };
    Object.assign(entities, { 1: victim, 2: bram, 3: lira });
    em.emit('entitySwingArm', bram);
    now += 200;
    expect(tracker.attackerOf(victim as never).attacker).toBe(bram);
    now += 500;
    expect(tracker.attackerOf(victim as never).attacker).toBeNull();
  });

  it('waits a moment for a swing that arrives just after the hurt it caused (as 26.1 sends them)', async () => {
    const { bot, entities, em } = fakeWorld();
    const tracker = new SwingTracker(bot);
    const victim = { id: 1, type: 'player', username: 'Pip', position: new Vec3(0, 64, 0), yaw: 0 };
    const bram = { id: 2, type: 'player', username: 'Bram', position: new Vec3(0, 64, 2), yaw: 0 };
    Object.assign(entities, { 1: victim, 2: bram });
    // The hurt first: nobody has swung yet.
    expect(tracker.attackerOf(victim as never).attacker).toBeNull();
    const got = new Promise((r) => tracker.attribute(victim as never, (a) => r(a.attacker)));
    setTimeout(() => em.emit('entitySwingArm', bram), 5);
    expect(await got).toBe(bram);
    // A swing long after the hurt is not that blow's.
    const late = new Promise((r) => tracker.attribute(victim as never, (a) => r(a.attacker)));
    await new Promise((r) => setTimeout(r, 450));
    const t0 = Date.now();
    const later = new Promise((r) => tracker.attribute(victim as never, (a) => r(a.attacker)));
    setTimeout(() => em.emit('entitySwingArm', bram), 400);
    expect(await later).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
    void late;
  });

  it("the server's word on a hurt goes first: a fall is nobody's blow, whoever was swinging nearby (two chopping one tree fought over a drop)", async () => {
    const { bot, entities, em } = fakeWorld();
    const client = new EventEmitter();
    Object.assign(bot, { _client: client });
    const tracker = new SwingTracker(bot);
    const victim = { id: 1, type: 'player', username: 'Pip', position: new Vec3(0, 64, 0), yaw: 0 };
    const bram = { id: 2, type: 'player', username: 'Bram', position: new Vec3(0, 64, 2), yaw: 0 };
    const skeleton = { id: 7, type: 'hostile', name: 'skeleton', position: new Vec3(0, 64, 12), yaw: 0 };
    Object.assign(entities, { 1: victim, 2: bram, 7: skeleton });
    // Bram swings at the log by Pip, facing Pip; the hurt is a fall: no one caused it.
    em.emit('entitySwingArm', bram);
    client.emit('damage_event', { entityId: 1, sourceCauseId: 0, sourceDirectId: 0 });
    const fall = await new Promise((r) => tracker.attribute(victim as never, (a) => r(a)));
    expect(fall).toEqual({ attacker: null, kind: 'unknown' });
    // The word coming just after the health it took: waited for.
    const late = new Promise((r) => tracker.attribute(victim as never, (a) => r(a)));
    setTimeout(() => client.emit('damage_event', { entityId: 1, sourceCauseId: 3, sourceDirectId: 3 }), 20);
    expect(await late).toEqual({ attacker: bram, kind: 'melee' });
    // An arrow: the skeleton caused it, the arrow dealt it.
    client.emit('damage_event', { entityId: 1, sourceCauseId: 8, sourceDirectId: 41 });
    const shot = await new Promise((r) => tracker.attribute(victim as never, (a) => r(a)));
    expect(shot).toEqual({ attacker: skeleton, kind: 'ranged' });
  });

  it('falls back to a melee mob within 3 blocks', () => {
    const { bot, entities } = fakeWorld();
    const tracker = new SwingTracker(bot, () => 0);
    const victim = { id: 1, type: 'player', username: 'Pip', position: new Vec3(0, 64, 0), yaw: 0 };
    const zombie = { id: 9, type: 'hostile', name: 'zombie', position: new Vec3(1.5, 64, 0), yaw: 0 };
    Object.assign(entities, { 1: victim, 9: zombie });
    expect(tracker.attackerOf(victim as never)).toEqual({ attacker: zombie, kind: 'mob' });
  });
});

describe('fight or flight with archers (§4.5)', () => {
  function rig(weapon: string | null) {
    const archer = { id: 7, type: 'hostile', name: 'skeleton', position: new Vec3(8, 64, 0), height: 1.99 };
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 0, position: new Vec3(0, 64, 0), height: 1.8 },
      entities: { 7: archer },
      health: 20,
      game: { difficulty: 'hard' },
      inventory: { items: () => (weapon ? [{ name: weapon, count: 1 }] : []), slots: [] },
      blockAt: () => ({ name: 'grass_block' }),
      // A wall along z = 3: lines from the archer to anywhere past it are blocked.
      world: { raycast: (from: Vec3, dir: Vec3, range: number) => (from.z + dir.z * range > 3 ? { position: new Vec3(0, 64, 3) } : null) },
    });
    const hooks = { caution: () => 0.5, quirks: () => [], combat: () => 0.5, mayFightBack: () => true };
    const r = new ReflexController(bot as unknown as Bot, hooks as never, nullLogger());
    return { r: r as unknown as { shouldFlee(t: unknown[]): boolean; fleeSpot(t: unknown[]): Vec3 | null }, archer };
  }

  it('armed and well, closes in on a skeleton rather than running across open ground', () => {
    expect(rig('stone_sword').r.shouldFlee([rig('stone_sword').archer])).toBe(false);
  });

  it('a drowned with a trident is a threat from afar, and one runs from it (after it is into the water)', () => {
    const { r, archer } = rig('stone_sword');
    const drowned = { id: 9, type: 'hostile', name: 'drowned', position: new Vec3(-12, 64, 0), height: 1.95, equipment: [{ name: 'trident' }] };
    const plain = { ...drowned, id: 10, equipment: [] };
    expect(shoots(drowned as never)).toBe(true);
    expect(shoots(plain as never)).toBe(false);
    expect(shoots(archer as never)).toBe(true);
    const rr = r as unknown as { shouldFlee(t: unknown[]): boolean; threats(radius?: number): { id: number }[] };
    expect(rr.shouldFlee([drowned])).toBe(true);
    // A skeleton 8 blocks off that can see us is a threat now (arm's length was 6).
    expect(rr.threats().map((t) => t.id)).toContain(7);
  });

  it('running from one, makes for a spot out of its line of fire', () => {
    const { r, archer } = rig(null);
    const spot = r.fleeSpot([archer]);
    expect(spot).not.toBeNull();
    expect(spot?.z).toBeGreaterThan(3);
    expect(spot?.distanceTo(archer.position)).toBeGreaterThanOrEqual(6);
  });
});

describe('fighting back a person (§17.6)', () => {
  it('reckons the blows that land, stops once one more could kill, and fights on if they come back for more', () => {
    const bot = Object.assign(new EventEmitter(), { entity: { id: 0, position: new Vec3(0, 64, 0), height: 1.8 }, entities: {}, health: 20, heldItem: { name: 'iron_sword' } });
    const hooks = { caution: () => 0.5, quirks: () => [], combat: () => 0.5, mayFightBack: () => true };
    const r = new ReflexController(bot as unknown as Bot, hooks as never, nullLogger()) as unknown as {
      reckon(e: unknown): void;
      beatenFoe(e: unknown): boolean;
      dealt: Map<number, { calledOffAt?: number }>;
    };
    const bo = { id: 5, type: 'player', username: 'Bo', position: new Vec3(2, 64, 0), equipment: [] };
    // An iron sword: 6 a blow. One landed: a crit more (9) would still leave them standing.
    r.reckon(bo);
    expect(r.beatenFoe(bo)).toBe(false);
    // Two: one more, a critical one, could finish them.
    r.reckon(bo);
    expect(r.beatenFoe(bo)).toBe(true);
    // Called off, and they came back for more: we fight on.
    const d = r.dealt.get(5);
    if (d) d.calledOffAt = Date.now();
    expect(r.beatenFoe(bo)).toBe(false);
    // Armor they visibly wear softens the reckoning.
    const ann = { id: 6, type: 'player', username: 'Ann', position: new Vec3(2, 64, 0), equipment: [null, null, { name: 'iron_boots' }, { name: 'iron_leggings' }, { name: 'iron_chestplate' }, { name: 'iron_helmet' }] };
    r.reckon(ann);
    r.reckon(ann);
    expect(r.beatenFoe(ann)).toBe(false);
  });
});

describe('water (§4.5): not drowning while the mind is busy deciding', () => {
  /** A bot in a lake: water from y 55 up to 62, the shore (grass at y 63) from x 10 on. */
  function lake(opts: { idle: boolean; oxygen?: number }) {
    const controls: Record<string, boolean> = {};
    const dangers: string[] = [];
    const cleared: string[] = [];
    const blockAt = (p: Vec3) => {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      if (x >= 10) return { name: y < 63 ? 'grass_block' : 'air', boundingBox: y < 63 ? 'block' : 'empty' };
      return { name: y < 55 ? 'sand' : y <= 62 ? 'water' : 'air', boundingBox: y < 55 ? 'block' : 'empty' };
    };
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 0, position: new Vec3(2, 56, 0), height: 1.8, onGround: false, isInWater: true, metadata: [] },
      entities: {},
      players: {},
      health: 20,
      food: 20,
      oxygenLevel: opts.oxygen ?? 20,
      inventory: { items: () => [], slots: [] },
      blockAt,
      setControlState: (k: string, v: boolean) => (controls[k] = v),
      clearControlStates: () => Object.keys(controls).forEach((k) => (controls[k] = false)),
      nearestEntity: () => null,
      pathfinder: { isMoving: (): boolean => false, setGoal: () => undefined, goto: (_g: { x: number; y: number; z: number }): Promise<void> => Promise.resolve() },
    });
    const hooks = {
      caution: () => 0.5,
      quirks: () => [],
      combat: () => 0.5,
      mayFightBack: () => true,
      deliberateFight: () => false,
      isIdle: () => opts.idle,
      between: () => false,
      onDanger: (d: { source: string }) => dangers.push(d.source),
      onDangerCleared: (s: string) => cleared.push(s),
    };
    const r = new ReflexController(bot as unknown as Bot, hooks as never, nullLogger());
    const tick = () => (r as unknown as { tick(): Promise<void> }).tick();
    return { r, bot, controls, dangers, cleared, tick };
  }

  it('with the head under water, swims up after a few seconds even when the air reading never drops', async () => {
    const { r, bot, controls, dangers, cleared, tick } = lake({ idle: false });
    await tick();
    expect(dangers).toEqual([]);
    // Six seconds under, the air reading still at 20 (as on 26.1, where it doesn't reach the bot).
    (r as unknown as { underSince: number }).underSince = Date.now() - 6500;
    await tick();
    expect(dangers).toEqual(['water']);
    expect(r.mode).toBe('swim');
    expect(controls.jump).toBe(true);
    // Head out of the water: the hazard is over.
    bot.entity.position = new Vec3(2, 62, 0);
    await tick();
    expect(cleared).toEqual(['out of danger']);
    expect(r.mode).toBe('idle');
  });

  it('a low air reading is a hazard at once', async () => {
    const { dangers, tick } = lake({ idle: false, oxygen: 5 });
    await tick();
    expect(dangers).toEqual(['water']);
  });

  it('idle in the water, treads water (holds jump); a skill moving the body takes over and it lets go', async () => {
    const idle = lake({ idle: true });
    idle.bot.entity.position = new Vec3(2, 61.5, 0);
    await idle.tick();
    expect(idle.controls.jump).toBe(true);
    expect(idle.dangers).toEqual([]);
    const busy = lake({ idle: true });
    busy.bot.entity.position = new Vec3(2, 61.5, 0);
    await busy.tick();
    busy.bot.pathfinder.isMoving = () => true;
    await busy.tick();
    expect(busy.controls.jump).toBe(false);
  });

  it('in the water a while with nothing to do, swims for the nearest shore (facing it, forward and jump held)', async () => {
    const { r, bot, controls, tick } = lake({ idle: true });
    bot.entity.position = new Vec3(4, 61.5, 0);
    const looked: Vec3[] = [];
    Object.assign(bot, { lookAt: (p: Vec3) => (looked.push(p), Promise.resolve()) });
    await tick();
    expect(looked).toEqual([]);
    expect(controls.forward).toBeUndefined();
    (r as unknown as { wetSince: number }).wetSince = Date.now() - 9000;
    await tick();
    expect(controls.forward).toBe(true);
    expect(controls.jump).toBe(true);
    expect(looked[0]?.x).toBeGreaterThanOrEqual(10);
    // Out of the water: it lets go.
    bot.entity.position = new Vec3(11, 63, 0);
    bot.entity.isInWater = false;
    await tick();
    expect(controls.forward).toBe(false);
    expect(controls.jump).toBe(false);
  });

  it('across a lake wider than the near search, still finds the far shore', async () => {
    const { r, bot, tick } = lake({ idle: true });
    bot.entity.position = new Vec3(-12, 61.5, 0);
    const looked: Vec3[] = [];
    Object.assign(bot, { lookAt: (p: Vec3) => (looked.push(p), Promise.resolve()) });
    (r as unknown as { wetSince: number }).wetSince = Date.now() - 9000;
    await tick();
    expect(looked[0]?.x).toBeGreaterThanOrEqual(10);
  });

  it('a walk is not aimed at the middle of a lake', () => {
    const { bot } = lake({ idle: true });
    expect(wetAt(bot as unknown as Bot, 4, 0, 63)).toBe(true);
    expect(wetAt(bot as unknown as Bot, 20, 0, 63)).toBe(false);
  });
});

describe('a stroll (wander): clear of those to keep away from, close to the one to keep by', () => {
  /** Flat dry ground at y 63; Rex standing at `rex`. The first walk's goal is recorded, then the stroll is called off. */
  async function firstWalk(rex: Vec3, args: Record<string, unknown>, seed = 1, home: Vec3 | null = null, at = new Vec3(0, 64, 0)) {
    const ac = new AbortController();
    const goals: { x: number; z: number }[] = [];
    const rexEntity = { id: 1, type: 'player', username: 'Rex', name: 'player', position: rex, height: 1.8 };
    const bot = {
      entity: { id: 0, position: at, height: 1.8 },
      entities: { 1: rexEntity },
      players: { Rex: { username: 'Rex', entity: rexEntity } },
      registry: { blocksArray: [] },
      blockAt: (p: Vec3) => (Math.floor(p.y) < 64 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
      findBlocks: () => [],
      nearestEntity: () => null,
      lookAt: () => Promise.resolve(),
      look: () => Promise.resolve(),
      clearControlStates: () => undefined,
      pathfinder: {
        setMovements: () => undefined,
        isMoving: () => false,
        setGoal: () => undefined,
        stop: () => undefined,
        goto: (g: { x: number; z: number }) => {
          goals.push({ x: g.x, z: g.z });
          ac.abort();
          return Promise.resolve();
        },
      },
    };
    const wander = getSkill('wander');
    const parsed = wander?.parseArgs(args);
    if (!wander || !parsed?.ok) throw new Error('wander args');
    const ctx = { bot: bot as unknown as Bot, signal: ac.signal, logger: nullLogger(), rng: new SeededRandom(seed), movements: () => ({}) as never, knowsRecipe: () => true, say: async () => undefined, slip: null, home, progress: () => undefined, planDepth: 2 };
    const r = await wander.run(ctx, parsed.args);
    expect(r.ok).toBe(true);
    return goals[0];
  }

  it('walks away from someone to keep clear of, when they are near', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = await firstWalk(new Vec3(6, 64, 0), { radius: 16, seconds: 30, avoid: ['Rex'] }, seed);
      expect(g?.x).toBeLessThan(0);
    }
  });

  /** A stroll with Rex at `rex`, its context given `extra` (whom it talks with, a fight seen): where it walked and looked. */
  async function pausedStroll(extra: Record<string, () => string | null>, rex = new Vec3(3, 64, 0)) {
    const ac = new AbortController();
    const walks: unknown[] = [];
    const looked: Vec3[] = [];
    const rexEntity = { id: 1, type: 'player', username: 'Rex', name: 'player', position: rex, height: 1.8 };
    const bot = {
      entity: { id: 0, position: new Vec3(0, 64, 0), height: 1.8 },
      entities: { 1: rexEntity },
      players: { Rex: { username: 'Rex', entity: rexEntity } },
      registry: { blocksArray: [] },
      blockAt: (p: Vec3) => (Math.floor(p.y) < 64 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
      findBlocks: () => [],
      nearestEntity: () => null,
      lookAt: (p: Vec3) => (looked.push(p), Promise.resolve()),
      look: () => Promise.resolve(),
      clearControlStates: () => undefined,
      pathfinder: { setMovements: () => undefined, isMoving: () => false, setGoal: () => undefined, stop: () => undefined, goto: (g: unknown) => (walks.push(g), Promise.resolve()) },
    };
    const wander = getSkill('wander');
    const parsed = wander?.parseArgs({ radius: 16, seconds: 30 });
    if (!wander || !parsed?.ok) throw new Error('wander args');
    setTimeout(() => ac.abort(), 2500);
    const ctx = { bot: bot as unknown as Bot, signal: ac.signal, logger: nullLogger(), rng: new SeededRandom(3), movements: () => ({}) as never, knowsRecipe: () => true, say: async () => undefined, slip: null, home: null, progress: () => undefined, planDepth: 2, ...extra };
    const r = await wander.run(ctx, parsed.args);
    return { r, walks, looked };
  }

  it('stops for a talk: stays put and faces whoever it is talking with', async () => {
    const { r, walks, looked } = await pausedStroll({ talkingWith: () => 'Rex' });
    expect(walks).toEqual([]);
    expect(looked.length).toBeGreaterThanOrEqual(1);
    expect(looked.every((p) => p.x === 3)).toBe(true);
    expect(r.observed).toMatch(/stopped to talk with Rex/);
  });

  it('stops to watch a fight in sight: stays put and faces the one fighting', async () => {
    const { r, walks, looked } = await pausedStroll({ fightNearby: () => 'Rex' }, new Vec3(20, 64, 0));
    expect(walks).toEqual([]);
    expect(looked.length).toBeGreaterThanOrEqual(1);
    expect(looked.every((p) => p.x === 20)).toBe(true);
    expect(r.observed).toMatch(/stopped to watch Rex fight/);
    // A fight out of sight is nothing to stop for.
    const far = await pausedStroll({ fightNearby: () => 'Rex' }, new Vec3(60, 64, 0));
    expect(far.walks.length).toBeGreaterThanOrEqual(1);
  });

  it('strolls about near the one it keeps by, wherever the stroll began', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = await firstWalk(new Vec3(30, 64, 10), { radius: 6, seconds: 30, near: 'Rex' }, seed);
      expect(Math.hypot((g?.x ?? 0) - 30, (g?.z ?? 0) - 10)).toBeLessThanOrEqual(7);
    }
  });
});

describe('a tool for the job (owner request, 2026-10-24)', () => {
  const bot = (names: [string, number][]) => ({ inventory: { items: () => names.map(([name, count]) => ({ name, count })), slots: [] } }) as unknown as Bot;

  it('finds the best tool of a kind carried, and makes stone when the cobblestone is there, wood otherwise', async () => {
    const { toolOf, toolToMake } = await import('@agora/agent/body/skills/tools');
    expect(toolOf(bot([['wooden_pickaxe', 1], ['iron_pickaxe', 1], ['stone_axe', 1]]), 'pickaxe')).toBe('iron_pickaxe');
    expect(toolOf(bot([['stone_axe', 1]]), 'sword')).toBeNull();
    expect(toolToMake(bot([['cobblestone', 3]]), 'pickaxe')).toBe('stone_pickaxe');
    expect(toolToMake(bot([['cobblestone', 2]]), 'pickaxe')).toBe('wooden_pickaxe');
    expect(toolToMake(bot([['cobblestone', 2]]), 'sword')).toBe('stone_sword');
    expect(toolToMake(bot([]), 'shovel')).toBe('wooden_shovel');
  });

  it('a tool being made makes no tool of its own (never in circles)', async () => {
    const { makeTool } = await import('@agora/agent/body/skills/tools');
    const notes: string[] = [];
    const ctx = { bot: bot([]), progress: (n: string) => void notes.push(n), logger: nullLogger(), toolDepth: 1 } as unknown as Parameters<typeof makeTool>[0];
    expect(await makeTool(ctx, 'wooden_pickaxe')).toBe(false);
    expect(notes).toEqual([]);
  });
});

describe('defending oneself from monsters (owner request, 2026-10-24)', () => {
  const rig = (weapon: string | null) => {
    // Open ground: nothing between us and anything.
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 0, position: new Vec3(0, 64, 0), height: 1.8 },
      entities: {},
      health: 20,
      game: { difficulty: 'normal' },
      registry: { entitiesByName: {} },
      inventory: { items: () => (weapon ? [{ name: weapon, count: 1 }] : []), slots: [] },
      world: { raycast: () => null },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    });
    const hooks = { caution: () => 0.5, quirks: () => [], combat: () => 0.5, mayFightBack: () => true };
    return new ReflexController(bot as unknown as Bot, hooks as never, nullLogger());
  };
  const zombie = { id: 3, type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0), height: 1.95 } as never;
  const person = { id: 4, type: 'player', username: 'Rex', name: 'player', position: new Vec3(3, 64, 0), height: 1.8 } as never;

  it('armed, one fights a monster on down to about three hearts; with a wooden weapon four; unarmed, or with a person among them, five', () => {
    expect(rig('stone_sword').fleeThreshold([zombie])).toBe(6);
    expect(rig('iron_axe').fleeThreshold([zombie])).toBe(6);
    expect(rig('wooden_sword').fleeThreshold([zombie])).toBe(8);
    expect(rig(null).fleeThreshold([zombie])).toBe(10);
    expect(rig('stone_sword').fleeThreshold([zombie, person])).toBe(10);
    expect(rig('stone_sword').fleeThreshold()).toBe(10);
  });

  it('one zombie is a fight; with two more in sight that would join in, it is a run', () => {
    const r = rig('stone_sword') as unknown as { bot: { entities: Record<number, unknown> }; shouldFlee(t: unknown[]): boolean };
    const near = { id: 3, type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0), height: 1.95 };
    r.bot.entities[3] = near;
    expect(r.shouldFlee([near])).toBe(false);
    r.bot.entities[11] = { ...near, id: 11, position: new Vec3(-12, 64, 4) };
    r.bot.entities[12] = { ...near, id: 12, position: new Vec3(10, 64, -9) };
    expect(r.shouldFlee([near])).toBe(true);
  });

  it('a fight is kept on record (whom, how long, health, weapon, swings and blows that landed) for a death to show', () => {
    const r = rig('stone_sword') as unknown as {
      bot: { pvp?: unknown; heldItem?: unknown; clearControlStates?: () => void; pathfinder?: unknown };
      hooks: Record<string, unknown>;
      fight(t: unknown, k: string): void;
      onSwing(): void;
      onEntityHurt(e: unknown): void;
      clear(s: string): void;
      fightRecord(): Record<string, unknown> | null;
    };
    const near = { id: 3, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0), height: 1.95 };
    Object.assign(r.bot, { pvp: { target: undefined, attack: () => undefined, forceStop: () => undefined }, pathfinder: { setGoal: () => undefined }, clearControlStates: () => undefined });
    Object.assign(r.hooks, { onDanger: () => undefined, onDangerCleared: () => undefined });
    expect(r.fightRecord()).toBeNull();
    r.fight(near, 'fight');
    r.onSwing();
    r.onSwing();
    r.onEntityHurt(near);
    expect(r.fightRecord()).toMatchObject({ foe: 'zombie', swings: 2, landed: 1, closest: 2, ended: 'under way' });
    r.clear('fight over');
    expect(r.fightRecord()).toMatchObject({ foe: 'zombie', swings: 2, landed: 1, ended: 'fight over', health: '20 to 20' });
  });

  it('an archer is closed in on; one that could not be got at lately is run from, out of its sight (one "fought" a skeleton 81 s, never nearer than 9 blocks)', () => {
    const r = rig('stone_sword') as unknown as { bot: { entities: Record<number, unknown> }; unreachable: Map<number, number>; shouldFlee(t: unknown[]): boolean };
    const skeleton = { id: 31, type: 'hostile', name: 'skeleton', position: new Vec3(9, 64, 0), height: 1.99, heldItem: { name: 'bow' } };
    r.bot.entities[31] = skeleton;
    expect(r.shouldFlee([skeleton])).toBe(false);
    r.unreachable.set(31, Date.now() + 30_000);
    expect(r.shouldFlee([skeleton])).toBe(true);
    r.unreachable.set(31, Date.now() - 1);
    expect(r.shouldFlee([skeleton])).toBe(false);
  });

  it('up on something, a zombie three blocks below is no threat; a spider, which climbs, still is', () => {
    const r = rig('stone_sword') as unknown as { bot: { entities: Record<number, unknown> }; threats(radius?: number): { id: number }[] };
    r.bot.entities[21] = { id: 21, type: 'hostile', name: 'zombie', position: new Vec3(1, 61, 0), height: 1.95 };
    r.bot.entities[22] = { id: 22, type: 'hostile', name: 'spider', position: new Vec3(-1, 61, 0), height: 0.9 };
    r.bot.entities[23] = { id: 23, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0), height: 1.95 };
    expect(r.threats().map((t) => t.id).sort()).toEqual([22, 23]);
  });

  it("running that isn't working turns into a fight: still caught, or going nowhere, with it close", () => {
    const r = rig('stone_sword') as unknown as { mode: string; fleeHits: number[]; fleeSince: number; fleeStillSince: number | null; cornered(now: number, t: unknown[]): boolean };
    const spider = { id: 5, type: 'hostile', name: 'spider', position: new Vec3(2, 64, 0), height: 0.9 };
    const far = { ...spider, id: 6, position: new Vec3(9, 64, 0) };
    r.mode = 'flee';
    const now = 100_000;
    // The blows of the moment one turns to run don't count: the run gets a fair start.
    r.fleeSince = now - 2000;
    r.fleeHits = [now - 1900, now - 1000];
    expect(r.cornered(now, [spider])).toBe(false);
    r.fleeSince = now - 8000;
    r.fleeHits = [now - 1000];
    expect(r.cornered(now, [spider])).toBe(false);
    r.fleeHits = [now - 4000, now - 1000];
    expect(r.cornered(now, [spider])).toBe(true);
    // Hit, but it has dropped back: running is working.
    expect(r.cornered(now, [far])).toBe(false);
    r.fleeHits = [];
    r.fleeStillSince = now - 2500;
    expect(r.cornered(now, [spider])).toBe(true);
  });

  it('a run that gets nowhere is going nowhere, the path "moving" or not (one jumped at a tree trunk four seconds with a zombie on her)', () => {
    const r = rig('stone_sword') as unknown as { bot: Record<string, unknown> & { entity: { position: Vec3 } }; mode: string; fleeStillSince: number | null; flee(t: unknown[]): void };
    const goals: unknown[] = [];
    Object.assign(r.bot, { time: { timeOfDay: 6000 }, pathfinder: { isMoving: () => true, setGoal: (g: unknown) => goals.push(g) } });
    r.mode = 'flee';
    const z = { id: 3, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0), height: 1.95 };
    let t = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => t);
    try {
      r.flee([z]);
      expect(r.fleeStillSince).toBeNull();
      // Jumping in place: the legs going, the body no farther on.
      t += 800;
      r.bot.entity.position = new Vec3(0.3, 64.8, 0.2);
      r.flee([z]);
      expect(r.fleeStillSince).toBeNull();
      t += 900;
      r.flee([z]);
      expect(r.fleeStillSince).toBe(t);
      // Going nowhere, the way is planned again at once.
      expect(goals.length).toBeGreaterThanOrEqual(2);
      // Off again: going somewhere.
      t += 500;
      r.bot.entity.position = new Vec3(-3, 64, 0);
      r.flee([z]);
      expect(r.fleeStillSince).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it('runs back the way it came, away from what chases it, never towards it', () => {
    const r = rig('stone_sword') as unknown as { trail: Vec3[]; trailSpot(t: unknown[]): Vec3 | null };
    // Came along x from -20 to 0; the spider is ahead, at x 3.
    r.trail = [-20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0].map((x) => new Vec3(x, 64, 0));
    const ahead = { id: 5, type: 'hostile', name: 'spider', position: new Vec3(3, 64, 0), height: 0.9 };
    const spot = r.trailSpot([ahead]);
    expect(spot?.x).toBeLessThanOrEqual(-6);
    // Coming from behind instead: the way back runs into it.
    const behind = { ...ahead, position: new Vec3(-5, 64, 0) };
    expect(r.trailSpot([behind])).toBeNull();
  });

  it('the way out keeps clear of every monster in sight, not only the one at hand (one ran from a creeper into another)', () => {
    const r = rig('stone_sword') as unknown as { bot: { entities: Record<number, unknown> }; trail: Vec3[]; trailSpot(t: unknown[]): Vec3 | null; inTheWay(t: unknown[]): { id: number }[] };
    r.trail = [-20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0].map((x) => new Vec3(x, 64, 0));
    const ahead = { id: 5, type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0), height: 1.95 };
    // A creeper on the trail, 12 blocks back: no threat yet, but in sight.
    const waiting = { id: 6, type: 'hostile', name: 'creeper', position: new Vec3(-12, 64, 1), height: 1.7 };
    const far = { id: 8, type: 'hostile', name: 'creeper', position: new Vec3(-40, 64, 0), height: 1.7 };
    Object.assign(r.bot.entities, { 5: ahead, 6: waiting, 8: far });
    const avoid = r.inTheWay([ahead]);
    expect(avoid.map((e) => e.id).sort()).toEqual([5, 6]);
    expect(r.trailSpot(avoid)).toBeNull();
    expect(r.trailSpot([ahead])?.x).toBeLessThanOrEqual(-6);
  });
});

describe('digging that the server refuses', () => {
  it("gives up once digging the block should long be done, and stops the dig, instead of waiting for ever", async () => {
    const { digBlock } = await import('@agora/agent/body/skills/util');
    let stopped = 0;
    // A dig the server never lets finish: the block never turns to air.
    const bot = { digTime: () => 50, dig: () => new Promise<void>(() => undefined), stopDigging: () => void stopped++ } as unknown as Bot;
    const block = { name: 'oak_leaves', position: new Vec3(0, 0, 0) } as never;
    const t0 = Date.now();
    await expect(digBlock({ bot, signal: new AbortController().signal }, block)).rejects.toThrow(/oak_leaves would not break/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5000);
    expect(stopped).toBe(1);
    // One that breaks is done.
    const ok = { digTime: () => 50, dig: () => Promise.resolve(), stopDigging: () => void stopped++ } as unknown as Bot;
    await expect(digBlock({ bot: ok, signal: new AbortController().signal }, block)).resolves.toBeUndefined();
    expect(stopped).toBe(1);
  }, 15_000);
});

describe('a pathfinder stuck on a dig that never ended', () => {
  it('is let go of the block, and walks again; one digging for real is left alone', async () => {
    const { releaseStuckDig } = await import('@agora/agent/body/skills/util');
    // The pathfinder's own bookkeeping, as mineflayer-pathfinder keeps it: a reset while digging waits for the dig's end.
    const bot = new EventEmitter() as EventEmitter & { targetDigBlock: unknown; pathfinder: { isMining(): boolean; setGoal(g: null): void } };
    let digging = true;
    bot.targetDigBlock = null;
    bot.pathfinder = {
      isMining: () => digging,
      setGoal: () => {
        if (digging) bot.once('diggingAborted', () => (digging = false));
      },
    };
    expect(releaseStuckDig(bot as unknown as Bot)).toBe(true);
    expect(digging).toBe(false);
    // A dig under way (mineflayer has hold of the block): not touched.
    digging = true;
    bot.targetDigBlock = { name: 'dirt' };
    expect(releaseStuckDig(bot as unknown as Bot)).toBe(false);
    expect(digging).toBe(true);
  });
});

describe('what the body did over an action (a model waiting at 1 health "learned" that waiting heals)', () => {
  const at = (health: number, food: number) => ({ inventory: new Map<string, number>(), pos: new Vec3(0, 64, 0), health, food, ts: 0 });
  it('health and food that changed are said; whole and unchanged, nothing', () => {
    expect(bodyNote(at(20, 20), at(20, 20), 120_000)).toBe('');
    expect(bodyNote(at(12, 18), at(8, 17), 5000)).toBe('health 12 to 8, food 18 to 17');
    expect(bodyNote(at(4, 19), at(9, 19), 40_000)).toBe('health 4 to 9');
  });
  it('a long while hurt with none of it back: said too; a moment, not', () => {
    expect(bodyNote(at(1, 10), at(1, 10), 120_000)).toBe('health still 1');
    expect(bodyNote(at(1, 10), at(1, 10), 3000)).toBe('');
  });
});

describe('what a torch can go on (torches set on leaves were refused, three times running)', () => {
  const block = (name: string, shapes: number[][] = [[0, 0, 0, 1, 1, 1]]) => ({ name, boundingBox: 'block', shapes });
  it('the face of a whole block holds it; leaves, a slab or air do not', async () => {
    const { sturdy } = await import('@agora/agent/body/world');
    expect(sturdy(block('stone') as never)).toBe(true);
    expect(sturdy(block('glass') as never)).toBe(true);
    expect(sturdy(block('oak_leaves') as never)).toBe(false);
    expect(sturdy(block('oak_slab', [[0, 0, 0, 1, 0.5, 1]]) as never)).toBe(false);
    expect(sturdy({ name: 'air', boundingBox: 'empty', shapes: [] } as never)).toBe(false);
  });
  it('a torch goes against stone beside it rather than the leaves under it; a block goes on the leaves', async () => {
    const { referenceFor } = await import('@agora/agent/body/skills/building');
    // Leaves under the spot, stone to the east, stone overhead.
    const at = (p: Vec3) => (p.y === 63 ? block('oak_leaves') : p.x === 1 && p.y === 64 ? block('stone') : p.y === 65 ? block('stone') : { name: 'air', boundingBox: 'empty', shapes: [] });
    const bot = { blockAt: (p: Vec3) => ({ ...at(p), position: p }) } as unknown as Bot;
    const spot = new Vec3(0, 64, 0);
    expect(referenceFor(bot, spot, 'torch')?.ref.name).toBe('stone');
    expect(Math.abs(referenceFor(bot, spot, 'torch')?.face.y ?? 1)).toBe(0);
    expect(referenceFor(bot, spot, 'dirt')?.ref.name).toBe('oak_leaves');
    // Leaves under and only the ceiling of stone: nothing for a torch (it can't hang), a lantern hangs from it.
    const roof = { blockAt: (p: Vec3) => ({ ...(p.y === 63 ? block('oak_leaves') : p.y === 65 ? block('stone') : { name: 'air', boundingBox: 'empty', shapes: [] }), position: p }) } as unknown as Bot;
    expect(referenceFor(roof, spot, 'torch')).toBeNull();
    expect(referenceFor(roof, spot, 'lantern')?.face.y).toBe(-1);
  });
});

describe('where a thing comes from is never what people made (one went to dig up the table its companion set down)', () => {
  it('a crafting table, planks or wool set down are no source; stone for cobblestone is', async () => {
    const { blockIdsDropping } = await import('@agora/agent/body/world');
    const items = { 1: { name: 'crafting_table' }, 2: { name: 'oak_planks' }, 3: { name: 'cobblestone' }, 4: { name: 'white_wool' }, 5: { name: 'oak_log' } };
    const blocksArray = [
      { id: 10, name: 'crafting_table', drops: [1] },
      { id: 11, name: 'oak_planks', drops: [2] },
      { id: 12, name: 'stone', drops: [3] },
      { id: 13, name: 'cobblestone', drops: [3] },
      { id: 14, name: 'white_wool', drops: [4] },
      { id: 15, name: 'oak_log', drops: [5] },
    ];
    const bot = { registry: { items, blocksArray } } as never;
    expect(blockIdsDropping(bot, itemMatcher('crafting_table'))).toEqual([]);
    expect(blockIdsDropping(bot, itemMatcher('oak_planks'))).toEqual([]);
    expect(blockIdsDropping(bot, itemMatcher('white_wool'))).toEqual([]);
    expect(blockIdsDropping(bot, itemMatcher('cobblestone'))).toEqual([12, 13]);
    expect(blockIdsDropping(bot, itemMatcher('oak_log'))).toEqual([15]);
  });
});

describe('under water with a roof over it (an agent drowned holding jump against the stone of a flooded tunnel)', () => {
  // Water two deep under a stone roof, but for an opening to the air five blocks east.
  const at = (p: Vec3) => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (y === 64 || y === 65) return { name: 'water', boundingBox: 'empty' };
    if (y === 66 && x < 5) return { name: 'stone', boundingBox: 'block' };
    if (y === 63) return { name: 'stone', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  const rig = (x: number) => {
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 0, position: new Vec3(x + 0.5, 64, 0.5), height: 1.8 },
      entities: {},
      health: 20,
      game: { difficulty: 'normal' },
      registry: { entitiesByName: {} },
      inventory: { items: () => [], slots: [] },
      blockAt: (p: Vec3) => ({ ...at(p), position: p.floored() }),
      world: { raycast: () => null },
    });
    const hooks = { caution: () => 0.5, quirks: () => [], combat: () => 0.5, mayFightBack: () => true };
    return new ReflexController(bot as unknown as Bot, hooks as never, nullLogger()) as unknown as { roofedWater(): boolean; airSpot(r?: number): Vec3 | null };
  };
  it('knows the roof is there, and where the nearest air is', () => {
    const r = rig(0);
    expect(r.roofedWater()).toBe(true);
    const air = r.airSpot();
    expect(air?.x).toBe(5);
    expect(rig(6).roofedWater()).toBe(false);
  });
  it('air over the roof is no way out: the opening in it is', () => {
    // Above the stone is open air, but from under it only the opening east can be swum to.
    expect(rig(2).airSpot()?.toArray()).toEqual([5, 65, 0]);
  });
});

describe('the wear on a tool, as its durability bar shows it (an iron pickaxe broke halfway to the diamonds)', () => {
  it('the best of a kind (seven fresh pickaxes and one nearly gone are not eight spent), and a tool nearly worn out says so in the digest', async () => {
    const { inventoryStacks } = await import('@agora/agent/body/inventory');
    const items = [
      { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 230 },
      { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 10 },
      { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 100 },
      { name: 'cobblestone', count: 40 },
    ];
    const bot = { inventory: { items: () => items, slots: [] } } as never;
    const stacks = inventoryStacks(bot);
    expect(stacks.find((st) => st.item === 'iron_pickaxe')?.left).toBe(0.08);
    expect(stacks.find((st) => st.item === 'stone_pickaxe')?.left).toBe(0.92);
    expect(stacks.find((st) => st.item === 'cobblestone')?.left).toBeUndefined();
    expect(inventoryDigest(stacks)).toBe('40 cobblestone, 2 stone_pickaxe, iron_pickaxe (worn)');
  });
});

describe('hurt, a careful walk (one at 8 health fell to its death crossing a dripstone cave)', () => {
  it('no jumps over gaps at half health or less', async () => {
    const { carefulWhenHurt } = await import('@agora/agent/body/plugins');
    const m = { allowParkour: true };
    expect(carefulWhenHurt({ health: 20 } as never, m as never)).toMatchObject({ allowParkour: true });
    expect(carefulWhenHurt({ health: 8 } as never, m as never)).toMatchObject({ allowParkour: false });
    expect(carefulWhenHurt({ health: 15 } as never, m as never)).toMatchObject({ allowParkour: true });
  });
});

describe('an enderman (one, looked in the eye, killed the one who looked: one swing landed in 23 s)', () => {
  it('is never looked at, and is no fight for a stone sword', async () => {
    const { lookAway } = await import('@agora/agent/body/world');
    expect(lookAway({ name: 'enderman' })).toBe(true);
    expect(lookAway({ name: 'cow' })).toBe(false);
    const fight = (name: string) => expectedFightDamage({ threats: [{ name }], weapon: 'stone_sword', armor: 0, combat: 0.5, difficulty: 'easy' });
    // A zombie costs a few hearts; an enderman, who teleports out from under the blows, far more than a full bar.
    expect(fight('zombie')).toBeLessThan(5);
    expect(fight('enderman')).toBeGreaterThan(20);
  });
});
