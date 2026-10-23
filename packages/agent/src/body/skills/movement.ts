// Movement skills: goTo, follow, explore, wander, lookAround, flee, look, wait.

import { z } from 'zod';
import { Vec3 } from 'vec3';
import { findEntity, nearbyHostiles, wetAt } from '../world';
import { abortable, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';
import { SkillAbortedError, type SkillContext, defineSkill } from './types';

const PosArgs = z.object({ x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number() });

export const goTo = defineSkill({
  name: 'goTo',
  description: 'goTo {x,y,z, range?} or {agent, range?} — walk to a place or a person you can see',
  argsSchema: z.union([
    PosArgs.extend({ range: z.coerce.number().min(0).max(32).default(1) }),
    z.object({ agent: z.string().min(1), range: z.coerce.number().min(1).max(32).default(2) }),
  ]),
  talkOverable: true,
  slipKinds: ['path'],
  expect(args) {
    if ('agent' in args) return { kind: 'nearAgent', agent: args.agent, within: args.range + 2 };
    return { kind: 'near', pos: new Vec3(args.x, args.y, args.z), within: args.range + 1.5 };
  },
  async run(ctx, args) {
    let target: Vec3;
    if ('agent' in args) {
      const e = findEntity(ctx.bot, args.agent, 128);
      if (!e) return { ok: false, observed: `cannot see ${args.agent}`, error: `${args.agent} is not in sight` };
      target = e.position.clone();
    } else target = new Vec3(args.x, args.y, args.z);
    try {
      await gotoNear(ctx, target, args.range);
    } catch (err) {
      return { ok: false, observed: `stopped ${ctx.bot.entity.position.distanceTo(target).toFixed(1)} blocks away`, error: errMsg(err) };
    }
    return { ok: true, observed: `arrived within ${ctx.bot.entity.position.distanceTo(target).toFixed(1)} blocks` };
  },
});

export const follow = defineSkill({
  name: 'follow',
  description: 'follow {agent, distance?} — stay near someone until the option ends',
  argsSchema: z.object({ agent: z.string().min(1), distance: z.coerce.number().min(1).max(16).default(3) }),
  talkOverable: true,
  slipKinds: [],
  expect: (args) => ({ kind: 'nearAgent', agent: args.agent, within: args.distance + 4 }),
  async run(ctx, args) {
    const { bot } = ctx;
    const e = findEntity(bot, args.agent, 64);
    if (!e) return { ok: false, observed: `cannot see ${args.agent}`, error: `${args.agent} is not in sight` };
    bot.pathfinder.setMovements(ctx.movements());
    bot.pathfinder.setGoal(new goals.GoalFollow(e, args.distance), true);
    ctx.progress(`following ${args.agent}`);
    try {
      // Follow until aborted (option termination) or until the target is gone for 5 s.
      let lostSince: number | null = null;
      while (!ctx.signal.aborted) {
        await waitMs(ctx, 500);
        const still = findEntity(bot, args.agent, 64);
        if (!still) {
          lostSince ??= Date.now();
          if (Date.now() - lostSince > 5000) {
            return { ok: false, observed: `lost sight of ${args.agent}`, error: `${args.agent} left` };
          }
        } else lostSince = null;
      }
    } catch {
      // aborted: the normal way a follow ends
    } finally {
      stopMotion(bot);
    }
    return { ok: true, observed: `followed ${args.agent}` };
  },
});

/** How far exploring may take a bot from where it first appeared. */
const MAX_ROAM = 96;
/** Turns tried, nearest first, for a heading whose end isn't in water. */
const DRY_TURNS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, Math.PI];

/**
 * The heading nearest `angle` whose walk of `r` from `from` ends on dry ground (a walk that ends in a lake leaves one
 * treading water, waiting for the next thought). `angle` itself if none does or nothing there is loaded.
 */
function dryHeading(ctx: SkillContext, from: Vec3, angle: number, r: number): number {
  for (const turn of DRY_TURNS) {
    const a = angle + turn;
    if (!wetAt(ctx.bot, from.x + Math.cos(a) * r, from.z + Math.sin(a) * r, from.y)) return a;
  }
  return angle;
}

