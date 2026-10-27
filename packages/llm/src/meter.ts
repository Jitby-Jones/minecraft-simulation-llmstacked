// Token meter per module, tier, model and agent, in input and output tokens: for the dashboard and the run reports.
// It rations nothing (owner request, 2026-10-25: the quota never limits thinking).

import type { LlmModule, ThoughtKind } from '@agora/shared';
import type { TierName } from './tiers';

export interface CostRecord {
  ts: number;
  agent: string;
  module: LlmModule;
  tier: TierName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  ok: boolean;
  /** The kind of thought the request was for. */
  thought?: ThoughtKind;
  /** Why a request failed (timeout, provider, schema_invalid, …). */
  failure?: string;
  /** The reply stopped at its length cap. */
  truncated?: boolean;
}

export interface MeterTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

const HOUR = 3_600_000;

function add(map: Map<string, MeterTotals>, key: string, r: CostRecord): void {
  const t = map.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  t.calls++;
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  map.set(key, t);
}

export class CostMeter {
  private readonly recent: CostRecord[] = [];
  readonly byModule = new Map<string, MeterTotals>();
  readonly byTier = new Map<string, MeterTotals>();
  readonly byModel = new Map<string, MeterTotals>();
  readonly byAgent = new Map<string, MeterTotals>();

  constructor(private readonly now: () => number = Date.now) {}

  record(r: CostRecord): void {
    this.recent.push(r);
    add(this.byModule, r.module, r);
    add(this.byTier, r.tier, r);
    add(this.byModel, r.model, r);
    add(this.byAgent, r.agent, r);
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - HOUR;
    let i = 0;
    while (i < this.recent.length && (this.recent[i]?.ts ?? 0) < cutoff) i++;
    if (i > 0) this.recent.splice(0, i);
  }

  /** Input tokens an agent spent in the last 60 minutes (rolling). */
  spentThisHour(agent: string): number {
    this.prune();
    return this.recent.filter((r) => r.agent === agent).reduce((a, r) => a + r.inputTokens, 0);
  }

  /** Input tokens per hour across all agents (last 60 minutes). */
  inputPerHour(): number {
    this.prune();
    return this.recent.reduce((a, r) => a + r.inputTokens, 0);
  }

  /** When the weekly quota runs out at the current burn, if before the reset (epoch ms), else null. */
  projectedExhaustion(remaining: number | null, resetAt: number | null): number | null {
    const rate = this.inputPerHour();
    if (remaining === null || rate <= 0) return null;
    const at = this.now() + (remaining / rate) * HOUR;
    return resetAt !== null && at >= resetAt ? null : at;
  }
}
