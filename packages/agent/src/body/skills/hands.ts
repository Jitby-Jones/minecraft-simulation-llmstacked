// The hands a player has (owner request, 2026-10-24: agents act on what they know of the game, and no one codes them
// to do any particular thing). A player's hand does a few general things: right-click with what it holds on a
// creature or a block, hold out what an animal wants and walk, pick a field. What they are for is the mind's to know:
// shears on a sheep, wheat on two cows, a bucket on a cow or on water, seeds on farmland, bone meal on a crop, flint
// and steel on obsidian, a bone for a wolf. Each says plainly what came of it (what it gained, what changed), so the
// mind learns from what happens.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { describeDiff, diffInventory, markThrown, snapshotInventory } from '../inventory';
import { itemMatcher, normalizeBlockName, normalizeItemName } from '../items';
import { biting, canSee, canSeeBlock, roomAround } from '../world';
import { stopCollecting } from './gathering';
import { abortable, digBlock, errMsg, goals, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

/** What each animal follows, and breeds on (game knowledge for the hand that holds it out). */
export const TEMPTED_BY: Readonly<Record<string, readonly string[]>> = {
  cow: ['wheat'],
  mooshroom: ['wheat'],
  sheep: ['wheat'],
  goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  horse: ['golden_carrot', 'golden_apple'],
  donkey: ['golden_carrot', 'golden_apple'],
  llama: ['hay_block'],
  camel: ['cactus'],
  turtle: ['seagrass'],
  frog: ['slime_ball'],
  strider: ['warped_fungus'],
  sniffer: ['torchflower_seeds'],
  armadillo: ['spider_eye'],
  wolf: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton'],
  cat: ['cod', 'salmon'],
};

const SEED_OF: Readonly<Record<string, string>> = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', nether_wart: 'nether_wart' };
const RIPE_AGE: Readonly<Record<string, number>> = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3 };
const REACH = 3.5;
/** What a right-click sets on top of a block: seeds and what is planted like them. */
const SOWN = /(_seeds|^carrot|^potato|^nether_wart|_sapling|^sweet_berries|^cocoa_beans)$/;
const ENTITY_REACH = 2.6;

function heldOne(bot: Bot, raw: string): { name: string } | null {
  const n = normalizeItemName(raw);
  const items = bot.inventory.items();
  return items.find((i) => i.name === n) ?? items.find((i) => i.name === raw) ?? items.find((i) => i.name.endsWith(`_${n}`) || i.name.startsWith(`${n}_`)) ?? null;
}

async function hold(bot: Bot, raw: string): Promise<string | null> {
  const it = heldOne(bot, raw);
  if (!it) return null;
  const item = bot.inventory.items().find((i) => i.name === it.name);
  if (!item) return null;
  await bot.equip(item, 'hand');
  return it.name;
}

/** An entity type (or a player's name) the words name, or null. */
function entityKind(bot: Bot, raw: string): string | null {
  const n = raw.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
  if (bot.players[raw]) return raw;
  for (const c of [n, n.replace(/s$/, ''), n.replace(/es$/, ''), n === 'sheep' ? 'sheep' : '']) if (c && bot.registry.entitiesByName[c]) return c;
  return null;
}

/** Block names the words name ("farmland", "water", "oak logs", "grass"), or null. */
function blockKinds(bot: Bot, raw: string): string[] | null {
  const n = normalizeBlockName(raw);
  if (n === 'grass' || n === 'short_grass') return ['grass_block'];
  if (n === 'crop' || n === 'crops') return Object.keys(SEED_OF);
  if (bot.registry.blocksByName[n]) return [n];
  const family = bot.registry.blocksArray.filter((b) => b.name.endsWith(`_${n}`)).map((b) => b.name);
  return family.length > 0 ? family : null;
}

