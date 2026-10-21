// GET /api/subscription/v1/usage (§22.1, §22.4). Shape from NanoGPT's OpenAPI spec: quota objects have
// used/remaining/percentUsed (fraction)/resetAt (epoch ms)/degraded; routing has recommendedMode and
// paidSpendPolicyAllowsBalance. Parsed leniently: NanoGPT may add fields; we never hard-code quota sizes.

import { z } from 'zod';
import { SUBSCRIPTION_BASE_URL } from './guard';

const QuotaSchema = z
  .object({
    used: z.number().nullable().optional(),
    remaining: z.number().nullable().optional(),
    percentUsed: z.number().nullable().optional(),
    resetAt: z.number().nullable().optional(),
    degraded: z.boolean().optional(),
  })
  .loose();
export type Quota = z.infer<typeof QuotaSchema>;

export const UsageSchema = z
  .object({
    active: z.boolean(),
    state: z.string(),
    limits: z
      .object({
        dailyInputTokens: z.number().nullable().optional(),
        weeklyInputTokens: z.number().nullable().optional(),
      })
      .loose()
      .optional(),
    dailyInputTokens: QuotaSchema.nullable().optional(),
    weeklyInputTokens: QuotaSchema.nullable().optional(),
    routing: z
      .object({
        recommendedMode: z.string().optional(),
        reason: z.string().optional(),
        subscriptionQuotaAvailable: z.boolean().nullable().optional(),
        paidSpendPolicyAllowsBalance: z.boolean().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
export type Usage = z.infer<typeof UsageSchema>;

export interface KeyLockVerdict {
  /** false = refuse to start. */
  ok: boolean;
  fatal: string | null;
  warnings: string[];
}

/** Layer 1 startup check (§22.1). */
export function evaluateKeyLock(usage: Usage, allowPaidKey: boolean): KeyLockVerdict {
  const warnings: string[] = [];
  const paid = usage.routing?.paidSpendPolicyAllowsBalance;
  if (paid === true && !allowPaidKey) {
    return {
      ok: false,
      fatal:
        'Set your NanoGPT key to Subscription only (dashboard → API keys), or set `llm.allowPaidKey: true` to override.',
      warnings,
    };
  }
  if (paid === undefined) {
    warnings.push(
      'NanoGPT did not report routing.paidSpendPolicyAllowsBalance, so the key billing mode cannot be verified. ' +
        'Inference still only runs while NanoGPT recommends subscription mode (§22.4).',
    );
  }
  if (!usage.active || usage.state === 'inactive') {
    return { ok: false, fatal: 'The NanoGPT subscription is not active (state: inactive).', warnings };
  }
  if (usage.state === 'grace') warnings.push('The NanoGPT subscription is in its grace period.');
  return { ok: true, fatal: null, warnings };
}

export async function fetchUsage(fetchImpl: typeof fetch, apiKey: string, signal?: AbortSignal): Promise<Usage> {
  const res = await fetchImpl(`${SUBSCRIPTION_BASE_URL}/usage`, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new UsageError(res.status, await safeText(res));
  return UsageSchema.parse(await res.json());
}

export class UsageError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`usage endpoint returned ${status}: ${body.slice(0, 200)}`);
    this.name = 'UsageError';
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