export const explore = defineSkill({
  name: 'explore',
  description: 'explore {distance?} — walk somewhere new',
  argsSchema: z.object({ distance: z.coerce.number().min(8).max(128).default(32) }),
  talkOverable: true,
  slipKinds: ['path'],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const start = bot.entity.position.clone();
    let angle = ctx.rng.next() * Math.PI * 2;
    // Roam, but not off the map: beyond MAX_ROAM from home, head back toward it (give or take 60°).
    const home = ctx.home;
    if (home && Math.hypot(start.x + Math.cos(angle) * args.distance - home.x, start.z + Math.sin(angle) * args.distance - home.z) > MAX_ROAM) {
      angle = Math.atan2(home.z - start.z, home.x - start.x) + (ctx.rng.next() - 0.5) * (Math.PI / 1.5);
    }
    angle = dryHeading(ctx, start, angle, args.distance);
    const tx = Math.round(start.x + Math.cos(angle) * args.distance);
    const tz = Math.round(start.z + Math.sin(angle) * args.distance);
    bot.pathfinder.setMovements(ctx.movements());
    try {
      await abortable(ctx.signal, bot.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 3)), () => stopMotion(bot));
    } catch (err) {
      const moved = bot.entity.position.distanceTo(start);
      if (moved >= args.distance / 3) return { ok: true, observed: `wandered ${moved.toFixed(0)} blocks` };
      return { ok: false, observed: `only got ${moved.toFixed(0)} blocks`, error: errMsg(err) };
    }
    return { ok: true, observed: `explored ${bot.entity.position.distanceTo(start).toFixed(0)} blocks to ${tx},${tz}` };
  },
});

/** What a stroll stops to look at: people, animals, and things worth a look (trees, ore, water, flowers…). */
const LOOKED_AT = /_(log|ore|leaves)$|^(water|lava|grass_block|sand|gravel|stone|cobblestone|chest|crafting_table|furnace|campfire|torch)$|flower|mushroom|_bed$|_door$|sign$/;

/** Something nearby worth turning to: the nearest person, else an animal, else a block of note; null if nothing. */
function somethingToSee(ctx: SkillContext, within: number): { what: string; pos: Vec3 } | null {
  const { bot } = ctx;
  const me = bot.entity.position;
  // minecraft-data categories are wider than prismarine-entity's type union.
  const seen = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position.distanceTo(me) <= within && ['player', 'animal', 'passive', 'mob', 'water_creature'].includes(e.type as string));
  const person = seen.filter((e) => e.type === 'player').sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
  if (person && ctx.rng.next() < 0.6) return { what: person.username ?? 'someone', pos: person.position.offset(0, person.height ?? 1.6, 0) };
  const other = seen.filter((e) => e.type !== 'player');
  const animal = other[Math.floor(ctx.rng.next() * other.length)];
  if (animal && ctx.rng.next() < 0.6) return { what: animal.name ?? 'an animal', pos: animal.position.offset(0, (animal.height ?? 1) * 0.8, 0) };
  const ids = bot.registry.blocksArray.filter((b) => LOOKED_AT.test(b.name)).map((b) => b.id);
  const spots = bot.findBlocks({ matching: ids, maxDistance: Math.min(within, 12), count: 12 });
  const spot = spots[Math.floor(ctx.rng.next() * spots.length)];
  const block = spot ? bot.blockAt(spot) : null;
  return block && spot ? { what: block.name, pos: spot.offset(0.5, 0.5, 0.5) } : null;
}

/** Turns to look at something nearby, or just around; returns what was looked at. */
async function glance(ctx: SkillContext, within: number, at?: string): Promise<string | null> {
  const { bot } = ctx;
  const who = at ? findEntity(bot, at, 24) : null;
  const target = who ? { what: at ?? '', pos: who.position.offset(0, who.height ?? 1.6, 0) } : somethingToSee(ctx, within);
  try {
    if (target) await bot.lookAt(target.pos, false);
    else await bot.look(bot.entity.yaw + (ctx.rng.next() - 0.5) * Math.PI, (ctx.rng.next() - 0.6) * 0.5, false);
  } catch {
    // looking is best-effort
  }
  return target?.what ?? null;
}

/** How near someone to keep clear of may come before a stroll turns away from them. */
const SHUN_RANGE = 24;

