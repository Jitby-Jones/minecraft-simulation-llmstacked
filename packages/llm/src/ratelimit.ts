// Request-rate limiting (§5): the Hub hands out tokens from a 20 rps bucket (M5); without the Hub each bot uses a
// local bucket of 20/N rps. Waiters are served by module priority (Talking first). After a 429 the rate drops by
// 20 % for 10 minutes (§22.6).

import { type LlmModule, sleep } from '@agora/shared';

export interface TokenSource {
  /** Resolves when a request may go out; higher priority is served first (MODULE_PRIORITY). Rejects if the signal fires first. */
  acquire(priority: number, signal?: AbortSignal, module?: LlmModule): Promise<void>;
  /** A 429 came back: lower the rate. */
  backOff?(): void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

interface Waiter {
  priority: number;
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface LocalRateLimiterOptions {
  rps: number;
  burst?: number;
  now?: () => number;
  /** 429 slow-down factor and duration. */
  backOffFactor?: number;
  backOffMs?: number;
}

export class LocalRateLimiter implements TokenSource {
  private tokens: number;
  private last: number;
  private seq = 0;
  private readonly waiters: Waiter[] = [];
  private pumping = false;
  private slowUntil = 0;
  private readonly now: () => number;

  constructor(private readonly opts: LocalRateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.tokens = opts.burst ?? Math.max(1, opts.rps);
    this.last = this.now();
  }

  get rate(): number {
    return this.now() < this.slowUntil ? this.opts.rps * (this.opts.backOffFactor ?? 0.8) : this.opts.rps;
  }

  backOff(): void {
    this.slowUntil = this.now() + (this.opts.backOffMs ?? 10 * 60_000);
  }

  private refill(): void {
    const t = this.now();
    const burst = this.opts.burst ?? Math.max(1, this.opts.rps);
    this.tokens = Math.min(burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }

  acquire(priority: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { priority, seq: this.seq++, resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      this.waiters.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiters.length > 0) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          const w = this.waiters.shift();
          if (!w) break;
          if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
          w.resolve();
          continue;
        }
        await sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      }
    } finally {
      this.pumping = false;
    }
  }
}