/** What can be seen of a creature's state: a sheep's wool, a baby, in love (hearts). */
function stateOf(bot: Bot, e: Entity): string {
  const keys = (bot.registry.entitiesByName[e.name ?? ''] as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys ?? [];
  const meta = (e.metadata as unknown[] | undefined) ?? [];
  const at = (k: string) => (keys.indexOf(k) >= 0 ? meta[keys.indexOf(k)] : undefined);
  return JSON.stringify([at('wool'), at('baby'), at('owneruuid')]);
}

/**
 * The way a player walks about a yard: round things and through gates, never digging down or building up (a dig
 * under a fence ends in a hole by the gate). A copy of the body's movements with that much changed.
 */
function onFoot(ctx: SkillContext): ReturnType<SkillContext['movements']> {
  const base = ctx.movements();
  const m = Object.assign(Object.create(Object.getPrototypeOf(base) as object) as typeof base, base);
  m.canDig = false;
  m.allow1by1towers = false;
  m.canOpenDoors = true;
  return m;
}

/** Walks on foot to within `range` of a place; a walk that gets nowhere is no error (the caller sees where it is). */
async function walkNear(ctx: SkillContext, pos: Vec3, range: number, ms: number): Promise<void> {
  const { bot } = ctx;
  bot.pathfinder.setMovements(onFoot(ctx));
  await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), ms), () => stopMotion(bot)).catch((err: unknown) => {
    if (err instanceof SkillAbortedError) throw err;
    stopMotion(bot);
  });
}

/** Walks to within reach of a creature (over a fence will do: a hand reaches across one). */
async function approachEntity(ctx: SkillContext, e: Entity): Promise<boolean> {
  const { bot } = ctx;
  for (let i = 0; i < 3 && bot.entities[e.id]; i++) {
    if (bot.entity.position.distanceTo(e.position) <= ENTITY_REACH) return true;
    bot.pathfinder.setMovements(onFoot(ctx));
    try {
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, ENTITY_REACH - 0.4)), 12_000), () => stopMotion(bot));
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      stopMotion(bot);
    }
  }
  return Boolean(bot.entities[e.id]) && bot.entity.position.distanceTo(e.position) <= ENTITY_REACH + 0.6;
}

/** Picks up what dropped around a spot (wool off a sheep, a crop); only items whose name passes `which`, if given. */
async function collectAround(ctx: SkillContext, where: Vec3, radius = 4, which?: (item: string) => boolean, tries = 5): Promise<void> {
  const { bot } = ctx;
  const named = (e: Entity) => !which || which((e as unknown as { getDroppedItem?: () => { name: string } | null }).getDroppedItem?.()?.name ?? '');
  for (let k = 0; k < tries; k++) {
    const drop = bot.nearestEntity((x) => x.name === 'item' && x.position.distanceTo(where) <= radius && named(x));
    if (!drop) return;
    bot.pathfinder.setMovements(onFoot(ctx));
    await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), 5000), () => stopMotion(bot)).catch((err: unknown) => {
      if (err instanceof SkillAbortedError) throw err;
      stopMotion(bot);
    });
    await waitMs(ctx, 250);
  }
}

// --- drop ----------------------------------------------------------------------------------------------------------

/**
 * Throws items out onto the ground, as a player does to make room: all of that item, or `qty`. What is thrown is left
 * where it lies (the pickup reflex would walk over and take it back). An agent with full pockets dug on, nothing
 * coming of it, and had no way to make room.
 */
export const drop = defineSkill({
  name: 'drop',
  description: "drop {item, qty?} — throw items out of your inventory onto the ground (all of that item if no qty), to make room or get rid of what you don't need",
  argsSchema: z.object({ item: z.string().min(1), qty: z.coerce.number().int().min(1).max(2304).optional() }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const m = itemMatcher(args.item);
    const types = new Map<number, { name: string; count: number }>();
    for (const i of bot.inventory.items()) {
      if (!m.matches(i.name)) continue;
      const t = types.get(i.type) ?? { name: i.name, count: 0 };
      t.count += i.count;
      types.set(i.type, t);
    }
    if (types.size === 0) return { ok: false, observed: `no ${m.label} carried`, error: `no ${m.label} in inventory` };
    // Thrown away from oneself, out into the open, a little up so it carries, as a player throws what they don't want:
    // tossed where one was looking (down, as often as not), the stack lay at one's feet, and two seconds on the game
    // gave it back (one dropped the same 94 granite four times in five minutes).
    const way = openWay(bot);
    stopMotion(bot);
    await bot.look(way.yaw, 0.35, true);
    const before = new Set(Object.values(bot.entities).filter((e) => e.name === 'item').map((e) => e.id));
    let left = args.qty ?? Infinity;
    const out: string[] = [];
    for (const [type, t] of types) {
      if (left <= 0) break;
      throwIfAborted(ctx.signal);
      const n = Math.min(t.count, left);
      await bot.toss(type, null, n);
      out.push(`${n} ${t.name}`);
      left -= n;
    }
    await waitMs(ctx, 900);
    const me = bot.entity.position;
    const thrown = Object.values(bot.entities).filter((e) => e.name === 'item' && !before.has(e.id) && e.position.distanceTo(me) < 8);
    markThrown(bot, thrown.map((e) => e.id));
    const far = thrown.length > 0 ? Math.min(...thrown.map((e) => Math.hypot(e.position.x - me.x, e.position.z - me.z))) : 0;
    // Where it lies, and what the game does with it: walked over, it comes back into one's pockets.
    const lies = far >= 1.5 ? `, ${Math.round(far)} m ${way.name} of you` : ', at your feet (nowhere open to throw it)';
    return { ok: true, observed: `dropped ${out.join(', ')}${lies}; walk over it and it is picked up again; left there, it is gone in 5 minutes` };
  },
});

