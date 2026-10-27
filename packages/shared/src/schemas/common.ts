import { z } from 'zod';

/** A trait or probability in [0, 1]. */
export const Unit = z.number().min(0).max(1);

export const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const ItemStackSchema = z.object({
  item: z.string().min(1),
  qty: z.number().int().positive(),
  /** A tool's wear left, as its durability bar shows it (0..1; the most worn of the kind). */
  left: z.number().min(0).max(1).optional(),
});
export type ItemStack = z.infer<typeof ItemStackSchema>;

export const SexSchema = z.enum(['male', 'female']);
export type Sex = z.infer<typeof SexSchema>;

export const OrientationSchema = z.enum(['hetero', 'homo', 'bi']);
export type Orientation = z.infer<typeof OrientationSchema>;

export const TierNameSchema = z.enum(['L1', 'L2', 'L3']);
export type TierName = z.infer<typeof TierNameSchema>;

export const VolumeSchema = z.enum(['whisper', 'normal', 'shout']);
export type Volume = z.infer<typeof VolumeSchema>;

/** LLM-calling modules, in rate-limit priority order (highest first, §5). */
export const LLM_MODULES = [
  'talking',
  'cc',
  'impulse',
  'social',
  'selfMonitor',
  'socialGoal',
  'goal',
  'memory',
  'reflection',
  'learning',
  'skillWriter',
  'architect',
  'controller',
  'bench',
  'persona',
] as const;
export const LlmModuleSchema = z.enum(LLM_MODULES);
export type LlmModule = z.infer<typeof LlmModuleSchema>;

/**
 * The kinds of thought, each on one model of its own (owner request, 2026-10-25: "I don't think models should vary").
 * Fast thought (the mind, under fire, speech, reading others, quick checks) has no hidden thinking and a short reply;
 * slow thought (plans, reflection, buildings, code, the overseer, new people) has time to think.
 */
export const THOUGHT_KINDS = ['mind', 'underFire', 'speech', 'social', 'check', 'summary', 'plan', 'reflect', 'build', 'code', 'oversee', 'persona'] as const;
export const ThoughtKindSchema = z.enum(THOUGHT_KINDS);
export type ThoughtKind = z.infer<typeof ThoughtKindSchema>;

/** A call's kind of thought when it names none, by its module (a quick check names itself). */
export const MODULE_THOUGHT: Readonly<Record<LlmModule, ThoughtKind>> = {
  talking: 'speech',
  cc: 'mind',
  impulse: 'speech',
  social: 'social',
  // What nothing waits on (the self-summary, a merged memory): the quick checks' model with time to finish.
  selfMonitor: 'summary',
  socialGoal: 'social',
  goal: 'plan',
  memory: 'summary',
  reflection: 'reflect',
  learning: 'reflect',
  skillWriter: 'code',
  architect: 'build',
  controller: 'oversee',
  bench: 'check',
  persona: 'persona',
};

/** NanoGPT's reasoning_effort levels; `none` turns hidden thinking off on the models that allow it. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/** Rate-limit priority (higher = served first). Talking > CC > Social > Self-Monitor > Goal > Reflection. */
export const MODULE_PRIORITY: Readonly<Record<LlmModule, number>> = {
  talking: 100,
  cc: 90,
  impulse: 85,
  social: 70,
  selfMonitor: 60,
  socialGoal: 55,
  goal: 50,
  memory: 45,
  reflection: 40,
  // Thinking back over what happened (owner request, 2026-10-24): slow, and never in a hurry.
  learning: 38,
  skillWriter: 30,
  // A building's design waits its turn; the controller steps in when something has gone wrong.
  architect: 35,
  controller: 65,
  bench: 20,
  persona: 10,
};
