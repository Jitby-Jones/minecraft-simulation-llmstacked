// duel (§17.6, §21.3): a fight with a person that ends when one side gives up. Only the conflict core's code gate
// lets it start. We give up at our own yield health: stop attacking, step back and say so. They give up when they
// say so or stop hitting back (the yield protocol works in chat and in deeds, the same with a human), and a brawl
// is never to the death: we also stop once they've plainly taken a beating, or have run off. Their hearts can't be
// seen (§17.4), so "a beating" is reckoned from the blows that land, our weapon and the armor they wear. Technique
// follows combat ability: novices spam clicks (random timing, weak hits), trained fighters and better time their
// swings to the weapon's cooldown, with a reaction delay of 400 ms × (1 − combat) + 50 ms.

import { z } from 'zod';
import { parseProximityLine } from '@agora/shared';
import pvpPkg from 'mineflayer-pvp';
import type { Entity } from 'prismarine-entity';
import { armorPoints, weaponStats } from '../combatOdds';
import { entityHealth, findEntity } from '../world';
import { equipBestWeapon, pvp } from './combat';
import { stopCollecting } from './gathering';
import { throwIfAborted, waitMs } from './util';
import { defineSkill } from './types';

const { MaxDamageOffset, RandomTicks } = pvpPkg as unknown as {
  MaxDamageOffset: new (min?: number, max?: number) => unknown;
  RandomTicks: new (min?: number, max?: number) => unknown;
};

/** "I yield", "ok ok, I give up", "you win", a bare "enough!": a fighter giving up (§17.6 yield protocol). "I've had
 *  enough of you" and "that's enough, stay away" are not. */
