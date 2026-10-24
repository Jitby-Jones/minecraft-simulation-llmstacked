// Hub protocol (§8). v0.2: infrastructure only — the Hub never sends a bot anything about the world or other
// players. v0.6: budgets are subscription token quota, not USD. §23.5: embeddings are a shared Hub service.

import { z } from 'zod';
import { ItemStackSchema, LlmModuleSchema, TierNameSchema, Vec3Schema } from './common';
import { BirthFactsSchema, PersonaSchema } from './persona';

export const DegradeLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type DegradeLevel = z.infer<typeof DegradeLevelSchema>;

/** Traits a parent believes its partner has (§19.3: the bot's perceived model, never ground truth). */
export const PerceivedTraitsSchema = z.record(z.string(), z.number().min(0).max(1));
export type PerceivedTraits = z.infer<typeof PerceivedTraitsSchema>;

/** Modules the operator can switch off for an agent (debug controls). */
export const TUNABLE_MODULES = [
  'llm',
  'cc.llm',
  'talking.llm',
  'goalGen',
  'socialGoals',
  'reflection',
  'selfMonitor',
  'impulses',
  'conflict',
  'romance',
  'family',
  'skillWriter',
  'architect',
  'controller',
] as const;
export const TunableModuleSchema = z.enum(TUNABLE_MODULES);
export type TunableModule = z.infer<typeof TunableModuleSchema>;

/**
 * The operator's debug settings for an agent (or for all of them): modules switched off, the model a tier tries
 * first and the tier a module uses (subscription models only, §22.3), and whether the agent is paused (no decisions;
 * the reflexes still keep it alive). Kept by the Hub across restarts; never anything about the world.
 */
export const TuningSchema = z.object({
  off: z.array(TunableModuleSchema).default([]),
  models: z.partialRecord(TierNameSchema, z.string().min(1)).default({}),
  tiers: z.partialRecord(LlmModuleSchema, TierNameSchema).default({}),
  paused: z.boolean().default(false),
});
export type Tuning = z.infer<typeof TuningSchema>;

export const URGE_ACTS = ['move_on', 'wander', 'drop_task', 'rethink'] as const;
export const UrgeActSchema = z.enum(URGE_ACTS);
export type UrgeAct = z.infer<typeof UrgeActSchema>;

export const UrgeSchema = z.object({
  /** move_on: end the talk and walk off; wander: walk a little way; drop_task: give up what keeps failing; rethink: think again. */
  act: UrgeActSchema,
  /** First person, as the agent's own thought. */
  thought: z.string().min(3).max(200),
  /** A short goodbye to whoever it was talking with (move_on). */
  say: z.string().min(1).max(100).optional(),
  /** Whom to leave be for a while: the people the talk went round in circles with. */
  avoid: z.array(z.string().min(1)).max(8).default([]),
  /** What keeps failing (drop_task): the skill and the thing it was for. */
  task: z.object({ skill: z.string().min(1), item: z.string().min(1).optional() }).optional(),
});
export type Urge = z.infer<typeof UrgeSchema>;

