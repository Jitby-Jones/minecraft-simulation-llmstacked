// First impressions and admiration (§18.3). On first sight a person is judged by what shows: their gear; once
// they talk, how they come across. Vain people weigh this more, the halo-prone most, and it counts double (the first
// of the two anchoring interactions). Better gear than ours stirs envy in the envious. When someone we admire
// wrongs us or a friend, admiration may crash (a rational fan is likelier to see it) and leaves a resentful ex-fan.

import type { AgentName, Logger, Persona, SocialProfile } from '@agora/shared';
import type { AgentBus } from '../bus';
import { gearScore } from '../body/items';
import type { AgentStateStore } from '../state/store';
import { newSocialProfile } from '../state/social';
import { pushWorkmem } from '../state/workmem';
import { withSentiment } from './math';
import { rationalityOf } from '../mind/biases';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * §18.3: what gear alone does to a first impression, weighted by vanity and the halo bias. Everyone starts with
 * nothing, so bare hands are neutral and only gear impresses.
 */
export function firstImpression(gear: number, persona: Persona): { sentimentDelta: number; admiration: number } {
  const k = persona.mind.vanity * (0.5 + persona.mind.biasProfile.halo * 0.5);
  return { sentimentDelta: gear * 2 * k, admiration: clamp01(gear * k * 1.2) };
}

const FUNNY = /\b(haha+|lol|lmao|hehe|joke|kidding)\b/i;
const CONFIDENT = /!\s*$|\b(i'?m the best|easy|no problem|watch this|leave it to me|follow me)\b/i;

/** How someone comes across in their first lines: funny and confident people charm the vain a little. */
export function styleImpression(lines: readonly string[], persona: Persona): { sentimentDelta: number; admiration: number } {
  const funny = lines.some((l) => FUNNY.test(l));
  const confident = lines.some((l) => CONFIDENT.test(l));
  const cue = (funny ? 0.5 : 0) + (confident ? 0.4 : 0);
  const k = persona.mind.vanity * (0.5 + persona.mind.biasProfile.halo * 0.5);
  return { sentimentDelta: cue * k, admiration: cue * k * 0.3 };
}

export interface ImpressionsOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** Our own visible gear, 0..1. */
  myGear: () => number;
  rng?: () => number;
  now?: () => number;
}

const ENVY_EVERY_MS = 5 * 60_000;

export class Impressions {
  /** People already judged at first sight (everyone known when we start counts). */
  private readonly formed = new Set<AgentName>();
  private readonly firstLines = new Map<AgentName, string[]>();
  private readonly envied = new Map<AgentName, number>();
  private readonly offs: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(private readonly o: ImpressionsOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
  }

  start(): void {
    for (const name of Object.keys(this.o.store.state.social)) this.formed.add(name);
    this.timer = setInterval(() => this.look(), 1000);
    this.timer.unref();
    this.offs.push(this.o.bus.on('heard', (e) => this.onFirstLines(e.utterance.from, e.utterance.text)));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** A wrong done by someone: an idol's fall (§18.3 disillusionment). */
  wronged(by: AgentName, what: string): void {
    const s = this.o.store.state;
    const p = s.social[by];
    if (!p || p.admiration < 0.5) return;
    if (this.rng() >= rationalityOf(s)) return;
    const fallen = withSentiment({ ...p, admiration: p.admiration * 0.3 }, -1.5, s.self.persona, this.now());
    this.write(fallen, 'disillusioned');
    pushWorkmem(this.o.store, `I used to look up to ${by}, but ${what}`, 0.75, 'self_observed', { aboutAgent: by, now: this.now() });
  }

  private profile(name: AgentName): SocialProfile {
    const s = this.o.store.state;
    return s.social[name] ?? newSocialProfile(name, s.self.persona, this.now());
  }

  private write(p: SocialProfile, reason: string): void {
    this.o.store.update('social', (all) => ({ ...all, [p.name]: p }), reason);
  }

  private look(): void {
    const s = this.o.store.state;
    const persona = s.self.persona;
    for (const e of s.perception.nearbyEntities) {
      if (e.kind !== 'player' || !e.visible || e.name === this.o.me) continue;
      const gear = gearScore(e.armor, e.heldItem);
      const p = this.profile(e.name);
      if (!this.formed.has(e.name)) {
        this.formed.add(e.name);
        const imp = firstImpression(gear, persona);
        const next = withSentiment({ ...p, gearScore: gear, admiration: Math.max(p.admiration, imp.admiration) }, imp.sentimentDelta, persona, this.now());
        this.write(next, `first impression of ${e.name}`);
        this.o.logger.info({ module: 'impressions', who: e.name, gear: Number(gear.toFixed(2)), sentiment: Number(next.sentiment.toFixed(2)), admiration: Number(next.admiration.toFixed(2)) }, 'first impression');
        continue;
      }
      if (Math.abs(gear - p.gearScore) >= 0.05) this.write({ ...p, gearScore: gear }, `${e.name}'s gear`);
      // Envy (§18.4): visibly better gear than ours, now and then.
      const gap = gear - this.o.myGear();
      if (gap > 0.3 && this.now() - (this.envied.get(e.name) ?? -Infinity) > ENVY_EVERY_MS) {
        this.envied.set(e.name, this.now());
        const d = 0.25 * persona.mind.biasProfile.envy * (1 - persona.big5.agreeableness) * (gap / 0.7);
        if (d > 0.02) this.o.store.update('emotions', (x) => ({ ...x, envy: Math.min(1, x.envy + d) }), `envy of ${e.name}`);
      }
    }
  }

  private onFirstLines(from: AgentName, text: string): void {
    if (from === this.o.me) return;
    const seen = this.firstLines.get(from);
    if (seen === undefined) {
      // Only people we are meeting now: their first two lines count.
      if (this.formed.has(from) && (this.o.store.state.social[from]?.interactions ?? 0) > 1) return;
      this.firstLines.set(from, [text]);
      return;
    }
    if (seen.length >= 2) return;
    seen.push(text);
    const s = this.o.store.state;
    const imp = styleImpression(seen, s.self.persona);
    if (imp.sentimentDelta <= 0) return;
    const p = this.profile(from);
    this.write({ ...withSentiment(p, imp.sentimentDelta, s.self.persona, this.now()), admiration: clamp01(p.admiration + imp.admiration) }, `how ${from} comes across`);
  }
}