export const SURRENDER_RE = /\b(i yield|i give up|i surrender|you win|mercy|stop,? please|please stop|ok ok)\b|^\W*(enough|i'?m done|i quit)\W*$/i;

/** The winner calling a fight off ("that's enough. stay out of my way."): it's over. */
export const CALL_OFF_RE = /\b(that'?s enough|stay out of my way|we'?re done here|let'?s leave it)\b/i;

export type DuelOutcome = 'won' | 'yielded' | 'gone' | 'interrupted';

/** Reckoned damage (of their 20, net of what they heal meanwhile) at which they've taken a beating: the brawl is
 *  over even if they never say so. Set above where a fighter normally yields, so the yield usually comes first. */
const BEATEN_DAMAGE = 18;
/** A fed fighter heals about this much a second (fast regeneration, then slow). */
const REGEN_PER_S = 0.4;
/** No blow from them this long while ours still land: they've stopped fighting (a yield in deeds). */
const QUIET_MS = 5000;
/** No blow either way this long (out of reach, or both lost the thread): the fight fizzled out, nobody won. */
const STALL_MS = 10_000;
/** Farther than this for RAN_MS: they ran off, and the brawl is over. */
const RAN_BLOCKS = 10;
const RAN_MS = 2000;

/** The health to give up at: our own threshold, or more against a weapon whose next (critical) blow could finish us. */
export function yieldAt(stopAtHealth: number, theirWeapon: string | undefined): number {
  return Math.max(stopAtHealth, Math.ceil(weaponStats(theirWeapon).dmg * 1.5) + 1);
}

/** One blow's reckoned damage: the weapon, softened by the armor they visibly wear; a novice's hurried swings land weaker. */
export function reckonBlow(weapon: string | undefined, theirArmor: readonly string[], combat: number): number {
  return weaponStats(weapon).dmg * (1 - armorPoints(theirArmor) / 50) * (combat < 0.3 ? 0.4 : 1);
}

export const duel = defineSkill({
  name: 'duel',
  description: 'duel {target, stopAtHealth?, lethal?} — fight a person until one of you gives up, or to the death when lethal (only when the conflict gate allows it)',
  argsSchema: z.object({
    target: z.string().min(1),
    stopAtHealth: z.coerce.number().min(1).max(19).default(8),
    seconds: z.coerce.number().min(5).max(120).default(60),
    /** §17.5 rung 4: no stopping at a beating, and a yield is spared only on the winner's mercy. */
    lethal: z.boolean().default(false),
    /** The chance of sparing them if they give up (§17.6 mercy, rolled once). */
    spareChance: z.coerce.number().min(0).max(1).default(1),
  }),
  talkOverable: false,
  slipKinds: ['tool'],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const e = findEntity(bot, args.target, 24);
    if (!e || e.type !== 'player') return { ok: false, observed: `${args.target} is not here`, error: `${args.target} not found` };
    // The pathfinder is the fight's alone: a collect task left from the interrupted work would steer it away.
    await stopCollecting(bot);
    if (ctx.slip !== 'tool') await equipBestWeapon(bot);
    const combat = ctx.combat ?? 0.4;
    const p = pvp(bot) as unknown as { attack(t: unknown): void; forceStop(): void; meleeAttackRate: unknown; target?: unknown };
    // §21.3 technique: cooldown timing from "trained" on, with reaction jitter shrinking as skill grows.
    const jitterTicks = Math.round((400 * (1 - combat) + 50) / 50);
    p.meleeAttackRate = combat < 0.3 ? new RandomTicks(2, 6) : new MaxDamageOffset(0, jitterTicks);
    let theyGaveUp = false;
    let calledOff = false;
    // A fight to the death: whether we would spare them, decided once (§17.6).
    const merciful = !args.lethal || ctx.rng.next() < args.spareChance;
    let unspared = false;
    const onMsg = (m: string) => {
      const line = parseProximityLine(m);
      if (line.kind !== 'speech' || line.speaker !== args.target) return;
      if (SURRENDER_RE.test(line.text)) theyGaveUp = true;
      // They say it's over ("that's enough. stay out of my way."): it is, for us too, and nobody gave up.
      else if (CALL_OFF_RE.test(line.text)) calledOff = true;
    };
    // What a fighter can tell: our blows landing, theirs landing on us.
    let landed = 0;
    let unanswered = 0;
    let dealt = 0;
    let theirLast = Date.now();
    let ourLast = Date.now();
    const onHurt = (x: Entity) => {
      if (x === bot.entity) {
        const foe = bot.entities[e.id];
        if (foe && foe.position.distanceTo(bot.entity.position) <= 4.5) {
          theirLast = Date.now();
          unanswered = 0;
        }
        return;
      }
      if (x.id !== e.id) return;
      const eq = (x as unknown as { equipment?: ({ name: string } | null | undefined)[] }).equipment ?? [];
      landed++;
      unanswered++;
      ourLast = Date.now();
      dealt += reckonBlow(bot.heldItem?.name, eq.slice(2).filter((i): i is { name: string } => Boolean(i)).map((i) => i.name), combat);
    };
    // What the pathfinder runs into while following them (for the debug log).
    const paths: Record<string, number> = {};
    const onPath = (r: { status?: string }) => void (paths[`update:${r.status ?? '?'}`] = (paths[`update:${r.status ?? '?'}`] ?? 0) + 1);
    const onReset = (reason: string) => void (paths[`reset:${reason}`] = (paths[`reset:${reason}`] ?? 0) + 1);
    bot.on('messagestr', onMsg);
    bot.on('entityHurt', onHurt);
    bot.on('path_update', onPath);
    bot.on('path_reset', onReset);
    p.attack(e);
    const started = Date.now();
    const deadline = started + args.seconds * 1000;
    let outcome: DuelOutcome = 'interrupted';
    let why = '';
    let farSince = 0;
    let lastLook = 0;
    try {
      while (Date.now() < deadline) {
        throwIfAborted(ctx.signal);
        // pvp lets go of a target it loses for a moment; take it up again.
        const live = bot.entities[e.id];
        if (live && !p.target) p.attack(live);
        if (Date.now() - lastLook > 3000) {
          lastLook = Date.now();
          const at = (v: { x: number; y: number; z: number }) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
          ctx.logger.debug({ module: 'duel', target: args.target, dist: live ? Number(live.position.distanceTo(bot.entity.position).toFixed(1)) : null, me: at(bot.entity.position), them: live ? at(live.position) : null, landed, engaged: Boolean(p.target), moving: bot.pathfinder.isMoving(), goal: Boolean(bot.pathfinder.goal), paths: { ...paths }, health: bot.health }, 'duel');
        }
        const held = (bot.entities[e.id] as unknown as { equipment?: ({ name: string } | null | undefined)[] } | undefined)?.equipment?.[0]?.name;
        if (bot.health <= yieldAt(args.stopAtHealth, held)) {
          outcome = 'yielded';
          break;
        }
        if (theyGaveUp && merciful) {
          outcome = 'won';
          why = 'gave up';
          break;
        }
        if (theyGaveUp && !unspared) {
          unspared = true;
          ctx.logger.info({ module: 'duel', target: args.target }, 'no mercy for a yield');
        }
        if (calledOff) {
          why = 'called off';
          break;
        }
        const cur = bot.entities[e.id];
        const hp = cur ? entityHealth(bot, cur) : 0;
        if (!cur || hp === 0) {
          outcome = 'gone';
          break;
        }
        if (!args.lethal && dealt - REGEN_PER_S * ((Date.now() - started) / 1000) >= BEATEN_DAMAGE) {
          outcome = 'won';
          why = 'took a beating';
          break;
        }
        const t = Date.now();
        // A yield in deeds: three of our blows in a row went unanswered, and theirs have stopped for a while.
        if (!args.lethal && unanswered >= 3 && t - theirLast > QUIET_MS && t - ourLast < 2500) {
          outcome = 'won';
          why = 'stopped fighting back';
          break;
        }
        if (t - Math.max(ourLast, theirLast) > STALL_MS) {
          why = 'fizzled out';
          ctx.logger.info({ module: 'duel', target: args.target, dist: Number(cur.position.distanceTo(bot.entity.position).toFixed(1)), landed, engaged: Boolean(p.target) }, 'fight fizzled out');
          break;
        }
        const far = cur.position.distanceTo(bot.entity.position) > RAN_BLOCKS;
        farSince = far ? farSince || Date.now() : 0;
        if (farSince && Date.now() - farSince >= RAN_MS) {
          outcome = 'gone';
          break;
        }
        await waitMs(ctx, 200);
      }
    } finally {
      p.forceStop();
      bot.off('messagestr', onMsg);
      bot.off('entityHurt', onHurt);
      bot.off('path_update', onPath);
      bot.off('path_reset', onReset);
    }
    if (outcome === 'yielded') {
      // Stop, back off, and say it: the other side sees the attacks stop and hears the yield. The reflexes may take
      // over to run (low health): the yield still stands and is what this fight's record says.
      bot.setControlState('back', true);
      try {
        await ctx.say('ok ok, I yield!');
        await waitMs(ctx, 600);
      } catch {
        // interrupted while backing off
      } finally {
        bot.clearControlStates();
      }
      return { ok: true, observed: `gave up the fight with ${args.target}`, data: { outcome } };
    }
    if (outcome === 'won') {
      // Done with them: a word, and room to walk away.
      if (!theyGaveUp) await ctx.say("that's enough. stay out of my way.");
      return { ok: true, observed: `${args.target} ${why}`, data: { outcome, why, landed } };
    }
    if (outcome === 'gone') return { ok: true, observed: `${args.target} is gone`, data: { outcome } };
    if (why === 'fizzled out') return { ok: false, observed: `the fight with ${args.target} fizzled out`, error: 'nobody landed a blow for a while', data: { outcome, why } };
    if (why === 'called off') return { ok: true, observed: `${args.target} called the fight off`, data: { outcome, why } };
    return { ok: false, observed: `the fight with ${args.target} dragged on`, error: 'the fight did not end in time', data: { outcome } };
  },
});
