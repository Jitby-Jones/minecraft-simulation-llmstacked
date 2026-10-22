// Persona generation (§16.2, §20, §21.5): numbers from the population distributions, words from the numbers.

import { describe, expect, it } from 'vitest';
import { SeededRandom, SexDifferencesSchema, WorldConfigSchema, generatePersona, isValidUsername, loadSexDifferences } from '@agora/shared';

const world = WorldConfigSchema.parse({});

function cohensD(f: number[], m: number[]): number {
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const sd = (xs: number[]) => {
    const mu = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1));
  };
  const pooled = Math.sqrt((sd(f) ** 2 + sd(m) ** 2) / 2);
  return (mean(f) - mean(m)) / pooled;
}

describe('persona generation (§20 calibration, §21 abilities)', () => {
  it('reproduces the configured sex differences within ±0.05 and leaves abilities unshifted', () => {
    const diffs = loadSexDifferences();
    const rng = new SeededRandom(20261021);
    const taken = new Set<string>();
    // 8000 per sex: the sampling error of d is about 0.016, well inside the ±0.05 the design asks for.
    const f = Array.from({ length: 8000 }, () => generatePersona({ rng, world, sexDiffs: diffs, takenNames: taken, sex: 'female' }));
    const m = Array.from({ length: 8000 }, () => generatePersona({ rng, world, sexDiffs: diffs, takenNames: taken, sex: 'male' }));
    const checks: [string, (p: (typeof f)[number]) => number, number][] = [
      ['neuroticism', (p) => p.big5.neuroticism, diffs.d.neuroticism ?? 0],
      ['agreeableness', (p) => p.big5.agreeableness, diffs.d.agreeableness ?? 0],
      ['aggression', (p) => p.temperament.aggression, diffs.d.aggression ?? 0],
      ['caution', (p) => p.drives.caution, diffs.d.caution ?? 0],
      ['openness', (p) => p.big5.openness, diffs.d.openness ?? 0],
      ['intelligence', (p) => p.abilities.intelligence, 0],
      ['combat', (p) => p.abilities.combat, 0],
    ];
    for (const [name, get, d] of checks) {
      const measured = cohensD(f.map(get), m.map(get));
      expect(Math.abs(measured - d), `${name}: measured ${measured.toFixed(3)} vs ${d}`).toBeLessThanOrEqual(0.05);
    }
  });

  it('scale 0 disables the shift', () => {
    const diffs = loadSexDifferences();
    const flat = WorldConfigSchema.parse({ sexDifferences: { scale: 0 } });
    const rng = new SeededRandom(7);
    const taken = new Set<string>();
    const f = Array.from({ length: 3000 }, () => generatePersona({ rng, world: flat, sexDiffs: diffs, takenNames: taken, sex: 'female' }));
    const m = Array.from({ length: 3000 }, () => generatePersona({ rng, world: flat, sexDiffs: diffs, takenNames: taken, sex: 'male' }));
    expect(Math.abs(cohensD(f.map((p) => p.big5.neuroticism), m.map((p) => p.big5.neuroticism)))).toBeLessThan(0.08);
  });

  it('gives a valid, unused, player-like name and words that follow the numbers', () => {
    const rng = new SeededRandom(3);
    const taken = new Set(['Pip', 'Bram', 'Mira', 'Tobin']);
    for (let i = 0; i < 50; i++) {
      const p = generatePersona({ rng, world, sexDiffs: SexDifferencesSchema.parse({}), takenNames: taken });
      expect(isValidUsername(p.name)).toBe(true);
      expect(taken.has(p.name)).toBe(false);
      taken.add(p.name);
      expect(p.source).toBe('generated');
      expect(p.traits.length).toBeGreaterThan(0);
      // The four strongest leanings are named; a weaker one can be crowded out.
      if (p.big5.extraversion >= 0.62) expect(p.traits.includes('outgoing') || p.traits.length === 4).toBe(true);
      if (p.big5.extraversion <= 0.38) expect(p.traits.includes('quiet') || p.traits.length === 4).toBe(true);
      expect(p.description).not.toMatch(/\b(man|woman|male|female|he|she)\b/i);
    }
  });
});
