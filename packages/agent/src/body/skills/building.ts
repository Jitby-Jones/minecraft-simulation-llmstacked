// Building skills: place, shelter (dig in for the night). Schematic-style code, not LLM-placed blocks (§12).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { blockMatcher, itemMatcher } from '../items';
import { audibleHostiles, findPlaceableSpot, isAirLike, isNight, isSolid, wallsAround } from '../world';
import { abortable, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs } from './util';
import { defineSkill, type SkillContext, type SkillResult, SkillAbortedError } from './types';

const FACES = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
];

/** A solid neighbor of `target` to place against, preferring the block below. */
export function referenceFor(bot: Bot, target: Vec3): { ref: Block; face: Vec3 } | null {
  for (const f of FACES) {
    const ref = bot.blockAt(target.plus(f));
    if (isSolid(ref) && ref) return { ref, face: f.scaled(-1) };
  }
  return null;
}

/** Places an inventory item at `target` (walks near first). Throws with a readable message on failure. */
export async function placeItemAt(ctx: SkillContext, itemName: string, target: Vec3): Promise<void> {
  const { bot } = ctx;
  const m = itemMatcher(itemName);
  const item = bot.inventory.items().find((i) => m.matches(i.name));
  if (!item) throw new Error(`no ${m.label} in inventory`);
  if (!isAirLike(bot.blockAt(target))) throw new Error(`${target.toString()} is not free`);
  if (bot.entity.position.distanceTo(target) > 4) await gotoNear(ctx, target, 3);
  const r = referenceFor(bot, target);
  if (!r) throw new Error('nothing solid to place against');
  // Never place into our own body.
  const feet = bot.entity.position.floored();
  if (target.equals(feet) || target.equals(feet.offset(0, 1, 0))) throw new Error('would place inside myself');
  await bot.equip(item, 'hand');
  throwIfAborted(ctx.signal);
  await bot.placeBlock(r.ref, r.face);
}

export const place = defineSkill({
  name: 'place',
  description: 'place {block, x?,y?,z?} — place a block from your inventory (next to you if no position)',
  argsSchema: z.object({
    block: z.string().min(1),
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
    z: z.coerce.number().optional(),
  }),
  talkOverable: false,
  slipKinds: [],
  expect: (args) =>
    args.x !== undefined && args.y !== undefined && args.z !== undefined
      ? { kind: 'blockAt', pos: new Vec3(args.x, args.y, args.z), block: blockMatcher(args.block).label }
      : { kind: 'inventoryLoss', item: itemMatcher(args.block).label, atLeast: 1 },
  async run(ctx, args) {
    const target =
      args.x !== undefined && args.y !== undefined && args.z !== undefined
        ? new Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z))
        : findPlaceableSpot(ctx.bot, 3);
    if (!target) return { ok: false, observed: 'no free spot', error: 'no free spot to place a block nearby' };
    try {
      await placeItemAt(ctx, args.block, target);
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: `could not place at ${target.toString()}`, error: errMsg(err) };
    }
    return { ok: true, observed: `placed ${args.block} at ${target.x},${target.y},${target.z}` };
  },
});

function diggableForShelter(bot: Bot, b: Block | null): boolean {
  if (!b || !isSolid(b)) return false;
  if (['bedrock', 'obsidian', 'reinforced_deepslate', 'barrier'].includes(b.name)) return false;
  return bot.canDigBlock(b);
}

function liquidNear(bot: Bot, p: Vec3): boolean {
  for (const f of FACES) {
    const n = bot.blockAt(p.plus(f));
    if (n && (n.name === 'water' || n.name === 'lava')) return true;
  }
  return false;
}

/** A column to dig in at `feet`: two diggable blocks down, solid ground under them, no water or lava beside. */
function goodShelterColumn(bot: Bot, feet: Vec3): boolean {
  const b1 = bot.blockAt(feet.offset(0, -1, 0));
  const b2 = bot.blockAt(feet.offset(0, -2, 0));
  return diggableForShelter(bot, b1) && diggableForShelter(bot, b2) && isSolid(bot.blockAt(feet.offset(0, -3, 0))) && !liquidNear(bot, feet.offset(0, -1, 0)) && !liquidNear(bot, feet.offset(0, -2, 0));
}

