// Agent State (blackboard, §4.1) and the runtime records modules exchange through it.
// There is deliberately NO human/AI field anywhere (§16.1).

import type { Vec3 } from './geometry';
import type { ItemStack, Sex, Volume } from './schemas/common';
import type { CommitmentWhat, Decision, OptionName } from './schemas/decision';
import type { DegradeLevel } from './schemas/hub';
import type { BiasName, Persona } from './schemas/persona';

export type AgentName = string;
export type ConvId = string;

export type EntityKind = 'player' | 'hostile' | 'passive' | 'item' | 'other';

export interface SeenEntity {
  id: number;
  kind: EntityKind;
  /** Username for players, mob type otherwise (item entities: the item name). */
  name: string;
  pos: Vec3;
  distance: number;
  /** Line of sight from our eyes (raycast). */
  visible: boolean;
  heldItem: string | null;
  armor: string[];
  lastSeen: number;
  /** Took damage in the last few seconds (visible hurt animation). */
  hurtRecently: boolean;
}

export interface BlockNote {
  name: string;
  pos: Vec3;
  distance: number;
  seenAt: number;
}

export interface Utterance {
  id: string;
  convId: ConvId;
  from: AgentName;
  to: AgentName[] | 'nearby';
  text: string;
  ts: number;
  /** Speaker position when visible. */
  pos: Vec3 | null;
  volume: Volume;
  /** "heard <name> from out of sight" (§6.1). */
  outOfSight: boolean;
  addressedToMe: boolean;
  /** How addressee detection read it (§6.2): for me, for someone else, or unclear (a group question). */
  heardAs?: 'me' | 'other' | 'unsure';
}

export type ObservedActionKind =
  | 'swing'
  | 'dig'
  | 'place'
  | 'equip'
  | 'collect'
  | 'hurt'
  | 'attack'
  | 'death'
  | 'toss'
  | 'gave'
  | 'sleep'
  | 'eat'
  | 'flee'
  | 'follow'
  | 'stopAttack';

export interface ObservedAction {
  id: string;
  actor: AgentName;
  kind: ObservedActionKind;
  target?: AgentName;
  item?: string;
  qty?: number;
  pos?: Vec3;
  ts: number;
  detail?: string;
}

export type SystemEventKind = 'death' | 'join' | 'leave' | 'advancement' | 'other';

export interface SystemEvent {
  kind: SystemEventKind;
  ts: number;
  text: string;
  subject?: AgentName;
  killer?: AgentName;
  cause?: string;
}

export type MemorySource = 'self_observed' | `told_by:${string}` | 'inferred' | 'reflection';

export interface WorkItem {
  id: string;
  text: string;
  ts: number;
  /** 0..1, how much this matters right now. */
  salience: number;
  source: MemorySource;
  aboutAgent?: AgentName;
}

export type GoalKind = 'life' | 'current' | 'social' | 'community';

export interface Goal {
  id: string;
  text: string;
  kind: GoalKind;
  createdAt: number;
  parent?: string;
  status: 'active' | 'done' | 'abandoned';
  /** Optional machine-checkable completion condition (same grammar as option `until`). */
  doneWhen?: string;
}

export interface Task {
  id: string;
  skill: string;
  args: Record<string, unknown>;
  source: 'cc' | 'commitment' | 'goal' | 'reflex' | 'plan';
  commitmentId?: string;
  createdAt: number;
  priority: number;
  note?: string;
}

export interface ActiveOption {
  decisionId: string;
  option: OptionName;
  startedAt: number;
  maxSeconds: number;
  until?: string;
  targetAgent?: AgentName;
  targetPos?: Vec3;
  targetItem?: string;
  skill?: string;
  args?: Record<string, unknown>;
  status: 'running' | 'succeeded' | 'failed' | 'terminated';
  progress?: string;
}

export interface ActionRecord {
  id: string;
  skill: string;
  args: Record<string, unknown>;
  expected: string;
  observed: string;
  ok: boolean;
  ts: number;
  durationMs: number;
  error?: string;
  /** Gained something on the way even though it failed (partial progress is not being stuck). */
  progressed?: boolean;
}

export type CommitmentStatus = 'proposed' | 'accepted' | 'fulfilled' | 'broken' | 'cancelled';

export interface Commitment {
  id: string;
  /** Who owes whom. */
  debtor: AgentName;
  creditor: AgentName;
  what: CommitmentWhat;
  dueBy?: number;
  status: CommitmentStatus;
  createdFromConv: ConvId;
  createdAt: number;
  verifiedBy?: 'inventory' | 'observation' | 'self_report' | 'judgment';
  coerced?: boolean;
  resolvedAt?: number;
  /** Progress counter for give/gather (items received so far, etc.). */
  progress?: number;
}

