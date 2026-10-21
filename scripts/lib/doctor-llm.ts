// Doctor's §22.1 check: the key must be "Subscription only" and the subscription active.

import path from 'node:path';
import { type ModelsConfig, repoRoot } from '@agora/shared';
import { createGuardedFetch } from '@agora/llm/guard';
import { ModelAllowlist, fetchSubscriptionModels } from '@agora/llm/models';
import { loadBenchFile, tierRuntimes } from '@agora/llm/start';
import { TIERS, resolveTiers } from '@agora/llm/tiers';
import { evaluateKeyLock, fetchUsage } from '@agora/llm/usage';

export async function checkSubscriptionLock(
  apiKey: string,
  models: ModelsConfig,
): Promise<{ status: 'ok' | 'warn' | 'fail'; detail: string }> {
  try {
    const usage = await fetchUsage(createGuardedFetch(), apiKey, AbortSignal.timeout(15000));
    const v = evaluateKeyLock(usage, models.llm.allowPaidKey);
    if (!v.ok) return { status: 'fail', detail: v.fatal ?? 'refused' };
    const weekly = usage.weeklyInputTokens;
    const quota =
      typeof weekly?.percentUsed === 'number' ? `weekly quota ${(weekly.percentUsed * 100).toFixed(1)}% used` : 'weekly quota unknown';
    if (v.warnings.length > 0) return { status: 'warn', detail: `${v.warnings.join(' ')} (${quota})` };
    return { status: 'ok', detail: `Subscription only, state ${usage.state}, ${quota}` };
  } catch (err) {
    return { status: 'fail', detail: `could not query usage: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** §22.3: resolve the tier chains from the live subscription list (public metadata; works without a key). */
export async function checkTiers(models: ModelsConfig, apiKey?: string): Promise<{ status: 'ok' | 'warn' | 'fail'; detail: string }> {
  try {
    const list = await fetchSubscriptionModels(createGuardedFetch(), apiKey, AbortSignal.timeout(15000));
    const bench = loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'));
    const res = resolveTiers(new ModelAllowlist(list), tierRuntimes(models), bench);
    const lines = TIERS.map((t) => `${t}${res.mappedTo[t] !== t ? `→${res.mappedTo[t] ?? 'none'}` : ''}: ${res.chains[t].slice(0, 3).join(', ') || '—'}`);
    const detail = `${list.length} subscription models${bench ? ', bench results used' : ''}; ${lines.join(' | ')}`;
    if (res.codeOnly) return { status: 'fail', detail: `no model fits L1: code-only. ${detail}` };
    if (TIERS.some((t) => res.mappedTo[t] !== t) || res.notes.length > 0) return { status: 'warn', detail: `${res.notes.join('; ')}. ${detail}` };
    return { status: 'ok', detail };
  } catch (err) {
    return { status: 'fail', detail: `could not read the subscription model list: ${err instanceof Error ? err.message : String(err)}` };
  }
}
