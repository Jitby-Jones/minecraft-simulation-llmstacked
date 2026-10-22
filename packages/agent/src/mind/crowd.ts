// Mob mentality (§18.4.2). A crowd is three or more people within 16 blocks turning on the same person: hostile
// talk about them (heard opinions at −0.6 or worse) in the last two minutes, our own anger counting too. Inside one,
// reason is suppressed (the override's crowdSuppression) and anger spreads faster. An onlooker either joins in or,
// if reason wins and what they have actually seen says the target did nothing wrong, objects out loud.

import { type AgentName, type HeardOpinion, type Logger, type Utterance } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import { readOpinions } from '../social/opinions';

export interface CrowdOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** Anger toward someone, 0..1 (Feelings). */
  angerToward: (name: AgentName) => number;
  /** The override factor (Mind), and the gut/facts mix about someone (0..10). */
  override: () => number;
  liking: (name: AgentName) => number;
  /** Says a line to someone at once (Talking.blurt). */
  say: (to: AgentName, text: string) => Promise<boolean>;
  now?: () => number;
}

const WINDOW_MS = 2 * 60_000;
const SPEAK_EVERY_MS = 2 * 60_000;

export class Crowd {
  /** Hostile talk heard: target → speaker → when. */
  private readonly hostile = new Map<AgentName, Map<AgentName, number>>();
  private readonly spokeAt = new Map<AgentName, number>();
  private joined: { target: AgentName; at: number } | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: CrowdOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('heard', (e) => this.onHeard(e.utterance)));
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** People turning on `target` within earshot recently (not counting us). */
  against(target: AgentName): AgentName[] {
    const t = this.now();
    const near = new Set(this.o.store.state.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.distance <= 16).map((e) => e.name));
    return [...(this.hostile.get(target) ?? new Map<AgentName, number>())].filter(([who, at]) => t - at < WINDOW_MS && near.has(who)).map(([who]) => who);
  }

  /** §18.4.2: three or more (us included, if we're angry too) against one person. */
  isMob(target: AgentName): boolean {
    const others = this.against(target).length;
    return others + (this.o.angerToward(target) >= 0.5 ? 1 : 0) >= 3;
  }

  /** We are part of a mob right now (reason suppressed, §18.5). */
  inMob(): boolean {
    return this.joined !== null && this.now() - this.joined.at < WINDOW_MS && this.isMob(this.joined.target);
  }

  private onHeard(u: Utterance): void {
    if (u.from === this.o.me) return;
    const s = this.o.store.state;
    const known = [...new Set([...Object.keys(s.social), ...s.perception.nearbyEntities.filter((e) => e.kind === 'player').map((e) => e.name)])];
    const said: HeardOpinion[] = readOpinions(u.text, u.from, known, this.now());
    for (const op of said) {
      if (op.valence > -0.6 || op.target === this.o.me) continue;
      const m = this.hostile.get(op.target) ?? new Map<AgentName, number>();
      this.hostile.set(op.target, m);
      m.set(u.from, this.now());
      void this.react(op.target, u.from);
    }
  }

  /** A crowd forming against someone: join in, or (reason winning, the facts on their side) speak up for them. */
  private async react(target: AgentName, speaker: AgentName): Promise<void> {
    const t = this.now();
    if (this.against(target).length < 2 || t - (this.spokeAt.get(target) ?? -Infinity) < SPEAK_EVERY_MS) return;
    const s = this.o.store.state;
    const evidence = s.social[target]?.evidence ?? s.self.persona.social.baselineSentiment;
    const reason = this.o.override();
    if (reason >= 0.45 && evidence >= 6) {
      this.spokeAt.set(target, t);
      await this.o.say(speaker, `hold on, ${target} has always been fair with me.`);
      pushWorkmem(this.o.store, `People were turning on ${target}; I stood up for them`, 0.6, 'self_observed', { aboutAgent: target, now: t });
      this.o.logger.info({ module: 'crowd', target, stance: 'objected' }, 'crowd');
      return;
    }
    if (this.o.liking(target) < 4.5) {
      this.spokeAt.set(target, t);
      this.joined = { target, at: t };
      await this.o.say(speaker, `yeah, ${target} is no good!`);
      pushWorkmem(this.o.store, `Everyone is against ${target}, and so am I`, 0.6, 'self_observed', { aboutAgent: target, now: t });
      this.o.logger.info({ module: 'crowd', target, stance: 'joined' }, 'crowd');
    }
  }
}