/** The way out from where one stands with the most open room at eye level, up to four blocks: where a thing thrown carries. */
function openWay(bot: Bot): { yaw: number; name: string } {
  const feet = bot.entity.position.floored();
  const WAYS: [string, number, number][] = [
    ['north', 0, -1],
    ['north-east', 1, -1],
    ['east', 1, 0],
    ['south-east', 1, 1],
    ['south', 0, 1],
    ['south-west', -1, 1],
    ['west', -1, 0],
    ['north-west', -1, -1],
  ];
  let best = { yaw: bot.entity.yaw, name: 'in front', room: -1 };
  for (const [name, dx, dz] of WAYS) {
    let room = 0;
    for (let i = 1; i <= 4; i++) {
      const head = bot.blockAt(feet.offset(dx * i, 1, dz * i));
      if (!head || head.boundingBox !== 'empty') break;
      room++;
    }
    // mineflayer's yaw: 0 faces north (-z), and it turns toward the west as it grows.
    if (room > best.room) best = { yaw: Math.atan2(-dx, -dz), name, room };
  }
  return { yaw: best.yaw, name: best.name };
}

// --- use -----------------------------------------------------------------------------------------------------------

/** What a click changed in a block: another block ("dirt became farmland"), or the same one opened, lit, filled. */
function changed(was: Block, now: Block): string {
  const name = (b: Block) => b.name.replace(/_/g, ' ');
  if (now.name !== was.name) return `${name(was)} became ${name(now)}`;
  const a = was.getProperties() as Record<string, unknown>;
  const b = now.getProperties() as Record<string, unknown>;
  if (a.open !== b.open && b.open !== undefined) return `the ${name(now)} ${b.open === true || b.open === 'true' ? 'opened' : 'shut'}`;
  if (a.lit !== b.lit && b.lit !== undefined) return `the ${name(now)} ${b.lit === true || b.lit === 'true' ? 'lit' : 'went out'}`;
  const props = Object.keys(b).filter((k) => String(a[k]) !== String(b[k]));
  return props.length > 0 ? `the ${name(now)}: ${props.map((k) => `${k} ${String(a[k])} to ${String(b[k])}`).join(', ')}` : `the ${name(now)} changed`;
}

