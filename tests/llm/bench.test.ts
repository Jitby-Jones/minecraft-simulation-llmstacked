// §11 latency check statistics.

import { describe, expect, it } from 'vitest';
import { mergeBench, percentile, summarizeBench } from '../../scripts/lib/bench';

describe('bench statistics', () => {
  it('computes percentiles over successful calls and rates over all', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBe(0);
    const [r] = summarizeBench([
      { model: 'm', ms: 100, ok: true, json: true, toolOk: true },
      { model: 'm', ms: 300, ok: true, json: true, toolOk: false },
      { model: 'm', ms: 9999, ok: false, json: false },
      { model: 'm', ms: 200, ok: true, ttftMs: 40 },
    ]);
    expect(r).toMatchObject({ model: 'm', calls: 4, okRate: 0.75, jsonOkRate: 0.667, p50Ms: 200, p90Ms: 300, ttftP50Ms: 40, toolArgOkRate: 0.5 });
  });

  it('keeps earlier results for models not measured again', () => {
    const prev = { measuredAt: 'old', results: [{ model: 'a', calls: 1, okRate: 1, jsonOkRate: 1, p50Ms: 1, p90Ms: 1 }, { model: 'b', calls: 1, okRate: 0, jsonOkRate: 0, p50Ms: 0, p90Ms: 0 }] };
    const merged = mergeBench(prev, [{ model: 'b', calls: 2, okRate: 1, jsonOkRate: 1, p50Ms: 5, p90Ms: 6 }], 'new');
    expect(merged.measuredAt).toBe('new');
    expect(merged.results.map((r) => [r.model, r.calls])).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
  });
});
