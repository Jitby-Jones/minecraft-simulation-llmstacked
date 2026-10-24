// Putting a blueprint up in the world (owner request, 2026-10-24: buildings, not shelters only). The site is cleared
// of what is in the way (trees, a hillside: dug top down) and the holes under it filled; then every block goes in as
// a player puts it: from where it can be reached, against a block already there, facing the way it must (a stair
// up the slope, a door into the room, a chest into the room, a torch on its wall, a log along its beam, a slab in
// the top half or the bottom). The order is the blueprint's (each block has something to go against) taken nearest
// first, so the builder walks little. The builder stands on what it has built, or on scaffolding of dirt or
// cobblestone that the pathfinder puts up, taken down again at the end; it never digs through its own work. Doors,
// beds, water, tilled ground, a flower in its pot and a stripped log each go in their own way. What it lacks it
// leaves out and says, and a second go carries on where the first stopped.

import type { BuildProject } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { type Blueprint, type Entrance, otherHalf, support } from '../../building/compile';
import { type Need, billOf, costOf, planMaterials, substitute } from '../../building/materials';
import type { Building } from '../../building/repertoire';
import { type BlockState, type Facing, FACINGS, facingVec, itemFor, opposite, parseState, rotatePos, rotateState, secondHalf, turnRight } from '../../building/state';
import { USABLE_BLOCK, isAirLike, isSolid } from '../world';
import { makeTool } from './tools';
import { type Footprint, type SkillContext, SkillAbortedError } from './types';
import { abortable, digBlock, errMsg, goals, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';

/** Where a blueprint goes: its box's north-west corner at the ground's top layer, and how far it is turned. */
export interface Site {
  origin: Vec3;
  /** Quarter turns clockwise, seen from above. */
  turn: number;
}

export interface Planned {
  pos: Vec3;
  state: BlockState;
  /** Comes with the block before it (a door's top, a bed's head). */
  second: boolean;
}

/** The box's size on the ground once turned. */
export function turnedSize(bp: Pick<Blueprint, 'size'>, turn: number): { x: number; z: number } {
  return turn % 2 === 0 ? { x: bp.size.x, z: bp.size.z } : { x: bp.size.z, z: bp.size.x };
}

const turnFacing = (f: Facing, turn: number): Facing => {
  let out = f;
  for (let i = 0; i < ((turn % 4) + 4) % 4; i++) out = turnRight(out);
  return out;
};

/** The turn that has a blueprint's door face `toward`. */
export function turnToFace(entrance: Pick<Entrance, 'out'> | null, toward: Facing): number {
  if (!entrance) return 0;
  return (FACINGS.indexOf(toward) - FACINGS.indexOf(entrance.out) + 4) % 4;
}

/** The blueprint's blocks and empty cells where they go in the world, blocks in its placing order. */
export function inWorld(bp: Blueprint, site: Site): { blocks: Planned[]; air: Vec3[]; entrance: (Entrance & { pos: Vec3 }) | null } {
  const at = (c: { x: number; y: number; z: number }) => {
    const p = rotatePos(c, bp.size.x, bp.size.z, site.turn);
    return site.origin.offset(p.x, p.y, p.z);
  };
  const blocks = bp.blocks.map((b) => {
    const s = rotateState(parseState(b.state), site.turn);
    return { pos: at(b), state: s, second: secondHalf(s) };
  });
  const e = bp.entrance;
  return { blocks, air: bp.air.map(at), entrance: e ? { ...e, out: turnFacing(e.out, site.turn), pos: at(e) } : null };
}

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
/** Yaw (mineflayer) to face a compass way: north 0, west π/2, south π, east -π/2. */
export const yawOf = (f: Facing): number => (f === 'north' ? 0 : f === 'west' ? Math.PI / 2 : f === 'south' ? Math.PI : -Math.PI / 2);
const DOWN = new Vec3(0, -1, 0);
const UP = new Vec3(0, 1, 0);
const SIDES = FACINGS.map((f) => new Vec3(facingVec(f).x, 0, facingVec(f).z));
/** Faces the one who placed it. */
const FACES_PLACER = /^(chest|trapped_chest|ender_chest|furnace|smoker|blast_furnace|lectern|loom|stonecutter|beehive|bee_nest|carved_pumpkin|jack_o_lantern|.*_glazed_terracotta)$/;
/** Blocks the builder may stand on while building and take down after: what the pathfinder towers with. */
const SCAFFOLD = /^(dirt|cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|stone|tuff)$/;
/** In the way of a block but gone with a touch (or placed over). */
const SOFT = /^(short_grass|tall_grass|grass|fern|large_fern|dead_bush|snow|seagrass|tall_seagrass|vine|glow_lichen|.*_sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|brown_mushroom|red_mushroom|torchflower|pink_petals|leaf_litter|bush|firefly_bush|short_dry_grass|tall_dry_grass|wildflowers)$/;
/** Found where the ground is, never the building's own. */
const NOT_GROUND = /_(leaves|log|wood)$|^(snow|water|lava)$/;

/** The way the one placing it must face for it to face the way it must (null: any). */
export function placerFacing(s: BlockState): Facing | null {
  const f = s.props.facing as Facing | undefined;
  if (!f || !FACINGS.includes(f)) return null;
  if (/_stairs$|_door$|_bed$|_fence_gate$|^campfire$|^soul_campfire$/.test(s.name)) return f;
  if (FACES_PLACER.test(s.name) || s.name === 'barrel') return opposite(f);
  // An anvil turns a quarter clockwise from the one placing it.
  if (/anvil$/.test(s.name)) return turnRight(turnRight(turnRight(f)));
  return null;
}

export interface Click {
  ref: Block;
  /** The face of `ref` clicked (pointing at the new block). */
  face: Vec3;
  half?: 'top' | 'bottom';
  yaw?: number;
  pitch?: number;
}

/** Where to click to put `s` at `pos` the right way round: against which block, which face of it, which half. */
export function clickFor(bot: Bot, pos: Vec3, s: BlockState): Click | null {
  let dirs: Vec3[];
  let half: 'top' | 'bottom' | undefined;
  const sup = support(s);
  const f = s.props.facing as Facing | undefined;
  if (sup === 'behind' && f) dirs = [new Vec3(-facingVec(f).x, 0, -facingVec(f).z)];
  else if (sup === 'below') dirs = [DOWN];
  else if (/_slab$/.test(s.name) || /_stairs$/.test(s.name)) {
    half = s.props.type === 'top' || s.props.half === 'top' ? 'top' : 'bottom';
    dirs = half === 'top' ? [UP, ...SIDES] : [DOWN, ...SIDES];
  } else if (/_trapdoor$/.test(s.name)) {
    half = s.props.half === 'top' ? 'top' : 'bottom';
    dirs = f ? [new Vec3(-facingVec(f).x, 0, -facingVec(f).z), half === 'top' ? UP : DOWN] : [DOWN];
  } else if (s.props.axis) {
    const along = s.props.axis === 'x' ? [new Vec3(-1, 0, 0), new Vec3(1, 0, 0)] : s.props.axis === 'z' ? [new Vec3(0, 0, -1), new Vec3(0, 0, 1)] : [DOWN, UP];
    // A log the wrong way rather than none.
    dirs = [...along, ...[DOWN, ...SIDES, UP].filter((d) => !along.some((a) => a.equals(d)))];
  } else if (s.name === 'lantern' || s.name === 'soul_lantern') dirs = s.props.hanging === 'true' ? [UP] : [DOWN];
  else dirs = [DOWN, ...SIDES, UP];
  for (const d of dirs) {
    const ref = bot.blockAt(pos.plus(d));
    if (!ref || !isSolid(ref)) continue;
    const face = d.scaled(-1);
    // A trapdoor against a side takes its facing from that side; against the block above or below, it faces away
    // from the one placing it.
    const pf = /_trapdoor$/.test(s.name) ? (d.y !== 0 && f && FACINGS.includes(f) ? opposite(f) : null) : placerFacing(s);
    let pitch: number | undefined;
    // A lantern hangs when placed looking up; a barrel faces away from where it is looked at from.
    if (s.name === 'lantern' || s.name === 'soul_lantern') pitch = s.props.hanging === 'true' ? 1.2 : -1.2;
    if (s.name === 'barrel' && (f === undefined || s.props.facing === 'up' || s.props.facing === 'down')) pitch = s.props.facing === 'down' ? 1.5 : -1.5;
    return { ref, face, ...(d.y === 0 && half ? { half } : {}), ...(pf ? { yaw: yawOf(pf) } : {}), ...(pitch !== undefined ? { pitch } : {}) };
  }
  return null;
}

/** Same block as wanted, near enough (a pane's connections, a stair's corner shape are the game's own). */
export function sameBlock(b: Block | null, s: BlockState): boolean {
  if (!b) return false;
  if (b.name !== s.name) {
    // A bed of another colour, carpet or wool of another colour, is still the bed.
    const loose = (n: string) => n.replace(/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(bed|carpet|wool)$/, '$2');
    if (loose(b.name) !== loose(s.name) || loose(s.name) === s.name) return false;
  }
  const props = (b.getProperties?.() ?? {}) as Record<string, string | number | boolean>;
  for (const k of ['facing', 'half', 'type', 'part', 'hanging']) {
    if (s.props[k] !== undefined && props[k] !== undefined && String(props[k]) !== s.props[k]) return false;
  }
  return true;
}

/** Items that will do for a block, best first: its own; a bed or carpet of any colour; the same in another wood. */
export function itemsFor(s: BlockState): string[] {
  if (s.name.startsWith('potted_')) return ['flower_pot'];
  const own = itemFor(s.name);
  const out = [own];
  const colour = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(bed|carpet|wool)$/.exec(own);
  if (colour?.[2]) for (const c of ['white', 'red', 'yellow', 'blue', 'green', 'black', 'brown', 'orange', 'gray', 'light_gray', 'lime', 'cyan', 'purple', 'pink', 'magenta', 'light_blue']) out.push(`${c}_${colour[2]}`);
  const wood = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(planks|stairs|slab|fence|fence_gate|door|trapdoor|pressure_plate|button|sign)$/.exec(own);
  if (wood?.[2]) for (const w of ['oak', 'spruce', 'birch', 'dark_oak', 'jungle', 'acacia', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped']) out.push(`${w}_${wood[2]}`);
  // A stripped log is a log with an axe taken to it.
  if (own.startsWith('stripped_')) out.push(own.replace(/^stripped_/, ''));
  return [...new Set(out)];
}

/** The planks a block's wood is, for a lookalike in what we carry. */
function carried(bot: Bot, names: readonly string[]): { name: string; count: number } | null {
  for (const n of names) {
    const count = bot.inventory
      .items()
      .filter((i) => i.name === n)
      .reduce((a, i) => a + i.count, 0);
    if (count > 0) return { name: n, count };
  }
  return null;
}

/** The pathfinder's goal: somewhere to stand with the block to click within reach, not in the block's own cell. */
class GoalReach extends goals.GoalPlaceBlock {
  constructor(
    private readonly target: Vec3,
    bot: Bot,
    faces: Vec3[],
  ) {
    super(target, bot.world, { range: REACH, LOS: false, faces, facing: undefined as unknown as 'north' });
  }

  override isEnd(node: { x: number; y: number; z: number }): boolean {
    const dx = node.x - this.target.x;
    const dz = node.z - this.target.z;
    const dy = this.target.y - node.y;
    if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) return false;
    return super.isEnd(node as never);
  }
}

/** Blocks given up on one after another, nothing done between, before a build stops and says it can't get at them. */
const STUCK_AFTER = 8;

/** How far a block can be from the eyes to be placed or dug (the game allows 4.5 to its nearest side, and a little). */
const REACH = 4.4;

function eyes(bot: Bot): Vec3 {
  return bot.entity.position.offset(0, 1.62, 0);
}

function within(bot: Bot, pos: Vec3, reach = REACH): boolean {
  const e = eyes(bot);
  // To the nearest point of the block.
  const nx = Math.max(pos.x, Math.min(e.x, pos.x + 1));
  const ny = Math.max(pos.y, Math.min(e.y, pos.y + 1));
  const nz = Math.max(pos.z, Math.min(e.z, pos.z + 1));
  return e.distanceTo(new Vec3(nx, ny, nz)) <= reach;
}

/** Our body is in that cell (a block can't go where we stand). */
function inMyWay(bot: Bot, pos: Vec3): boolean {
  const p = bot.entity.position;
  const w = 0.3;
  return p.x + w > pos.x && p.x - w < pos.x + 1 && p.z + w > pos.z && p.z - w < pos.z + 1 && p.y < pos.y + 1 && p.y + 1.8 > pos.y;
}

/** Someone else, or an animal, in that cell. */
function occupied(bot: Bot, pos: Vec3): boolean {
  for (const e of Object.values(bot.entities)) {
    // Dropped items, orbs and arrows don't stand in a block's way; anyone or anything alive does.
    const t = e.type as string;
    if (e === bot.entity || !e.position || t === 'object' || t === 'orb' || t === 'projectile' || t === 'global' || t === 'other') continue;
    const w = (e.width ?? 0.6) / 2;
    const h = e.height ?? 1.8;
    if (e.position.x + w > pos.x && e.position.x - w < pos.x + 1 && e.position.z + w > pos.z && e.position.z - w < pos.z + 1 && e.position.y < pos.y + 1 && e.position.y + h > pos.y) return true;
  }
  return false;
}

export interface BuildReport {
  placed: number;
  /** Doors that would not go in: a building without its door is not finished. */
  doorsFailed: number;
  /** Already as wanted when we came to them. */
  already: number;
  total: number;
  /** What we lacked, by item. */
  missing: Record<string, number>;
  /** Blocks we could not get to or put in (not for want of the item). */
  failed: number;
  dug: number;
  scaffoldTaken: number;
  stoppedFor?: string;
}

export interface ConstructOptions {
  /** Stop after this long (a second go carries on). */
  timeMs?: number;
  /** Clear the site first (dig what is in the way inside the box). */
  clear?: boolean;
  /** Ground-layer blocks to put under a block whose ground is missing. */
  fill?: readonly string[];
}

const FILL = ['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'stone', 'netherrack', 'gravel', 'sand'];

/** Walks to where `pos` can be reached (clicking toward one of `faces`, or digging it); false when there's no way. */
async function reach(ctx: SkillContext, pos: Vec3, faces: Vec3[] | null, timeoutMs = 25_000): Promise<boolean> {
  const { bot } = ctx;
  if (within(bot, pos) && !inMyWay(bot, pos)) return true;
  const goal = faces && faces.length > 0 ? new GoalReach(pos, bot, faces) : new goals.GoalLookAtBlock(pos, bot.world, { reach: REACH });
  try {
    await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(goal), timeoutMs), () => stopMotion(bot));
  } catch (err) {
    if (err instanceof SkillAbortedError) throw err;
    stopMotion(bot);
    ctx.logger.debug({ module: 'build', at: key(pos), from: key(bot.entity.position.floored()), err: errMsg(err) }, 'could not get near');
    // A stop asked of a moving pathfinder takes hold at its next step; the next walk set before then is wiped with it.
    await bot.waitForTicks(2);
    stopMotion(bot);
  }
  return within(bot, pos) && !inMyWay(bot, pos);
}

async function dig(ctx: SkillContext, b: Block, reachMs?: number): Promise<boolean> {
  const { bot } = ctx;
  if (!(await reach(ctx, b.position, null, reachMs))) return false;
  const now = bot.blockAt(b.position);
  if (!now || isAirLike(now) || now.name === 'water' || now.name === 'lava') return true;
  const tool = bot.pathfinder.bestHarvestTool(now);
  if (tool) await bot.equip(tool, 'hand');
  try {
    await digBlock(ctx, now);
  } catch (err) {
    if (err instanceof SkillAbortedError) throw err;
    ctx.logger.debug({ module: 'build', at: key(b.position), block: now.name, err: errMsg(err) }, 'could not dig');
    return false;
  }
  return isAirLike(bot.blockAt(b.position));
}

async function equipOne(bot: Bot, names: readonly string[]): Promise<string | null> {
  const have = carried(bot, names);
  if (!have) return null;
  const item = bot.inventory.items().find((i) => i.name === have.name);
  if (!item) return null;
  await bot.equip(item, 'hand');
  return have.name;
}

/** Clicks on a block with what is in hand (a hoe on dirt, an axe on a log, a flower on a pot). */
async function useOn(ctx: SkillContext, b: Block, face = UP): Promise<void> {
  const { bot } = ctx;
  await bot.lookAt(b.position.offset(0.5, 0.5 + face.y * 0.5, 0.5), true);
  await bot.activateBlock(b, face);
  await waitMs(ctx, 250);
}

/** Puts one block in, the right way round. Throws why not. */
async function placeOne(ctx: SkillContext, p: Planned): Promise<string> {
  const { bot } = ctx;
  const s = p.state;
  // Water: poured from a bucket onto the block below.
  if (s.name === 'water') {
    const below = bot.blockAt(p.pos.offset(0, -1, 0));
    if (!below || !isSolid(below)) throw new Error('nothing under it to pour water onto');
    if (!(await equipOne(bot, ['water_bucket']))) throw new Error('missing:water_bucket');
    if (!(await reach(ctx, p.pos, [DOWN]))) throw new Error('could not get to it');
    await bot.lookAt(p.pos.offset(0.5, 0.05, 0.5), true);
    bot.activateItem();
    await waitMs(ctx, 300);
    bot.deactivateItem();
    return 'water_bucket';
  }
  // Tilled ground: earth, then a hoe on it.
  if (s.name === 'farmland') {
    let here = bot.blockAt(p.pos);
    if (!here || !/^(dirt|grass_block|dirt_path|coarse_dirt|rooted_dirt)$/.test(here.name)) {
      await placeOne(ctx, { pos: p.pos, state: { name: 'dirt', props: {} }, second: false });
      here = bot.blockAt(p.pos);
    }
    if (!here) throw new Error('no earth to till');
    if (!carried(bot, ['wooden_hoe', 'stone_hoe', 'iron_hoe', 'golden_hoe', 'diamond_hoe', 'netherite_hoe']) && !(await makeTool(ctx, 'wooden_hoe'))) throw new Error('missing:wooden_hoe');
    await equipOne(bot, ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'golden_hoe', 'wooden_hoe']);
    if (!(await reach(ctx, p.pos, null))) throw new Error('could not get to it');
    await useOn(ctx, here);
    return 'dirt';
  }
  const items = itemsFor(s);
  const have = carried(bot, items);
  if (!have) throw new Error(`missing:${items[0] ?? s.name}`);
  // A stripped log from a plain one: put the log in, then an axe to it.
  const strip = s.name.startsWith('stripped_') && !have.name.startsWith('stripped_');
  const placing: BlockState = strip ? { name: have.name, props: s.props } : s;
  const click = clickFor(bot, p.pos, placing);
  if (!click) throw new Error('nothing yet to put it against');
  if (!(await reach(ctx, p.pos, [click.ref.position.minus(p.pos)]))) throw new Error('could not get to it');
  if (inMyWay(bot, p.pos)) throw new Error('standing in the way');
  if (occupied(bot, p.pos)) throw new Error('someone is in the way');
  const item = bot.inventory.items().find((i) => i.name === have.name);
  if (!item) throw new Error(`missing:${have.name}`);
  await bot.equip(item, 'hand');
  throwIfAborted(ctx.signal);
  // Face the way it must face; look at where we click.
  const at = click.ref.position.offset(0.5 + click.face.x * 0.5, 0.5 + click.face.y * 0.5 + (click.half === 'top' ? 0.25 : click.half === 'bottom' ? -0.25 : 0), 0.5 + click.face.z * 0.5);
  const d = at.minus(eyes(bot));
  const yaw = click.yaw ?? Math.atan2(-d.x, -d.z);
  const pitch = click.pitch ?? Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z));
  await bot.look(yaw, pitch, true);
  // Against a chest or a door a click would use it: sneak, as players do.
  const sneak = USABLE_BLOCK.test(click.ref.name);
  if (sneak) bot.setControlState('sneak', true);
  await bot.waitForTicks(1);
  try {
    const placer = bot as unknown as { _placeBlockWithOptions: (ref: Block, face: Vec3, o: object) => Promise<void> };
    await placer._placeBlockWithOptions(click.ref, click.face, { forceLook: 'ignore', swingArm: 'right', ...(click.half ? { half: click.half } : {}) });
  } finally {
    if (sneak) bot.setControlState('sneak', false);
  }
  const placed = bot.blockAt(p.pos);
  // The second slab of a double one, on the first.
  if (s.name.endsWith('_slab') && s.props.type === 'double' && placed && String(placed.getProperties?.().type) !== 'double') {
    const again = bot.inventory.items().find((i) => i.name === have.name);
    if (again) {
      await bot.equip(again, 'hand');
      await useOn(ctx, placed, UP);
    }
  }
  if (strip && placed) {
    if (!carried(bot, ['wooden_axe', 'stone_axe', 'iron_axe', 'golden_axe', 'diamond_axe', 'netherite_axe'])) await makeTool(ctx, 'wooden_axe');
    if (await equipOne(bot, ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'])) await useOn(ctx, placed, click.face);
  }
  // A flower in its pot.
  if (s.name.startsWith('potted_') && placed) {
    const flower = s.name.replace(/^potted_/, '');
    if (await equipOne(bot, [flower])) await useOn(ctx, placed, UP);
  }
  return have.name;
}

/** Whether a block can go in now: what it must go against is there (the same as where we would click). */
function ready(bot: Bot, p: Planned): boolean {
  if (p.state.name === 'water' || p.state.name === 'farmland') return isSolid(bot.blockAt(p.pos.offset(0, -1, 0)));
  const s = p.state.name.startsWith('stripped_') ? { name: p.state.name.replace(/^stripped_/, ''), props: p.state.props } : p.state;
  return clickFor(bot, p.pos, s) !== null;
}

/**
 * Builds `bp` at `site`: clears what is in the way, fills the ground under it, puts every block in (what we carry of
 * it), takes the scaffolding down. Blocks already as wanted are left alone, so a second go carries on.
 */
export async function construct(ctx: SkillContext, bp: Blueprint, site: Site, opts: ConstructOptions = {}): Promise<BuildReport> {
  const { bot } = ctx;
  const deadline = Date.now() + (opts.timeMs ?? 15 * 60_000);
  const plan = inWorld(bp, site);
  const wanted = new Map(plan.blocks.map((b) => [key(b.pos), b]));
  const report: BuildReport = { placed: 0, doorsFailed: 0, already: 0, total: plan.blocks.filter((b) => !b.second).length, missing: {}, failed: 0, dug: 0, scaffoldTaken: 0 };
  const lack = (item: string) => (report.missing[item] = (report.missing[item] ?? 0) + 1);
  const size = turnedSize(bp, site.turn);

  // A walk of whatever ran before is over first (a stop still pending would wipe the first walk here).
  stopMotion(bot);
  await bot.waitForTicks(2);
  // While building: never dig through what is built; no scaffolding where a block or a room is meant to be.
  const m = ctx.movements();
  const keep = (b: Block) => {
    const w = wanted.get(key(b.position));
    return w && sameBlock(b, w.state) ? 100 : 0;
  };
  const airCells = new Set(plan.air.map(key));
  const noScaffold = (b: Block) => (wanted.has(key(b.position)) || airCells.has(key(b.position)) ? 30 : 0);
  const doorsBefore = m.canOpenDoors;
  m.exclusionAreasBreak.push(keep);
  m.exclusionAreasPlace.push(noScaffold);
  m.canOpenDoors = true;
  bot.pathfinder.setMovements(m);
  // What we put up that isn't the building (the pathfinder's towers and bridges) comes down at the end; the ground we
  // filled under the floor stays.
  const ours = new Set<string>();
  const filled = new Set<string>();
  const onPlaced = (_old: unknown, placed: { position: Vec3 }) => ours.add(key(placed.position));
  (bot as unknown as { on(ev: 'blockPlaced', f: typeof onPlaced): void }).on('blockPlaced', onPlaced);
  try {
    // 1. Clear the box of what is in the way, from the top down (sand and gravel fall).
    if (opts.clear !== false) {
      const inTheWay: Vec3[] = [];
      // Every cell of it, the second halves too: a door's top or a bed's head can't go into earth.
      for (const p of [...plan.air, ...plan.blocks.map((b) => b.pos)]) {
        const here = bot.blockAt(p);
        if (!here || isAirLike(here)) continue;
        const w = wanted.get(key(p));
        if (w && sameBlock(here, w.state)) continue;
        // The ground layer itself is dug only where the building puts something of its own.
        if (p.y <= site.origin.y && !w) continue;
        if (here.name === 'water' || here.name === 'lava') continue;
        inTheWay.push(p);
      }
      // Above the building, inside its box: trees, a hillside.
      for (let x = site.origin.x; x < site.origin.x + size.x; x++) {
        for (let z = site.origin.z; z < site.origin.z + size.z; z++) {
          for (let y = site.origin.y + 1; y <= site.origin.y + bp.size.y + 1; y++) {
            const p = new Vec3(x, y, z);
            if (wanted.has(key(p)) || airCells.has(key(p))) continue;
            const here = bot.blockAt(p);
            if (here && !isAirLike(here) && here.name !== 'water' && here.name !== 'lava' && (NOT_GROUND.test(here.name) || isSolid(here))) inTheWay.push(p);
          }
        }
      }
      // Earth to be tilled stays where it is.
      const tillable = (p: Vec3) => wanted.get(key(p))?.state.name === 'farmland' && /^(dirt|grass_block|coarse_dirt|rooted_dirt|dirt_path)$/.test(bot.blockAt(p)?.name ?? '');
      const order = [...new Map(inTheWay.filter((p) => !tillable(p)).map((p) => [key(p), p])).values()].sort((a, b) => b.y - a.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
      if (order.length > 0) ctx.progress(`clearing the site: ${order.length} blocks in the way`);
      // In passes, from the top: what can't be got at yet (the top of a tree, seen past its own leaves) waits for what
      // is under and around it to come away, and leaves left over once the logs are gone fall by themselves.
      let left = order;
      for (let pass = 0; pass < 4 && left.length > 0; pass++) {
        const missed: Vec3[] = [];
        let gone = 0;
        let stuck = 0;
        let i = 0;
        for (; i < left.length; i++) {
          const p = left[i];
          if (!p) continue;
          throwIfAborted(ctx.signal);
          if (Date.now() > deadline) {
            report.stoppedFor = 'out of time clearing the site';
            return report;
          }
          const b = bot.blockAt(p);
          if (!b || isAirLike(b)) continue;
          if (SOFT.test(b.name) || (await dig(ctx, b, 12_000))) {
            report.dug++;
            gone++;
            stuck = 0;
          } else {
            missed.push(p);
            // One after another out of reach, nothing coming away: on to the next pass rather than all of them.
            if (++stuck >= STUCK_AFTER) break;
          }
        }
        // What wasn't got at, and what this pass didn't come to; not what has gone since, nor grass (placing over it does).
        const rest = [...missed, ...left.slice(i + 1)].filter((p) => {
          const b = bot.blockAt(p);
          return b !== null && !isAirLike(b) && !SOFT.test(b.name);
        });
        if (rest.length === 0) break;
        if (gone === 0) {
          // Nothing came away this pass: leaves alone left may fall by themselves; anything else can't be got at.
          if (!rest.every((p) => /_leaves$/.test(bot.blockAt(p)?.name ?? ''))) {
            report.stoppedFor = 'could not get at what is in the way';
            return report;
          }
          for (let t = 0; t < 30 && rest.some((p) => !isAirLike(bot.blockAt(p))); t++) await waitMs(ctx, 1000);
        }
        left = rest;
      }
    }

    // 2. Ground under the building: a hole under the ground layer is filled, so the floor has something under it. Under
    // a block of the ground layer that is the three below it; under one standing on the ground (a fence post), the
    // ground itself and two below. Deepest first, each only once there is something under it (else from the side).
    const fills = opts.fill ?? FILL;
    const columns = new Map<string, Vec3>();
    for (const b of plan.blocks) if (b.pos.y <= site.origin.y + 1) columns.set(`${b.pos.x},${b.pos.z}`, b.pos);
    for (const c of columns.values()) {
      const top = wanted.has(key(new Vec3(c.x, site.origin.y, c.z))) ? site.origin.y - 1 : site.origin.y;
      for (let y = top - 2; y <= top; y++) {
        const p = new Vec3(c.x, y, c.z);
        if (wanted.has(key(p)) || isSolid(bot.blockAt(p))) continue;
        if (y < top && !isSolid(bot.blockAt(p.offset(0, -1, 0)))) continue;
        throwIfAborted(ctx.signal);
        const fill = carried(bot, fills);
        if (!fill) {
          lack('dirt');
          break;
        }
        try {
          await placeOne(ctx, { pos: p, state: { name: fill.name, props: {} }, second: false });
          filled.add(key(p));
        } catch (err) {
          if (err instanceof SkillAbortedError) throw err;
        }
      }
    }

    // 3. The blocks, nearest first among those that can go in now.
    const pending = plan.blocks.filter((b) => {
      if (b.second) return false;
      if (sameBlock(bot.blockAt(b.pos), b.state)) {
        report.already++;
        return false;
      }
      return true;
    });
    const tries = new Map<string, number>();
    const skip = new Set<string>();
    let progress = 0;
    let stuck = 0;
    for (let round = 0; pending.length > 0 && round < 20_000; round++) {
      throwIfAborted(ctx.signal);
      if (Date.now() > deadline) {
        report.stoppedFor = 'out of time';
        break;
      }
      const can = pending.filter((b) => !skip.has(key(b.pos)) && ready(bot, b));
      if (can.length === 0) break;
      const me = bot.entity.position;
      const near = can.filter((b) => within(bot, b.pos) && !inMyWay(bot, b.pos));
      // In reach: lowest first, then nearest; else walk to the nearest of the lowest.
      const pick = (near.length > 0 ? near : can).sort((a, b) => a.pos.y - b.pos.y || a.pos.distanceTo(me) - b.pos.distanceTo(me))[0];
      if (!pick) break;
      const k = key(pick.pos);
      try {
        // Its cell clear, and its other half's (a door's top, a bed's head).
        const other = otherHalf(pick.pos, pick.state);
        for (const cell of [pick.pos, ...(other ? [new Vec3(other.x, other.y, other.z)] : [])]) {
          const here = bot.blockAt(cell);
          if (here && !isAirLike(here) && !(cell === pick.pos && sameBlock(here, pick.state)) && here.name !== 'water') {
            if (!(SOFT.test(here.name) && pick.state.name !== 'water') && !(await dig(ctx, here))) throw new Error(`could not clear the ${here.name} there`);
            report.dug++;
          }
        }
        await placeOne(ctx, pick);
        if (sameBlock(bot.blockAt(pick.pos), pick.state) || (pick.state.name === 'farmland' && bot.blockAt(pick.pos)?.name === 'farmland')) {
          report.placed++;
          stuck = 0;
          pending.splice(pending.indexOf(pick), 1);
          if (++progress % 10 === 0) ctx.progress(`building ${bp.name}: ${report.already + report.placed}/${report.total}`);
        } else throw new Error(`it came out as ${bot.blockAt(pick.pos)?.name ?? 'nothing'}`);
      } catch (err) {
        if (err instanceof SkillAbortedError) throw err;
        const msg = errMsg(err);
        const missing = /^missing:(.+)$/.exec(msg)?.[1];
        if (missing) {
          lack(missing);
          skip.add(k);
          pending.splice(pending.indexOf(pick), 1);
          continue;
        }
        const n = (tries.get(k) ?? 0) + 1;
        tries.set(k, n);
        ctx.logger.debug({ module: 'build', at: k, block: pick.state.name, err: msg, tries: n }, 'block not placed');
        if (n >= 3) {
          skip.add(k);
          report.failed++;
          if (/_door$/.test(pick.state.name)) report.doorsFailed++;
          // Block after block given up on, nothing placed between: stop and say so.
          if (++stuck >= STUCK_AFTER) {
            report.stoppedFor = 'could not get at the blocks';
            break;
          }
        }
      }
    }
    report.failed += pending.filter((b) => !skip.has(key(b.pos))).length;

    // 4. Scaffolding down: what we put up that the building doesn't want, from the top.
    const left = [...ours]
      .filter((k) => !wanted.has(k) && !filled.has(k))
      .map((k) => {
        const [x = 0, y = 0, z = 0] = k.split(',').map(Number);
        return new Vec3(x, y, z);
      })
      .filter((p) => SCAFFOLD.test(bot.blockAt(p)?.name ?? ''))
      .sort((a, b) => b.y - a.y);
    for (const p of left) {
      throwIfAborted(ctx.signal);
      const b = bot.blockAt(p);
      if (b && SCAFFOLD.test(b.name) && (await dig(ctx, b))) report.scaffoldTaken++;
    }
    // Out through the door, onto the step outside.
    if (plan.entrance) {
      const v = facingVec(plan.entrance.out);
      const step = plan.entrance.pos.offset(v.x * 2, 0, v.z * 2);
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNear(step.x, step.y, step.z, 1)), 20_000), () => stopMotion(bot)).catch((err: unknown) => {
        if (err instanceof SkillAbortedError) throw err;
      });
    }
    return report;
  } finally {
    (bot as unknown as { off(ev: 'blockPlaced', f: typeof onPlaced): void }).off('blockPlaced', onPlaced);
    m.exclusionAreasBreak.splice(m.exclusionAreasBreak.indexOf(keep), 1);
    m.exclusionAreasPlace.splice(m.exclusionAreasPlace.indexOf(noScaffold), 1);
    m.canOpenDoors = doorsBefore;
    bot.pathfinder.setMovements(m);
  }
}