/** The nearest place within 4 blocks where one can stand and dig in (`goodShelterColumn`), or null. */
function shelterSpotNear(bot: Bot): Vec3 | null {
  const feet = bot.entity.position.floored();
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (const dy of [0, 1, -1]) {
        const p = feet.offset(dx, dy, dz);
        const d = Math.hypot(dx, dy, dz);
        if (d >= bestD || !isAirLike(bot.blockAt(p)) || !isAirLike(bot.blockAt(p.offset(0, 1, 0))) || !goodShelterColumn(bot, p)) continue;
        best = p;
        bestD = d;
      }
    }
  }
  return best;
}

/** Sneaks to the middle of the block we stand on, so digging below drops us into the hole. */
async function centerOnBlock(ctx: SkillContext): Promise<void> {
  const { bot } = ctx;
  const feet = bot.entity.position.floored();
  const target = new Vec3(feet.x + 0.5, bot.entity.position.y, feet.z + 0.5);
  bot.setControlState('sneak', true);
  try {
    for (let i = 0; i < 40; i++) {
      throwIfAborted(ctx.signal);
      const p = bot.entity.position;
      if (Math.hypot(p.x - target.x, p.z - target.z) < 0.12) break;
      await bot.lookAt(target.offset(0, bot.entity.height * 0.9, 0), true);
      bot.setControlState('forward', true);
      await waitMs(ctx, 50);
      bot.setControlState('forward', false);
      await waitMs(ctx, 50);
    }
  } finally {
    bot.clearControlStates();
  }
}

/** A spot to stand on next to the shaft we are in, up to 6 blocks higher. */
function shaftExit(bot: Bot, feet: Vec3): Vec3 | null {
  for (let dy = 1; dy <= 6; dy++) {
    for (const f of FACES.slice(1, 5)) {
      const p = feet.offset(f.x, dy, f.z);
      if (isAirLike(bot.blockAt(p)) && isAirLike(bot.blockAt(p.offset(0, 1, 0))) && isSolid(bot.blockAt(p.offset(0, -1, 0)))) return p;
    }
  }
  return null;
}

/** Walled in, and the block above our head can be sealed against something (it lies inside the ground). */
function readyToSeal(bot: Bot): boolean {
  const feet = bot.entity.position.floored();
  if (!wallsAround(bot, feet)) return false;
  const cover = feet.offset(0, 2, 0);
  return isSolid(bot.blockAt(cover)) || FACES.slice(1, 5).some((f) => isSolid(bot.blockAt(cover.plus(f))));
}

const COVER_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite'];

function isDaytime(bot: Bot): boolean {
  return !isNight(bot) && bot.time.timeOfDay <= 12500;
}

/**
 * Undead burn from about 1000 ticks after sunrise. Until then, or while something can be heard right outside
 * (8 blocks; creepers make no sound), stay put; by mid-morning go anyway and let the reflexes handle stragglers.
 */
/** Lying low to heal ends here, or after this long. */
const HEALED = 18;
const HEAL_MAX_MS = 150_000;

/**
 * Mobs from the night linger into the morning (skeletons in the shade, stragglers): out only once none can be heard
 * nearby, and by midmorning in any case (a creeper is silent; a skeleton under a tree may stay all day).
 */
function safeToLeave(bot: Bot): boolean {
  const t = bot.time.timeOfDay;
  if (t < 1000 || t >= 12000) return false;
  return t > 6000 || audibleHostiles(bot, 16).length === 0;
}

/** Waits for a safe moment, opens the top of the shaft and walks out (pathfinder towers up with the dug dirt). */
async function climbOut(ctx: SkillContext, done = 'survived the night'): Promise<SkillResult> {
  const { bot } = ctx;
  while (!safeToLeave(bot)) await waitMs(ctx, 1000);
  try {
    const feet = bot.entity.position.floored();
    const coverBlock = bot.blockAt(feet.offset(0, 2, 0));
    if (coverBlock && !isAirLike(coverBlock)) await abortable(ctx.signal, bot.dig(coverBlock, true), () => bot.stopDigging());
    const exit = shaftExit(bot, feet);
    if (!exit) return { ok: true, observed: `${done} but found no way out yet` };
    bot.pathfinder.setMovements(ctx.movements());
    await abortable(ctx.signal, bot.pathfinder.goto(new goals.GoalBlock(exit.x, exit.y, exit.z)), () => stopMotion(bot));
  } catch (err) {
    if (err instanceof SkillAbortedError) throw err;
    return { ok: true, observed: `${done} but could not climb out yet (${errMsg(err)})` };
  }
  return { ok: true, observed: `${done} in a shelter and climbed out` };
}

