// Social skills: give (walk within 2 blocks, look at the receiver, toss — §6.6, works the same with a human) and say.

import { z } from 'zod';
import { VolumeSchema } from '@agora/shared';
import { countItem } from '../inventory';
import { itemMatcher } from '../items';
import { playerEntity } from '../world';
import { errMsg, gotoNear, throwIfAborted, waitMs } from './util';
import { defineSkill, SkillAbortedError } from './types';

export const give = defineSkill({
  name: 'give',
  description: 'give {to, item, qty} — walk up to someone and toss them items',
  argsSchema: z.object({ to: z.string().min(1), item: z.string().min(1), qty: z.coerce.number().int().min(1).max(256).default(1) }),
  talkOverable: true,
  slipKinds: [],
  expect: (args) => ({ kind: 'inventoryLoss', item: itemMatcher(args.item).label, atLeast: args.qty }),
  async run(ctx, args) {
    const { bot } = ctx;
    const m = itemMatcher(args.item);
    const have = countItem(bot, m);
    if (have < args.qty) return { ok: false, observed: `only have ${have} ${m.label}`, error: `not enough ${m.label} (${have}/${args.qty})` };
    const target = playerEntity(bot, args.to);
    if (!target) return { ok: false, observed: `cannot see ${args.to}`, error: `${args.to} is not nearby` };
    try {
      if (target.position.distanceTo(bot.entity.position) > 2.5) await gotoNear(ctx, target.position, 2);
      const now = playerEntity(bot, args.to);
      if (!now) return { ok: false, observed: `${args.to} left`, error: `${args.to} walked away` };
      await bot.lookAt(now.position.offset(0, 1.2, 0), true);
      let left = args.qty;
      for (const it of bot.inventory.items().filter((i) => m.matches(i.name))) {
        throwIfAborted(ctx.signal);
        if (left <= 0) break;
        const n = Math.min(it.count, left);
        await bot.toss(it.type, null, n);
        left -= n;
        await waitMs(ctx, 150);
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'could not hand it over', error: errMsg(err) };
    }
    return { ok: true, observed: `tossed ${args.qty} ${m.label} to ${args.to}` };
  },
});

export const say = defineSkill({
  name: 'say',
  description: 'say {text, volume?} — speak in chat (volume: whisper|normal|shout)',
  argsSchema: z.object({ text: z.string().min(1).max(512), volume: VolumeSchema.default('normal') }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    await ctx.say(args.text, args.volume);
    return { ok: true, observed: `said "${args.text.slice(0, 60)}"` };
  },
});