// --- where to build ----------------------------------------------------------------------------------------------

/** The ground's top block at (x, z) near height y: solid, not a tree, with room over it; null when none or water. */
function groundAt(bot: Bot, x: number, z: number, y: number): number | null | 'water' {
  for (let yy = y + 12; yy >= y - 12; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z));
    if (!b) return null;
    if (b.name === 'water' || b.name === 'lava') return 'water';
    if (isSolid(b) && !NOT_GROUND.test(b.name)) return yy;
  }
  return null;
}

/**
 * Where a building asked for at `origin` stands: there, unless that is well above the ground under it, and then on
 * that ground (its middle height). A height taken from the treetops put a hut five blocks up in the air, its door out
 * of reach of the two who built it.
 */
export function onTheGround(bot: Bot, origin: Vec3, size: { x: number; z: number }): Vec3 {
  const hs: number[] = [];
  for (let x = origin.x; x < origin.x + size.x; x++) {
    for (let z = origin.z; z < origin.z + size.z; z++) {
      const g = groundAt(bot, x, z, origin.y);
      if (typeof g === 'number') hs.push(g);
    }
  }
  const level = [...hs].sort((a, b) => a - b)[Math.floor(hs.length / 2)];
  return level !== undefined && origin.y > level + 2 ? new Vec3(origin.x, level, origin.z) : origin;
}