export const HubToBotSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('assign'),
    persona: PersonaSchema,
    username: z.string(),
    /** true when reconnecting a living agent after a restart (§23.4). */
    resume: z.boolean(),
    birthFacts: BirthFactsSchema.optional(),
    /** Where to appear, if the supervisor chose a spot (births at the parents' beds). */
    spawnAt: Vec3Schema.optional(),
    giveStarterKit: z.boolean(),
  }),
  z.object({ t: z.literal('llmGrant'), reqId: z.string() }),
  z.object({ t: z.literal('llmDeny'), reqId: z.string(), reason: z.string() }),
  z.object({
    t: z.literal('budget'),
    remainingTokensThisHour: z.number(),
    degrade: DegradeLevelSchema,
    codeOnly: z.boolean(),
    resetAt: z.number().nullable(),
    reason: z.string(),
  }),
  z.object({ t: z.literal('speechGrant'), reqId: z.string(), ok: z.boolean() }),
  z.object({ t: z.literal('fightGrant'), reqId: z.string(), ok: z.boolean() }),
  z.object({ t: z.literal('embedResult'), reqId: z.string(), vectors: z.array(z.array(z.number())).nullable() }),
  /** Extinction brake (§17.10): changes the agent's own caution baseline only, never what it perceives. */
  z.object({ t: z.literal('cautionShift'), shift: z.number().min(0).max(1), untilTs: z.number() }),
  z.object({ t: z.literal('snapshot'), reqId: z.string() }),
  z.object({ t: z.literal('retire'), reason: z.string() }),
  z.object({ t: z.literal('shutdown'), reason: z.string() }),
  /** The operator's debug settings for this agent (sent on start and on every change). */
  z.object({ t: z.literal('tuning'), tuning: TuningSchema }),
  /** An operator's debug request (inspect, memory, goal, plan, decide, …); answered with debugResult. */
  z.object({ t: z.literal('debug'), reqId: z.string(), op: z.string().min(1).max(40), args: z.record(z.string(), z.unknown()).default({}) }),
  /**
   * The controller (owner request, 2026-10-24): something gone wrong (a talk going round in circles, standing stuck,
   * the same failure over and over) ended by an urge the agent takes as its own. Like cautionShift it changes the
   * agent's own inclination, never what it perceives: the thought is in its own words about what it did itself, and
   * `avoid` names only the people it was just talking with.
   */
  z.object({ t: z.literal('urge'), urge: UrgeSchema }),
]);
export type HubToBot = z.infer<typeof HubToBotSchema>;

export const TelemetryKindSchema = z.enum([
  'decision',
  'option',
  'utterance',
  'conversation',
  'social',
  'emotion',
  'commitment',
  'fight',
  'impulse',
  'override',
  'goal',
  'role',
  'memory',
  'state',
  'modelSwap',
  'guard',
  'romance',
  'knowledge',
  'skill',
]);
export type TelemetryKind = z.infer<typeof TelemetryKindSchema>;

export const BotToHubSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), pid: z.number().int(), slot: z.string() }),
  z.object({ t: z.literal('ready'), username: z.string() }),
  z.object({
    t: z.literal('llmToken'),
    reqId: z.string(),
    priority: z.number(),
    module: LlmModuleSchema,
    estTokens: z.number().int().min(0),
  }),
  z.object({
    t: z.literal('cost'),
    module: LlmModuleSchema,
    tier: TierNameSchema,
    model: z.string(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    ms: z.number().min(0),
    ok: z.boolean(),
  }),
  z.object({ t: z.literal('speechToken'), reqId: z.string() }),
  /** §17.10: may this bot start a fight now (world-wide cap)? Released with fightEnd. */
  z.object({ t: z.literal('fightStart'), reqId: z.string() }),
  z.object({ t: z.literal('fightEnd') }),
  z.object({ t: z.literal('embed'), reqId: z.string(), texts: z.array(z.string()).max(64) }),
  z.object({
    t: z.literal('died'),
    username: z.string(),
    cause: z.string(),
    pos: Vec3Schema.nullable(),
    aliveSec: z.number().min(0),
    inventory: z.array(ItemStackSchema),
  }),
  z.object({
    t: z.literal('conception'),
    username: z.string(),
    partner: z.string(),
    partnerModel: PerceivedTraitsSchema,
    /** How the reporter sees its partner (for a parent the system knows nothing about). */
    partnerSex: z.enum(['male', 'female', 'unknown']).default('unknown'),
    bedPos: Vec3Schema,
    ts: z.number(),
  }),
  z.object({ t: z.literal('snapshotDone'), reqId: z.string(), ok: z.boolean() }),
  z.object({
    t: z.literal('log'),
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
    module: z.string(),
    msg: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  /** Dashboard only; never fanned out to other bots. */
  z.object({
    t: z.literal('telemetry'),
    kind: TelemetryKindSchema,
    ts: z.number(),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({ t: z.literal('bye'), username: z.string(), reason: z.string() }),
  z.object({ t: z.literal('debugResult'), reqId: z.string(), ok: z.boolean(), message: z.string(), data: z.unknown().optional() }),
]);
export type BotToHub = z.infer<typeof BotToHubSchema>;

export function parseHubToBot(raw: string): HubToBot | null {
  try {
    const r = HubToBotSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseBotToHub(raw: string): BotToHub | null {
  try {
    const r = BotToHubSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