export const wander = defineSkill({
  name: 'wander',
  description:
    'wander {radius?, seconds?, near?, avoid?} — stroll around nearby at a walk, stopping to look at people, animals and things; near: a person to keep close to, avoid: people to keep clear of',
  argsSchema: z.object({
    radius: z.coerce.number().min(4).max(48).default(16),
    seconds: z.coerce.number().min(5).max(600).default(60),
    near: z.string().min(1).optional(),
    avoid: z.array(z.string().min(1)).max(16).optional(),
  }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const start = bot.entity.position.clone();
    const end = Date.now() + args.seconds * 1000;
    const seen = new Set<string>();
    const talked = new Set<string>();
    const watched = new Set<string>();
    let walked = 0;
    // Someone talking with us, in sight: a stroll is no reason to walk off from them.
    const talkingTo = () => {
      const who = ctx.talkingWith?.();
      return who && findEntity(bot, who, 16) ? who : null;
    };
    // A fight breaking out in sight: people stop to watch.
    const fightAt = () => {
      const who = ctx.fightNearby?.();
      return who && findEntity(bot, who, 32) ? who : null;
    };
    bot.pathfinder.setMovements(ctx.movements());
    try {
      while (Date.now() < end) {
        throwIfAborted(ctx.signal);
        // In a talk: stay put and face them while it lasts.
        const partner = talkingTo();
        if (partner) {
          talked.add(partner);
          await glance(ctx, 16, partner);
          await waitMs(ctx, 1500 + ctx.rng.next() * 1500);
          continue;
        }
        // A fight in sight: stay and watch it while it lasts.
        const fighter = fightAt();
        if (fighter) {
          watched.add(fighter);
          await glance(ctx, 32, fighter);
          await waitMs(ctx, 1000 + ctx.rng.next() * 1000);
          continue;
        }
        // The next spot: somewhere within the radius of where the stroll began (or of the one we keep close to), away
        // from any monster or anyone to keep clear of in sight, and not off toward the edge of where we live (beyond
        // MAX_ROAM from home it heads back).
        const me = bot.entity.position;
        const shunned = (args.avoid ?? [])
          .map((n) => findEntity(bot, n, SHUN_RANGE))
          .filter((e) => e !== null)
          .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
        const threat = nearbyHostiles(bot, 16)[0] ?? shunned;
        let angle = threat ? Math.atan2(me.z - threat.position.z, me.x - threat.position.x) + (ctx.rng.next() - 0.5) : ctx.rng.next() * Math.PI * 2;
        const home = ctx.home;
        const farOut = Boolean(home && Math.hypot(me.x - home.x, me.z - home.z) > MAX_ROAM * 0.75);
        if (home && farOut) angle = Math.atan2(home.z - me.z, home.x - me.x) + (ctx.rng.next() - 0.5);
        const r = args.radius * (0.3 + 0.7 * ctx.rng.next());
        const by = args.near ? findEntity(bot, args.near, 48) : null;
        const base = threat || farOut ? me : (by?.position ?? start);
        angle = dryHeading(ctx, base, angle, r);
        const tx = Math.round(base.x + Math.cos(angle) * r);
        const tz = Math.round(base.z + Math.sin(angle) * r);
        const from = bot.entity.position.clone();
        // A talk begun on the way stops the walk.
        const listen = setInterval(() => {
          if (talkingTo() || fightAt()) stopMotion(bot);
        }, 1000);
        try {
          await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 2)), 20_000), () => stopMotion(bot));
        } catch (err) {
          if (err instanceof SkillAbortedError) throw err;
          stopMotion(bot);
        } finally {
          clearInterval(listen);
        }
        walked += bot.entity.position.distanceTo(from);
        // A look around before going on.
        for (let i = 0, n = 1 + Math.floor(ctx.rng.next() * 3); i < n && Date.now() < end; i++) {
          const what = await glance(ctx, 16);
          if (what) seen.add(what);
          await waitMs(ctx, 800 + ctx.rng.next() * 2200);
        }
      }
    } catch (err) {
      if (!(err instanceof SkillAbortedError)) throw err;
      // An ending option (time up, a new decision) is the usual way a stroll stops.
    } finally {
      stopMotion(bot);
    }
    const things = [...seen].filter((x) => !talked.has(x) && !watched.has(x)).slice(0, 6);
    const talks = talked.size > 0 ? `, stopped to talk with ${[...talked].join(', ')}` : '';
    const fights = watched.size > 0 ? `, stopped to watch ${[...watched].join(', ')} fight` : '';
    return { ok: true, observed: `strolled ${walked.toFixed(0)} blocks${things.length > 0 ? `, saw ${things.join(', ')}` : ''}${talks}${fights}` };
  },
});

