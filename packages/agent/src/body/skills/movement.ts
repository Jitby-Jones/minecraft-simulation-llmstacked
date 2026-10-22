// Movement skills: goTo, follow, explore, flee, look, wait.

import { z } from 'zod';
import { Vec3 } from 'vec3';
import { findEntity, nearbyHostiles } from '../world';
import { abortable, errMsg, goals, gotoNear, stopMotion, waitMs } from './util';
import { defineSkill } from './types';

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
    bot.pathfinder.setMovements(ctx.movements());
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
