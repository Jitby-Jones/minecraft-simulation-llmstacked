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
  /** A player lying in a bed, asleep (§19.3 the bed ritual). */
  sleeping?: boolean;
}

export interface BlockNote {
  name: string;
  pos: Vec3;
  distance: number;
  seenAt: number;
}

/**
 * A block that changed around us, as the agent could tell it (a wall it stands against, a block in sight): broken,
 * set down, or a door opened or shut; who was at it, if anyone; and whether it was ours.
 */
export interface BlockChange {
  pos: Vec3;
  kind: 'broken' | 'placed' | 'opened' | 'closed';
  /** What was there, and what is there now. */
  was: string;
  now: string;
  /** Who was at it: a person, a mob ("a zombie"), or "an explosion"; left out if nobody was seen at it. */
  by?: string;
  /** Ours: part of the shelter we are in, of a hut of the village, the village chest, or a block we set down. */
  ours?: 'shelter' | 'hut' | 'chest' | 'placed';
  /** Where, from where we stood, in words: "beside you to the north, at head height". */
  where: string;
  ts: number;
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

/** Where a memory came from; `operator` is one the operator wrote or edited (debug controls). */
export type MemorySource = 'self_observed' | `told_by:${string}` | 'inferred' | 'reflection' | 'operator';

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
  /** A social goal's kind of village work (§6.8): wood, stone, food, build, guard, tools, scout. */
  work?: string;
  /** Someone the goal is with or for. */
  with?: AgentName;
}

/** One step of an agent's plan: a goal in the agent's own words, checked by code when it has a `doneWhen`. */
export interface PlanStep {
  text: string;
  /** Machine-checkable completion (the `doneWhen` grammar); without one the step is done when the agent says so. */
  doneWhen?: string;
  status: 'todo' | 'doing' | 'done' | 'dropped';
}

/**
 * The agent's own plan (what it means to get done over the next half hour or so, as a few steps). It makes it
 * itself, and changes it as it goes and after talking things over with others; the current step is its current goal.
 */
export interface Plan {
  id: string;
  /** What the plan is for, in the agent's own words. */
  aim: string;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
  /** Why it was made or last changed ("Mira cuts the wood, so I'll get the stone"). */
  why?: string;
  /** Whom it has been talked over with. */
  discussedWith: AgentName[];
  /** Who made it: the model, the code default, or the operator (debug controls). */
  source: 'llm' | 'default' | 'operator';
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
  /** Chosen in danger: while it runs, the body's reflexes stand by (hazards and what no thought is quick enough for
   *  aside), as one who has decided what to do does it. */
  underFire?: boolean;
}

export interface ActionRecord {
  /** Skill-specific results (a duel's outcome, …). */
  data?: Record<string, unknown>;
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
/** What reflection can inoculate against (§18.6): a bias, or going along with what people say (conformity). */
export type Inoculable = BiasName | 'conformity';
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
  /**
   * §18.5 FACTS: what they have actually done to us, 0..10, the same scale as sentiment but without first
   * impressions, halo, envy or hearsay. The CC sees both; code mixes them by the override factor.
   */
  evidence: number;
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
  /** §18.4.1: when someone was seen standing up to them and getting away with it (they look weaker, fear falls). */
  defiedSeen?: number[];
  /** §18.6 inoculation: biases reflection corrected about this person (×0.5 susceptibility for the rest of this life). */
  inoculated?: Inoculable[];
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
  /** We and our partner agreed to start a family (§19.3): the bed ritual is next. */
  planning?: { with: AgentName; at: number };
  /** A born agent: the parents it has greeted in person (§19.3 "hi mom, hi dad!"). */
  greeted?: AgentName[];
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
  /** Owner request, 2026-10-24: what the agent learned as it played. */
  lessons?: Lesson[];
  beliefs?: Belief[];
  /** The first time it saw each notable kind of thing ("entity:mooshroom", "block:diamond_ore"). */
  firstSeen?: Record<string, number>;
  /** What it has seen surprise it, by what it was about and the key, with how often ("Kelby:hover"). */
  surprised?: Record<string, number>;
  /** What it expects of each kind of creature, learned from what it saw. */
  envelopes?: Record<string, Envelope>;
  /** Where it saw things worth coming back to. */
  places?: Place[];
}