export const use = defineSkill({
  name: 'use',
  description:
    'use {item?, on, times?, x?,y?,z?} — right-click with an item (or what you hold) on a creature or a block, as a player does: shears on a sheep, wheat on a cow, a bucket on a cow or on water, seeds or bone meal on farmland or a crop, a hoe on dirt, flint and steel on obsidian, a door or a gate to open it, a fishing rod on water (cast, and pulled in when a fish bites); on: what (a creature or block name; with x,y,z that block); times: that many of them, nearest first',
  argsSchema: z.object({
    item: z.string().min(1).optional(),
    on: z.string().min(1),
    times: z.coerce.number().int().min(1).max(32).default(1),
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
    z: z.coerce.number().optional(),
  }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const before = snapshotInventory(bot);
    if (args.item && !heldOne(bot, args.item)) return { ok: false, observed: `no ${args.item} on you`, error: `you have no ${normalizeItemName(args.item)}` };
    await stopCollecting(bot);
    const at = [args.x, args.y, args.z].every((n) => typeof n === 'number' && Number.isFinite(n)) ? new Vec3(Math.floor(args.x as number), Math.floor(args.y as number), Math.floor(args.z as number)) : null;
    // A rod on water: cast, and pull in when a fish bites, as a player fishes.
    const rod = args.item ? normalizeItemName(args.item) === 'fishing_rod' : bot.heldItem?.name === 'fishing_rod';
    if (rod && normalizeBlockName(args.on) === 'water') return await fish(ctx, args.times, at);
    const kind = at ? null : entityKind(bot, args.on);
    const changes: string[] = [];
    let done = 0;
    try {
      if (kind) {
        const used = new Set<number>();
        for (let i = 0; i < args.times; i++) {
          throwIfAborted(ctx.signal);
          const e = bot.nearestEntity((x) => x !== bot.entity && (x.name === kind || x.username === kind) && !used.has(x.id) && x.position.distanceTo(bot.entity.position) <= 32 && canSee(bot, x, 33));
          if (!e) break;
          used.add(e.id);
          if (!(await approachEntity(ctx, e))) continue;
          if (args.item) await hold(bot, args.item);
          const was = stateOf(bot, e);
          const where = e.position.clone();
          await bot.lookAt(e.position.offset(0, (e.height ?? 1) * 0.6, 0), true);
          await bot.activateEntity(e);
          await waitMs(ctx, 450);
          done++;
          if (bot.entities[e.id] && stateOf(bot, e) !== was) changes.push(`the ${kind.replace(/_/g, ' ')} changed`);
          // What came off it (wool off a sheep) is picked up.
          await waitMs(ctx, 300);
          await collectAround(ctx, where);
        }
        if (done === 0) return { ok: false, observed: `no ${kind.replace(/_/g, ' ')} in reach`, error: `no ${kind.replace(/_/g, ' ')} in sight to use it on` };
      } else {
        const names = at ? [bot.blockAt(at)?.name ?? ''] : blockKinds(bot, args.on);
        // What the hands take: a block or a creature by name, or x,y,z. Asked to use a door "on doorway", one was told
        // only that it didn't know what that was, the doorway's spot given it a moment before.
        if (!names || names[0] === '') return { ok: false, observed: 'nothing to use it on', error: `"${args.on}" is no block or creature you can name (give x,y,z for a spot); a door, a block or a torch is set down with place {block, x,y,z}` };
        const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined);
        const used = new Set<string>();
        for (let i = 0; i < args.times; i++) {
          throwIfAborted(ctx.signal);
          // What goes in on top (a seed, a sapling, a block) goes where the top is free: seeds on farmland already sown
          // came to nothing four times over.
          const onTop = Boolean(args.item && SOWN.test(normalizeItemName(args.item)));
          const target = at ? bot.blockAt(at) : pickBlock(bot, ids, used, onTop);
          if (!target) break;
          used.add(target.position.toString());
          await walkNear(ctx, target.position, REACH - 0.8, 30_000);
          if (bot.entity.position.distanceTo(target.position.offset(0.5, 0.5, 0.5)) > REACH + 1.5) continue;
          if (args.item) await hold(bot, args.item);
          const was = bot.blockAt(target.position)?.stateId;
          const above = bot.blockAt(target.position.offset(0, 1, 0))?.stateId;
          await useOnBlock(bot, target);
          await waitMs(ctx, 400);
          done++;
          const now = bot.blockAt(target.position);
          const nowAbove = bot.blockAt(target.position.offset(0, 1, 0));
          // A door: which side of it one is on, as one sees (one shut its hut's door from outside and waited there).
          if (now && now.stateId !== was) changes.push(`${changed(target, now)}${/_door$/.test(now.name) ? `, with you ${roomAround(bot) ? 'inside' : 'outside'}` : ''}`);
          else if (nowAbove && nowAbove.stateId !== above) changes.push(`${nowAbove.name.replace(/_/g, ' ')} on the ${target.name.replace(/_/g, ' ')}`);
          if (at) break;
        }
        if (done === 0) return { ok: false, observed: `no ${names[0]?.replace(/_/g, ' ')} in reach`, error: `no ${args.on} in sight to use it on` };
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `used it ${done} time(s)`, error: errMsg(err) };
    }
    const diff = diffInventory(before, snapshotInventory(bot));
    const what = [...new Set(changes)].slice(0, 3);
    const happened = diff.size > 0 || what.length > 0;
    const used = args.item ? (heldOne(bot, args.item)?.name ?? args.item) : 'my hand';
    // (The runner adds what changed in the inventory.)
    const observed = `used ${used} on ${done} ${args.on}${what.length > 0 ? `: ${what.join('; ')}` : ''}`;
    return happened ? { ok: true, observed } : { ok: false, observed, error: 'nothing came of it' };
  },
});

