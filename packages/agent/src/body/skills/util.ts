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
    bot.pathfinder.stop();
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
  await abortable(
    ctx.signal,
    withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), timeoutMs),
    () => stopMotion(bot),
  );
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
