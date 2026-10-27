// tunnel: digging one's way, the plain act a player does with a pickaxe in hand: a passage through the rock a way of
// one's choosing, a stair up to the open sky or down into the ground, and if one wants, the way behind closed with a
// block. What it is for (out of a cave and up to the surface, a nook in the wall out of reach, a way through a hill)
// is the mind's to know; this is only the hands (owner, 2026-10-24: hurt among monsters in a cave, a player runs, digs
// into the wall and up to the surface; nobody digs a hole in the floor to wait in). The digging is prospect's: water
// and lava walled off, gravel let down before stepping in, bedrock and stalactites left alone.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { isAirLike, isSolid, overlapsCell } from '../world';
import { centerOnBlock, isCover, placeItemAt, referenceFor } from './building';
import { lightTheWay } from './light';
import { BRIDGE_BLOCKS, Blocked, DIRS, bridge, clear, stepTo } from './prospecting';
import { errMsg, stopMotion, throwIfAborted, upTo, withTimeout } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

const ALONG = ['north', 'south', 'east', 'west'] as const;
type Along = (typeof ALONG)[number];

/** A way as a player says it: up (to the surface, out), down (deeper), or one of the four; of two, the first. */
function wayWord(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const w = v.trim().toLowerCase();
  if (/^(up|upward|upwards|out|above|surface|(to )?the surface|daylight|(to )?the sky|skyward)$/.test(w)) return 'up';
  if (/^(down|downward|downwards|deeper|below)$/.test(w)) return 'down';
  return /^(north|south|east|west)/.exec(w)?.[1] ?? v;
}

/** Steps up when no number is given: as many as it takes to the open sky, up to this. */
const MOST = 96;
const DEFAULT_ALONG = 3;
const DEFAULT_DOWN = 8;
/** How many steps in the way behind may be tried for closing before it's left open (a monster stood in it). */
const CLOSE_TRIES = 3;

