import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_CHARS,
  SeededRandom,
  capWords,
  clamp01,
  cohensD,
  cosineSimilarity,
  decayToward,
  distance,
  formatVec,
  gaussian,
  generateChildUsername,
  generateUsername,
  halfLifeFactor,
  isGiveawayName,
  isNightTick,
  isValidUsername,
  mean,
  mentionsName,
  overlapCoefficient,
  parseVec,
  redactSecrets,
  splitForChat,
  stddev,
  stripColorCodes,
  weightedPick,
  yawTowards,
} from '@agora/shared';

describe('geometry', () => {
  it('computes distances and parses vectors', () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(parseVec('120, 12, -40')).toEqual({ x: 120, y: 12, z: -40 });
    expect(parseVec('nope')).toBeNull();
    expect(formatVec({ x: 1.4, y: 63.6, z: -2.5 })).toBe('1,64,-2');
  });

  it('matches mineflayer lookAt yaw convention', () => {
    // Facing -Z (north) is yaw 0 in mineflayer.
    expect(yawTowards({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 })).toBeCloseTo(0);
    expect(Math.abs(yawTowards({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }))).toBeCloseTo(Math.PI);
  });
});

describe('math', () => {
  it('clamps, decays and measures similarity', () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(halfLifeFactor(1000, 1000)).toBeCloseTo(0.5);
    expect(decayToward(1, 0, 2000, 1000)).toBeCloseTo(0.25);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("computes Cohen's d and the overlap coefficient", () => {
    expect(cohensD([1, 2, 3], [1, 2, 3])).toBe(0);
    // OVL for d = 0.4 is about 0.84 (§20 calibration check expects 0.8–0.85).
    expect(overlapCoefficient(0.4)).toBeGreaterThan(0.8);
    expect(overlapCoefficient(0.4)).toBeLessThan(0.85);
  });
});

describe('random', () => {
  it('is reproducible from a seed', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    for (let i = 0; i < 10; i++) expect(a.next()).toBe(b.next());
  });

  it('samples a standard normal', () => {
    const rng = new SeededRandom(7);
    const xs = Array.from({ length: 20000 }, () => gaussian(rng));
    expect(Math.abs(mean(xs))).toBeLessThan(0.03);
    expect(Math.abs(stddev(xs) - 1)).toBeLessThan(0.03);
  });

  it('weightedPick follows weights and rejects all-zero weights', () => {
    const rng = new SeededRandom(1);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 10000; i++) counts[weightedPick(rng, { a: 3, b: 1 })]++;
    expect(counts.a / 10000).toBeGreaterThan(0.72);
    expect(counts.a / 10000).toBeLessThan(0.78);
    expect(() => weightedPick(rng, { a: 0 })).toThrow();
  });
});

describe('text', () => {
  it('strips color codes and splits long chat at sentence boundaries', () => {
    expect(stripColorCodes('§aHello §lworld')).toBe('Hello world');
    const long = `${'This is a sentence. '.repeat(20)}End`;
    const parts = splitForChat(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.trim().replace(/\s+/g, ' '));
    expect(splitForChat('   ')).toEqual([]);
  });

  it('splits a single huge word', () => {
    const parts = splitForChat('x'.repeat(600));
    expect(parts.map((p) => p.length)).toEqual([256, 256, 88]);
  });

  it('caps words and detects mentions', () => {
    expect(capWords('one two three four', 2)).toBe('one two…');
    expect(mentionsName('hey @Pip come here', 'Pip')).toBe(true);
    expect(mentionsName('pip, look', 'Pip')).toBe(true);
    expect(mentionsName('Pippin is here', 'Pip')).toBe(false);
  });

  it('redacts secrets', () => {
    const env = { NANOGPT_API_KEY: 'sk-secret-1234' } as NodeJS.ProcessEnv;
    expect(redactSecrets('key=sk-secret-1234 and Bearer abc.def', env)).toBe(
      'key=[NANOGPT_API_KEY] and Bearer [redacted]',
    );
  });
});

describe('names (§16.1)', () => {
  it('rejects giveaway names but allows normal ones like Kai', () => {
    expect(isGiveawayName('PipAI')).toBe(true);
    expect(isGiveawayName('AI_Pip')).toBe(true);
    expect(isGiveawayName('pip_ai')).toBe(true);
    expect(isGiveawayName('Robot5')).toBe(true);
    expect(isGiveawayName('Kai')).toBe(false);
    expect(isGiveawayName('Kaia')).toBe(false);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a'.repeat(17))).toBe(false);
    expect(isValidUsername('Pip')).toBe(true);
    expect(isValidUsername('Pip-1')).toBe(false);
  });

  it('generates unique player-like usernames and never reuses taken ones', () => {
    const rng = new SeededRandom(3);
    const taken = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const name = generateUsername('Pip', taken, rng);
      expect(isValidUsername(name)).toBe(true);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  it('builds child usernames as Given_Initial', () => {
    const rng = new SeededRandom(5);
    expect(generateChildUsername('Mira', 'Brightwater', new Set(), rng)).toBe('Mira_B');
    const second = generateChildUsername('Mira', 'Brightwater', new Set(['Mira_B']), rng);
    expect(second).not.toBe('Mira_B');
    expect(isValidUsername(second)).toBe(true);
  });
});

describe('time', () => {
  it('detects night ticks', () => {
    expect(isNightTick(6000)).toBe(false);
    expect(isNightTick(18000)).toBe(true);
    expect(isNightTick(24000 + 18000)).toBe(true);
  });
});
