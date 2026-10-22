// Layer 4 (§22.4): budgets are subscription input-token quota, polled from /api/subscription/v1/usage. The degrade
// ladder turns quota pressure into cheaper behavior, ending in code-only mode; nothing here can switch to paid
// billing, whatever the usage endpoint says (recommendedMode paygo means stop, not pay).

import { EventEmitter } from 'node:events';
import { type LlmModule, type Logger, MODULE_PRIORITY } from '@agora/shared';
import type { TierName } from './tiers';
import type { Usage } from './usage';

/** The modules that call the LLM (the Hub protocol's names). */
export type ModuleName = LlmModule;
/** §5: Talking > CC > Social > Self-Monitor > Goal > Reflection; higher is served first. */
export { MODULE_PRIORITY };

/** 0 normal · 1 (70–85 %) · 2 (85–95 %) · 3 code-only. */
export type DegradeLevel = 0 | 1 | 2 | 3;

export interface QuotaStatus {
  level: DegradeLevel;
  codeOnly: boolean;
  reason: string;
  /** Weekly (or daily, if that is tighter) reset, epoch ms. */
  resetAt: number | null;
  weeklyPercent: number | null;
  dailyPercent: number | null;
  /** Weekly input tokens left. */
  remaining: number | null;
  /** NanoGPT could not report the quota: treated as level 1 until a good poll. */
  unknown: boolean;
  polledAt: number;
}

function levelFor(fraction: number): DegradeLevel {
  if (fraction >= 0.95) return 3;
  if (fraction >= 0.85) return 2;
  if (fraction >= 0.7) return 1;
  return 0;
}

/** The §22.4 table, applied to one usage response. */
export function statusFromUsage(u: Usage, now = Date.now()): QuotaStatus {
  const weekly = u.weeklyInputTokens ?? null;
  const daily = u.dailyInputTokens ?? null;
  const weeklyPercent = typeof weekly?.percentUsed === 'number' ? weekly.percentUsed : null;
  const dailyPercent = typeof daily?.percentUsed === 'number' ? daily.percentUsed : null;
  const resets = [weekly?.resetAt, daily?.resetAt].filter((v): v is number => typeof v === 'number' && v > now);
  const base = {
    resetAt: resets.length > 0 ? Math.min(...resets) : null,
    weeklyPercent,
    dailyPercent,
    remaining: typeof weekly?.remaining === 'number' ? weekly.remaining : null,
    polledAt: now,
  };
  const mode = u.routing?.recommendedMode;
  if (!u.active || u.state === 'inactive') return { ...base, level: 3, codeOnly: true, reason: 'subscription inactive', unknown: false };
  if (mode === 'unavailable' || mode === 'paygo') {
    // Never switch to paid billing (§22.4): wait for the reset instead.
    return { ...base, level: 3, codeOnly: true, reason: `NanoGPT recommends ${mode}; code-only until the quota resets`, unknown: false };
  }
  const unknown = weekly?.degraded === true || daily?.degraded === true || (weeklyPercent === null && dailyPercent === null);
  const used = Math.max(weeklyPercent ?? 0, dailyPercent ?? 0);
  let level = levelFor(used);
  if (unknown && level < 1) level = 1;
  const reason = unknown ? 'quota unknown (degraded)' : `quota ${(used * 100).toFixed(1)}% used`;
  return { ...base, level, codeOnly: level === 3, reason, unknown };
}

export interface LadderEffects {
  /** Tier actually used for a requested tier (null: no LLM). */
  tier: (requested: TierName, module: ModuleName) => TierName | null;
  /** Multiplier on a module's cadence (2 = half as often). */
  cadence: (module: ModuleName) => number;
  enabled: (module: ModuleName) => boolean;
  /** Minimum Self-Monitor interval in seconds (85–95 %: every 30 s). */
  selfMonitorMinSec: number | null;
}

/** What a degrade level means for modules (§22.4 table). */
export function ladder(level: DegradeLevel): LadderEffects {
  return {
    tier: (requested, module) => {
      if (level >= 3) return null;
      if (level >= 2 && module === 'cc') return 'L1'; // intelligence-routed CC tiers forced to L1
      if (level >= 1 && requested === 'L3') return 'L2';
      return requested;
    },
    cadence: (module) => (level >= 1 && (module === 'reflection' || module === 'goal' || module === 'skillWriter') ? 2 : 1),
    enabled: (module) => level < 3 && !(level >= 2 && module === 'socialGoal'),
    selfMonitorMinSec: level >= 2 ? 30 : null,
  };
}

/** §5 per-agent budget: L3 off first, then Social Goal Gen slows, then L2 → L1, then code-only. */
export interface AgentDegrade {
  l3Off: boolean;
  socialGoalSlow: boolean;
  l2ToL1: boolean;
  codeOnly: boolean;
}