/** The longest a cast is left out for a bite (one comes within half a minute, as a rule). */
const BITE_MS = 45_000;

/** Water to cast onto: in sight, open to the sky over it, the nearest first (null: none). */
function openWater(bot: Bot): Block | null {
  const id = bot.registry.blocksByName.water?.id;
  if (id === undefined) return null;
  for (const p of bot.findBlocks({ matching: id, maxDistance: 16, count: 96 })) {
    const above = bot.blockAt(p.offset(0, 1, 0));
    if (!above || above.boundingBox !== 'empty' || above.name === 'water') continue;
    if (bot.entity.position.distanceTo(p) < 2 || !canSeeBlock(bot, p, 17)) continue;
    const b = bot.blockAt(p);
    if (b) return b;
  }
  return null;
}

/** Our line's bobber, out on the water (null: none out). */
function bobberOut(bot: Bot, not: ReadonlySet<number> = new Set()): Entity | null {
  return Object.values(bot.entities).find((e) => e.name === 'fishing_bobber' && !not.has(e.id) && e.position.distanceTo(bot.entity.position) < 32) ?? null;
}

/**
 * Fishing, as a player does it: from the bank, the rod in hand, cast onto the water; when the float is pulled under,
 * pull in, and the catch flies to one. `times` casts; a cast with no bite in 45 s is pulled in empty.
 */
async function fish(ctx: SkillContext, times: number, at: Vec3 | null): Promise<{ ok: boolean; observed: string; error?: string }> {
  const { bot } = ctx;
  if (!heldOne(bot, 'fishing_rod')) return { ok: false, observed: 'no fishing rod on you', error: 'you have no fishing_rod (3 sticks and 2 string make one)' };
  const water = at ? bot.blockAt(at) : openWater(bot);
  if (water?.name !== 'water') return { ok: false, observed: 'no water to fish in', error: 'no open water in sight to cast onto' };
  if (bot.entity.position.distanceTo(water.position) > 6) await walkNear(ctx, water.position, 4, 30_000);
  const before = snapshotInventory(bot);
  let casts = 0;
  let bites = 0;
  try {
    for (let i = 0; i < times; i++) {
      throwIfAborted(ctx.signal);
      await hold(bot, 'fishing_rod');
      const old = bobberOut(bot);
      if (old) {
        bot.activateItem();
        await waitMs(ctx, 400);
      }
      const had = new Set(Object.values(bot.entities).filter((e) => e.name === 'fishing_bobber').map((e) => e.id));
      await bot.lookAt(water.position.offset(0.5, 1.2, 0.5), true);
      bot.activateItem();
      casts++;
      let bobber: Entity | null = null;
      for (let k = 0; k < 20 && !bobber; k++) {
        await waitMs(ctx, 100);
        bobber = bobberOut(bot, had);
      }
      if (!bobber) continue;
      const end = Date.now() + BITE_MS;
      let bit = false;
      while (!bit && Date.now() < end && bot.entities[bobber.id]) {
        await waitMs(ctx, 50);
        bit = biting(bot, bobber);
      }
      // Pulled in: on a bite the catch flies to us; otherwise only the line comes back.
      if (bot.entities[bobber.id]) bot.activateItem();
      if (bit) bites++;
      await waitMs(ctx, bit ? 1500 : 400);
    }
  } catch (err) {
    // Stopped with the line out: it is pulled in.
    if (bobberOut(bot) && bot.heldItem?.name === 'fishing_rod') bot.activateItem();
    if (err instanceof SkillAbortedError) throw err;
    return { ok: false, observed: `cast ${casts} time(s)`, error: errMsg(err) };
  }
  const caught = [...diffInventory(before, snapshotInventory(bot)).values()].filter((n) => n > 0).length > 0;
  const observed = `cast ${casts} time(s), ${bites === 0 ? 'no bite' : `${bites} bite(s)`}`;
  if (caught) return { ok: true, observed };
  return { ok: false, observed, error: casts === 0 ? 'could not cast' : bites === 0 ? `no fish bit in ${Math.round(BITE_MS / 1000)} s a cast` : 'pulled in, but nothing came' };
}

