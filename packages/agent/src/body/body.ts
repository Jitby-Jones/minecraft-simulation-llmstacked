// The Body: one mineflayer client plus plugins, quirk-aware movements, rate-limited chat, L0 reflexes and the
// verified skill runner. Modules above it never touch mineflayer directly except through perception.

import { type Logger, type Quirk, type Random, type Volume, SeededRandom, seedFromString } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
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
}

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
    return body;
  }

  setQuirks(quirks: readonly Quirk[]): void {
    this.quirks = quirks;
    this.cachedMovements = null;
  }

  movements(): Movements {
    this.cachedMovements ??= createMovements(this.bot, this.quirks);
    return this.cachedMovements;
  }

  async say(text: string, volume: Volume = 'normal', listeners: readonly string[] = []): Promise<void> {
    await this.chat.say(text, volume, listeners);
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
      say: (text, volume) => this.say(text, volume),
      slipChance: opts.slipChance ?? 0,
      progress: opts.progress,
    });
  }

  async disconnect(reason = 'bye'): Promise<void> {
    this.reflexes.stop();
    await disconnectBody(this.bot, reason);
  }
}