export interface GrowthState {
  rationalityBonus: number;
  conformityBonus: number;
  combatGrowth: number;
  selfCorrections: number;
  mobParticipations: number;
  /** M10, §7 evolution: the experiences reflection has already weighed for a trait annotation (each once a life). */
  evolved?: string[];
}

/** A sign this agent has read (§6.8 notice board): where it stands and what its front says. */
export interface SignSeen {
  pos: Vec3;
  text: string;
  readAt: number;
}

/**
 * What this agent knows of its village (§6.8), from its own eyes only (§13 rule 4): the village is where it arrived
 * (home). The chest and the board are the ones nearest home that it has seen; what is in the chest is what it saw
 * the last time it opened it.
 */
export interface VillageState {
  /** Where this agent arrived: the village (null until it has a body). */
  home: Vec3 | null;
  chest: { pos: Vec3; contents: Record<string, number> | null; seenAt: number } | null;
  /** Huts near home, by their doors. */
  huts: Vec3[];
  /** The rooms of the huts this agent built itself, where one goes in to be inside (newest last). */
  rooms?: Vec3[];
  /** Where the signs near home stand: the first one seen there. */
  board: Vec3 | null;
  /** Signs read, newest last (ring). */
  signs: SignSeen[];
  /** When hostile mobs came near home lately (ring of timestamps). */
  threats: number[];
  /** Ore this agent found away from home (newest last, ring): what a scout comes back to post. */
  finds: { what: string; pos: Vec3; at: number }[];
  /** Buildings this agent has begun (owner request, 2026-10-24): where, how far along, what they still lack. */
  projects: BuildProject[];
  /** Portals this agent has built or been through (owner request, 2026-10-24): the way to the Nether and back. */
  portals: PortalNote[];
}

/** A portal: which world it stands in (overworld, the_nether, the_end), where, and where it leads. */
export interface PortalNote {
  dimension: string;
  pos: Vec3;
  leadsTo: string;
  at: number;
}

/** A building begun: one of the village's designs, put up at a site, a second go carrying on where the first stopped. */
export interface BuildProject {
  /** The design's id ("plains-cottage", "vanilla:plains_small_house_1"). */
  design: string;
  name: string;
  /** The box's north-west corner at the ground's top layer. */
  origin: Vec3;
  /** Quarter turns clockwise. */
  turn: number;
  /** Its size on the ground as it stands (east-west, north-south). */
  size: { x: number; z: number };
  /** Where its door is, if it has one. */
  door: Vec3 | null;
  startedAt: number;
  /** Blocks in, of all of them. */
  placed: number;
  total: number;
  /** What it still lacks, by item. */
  missing: Record<string, number>;
  /** Blocks put in place of the design's own, decided when it was begun (oak_planks → spruce_planks). */
  swaps: Record<string, string>;
  doneAt: number | null;
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
  /** Modules the operator switched off (debug controls, TUNABLE_MODULES). */
  off?: string[];
  /** The operator paused the agent: no decisions (the reflexes still keep it alive). */
  paused?: boolean;
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
  /** Free slots of the 36 in the inventory and hotbar. */
  slotsFree?: number;
  equipped: string | null;
  armor: string[];
  dimension: string;
  /** In-game time of day in ticks (0..23999). */
  time: number;
  isDay: boolean;
  lightLevel: number;
  isSleeping: boolean;
  spawnPos: Vec3 | null;
  /** The world's difficulty (how hard monsters hit, whether hunger can kill). */
  difficulty?: string;
}

/** How something moves, as a player sees it (owner request, 2026-10-24: complete senses). */
export type MotionKind = 'still' | 'walking' | 'running' | 'jumping' | 'falling' | 'flying' | 'swimming' | 'climbing' | 'riding' | 'gliding';

