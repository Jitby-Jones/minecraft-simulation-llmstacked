// Building skills: place, shelter (dig in for the night). Schematic-style code, not LLM-placed blocks (§12).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { blockMatcher, itemMatcher } from '../items';
import { ATTACHED, NOT_FROM_ABOVE, USABLE_BLOCK, audibleHostiles, findPlaceableSpot, isAirLike, isNight, isSolid, overlapsCell, shelterHole, sturdy, wallsAround } from '../world';
import { abortable, digBlock, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs } from './util';
import { defineSkill, type SkillContext, type SkillResult, SkillAbortedError } from './types';

const FACES = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
];

/**
 * A solid neighbor of `target` to place against, preferring the block below. For what goes on a face (`item`: a
 * torch, a sign), a sturdy one, and never the one above for what can't hang from a ceiling.
 */
export function referenceFor(bot: Bot, target: Vec3, item?: string): { ref: Block; face: Vec3 } | null {
  const attached = item !== undefined && ATTACHED.test(item);
  // A plain block first: one a right-click uses (a crafting table) takes a sneak to place against (placeItemAt).
  let usable: { ref: Block; face: Vec3 } | null = null;
  for (const f of FACES) {
    const ref = bot.blockAt(target.plus(f));
    if (!isSolid(ref) || !ref) continue;
    if (attached && (!sturdy(ref) || (f.y > 0 && NOT_FROM_ABOVE.test(item)))) continue;
    if (!USABLE_BLOCK.test(ref.name)) return { ref, face: f.scaled(-1) };
    usable ??= { ref, face: f.scaled(-1) };
  }
  return usable;
}

/** Places an inventory item at `target` (walks near first). Throws with a readable message on failure. */
export async function placeItemAt(ctx: SkillContext, itemName: string, target: Vec3): Promise<void> {
  const { bot } = ctx;
  const m = itemMatcher(itemName);
  const item = bot.inventory.items().find((i) => m.matches(i.name));
  if (!item) throw new Error(`no ${m.label} in inventory`);
  if (!isAirLike(bot.blockAt(target))) throw new Error(`${target.toString()} is not free`);
  if (bot.entity.position.distanceTo(target) > 4) await gotoNear(ctx, target, 3);
  const r = referenceFor(bot, target, item.name);
  if (!r) throw new Error(ATTACHED.test(item.name) ? `nothing there for a ${item.name} to go on (it needs the face of a whole block: not leaves, not a slab)` : 'nothing solid to place against');
  // Never place into our own body.
  const feet = bot.entity.position.floored();
  if (target.equals(feet) || target.equals(feet.offset(0, 1, 0))) throw new Error('would place inside myself');
  await bot.equip(item, 'hand');
  throwIfAborted(ctx.signal);
  // Against a crafting table, a chest or a door, a click would use it: sneak to place, as players do.
  const sneak = USABLE_BLOCK.test(r.ref.name);
  if (sneak) bot.setControlState('sneak', true);
  try {
    await bot.placeBlock(r.ref, r.face);
  } finally {
    if (sneak) bot.setControlState('sneak', false);
  }
}

const SIDE_CELLS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
/** They fall unless something is under them. */
const FALLS = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding|\w+_concrete_powder)$/;
/** How far a hand reaches to set a block, from the eyes. */
const REACH = 4.5;

/**
 * An empty cell in reach beside a face a click can take (the side of the block underfoot, a wall, a ceiling): where a
 * player sets a block down over a drop or on a ledge with no floor about. An agent on its own blocks in a cave was
 * told there was no room for its furnace.
 */
export function besideAFace(bot: Bot, item?: string): Vec3 | null {
  const me = bot.entity.position.floored();
  const eyes = bot.entity.position.offset(0, 1.62, 0);
  const bodies = Object.values(bot.entities).filter((e) => e === bot.entity || e.type === 'player' || e.type === 'mob' || e.type === 'hostile');
  for (let r = 1; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, -1, 1]) {
          const p = me.offset(dx, dy, dz);
          if (!isAirLike(bot.blockAt(p)) || p.offset(0.5, 0.5, 0.5).distanceTo(eyes) > REACH) continue;
          if (bodies.some((e) => overlapsCell(e, p))) continue;
          if (referenceFor(bot, p, item)) return p;
        }
      }
    }
  }
  return null;
}

