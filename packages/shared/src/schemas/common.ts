import { z } from 'zod';

/** A trait or probability in [0, 1]. */
export const Unit = z.number().min(0).max(1);

export const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const ItemStackSchema = z.object({
  item: z.string().min(1),
  qty: z.number().int().positive(),
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