/**
 * A creature or thing in view (owner request, 2026-10-24: complete senses): where it is from us, how it moves, how it
 * stands to us and to what is around it, and what a player can see of it.
 */
export interface SceneCreature {
  id: number;
  kind: EntityKind;
  /** Username for people, mob type otherwise; an item on the ground is the item's name. */
  name: string;
  pos: Vec3;
  distance: number;
  /** Compass direction from us ("north-east"); "here" within a block. */
  bearing: string;
  /** Metres above (+) or below (-) our feet. */
  dy: number;
  motion: MotionKind;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Its feet above the ground under it, when it is off the ground. */
  aboveGround?: number;
  /** Seconds off the ground with nothing under it. */
  airborneSec?: number;
  heading?: 'toward you' | 'away from you' | 'across';
  /** How it stands to someone or something around it: "chasing Bo", "next to the cow", "looking at you". */
  relations: string[];
  /** What can be seen of it: "baby", "white wool", "sheared", "holding iron_pickaxe", "in iron armor". */
  details: string[];
  /** Items on the ground: how many. */
  count?: number;
  visible: boolean;
}

export type SceneFeatureKind =
  | 'trees' | 'water' | 'lava' | 'ore' | 'rock' | 'sand' | 'gravel' | 'clay' | 'snow' | 'crops' | 'plants' | 'built'
  | 'station' | 'container' | 'bed' | 'portal' | 'spawner' | 'danger' | 'ground' | 'other';

/** A group of blocks in view, one thing to a player: a stand of trees, a pond, ore in a wall, a building. */
export interface SceneFeature {
  kind: SceneFeatureKind;
  /** In words: "4 oak trees", "iron ore (3)", "a building of oak planks and glass". */
  what: string;
  /** Blocks of it seen, by name. */
  blocks: Record<string, number>;
  nearest: Vec3;
  distance: number;
  bearing: string;
  dy: number;
  size: number;
  /** The first of its kind this agent has ever seen. */
  first?: boolean;
}

/** Something that stood out: what doesn't fit what the agent knows is possible, what is new to it, a cue it waited for. */
export interface Notice {
  id: string;
  ts: number;
  kind: 'surprise' | 'novel' | 'cue';
  /** Who or what it is about: a name, a mob type, "you", "the world". */
  about: string;
  /** A key for the same sort of thing (habituation): "hover", "speed", "teleport", "appear", "inside", ... */
  key: string;
  text: string;
  /** 0..1: how far outside what is expected; it shrinks as the same thing is seen again. */
  strength: number;
  /** How often this agent saw the same before (0: never). */
  seenBefore: number;
}

/** What the agent sees around it now (owner request, 2026-10-24): the place, the features in view, what moves in it. */
export interface Scene {
  at: number;
  /** Where we are, as a player would put it: the biome, what we stand on, the sky or a roof, inside or out. */
  where: string;
  features: SceneFeature[];
  creatures: SceneCreature[];
  /** What stood out lately (the last few minutes), newest last. */
  notices: Notice[];
}

/** A train of thought, kept from one decision to the next (owner request, 2026-10-24: think, don't follow rules). */
export interface Thought {
  ts: number;
  text: string;
  decisionId?: string;
}

/** One step the agent means to take after the one under way: a skill, or another option. */
export interface IntentionStep {
  skill?: string;
  args?: Record<string, unknown>;
  option?: OptionName;
  target?: { agent?: string; pos?: Vec3 };
  text?: string;
}

/** What the agent means to do next, in order, decided in one go: done one after another without stopping to think. */
export interface Intention {
  aim: string;
  steps: IntentionStep[];
  from: string;
  at: number;
  /** Meant in danger (a way out in steps): the steps go on while the danger lasts. */
  underFire?: boolean;
}

/** A place the agent saw something worth coming back to (a herd of sheep, ore in a cliff, a building): its map memory. */
export interface Place {
  key: string;
  kind: SceneFeatureKind | 'animals';
  what: string;
  pos: Vec3;
  world: string;
  seenAt: number;
  /** Block or creature names there, for finding it again by what is needed. */
  names: string[];
}

