// Putting things off (owner request, 2026-10-24: a player who can't do something now "would think over different
// options or give up if it's impossible"). One of the options is to wait for a better moment: "get wool once I see
// sheep", "go mining when it's day", "try again in ten minutes". The mind puts it off with a cue; this watches for the
// cue (what the agent sees, what it carries, the time of day, the minutes gone by) and, when it comes, reminds the mind
// of what it meant to do, as remembering does. What to do then is the mind's own call.

import type { AgentState, Deferred, Logger } from '@agora/shared';
import type { AgentBus } from '../bus';
import { evalCondition } from '../modules/conditions';
import type { AgentStateStore } from '../state/store';

/** How long a cue is waited for at most: a thing put off is forgotten after this. */
export const FORGET_MS = 90 * 60_000;
const CHECK_MS = 3000;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/^(a|an|the|some)\s+/, '').replace(/\s+/g, '_');
}

/**
 * A cue as written ("see:sheep", "have:shears", "day", "minutes:10"), checked and normalised; null if it isn't one.
 * With `isDay`, day put off by day (and night by night) waits for the other first: at dusk, one agent's "shear the
 * sheep when it's day" came at once, it being day still, and took it off the hut it was putting up for the night.
 */
export function cueFrom(when: string, now: number, isDay?: boolean): { cue: string; due?: number; after?: 'day' | 'night' } | null {
  const w = when.trim().toLowerCase();
  if (w === 'day' || w === 'morning' || w === 'daytime') return { cue: 'day', ...(isDay === true ? { after: 'night' as const } : {}) };
  if (w === 'night' || w === 'dark' || w === 'nighttime') return { cue: 'night', ...(isDay === false ? { after: 'day' as const } : {}) };
  const m = /^minutes?\s*:\s*(\d{1,3})$/.exec(w);
  if (m?.[1]) {
    const n = Math.max(1, Math.min(120, Number(m[1])));
    return { cue: `minutes:${n}`, due: now + n * 60_000 };
  }
  const see = /^see\s*:\s*(.{2,40})$/.exec(w);
  if (see?.[1]) return { cue: `see:${norm(see[1])}` };
  const have = /^have\s*:\s*([a-z0-9_ ]{2,40}?)\s*(?:>=\s*(\d{1,4}))?$/.exec(w);
  if (have?.[1]) return { cue: `have:${norm(have[1])}${have[2] ? `>=${have[2]}` : ''}` };
  return null;
}

/** "sheep" matches sheep, "white_wool" a white_wool block or item, "cows" a cow. */
function names(thing: string): string[] {
  const t = norm(thing);
  return [...new Set([t, t.replace(/s$/, ''), t.replace(/es$/, '')])].filter((x) => x.length >= 2);
}

/** Whether the cue has come, and how it shows; null while it hasn't. */
export function cueCame(d: Deferred, s: AgentState, now: number): string | null {
  if (d.cue === 'day') return s.self.isDay && !d.after ? 'it is day' : null;
  if (d.cue === 'night') return !s.self.isDay && !d.after ? 'it is night' : null;
  if (d.cue.startsWith('minutes:')) return d.due !== undefined && now >= d.due ? `${d.cue.slice(8)} minutes have gone by` : null;
  if (d.cue.startsWith('see:')) {
    const want = names(d.cue.slice(4));
    const hit = (n: string) => want.some((w) => n === w || n.endsWith(`_${w}`) || n.startsWith(`${w}_`));
    const c = s.scene.creatures.find((x) => hit(x.name.toLowerCase()) && x.visible);
    if (c) return `there is ${c.kind === 'player' ? c.name : `a ${c.name.replace(/_/g, ' ')}`} ${Math.round(c.distance)} m ${c.bearing}`;
    const f = s.scene.features.find((x) => Object.keys(x.blocks).some(hit));
    if (f) return `you can see ${f.what} ${f.distance} m ${f.bearing}`;
    return null;
  }
  if (d.cue.startsWith('have:')) {
    const [item, n] = d.cue.slice(5).split('>=');
    return evalCondition(`inventoryHas:${item}>=${n ?? 1}`, s) === true ? `you have ${n ?? 'some'} ${item}` : null;
  }
  return null;
}

/** Watches for the cues of what the agent put off. */
export class LaterWatch {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly o: { store: AgentStateStore; bus: AgentBus; logger: Logger; now?: () => number; checkMs?: number },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.o.checkMs ?? CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look: the cues that came are reminded of (and done with); what waited too long is forgotten. */
  check(): void {
    const s = this.o.store.state;
    const later = s.mind.later;
    if (later.length === 0 || s.flags.paused) return;
    const now = (this.o.now ?? Date.now)();
    const came: { d: Deferred; why: string }[] = [];
    const keep: Deferred[] = [];
    let passed = false;
    for (const d0 of later) {
      // The night (or day) it waited for has come: from now on, the day (or night) is the one meant.
      const turned = d0.after !== undefined && (d0.after === 'night' ? !s.self.isDay : s.self.isDay);
      const d: Deferred = turned ? { id: d0.id, what: d0.what, cue: d0.cue, since: d0.since, ...(d0.due !== undefined ? { due: d0.due } : {}) } : d0;
      passed ||= turned;
      const why = cueCame(d, s, now);
      if (why) came.push({ d, why });
      else if (now - d.since < FORGET_MS) keep.push(d);
    }
    if (came.length === 0 && keep.length === later.length && !passed) return;
    this.o.store.update('mind', (m) => ({ ...m, later: keep }), 'a cue came');
    for (const c of came) {
      this.o.logger.info({ module: 'later', what: c.d.what, cue: c.d.cue, why: c.why }, 'cue came');
      this.o.bus.emit({ type: 'cue', deferred: c.d, why: c.why });
    }
  }
}