/** The nearest block of these kinds in sight and reach of a walk, not used yet this run. */
function pickBlock(bot: Bot, ids: readonly number[], used: ReadonlySet<string>, freeTop = false): Block | null {
  for (const p of bot.findBlocks({ matching: [...ids], maxDistance: 24, count: 64 })) {
    if (used.has(p.toString())) continue;
    if (freeTop && bot.blockAt(p.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
    if (freeTop && /^(wheat|carrots|potatoes|beetroots|nether_wart|torchflower_crop|pitcher_crop|melon_stem|pumpkin_stem)$/.test(bot.blockAt(p.offset(0, 1, 0))?.name ?? '')) continue;
    if (!canSeeBlock(bot, p, 25)) continue;
    const b = bot.blockAt(p);
    if (b) return b;
  }
  return null;
}

/** A right-click on a block: on its top face, or on a liquid's surface with what is held (a bucket). */
async function useOnBlock(bot: Bot, b: Block): Promise<void> {
  if (b.name === 'water' || b.name === 'lava' || b.name === 'powder_snow') {
    await bot.lookAt(b.position.offset(0.5, 0.8, 0.5), true);
    bot.activateItem();
    await bot.waitForTicks(2);
    bot.deactivateItem();
    return;
  }
  await bot.lookAt(b.position.offset(0.5, 1, 0.5), true);
  await bot.activateBlock(b, new Vec3(0, 1, 0));
}

// --- lead -----------------------------------------------------------------------------------------------------------

export const lead = defineSkill({
  name: 'lead',
  description:
    'lead {animal, x?,y?,z?, to?, item?} — hold out what the animal wants (wheat for cows and sheep, carrots for pigs, seeds for chickens, or the item named) and walk at its pace to x,y,z (or to someone, or home), with the ones that follow; says how many came',
  argsSchema: z.object({
    animal: z.string().min(2),
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
    z: z.coerce.number().optional(),
    to: z.string().min(1).optional(),
    item: z.string().min(1).optional(),
  }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const kind = entityKind(bot, args.animal);
    if (!kind) return { ok: false, observed: 'no such animal', error: `you don't know what "${args.animal}" is` };
    const food = args.item ? [normalizeItemName(args.item)] : (TEMPTED_BY[kind] ?? []);
    const bait = food.find((f) => heldOne(bot, f));
    if (!bait) return { ok: false, observed: `nothing ${kind} follows on you`, error: `you need ${food.length > 0 ? food.slice(0, 2).join(' or ') : 'something it follows'} to lead a ${kind}` };
    const who = args.to ? bot.players[args.to]?.entity : null;
    const dest = [args.x, args.y, args.z].every((n) => typeof n === 'number' && Number.isFinite(n)) ? new Vec3(args.x as number, args.y as number, args.z as number) : who ? who.position.clone() : ctx.home;
    if (!dest) return { ok: false, observed: 'nowhere to go', error: 'where to? give x,y,z (or someone to go to)' };
    await stopCollecting(bot);
    await hold(bot, bait);
    const followers = () => Object.values(bot.entities).filter((e) => e.name === kind && e.position.distanceTo(bot.entity.position) <= 10);
    // Find some first: up to the nearest one in sight.
    if (followers().length === 0) {
      const near = bot.nearestEntity((e) => e.name === kind && e.position.distanceTo(bot.entity.position) <= 40 && canSee(bot, e, 41));
      if (!near) return { ok: false, observed: `no ${kind} in sight`, error: `no ${kind} in sight to lead` };
      await walkNear(ctx, near.position, 4, 40_000);
      await hold(bot, bait);
      await waitMs(ctx, 1500);
    }
    const deadline = Date.now() + 180_000;
    try {
      while (Date.now() < deadline && bot.entity.position.distanceTo(dest) > 3) {
        throwIfAborted(ctx.signal);
        const with_ = followers();
        if (with_.length === 0) {
          // They lost interest: back to the nearest.
          const near = bot.nearestEntity((e) => e.name === kind && e.position.distanceTo(bot.entity.position) <= 24);
          if (!near) break;
          await walkNear(ctx, near.position, 3, 20_000);
          await waitMs(ctx, 1200);
          continue;
        }
        // A few blocks on, then wait for them to catch up.
        const me = bot.entity.position;
        const step = dest.minus(me);
        const len = Math.hypot(step.x, step.z);
        const leg = len <= 4 ? dest : me.plus(new Vec3((step.x / len) * 4, 0, (step.z / len) * 4));
        bot.pathfinder.setMovements(onFoot(ctx));
        await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(leg.x, leg.z, 1)), 15_000), () => stopMotion(bot)).catch((err: unknown) => {
          if (err instanceof SkillAbortedError) throw err;
          stopMotion(bot);
        });
        await hold(bot, bait);
        for (let w = 0; w < 8 && !followers().some((e) => e.position.distanceTo(bot.entity.position) <= 4); w++) await waitMs(ctx, 500);
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'lost them on the way', error: errMsg(err) };
    }
    const came = Object.values(bot.entities).filter((e) => e.name === kind && e.position.distanceTo(dest) <= 6).length;
    const arrived = bot.entity.position.distanceTo(dest) <= 4;
    const observed = `${arrived ? 'got there' : 'stopped short'} with ${came} ${kind}${came === 1 ? '' : 's'} near ${Math.round(dest.x)},${Math.round(dest.y)},${Math.round(dest.z)}`;
    return came > 0 && arrived ? { ok: true, observed, data: { came } } : { ok: false, observed, error: came === 0 ? `no ${kind} came along` : 'did not get all the way', data: { came } };
  },
});