/** Nothing over this cell to the top of the world, leaves aside: the sky over it. */
function skyOver(bot: Bot, cell: Vec3): boolean {
  const g = bot.game as unknown as { minY?: number; height?: number };
  const top = (g.minY ?? -64) + (g.height ?? 384);
  for (let y = cell.y + 1; y < top; y++) {
    const b = bot.blockAt(new Vec3(cell.x, y, cell.z));
    if (!b) return y > cell.y + 24;
    if (b.name === 'water' || b.name === 'lava') return false;
    if (b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false;
  }
  return true;
}

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/**
 * Out under the open sky: nothing over one's head, and open ground to walk off onto beside one's feet (room to stand,
 * a floor, the sky over it). A head out of the ground is not out: a stair stopped so had two blocks yet to climb.
 */
export function underTheSky(bot: Bot): boolean {
  const feet = bot.entity.position.floored();
  if (!skyOver(bot, feet.offset(0, 1, 0))) return false;
  return SIDES.some((s) => {
    const c = feet.plus(s);
    return isAirLike(bot.blockAt(c)) && isAirLike(bot.blockAt(c.offset(0, 1, 0))) && isSolid(bot.blockAt(c.offset(0, -1, 0))) && skyOver(bot, c.offset(0, 1, 0));
  });
}

/**
 * The way a stair goes, up or down, where it is not said: the one with the most rock along it, and nothing wet, as a
 * player digs into the wall rather than out across an open cave. Null when there is no rock any way.
 */
function rockiestWay(bot: Bot, rise: number, roll: number): Along | null {
  const feet = bot.entity.position.floored();
  const scores = ALONG.map((name) => {
    const d = DIRS[name] ?? new Vec3(1, 0, 0);
    let n = 0;
    for (let k = 1; k <= 8; k++) {
      for (const h of [0, 1, 2]) {
        const b = bot.blockAt(feet.plus(d.scaled(k)).offset(0, rise * k + h, 0));
        if (!b) continue;
        if (b.name === 'water' || b.name === 'lava') n -= 6;
        else if (isSolid(b)) n++;
      }
    }
    return { name, n };
  });
  const best = Math.max(...scores.map((s) => s.n));
  if (best <= 0) return null;
  const top = scores.filter((s) => s.n === best);
  return top[Math.floor(roll * top.length)]?.name ?? null;
}

/** Something else's body in that cell (a monster in the way): nothing goes in there. */
function occupied(bot: Bot, cell: Vec3): boolean {
  return Object.values(bot.entities).some((e) => e !== bot.entity && (e.type === 'mob' || e.type === 'hostile' || e.type === 'player') && overlapsCell(e, cell));
}

/**
 * The way we came, closed: the open cells right behind us at our feet and our head get a block each (cobblestone,
 * dirt, whatever whole block we carry that stays put). One with nothing to set it against (the step a stair came up
 * from, out in an open cave) is built up to from the floor. Null once nothing is left open there, else why not.
 */
async function closeBehind(ctx: SkillContext, at: Vec3, back: Vec3): Promise<string | null> {
  const { bot } = ctx;
  const block = () => bot.inventory.items().find((i) => BRIDGE_BLOCKS.includes(i.name)) ?? bot.inventory.items().find((i) => isCover(i.name));
  const first = block();
  if (!first) return 'no block on you to close it with';
  const top = at.plus(back).offset(0, 1, 0);
  let low = at.plus(back);
  for (let i = 0; i < 2 && isAirLike(bot.blockAt(low)) && !referenceFor(bot, low, first.name) && isAirLike(bot.blockAt(low.offset(0, -1, 0))); i++) low = low.offset(0, -1, 0);
  for (let y = low.y; y <= top.y; y++) {
    const cell = new Vec3(low.x, y, low.z);
    if (!isAirLike(bot.blockAt(cell))) continue;
    if (occupied(bot, cell)) return 'something stood in the way';
    const item = block();
    if (!item) return 'no block left on you to close it with';
    try {
      await placeItemAt(ctx, item.name, cell);
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      ctx.logger.debug({ module: 'skill', at: cell.toString(), err: errMsg(err) }, 'could not close the way behind');
      return `a block would not go in there (${errMsg(err)})`;
    }
  }
  return null;
}

export const tunnel = defineSkill({
  name: 'tunnel',
  description:
    'tunnel {direction, blocks?, close?, toward?, byHand?} — dig your way: north|south|east|west (a passage two high, 3 blocks if not said), up (a stair up, to the open sky unless blocks says how many steps), down (a stair down, 8 steps if not said); toward: the way a stair runs; close: put a block in the way behind you once you are in; byHand: on bare-handed through rock no pickaxe of yours can take (slow, and nothing drops)',
  argsSchema: z.object({
    direction: z.preprocess(wayWord, z.enum(['north', 'south', 'east', 'west', 'up', 'down'])),
    blocks: upTo(1, MOST, true).optional(),
    close: z.coerce.boolean().default(false),
    toward: z.preprocess(wayWord, z.enum(ALONG).optional()),
    byHand: z.coerce.boolean().optional(),
  }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const rise = args.direction === 'up' ? 1 : args.direction === 'down' ? -1 : 0;
    const toSky = args.direction === 'up' && args.blocks === undefined;
    if (toSky && underTheSky(bot)) return { ok: true, observed: 'already out under the open sky' };
    const limit = args.blocks ?? (args.direction === 'up' ? MOST : args.direction === 'down' ? DEFAULT_DOWN : DEFAULT_ALONG);
    const pick = (): Along => (rise === 0 ? (args.direction as Along) : (args.toward ?? rockiestWay(bot, rise, ctx.rng.next()) ?? ALONG[Math.floor(ctx.rng.next() * 4)] ?? 'east'));
    let way = pick();
    const tried = new Set<Along>([way]);
    let steps = 0;
    let closeTries = args.close ? CLOSE_TRIES : 0;
    let closed = false;
    let open = '';
    const stopped: string[] = [];
    const start = bot.entity.position.floored();
    try {
      while (steps < limit) {
        throwIfAborted(ctx.signal);
        if (toSky && underTheSky(bot)) break;
        const d = DIRS[way] ?? new Vec3(1, 0, 0);
        const feet = bot.entity.position.floored();
        const next = feet.plus(d).offset(0, rise, 0);
        try {
          // Room to rise into over our head for a step up; head room at our height for a step down.
          const how = { byHand: args.byHand === true };
          if (rise > 0) await clear(ctx, feet.offset(0, 2, 0), how);
          if (rise < 0) await clear(ctx, feet.plus(d).offset(0, 1, 0), how);
          await clear(ctx, next.offset(0, 1, 0), how);
          await clear(ctx, next, how);
          await bridge(ctx, next.offset(0, -1, 0));
        } catch (err) {
          if (!(err instanceof Blocked)) throw err;
          stopped.push(`${err.message} ${way}`);
          // A way along was the mind's choice, and stays its own to change; a stair turns, as up is up whichever way.
          const other = rise === 0 ? undefined : ALONG.find((w) => !tried.has(w));
          if (!other) throw err;
          way = other;
          tried.add(way);
          continue;
        }
        await withTimeout(stepTo(ctx, next), 10_000, 'could not step in where it was dug').catch((err: unknown) => {
          stopMotion(bot);
          throw err;
        });
        steps++;
        if (closeTries > 0 && !closed) {
          closeTries--;
          // In the middle of the cell first: just in over its edge, the block behind would go into one's own body.
          await centerOnBlock(ctx);
          const why = await closeBehind(ctx, next, d.scaled(-1));
          closed = why === null;
          open = why ?? '';
        }
        await lightTheWay(ctx);
        ctx.progress(rise > 0 ? `digging up, ${steps} steps` : rise < 0 ? `digging down, ${steps} steps` : `digging ${way}, ${steps} blocks`);
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      const at = bot.entity.position.floored();
      const why = err instanceof Blocked && stopped.length > 1 ? stopped.join(', ') : errMsg(err);
      return { ok: false, observed: `dug ${steps} ${rise === 0 ? 'blocks' : 'steps'}, from ${start.toString()} to ${at.toString()}${closed ? ', the way behind closed' : ''}`, error: why };
    }
    const at = bot.entity.position.floored();
    const out = toSky ? (underTheSky(bot) ? ', out under the open sky' : ', still under the ground') : '';
    const behind = args.close ? (closed ? '; the way behind closed' : `; the way behind left open: ${open || 'not dug far enough in to close it'}`) : '';
    const what = rise > 0 ? `dug a stair up ${steps} steps` : rise < 0 ? `dug a stair down ${steps} steps` : `dug ${steps} blocks ${way}`;
    return { ok: !toSky || underTheSky(bot), observed: `${what}, from ${start.toString()} to ${at.toString()}${out}${behind}`, ...(toSky && !underTheSky(bot) ? { error: `${MOST} steps up and still under the ground` } : {}) };
  },
});
