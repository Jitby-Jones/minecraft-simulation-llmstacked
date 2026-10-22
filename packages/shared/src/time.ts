// Time constants. All stored times are UTC epoch milliseconds (§23.1).

/** One Minecraft day is 24000 ticks at 20 ticks/s = 20 real minutes. */
export const GAME_DAY_MS = 20 * 60 * 1000;
export const GAME_WEEK_MS = 7 * GAME_DAY_MS;
export const TICKS_PER_DAY = 24000;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** Manually advanced clock for tests and scenario simulation. */
export class ManualClock {
  constructor(private t = 0) {}
  now = (): number => this.t;
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

export function gameDays(ms: number): number {
  return ms / GAME_DAY_MS;
}

/** Minecraft time of day (0..23999) → night? Night is roughly 13000..23000 ticks. */
export function isNightTick(timeOfDay: number): boolean {
  const t = ((timeOfDay % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  return t >= 13000 && t < 23000;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
