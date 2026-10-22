// Skill contract (§4.6): every skill declares its expected postcondition, which the runner checks against the
// real inventory/world diff afterwards. Skills are verified code primitives — never LLM-generated here (M10 adds
// sandboxed generated skills behind a separate gate).

import type { Logger, Random, Volume } from '@agora/shared';
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
  /** Quirk-adjusted pathfinder movements (§7 pathCost). */
  movements: () => Movements;
  /** Recipe knowledge gate (§21.2): false = "I don't know how to make that". */
  knowsRecipe: (item: string) => boolean;
  /** Rate-limited speech port (§6.2). */
  say: (text: string, volume?: Volume) => Promise<void>;
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
