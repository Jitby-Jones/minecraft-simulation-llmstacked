// Persona generation (§16.2 `personas: auto`, §19.7, §20, §21.5): when the pool runs out, new people are drawn from
// the population's distributions. Numbers first: every 0..1 trait is clamp(N(0.5 ± d·σ/2, σ)) with the sex shift
// from config/sex-differences.yaml × world.sexDifferences.scale (§20); intelligence and combat come from
// world.abilities and are never shifted by sex (§21). The words (traits, description, speech style, values, life
// goals) are derived from the numbers, never from the sex label. The Hub may have L3 rewrite the prose later.

import type { Orientation, Sex } from './schemas/common';
import type { SexDifferences, WorldConfig } from './schemas/config';
import { NUMERIC_TRAIT_KEYS, type Persona, PersonaSchema, type Quirk, getTrait, setTrait } from './schemas/persona';
import { generateChildUsername, generateUsername, givenNamePool } from './names';
import { type Random, chance, normal, normal01, pick, shuffle } from './random';

export interface GeneratePersonaOptions {
  rng: Random;
  world: WorldConfig;
  sexDiffs: SexDifferences;
  /** Every username ever used, alive or dead (never reused, §16.3). */
  takenNames: ReadonlySet<string>;
  sex?: Sex;
}

type Shifted = 'neuroticism' | 'agreeableness' | 'extraversion' | 'openness' | 'conscientiousness' | 'aggression' | 'dominance' | 'caution' | 'mercy' | 'impulsivity' | 'vanity';

/** One 0..1 trait with the §20 mean shift for `sex`. */
export function sampleTrait(rng: Random, sex: Sex, trait: string, diffs: SexDifferences, scale: number): number {
  const sigma = diffs.sigma;
  const d = (diffs.d[trait as Shifted] ?? 0) * scale;
  const mu = 0.5 + (sex === 'female' ? 1 : -1) * ((d * sigma) / 2);
  return Math.round(normal01(rng, mu, sigma) * 100) / 100;
}

function orientationFor(rng: Random, dist: { hetero: number; homo: number; bi: number }): Orientation {
  const total = dist.hetero + dist.homo + dist.bi;
  const r = rng.next() * total;
  if (r < dist.hetero) return 'hetero';
  return r < dist.hetero + dist.homo ? 'homo' : 'bi';
}

/** Trait words from the numbers: the strongest leanings first. */
function traitWords(n: Record<string, number>): string[] {
  const words: [number, string][] = [];
  const lean = (v: number, hi: string, lo: string) => {
    if (v >= 0.62) words.push([v - 0.5, hi]);
    else if (v <= 0.38) words.push([0.5 - v, lo]);
  };
  lean(n.openness ?? 0.5, 'curious', 'down-to-earth');
  lean(n.conscientiousness ?? 0.5, 'hard-working', 'easygoing');
  lean(n.extraversion ?? 0.5, 'outgoing', 'quiet');
  lean(n.agreeableness ?? 0.5, 'kind', 'blunt');
  lean(n.neuroticism ?? 0.5, 'anxious', 'calm');
  lean(n.aggression ?? 0.5, 'hot-headed', 'gentle');
  lean(n.ambition ?? 0.5, 'ambitious', 'unhurried');
  lean(n.loyalty ?? 0.5, 'loyal', 'independent');
  lean(n.caution ?? 0.5, 'careful', 'daring');
  lean(n.impulsivity ?? 0.5, 'impulsive', 'patient');
  const out = words.sort((a, b) => b[0] - a[0]).map(([, w]) => w);
  return out.length > 0 ? out.slice(0, 4) : ['steady'];
}

const VALUE_RULES: readonly [string, (n: Record<string, number>) => number][] = [
  ['exploration', (n) => n.openness ?? 0],
  ['friendship', (n) => ((n.agreeableness ?? 0) + (n.extraversion ?? 0)) / 2],
  ['hard work', (n) => n.conscientiousness ?? 0],
  ['success', (n) => n.ambition ?? 0],
  ['safety', (n) => n.caution ?? 0],
  ['loyalty', (n) => n.loyalty ?? 0],
  ['independence', (n) => 1 - (n.loyalty ?? 0.5)],
  ['fun', (n) => ((n.impulsivity ?? 0) + (n.extraversion ?? 0)) / 2],
];

const LIFE_GOALS: Readonly<Record<string, readonly string[]>> = {
  exploration: ['see what lies beyond the hills', 'map the land around home', 'find a cave full of ore'],
  friendship: ['make good friends', 'get to know everyone nearby', 'help a neighbor build a home'],
  'hard work': ['build a sturdy house', 'keep a well-stocked storehouse', 'run a tidy farm'],
  success: ['own the best tools around', 'become someone people look up to', 'gather a big pile of iron'],
  safety: ['build a safe home with walls', 'always have food put aside', 'light up the paths at night'],
  loyalty: ['look after the people close to me', 'stand by my friends'],
  independence: ['live on my own terms', 'build a home of my own away from the crowd'],
  fun: ['have a good time with others', 'build something silly and big'],
};

