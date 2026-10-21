// Persona: superset of Project Sid's config (§7) plus §16.3 caution, §17.1 temperament, §18.1 big5/mind,
// §19 sex/orientation/family and §21 abilities. Numeric traits are 0..1 and read by code, not only prompts.

import { z } from 'zod';
import { ItemStackSchema, OrientationSchema, SexSchema, Unit, Vec3Schema } from './common';

/** Tiny condition grammar for quirks, e.g. "lightLevel<7", "health<=6", "timeOfDay>=13000". */
export const QUIRK_CONDITION = /^(lightLevel|timeOfDay|health|food|y)\s*(<=|>=|==|<|>)\s*(-?\d+(?:\.\d+)?)$/;

export const QuirkSchema = z.discriminatedUnion('hook', [
  z.object({
    hook: z.literal('pathCost'),
    when: z.string().regex(QUIRK_CONDITION, 'expected e.g. "lightLevel<7"'),
    multiplier: z.number().positive().max(100),
  }),
  z.object({ hook: z.literal('autoCollect'), items: z.array(z.string().min(1)).min(1) }),
  z.object({
    hook: z.literal('idleEmote'),
    everySec: z.number().min(10),
    say: z.array(z.string().min(1).max(100)).min(1),
  }),
  z.object({
    hook: z.literal('distraction'),
    chance: Unit,
    onSee: z.array(z.string().min(1)).min(1),
    action: z.enum(['approach', 'look', 'follow']).default('approach'),
  }),
  z.object({
    hook: z.literal('reflexBias'),
    reflex: z.enum(['flee', 'fight', 'eat']),
    /** Added to the reflex threshold (health points for flee/fight, food points for eat). */
    delta: z.number().min(-10).max(10),
  }),
  z.object({
    hook: z.literal('tradeBias'),
    item: z.string().min(1),
    /** >1: values the item more when trading it away. */
    multiplier: z.number().positive().max(10),
  }),
]);
export type Quirk = z.infer<typeof QuirkSchema>;
export type QuirkHook = Quirk['hook'];

export const BIAS_NAMES = [
  'halo',
  'confirmation',
  'negativity',
  'ingroup',
  'attribution',
  'availability',
  'authority',
  'envy',
  'sunkCost',
  'selfServing',
  'scapegoat',
] as const;
export type BiasName = (typeof BIAS_NAMES)[number];

export const BiasProfileSchema = z.object({
  halo: Unit.default(0.5),
  confirmation: Unit.default(0.5),
  negativity: Unit.default(0.5),
  ingroup: Unit.default(0.5),
  attribution: Unit.default(0.5),
  availability: Unit.default(0.5),
  authority: Unit.default(0.5),
  envy: Unit.default(0.3),
  sunkCost: Unit.default(0.4),
  selfServing: Unit.default(0.5),
  scapegoat: Unit.default(0.3),
});
export type BiasProfile = z.infer<typeof BiasProfileSchema>;

export const Big5Schema = z.object({
  openness: Unit.default(0.5),
  conscientiousness: Unit.default(0.5),
  extraversion: Unit.default(0.5),
  agreeableness: Unit.default(0.5),
  neuroticism: Unit.default(0.5),
});
export type Big5 = z.infer<typeof Big5Schema>;

export const MindSchema = z.object({
  rationality: Unit.default(0.5),
  impulsivity: Unit.default(0.5),
  conformity: Unit.default(0.5),
  vanity: Unit.default(0.4),
  biasProfile: BiasProfileSchema.prefault({}),
});
export type Mind = z.infer<typeof MindSchema>;

export const TemperamentSchema = z.object({
  aggression: Unit.default(0.3),
  dominance: Unit.default(0.2),
  vengefulness: Unit.default(0.5),
  mercy: Unit.default(0.6),
  loyalty: Unit.default(0.5),
  ambition: Unit.default(0.4),
});
export type Temperament = z.infer<typeof TemperamentSchema>;

export const SocialSettingsSchema = z.object({
  /** Conversation turn cap; derived from extraversion when omitted (introvert 4 … extrovert 10). */
  maxTurns: z.number().int().min(2).max(20).optional(),
  initiateChance: Unit.default(0.3),
  baselineSentiment: z.number().min(0).max(10).default(5),
  grudge: Unit.default(0.5),
});
export type SocialSettings = z.infer<typeof SocialSettingsSchema>;

export const SpeechSchema = z.object({
  style: z.string().min(1).default('plain and friendly'),
  maxWords: z.number().int().min(5).max(60).default(25),
  catchphrases: z.array(z.string().min(1).max(80)).default([]),
});

export const AbilitiesSchema = z.object({
  intelligence: Unit.default(0.5),
  combat: Unit.default(0.4),
});
export type Abilities = z.infer<typeof AbilitiesSchema>;

export const DrivesSchema = z.object({
  /** Risk aversion baseline (§16.3). */
  caution: Unit.default(0.5),
});