/** Something put off until a cue (prospective memory): "get wool when I see sheep". */
export interface Deferred {
  id: string;
  what: string;
  /** see:<thing> | have:<item>[>=n] | day | night | minutes:<n> */
  cue: string;
  since: number;
  /** For minutes:<n>, when it comes due. */
  due?: number;
  /**
   * For day or night put off while it is that already: the other must come first ("when it's day" said at dusk is
   * the morning, not now).
   */
  after?: 'day' | 'night';
}

/** A task someone gave this agent (the operator, or anyone), in their words; done or dropped by the agent's own judgment. */
export interface AssignedTask {
  id: string;
  text: string;
  from: string;
  at: number;
  status: 'open' | 'done' | 'dropped';
  note?: string;
}

/** The thinking side of the agent (owner request, 2026-10-24). */
export interface MindState {
  thoughts: Thought[];
  intention: Intention | null;
  later: Deferred[];
  /** What it reached for lately and could not do now, and why: kept in mind so the same isn't reached for again at once. */
  ruledOut?: RuledOut[];
}

/** Something chosen that the checks would not have, as the agent keeps it in mind (one per reason). */
export interface RuledOut {
  /** What was chosen ("shelter {\"untilMorning\":true}"). */
  what: string;
  why: string;
  ts: number;
  /** How many times lately. */
  n: number;
}

/** Something learned from experience, kept for life (owner request, 2026-10-24: agents learn as they play). */
export interface Lesson {
  id: string;
  text: string;
  ts: number;
  from: 'experience' | 'thought' | 'told';
  /** How often it came to mind for a decision since. */
  uses: number;
}

/** What the agent has come to believe about someone or some kind of thing from what it saw ("Kelby can fly"). */
export interface Belief {
  about: string;
  key: string;
  text: string;
  since: number;
  seen: number;
  lastSeen: number;
}

/** What the agent has learned to expect of a kind of creature, from what it has seen (and what it knew of the game). */
export interface Envelope {
  /** Fastest seen on the ground and in the air, m/s. */
  ground: number;
  air: number;
  /** Longest seen off the ground with nothing under it and not falling, s. */
  hover: number;
  /** Highest seen above the ground without falling, m. */
  height: number;
  /** Observations it rests on. */
  n: number;
}

export interface Perception {
  nearbyEntities: SeenEntity[];
  nearbyBlocksOfInterest: BlockNote[];
  /** ring buffer */
  heardSpeech: Utterance[];
  observedActions: ObservedAction[];
  systemEvents: SystemEvent[];
  /** ring buffer: blocks that changed around us lately (a broken shelter wall, a door, a block set down). */
  blockChanges: BlockChange[];
}