export type GrievanceKind =
  | 'insult'
  | 'theft'
  | 'attack'
  | 'betrayal'
  | 'coercion'
  | 'killed_friend'
  | 'killed_partner'
  | 'killed_parent'
  | 'broken_promise'
  | 'griefing'
  | 'unwanted_advance'
  | 'romantic_rival'
  | 'rejection'
  | 'scapegoat';

export interface Grievance {
  kind: GrievanceKind;
  weight: number;
  ts: number;
  witnessed: boolean;
  source: 'self_observed' | `told_by:${string}`;
  note?: string;
}

export type Allegiance = 'ally' | 'follower' | 'leader' | 'rival' | 'enemy';
export type Relationship = 'none' | 'crush' | 'courting' | 'partner' | 'ex';
export type Kin = 'parent' | 'child' | 'sibling' | 'partner' | 'grandparent' | null;
export type FightOutcome = 'won' | 'lost' | 'yielded' | 'spared' | 'interrupted';

export interface SocialFact {
  text: string;
  source: 'told' | 'observed';
  ts: number;
}

export interface SocialProfile {
  name: AgentName;
  firstMet: number;
  lastSeen: number;
  lastSeenPos?: Vec3;
  /** 0 hate … 10 love (Sid). */
  sentiment: number;
  /** 0..1 reliability of their claims & promises. */
  trust: number;
  perceivedRole?: string;
  perceivedGoals: string[];
  facts: SocialFact[];
  summary: string;
  promisesKept: number;
  promisesBroken: number;
  interactions: number;
  // §17.2
  friction: number;
  grievances: Grievance[];
  perceivedPower: number;
  fearOf: number;
  allegiance?: Allegiance;
  theirStanceGuess?: Allegiance;
  lastFight?: { ts: number; outcome: FightOutcome };
  // §18.3
  admiration: number;
  /** Interactions counted so far toward the ×2 anchoring of the first 2. */
  anchorCount: number;
  // §19
  perceivedSex: Sex | 'unknown';
  romanticInterest: number;
  relationship: Relationship;
  relationshipSince?: number;
  kin: Kin;
  // §21.4
  estCombat: number;
  estIntelligence: number;
  /** Traits I believe they have (used for a human partner's perceived model, §19.3). */
  estTraits: Record<string, number>;
  // perception-derived power inputs (§17.4)
  gearScore: number;
  killsSeen: number;
  fightsWonSeen: number;
  followersSeen: number;
  /** Agents this person was seen accompanying recently (for follower/leader inference). */
  companions: AgentName[];
}

export interface ConversationState {
  convId: ConvId;
  participants: AgentName[];
  startedAt: number;
  lastActivity: number;
  turns: number;
  myTurns: number;
  lastEmbeds: number[][];
  topic?: string;
  status: 'active' | 'ending' | 'ended';
  transcript: Utterance[];
  initiatedByMe: boolean;
  nudged: boolean;
  partnerOutOfRangeSince?: number;
  endedReason?: string;
}

export interface EmotionState {
  anger: number;
  fear: number;
  joy: number;
  sadness: number;
  disgust: number;
  shame: number;
  envy: number;
  affection: number;
  /** max-ish of the intense ones; drives impulsivity and blocks reflection (§18.2). */
  arousal: number;
}

export type EmotionName = Exclude<keyof EmotionState, 'arousal'>;

export interface Mood {
  /** -1..1 slow EMA of emotions; hours-scale. */
  valence: number;
  baselineShift: number;
}

export interface HeardOpinion {
  speaker: AgentName;
  target: AgentName;
  /** -1 (very negative) .. 1 (very positive). */
  valence: number;
  ts: number;
}

export interface Drives {
  caution: number;
  cautionBaseline: number;
  /** Extinction-brake shift applied to the baseline until brakeUntil (§17.10). */
  brakeShift: number;
  brakeUntil: number;
}

export interface ActiveFight {
  target: AgentName;
  intent: 'brawl' | 'lethal' | 'defend' | 'impulse';
  startedAt: number;
  rung: number;
  hitsLanded: number;
  hitsTaken: number;
  yieldedBy?: AgentName;
}

export interface ConflictState {
  /** Current escalation rung toward each person (0 avoid … 4 lethal). */
  rungs: Record<AgentName, number>;
  lastPressure: Record<AgentName, number>;
  pairCooldownUntil: Record<AgentName, number>;
  activeFight: ActiveFight | null;
}

export interface FamilyState {
  partner?: AgentName;
  parents: AgentName[];
  children: AgentName[];
  siblings: AgentName[];
  home?: { beds: Vec3[]; chest?: Vec3 };
  familyName?: string;
  lastConceptionTs?: number;
  /** Romance soft-persistence cap bookkeeping (§19.10): target → attempts this in-game week. */
  advances: Record<AgentName, { count: number; weekStart: number; rejections: number }>;
}

