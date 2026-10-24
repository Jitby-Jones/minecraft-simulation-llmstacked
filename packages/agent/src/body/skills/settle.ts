// Moving the village (owner request, 2026-10-24: "communities that spawn in rough terrain may move in a group to find
// flatter, easier to build upon land"). `scout {for: "flat land"}` looks out from home for level ground with room for
// a village: the land in sight first (the ground everyone can see, §13 rule 4), then, if none, a walk out the most
// promising way and a look from there. `settle {x,y,z}` makes a place home: the village is where its people live, so
// one who has talked the others into moving goes there with them and settles. Talking it over, agreeing and going
// together are the agents' own (talk, consensus, follow); these only find the land and move the home.

import { z } from 'zod';
import { Vec3 } from 'vec3';
import { findBuildSite } from './construct';
import { defineSkill, type SkillContext } from './types';
import { abortable, errMsg, goals, gotoNear, stopMotion, throwIfAborted, withTimeout } from './util';

/** Room for a few houses: a square this wide with little digging and filling. */
const VILLAGE_SIDE = 15;
/** Little enough work for that square that it counts as easy land (about one block up or down in five). */
const EASY_WORK = 60;

/** How easy the land at `center` is to build a village on: the work a square of VILLAGE_SIDE takes there (lower is easier). */
export function landWork(ctx: SkillContext, center: Vec3, radius = 10): { origin: Vec3; work: number } | null {
  const site = findBuildSite(ctx.bot, { x: VILLAGE_SIDE, z: VILLAGE_SIDE }, center, { radius, minDist: 0, maxWork: VILLAGE_SIDE * VILLAGE_SIDE * 4 });
  return site ? { origin: site.origin, work: site.work } : null;
}

const WAYS = [
  [0, -1, 'north'],
  [1, -1, 'north-east'],
  [1, 0, 'east'],
  [1, 1, 'south-east'],
  [0, 1, 'south'],
  [-1, 1, 'south-west'],
  [-1, 0, 'west'],
  [-1, -1, 'north-west'],
] as const;

export const scout = defineSkill({
  name: 'scout',
  description: 'scout {for: "flat land", distance?} — look out from home for level ground with room for a village (to move to if home is on rough land): says how easy home is to build on and where better land is',
  argsSchema: z.object({ for: z.string().default('flat land'), distance: z.coerce.number().min(32).max(240).default(120) }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const home = (ctx.home ?? bot.entity.position).floored();
    const here = landWork(ctx, home);
    ctx.progress('looking at the land');
    const best: { pos: Vec3; work: number; way: string; dist: number }[] = [];
    const look = (from: Vec3) => {
      for (const [dx, dz, way] of WAYS) {
        for (const d of [32, 56, 80]) {
          const p = from.offset(Math.round(dx * d * (dx && dz ? 0.71 : 1)), 0, Math.round(dz * d * (dx && dz ? 0.71 : 1)));
          if (!bot.blockAt(p)) continue;
          const w = landWork(ctx, p, 8);
          if (w) best.push({ pos: w.origin.offset(Math.floor(VILLAGE_SIDE / 2), 1, Math.floor(VILLAGE_SIDE / 2)), work: w.work, way, dist: Math.round(w.origin.distanceTo(home)) });
        }
      }
    };
    look(home);
    // Nothing easy in sight: walk out the way that looked best (or the one least looked at) and look again.
    for (let leg = 0; leg < 2 && !best.some((b) => b.work <= EASY_WORK) && best.length < 40; leg++) {
      throwIfAborted(ctx.signal);
      const lead = best.sort((a, b) => a.work - b.work)[0];
      const [dx, dz] = lead ? [Math.sign(lead.pos.x - home.x), Math.sign(lead.pos.z - home.z)] : [1, 0];
      const to = bot.entity.position.offset(dx * args.distance * 0.5, 0, dz * args.distance * 0.5);
      try {
        await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(to.x, to.z, 6)), 90_000), () => stopMotion(bot));
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.logger.debug({ module: 'skill', err: errMsg(err) }, 'scouting walk cut short');
      }
      look(bot.entity.position.floored());
    }
    const easiest = best.sort((a, b) => a.work - b.work || a.dist - b.dist)[0];
    const homeText = here ? (here.work <= EASY_WORK ? 'home is on easy, level land' : here.work <= EASY_WORK * 3 ? 'home is on uneven land' : 'home is on rough, steep land') : 'there is no room to build around home';
    if (!easiest) return { ok: false, observed: `${homeText}; found no better land`, error: 'no level land found nearby' };
    const better = !here || easiest.work < here.work * 0.6;
    const where = `${easiest.pos.x},${easiest.pos.y},${easiest.pos.z}`;
    const kind = easiest.work <= EASY_WORK ? 'flat, open land' : 'easier land';
    return {
      ok: true,
      observed: better ? `${homeText}; ${kind} ${easiest.dist} blocks ${easiest.way} of home at ${where}, room for a village` : `${homeText}; nothing much better about (the best: ${easiest.dist} blocks ${easiest.way} at ${where})`,
      data: { home: here?.work ?? null, best: { x: easiest.pos.x, y: easiest.pos.y, z: easiest.pos.z, work: easiest.work, way: easiest.way, dist: easiest.dist }, better },
    };
  },
});

export const settle = defineSkill({
  name: 'settle',
  description: 'settle {x,y,z} — make that place home (the village moves with its people): walks there; do it once you and the others have agreed to move',
  argsSchema: z.object({ x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number() }),
  talkOverable: false,
  slipKinds: [],
  expect: (args) => ({ kind: 'near', pos: new Vec3(args.x, args.y, args.z), within: 8 }),
  async run(ctx, args) {
    if (!ctx.setHome) return { ok: false, observed: 'cannot move home', error: 'home cannot be moved here' };
    const to = new Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z));
    try {
      await gotoNear(ctx, to, 4, 240_000);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return { ok: false, observed: `could not get to ${to.x},${to.y},${to.z}`, error: errMsg(err) };
    }
    const at = ctx.bot.entity.position.floored();
    ctx.setHome(at);
    return { ok: true, observed: `settled at ${at.x},${at.y},${at.z}: this is home now`, data: { home: { x: at.x, y: at.y, z: at.z } } };
  },
});