/**
 * A spot to set something down; over a drop, beside any face in reach; in a tunnel with none, a notch dug in the wall
 * beside one's feet, as a player does (a block that can be dug, with a floor under it and no water or lava against it).
 */
export async function spotOrNotch(ctx: SkillContext, item?: string): Promise<Vec3 | null> {
  const { bot } = ctx;
  const onFace = item !== undefined && ATTACHED.test(item);
  const spot = findPlaceableSpot(bot, 3, { sturdy: onFace });
  if (spot) return spot;
  const side = item !== undefined && FALLS.test(item) ? null : besideAFace(bot, item);
  if (side) return side;
  const feet = bot.entity.position.floored();
  for (const side of SIDE_CELLS) {
    const cell = feet.plus(side);
    const b = bot.blockAt(cell);
    if (!b || !isSolid(b) || b.hardness === null || b.hardness < 0 || ['bedrock', 'obsidian', 'reinforced_deepslate'].includes(b.name) || !bot.canDigBlock(b)) continue;
    const floor = bot.blockAt(cell.offset(0, -1, 0));
    if (!(onFace ? sturdy(floor) : isSolid(floor)) || liquidNear(bot, cell)) continue;
    const tool = bot.pathfinder.bestHarvestTool(b);
    if (tool) await bot.equip(tool, 'hand');
    await digBlock(ctx, b);
    await waitMs(ctx, 150);
    if (isAirLike(bot.blockAt(cell))) return cell;
  }
  return null;
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
        : await spotOrNotch(ctx, itemMatcher(args.block).label);
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

/** A shelter broken open while we waited in it: what the mind is told. */
function breached(hole: string): { ok: false; observed: string; error: string } {
  return { ok: false, observed: `the shelter was broken open: a hole ${hole}`, error: 'shelter breached' };
}

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
/** Any whole block that stays put makes a lid: planks and logs as well as earth and stone (not sand or gravel, which fall). */
const COVER = /_planks$|_log$|_stem$|^(stone|deepslate|tuff|calcite|sandstone|red_sandstone|bricks|stone_bricks|mud_bricks|mossy_cobblestone|blackstone|basalt|end_stone|coarse_dirt|rooted_dirt|packed_mud|terracotta)$/;
export const isCover = (name: string) => COVER_BLOCKS.includes(name) || COVER.test(name);

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
    if (coverBlock && !isAirLike(coverBlock)) await digBlock(ctx, coverBlock);
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
  // Until morning unless asked to lie low until healed: asked that by day (at 4 health), it said "it is already day"
  // and was out mining again at once.
  argsSchema: z.object({ untilMorning: z.coerce.boolean().optional(), untilHealed: z.coerce.boolean().default(false) }).transform((a) => ({ ...a, untilMorning: a.untilMorning ?? !a.untilHealed })),
  talkOverable: false,
  slipKinds: [],
  expect: (args) => (args.untilMorning ? { kind: 'awakeAfterNight' } : { kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    stopMotion(bot);
    // Re-run in the morning (e.g. after a reflex interrupted the climb): just get out.
    if (args.untilMorning && !args.untilHealed && isDaytime(bot)) {
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
          await digBlock(ctx, b);
        }
        // Drop into the hole.
        for (let t = 0; t < 15 && bot.entity.position.floored().y >= feet.y; t++) await waitMs(ctx, 100);
        await waitMs(ctx, 200);
      }
      if (!readyToSeal(bot)) return { ok: false, observed: 'could not dig deep enough', error: 'no good spot to dig in' };
      const feet = bot.entity.position.floored();
      const cover = feet.offset(0, 2, 0);
      if (!isSolid(bot.blockAt(cover))) {
        const coverItem = bot.inventory.items().find((i) => COVER_BLOCKS.includes(i.name)) ?? bot.inventory.items().find((i) => isCover(i.name));
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
      while (bot.health < HEALED && bot.food >= 18 && Date.now() < until) {
        await waitMs(ctx, 1000);
        const hole = shelterHole(bot);
        if (hole) return breached(hole);
      }
      return climbOut(ctx, bot.health >= HEALED ? 'healed up' : 'rested');
    }
    if (!args.untilMorning) return { ok: true, observed: 'dug in and sealed the top' };
    // Waiting for day, and watching the walls: a shelter broken open is no shelter, and the mind must know.
    while (!isDaytime(bot)) {
      await waitMs(ctx, 1000);
      const hole = shelterHole(bot);
      if (hole) return breached(hole);
    }
    return climbOut(ctx);
  },
});
