// Combat skills. `attack` is plain melee via mineflayer-pvp. Fights against people are gated by code before
// any skill runs (§17.5 ConflictEvaluator); technique tiers by combat ability arrive with the duel skill (§21.3).

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import { weaponTier } from '../items';
import { entityHealth, findEntity } from '../world';
import { stopCollecting } from './gathering';
import { abortable, waitMs } from './util';
import { defineSkill, SkillAbortedError } from './types';

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

export async function equipBestWeapon(bot: Bot): Promise<string | null> {
  const best = bestWeapon(bot);
  if (best && bot.heldItem?.name !== best.name) await bot.equip(best, 'hand');
  return best?.name ?? null;
}

function alive(bot: Bot, e: Entity): boolean {
  const cur = bot.entities[e.id];
  if (!cur || (cur as unknown as { isValid?: boolean }).isValid === false) return false;
  const hp = entityHealth(bot, cur);
  return hp === undefined || hp > 0;
}

export const attack = defineSkill({
  name: 'attack',
  description: 'attack {target, seconds?} — melee a mob type or a person until it is gone (fights with people are code-gated)',
  argsSchema: z.object({ target: z.string().min(1), seconds: z.coerce.number().min(2).max(120).default(30) }),
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
    p.attack(e);
    const deadline = Date.now() + args.seconds * 1000;
    try {
      await abortable(
        ctx.signal,
        (async () => {
          while (alive(bot, e) && Date.now() < deadline) await waitMs(ctx, 250);
        })(),
        () => p.forceStop(),
      );
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
    } finally {
      p.forceStop();
    }
    if (!alive(bot, e)) return { ok: true, observed: `${args.target} is gone` };
    return { ok: false, observed: `${args.target} still standing`, error: 'could not finish the fight in time' };
  },
});
