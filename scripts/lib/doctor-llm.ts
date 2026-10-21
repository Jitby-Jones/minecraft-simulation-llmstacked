// Doctor's §22.1 check: the key must be "Subscription only" and the subscription active.

import type { ModelsConfig } from '@agora/shared';
import { createGuardedFetch } from '@agora/llm/guard';
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
