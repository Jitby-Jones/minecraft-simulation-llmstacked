// §22.8 live smoke test (M2). Spends real subscription quota, so it only runs with NANOGPT_API_KEY set AND
// AGORA_LIVE_LLM=1. It never sends anything but subscription-path requests to allowlisted models.

import { describe, expect, it } from 'vitest';
import { createLogger, loadEnv, loadModelsConfigForRuns } from '@agora/shared';
import { ModelNotInSubscription, TIERS, createGuardedFetch, startLlm } from '@agora/llm';

loadEnv();
const key = process.env.NANOGPT_API_KEY?.trim();
const enabled = Boolean(key) && process.env.AGORA_LIVE_LLM === '1';

async function balance(): Promise<unknown> {
  const res = await createGuardedFetch()('https://nano-gpt.com/api/check-balance', {
    method: 'POST',
    headers: { 'x-api-key': key ?? '', 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.ok).toBe(true);
  return res.json();
}

describe.skipIf(!enabled)('M2 live: NanoGPT subscription lock', () => {
  it('runs 20 calls per tier without the balance changing', async () => {
    const rt = await startLlm({ apiKey: key ?? '', config: loadModelsConfigForRuns(), logger: createLogger({ name: 'm2-live', console: false }), background: false });
    try {
      const before = JSON.stringify(await balance());
      let ok = 0;
      for (const tier of TIERS) {
        for (let i = 0; i < 20; i++) {
          const r = await rt.client.call<string>({
            tier,
            module: 'bench',
            agent: 'live-test',
            messages: [{ role: 'user', content: `Say the word "ok" and nothing else. (${tier} #${i})` }],
            fallback: () => '',
          });
          if (r.ok) ok++;
        }
      }
      expect(ok).toBeGreaterThan(45);
      expect(JSON.stringify(await balance())).toBe(before);
    } finally {
      rt.stop();
    }
  }, 900_000);

  it('blocks a paid-only model locally, before sending', async () => {
    const rt = await startLlm({ apiKey: key ?? '', config: loadModelsConfigForRuns(), logger: createLogger({ name: 'm2-live', console: false }), background: false });
    try {
      await expect(
        rt.client.call<string>({ tier: 'L1', module: 'bench', agent: 'live-test', model: 'openai/gpt-paid-only-model', messages: [{ role: 'user', content: 'hi' }], fallback: () => '' }),
      ).rejects.toBeInstanceOf(ModelNotInSubscription);
    } finally {
      rt.stop();
    }
  });
});
