// Starts the LLM layer: layer-1 key check (§22.1), the subscription allowlist and tier chains (§22.3), the quota
// governor (§22.4), and the client. Refuses to start when the key can spend balance.

import fs from 'node:fs';
import { z } from 'zod';
import type { Logger, ModelsConfig } from '@agora/shared';
import { LlmClient, type TierRuntime } from './client';
import { QuotaGovernor } from './governor';
import { createGuardedFetch } from './guard';
import { CostMeter, type CostRecord } from './meter';
import { ModelAllowlist, fetchSubscriptionModels } from './models';
import { LocalRateLimiter, type TokenSource } from './ratelimit';
import { type BenchFile, ModelRouter, TIERS, type TierName } from './tiers';
import { evaluateKeyLock, fetchUsage } from './usage';

export class KeyLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyLockError';
  }
}

const BenchFileSchema = z.object({
  measuredAt: z.string(),
  results: z.array(
    z.object({
      model: z.string(),
      calls: z.number().int().nonnegative(),
      okRate: z.number().min(0).max(1),
      jsonOkRate: z.number().min(0).max(1),
      p50Ms: z.number().nonnegative(),
      p90Ms: z.number().nonnegative(),
      ttftP50Ms: z.number().nonnegative().optional(),
      toolArgOkRate: z.number().min(0).max(1).optional(),
    }),
  ),
});

/** config/model-bench.json, if present and valid. */
export function loadBenchFile(file: string, logger?: Logger): BenchFile | null {
  if (!fs.existsSync(file)) return null;
  try {
    return BenchFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    logger?.warn({ module: 'llm', file, err: String(err) }, 'ignoring an invalid model bench file');
    return null;
  }
}

export function tierRuntimes(config: ModelsConfig): Record<TierName, TierRuntime> {
  const out = {} as Record<TierName, TierRuntime>;
  for (const t of TIERS) {
    const c = config.tiers[t];
    out[t] = { primary: c.primary, fallbacks: c.fallbacks, need: c.need, timeoutMs: c.timeoutMs, maxTokens: c.maxTokens };
  }
  return out;
}

export interface StartLlmOptions {
  apiKey: string;
  config: ModelsConfig;
  logger: Logger;
  bench?: BenchFile | null;
  /** Underlying fetch (tests: a fake NanoGPT). Always wrapped by the guard. */
  fetch?: typeof fetch;
  limiter?: TokenSource;
  activeAgents?: () => number;
  onCost?: (r: CostRecord) => void;
  now?: () => number;
  /** Periodic allowlist refresh and usage polling (off in tests). */
  background?: boolean;
}

export interface LlmRuntime {
  client: LlmClient;
  router: ModelRouter;
  governor: QuotaGovernor;
  meter: CostMeter;
  limiter: TokenSource;
  stop(): void;
}

export async function startLlm(o: StartLlmOptions): Promise<LlmRuntime> {
  const { config, logger } = o;
  const http = createGuardedFetch({ baseFetch: o.fetch });
  if (config.llm.baseUrl === 'paid') {
    logger.warn({ module: 'llm' }, "llm.baseUrl 'paid' is not implemented; inference stays on the subscription endpoint (§22.2)");
  }
  // Layer 1: the key must not be able to spend balance.
  const usage = await fetchUsage(http, o.apiKey, AbortSignal.timeout(15_000));
  const verdict = evaluateKeyLock(usage, config.llm.allowPaidKey);
  for (const w of verdict.warnings) logger.warn({ module: 'llm' }, w);
  if (!verdict.ok) throw new KeyLockError(verdict.fatal ?? 'NanoGPT key check failed');

  // Layer 3: the subscription list is the allowlist.
  const fetchModels = (signal?: AbortSignal) => fetchSubscriptionModels(http, o.apiKey, signal);
  const allowlist = new ModelAllowlist(await fetchModels(AbortSignal.timeout(15_000)), o.now?.());
  const specs = tierRuntimes(config);
  const router = new ModelRouter({
    allowlist,
    fetchModels,
    specs,
    bench: o.bench,
    refreshMs: config.llm.allowlistRefreshHours * 3_600_000,
    logger,
    now: o.now,
  });
  const res = router.resolution;
  logger.info({ module: 'llm', chains: res.chains, mappedTo: res.mappedTo, models: allowlist.size }, 'subscription tiers resolved');
  for (const n of res.notes) logger.warn({ module: 'llm' }, n);

  // Layer 4: quota governor, seeded with the startup poll.
  const governor = new QuotaGovernor({
    fetchUsage: (signal) => fetchUsage(http, o.apiKey, signal),
    pollMs: config.llm.usagePollSec * 1000,
    runtimeHoursPerWeek: config.llm.expectedRuntimeHoursPerWeek,
    logger,
    now: o.now,
  });
  governor.ingest(usage);
  const meter = new CostMeter(o.now);
  const limiter = o.limiter ?? new LocalRateLimiter({ rps: 20, now: o.now });
  const client = new LlmClient({
    apiKey: o.apiKey,
    router,
    governor,
    meter,
    limiter,
    specs,
    logger,
    fetch: o.fetch,
    activeAgents: o.activeAgents,
    onCost: o.onCost,
    now: o.now,
  });
  if (o.background ?? true) {
    router.start();
    governor.start();
  }
  return {
    client,
    router,
    governor,
    meter,
    limiter,
    stop() {
      router.stop();
      governor.stop();
    },
  };
}
