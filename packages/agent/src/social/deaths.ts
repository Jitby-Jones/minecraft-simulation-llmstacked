// Making death matter to the living (§16.3). Death notices are public; each one becomes a note on the agent's mind
// (and so a memory). Caution rises by 0.1 per death, more if it happened nearby or the cause is known, and falls
// back toward the baseline over hours. Someone the agent cared about dying brings grief, someone it hated relief.
// Seeing the body fall teaches where and how.

import type { AgentName, Logger, Persona, SocialProfile, SystemEvent } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';

export interface DeathReaction {
  cautionDelta: number;
  note: string;
  salience: number;
  /** -1 relief … 1 grief, by how the agent felt about the dead. */
  grief: number;
}

/** What a death notice does to this agent (pure, for tests and the dashboard). */
export function reactToDeath(ev: SystemEvent, me: AgentName, profile: SocialProfile | undefined, persona: Persona, sawIt: boolean): DeathReaction | null {
  if (ev.kind !== 'death' || !ev.subject || ev.subject === me) return null;
  const who = ev.subject;
  const cause = ev.killer ? `killed by ${ev.killer}` : (ev.cause ?? ev.text.replace(who, '').trim());
  const known = Boolean(ev.killer || ev.cause);
  const cautionDelta = Math.min(0.3, 0.1 + (sawIt ? 0.1 : 0) + (known ? 0.05 : 0)) * (0.6 + 0.8 * persona.big5.neuroticism * 0.5);
  const s = profile?.sentiment ?? persona.social.baselineSentiment;
  const grief = profile ? Math.max(-1, Math.min(1, (s - 5) / 4)) : 0;
  const feeling = grief > 0.4 ? 'I will miss them' : grief < -0.4 ? 'I can’t say I’m sorry' : '';
  const note = `${who} died${cause ? ` (${cause})` : ''}${sawIt ? '; I saw it happen' : ''}. Death is permanent.${feeling ? ` ${feeling}.` : ''}`;
  return { cautionDelta, note, salience: 0.65 + 0.25 * Math.abs(grief) + (sawIt ? 0.1 : 0), grief };
}

export interface DeathWatchOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** Did we see the body fall (entityDead in sight)? */
  sawDeath: (name: AgentName, withinMs: number) => boolean;
  now?: () => number;
}

/** Caution falls back toward the baseline by this much per hour. */
const CAUTION_RECOVERY_PER_HOUR = 0.05;

export class DeathWatch {
  private readonly offs: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly o: DeathWatchOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('systemEvent', (e) => this.onEvent(e.event)));
    this.timer = setInterval(() => this.recover(60_000), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  private onEvent(ev: SystemEvent): void {
    const s = this.o.store.state;
    const subject = ev.subject;
    if (!subject) return;
    const saw = this.o.sawDeath(subject, 5000);
    const r = reactToDeath(ev, this.o.me, s.social[subject], s.self.persona, saw);
    if (!r) return;
    this.o.store.update('drives', (d) => ({ ...d, caution: Math.min(1, d.caution + r.cautionDelta) }), `caution after ${subject} died`);
    pushWorkmem(this.o.store, r.note, r.salience, 'self_observed', { aboutAgent: subject, now: this.now() });
    this.o.bus.emit({ type: 'peerDied', name: subject, cause: ev.killer ? `killed by ${ev.killer}` : (ev.cause ?? ev.text), witnessed: saw, grief: r.grief, ...(ev.killer ? { killer: ev.killer } : {}) });
    this.o.logger.info({ module: 'deaths', who: subject, cause: ev.killer ?? ev.cause, caution: this.o.store.state.drives.caution }, 'a peer died');
  }

  /** §16.3: the fear fades slowly back to the agent's own baseline (plus any extinction-brake shift). */
  private recover(dtMs: number): void {
    const d = this.o.store.state.drives;
    const floor = Math.min(1, d.cautionBaseline + (this.now() < d.brakeUntil ? d.brakeShift : 0));
    if (d.caution <= floor) return;
    const next = Math.max(floor, d.caution - (CAUTION_RECOVERY_PER_HOUR * dtMs) / 3_600_000);
    this.o.store.update('drives', (x) => ({ ...x, caution: next }), 'caution recovers');
  }
}
