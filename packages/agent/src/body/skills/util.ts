// Shared skill helpers: abortable waits and pathfinding with cancellation.

import { sleep } from '@agora/shared';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Bot } from 'mineflayer';
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
  } catch {
    // not moving
  }
  bot.clearControlStates();
}

/** Pathfinds to within `range` of `pos`. Applies the 'path' slip as a detour (§21.1). */
export async function gotoNear(ctx: SkillContext, pos: Vec3, range: number, timeoutMs = 60_000): Promise<void> {
  const { bot } = ctx;
  bot.pathfinder.setMovements(ctx.movements());
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
  try {
    await abortable(
      ctx.signal,
      withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), timeoutMs),
      () => stopMotion(bot),
    );
  } catch (err) {
    if (!(err instanceof SkillAbortedError)) {
      const at = bot.entity.position;
      const f = at.floored();
      // Where exactly it stopped, for one that never moved at all (in a hole, or in a block).
      const stuck = { exact: `${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}`, onGround: bot.entity.onGround, feet: bot.blockAt(f)?.name ?? null, head: bot.blockAt(f.offset(0, 1, 0))?.name ?? null };
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
