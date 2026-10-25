// The week's quota as NanoGPT reports it, for the operator to see: the dashboard, `ctl status` and the long runs' logs.
// Owner request (2026-10-25): the quota never changes what the agents think, how or how often; when it runs short,
// more is bought. So nothing here is read by the client or the agents. (The §22.4 ladder and the per-agent hourly
// shares it replaced are gone.) The subscription lock stays: inference only on the subscription, with a key that can't
// spend balance, so a used-up quota means refused calls, never paid ones.

import type { Logger } from '@agora/shared';
import type { Usage } from './usage';

export interface QuotaView {
  /** Fractions of the week's and the day's input tokens used (they may pass 1); null when not reported. */
  weeklyPercent: number | null;
  dailyPercent: number | null;
  /** Weekly input tokens left. */
  remaining: number | null;
  /** The next reset, epoch ms. */
  resetAt: number | null;
  /** NanoGPT's routing advice: 'subscription' while the quota covers calls. */
  recommendedMode: string | null;
  polledAt: number;
}

export function quotaView(u: Usage, now = Date.now()): QuotaView {
  const weekly = u.weeklyInputTokens ?? null;
  const daily = u.dailyInputTokens ?? null;
  const resets = [weekly?.resetAt, daily?.resetAt].filter((v): v is number => typeof v === 'number' && v > now);
  return {
    weeklyPercent: typeof weekly?.percentUsed === 'number' ? weekly.percentUsed : null,
    dailyPercent: typeof daily?.percentUsed === 'number' ? daily.percentUsed : null,
    remaining: typeof weekly?.remaining === 'number' ? weekly.remaining : null,
    resetAt: resets.length > 0 ? Math.min(...resets) : null,
    recommendedMode: u.routing?.recommendedMode ?? null,
    polledAt: now,
  };
}

/** One line for logs: "quota 42.0% of the week used, resets 2026-10-26T00:00:00.000Z". */
export function describeQuota(q: QuotaView | null): string {
  if (!q) return 'quota not known';
  const used = q.weeklyPercent === null ? 'quota not reported' : `quota ${(q.weeklyPercent * 100).toFixed(1)}% of the week used`;
  const reset = q.resetAt === null ? '' : `, resets ${new Date(q.resetAt).toISOString()}`;
  const mode = q.recommendedMode && q.recommendedMode !== 'subscription' ? `; NanoGPT advises ${q.recommendedMode}: calls will be refused until the reset or more is bought` : '';
  return `${used}${reset}${mode}`;
}

export interface QuotaWatchOptions {
  fetchUsage: (signal?: AbortSignal) => Promise<Usage>;
  pollMs: number;
  logger: Logger;
  now?: () => number;
}

/** Reads the quota now and then. It tells the operator when the subscription stops covering calls; it changes nothing. */
export class QuotaWatch {
  private current: QuotaView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: QuotaWatchOptions) {
    this.now = opts.now ?? Date.now;
  }

  get view(): QuotaView | null {
    return this.current;
  }

  /** Takes a usage response fetched elsewhere (the startup check). */
  ingest(usage: Usage): QuotaView {
    const before = this.current;
    const after = quotaView(usage, this.now());
    this.current = after;
    const covered = (q: QuotaView | null) => !q?.recommendedMode || q.recommendedMode === 'subscription';
    if (before && covered(before) && !covered(after)) this.opts.logger.warn({ module: 'llm', event: 'quota' }, describeQuota(after));
    return after;
  }

  async poll(): Promise<QuotaView | null> {
    try {
      return this.ingest(await this.opts.fetchUsage(AbortSignal.timeout(15_000)));
    } catch (err) {
      this.opts.logger.warn({ module: 'llm', err: String(err) }, 'usage poll failed');
      return this.current;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