export interface SiteChoice extends Site {
  /** Blocks to dig and to fill to level it, and trees to fell. */
  work: number;
}

/**
 * The best place near `center` for a building `size` (turned): level ground best, but a hillside or a wood does if
 * nothing better is near (its earth is dug away, its holes filled); never water, never on another building
 * (`avoid`: the ground they take, kept 3 clear). `work` is how much digging and filling it takes.
 */
export function findBuildSite(
  bot: Bot,
  size: { x: number; z: number },
  center: Vec3,
  opts: { radius?: number; minDist?: number; avoid?: readonly Footprint[]; maxWork?: number } = {},
): SiteChoice | null {
  const radius = opts.radius ?? 24;
  const minDist = opts.minDist ?? 3;
  const c = center.floored();
  const heights = new Map<string, number | null | 'water'>();
  const h = (x: number, z: number) => {
    const k = `${x},${z}`;
    if (!heights.has(k)) heights.set(k, groundAt(bot, x, z, c.y));
    return heights.get(k) ?? null;
  };
  const maxWork = opts.maxWork ?? size.x * size.z * 3;
  let best: SiteChoice | null = null;
  let bestScore = Infinity;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const x0 = c.x + dx - Math.floor(size.x / 2);
      const z0 = c.z + dz - Math.floor(size.z / 2);
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist || dist > radius) continue;
      // Three clear of anything else built.
      if ((opts.avoid ?? []).some((a) => a.x1 >= x0 - 3 && a.x0 <= x0 + size.x + 2 && a.z1 >= z0 - 3 && a.z0 <= z0 + size.z + 2)) continue;
      const hs: number[] = [];
      let bad = false;
      for (let x = x0 - 1; x <= x0 + size.x && !bad; x++) {
        for (let z = z0 - 1; z <= z0 + size.z && !bad; z++) {
          const v = h(x, z);
          if (v === null || v === 'water') bad = true;
          else hs.push(v);
        }
      }
      if (bad || hs.length === 0) continue;
      const sorted = [...hs].sort((a, b) => a - b);
      const level = sorted[Math.floor(sorted.length / 2)] ?? c.y;
      let work = 0;
      for (const v of hs) work += Math.abs(v - level) * (v > level ? 1 : 1.5);
      // Trees on it are felled.
      for (let x = x0; x < x0 + size.x; x += 2) for (let z = z0; z < z0 + size.z; z += 2) if (/_log$/.test(bot.blockAt(new Vec3(x, level + 1, z))?.name ?? '')) work += 6;
      if (work > maxWork) continue;
      const score = work + dist * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = { origin: new Vec3(x0, level, z0), turn: 0, work: Math.round(work) };
      }
    }
  }
  return best;
}

