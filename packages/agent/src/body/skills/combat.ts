// Combat skills. `attack` is plain melee via mineflayer-pvp. Fights against people are gated by code before
// any skill runs (§17.5 ConflictEvaluator); technique tiers by combat ability arrive with the duel skill (§21.3).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { weaponTier } from '../items';
import { entityHealth, findEntity, hissing } from '../world';
import { stopCollecting } from './gathering';
import { abortable, goals, stopMotion, throwIfAborted, upTo, waitMs, withTimeout } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

interface PvpApi {
  attack(target: Entity): void;
  /** Stops at once. pvp's stop() waits up to 5 s for the pathfinder and then drops every 'path_stop' listener. */
  forceStop(): void;
  target?: Entity;
}

export function pvp(bot: Bot): PvpApi {
  return (bot as unknown as { pvp: PvpApi }).pvp;
}

/** The melee weapon we would draw: best sword/axe/trident/mace in the inventory. */
export function bestWeapon(bot: Bot): Item | null {
  return (
    bot.inventory
      .items()
      .filter((i) => weaponTier(i.name) > 0 && (i.name.endsWith('_sword') || i.name.endsWith('_axe') || i.name === 'trident' || i.name === 'mace'))
      .sort((a, b) => weaponTier(b.name) - weaponTier(a.name))[0] ?? null
  );
}

/** What to hit with: the best weapon, else the best tool (a pickaxe hits two or three times as hard as a fist). */
export function bestToHitWith(bot: Bot): Item | null {
  return (
    bestWeapon(bot) ??
    bot.inventory
      .items()
      .filter((i) => /_(pickaxe|shovel|hoe)$/.test(i.name))
      .sort((a, b) => weaponTier(b.name) - weaponTier(a.name))[0] ??
    null
  );
}

export async function equipBestWeapon(bot: Bot): Promise<string | null> {
  const best = bestToHitWith(bot);
  if (best && bot.heldItem?.name !== best.name) await bot.equip(best, 'hand');
  return best?.name ?? null;
}

function alive(bot: Bot, e: Entity): boolean {
  const cur = bot.entities[e.id];
  if (!cur || (cur as unknown as { isValid?: boolean }).isValid === false) return false;
  const hp = entityHealth(bot, cur);
  return hp === undefined || hp > 0;
}

/** A creeper stops hissing once what it is after is this far off. */
const CREEPER_LETS_GO = 7;

/** Out of a creeper's reach: away from it at a run, until it is this far off or the time is up. */
async function backOff(ctx: SkillContext, e: Entity, far: number): Promise<void> {
  const { bot } = ctx;
  const me = bot.entity.position;
  const away = me.minus(e.position);
  const flat = new Vec3(away.x, 0, away.z);
  const dir = flat.norm() < 0.1 ? new Vec3(1, 0, 0) : flat.normalize();
  const to = me.plus(dir.scaled(far + 2));
  bot.setControlState('sprint', true);
  bot.pathfinder.setMovements(ctx.movements(true));
  try {
    await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(Math.round(to.x), Math.round(to.z), 2)), 3000), () => stopMotion(bot)).catch((err: unknown) => {
      if (err instanceof SkillAbortedError) throw err;
    });
  } finally {
    stopMotion(bot);
    bot.setControlState('sprint', false);
  }
}

/**
 * A creeper is fought as a player fights one: in for a blow, and back out of its reach while it hisses; in again once
 * it has stopped (one stood and swung at one, as at a zombie, and its blast took it from 20 health to 7).
 */
async function hitAndBackOff(ctx: SkillContext, e: Entity, deadline: number): Promise<void> {
  const { bot } = ctx;
  const p = pvp(bot);
  const now = () => bot.entities[e.id] ?? e;
  while (alive(bot, e) && Date.now() < deadline) {
    throwIfAborted(ctx.signal);
    if (hissing(bot, now()) || now().position.distanceTo(bot.entity.position) < 1.5) {
      p.forceStop();
      await backOff(ctx, now(), CREEPER_LETS_GO);
      // Its fuse goes out once we are far enough off; until then, keep away.
      for (let i = 0; i < 20 && hissing(bot, now()) && alive(bot, e); i++) {
        if (now().position.distanceTo(bot.entity.position) < CREEPER_LETS_GO) await backOff(ctx, now(), CREEPER_LETS_GO);
        else await waitMs(ctx, 100);
      }
      continue;
    }
    // In for one blow, and out the moment it lands or the creeper starts to hiss.
    const before = entityHealth(bot, now());
    p.attack(now());
    const until = Date.now() + 5000;
    while (Date.now() < until && alive(bot, e) && !hissing(bot, now())) {
      await waitMs(ctx, 50);
      const h = entityHealth(bot, now());
      if (before !== undefined && h !== undefined && h < before) break;
    }
    p.forceStop();
    if (alive(bot, e)) await backOff(ctx, now(), 4);
  }
}

export const attack = defineSkill({
  name: 'attack',
  description: 'attack {target, seconds?} — melee a mob type or a person until it is gone (fights with people are code-gated)',
  argsSchema: z.object({ target: z.string().min(1), seconds: upTo(2, 120).default(30) }),
  talkOverable: false,
  slipKinds: ['tool'],
  expect: (args, _before, bot) => ({ kind: 'entityGone', target: args.target, entityId: findEntity(bot, args.target, 32)?.id }),
  async run(ctx, args) {
    const { bot } = ctx;
    const e = findEntity(bot, args.target, 32);
    if (!e) return { ok: false, observed: `no ${args.target} in sight`, error: `${args.target} not found` };
    await stopCollecting(bot);
    if (ctx.slip !== 'tool') await equipBestWeapon(bot);
    const p = pvp(bot);
    const deadline = Date.now() + args.seconds * 1000;
    try {
      if (e.name === 'creeper') await hitAndBackOff(ctx, e, deadline);
      else {
        p.attack(e);
        await abortable(
          ctx.signal,
          (async () => {
            while (alive(bot, e) && Date.now() < deadline) await waitMs(ctx, 250);
          })(),
          () => p.forceStop(),
        );
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
    } finally {
      p.forceStop();
    }
    if (!alive(bot, e)) return { ok: true, observed: `${args.target} is gone` };
    return { ok: false, observed: `${args.target} still standing`, error: 'could not finish the fight in time' };
  },
});
