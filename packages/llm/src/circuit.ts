// §22.6: after 3 consecutive provider failures (5xx / timeout) a model is skipped for 5 minutes.

export interface CircuitOptions {
  failures?: number;
  openMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly fails = new Map<string, number>();
  private readonly openUntil = new Map<string, number>();
  private readonly limit: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitOptions = {}) {
    this.limit = opts.failures ?? 3;
    this.openMs = opts.openMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Records a failure; true when this one opened the circuit. */
  failure(model: string): boolean {
    const n = (this.fails.get(model) ?? 0) + 1;
    this.fails.set(model, n);
    if (n >= this.limit) {
      this.fails.set(model, 0);
      this.openUntil.set(model, this.now() + this.openMs);
      return true;
    }
    return false;
  }

  success(model: string): void {
    this.fails.delete(model);
  }

  isOpen(model: string): boolean {
    const until = this.openUntil.get(model);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.openUntil.delete(model);
      return false;
    }
    return true;
  }

  open(): string[] {
    return [...this.openUntil.keys()].filter((m) => this.isOpen(m));
  }
}
