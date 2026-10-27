import { z } from 'zod';
// Shared skill helpers: abortable waits and pathfinding with cancellation.

import { sleep } from '@agora/shared';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { type SkillContext, SkillAbortedError } from './types';

const { goals } = pathfinderPkg;
export { goals };

export function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r.message;
  return typeof r === 'string' ? r : 'preempted';
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SkillAbortedError(abortReason(signal));
}

/** Races `task` against the signal; on abort runs `cancel` and rejects with SkillAbortedError. */
export function abortable<T>(signal: AbortSignal, task: Promise<T>, cancel: () => void): Promise<T> {
  if (signal.aborted) {
    cancel();
    return Promise.reject(new SkillAbortedError(abortReason(signal)));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      try {
        cancel();
      } finally {
        reject(new SkillAbortedError(abortReason(signal)));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function waitMs(ctx: SkillContext, ms: number): Promise<void> {
  try {
    await sleep(ms, ctx.signal);
  } catch {
    throw new SkillAbortedError(abortReason(ctx.signal));
  }
}

export function stopMotion(bot: Bot): void {
  try {
    // An idle pathfinder never acts on stop(): the flag lingers and wipes the next goal set, whose goto then fails
    // at once ("PathStopped"). Clearing the goal stops it outright; a moving one still stops at its next step.
    if (bot.pathfinder.isMoving()) bot.pathfinder.stop();
    else bot.pathfinder.setGoal(null);
    releaseStuckDig(bot);
  } catch {
    // not moving
  }
  bot.clearControlStates();
}

/**
 * The pathfinder stuck "digging": mineflayer lets go of a dig whose time is up and then waits for the block to turn to
 * air, so a dig of the pathfinder's that the server refused never settles, and the pathfinder, digging still, never
 * takes another step (every walk after times out without a step). With no dig going on, it is let go of the block: a
 * reset while digging listens for the dig's end, which mineflayer has nothing left to send. True if it was stuck.
 */
export function releaseStuckDig(bot: Bot): boolean {
  if (!bot.pathfinder.isMining() || bot.targetDigBlock) return false;
  bot.pathfinder.setGoal(null);
  (bot as unknown as { emit(ev: string, b: null): void }).emit('diggingAborted', null);
  return true;
}

/** Pathfinds to within `range` of `pos`. Applies the 'path' slip as a detour (§21.1). */
export async function gotoNear(ctx: SkillContext, pos: Vec3, range: number, timeoutMs = 60_000, movements = ctx.movements()): Promise<void> {
  const { bot } = ctx;
  bot.pathfinder.setMovements(movements);
  if (ctx.slip === 'path') {
    // Inefficient path: wander via a point off to the side first.
    const side = new Vec3(pos.x + (ctx.rng.next() < 0.5 ? -6 : 6), pos.y, pos.z + (ctx.rng.next() < 0.5 ? -6 : 6));
    try {
      await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(side.x, side.z, 2)), timeoutMs / 2), () => stopMotion(bot));
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
    }
  }
  // What the pathfinder went through, for the log when a walk fails.
  const events: Record<string, number> = {};
  const count = (k: string) => (events[k] = (events[k] ?? 0) + 1);
  const onUpdate = (r: { status: string }) => count(`update:${r.status}`);
  const onReset = (reason: string) => count(`reset:${reason}`);
  bot.on('path_update', onUpdate);
  bot.on('path_reset', onReset);
  const from = bot.entity.position.clone();
  const began = Date.now();
  try {
    await abortable(
      ctx.signal,
      withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), timeoutMs),
      () => stopMotion(bot),
    );
  } catch (err) {
    // A long walk cut short far from where it was going: what the pathfinder went through, as for one that failed (a
    // climb out of a cave to the surface ran three minutes and was still 34 blocks off).
    if (err instanceof SkillAbortedError && Date.now() - began > 60_000 && bot.entity.position.distanceTo(pos) > range + 8) {
      ctx.logger.info({ module: 'skill', from: from.floored().toString(), at: bot.entity.position.floored().toString(), to: pos.floored().toString(), range, events, ms: Date.now() - began }, 'long walk cut short');
    }
    if (!(err instanceof SkillAbortedError)) {
      const at = bot.entity.position;
      const f = at.floored();
      // Where exactly it stopped, for one that never moved at all (in a hole, or in a block).
      // And what the walk was at when it stopped: a dig or a placement never finishing holds a walk where it is.
      const pf = bot.pathfinder as unknown as { isMining?: () => boolean; isBuilding?: () => boolean };
      const stuck = {
        exact: `${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}`,
        onGround: bot.entity.onGround,
        feet: bot.blockAt(f)?.name ?? null,
        head: bot.blockAt(f.offset(0, 1, 0))?.name ?? null,
        mining: pf.isMining?.() ?? null,
        building: pf.isBuilding?.() ?? null,
        holding: bot.heldItem?.name ?? null,
      };
      ctx.logger.info({ module: 'skill', from: from.floored().toString(), at: f.toString(), to: pos.floored().toString(), range, events, err: errMsg(err), ...stuck }, 'walk failed');
      stopMotion(bot);
    }
    throw err;
  } finally {
    bot.off('path_update', onUpdate);
    bot.off('path_reset', onReset);
  }
}