export const shelter = defineSkill({
  name: 'shelter',
  description:
    'shelter {untilMorning?, untilHealed?} — dig into the ground and seal the top; with untilMorning, wait for day and climb out; with untilHealed, lie low until the health is back',
  argsSchema: z.object({ untilMorning: z.coerce.boolean().default(true), untilHealed: z.coerce.boolean().default(false) }),
  talkOverable: false,
  slipKinds: [],
  expect: (args) => (args.untilMorning ? { kind: 'awakeAfterNight' } : { kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    stopMotion(bot);
    // Re-run in the morning (e.g. after a reflex interrupted the climb): just get out.
    if (args.untilMorning && isDaytime(bot)) {
      return wallsAround(bot) ? climbOut(ctx) : { ok: true, observed: 'it is already day' };
    }
    try {
      // Dig straight down until walled in with a sealable top; a half-dug hole from an interrupted try is resumed.
      // Where the ground won't do (a shaft below, water beside), a spot a few steps away first.
      if (!wallsAround(bot) && !goodShelterColumn(bot, bot.entity.position.floored())) {
        const spot = shelterSpotNear(bot);
        if (spot) {
          bot.pathfinder.setMovements(ctx.movements());
          await abortable(ctx.signal, bot.pathfinder.goto(new goals.GoalBlock(spot.x, spot.y, spot.z)), () => stopMotion(bot));
        }
      }
      if (!wallsAround(bot)) await centerOnBlock(ctx);
      for (let i = 0; i < 5 && !readyToSeal(bot); i++) {
        throwIfAborted(ctx.signal);
        const feet = bot.entity.position.floored();
        const below = feet.offset(0, -1, 0);
        const b = bot.blockAt(below);
        if (!isSolid(bot.blockAt(below.offset(0, -1, 0)))) return { ok: false, observed: 'ground below is not solid', error: 'unsafe to dig in here' };
        if (!diggableForShelter(bot, b)) return { ok: false, observed: 'cannot dig here', error: `cannot dig ${b?.name ?? 'block'}` };
        if (liquidNear(bot, below)) return { ok: false, observed: 'liquid next to the hole', error: 'water or lava nearby' };
        if (b) {
          const tool = bot.pathfinder.bestHarvestTool(b);
          if (tool) await bot.equip(tool, 'hand');
          await abortable(ctx.signal, bot.dig(b, true), () => bot.stopDigging());
        }
        // Drop into the hole.
        for (let t = 0; t < 15 && bot.entity.position.floored().y >= feet.y; t++) await waitMs(ctx, 100);
        await waitMs(ctx, 200);
      }
      if (!readyToSeal(bot)) return { ok: false, observed: 'could not dig deep enough', error: 'no good spot to dig in' };
      const feet = bot.entity.position.floored();
      const cover = feet.offset(0, 2, 0);
      if (!isSolid(bot.blockAt(cover))) {
        const coverItem = bot.inventory.items().find((i) => COVER_BLOCKS.includes(i.name));
        if (!coverItem) return { ok: false, observed: 'dug in but nothing to seal the top with', error: 'no block to seal the shelter' };
        const r = referenceFor(bot, cover);
        if (!r) return { ok: false, observed: 'no wall to seal against', error: 'cannot seal shelter' };
        await bot.equip(coverItem, 'hand');
        await bot.placeBlock(r.ref, r.face);
      }
      ctx.progress('sheltered');
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'shelter failed', error: errMsg(err) };
    }
    if (args.untilHealed) {
      // Health only comes back with food at 18 or more; hungry again, it's time to go and find some.
      const until = Date.now() + HEAL_MAX_MS;
      while (bot.health < HEALED && bot.food >= 18 && Date.now() < until) await waitMs(ctx, 1000);
      return climbOut(ctx, bot.health >= HEALED ? 'healed up' : 'rested');
    }
    if (!args.untilMorning) return { ok: true, observed: 'dug in and sealed the top' };
    while (!isDaytime(bot)) await waitMs(ctx, 1000);
    return climbOut(ctx);
  },
});
