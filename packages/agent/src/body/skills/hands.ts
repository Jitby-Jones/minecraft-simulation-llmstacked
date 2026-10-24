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
import { describeDiff, diffInventory, snapshotInventory } from '../inventory';
import { normalizeBlockName, normalizeItemName } from '../items';
import { canSee, canSeeBlock } from '../world';
import { stopCollecting } from './gathering';
import { abortable, digBlock, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';
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

async function approachEntity(ctx: SkillContext, e: Entity): Promise<boolean> {
  const { bot } = ctx;
  for (let i = 0; i < 3 && bot.entities[e.id]; i++) {
    if (bot.entity.position.distanceTo(e.position) <= ENTITY_REACH) return true;
    bot.pathfinder.setMovements(ctx.movements());
    try {
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 1.5)), 12_000), () => stopMotion(bot));
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      stopMotion(bot);
    }
  }
  return Boolean(bot.entities[e.id]) && bot.entity.position.distanceTo(e.position) <= ENTITY_REACH + 0.6;
}

// --- use -----------------------------------------------------------------------------------------------------------

export const use = defineSkill({
  name: 'use',
  description:
    'use {item?, on, times?, x?,y?,z?} — right-click with an item (or what you hold) on a creature or a block, as a player does: shears on a sheep, wheat on a cow, a bucket on a cow or on water, seeds or bone meal on farmland or a crop, a hoe on dirt, flint and steel on obsidian, a door or a gate to open it; on: what (a creature or block name; with x,y,z that block); times: that many of them, nearest first',
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
          await bot.lookAt(e.position.offset(0, (e.height ?? 1) * 0.6, 0), true);
          await bot.activateEntity(e);
          await waitMs(ctx, 450);
          done++;
          if (bot.entities[e.id] && stateOf(bot, e) !== was) changes.push(`the ${kind.replace(/_/g, ' ')} changed`);
        }
        if (done === 0) return { ok: false, observed: `no ${kind.replace(/_/g, ' ')} in reach`, error: `no ${kind.replace(/_/g, ' ')} in sight to use it on` };
      } else {
        const names = at ? [bot.blockAt(at)?.name ?? ''] : blockKinds(bot, args.on);
        if (!names || names[0] === '') return { ok: false, observed: 'nothing to use it on', error: `you don't know what "${args.on}" is` };
        const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined);
        const used = new Set<string>();
        for (let i = 0; i < args.times; i++) {
          throwIfAborted(ctx.signal);
          const target = at ? bot.blockAt(at) : pickBlock(bot, ids, used);
          if (!target) break;
          used.add(target.position.toString());
          await gotoNear(ctx, target.position, REACH - 0.8, 30_000).catch((err: unknown) => {
            if (err instanceof SkillAbortedError) throw err;
          });
          if (bot.entity.position.distanceTo(target.position.offset(0.5, 0.5, 0.5)) > REACH + 1.5) continue;
          if (args.item) await hold(bot, args.item);
          const was = bot.blockAt(target.position)?.stateId;
          const above = bot.blockAt(target.position.offset(0, 1, 0))?.stateId;
          await useOnBlock(bot, target);
          await waitMs(ctx, 400);
          done++;
          const now = bot.blockAt(target.position);
          const nowAbove = bot.blockAt(target.position.offset(0, 1, 0));
          if (now && now.stateId !== was) changes.push(`${target.name.replace(/_/g, ' ')} became ${now.name.replace(/_/g, ' ')}`);
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
    const observed = `used ${args.item ? normalizeItemName(args.item) : 'my hand'} on ${done} ${args.on}: ${describeDiff(diff)}${what.length > 0 ? `; ${what.join('; ')}` : ''}`;
    return happened ? { ok: true, observed } : { ok: false, observed, error: 'nothing came of it' };
  },
});

/** The nearest block of these kinds in sight and reach of a walk, not used yet this run. */
function pickBlock(bot: Bot, ids: readonly number[], used: ReadonlySet<string>): Block | null {
  for (const p of bot.findBlocks({ matching: [...ids], maxDistance: 24, count: 64 })) {
    if (used.has(p.toString())) continue;
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
      await gotoNear(ctx, near.position, 4, 40_000).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
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
          await gotoNear(ctx, near.position, 3, 20_000).catch((err: unknown) => {
            if (err instanceof SkillAbortedError) throw err;
          });
          await waitMs(ctx, 1200);
          continue;
        }
        // A few blocks on, then wait for them to catch up.
        const me = bot.entity.position;
        const step = dest.minus(me);
        const len = Math.hypot(step.x, step.z);
        const leg = len <= 4 ? dest : me.plus(new Vec3((step.x / len) * 4, 0, (step.z / len) * 4));
        bot.pathfinder.setMovements(ctx.movements());
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
        await gotoNear(ctx, p, 2.5, 20_000).catch((err: unknown) => {
          if (err instanceof SkillAbortedError) throw err;
        });
        const fresh = bot.blockAt(p);
        if (!ripe(fresh) || !fresh) continue;
        await digBlock(ctx, fresh);
        picked++;
        await waitMs(ctx, 250);
        const seed = SEED_OF[crop];
        const soil = bot.blockAt(p.offset(0, -1, 0));
        if (args.replant && seed && soil && (soil.name === 'farmland' || soil.name === 'soul_sand') && (await hold(bot, seed))) {
          await bot.lookAt(soil.position.offset(0.5, 1, 0.5), true);
          await bot.activateBlock(soil, new Vec3(0, 1, 0)).catch(() => undefined);
          await waitMs(ctx, 200);
          if (bot.blockAt(p)?.name === crop) planted++;
        }
      }
      // What dropped around the field.
      for (let i = 0; i < 12; i++) {
        const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= args.radius);
        if (!drop) break;
        await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), 6000), () => stopMotion(bot)).catch((err: unknown) => {
          if (err instanceof SkillAbortedError) throw err;
          stopMotion(bot);
        });
        await waitMs(ctx, 250);
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `picked ${picked}, planted ${planted}`, error: errMsg(err) };
    }
    const diff = describeDiff(diffInventory(before, snapshotInventory(bot)));
    if (picked === 0) return { ok: false, observed: 'nothing ripe to pick', error: `no ripe ${args.crop ?? 'crops'} within ${args.radius} blocks` };
    return { ok: true, observed: `picked ${picked} ripe crop(s), planted ${planted} again: ${diff}`, data: { picked, planted } };
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

/** Shears up to `n` woolly sheep of the colour and picks up the wool; returns how many were sheared. */
export async function shearSheep(ctx: SkillContext, colour: string | null, n: number): Promise<number> {
  const { bot } = ctx;
  let sheared = 0;
  const tried = new Set<number>();
  for (let i = 0; i < n * 2 && sheared < n; i++) {
    throwIfAborted(ctx.signal);
    const e = woollySheep(bot, colour).find((x) => !tried.has(x.id));
    if (!e) break;
    tried.add(e.id);
    if (!(await approachEntity(ctx, e))) continue;
    if (!(await hold(bot, 'shears'))) break;
    await bot.lookAt(e.position.offset(0, 0.8, 0), true);
    await bot.activateEntity(e);
    await waitMs(ctx, 500);
    if (woolOf(bot, e)?.sheared) sheared++;
    // The wool pops off around it.
    for (let k = 0; k < 4; k++) {
      const drop = bot.nearestEntity((x) => x.name === 'item' && x.position.distanceTo(e.position) <= 4);
      if (!drop) break;
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), 5000), () => stopMotion(bot)).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
        stopMotion(bot);
      });
      await waitMs(ctx, 250);
    }
  }
  return sheared;
}
