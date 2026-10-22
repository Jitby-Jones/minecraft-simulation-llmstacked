// Social skills: give (walk up to the receiver, toss at their feet, step back so they get it — §6.6, works the same
// with a human) and say.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { VolumeSchema } from '@agora/shared';
import { countItem } from '../inventory';
import { type ItemMatcher, itemMatcher } from '../items';
import { playerEntity } from '../world';
import { approachPlayer, errMsg, throwIfAborted, waitMs } from './util';
import { defineSkill, type SkillContext, SkillAbortedError } from './types';

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
    if (!playerEntity(bot, args.to)) return { ok: false, observed: `cannot see ${args.to}`, error: `${args.to} is not nearby` };
    let observed = '';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await approachPlayer(ctx, args.to, 1.5);
        const target = playerEntity(bot, args.to);
        if (!target) return { ok: false, observed: `${args.to} left`, error: `${args.to} walked away` };
        const left = args.qty - (have - countItem(bot, m));
        const dropped = await tossAtFeet(ctx, target, m, left);
        // Nobody can pick a thrown item up for 2 s; then whoever is closest gets it. Step back so it's them, watching
        // from the moment the items leave our hands so that no pickup is missed.
        const collecting = whoCollects(bot, dropped, m, left, 8000);
        await stepBack(ctx, target);
        const got = await collecting;
        if ((got.get(target.id) ?? 0) >= left) return { ok: true, observed: `tossed ${args.qty} ${m.label} to ${args.to}` };
        // We picked them back up: try again from closer.
        if ((got.get(bot.entity.id) ?? 0) > 0) {
          observed = 'the items came back to me';
          continue;
        }
        // Still lying at their feet (they can pick them up), or someone else took them.
        const now = playerEntity(bot, args.to);
        const lying = [...dropped].map((id) => bot.entities[id]).filter((e) => e !== undefined);
        const others = [...got.keys()].some((id) => id !== target.id);
        if (!others && lying.length > 0 && now && lying.every((e) => e.position.distanceTo(now.position) <= 2)) {
          return { ok: true, observed: `left ${args.qty} ${m.label} at ${args.to}'s feet` };
        }
        observed = others ? `someone else took the ${m.label}` : `${args.to} did not pick them up`;
        break;
      }
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      return { ok: false, observed: 'could not hand it over', error: errMsg(err) };
    }
    // What left our hands: if they pick it up after all, the hand-over counts (social/commitments.ts).
    const tossed = have - countItem(bot, m);
    return { ok: false, observed, error: `${args.to} did not get the ${m.label}`, ...(tossed > 0 ? { data: { tossed } } : {}) };
  },
});

/** Tosses up to `qty` matching items at the person's feet; returns the item entities that left our hands. */
async function tossAtFeet(ctx: SkillContext, target: Entity, m: ItemMatcher, qty: number): Promise<Set<number>> {
  const { bot } = ctx;
  const seen = new Set<number>();
  const hands = () => bot.entity.position.offset(0, 1.3, 0);
  // Leaves decaying nearby drop saplings and sticks too: only what appears right at our hands is ours.
  const onSpawn = (e: Entity) => {
    if (e.name === 'item' && e.position.distanceTo(hands()) < 1.5) seen.add(e.id);
  };
  bot.on('entitySpawn', onSpawn);
  try {
    // A thrown item lands about where we look (measured on 26.1: aiming 0.5–2 blocks ahead lands within 0.2 of
    // it), but only once the server has our new rotation: give it two ticks.
    await bot.lookAt(target.position, true);
    await waitMs(ctx, 150);
    let left = qty;
    for (const it of bot.inventory.items().filter((i) => m.matches(i.name))) {
      throwIfAborted(ctx.signal);
      if (left <= 0) break;
      const n = Math.min(it.count, left);
      await bot.toss(it.type, null, n);
      left -= n;
      await waitMs(ctx, 150);
    }
    await waitMs(ctx, 250);
  } finally {
    bot.off('entitySpawn', onSpawn);
  }
  return seen;
}

/** A short step away from the person, out of reach of what we just tossed. */
async function stepBack(ctx: SkillContext, target: Entity): Promise<void> {
  const { bot } = ctx;
  await bot.lookAt(target.position.offset(0, 1.2, 0), true);
  bot.setControlState('back', true);
  try {
    await waitMs(ctx, 700);
  } finally {
    bot.clearControlStates();
  }
}

/** How many of the tossed items each player (entity id) picked up, waiting up to `ms` or until all `qty` are taken. */
function whoCollects(bot: Bot, ids: ReadonlySet<number>, m: ItemMatcher, qty: number, ms: number): Promise<Map<number, number>> {
  const got = new Map<number, number>();
  let taken = 0;
  return new Promise((resolve) => {
    if (ids.size === 0) {
      resolve(got);
      return;
    }
    const done = () => {
      clearTimeout(timer);
      bot.off('playerCollect', onCollect);
      resolve(got);
    };
    const onCollect = (collector: Entity, collected: Entity) => {
      if (!ids.has(collected.id)) return;
      const it = (collected as unknown as { getDroppedItem?: () => { name: string; count: number } | null }).getDroppedItem?.();
      if (it && !m.matches(it.name)) return;
      const n = it?.count ?? 1;
      got.set(collector.id, (got.get(collector.id) ?? 0) + n);
      taken += n;
      if (taken >= qty) done();
    };
    const timer = setTimeout(done, ms);
    bot.on('playerCollect', onCollect);
  });
}

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