export interface LifeState {
  born: boolean;
  /** Epoch ms this life started (spawn or birth). */
  startedAt: number;
  /** Youth phase end (born agents only, §19.5). */
  youthUntil: number;
  deaths: number;
}

export interface KnowledgeState {
  recipes: string[];
  seenItems: string[];
}

export interface GrowthState {
  rationalityBonus: number;
  conformityBonus: number;
  combatGrowth: number;
  selfCorrections: number;
  mobParticipations: number;
}

export interface AgentFlags {
  inDanger: boolean;
  stuck: boolean;
  busyLevel: 'idle' | 'working' | 'critical';
  /** Canned fast line Talking should use while a reflex is busy ("hang on, zombie!"). */
  busySpeech: string | null;
  codeOnly: boolean;
  degrade: DegradeLevel;
  inCrowd: boolean;
}

export interface SelfState {
  name: string;
  username: AgentName;
  persona: Persona;
  pos: Vec3;
  health: number;
  food: number;
  oxygen: number;
  inventory: ItemStack[];
  equipped: string | null;
  armor: string[];
  dimension: string;
  /** In-game time of day in ticks (0..23999). */
  time: number;
  isDay: boolean;
  lightLevel: number;
  isSleeping: boolean;
  spawnPos: Vec3 | null;
}

export interface Perception {
  nearbyEntities: SeenEntity[];
  nearbyBlocksOfInterest: BlockNote[];
  /** ring buffer */
  heardSpeech: Utterance[];
  observedActions: ObservedAction[];
  systemEvents: SystemEvent[];
}

export interface AgentState {
  /** Monotonic version: bumped on every mutation. */
  version: number;
  self: SelfState;
  perception: Perception;
  /** ~5 items, newest on mind. */
  workmem: WorkItem[];
  /** Narrative from the Self-Monitor. */
  selfSummary: string;
  goals: { life: string[]; current: Goal | null; social: Goal[]; community?: string; history: Goal[] };
  decision: Decision | null;
  option: ActiveOption | null;
  taskQueue: Task[];
  commitments: Commitment[];
  social: Record<AgentName, SocialProfile>;
  conversations: Record<ConvId, ConversationState>;
  actionLog: ActionRecord[];
  flags: AgentFlags;
  drives: Drives;
  emotions: EmotionState;
  mood: Mood;
  heardOpinions: HeardOpinion[];
  knowledge: KnowledgeState;
  conflict: ConflictState;
  family: FamilyState;
  life: LifeState;
  growth: GrowthState;
  /** "has grown wary of strangers since being robbed" (§7 evolution). */
  traitAnnotations: string[];
  /** bias:target → susceptibility multiplier after a correction (§18.6). */
  inoculation: Partial<Record<`${BiasName}:${string}`, number>>;
}

/** Events emitted by the blackboard and modules. Payloads are small; modules read state for details. */
export type AgentEvent =
  | { type: 'stateChanged'; reason: string }
  | { type: 'perception' }
  | { type: 'danger'; source: string; level: number }
  | { type: 'dangerCleared' }
  | { type: 'heard'; utterance: Utterance }
  | { type: 'addressed'; utterance: Utterance }
  /** A line in earshot not addressed to us (§6.2 group floor control decides whether to chime in). */
  | { type: 'overheard'; utterance: Utterance }
  | { type: 'needsDecision'; reason: string; convId?: ConvId; from?: AgentName }
  | { type: 'optionTerminated'; reason: string; ok: boolean }
  | { type: 'decision'; decision: Decision }
  | { type: 'conversationStarted'; convId: ConvId }
  | { type: 'conversationEnded'; convId: ConvId; reason: string }
  | { type: 'observedAction'; action: ObservedAction }
  | { type: 'systemEvent'; event: SystemEvent }
  | { type: 'peerDied'; name: AgentName; cause: string; where?: Vec3; witnessed: boolean }
  | { type: 'commitmentResolved'; commitmentId: string; status: CommitmentStatus }
  | { type: 'newGoal'; goal: Goal }
  | { type: 'goalDone'; goal: Goal }
  | { type: 'actionRecorded'; record: ActionRecord }
  | { type: 'stuck'; skill: string }
  | { type: 'inventoryChanged' }
  | { type: 'emotionSpike'; emotion: EmotionName; value: number; cause: string }
  | { type: 'attacked'; by: AgentName | null; damage: number }
  | { type: 'fightStarted'; target: AgentName }
  | { type: 'fightEnded'; target: AgentName; outcome: FightOutcome }
  | { type: 'death'; cause: string };

export type AgentEventType = AgentEvent['type'];
