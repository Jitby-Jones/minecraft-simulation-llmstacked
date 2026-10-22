// Cognitive Controller output (§4.3) extended with §17.11 conflict options, §6.6 trade steps and §19 romance.
// The LLM produces DecisionOutput; code stamps id/createdAt/stateVersion/source to make a Decision.

import { z } from 'zod';
import { ItemStackSchema, Vec3Schema, VolumeSchema } from './common';

export const OPTIONS = [
  'work',
  'talk',
  'move',
  'follow',
  'trade',
  'help',
  'explore',
  'rest',
  'flee',
  'fight',
  'demand',
  'yield',
  'recruit',
  'court',
  'apologize',
] as const;
export const OptionSchema = z.enum(OPTIONS);
export type OptionName = z.infer<typeof OptionSchema>;

export const STANCES = [
  'agree',
  'decline',
  'negotiate',
  'inform',
  'ask',
  'chat',
  'none',
  'hostile',
  'threaten',
  'yield',
  'rally',
  'flirt',
  'propose',
  'apologize',
] as const;
export const StanceSchema = z.enum(STANCES);
export type Stance = z.infer<typeof StanceSchema>;

export const COMMITMENT_KINDS = ['give', 'gather', 'meet', 'help', 'build', 'follow', 'fight', 'custom'] as const;
export const CommitmentKindSchema = z.enum(COMMITMENT_KINDS);
export type CommitmentKind = z.infer<typeof CommitmentKindSchema>;

/** Small models often send numbers as strings; coerce the obvious cases. */
const looseInt = z.coerce.number().int().positive();

export const CommitmentWhatSchema = z.object({
  kind: CommitmentKindSchema,
  item: z.string().min(1).optional(),
  qty: looseInt.optional(),
  pos: Vec3Schema.optional(),
  /** For kind 'fight' (uprisings, §17.8) and 'help'/'follow'. */
  target: z.string().optional(),
  text: z.string().min(1).max(200),
});
export type CommitmentWhat = z.infer<typeof CommitmentWhatSchema>;

export const CommitmentDraftSchema = z.object({
  debtor: z.string().min(1),
  creditor: z.string().min(1),
  what: CommitmentWhatSchema,
  dueInSec: z.coerce.number().positive().max(7 * 24 * 3600).optional(),
  coerced: z.boolean().optional(),
});
export type CommitmentDraft = z.infer<typeof CommitmentDraftSchema>;

export const SpeechIntentSchema = z.object({
  stance: StanceSchema,
  /** What we're willing to say / commit to. */
  gist: z.string().max(300),
  /** Talking may promise things only if true (§6.2, rule 3). */
  mayCommit: z.boolean(),
  volume: VolumeSchema.optional(),
});
export type SpeechIntent = z.infer<typeof SpeechIntentSchema>;

export const TradeStepSchema = z.object({
  with: z.string().min(1),
  phase: z.enum(['offer', 'accept', 'counter', 'decline', 'deliver']),
  give: z.array(ItemStackSchema).max(4).default([]),
  want: z.array(ItemStackSchema).max(4).default([]),
});
export type TradeStep = z.infer<typeof TradeStepSchema>;

export const FightProposalSchema = z.object({
  target: z.string().min(1),
  intent: z.enum(['brawl', 'lethal']),
  withAllies: z.array(z.string()).max(6).default([]),
  /** Joining a fight a sworn ally is in with them just now (§17.6 groupAttack); code checks that it is so. */
  joining: z.boolean().optional(),
  reason: z.string().max(200).optional(),
});
export type FightProposal = z.infer<typeof FightProposalSchema>;

export const TerminateSchema = z.object({
  maxSeconds: z.coerce.number().min(5).max(900),
  /** Code-checkable condition key, e.g. "inventoryHas:oak_log>=16", "agentLeftRange:Steve". */
  until: z.string().max(80).optional(),
});

export const DecisionOutputSchema = z.object({
  option: OptionSchema,
  target: z
    .object({
      agent: z.string().min(1).optional(),
      pos: Vec3Schema.optional(),
      item: z.string().min(1).optional(),
    })
    .optional(),
  task: z
    .object({
      skill: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  speechIntent: SpeechIntentSchema.optional(),
  commitmentsToCreate: z.array(CommitmentDraftSchema).max(3).optional(),
  trade: TradeStepSchema.optional(),
  fight: FightProposalSchema.optional(),
  terminate: TerminateSchema,
  /** ≤ 1 sentence, for logs/UI only. */
  rationale: z.string().max(400),
});
export type DecisionOutput = z.infer<typeof DecisionOutputSchema>;

export type DecisionSource = 'llm' | 'default' | 'reflex' | 'impulse' | 'script';

export interface Decision extends DecisionOutput {
  id: string;
  createdAt: number;
  stateVersion: number;
  source: DecisionSource;
}
