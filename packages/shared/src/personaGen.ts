// Persona generation (§16.2 `personas: auto`, §19.7, §20, §21.5): when the pool runs out, new people are drawn from
// the population's distributions. Numbers first: every 0..1 trait is clamp(N(0.5 ± d·σ/2, σ)) with the sex shift
// from config/sex-differences.yaml × world.sexDifferences.scale (§20); intelligence and combat come from
// world.abilities and are never shifted by sex (§21). The words (traits, description, speech style, values, life
// goals) are derived from the numbers, never from the sex label. The Hub may have L3 rewrite the prose later.

import type { Orientation, Sex } from './schemas/common';
import type { SexDifferences, WorldConfig } from './schemas/config';
import { type Persona, PersonaSchema, type Quirk } from './schemas/persona';
import { generateUsername, givenNamePool } from './names';
import { type Random, chance, normal01, pick, shuffle } from './random';

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