// --- harvest --------------------------------------------------------------------------------------------------------

export const harvest = defineSkill({
  name: 'harvest',
  description: 'harvest {crop?, radius?, replant?} — pick the ripe crops nearby (wheat, carrots, potatoes, beetroot, nether wart), collect what drops, and plant again what you picked (replant: true unless false)',
  argsSchema: z.object({
    crop: z.string().min(2).optional(),
    radius: z.coerce.number().min(2).max(32).default(16),
    replant: z.coerce.boolean().default(true),
  }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const before = snapshotInventory(bot);
    const wanted = args.crop ? Object.keys(SEED_OF).filter((c) => c.startsWith(normalizeBlockName(args.crop ?? '').replace(/s$/, ''))) : Object.keys(SEED_OF);
    const ids = wanted.map((c) => bot.registry.blocksByName[c]?.id).filter((x): x is number => x !== undefined);
    const ripe = (b: Block | null) => Boolean(b && RIPE_AGE[b.name] !== undefined && Number((b.getProperties?.() as Record<string, unknown> | undefined)?.age ?? -1) >= (RIPE_AGE[b.name] ?? 99));
    let picked = 0;
    let planted = 0;
    await stopCollecting(bot);
    try {
      for (let i = 0; i < 64; i++) {
        throwIfAborted(ctx.signal);
        const p = bot.findBlocks({ matching: ids, maxDistance: args.radius, count: 128 }).find((x) => ripe(bot.blockAt(x)));
        if (!p) break;
        const b = bot.blockAt(p);
        if (!b) break;
        const crop = b.name;
        bot.pathfinder.setMovements(onFoot(ctx));
        await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2.5)), 20_000), () => stopMotion(bot)).catch((err: unknown) => {
          if (err instanceof SkillAbortedError) throw err;
          stopMotion(bot);
        });
        const fresh = bot.blockAt(p);
        if (!ripe(fresh) || !fresh) continue;
        await digBlock(ctx, fresh);
        picked++;
        // What it dropped (the seeds to plant again among it) is picked up first.
        await waitMs(ctx, 600);
        await collectAround(ctx, p.offset(0.5, 0, 0.5), 2.5, undefined, 3);
        const seed = SEED_OF[crop];
        const soil = bot.blockAt(p.offset(0, -1, 0));
        if (args.replant && seed && soil && (soil.name === 'farmland' || soil.name === 'soul_sand') && (await hold(bot, seed))) {
          await bot.lookAt(soil.position.offset(0.5, 1, 0.5), true);
          await bot.activateBlock(soil, new Vec3(0, 1, 0)).catch(() => undefined);
          await waitMs(ctx, 200);
          if (bot.blockAt(p)?.name === crop) planted++;
        }
      }
      // What else dropped around the field.
      await collectAround(ctx, bot.entity.position.clone(), args.radius, undefined, 12);
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `picked ${picked}, planted ${planted}`, error: errMsg(err) };
    }
    if (picked === 0) return { ok: false, observed: 'nothing ripe to pick', error: `no ripe ${args.crop ?? 'crops'} within ${args.radius} blocks` };
    return { ok: true, observed: `picked ${picked} ripe crop(s), planted ${planted} again`, data: { picked, planted, gained: describeDiff(diffInventory(before, snapshotInventory(bot))) } };
  },
});