export const PersonaSchema = z.object({
  /** Stable id (pool file stem, or generated). */
  id: z.string().min(1).max(40).optional(),
  name: z.string().min(1).max(32),
  sex: SexSchema,
  orientation: OrientationSchema.default('hetero'),
  familyName: z.string().min(1).max(20).optional(),
  traits: z.array(z.string().min(1).max(40)).min(1).max(8),
  /** Prose written from the numbers (never from the sex label, §20). */
  description: z.string().max(600).optional(),
  speech: SpeechSchema.prefault({}),
  values: z.array(z.string().min(1).max(40)).default([]),
  lifeGoals: z.array(z.string().min(1).max(120)).default([]),
  spawn: Vec3Schema.optional(),
  inventory: z.array(ItemStackSchema).default([]),
  location_memories: z.array(z.object({ name: z.string().min(1), pos: Vec3Schema })).default([]),
  social: SocialSettingsSchema.prefault({}),
  quirks: z.array(QuirkSchema).default([]),
  temperament: TemperamentSchema.prefault({}),
  big5: Big5Schema.prefault({}),
  mind: MindSchema.prefault({}),
  drives: DrivesSchema.prefault({}),
  abilities: AbilitiesSchema.prefault({}),
  /** Known insecurities an insult can hit (§18.2); L2 may add more during life. */
  insecurities: z.array(z.string().min(1).max(60)).default([]),
  source: z.enum(['pool', 'generated', 'born']).default('pool'),
  generation: z.number().int().min(0).default(0),
});
export type Persona = z.infer<typeof PersonaSchema>;
export type PersonaInput = z.input<typeof PersonaSchema>;

/** Every 0..1 numeric trait that sampling, inheritance and sex-difference shifts operate on. */
export const NUMERIC_TRAIT_KEYS = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
  'rationality',
  'impulsivity',
  'conformity',
  'vanity',
  'aggression',
  'dominance',
  'vengefulness',
  'mercy',
  'loyalty',
  'ambition',
  'caution',
  'grudge',
  ...BIAS_NAMES.map((b) => `bias.${b}` as const),
] as const;
export type NumericTraitKey = (typeof NUMERIC_TRAIT_KEYS)[number];
export type BiasTraitKey = `bias.${BiasName}`;
export type CoreTraitKey = Exclude<NumericTraitKey, BiasTraitKey>;

export function isBiasTraitKey(key: NumericTraitKey): key is BiasTraitKey {
  return key.startsWith('bias.');
}

function biasOf(key: BiasTraitKey): BiasName {
  return key.slice(5) as BiasName;
}

export function getTrait(p: Persona, key: NumericTraitKey): number {
  if (isBiasTraitKey(key)) return p.mind.biasProfile[biasOf(key)];
  return getCoreTrait(p, key);
}

function getCoreTrait(p: Persona, key: CoreTraitKey): number {
  switch (key) {
    case 'openness':
    case 'conscientiousness':
    case 'extraversion':
    case 'agreeableness':
    case 'neuroticism':
      return p.big5[key];
    case 'rationality':
    case 'impulsivity':
    case 'conformity':
    case 'vanity':
      return p.mind[key];
    case 'aggression':
    case 'dominance':
    case 'vengefulness':
    case 'mercy':
    case 'loyalty':
    case 'ambition':
      return p.temperament[key];
    case 'caution':
      return p.drives.caution;
    case 'grudge':
      return p.social.grudge;
  }
}

export function setTrait(p: Persona, key: NumericTraitKey, value: number): void {
  if (isBiasTraitKey(key)) {
    p.mind.biasProfile[biasOf(key)] = value;
    return;
  }
  setCoreTrait(p, key, value);
}

function setCoreTrait(p: Persona, key: CoreTraitKey, value: number): void {
  switch (key) {
    case 'openness':
    case 'conscientiousness':
    case 'extraversion':
    case 'agreeableness':
    case 'neuroticism':
      p.big5[key] = value;
      return;
    case 'rationality':
    case 'impulsivity':
    case 'conformity':
    case 'vanity':
      p.mind[key] = value;
      return;
    case 'aggression':
    case 'dominance':
    case 'vengefulness':
    case 'mercy':
    case 'loyalty':
    case 'ambition':
      p.temperament[key] = value;
      return;
    case 'caution':
      p.drives.caution = value;
      return;
    case 'grudge':
      p.social.grudge = value;
      return;
  }
}

/** introvert 4 … extrovert 10 (§6.2). */
export function maxTurnsFor(p: Persona): number {
  return p.social.maxTurns ?? Math.round(4 + 6 * p.big5.extraversion);
}

/** Facts a born agent starts with (§19.4) — the same a human child would have. */
export const BirthFactsSchema = z.object({
  parents: z.array(z.object({ username: z.string(), name: z.string() })).length(2),
  siblings: z.array(z.string()).default([]),
  home: Vec3Schema.optional(),
  familyName: z.string().optional(),
});
export type BirthFacts = z.infer<typeof BirthFactsSchema>;