/**
 * Walks up to a person: pathfinds to where they are now, again if they moved, in short tries. If the pathfinder
 * keeps failing while they are in plain view a few blocks away, walks straight at them. Throws if they leave.
 */
export async function approachPlayer(ctx: SkillContext, name: string, within: number, timeoutMs = 45_000): Promise<void> {
  const { bot } = ctx;
  const where = () => bot.players[name]?.entity?.position ?? null;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
    const p = where();
    if (!p) throw new Error(`${name} walked away`);
    if (p.distanceTo(bot.entity.position) <= within + 0.3) return;
    try {
      await gotoNear(ctx, p, within, Math.min(15_000, deadline - Date.now()));
    } catch (err) {
      if (err instanceof SkillAbortedError) throw err;
      lastError = err;
    }
  }
  const p = where();
  if (!p) throw new Error(`${name} walked away`);
  if (p.distanceTo(bot.entity.position) <= within + 0.3) return;
  if (p.distanceTo(bot.entity.position) <= 6) {
    await walkStraightTo(ctx, where, within, 5000);
    const q = where();
    if (q && q.distanceTo(bot.entity.position) <= within + 0.3) return;
  }
  throw lastError instanceof Error ? lastError : new Error(`could not get to ${name}`);
}

/** A few steps straight toward a (moving) point on open ground, jumping over bumps. */
async function walkStraightTo(ctx: SkillContext, where: () => Vec3 | null, within: number, timeoutMs: number): Promise<void> {
  const { bot } = ctx;
  stopMotion(bot);
  const end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end) {
      throwIfAborted(ctx.signal);
      const p = where();
      if (!p || p.distanceTo(bot.entity.position) <= within) return;
      await bot.lookAt(p.offset(0, 1.2, 0), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', Boolean((bot.entity as unknown as { isCollidedHorizontally?: boolean }).isCollidedHorizontally));
      await waitMs(ctx, 100);
    }
  } finally {
    bot.clearControlStates();
  }
}

/**
 * Digs a block, for as long as digging it takes and a few seconds more. mineflayer waits for the block to turn to air,
 * and a dig the server refused (out of reach, the block changed under us) would wait for ever.
 */
export async function digBlock(ctx: Pick<SkillContext, 'bot' | 'signal'>, block: Block): Promise<void> {
  const { bot } = ctx;
  const ms = Math.min(60_000, (bot.digTime(block) || 5000) + 5000);
  for (let attempt = 0; ; attempt++) {
    try {
      await abortable(ctx.signal, withTimeout(bot.dig(block, true), ms, `the ${block.name} would not break`), () => bot.stopDigging());
      return;
    } catch (err) {
      // A stop meant for a dig that went before (the last skill's, cut short) can land on ours: once more, then.
      if (attempt === 0 && !ctx.signal.aborted && /Digging aborted/.test(errMsg(err))) {
        await new Promise((r) => setTimeout(r, 250));
        throwIfAborted(ctx.signal);
        const fresh = bot.blockAt(block.position);
        if (!fresh || fresh.type !== block.type) return;
        continue;
      }
      if (!ctx.signal.aborted) bot.stopDigging();
      throw err;
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'timed out'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A number a skill takes, held to what it can do rather than refused: asked to craft 70 or wait 700 s, a player does
 * what fits (the models asked so often, and each refusal was a thought wasted).
 */
export function upTo(lo: number, hi: number, int = false) {
  return z.coerce.number().transform((n) => Math.max(lo, Math.min(hi, int ? Math.round(n) : n)));
}