export interface AgentState {
  /** Monotonic version: bumped on every mutation. */
  version: number;
  self: SelfState;
  perception: Perception;
  /** What it sees around it, grouped as a player sees it (owner request, 2026-10-24). */
  scene: Scene;
  /** Its train of thought, what it means to do next, and what it put off (owner request, 2026-10-24). */
  mind: MindState;
  /** ~5 items, newest on mind. */
  workmem: WorkItem[];
  /** Narrative from the Self-Monitor. */
  selfSummary: string;
  goals: {
    life: string[];
    /** Tasks someone gave this agent (owner request, 2026-10-24), worked toward by its own plans. */
    tasks?: AssignedTask[];
    current: Goal | null;
    /** The agent's own plan; its current step is `current`. */
    plan?: Plan | null;
    social: Goal[];
    community?: string;
    history: Goal[];
    /** The role the last five social goals add up to (§6.8, Sid's inference, in code). */
    role?: string | null;
    /** The kinds of work of the latest social goals (newest last, up to five). */
    socialKinds?: string[];
  };
  village: VillageState;
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
  | { type: 'danger'; source: string; level: number; kind?: 'fight' | 'flee' | 'hazard' | 'defend' }
  /** `what`: how it ended, in words ("never got to the skeleton; it is still about, 12 m off; health 20 to 17"). */
  | { type: 'dangerCleared'; what?: string }
  | { type: 'heard'; utterance: Utterance }
  | { type: 'addressed'; utterance: Utterance }
  /** A line in earshot not addressed to us (§6.2 group floor control decides whether to chime in). */
  | { type: 'overheard'; utterance: Utterance }
  /** Social Awareness read an insult in a conversation (an appraisal event, §18.2). */
  | { type: 'insulted'; by: AgentName }
  /** Something stirred a feeling (§18.2): the impulse path (§18.5) looks at it. */
  | { type: 'felt'; cause: string; by?: AgentName; arousal: number }
  /** The escalation rung toward someone moved (§17.5). */
  | { type: 'rungChanged'; name: AgentName; from: number; to: number }
  /** Someone we're at odds with (rung ≥ 1) has just come near (§17.5 "X comes into sight"). */
  | { type: 'atOddsNearby'; name: AgentName; rung: number }
  | { type: 'needsDecision'; reason: string; convId?: ConvId; from?: AgentName }
  | { type: 'optionTerminated'; reason: string; ok: boolean; option?: OptionName; targetAgent?: AgentName; decisionId?: string }
  | { type: 'decision'; decision: Decision }
  | { type: 'conversationStarted'; convId: ConvId }
  | { type: 'conversationEnded'; convId: ConvId; reason: string }
  /** A line of ours went out in a conversation. */
  | { type: 'spoke'; convId: ConvId; text: string }
  /** A talk settled on something to do now (owner request, 2026-10-24): what, with whom, and our part in it. */
  | { type: 'agreed'; with: AgentName[]; what: string; mine?: string }
  | { type: 'observedAction'; action: ObservedAction }
  | { type: 'systemEvent'; event: SystemEvent }
  /** A death notice about someone else (§16.3); grief −1 (relief) … 1 by how we felt about them. */
  | { type: 'peerDied'; name: AgentName; cause: string; where?: Vec3; witnessed: boolean; grief?: number; killer?: AgentName }
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
  | { type: 'death'; cause: string }
  /** A sign read for the first time, or changed since (§6.8). `board`: it stands at the village's notice board. */
  | { type: 'signRead'; sign: SignSeen; board: boolean }
  /** We began or stopped following someone (§17.7). */
  | { type: 'leaderChanged'; leader: AgentName | null; before: AgentName | null }
  /** We walked away from our leader as a group set upon them (§17.8 defection). */
  | { type: 'defected'; from: AgentName; attackers: AgentName[] }
  /** §17.8: someone we resent is alone or hurt, and others resent them too: the moment to call on them. */
  | { type: 'opening'; name: AgentName }
  /** M10: the CC reached for a skill there is none of; the skill writer may write it. */
  | { type: 'skillWanted'; name: string; args: Record<string, unknown>; why: string }
  /** M10: a skill the agent wrote did what it said on its trial, and is kept. */
  | { type: 'skillLearned'; name: string; description: string }
  /** M10, §7 evolution: reflection found the agent changed ("has grown wary of strangers since being robbed"). */
  | { type: 'traitAnnotated'; text: string }
  /** A block around us changed, as we could tell it (perception/surroundings.ts). */
  | { type: 'surroundingsChanged'; change: BlockChange }
  /** Something stood out (owner request, 2026-10-24): what doesn't fit what we know is possible, or is new to us. */
  | { type: 'noticed'; notice: Notice }
  /** A cue something was put off for came (prospective memory): "get wool when I see sheep". */
  | { type: 'cue'; deferred: Deferred; why: string }
  /** The agent learned something from what happened. */
  | { type: 'learned'; lesson: Lesson }
  /** Someone gave the agent a task (owner request, 2026-10-24). */
  | { type: 'taskGiven'; task: AssignedTask };

export type AgentEventType = AgentEvent['type'];