/** Which way is `to` from `from`, by the compass. */
export function facingToward(from: { x: number; z: number }, to: { x: number; z: number }): Facing {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : dz > 0 ? 'south' : 'north';
}

// --- the skill's part ------------------------------------------------------------------------------------------

const WOOD_NAMES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'];

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((a, i) => a + i.count, 0);
}

/** Planks' worth of a wood we carry (a log is four). */
function woodHeld(bot: Bot, wood: string): number {
  return count(bot, `${wood}_planks`) + 4 * (count(bot, `${wood}_log`) + count(bot, `stripped_${wood}_log`) + count(bot, `${wood}_wood`));
}

/** The wood a blueprint is mostly of. */
function mainWood(bp: Blueprint): string | null {
  const n = new Map<string, number>();
  for (const b of bp.blocks) {
    const name = parseState(b.state).name.replace(/^stripped_/, '');
    const w = [...WOOD_NAMES].sort((a, c) => c.length - a.length).find((x) => name.startsWith(`${x}_`));
    if (w) n.set(w, (n.get(w) ?? 0) + 1);
  }
  return [...n].sort((a, c) => c[1] - a[1])[0]?.[0] ?? null;
}

/** A blueprint with its blocks swapped as decided (`from → to`, by block name), keeping their state. */
export function withSwaps(bp: Blueprint, swaps: Readonly<Record<string, string>>): Blueprint {
  if (Object.keys(swaps).length === 0) return bp;
  return {
    ...bp,
    blocks: bp.blocks.map((b) => {
      const s = parseState(b.state);
      const to = swaps[s.name];
      return to ? { ...b, state: b.state.replace(/^[a-z0-9_]+/, to) } : b;
    }),
  };
}

