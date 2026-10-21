// Seedable RNG so persona sampling, reaction rolls and tests are reproducible.

import { clamp01 } from './math';

export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
}

/** mulberry32: tiny, fast, good enough for simulation sampling. */
export class SeededRandom implements Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export const defaultRandom: Random = { next: () => Math.random() };

export function seedFromString(text: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function uniform(rng: Random, lo: number, hi: number): number {
  return lo + (hi - lo) * rng.next();
}

export function randInt(rng: Random, lo: number, hiInclusive: number): number {
  return Math.floor(uniform(rng, lo, hiInclusive + 1));
}

export function chance(rng: Random, p: number): boolean {
  return rng.next() < p;
}

/** Box–Muller standard normal sample. */
export function gaussian(rng: Random): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function normal(rng: Random, mu: number, sigma: number): number {
  return mu + sigma * gaussian(rng);
}

/** clamp(N(mu, sigma)) into [0, 1] — the §20/§21 sampling rule. */
export function normal01(rng: Random, mu: number, sigma: number): number {
  return clamp01(normal(rng, mu, sigma));
}

export function pick<T>(rng: Random, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() from empty list');
  const item = items[Math.floor(rng.next() * items.length)];
  return item as T;
}

export function shuffle<T>(rng: Random, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Samples a key from non-negative weights. Throws if all weights are zero. */
export function weightedPick<K extends string>(rng: Random, weights: Readonly<Record<K, number>>): K {
  const entries = Object.entries(weights) as [K, number][];
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, w);
  if (total <= 0) throw new Error('weightedPick() with no positive weight');
  let r = rng.next() * total;
  for (const [k, w] of entries) {
    r -= Math.max(0, w);
    if (r < 0) return k;
  }
  const last = entries[entries.length - 1];
  if (!last) throw new Error('weightedPick() with no entries');
  return last[0];
}

export function jitter(rng: Random, minMs: number, maxMs: number): number {
  return Math.round(uniform(rng, minMs, maxMs));
}

export function randomId(rng: Random = defaultRandom, length = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng.next() * alphabet.length)];
  return out;
}