// --- shearing (the planner's way to wool that keeps the sheep) --------------------------------------------------------

const DYE_COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

/** A sheep's wool as seen: its colour, and whether it has any (sheared ones have none until they graze). */
export function woolOf(bot: Bot, e: Entity): { colour: string; sheared: boolean } | null {
  if (e.name !== 'sheep') return null;
  const keys = (bot.registry.entitiesByName.sheep as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys ?? [];
  const v = (e.metadata as unknown[] | undefined)?.[keys.indexOf('wool')];
  if (typeof v !== 'number') return { colour: 'white', sheared: false };
  return { colour: DYE_COLOURS[v & 0x0f] ?? 'white', sheared: (v & 0x10) !== 0 };
}

/** Grown sheep in sight with wool of this colour on them (any colour without one), nearest first. */
export function woollySheep(bot: Bot, colour: string | null, radius = 32): Entity[] {
  const keys = (bot.registry.entitiesByName.sheep as unknown as { metadataKeys?: string[] } | undefined)?.metadataKeys ?? [];
  const baby = (e: Entity) => (e.metadata as unknown[] | undefined)?.[keys.indexOf('baby')] === true;
  return Object.values(bot.entities)
    .filter((e) => {
      const w = woolOf(bot, e);
      return w && !w.sheared && !baby(e) && (!colour || w.colour === colour) && e.position.distanceTo(bot.entity.position) <= radius && canSee(bot, e, radius + 1);
    })
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

/** Shears woolly sheep of the colour, picking up the wool, until `enough` (or none are left to shear); how many were sheared. */
export async function shearSheep(ctx: SkillContext, colour: string | null, enough: () => boolean): Promise<number> {
  const { bot } = ctx;
  let sheared = 0;
  const tried = new Set<number>();
  for (let i = 0; i < 24 && !enough(); i++) {
    throwIfAborted(ctx.signal);
    const e = woollySheep(bot, colour).find((x) => !tried.has(x.id));
    if (!e) break;
    tried.add(e.id);
    const near = await approachEntity(ctx, e);
    ctx.logger.debug({ module: 'hands', sheep: e.id, near, d: Math.round(bot.entity.position.distanceTo(e.position) * 10) / 10 }, 'to a sheep');
    if (!near) continue;
    if (!(await hold(bot, 'shears'))) break;
    await bot.lookAt(e.position.offset(0, 0.8, 0), true);
    await bot.activateEntity(e);
    await waitMs(ctx, 500);
    if (woolOf(bot, e)?.sheared) sheared++;
    ctx.logger.debug({ module: 'hands', sheep: e.id, sheared: woolOf(bot, e)?.sheared, drops: Object.values(bot.entities).filter((x) => x.name === 'item' && x.position.distanceTo(e.position) <= 6).length }, 'sheared');
    // The wool pops off around it.
    await waitMs(ctx, 300);
    await collectAround(ctx, e.position.clone(), 5);
  }
  // Wool that flew further, around where the sheep are.
  if (sheared > 0) await collectAround(ctx, bot.entity.position.clone(), 10, (n) => n.endsWith('_wool'), 10);
  return sheared;
}
