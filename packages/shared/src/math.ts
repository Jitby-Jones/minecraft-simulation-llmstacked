// Small numeric helpers shared by the emotion, social and conflict math.

export function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Exponential moving average step: alpha in (0,1]. */
export function ema(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha;
}

/** Multiplier that applies a half-life decay over `dtMs`. halfLifeMs <= 0 means "decay instantly". */
export function halfLifeFactor(dtMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 0;
  if (dtMs <= 0) return 1;
  return Math.pow(0.5, dtMs / halfLifeMs);
}

/** Moves `value` toward `target` by a half-life decay over dtMs. */
export function decayToward(value: number, target: number, dtMs: number, halfLifeMs: number): number {
  return target + (value - target) * halfLifeFactor(dtMs, halfLifeMs);
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Shannon entropy in bits of a list of labels: 0 when they are all the same, log2(n) when all differ. */
export function shannonEntropy(labels: readonly string[]): number {
  if (labels.length === 0) return 0;
  const m = new Map<string, number>();
  for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1);
  let h = 0;
  for (const n of m.values()) {
    const p = n / labels.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 1000) / 1000;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return s / (values.length - 1);
}

export function stddev(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

/** Cohen's d with pooled standard deviation: (mean(a) - mean(b)) / sd_pooled. */
export function cohensD(a: readonly number[], b: readonly number[]): number {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return 0;
  const pooled = Math.sqrt(((na - 1) * variance(a) + (nb - 1) * variance(b)) / (na + nb - 2));
  return pooled === 0 ? 0 : (mean(a) - mean(b)) / pooled;
}

export function dotProduct(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function norm(a: readonly number[]): number {
  return Math.sqrt(dotProduct(a, a));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dotProduct(a, b) / (na * nb);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf approximation). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Overlapping coefficient of two equal-variance normals separated by Cohen's d: 2·Φ(−|d|/2). */
export function overlapCoefficient(d: number): number {
  return 2 * normalCdf(-Math.abs(d) / 2);
}

export function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function maxOf(values: readonly number[], fallback = 0): number {
  if (values.length === 0) return fallback;
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}
