import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SeededRandom, nullLogger } from '@agora/shared';
import type { Bot } from '@agora/agent/body/bot';
import { Vec3 } from '@agora/agent/body/bot';
import { ChatOut } from '@agora/agent/body/chatOut';
import { countIn, describeDiff, diffInventory, inventoryDigest } from '@agora/agent/body/inventory';
import { armorSlotOf, gearScore, itemMatcher, normalizeItemName, weaponTier } from '@agora/agent/body/items';
import { compileCondition, pathCostRules, reflexDelta } from '@agora/agent/body/quirks';
import { SKILLS, getSkill, skillCatalog } from '@agora/agent/body/skills/registry';
import { describeMissing } from '@agora/agent/body/skills/crafting';
import { checkExpectation, describeExpectation, runSkill } from '@agora/agent/body/skills/runner';
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
  });

  it('matches categories without false positives', () => {
    const log = itemMatcher('logs');
    expect(log.matches('oak_log')).toBe(true);
    expect(log.matches('crimson_stem')).toBe(true);
    expect(log.matches('stripped_oak_log')).toBe(false);
    expect(log.matches('oak_planks')).toBe(false);
    expect(itemMatcher('planks').matches('birch_planks')).toBe(true);
    expect(itemMatcher('oak_log').matches('birch_log')).toBe(false);
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
    for (const n of names) expect(catalog).toContain(n);
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
    expect(describeMissing([], [])).toBe('');
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
    const bot = Object.assign(new EventEmitter(), { entity: { id: 0, position: new Vec3(0, 64, 0), height: 1.8 }, entities: {}, health: 20, inventory: { items: () => (weapon ? [{ name: weapon, count: 1 }] : []), slots: [] } });
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
});