const QUIRK_IDEAS: readonly ((rng: Random) => Quirk)[] = [
  () => ({ hook: 'idleEmote', everySec: 120, say: ['*hums*'] }),
  () => ({ hook: 'idleEmote', everySec: 150, say: ['*whistles*'] }),
  () => ({ hook: 'autoCollect', items: ['poppy', 'dandelion'] }),
  () => ({ hook: 'autoCollect', items: ['apple'] }),
  (rng) => ({ hook: 'distraction', chance: 0.05, onSee: [pick(rng, ['sheep', 'cow', 'chicken', 'pig'])], action: 'approach' }),
  () => ({ hook: 'pathCost', when: 'lightLevel<7', multiplier: 3 }),
  () => ({ hook: 'reflexBias', reflex: 'flee', delta: 2 }),
];

/** A complete persona sampled from the population distributions. */
export function generatePersona(o: GeneratePersonaOptions): Persona {
  const { rng, world, sexDiffs } = o;
  const sex: Sex = o.sex ?? (chance(rng, 0.5) ? 'female' : 'male');
  const scale = world.sexDifferences.scale;
  const t = (name: string) => sampleTrait(rng, sex, name, sexDiffs, scale);
  const n: Record<string, number> = {};
  for (const k of ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism']) n[k] = t(k);
  for (const k of ['rationality', 'impulsivity', 'conformity', 'vanity']) n[k] = t(k);
  for (const k of ['aggression', 'dominance', 'vengefulness', 'mercy', 'loyalty', 'ambition', 'caution', 'grudge']) n[k] = t(k);
  const ab = world.abilities;
  const intelligence = Math.round(normal01(rng, ab.intelligence.mean, ab.intelligence.sd) * 100) / 100;
  const combat = Math.round(normal01(rng, ab.combat.mean, ab.combat.sd) * 100) / 100;
  const v = (k: string) => n[k] ?? 0.5;
  const traits = traitWords(n);
  const values = VALUE_RULES.map(([name, f]) => [name, f(n)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
  const lifeGoals = values.map((val) => pick(rng, LIFE_GOALS[val] ?? ['make a good life here']));
  const given = shuffle(rng, givenNamePool()).find((g) => ![...o.takenNames].some((x) => x.toLowerCase() === g.toLowerCase())) ?? pick(rng, givenNamePool());
  const name = generateUsername(given, o.takenNames, rng);
  const talkative = v('extraversion');
  const style = `${talkative >= 0.6 ? 'chatty' : talkative <= 0.4 ? 'brief' : 'easy'} and ${v('agreeableness') >= 0.55 ? 'warm' : v('agreeableness') <= 0.4 ? 'blunt' : 'plain'}`;
  const quirks = shuffle(rng, QUIRK_IDEAS)
    .slice(0, chance(rng, 0.5) ? 2 : 1)
    .map((q) => q(rng));
  return PersonaSchema.parse({
    id: `gen-${name.toLowerCase()}`,
    name,
    sex,
    orientation: orientationFor(rng, world.romance.orientationDist),
    traits,
    description: `${name} is ${traits.slice(0, 2).join(' and ')}, and cares most about ${values.join(' and ')}.`,
    speech: { style, maxWords: Math.round(12 + 18 * talkative), catchphrases: [] },
    values,
    lifeGoals,
    inventory: [{ item: 'bread', qty: 2 }],
    social: { initiateChance: Math.round((0.1 + 0.5 * talkative) * 100) / 100, baselineSentiment: Math.round((3 + 4 * v('agreeableness')) * 10) / 10, grudge: v('grudge') },
    quirks,
    temperament: { aggression: v('aggression'), dominance: v('dominance'), vengefulness: v('vengefulness'), mercy: v('mercy'), loyalty: v('loyalty'), ambition: v('ambition') },
    big5: { openness: v('openness'), conscientiousness: v('conscientiousness'), extraversion: talkative, agreeableness: v('agreeableness'), neuroticism: v('neuroticism') },
    mind: { rationality: v('rationality'), impulsivity: v('impulsivity'), conformity: v('conformity'), vanity: v('vanity') },
    drives: { caution: v('caution') },
    abilities: { intelligence, combat },
    insecurities: [],
    source: 'generated',
  });
}

export interface InheritOptions {
  rng: Random;
  world: WorldConfig;
  /** The parent whose family name passes on (or whose name becomes it). */
  a: Persona;
  /** The other parent: their persona, or as `a` sees them (a human's real traits are known to no one). */
  b: Persona;
  /** Every username ever used, alive or dead (never reused, §16.3). */
  takenNames: ReadonlySet<string>;
}

/** Each numeric trait: one parent's, the other's or their mean, plus a little noise, now and then a lot (§19.4). */
function inheritTrait(rng: Random, x: number, y: number): number {
  const base = pick(rng, [x, y, (x + y) / 2]);
  const v = normal(rng, base, chance(rng, 0.1) ? 0.25 : 0.08);
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
}

/**
 * §19.4: a child's persona from its parents'. Numbers are inherited trait by trait; intelligence and combat by
 * world.abilities' heritability (the parents' mean for that share, the population for the rest). Values and quirks:
 * each parent's kept with probability 0.5, plus one new quirk. The words (traits, description, speech style, life
 * goals) come from the child's own numbers, as for anyone. Sex 50/50, orientation from the configured distribution,
 * a new given name with the family's initial ("Lily_N"). No memories: those it learns, as anyone does.
 */
export function inheritPersona(o: InheritOptions): Persona {
  const { rng, world, a, b } = o;
  const sex: Sex = chance(rng, 0.5) ? 'female' : 'male';
  const familyName = a.familyName ?? b.familyName ?? a.name.replace(/_[A-Z]$/, '');
  const child = PersonaSchema.parse({ name: 'child', sex, traits: ['young'] });
  const n: Record<string, number> = {};
  for (const k of NUMERIC_TRAIT_KEYS) {
    const v = inheritTrait(rng, getTrait(a, k), getTrait(b, k));
    setTrait(child, k, v);
    n[k] = v;
  }
  const ab = world.abilities;
  // h of it from the parents' mean, the rest a fresh draw from the population.
  const heritable = (h: number, x: number, y: number, mean: number, sd: number) => Math.round(normal01(rng, h * ((x + y) / 2) + (1 - h) * mean, (1 - h) * sd) * 100) / 100;
  const intelligence = heritable(ab.intelligence.heritability, a.abilities.intelligence, b.abilities.intelligence, ab.intelligence.mean, ab.intelligence.sd);
  const combat = heritable(ab.combat.heritability, a.abilities.combat, b.abilities.combat, ab.combat.mean, ab.combat.sd);
  const v = (k: string) => n[k] ?? 0.5;
  const kept = <T>(xs: readonly T[], key: (x: T) => string): T[] => {
    const out: T[] = [];
    for (const x of xs) if (chance(rng, 0.5) && !out.some((y) => key(y) === key(x))) out.push(x);
    return out;
  };
  const values = kept([...a.values, ...b.values], (x) => x);
  if (values.length === 0) values.push(...VALUE_RULES.map(([name, f]) => [name, f(n)] as const).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([name]) => name));
  const quirks = [...kept([...a.quirks, ...b.quirks], (q) => JSON.stringify(q)), pick(rng, QUIRK_IDEAS)(rng)];
  const traits = traitWords(n);
  const given = shuffle(rng, givenNamePool()).find((g) => ![...o.takenNames].some((x) => x.toLowerCase() === g.toLowerCase())) ?? pick(rng, givenNamePool());
  const name = generateChildUsername(given, familyName, o.takenNames, rng);
  const talkative = v('extraversion');
  return PersonaSchema.parse({
    ...child,
    id: `born-${name.toLowerCase()}`,
    name,
    sex,
    orientation: orientationFor(rng, world.romance.orientationDist),
    familyName,
    traits,
    description: `${name} is ${traits.slice(0, 2).join(' and ')}, and cares most about ${values.slice(0, 2).join(' and ')}.`,
    speech: { style: `${talkative >= 0.6 ? 'chatty' : talkative <= 0.4 ? 'brief' : 'easy'} and ${v('agreeableness') >= 0.55 ? 'warm' : v('agreeableness') <= 0.4 ? 'blunt' : 'plain'}`, maxWords: Math.round(12 + 18 * talkative), catchphrases: [] },
    values,
    lifeGoals: values.slice(0, 2).map((val) => pick(rng, LIFE_GOALS[val] ?? ['make a good life here'])),
    inventory: [],
    social: { ...child.social, initiateChance: Math.round((0.1 + 0.5 * talkative) * 100) / 100, baselineSentiment: Math.round((3 + 4 * v('agreeableness')) * 10) / 10 },
    quirks,
    abilities: { intelligence, combat },
    insecurities: [],
    source: 'born',
    generation: Math.max(a.generation, b.generation) + 1,
  });
}

/**
 * §19.3 a parent the system has no persona for (a person playing): what the other parent, one of ours, believes of
 * them stands in for their traits, on that parent's own persona wherever it has no view. Their real traits are never
 * known, and nothing of theirs (values, quirks) is guessed.
 */
export function perceivedPersona(base: Persona, o: { username: string; sex: Sex | 'unknown'; model: Readonly<Record<string, number>> }): Persona {
  const p = structuredClone(base);
  for (const k of NUMERIC_TRAIT_KEYS) {
    const v = o.model[k];
    if (typeof v === 'number' && Number.isFinite(v)) setTrait(p, k, Math.min(1, Math.max(0, v)));
  }
  const ability = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
  return PersonaSchema.parse({
    ...p,
    id: `perceived-${o.username.toLowerCase()}`,
    name: o.username,
    sex: o.sex === 'unknown' ? base.sex : o.sex,
    familyName: undefined,
    values: [],
    quirks: [],
    abilities: { intelligence: ability(o.model.intelligence, base.abilities.intelligence), combat: ability(o.model.combat, base.abilities.combat) },
  });
}
