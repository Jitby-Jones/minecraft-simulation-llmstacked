// Code quirks (§7): consistent, visible and free (no tokens). pathCost and reflexBias live in the body; this runs the
// behavioral ones: idleEmote (a line every so often when someone can hear), distraction (seeing a sheep, a chance to
// wander over), autoCollect (can't walk past a poppy: the item lying on the ground, or a block that is the item, in
// sight). Distractions and pick-ups are impulses: they briefly take over, and the CC resumes the plan when they end.
// tradeBias applies in trades (M6).

import type { Logger, Quirk } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { Body } from '../body/body';
import { findKnownBlocks } from '../body/sightings';
import { blockIdsNamed, lookAway } from '../body/world';
import { itemMatcher } from '../body/items';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import type { CognitiveController } from './cc';
import type { SkillExecutor } from './executor';
import { isOff } from '../state/switches';

export interface QuirkRunnerOptions {
  store: AgentStateStore;
  bus: AgentBus;
  body: Body;
  cc: CognitiveController;
  executor: SkillExecutor;
  logger: Logger;
  quirks: readonly Quirk[];
  /** People within earshot (an emote nobody hears is pointless). */
  peopleInRange: () => string[];
  rng?: () => number;
  now?: () => number;
}

export class QuirkRunner {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastEmote = new Map<number, number>();
  private readonly rolled = new Set<number>();
  private readonly collectedAt = new Map<string, number>();
  private lastDistraction = 0;
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(private readonly o: QuirkRunnerOptions) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.o.quirks.length === 0 || this.timer) return;
    const t0 = this.now();
    this.o.quirks.forEach((_, i) => this.lastEmote.set(i, t0));
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.o.logger.warn({ module: 'quirks', err: String(err) }, 'quirk tick failed');
      }
    }, 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Free to be pulled away: not in danger and not in the middle of something that can't be talked over. */
  private interruptible(): boolean {
    const s = this.o.store.state;
    return !s.flags.inDanger && (!this.o.executor.busy || this.o.executor.talkOverable()) && s.option?.option !== 'talk';
  }

  private tick(): void {
    const s = this.o.store.state;
    if (isOff(s, 'impulses')) return;
    const now = this.now();
    this.o.quirks.forEach((q, i) => {
      switch (q.hook) {
        case 'idleEmote': {
          // "Idle" socially: not in a conversation and not busy with something that can't be talked over (humming
          // while chopping wood is fine).
          const due = (this.lastEmote.get(i) ?? now) + q.everySec * 1000 * (0.8 + 0.4 * this.rng());
          const chatting = Object.values(s.conversations).some((c) => c.status === 'active');
          if (now < due || chatting || !this.interruptible() || this.o.peopleInRange().length === 0) return;
          this.lastEmote.set(i, now);
          const line = q.say[Math.floor(this.rng() * q.say.length)];
          if (line) void this.o.body.say(line).catch(() => undefined);
          return;
        }
        case 'distraction': {
          if (now - this.lastDistraction < 60_000 || !this.interruptible()) return;
          const seen = s.perception.nearbyEntities.find((e) => e.visible && e.distance <= 12 && q.onSee.includes(e.name) && !lookAway(e) && !this.rolled.has(e.id));
          if (!seen) return;
          this.rolled.add(seen.id);
          if (this.rng() >= q.chance) return;
          this.lastDistraction = now;
          pushWorkmem(this.o.store, `got distracted by a ${seen.name}`, 0.3, 'self_observed', { now });
          if (q.action === 'look') {
            void this.o.body.bot.lookAt(this.o.body.bot.entity.position.offset(seen.pos.x - s.self.pos.x, seen.pos.y - s.self.pos.y + 1, seen.pos.z - s.self.pos.z)).catch(() => undefined);
            return;
          }
          this.o.cc.impulse({
            option: 'move',
            target: { pos: { x: seen.pos.x, y: seen.pos.y, z: seen.pos.z } },
            terminate: { maxSeconds: q.action === 'follow' ? 30 : 15 },
            rationale: `got distracted by a ${seen.name}`,
          });
          return;
        }
        case 'autoCollect': {
          if (!this.interruptible()) return;
          for (const item of q.items) {
            if (now - (this.collectedAt.get(item) ?? 0) < 60_000) continue;
            const m = itemMatcher(item);
            const dropped = s.perception.nearbyEntities.some((e) => e.kind === 'item' && e.visible && e.distance <= 8 && m.matches(e.name));
            const bot = this.o.body.bot;
            const block = dropped
              ? undefined
              : findKnownBlocks(bot, blockIdsNamed(bot, item), 8, 1)[0];
            if (!dropped && !block) continue;
            this.collectedAt.set(item, now);
            this.o.cc.impulse({
              option: 'work',
              task: dropped ? { skill: 'pickup', args: { item, radius: 10 } } : { skill: 'gather', args: { item, qty: 1, maxDistance: 10 } },
              terminate: { maxSeconds: 25 },
              rationale: `couldn't resist the ${item}`,
            });
            return;
          }
          return;
        }
        case 'pathCost':
        case 'reflexBias':
        case 'tradeBias':
          return;
      }
    });
    if (this.rolled.size > 500) this.rolled.clear();
  }
}
