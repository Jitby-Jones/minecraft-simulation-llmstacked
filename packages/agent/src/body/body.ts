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
import type { AnySkill, DesignAsk, ProjectBook, SkillContext, SkillResult } from './skills/types';
import { releaseStuckDig } from './skills/util';

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
  /** Whom we are in a conversation with just now, if anyone. */
  talkingWith?: () => string | null;
  /** Someone just seen attacking another, if anyone. */
  fightNearby?: () => string | null;
  /** Who should make a chest when there is none: null for us, else the builder to ask. */
  chestMaker?: () => string | null;
  /** The buildings we have begun. */
  projects?: ProjectBook;
  /** The architect, for the `design` skill. */
  architect?: (ask: DesignAsk) => Promise<SkillResult>;
  /** Makes a place home, for the `settle` skill. */
  setHome?: (pos: Vec3) => void;
  /** Portals known, for the expedition skills. */
  portals?: SkillContext['portals'];
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
  /** The world home is in (overworld, the_nether, the_end). */
  homeWorld = 'overworld';
  /** Blocks this body placed ("x,y,z", oldest first): someone breaking them is a deed against us (§6.3). */
  readonly placed = new Set<string>();
  /** Died: it does nothing more (owner request, 2026-10-24). */
  dead = false;
  private quirks: readonly Quirk[];
  private cachedMovements: Movements | null = null;
  private cachedRun: Movements | null = null;

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
    // Placed somewhere far away (a respawn, an operator's teleport): that is where this body lives now. Not through a
    // portal: home stays in its own world, and the way back is the portal (owner request, 2026-10-24).
    body.homeWorld = String(bot.game.dimension ?? 'overworld');
    bot.on('forcedMove', () => {
      const p = bot.entity.position;
      if (String(bot.game.dimension ?? 'overworld') !== body.homeWorld) return;
      if (!body.home || p.distanceTo(body.home) > 64) body.home = p.clone();
    });
    // The pathfinder left "digging" a block whose dig will never settle stops walking for good (util.ts
    // releaseStuckDig): seen so for six seconds with no dig going on, it is let go.
    let stuckFor = 0;
    const watch = setInterval(() => {
      if (!bot.pathfinder?.isMining() || bot.targetDigBlock) {
        stuckFor = 0;
        return;
      }
      if (++stuckFor < 3) return;
      stuckFor = 0;
      if (releaseStuckDig(bot)) cfg.logger.info({ module: 'body' }, 'the pathfinder was stuck on a dig that never ended; let go');
    }, 2000);
    watch.unref();
    bot.once('end', () => clearInterval(watch));
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
    this.cachedRun = null;
  }

  /** A walk, or with `sprint` a run (running away: sprinting costs food). */
  movements(sprint = false): Movements {
    if (sprint) return (this.cachedRun ??= createMovements(this.bot, this.quirks, { sprint: true }));
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

  /**
   * A death ends everything at once (owner request, 2026-10-24): walking, digging, fighting, using an item and the
   * reflexes stop, and nothing more is said. The body is left where it fell; it never respawns (`respawn: false`).
   */
  halt(): void {
    if (this.dead) return;
    this.dead = true;
    this.chat.silence();
    this.reflexes.stop();
    const b = this.bot as Bot & { pathfinder?: { setGoal(g: null): void; stop(): void }; pvp?: { stop(): void } };
    for (const stop of [() => b.pathfinder?.setGoal(null), () => b.pathfinder?.stop(), () => b.pvp?.stop(), () => b.clearControlStates(), () => b.stopDigging(), () => b.deactivateItem()]) {
      try {
        stop();
      } catch {
        // already still
      }
    }
  }

  async run(skillName: string, args: unknown, opts: RunOptions = {}): Promise<SkillRunRecord> {
    const skill = this.dead ? null : (getSkill(skillName) ?? opts.extraSkills?.find((s) => s.name === skillName) ?? null);
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
        error: this.dead ? 'dead' : `unknown skill ${skillName}`,
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
      movements: (sprint?: boolean) => this.movements(sprint),
      knowsRecipe: opts.knowsRecipe ?? (() => true),
      say: async (text, volume, urgent) => {
        await this.say(text, volume, [], undefined, urgent);
      },
      slipChance: opts.slipChance ?? 0,
      progress: opts.progress,
      planDepth: opts.planDepth,
      // In another world (through a portal) home is far off in its own; the way back is the portal.
      home: String(this.bot.game.dimension ?? 'overworld') === this.homeWorld ? this.home : null,
      ...(opts.combat !== undefined ? { combat: opts.combat } : {}),
      ...(opts.talkingWith ? { talkingWith: opts.talkingWith } : {}),
      ...(opts.fightNearby ? { fightNearby: opts.fightNearby } : {}),
      ...(opts.chestMaker ? { chestMaker: opts.chestMaker } : {}),
      ...(opts.projects ? { projects: opts.projects } : {}),
      ...(opts.architect ? { architect: opts.architect } : {}),
      ...(opts.setHome ? { setHome: opts.setHome } : {}),
      ...(opts.portals ? { portals: opts.portals } : {}),
    });
  }

  async disconnect(reason = 'bye'): Promise<void> {
    this.reflexes.stop();
    await disconnectBody(this.bot, reason);
  }
}
