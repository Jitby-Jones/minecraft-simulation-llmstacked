// The Body: one mineflayer client plus plugins, quirk-aware movements, rate-limited chat, L0 reflexes and the
// verified skill runner. Modules above it never touch mineflayer directly except through perception.

import { type Logger, type Quirk, type Random, type Volume, SeededRandom, seedFromString } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';
import { type BodyOptions, connectBody, disconnectBody } from './bot';
import { ChatOut, type ChatOutOptions } from './chatOut';
import { createMovements, loadBodyPlugins } from './plugins';
import { ReflexController, type ReflexHooks, type ReflexOptions } from './reflexes';
import { getSkill } from './skills/registry';
import { type SkillRunRecord, runSkill } from './skills/runner';
import type { AnySkill } from './skills/types';

export interface BodyConfig extends BodyOptions {
  logger: Logger;
  quirks?: readonly Quirk[];
  rng?: Random;
  chat?: ChatOutOptions;
  reflexes?: ReflexOptions;
}

export interface RunOptions {
  signal?: AbortSignal;
  slipChance?: number;
  knowsRecipe?: (item: string) => boolean;
  progress?: (note: string) => void;
  /** Extra (generated) skills to resolve names against. */
  extraSkills?: readonly AnySkill[];
  /** `obtain` planning depth (§21.1). */
  planDepth?: number;
  /** Fighting ability with growth (§21.3). */
  combat?: number;
}

const MAX_PLACED = 4000;

export const DEFAULT_REFLEX_HOOKS: ReflexHooks = {
  caution: () => 0.5,
  shouldDefend: () => false,
  mayFightBack: () => true,
  quirks: () => [],
  deliberateFight: () => false,
  combat: () => 0.4,
  onDanger: () => undefined,
  onDangerCleared: () => undefined,
  onAttacked: () => undefined,
  isIdle: () => true,
};

export class Body {
  readonly chat: ChatOut;
  readonly reflexes: ReflexController;
  readonly rng: Random;
  /** Where this body first appeared: exploring stays within reach of it. */
  home: Vec3 | null = null;
  /** Blocks this body placed ("x,y,z", oldest first): someone breaking them is a deed against us (§6.3). */
  readonly placed = new Set<string>();
  private quirks: readonly Quirk[];
  private cachedMovements: Movements | null = null;

  private constructor(
    readonly bot: Bot,
    readonly logger: Logger,
    cfg: BodyConfig,
    hooks: ReflexHooks,
  ) {
    this.rng = cfg.rng ?? new SeededRandom(seedFromString(cfg.username));
    this.quirks = cfg.quirks ?? [];
    this.chat = new ChatOut(bot, { logger, ...cfg.chat });
    this.reflexes = new ReflexController(bot, { ...hooks, quirks: () => this.quirks }, logger, cfg.reflexes);
  }

  static async connect(cfg: BodyConfig, hooks: Partial<ReflexHooks> = {}): Promise<Body> {
    const bot = await connectBody(cfg);
    loadBodyPlugins(bot);
    const body = new Body(bot, cfg.logger, cfg, { ...DEFAULT_REFLEX_HOOKS, ...hooks });
    body.home = bot.entity.position.clone();
    // Every confirmed placement (skills and the pathfinder's scaffolding alike) comes through here.
    (bot as unknown as { on(ev: 'blockPlaced', f: (old: unknown, placed: { position: Vec3 }) => void): void }).on('blockPlaced', (_old, placed) => body.notePlaced(placed.position));
    // Placed somewhere far away (a respawn, an operator's teleport): that is where this body lives now.
    bot.on('forcedMove', () => {
      const p = bot.entity.position;
      if (!body.home || p.distanceTo(body.home) > 64) body.home = p.clone();
    });
    return body;
  }

  notePlaced(p: Vec3): void {
    const k = `${p.x},${p.y},${p.z}`;
    this.placed.delete(k);
    this.placed.add(k);
    if (this.placed.size > MAX_PLACED) {
      const oldest = this.placed.values().next().value;
      if (oldest !== undefined) this.placed.delete(oldest);
    }
  }

  setQuirks(quirks: readonly Quirk[]): void {
    this.quirks = quirks;
    this.cachedMovements = null;
  }

  movements(): Movements {
    this.cachedMovements ??= createMovements(this.bot, this.quirks);
    return this.cachedMovements;
  }

  /** A skill by name (built-in or one of `extra`), or null. */
  skill(name: string, extra: readonly AnySkill[] = []): AnySkill | null {
    return getSkill(name) ?? extra.find((s) => s.name === name) ?? null;
  }

  async say(text: string, volume: Volume = 'normal', listeners: readonly string[] = [], stillWanted?: () => boolean, urgent = false): Promise<boolean> {
    return (await this.chat.say(text, volume, listeners, stillWanted, urgent)).sent;
  }

  async run(skillName: string, args: unknown, opts: RunOptions = {}): Promise<SkillRunRecord> {
    const skill = getSkill(skillName) ?? opts.extraSkills?.find((s) => s.name === skillName) ?? null;
    if (!skill) {
      return {
        id: 'unknown',
        skill: skillName,
        args: (args ?? {}) as Record<string, unknown>,
        expected: 'a known skill',
        observed: 'did not start',
        ok: false,
        mismatch: false,
        aborted: false,
        error: `unknown skill ${skillName}`,
        slip: null,
        startedAt: Date.now(),
        durationMs: 0,
      };
    }
    return runSkill(skill, args, {
      bot: this.bot,
      logger: this.logger,
      rng: this.rng,
      signal: opts.signal ?? new AbortController().signal,
      movements: () => this.movements(),
      knowsRecipe: opts.knowsRecipe ?? (() => true),
      say: async (text, volume, urgent) => {
        await this.say(text, volume, [], undefined, urgent);
      },
      slipChance: opts.slipChance ?? 0,
      progress: opts.progress,
      planDepth: opts.planDepth,
      home: this.home,
      ...(opts.combat !== undefined ? { combat: opts.combat } : {}),
    });
  }

  async disconnect(reason = 'bye'): Promise<void> {
    this.reflexes.stop();
    await disconnectBody(this.bot, reason);
  }
}