export interface DesignBuildArgs {
  x?: number;
  y?: number;
  z?: number;
  facing?: Facing;
}

/**
 * The `build` skill for one of the village's designs: carries on a building begun, or begins one (at x,y,z, else the
 * best site near home, its door toward home), in the wood we carry and with lookalikes for what we can't get; says
 * what it still lacks. Too little in hand to make a start: it says what to get, and builds nothing.
 */
export async function buildDesign(
  ctx: SkillContext,
  query: string,
  at: DesignBuildArgs,
  repertoire: () => Promise<{ find(q: string): Building | undefined; list(o?: { vanilla?: boolean }): Building[]; blueprint(b: Building): Promise<Blueprint> }>,
): Promise<{ ok: boolean; observed: string; error?: string; data?: Record<string, unknown> }> {
  const { bot } = ctx;
  const rep = await repertoire();
  const b = rep.find(query);
  if (!b) {
    const known = rep
      .list({ vanilla: false })
      .map((x) => x.name)
      .slice(0, 16)
      .join(', ');
    return { ok: false, observed: `no design called ${query}`, error: `there is no design called "${query}"; the ones we know: ${known}` };
  }
  const base = await rep.blueprint(b);
  const prior = ctx.projects?.get(b.id) ?? null;
  let swaps: Record<string, string> = prior?.swaps ?? {};
  if (!prior) {
    // In the wood we have, if it isn't the design's; lookalikes for what is hard to get and we don't carry.
    const own = mainWood(base);
    const best = [...WOOD_NAMES].sort((a, c) => woodHeld(bot, c) - woodHeld(bot, a))[0];
    const wood = own && best && woodHeld(bot, best) > 2 * woodHeld(bot, own) ? best : undefined;
    const costs = costOf();
    const sub = substitute(base, { ...(wood ? { wood } : {}), cost: (item) => (count(bot, item) > 0 ? 0 : costs(item)) });
    swaps = {};
    for (const [i, blk] of base.blocks.entries()) {
      const from = parseState(blk.state).name;
      const to = parseState(sub.blueprint.blocks[i]?.state ?? blk.state).name;
      if (from !== to) swaps[from] = to;
    }
  }
  const bp = withSwaps(base, swaps);
  const total = bp.blocks.filter((x) => !secondHalf(parseState(x.state))).length;

  // Where.
  const home = ctx.home ?? bot.entity.position;
  let site: Site;
  if (prior) site = { origin: new Vec3(prior.origin.x, prior.origin.y, prior.origin.z), turn: prior.turn };
  else if (at.x !== undefined && at.y !== undefined && at.z !== undefined) {
    const asked = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
    const turn = turnToFace(bp.entrance, at.facing ?? facingToward({ x: asked.x + bp.size.x / 2, z: asked.z + bp.size.z / 2 }, home));
    const origin = onTheGround(bot, asked, turnedSize(bp, turn));
    if (origin.y !== asked.y) ctx.logger.info({ module: 'build', asked: asked.toString(), origin: origin.toString() }, 'down to the ground under it');
    site = { origin, turn };
  } else {
    const side = Math.max(bp.size.x, bp.size.z);
    ctx.progress(`looking for a place to build the ${b.name}`);
    const found = findBuildSite(bot, { x: side, z: side }, home, { avoid: ctx.projects?.taken() ?? [] });
    if (!found) return { ok: false, observed: 'no room', error: `no place near home for the ${b.name}: water, or too steep, everywhere` };
    const turn = turnToFace(bp.entrance, at.facing ?? facingToward({ x: found.origin.x + side / 2, z: found.origin.z + side / 2 }, home));
    const ts = turnedSize(bp, turn);
    site = { origin: found.origin.offset(Math.floor((side - ts.x) / 2), 0, Math.floor((side - ts.z) / 2)), turn };
  }

  // Enough in hand to make a start?
  const bill = billOf(bp);
  let held = 0;
  const short: Need[] = [];
  for (const [item, n] of bill) {
    const have = Math.min(n, count(bot, item));
    held += have;
    if (have < n) short.push({ item, count: n - have });
  }
  const blocks = [...bill.values()].reduce((a, n) => a + n, 0);
  const shopping = (needs: Need[]) => {
    const p = planMaterials(needs, { wood: mainWood(bp) ?? 'oak' });
    return p.raw
      .sort((x, y) => y.count - x.count)
      .slice(0, 6)
      .map((r) => `${r.count} ${r.item.replace(/_/g, ' ')}`)
      .join(', ');
  };
  if (!prior && held < blocks * 0.25) {
    const missing = Object.fromEntries(short.map((n) => [n.item, n.count]));
    return {
      ok: false,
      observed: `have ${held} of the ${blocks} blocks the ${b.name} takes`,
      error: `need materials first for the ${b.name}: ${short
        .sort((x, y) => y.count - x.count)
        .slice(0, 6)
        .map((n) => `${n.count} ${n.item.replace(/_/g, ' ')}`)
        .join(', ')} (from about ${shopping(short)})`,
      data: { design: b.id, missing },
    };
  }

  const placed = inWorld(bp, site);
  const project: BuildProject = prior ?? {
    design: b.id,
    name: b.name,
    origin: { x: site.origin.x, y: site.origin.y, z: site.origin.z },
    turn: site.turn,
    size: turnedSize(bp, site.turn),
    door: placed.entrance ? { x: placed.entrance.pos.x, y: placed.entrance.pos.y, z: placed.entrance.pos.z } : null,
    startedAt: Date.now(),
    placed: 0,
    total,
    missing: {},
    swaps,
    doneAt: null,
  };
  ctx.projects?.set(project);
  ctx.logger.info({ module: 'build', design: b.id, origin: project.origin, turn: site.turn, swaps, resumed: Boolean(prior) }, prior ? 'carrying on with a building' : 'starting a building');
  const report = await construct(ctx, bp, site);
  const inPlace = report.placed + report.already;
  const done = inPlace >= total - Math.max(2, Math.round(total * 0.03)) && Object.keys(report.missing).length === 0 && report.doorsFailed === 0;
  ctx.projects?.set({ ...project, placed: inPlace, missing: report.missing, doneAt: done ? Date.now() : null });
  const where = `${site.origin.x},${site.origin.y},${site.origin.z}`;
  const lacking = Object.entries(report.missing)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
    .map(([item, n]) => `${n} ${item.replace(/_/g, ' ')}`)
    .join(', ');
  const data = { design: b.id, origin: project.origin, turn: site.turn, placed: inPlace, total, missing: report.missing, ...(project.door ? { door: project.door } : {}) };
  if (done) return { ok: true, observed: `built the ${b.name} at ${where}${placed.entrance ? `, its door facing ${placed.entrance.out}` : ''} (${total} blocks)`, data };
  const why = lacking ? `still need ${lacking}` : report.stoppedFor ? report.stoppedFor : report.doorsFailed > 0 ? 'its door would not go in' : `${report.failed} blocks would not go in`;
  return { ok: false, observed: `put up ${inPlace} of the ${total} blocks of the ${b.name} at ${where}`, error: `the ${b.name} is not finished: ${why}`, data };
}
