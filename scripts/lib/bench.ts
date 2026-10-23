// Statistics for the §11 latency check (`pnpm bench-models`).

import type { BenchFile, TierName } from '@agora/llm';

export interface BenchSample {
  model: string;
  /** The tier whose prompts were sent. */
  tier?: TierName;
  ms: number;
  /** A real model reply (not the code default). */
  ok: boolean;
  /** Structured call: the reply validated. */
  json?: boolean;
  /** Streamed call: time to the first token. */
  ttftMs?: number;
  /** CC-style call: the decision named a real skill with valid args. */
  toolOk?: boolean;
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? 0;
}

const rate = (xs: readonly boolean[]) => (xs.length === 0 ? 0 : xs.filter(Boolean).length / xs.length);
const round = (n: number) => Math.round(n * 1000) / 1000;

/** One result per model and tier measured. */
export function summarizeBench(samples: readonly BenchSample[]): BenchFile['results'] {
  const by = new Map<string, BenchSample[]>();
  for (const s of samples) by.set(`${s.tier ?? ''} ${s.model}`, [...(by.get(`${s.tier ?? ''} ${s.model}`) ?? []), s]);
  return [...by.values()].map((xs) => {
    const model = xs[0]?.model ?? '';
    const tier = xs[0]?.tier;
    const okMs = xs.filter((x) => x.ok).map((x) => x.ms);
    const json = xs.filter((x) => x.json !== undefined).map((x) => x.json === true);
    const ttft = xs.flatMap((x) => (x.ttftMs !== undefined ? [x.ttftMs] : []));
    const tool = xs.filter((x) => x.toolOk !== undefined).map((x) => x.toolOk === true);
    return {
      model,
      ...(tier ? { tier } : {}),
      calls: xs.length,
      okRate: round(rate(xs.map((x) => x.ok))),
      jsonOkRate: round(json.length > 0 ? rate(json) : 1),
      p50Ms: percentile(okMs, 50),
      p90Ms: percentile(okMs, 90),
      ...(ttft.length > 0 ? { ttftP50Ms: percentile(ttft, 50) } : {}),
      ...(tool.length > 0 ? { toolArgOkRate: round(rate(tool)) } : {}),
    };
  });
}

/** Keeps earlier results for the models and tiers not measured this run. */
export function mergeBench(previous: BenchFile | null, fresh: BenchFile['results'], measuredAt: string): BenchFile {
  const key = (r: BenchFile['results'][number]) => `${r.tier ?? ''} ${r.model}`;
  const seen = new Set(fresh.map(key));
  return { measuredAt, results: [...fresh, ...(previous?.results ?? []).filter((r) => !seen.has(key(r)))] };
}