export function agentDegrade(spentThisHour: number, allowancePerHour: number | null): AgentDegrade {
  if (allowancePerHour === null || allowancePerHour <= 0) {
    return { l3Off: false, socialGoalSlow: false, l2ToL1: false, codeOnly: allowancePerHour !== null };
  }
  const f = spentThisHour / allowancePerHour;
  return { l3Off: f >= 0.7, socialGoalSlow: f >= 0.8, l2ToL1: f >= 0.9, codeOnly: f >= 1 };
}

export function applyAgentDegrade(tier: TierName | null, d: AgentDegrade): TierName | null {
  if (tier === null || d.codeOnly) return null;
  if (d.l2ToL1 && (tier === 'L2' || tier === 'L3')) return 'L1';
  if (d.l3Off && tier === 'L3') return 'L2';
  return tier;
}

/**
 * perAgentHourly = remaining / (activeAgents × hoursUntilReset × dutyCycle), dutyCycle = runtime hours / 168.
 * Null when the quota is unknown.
 */
export function perAgentHourly(
  remaining: number | null,
  resetAt: number | null,
  activeAgents: number,
  runtimeHoursPerWeek: number,
  now = Date.now(),
): number | null {
  if (remaining === null || resetAt === null) return null;
  const hours = Math.max(1, (resetAt - now) / 3_600_000);
  const duty = Math.min(1, Math.max(1 / 168, runtimeHoursPerWeek / 168));
  return remaining / (Math.max(1, activeAgents) * hours * duty);
}

export interface GovernorOptions {
  fetchUsage: (signal?: AbortSignal) => Promise<Usage>;
  pollMs: number;
  runtimeHoursPerWeek: number;
  logger: Logger;
  now?: () => number;
}

export class QuotaGovernor extends EventEmitter<{ change: [QuotaStatus] }> {
  private current: QuotaStatus;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<QuotaStatus> | null = null;
  private forced: { reason: string; until: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: GovernorOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.current = {
      level: 1,
      codeOnly: false,
      reason: 'quota not polled yet',
      resetAt: null,
      weeklyPercent: null,
      dailyPercent: null,
      remaining: null,
      unknown: true,
      polledAt: 0,
    };
  }

  get status(): QuotaStatus {
    if (this.forced && this.now() < this.forced.until) {
      return { ...this.current, level: 3, codeOnly: true, reason: this.forced.reason };
    }
    return this.current;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll('scheduled'), this.opts.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Takes a usage response fetched elsewhere (the startup check). */
  ingest(usage: Usage): QuotaStatus {
    const before = this.status;
    this.current = statusFromUsage(usage, this.now());
    const after = this.status;
    if (after.level !== before.level || after.codeOnly !== before.codeOnly) this.emit('change', after);
    return after;
  }

  /** Polls now (single-flight). A failed poll keeps the last status but marks the quota unknown (≥ level 1). */
  poll(reason: string): Promise<QuotaStatus> {
    this.polling ??= (async () => {
      const before = this.status;
      try {
        const usage = await this.opts.fetchUsage(AbortSignal.timeout(15_000));
        this.current = statusFromUsage(usage, this.now());
      } catch (err) {
        this.opts.logger.warn({ module: 'llm', reason, err: String(err) }, 'usage poll failed');
        this.current = { ...this.current, unknown: true, level: Math.max(1, this.current.level) as DegradeLevel, reason: 'usage poll failed' };
      } finally {
        this.polling = null;
      }
      const after = this.status;
      if (after.level !== before.level || after.codeOnly !== before.codeOnly) {
        this.opts.logger.warn({ module: 'llm', event: 'quotaMode', from: before.level, to: after.level, reason: after.reason }, 'quota mode change');
        this.emit('change', after);
      }
      return after;
    })();
    return this.polling;
  }

  /** Takes the status the Hub computed for this agent (one usage poll for everyone, §22.4); bots don't poll then. */
  setExternal(level: DegradeLevel, codeOnly: boolean, reason: string, resetAt: number | null): void {
    const before = this.status;
    this.current = { ...this.current, level: codeOnly ? 3 : level, codeOnly, reason, resetAt, unknown: false, polledAt: this.now() };
    const after = this.status;
    if (after.level !== before.level || after.codeOnly !== before.codeOnly) this.emit('change', after);
  }

  /** Daily key cap or a revoked key: no LLM until `untilMs` (or until a poll after it says otherwise). */
  forceCodeOnly(reason: string, untilMs: number): void {
    const before = this.status;
    this.forced = { reason, until: untilMs };
    this.opts.logger.warn({ module: 'llm', event: 'quotaMode', reason, until: new Date(untilMs).toISOString() }, 'code-only mode');
    if (!before.codeOnly) this.emit('change', this.status);
  }

  perAgentHourly(activeAgents: number): number | null {
    const s = this.status;
    return perAgentHourly(s.remaining, s.resetAt, activeAgents, this.opts.runtimeHoursPerWeek, this.now());
  }
}