export const lookAround = defineSkill({
  name: 'lookAround',
  description: 'lookAround {seconds, at?} — stay put but keep an eye on things (on someone, with at)',
  argsSchema: z.object({ seconds: z.coerce.number().min(1).max(600).default(20), at: z.string().min(1).optional() }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const end = Date.now() + args.seconds * 1000;
    const seen = new Set<string>();
    try {
      while (Date.now() < end) {
        // Mostly at the one we are with, now and then at something else.
        const what = await glance(ctx, 16, args.at && ctx.rng.next() < 0.8 ? args.at : undefined);
        if (what) seen.add(what);
        await waitMs(ctx, Math.min(end - Date.now(), 1500 + ctx.rng.next() * 3000));
      }
    } catch {
      return { ok: true, observed: 'stopped early' };
    }
    const things = [...seen].filter((x) => x !== args.at).slice(0, 5);
    return { ok: true, observed: `stayed ${args.seconds}s${things.length > 0 ? `, saw ${things.join(', ')}` : ''}` };
  },
});

export const flee = defineSkill({
  name: 'flee',
  description: 'flee {from?, distance?} — run away from a person, a mob type, or the nearest hostile',
  argsSchema: z.object({ from: z.string().optional(), distance: z.coerce.number().min(4).max(64).default(16) }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const threat = args.from ? findEntity(bot, args.from, 48) : (nearbyHostiles(bot, 24)[0] ?? null);
    if (!threat) return { ok: true, observed: 'nothing to flee from' };
    const me = bot.entity.position;
    const away = me.minus(threat.position);
    const dir = away.norm() < 0.1 ? new Vec3(1, 0, 0) : away.normalize();
    const target = me.plus(dir.scaled(args.distance));
    bot.setControlState('sprint', true);
    bot.pathfinder.setMovements(ctx.movements(true));
    try {
      await abortable(
        ctx.signal,
        bot.pathfinder.goto(new goals.GoalNearXZ(Math.round(target.x), Math.round(target.z), 3)),
        () => stopMotion(bot),
      );
    } catch (err) {
      const d = bot.entity.position.distanceTo(threat.position);
      return d >= args.distance * 0.6
        ? { ok: true, observed: `got ${d.toFixed(0)} blocks away` }
        : { ok: false, observed: `only ${d.toFixed(0)} blocks away`, error: errMsg(err) };
    } finally {
      bot.setControlState('sprint', false);
    }
    return { ok: true, observed: `fled to ${bot.entity.position.distanceTo(threat.position).toFixed(0)} blocks away` };
  },
});

export const look = defineSkill({
  name: 'look',
  description: 'look {agent} or {x,y,z} — turn to face someone or something',
  argsSchema: z.union([z.object({ agent: z.string().min(1) }), PosArgs]),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    let p: Vec3;
    if ('agent' in args) {
      const e = findEntity(bot, args.agent, 64);
      if (!e) return { ok: false, observed: `cannot see ${args.agent}`, error: `${args.agent} is not in sight` };
      p = e.position.offset(0, e.height ?? 1.6, 0);
    } else p = new Vec3(args.x, args.y, args.z);
    await bot.lookAt(p, false);
    return { ok: true, observed: 'looked' };
  },
});

export const wait = defineSkill({
  name: 'wait',
  description: 'wait {seconds} — stand still (also "stay")',
  argsSchema: z.object({ seconds: z.coerce.number().min(1).max(600).default(10) }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    try {
      await waitMs(ctx, args.seconds * 1000);
    } catch {
      return { ok: true, observed: 'stopped waiting early' };
    }
    return { ok: true, observed: `waited ${args.seconds}s` };
  },
});
