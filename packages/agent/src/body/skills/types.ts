// Skill contract (§4.6): every skill declares its expected postcondition, which the runner checks against the
// real inventory/world diff afterwards. Skills are verified code primitives — never LLM-generated here (M10 adds
// sandboxed generated skills behind a separate gate).

import type { BuildProject, Logger, Random, Volume } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';
import type { z } from 'zod';
import type { InventorySnapshot } from '../inventory';

export type Expectation =
  | { kind: 'inventoryGain'; item: string; atLeast: number }
  | { kind: 'inventoryLoss'; item: string; atLeast: number }
  /** Holding at least this many afterwards, however many we had before (obtain). */
  | { kind: 'inventoryHas'; item: string; atLeast: number }
  | { kind: 'near'; pos: Vec3; within: number }
  | { kind: 'nearAgent'; agent: string; within: number }
  | { kind: 'blockAt'; pos: Vec3; block: string }
  /** With entityId, that specific entity (e.g. the zombie we picked) must be gone, not every one of its kind. */
  | { kind: 'entityGone'; target: string; entityId?: number }
  | { kind: 'foodAbove'; value: number }
  | { kind: 'equipped'; item: string }
  | { kind: 'awakeAfterNight' }
  | { kind: 'none' };

export interface BodySnapshot {
  inventory: InventorySnapshot;
  pos: Vec3;
  food: number;
  health: number;
  ts: number;
}

export interface SkillResult {
  ok: boolean;
  /** What actually happened, in plain words (for logs, workmem and the CC packet). */
  observed: string;
  /** Why it failed ("need a pickaxe", "no oak_log within 48 blocks"). Feeds stuck detection. */
  error?: string;
  data?: Record<string, unknown>;
}

/** Execution slips injected by code (§21.1): wrong tool, inefficient path, miscount. */
export type SlipKind = 'tool' | 'path' | 'count';

export interface SkillContext {
  bot: Bot;
  signal: AbortSignal;
  logger: Logger;
  rng: Random;
  /** Quirk-adjusted pathfinder movements (§7 pathCost): a walk, or with `sprint` a run (running away). */
  movements: (sprint?: boolean) => Movements;
  /** Recipe knowledge gate (§21.2): false = "I don't know how to make that". */
  knowsRecipe: (item: string) => boolean;
  /** Rate-limited speech port (§6.2). */
  /** `urgent`: at once, ahead of anything waiting to be said (giving up a fight, calling one off). */
  say: (text: string, volume?: Volume, urgent?: boolean) => Promise<void>;
  /** The slip rolled for this run, if any (§21.1). Skills apply it where it makes sense. */
  slip: SlipKind | null;
  /** Where the body first appeared (explore stays within reach of it). */
  home: Vec3 | null;
  /** Progress notes for the dashboard and termination checks. */
  progress: (note: string) => void;
  /** How many prerequisite levels `obtain` may plan through (§21.1 planning horizon). */
  planDepth: number;
  /** Fighting ability 0..1 with growth (§21.3): technique in fights. */
  combat?: number;
  /** Whom we are in a conversation with just now, if anyone (a stroll stops for it). */
  talkingWith?: () => string | null;
  /** Someone just seen attacking another, if anyone (a stroll stops to watch). */
  fightNearby?: () => string | null;
  /** How deep in making tools for the job we are (tools.ts): a tool being made makes none of its own. */
  toolDepth?: number;
  /**
   * Who should make a chest when there is none (owner request, 2026-10-24): null when we should (a builder, or anyone
   * when there's no builder), else the builder's name, to ask.
   */
  chestMaker?: () => string | null;
  /** The buildings we have begun (construct.ts): where each one is, so a second go carries on there. */
  projects?: ProjectBook;
  /** The architect (building/architect.ts): draws a building for what is asked and makes building it our plan. */
  architect?: (ask: DesignAsk) => Promise<SkillResult>;
  /** Makes a place home (settle.ts): the village moves with its people. */
  setHome?: (pos: Vec3) => void;
}

/** What the `design` skill asks the architect for, with what it saw of the land around home. */
export interface DesignAsk {
  purpose: string;
  kind?: string;
  /** The biome at home. */
  biome: string;
  /** What there is to build with, in a line. */
  materials: string;
  /** Trees here, the commonest first. */
  woods: string[];
  /** What one of each raw material takes here (dear where nobody has seen any). */
  raw: Record<string, number>;
}

/** Ground taken, from corner to corner (x0 ≤ x1, z0 ≤ z1). */
export interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** What an agent knows of the buildings it has begun and of the others near home. */
export interface ProjectBook {
  get(design: string): BuildProject | null;
  set(p: BuildProject): void;
  /** The ground other buildings and the village's things stand on (a chest is a box of one), to build clear of. */
  taken(): Footprint[];
}

export interface SkillDef<A> {
  name: string;
  /** One line for the CC's skill list. */
  description: string;
  argsSchema: z.ZodType<A>;
  /** §6.2 busy matrix: these can continue while talking (follow, stay, walk, collect). */
  talkOverable: boolean;
  /** Slip kinds that apply to this skill. */
  slipKinds: readonly SlipKind[];
  expect(args: A, before: BodySnapshot, bot: Bot): Expectation;
  run(ctx: SkillContext, args: A): Promise<SkillResult>;
}

/** Type-erased skill for the registry. */
export interface AnySkill {
  name: string;
  description: string;
  talkOverable: boolean;
  slipKinds: readonly SlipKind[];
  parseArgs(raw: unknown): { ok: true; args: unknown } | { ok: false; error: string };
  expect(args: unknown, before: BodySnapshot, bot: Bot): Expectation;
  run(ctx: SkillContext, args: unknown): Promise<SkillResult>;
}

export function defineSkill<A>(def: SkillDef<A>): AnySkill {
  return {
    name: def.name,
    description: def.description,
    talkOverable: def.talkOverable,
    slipKinds: def.slipKinds,
    parseArgs(raw) {
      const r = def.argsSchema.safeParse(raw ?? {});
      if (r.success) return { ok: true, args: r.data };
      return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ') };
    },
    expect: (args, before, bot) => def.expect(args as A, before, bot),
    run: (ctx, args) => def.run(ctx, args as A),
  };
}

export class SkillAbortedError extends Error {
  constructor(reason: string) {
    super(`aborted: ${reason}`);
    this.name = 'SkillAbortedError';
  }
}
