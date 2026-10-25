// Building skills: place, shelter (dig in for the night). Schematic-style code, not LLM-placed blocks (§12).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { blockMatcher, itemMatcher } from '../items';
import { ATTACHED, NOT_FROM_ABOVE, USABLE_BLOCK, audibleHostiles, findEntity, findPlaceableSpot, isAirLike, isNight, isSolid, nearbyHostiles, outByHand, overlapsCell, placeableInto, shelterHole, sturdy, wallsAround } from '../world';
import { abortable, digBlock, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';
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
  // A flower, a sapling, a torch: walked through, but nothing goes in over it. Out first, by hand, as a player does.
  const there = bot.blockAt(target);
  if (there && !placeableInto(there)) {
    if (outByHand(there)) await digBlock(ctx, there);
    if (!placeableInto(bot.blockAt(target))) throw new Error(`${target.toString()} is not free: the ${there.name} there is in the way`);
  }
  // A bed lies over two cells, its head the way one faces as it goes down: room for the head, and that facing.
  let head: Vec3 | null = null;
  if (TWO_LONG.test(item.name)) {
    const way = bedWay(bot, target);
    if (!way) throw new Error(`no room at ${target.toString()} for a bed: its head needs a free cell on the ground beside it, and somewhere to stand facing that way`);
    if (!facingTo(bot, target).equals(way)) {
      const stand = target.minus(way);
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalBlock(stand.x, stand.y, stand.z)), 8000), () => stopMotion(bot)).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
      if (!facingTo(bot, target).equals(way)) throw new Error('could not get round to face the way the bed must lie');
    }
    head = target.plus(way);
    const h = bot.blockAt(head);
    if (h && outByHand(h)) await digBlock(ctx, h);
  }
  const r = referenceFor(bot, target, item.name);
  if (!r) throw new Error(ATTACHED.test(item.name) ? `nothing there for a ${item.name} to go on (it needs the face of a whole block: not leaves, not a slab)` : 'nothing solid to place against');
  // Never place into our own body: a door is two high, and the server refuses one that touches us at all (at a hut's
  // doorway, a hair over its edge, it was refused). A step clear first.
  const cells = TWO_HIGH.test(item.name) ? [target, target.offset(0, 1, 0)] : head ? [target, head] : [target];
  if (cells.some((c) => overlapsCell(bot.entity, c))) await stepClear(ctx, cells);
  if (cells.some((c) => overlapsCell(bot.entity, c))) throw new Error('would place inside myself');
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
/** What stands two blocks high once placed. */
const TWO_HIGH = /_door$|^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|small_dripleaf)$/;
/** What lies over two cells once placed, its head the way one faces as it goes down. */
const TWO_LONG = /(^|_)bed$/;

/** The way one faces, from where one stands, toward a cell (the way a bed's head goes). */
function facingTo(bot: Bot, target: Vec3): Vec3 {
  const dx = target.x + 0.5 - bot.entity.position.x;
  const dz = target.z + 0.5 - bot.entity.position.z;
  return Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1);
}

/** Room to stand in a cell: for the body, with ground under it. */
function standable(bot: Bot, p: Vec3): boolean {
  return isAirLike(bot.blockAt(p)) && isAirLike(bot.blockAt(p.offset(0, 1, 0))) && isSolid(bot.blockAt(p.offset(0, -1, 0)));
}

/**
 * The way a bed set down at `foot` can lie: its head into a free cell on the ground (a flower there is picked first),
 * from somewhere to stand facing that way; the way one faces now first. One set down facing a tree, then a hillside,
 * was refused five times over at dusk.
 */
export function bedWay(bot: Bot, foot: Vec3): Vec3 | null {
  const now = facingTo(bot, foot);
  for (const d of [now, ...SIDE_CELLS]) {
    const cell = foot.plus(d);
    const b = bot.blockAt(cell);
    if (!(placeableInto(b) || outByHand(b)) || !isSolid(bot.blockAt(cell.offset(0, -1, 0)))) continue;
    if (d.equals(now) || standable(bot, foot.minus(d))) return d;
  }
  return null;
}

/** A spot within reach for a bed: free, on the ground, with room for its head one way or another. */
function bedSpot(bot: Bot): Vec3 | null {
  const me = bot.entity.position.floored();
  const bodies = Object.values(bot.entities).filter((e) => e === bot.entity || e.type === 'player' || e.type === 'mob' || e.type === 'hostile');
  for (let r = 1; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const p = me.offset(dx, dy, dz);
          const b = bot.blockAt(p);
          const below = bot.blockAt(p.offset(0, -1, 0));
          if (!(placeableInto(b) || outByHand(b)) || !isAirLike(bot.blockAt(p.offset(0, 1, 0))) || !isSolid(below) || USABLE_BLOCK.test(below?.name ?? '')) continue;
          if (bodies.some((e) => overlapsCell(e, p))) continue;
          if (bedWay(bot, p)) return p;
        }
      }
    }
  }
  return null;
}

/** A step to a cell beside one's feet with room to stand and ground under it, clear of `cells`, away from them. */
async function stepClear(ctx: SkillContext, cells: readonly Vec3[]): Promise<void> {
  const { bot } = ctx;
  const feet = bot.entity.position.floored();
  const from = cells[0] ?? feet;
  const spots = SIDE_CELLS.map((d) => feet.plus(d))
    .filter((p) => !cells.some((c) => c.x === p.x && c.z === p.z) && isAirLike(bot.blockAt(p)) && isAirLike(bot.blockAt(p.offset(0, 1, 0))) && isSolid(bot.blockAt(p.offset(0, -1, 0))))
    .sort((a, b) => b.distanceTo(from) - a.distanceTo(from));
  const to = spots[0];
  if (!to) return;
  await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalBlock(to.x, to.y, to.z)), 4000), () => stopMotion(bot)).catch((err: unknown) => {
    if (err instanceof SkillAbortedError) throw err;
  });
}
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
          if (!placeableInto(bot.blockAt(p)) || p.offset(0.5, 0.5, 0.5).distanceTo(eyes) > REACH) continue;
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
  if (item !== undefined && TWO_LONG.test(item)) return bedSpot(bot);
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

