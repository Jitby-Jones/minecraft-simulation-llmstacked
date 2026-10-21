// Per-module single-flight (§4.2): at most one in-flight LLM call per key; a new trigger replaces the queued
// one, which resolves as superseded without ever running.

export const SUPERSEDED: unique symbol = Symbol('superseded');
export type Superseded = typeof SUPERSEDED;

interface Queued<T> {
  fn: () => Promise<T>;
  resolve: (v: T | Superseded) => void;
  reject: (err: unknown) => void;
}

export class SingleFlight<T> {
  private readonly running = new Set<string>();
  private readonly queued = new Map<string, Queued<T>>();

  /** Runs now if `key` is idle; otherwise waits behind the running call, replacing any older queued one. */
  run(key: string, fn: () => Promise<T>): Promise<T | Superseded> {
    return new Promise<T | Superseded>((resolve, reject) => {
      if (!this.running.has(key)) {
        this.start(key, { fn, resolve, reject });
        return;
      }
      this.queued.get(key)?.resolve(SUPERSEDED);
      this.queued.set(key, { fn, resolve, reject });
    });
  }

  inFlight(key: string): boolean {
    return this.running.has(key);
  }

  private start(key: string, job: Queued<T>): void {
    this.running.add(key);
    // Free the key before settling, so a caller that awaits the result sees it idle (or the next job running).
    const done = () => {
      this.running.delete(key);
      const next = this.queued.get(key);
      if (next) {
        this.queued.delete(key);
        this.start(key, next);
      }
    };
    job.fn().then(
      (v) => {
        done();
        job.resolve(v);
      },
      (err: unknown) => {
        done();
        job.reject(err);
      },
    );
  }
}
