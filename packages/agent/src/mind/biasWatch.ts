// The biases of §18.4 that act on events, in code. Availability: a recent, vivid death makes its cause loom
// larger (fear of creepers after a creeper death, so one flees sooner). Self-serving: our own failures were bad luck
// or someone else's fault. Scapegoating: misfortune with no known cause, while afraid, is pinned on someone we
// already dislike. Each is scaled by the agent's own susceptibility and weakened by the override (§18.5). They move
// the gut only (sentiment), never the facts (evidence).

import type { AgentName, Logger } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';

export interface BiasWatchOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  override: () => number;
  /** A gut-only change in how we feel about someone (Social Awareness). */
  nudge: (name: AgentName, delta: number, note: string) => void;
  rng?: () => number;
  now?: () => number;
}

const VIVID_MS = 30 * 60_000;

/** "was slain by Zombie" → zombie, "blew up" → creeper, "tried to swim in lava" → lava. */
export function causeOf(text: string): string | null {
  const t = text.toLowerCase();
  if (/blew up|creeper/.test(t)) return 'creeper';
  if (/lava/.test(t)) return 'lava';
  if (/fell|hit the ground/.test(t)) return 'fall';
  if (/drown/.test(t)) return 'water';
  const m = /\bby ([a-z_]+)\b/.exec(t);
  return m?.[1] ?? null;
}

export class BiasWatch {
  private readonly vivid = new Map<string, number>();
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(private readonly o: BiasWatchOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
  }

  start(): void {
    this.offs.push(this.o.bus.on('peerDied', (e) => this.onDeath(e.name, e.cause, Boolean(e.killer))));
    this.offs.push(this.o.bus.on('stuck', () => this.onFailure()));
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private bias(name: 'availability' | 'selfServing' | 'scapegoat'): number {
    return this.o.store.state.self.persona.mind.biasProfile[name] * (1 - this.o.override());
  }

  /** §18.4 availability: extra health points of fear toward a cause someone died of lately (flee sooner). */
  fearBoost(source: string): number {
    const at = this.vivid.get(source.toLowerCase());
    if (at === undefined) return 0;
    const age = this.now() - at;
    if (age > VIVID_MS) return 0;
    return 4 * this.bias('availability') * (1 - age / VIVID_MS);
  }

  private onDeath(name: AgentName, cause: string, hasKiller: boolean): void {
    const c = causeOf(cause);
    if (c) this.vivid.set(c, this.now());
    const s = this.o.store.state;
    // Scapegoat: no known killer, we're afraid, and there is someone we already dislike.
    if (hasKiller || s.emotions.fear < 0.4 || this.rng() >= this.bias('scapegoat')) return;
    const goat = Object.values(s.social)
      .filter((p) => p.name !== name && p.name !== this.o.me && p.sentiment < 4)
      .sort((a, b) => a.sentiment - b.sentiment)[0];
    if (!goat) return;
    this.o.nudge(goat.name, -0.5, `I bet ${goat.name} had something to do with ${name}'s death`);
    this.o.logger.info({ module: 'bias', bias: 'scapegoat', target: goat.name, death: name }, 'blamed someone');
  }

  /** Self-serving: it was bad luck, or someone got in the way. */
  private onFailure(): void {
    const s = this.o.store.state;
    if (this.rng() >= this.bias('selfServing')) return;
    const near = new Set(s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.distance <= 8).map((e) => e.name));
    const blamed = Object.values(s.social).find((p) => near.has(p.name) && p.sentiment < 5);
    if (blamed) this.o.nudge(blamed.name, -0.3, `${blamed.name} kept getting in my way`);
    else pushWorkmem(this.o.store, 'that was just bad luck', 0.3, 'self_observed', { now: this.now() });
  }
}