const WAYS: Readonly<Record<string, Vec3>> = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) };

/**
 * The cell beside one toward a way or something in sight, at the feet, or at the head once the feet are walled: where
 * a block goes between one and it (asked to "block the arrows" with no spot, one went down anywhere, and the skeleton
 * shot on). Null when there is no such way or thing, or both cells there are taken.
 */
function besideToward(bot: Bot, toward: string): Vec3 | null {
  const w = toward.trim().toLowerCase();
  let d = WAYS[/^(north|south|east|west)/.exec(w)?.[1] ?? ''] ?? null;
  if (!d) {
    const e = findEntity(bot, w.replace(/^(the|a|an)\s+/, ''), 32);
    if (!e) return null;
    const dx = e.position.x - bot.entity.position.x;
    const dz = e.position.z - bot.entity.position.z;
    d = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1);
  }
  const feet = bot.entity.position.floored();
  for (const dy of [0, 1]) {
    const c = feet.plus(d).offset(0, dy, 0);
    if (placeableInto(bot.blockAt(c))) return c;
  }
  return null;
}

export const place = defineSkill({
  name: 'place',
  description:
    'place {block, x?,y?,z?, toward?} — place a block from your inventory: at x,y,z; or beside you toward a way (north...) or something in sight (a skeleton, someone), at your feet or at your head once that is filled; next to you if neither',
  argsSchema: z.object({
    block: z.string().min(1),
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
    z: z.coerce.number().optional(),
    toward: z.string().min(1).optional(),
  }),
  talkOverable: false,
  slipKinds: [],
  expect: (args) =>
    args.x !== undefined && args.y !== undefined && args.z !== undefined
      ? { kind: 'blockAt', pos: new Vec3(args.x, args.y, args.z), block: blockMatcher(args.block).label }
      : { kind: 'inventoryLoss', item: itemMatcher(args.block).label, atLeast: 1 },
  async run(ctx, args) {
    const at = args.x !== undefined && args.y !== undefined && args.z !== undefined;
    if (!at && args.toward) {
      const beside = besideToward(ctx.bot, args.toward);
      if (!beside) return { ok: false, observed: `nowhere to put it toward ${args.toward}`, error: `no ${args.toward} in sight, or both cells beside you that way are taken` };
      try {
        await placeItemAt(ctx, args.block, beside);
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        return { ok: false, observed: `could not place at ${beside.toString()}`, error: errMsg(err) };
      }
      return { ok: true, observed: `placed ${args.block} at ${beside.x},${beside.y},${beside.z}, beside you toward ${args.toward}` };
    }
    const target = at ? new Vec3(Math.floor(args.x ?? 0), Math.floor(args.y ?? 0), Math.floor(args.z ?? 0)) : await spotOrNotch(ctx, itemMatcher(args.block).label);
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
export async function centerOnBlock(ctx: SkillContext): Promise<void> {
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

/** Monsters this near by day keep one in a shelter dug in. */
const BESIEGED_RANGE = 16;

export const shelter = defineSkill({
  name: 'shelter',
  description:
    'shelter {untilMorning?, untilHealed?} — dig into the ground and seal the top; with untilMorning, wait for day and climb out; with untilHealed, lie low until the health is back',
  // Until morning unless asked to lie low until healed: asked that by day (at 4 health), it said "it is already day"
  // and was out mining again at once.
  argsSchema: z.object({ untilMorning: z.coerce.boolean().optional(), untilHealed: z.coerce.boolean().default(false) }).transform((a) => ({ ...a, untilMorning: a.untilMorning ?? !a.untilHealed })),
  talkOverable: false,
  slipKinds: [],
  // The code-only brain's night (§22.4), not a mind's: hurt among monsters a player runs, digs into the wall and up,
  // and eats what they brought; nobody digs a hole in the floor to wait in (owner, 2026-10-24). A mind digs its own
  // way with tunnel, and waits with wait.
  codeOnly: true,
  expect: (args) => (args.untilMorning ? { kind: 'awakeAfterNight' } : { kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    stopMotion(bot);
    // By day with monsters about (down in the dark they don't burn), a hole sealed over is still the way to be safe:
    // at 1.5 health among five zombies and a skeleton in a cave, an agent was told "it is already day", twice, and
    // died. It lies low until they have gone.
    const besieged = isDaytime(bot) && nearbyHostiles(bot, BESIEGED_RANGE).length > 0;
    // Re-run in the morning (e.g. after a reflex interrupted the climb): just get out.
    if (args.untilMorning && !args.untilHealed && isDaytime(bot) && !besieged) {
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
    if (besieged) {
      const until = Date.now() + HEAL_MAX_MS;
      while (nearbyHostiles(bot, BESIEGED_RANGE).length > 0 && Date.now() < until) {
        await waitMs(ctx, 1000);
        const hole = shelterHole(bot);
        if (hole) return breached(hole);
      }
      return climbOut(ctx, nearbyHostiles(bot, BESIEGED_RANGE).length === 0 ? 'the monsters about gone' : 'waited long');
    }
    // Waiting for day, and watching the walls: a shelter broken open is no shelter, and the mind must know.
    while (!isDaytime(bot)) {
      await waitMs(ctx, 1000);
      const hole = shelterHole(bot);
      if (hole) return breached(hole);
    }
    return climbOut(ctx);
  },
});
