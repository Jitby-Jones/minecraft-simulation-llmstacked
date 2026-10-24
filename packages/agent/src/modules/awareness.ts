// Action Awareness (§4.2 module 4, §4.6 hallucination guard #1): compares what each skill expected with what was
// observed. The same skill failing with the same arguments three times marks the agent stuck on it and puts "I keep
// failing to X because Y" on its mind; the CC must then pick something else (Sid's Oak Log Crafting Syndrome).

import type { ActionRecord, Logger } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';

export interface AwarenessOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  now?: () => number;
  /** Failures within this window count toward "stuck". */
  windowMs?: number;
  /** How long a stuck mark lasts without a success. */
  stuckForMs?: number;
}

export function taskKey(skill: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join(',');
  return `${skill}(${sorted})`;
}

/** Skills whose failures can still be partial progress (they collect things). */
const GATHERING = new Set(['obtain', 'gather', 'mine', 'craft', 'smelt', 'pickup', 'withdraw']);

function describe(r: ActionRecord): string {
  const args = Object.entries(r.args)
    .map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return args ? `${r.skill} (${args})` : r.skill;
}

export class ActionAwareness {
  /** Failure times and weights per task: a failure that still gained something counts half. */
  private readonly fails = new Map<string, { t: number; w: number }[]>();
  private readonly stuckUntil = new Map<string, { until: number; why: string }>();
  private readonly now: () => number;
  private off: (() => void) | null = null;

  constructor(private readonly o: AwarenessOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.off = this.o.bus.on('actionRecorded', (e) => this.onRecord(e.record));
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  isStuckOn(skill: string, args: Record<string, unknown>): boolean {
    const s = this.stuckUntil.get(taskKey(skill, args));
    if (s && s.until > this.now()) return true;
    // Given up on: that skill for that thing, whatever the other arguments.
    const item = typeof args.item === 'string' ? args.item : null;
    const g = this.givenUp.get(`${skill}:${item ?? ''}`) ?? this.givenUp.get(`${skill}:`);
    return Boolean(g && g.until > this.now());
  }

  /** "gather (item oak_log, qty 4): no oak_log within 48 blocks" for each live stuck mark. */
  stuckList(): string[] {
    const t = this.now();
    return [
      ...[...this.stuckUntil.entries()].filter(([, s]) => s.until > t).map(([k, s]) => `${k}: ${s.why}`),
      ...[...this.givenUp.entries()].filter(([, s]) => s.until > t).map(([k, s]) => `${k.replace(/:$/, '').replace(':', ' ')} (any way): ${s.why}`),
    ];
  }

  /** Tasks given up on, by skill and the thing they were for (`skill:item`, or `skill:` for the skill itself). */
  private readonly givenUp = new Map<string, { until: number; why: string }>();

  /**
   * Gives up on a task for `ms` (it failed over and over, in one way after another): that skill for that item (or,
   * with no item, the skill itself) counts as stuck whatever its other arguments. A success with it lifts the mark.
   */
  giveUp(skill: string, item: string | null, why: string, ms: number): void {
    this.givenUp.set(`${skill}:${item ?? ''}`, { until: this.now() + ms, why });
    this.o.store.update('flags', (f) => (f.stuck ? f : { ...f, stuck: true }), 'gave up');
    this.o.logger.info({ module: 'awareness', skill, item, why }, 'gave up');
  }

  private readonly instant = new Map<string, number[]>();

  private onRecord(r: ActionRecord): void {
    const key = taskKey(r.skill, r.args);
    const t = this.now();
    // Loop cap (§13 rule 6): the same task "succeeding" instantly over and over changes nothing.
    if (r.ok && r.durationMs < 1500 && !['wait', 'say', 'look', 'lookAround', 'wander'].includes(r.skill)) {
      const xs = [...(this.instant.get(key) ?? []), t].filter((x) => t - x < 120_000);
      this.instant.set(key, xs);
      if (xs.length >= 3) {
        this.instant.delete(key);
        this.stuckUntil.set(key, { until: t + (this.o.stuckForMs ?? 5 * 60_000), why: 'doing it again changes nothing' });
        pushWorkmem(this.o.store, `${describe(r)} keeps finishing instantly; nothing changes. Do something else`, 0.7, 'self_observed', { now: t });
        this.o.bus.emit({ type: 'stuck', skill: r.skill });
        return;
      }
    }
    if (r.ok) {
      // New information lifts a mark: once a prospect finds the ore an obtain kept missing ("haven't seen any
      // raw_iron"), doing it again is no longer "changes nothing".
      const found = r.skill === 'prospect' ? /^found (\S+) at /.exec(r.observed)?.[1] : undefined;
      const item = typeof r.args.item === 'string' ? r.args.item : undefined;
      if (found) {
        for (const [k, s] of this.stuckUntil) {
          if (s.why.includes(found) || (item && s.why.includes(item))) this.stuckUntil.delete(k);
        }
      }
      this.fails.delete(key);
      const lifted = this.givenUp.delete(`${r.skill}:${item ?? ''}`) || this.givenUp.delete(`${r.skill}:`);
      if ((this.stuckUntil.delete(key) || lifted) && this.stuckList().length === 0) {
        this.o.store.update('flags', (f) => (f.stuck ? { ...f, stuck: false } : f), 'unstuck');
      }
      return;
    }
    if (r.skill === 'wait' || r.skill === 'lookAround') return;
    const why = r.error ?? `expected ${r.expected}, saw ${r.observed}`;
    if (r.error?.startsWith('aborted') || r.error === 'time is up') return;
    const w = r.progressed && GATHERING.has(r.skill) ? 0.5 : 1;
    const list = [...(this.fails.get(key) ?? []), { t, w }].filter((x) => t - x.t < (this.o.windowMs ?? 10 * 60_000));
    this.fails.set(key, list);
    // The executor records a postcondition mismatch as "expected …, saw …".
    const mismatch = r.error?.startsWith('expected ') ?? false;
    if (list.reduce((a, x) => a + x.w, 0) >= 3) {
      this.fails.delete(key);
      this.stuckUntil.set(key, { until: t + (this.o.stuckForMs ?? 5 * 60_000), why });
      this.o.store.update('flags', (f) => ({ ...f, stuck: true }), 'stuck');
      pushWorkmem(this.o.store, `I keep failing to ${describe(r)} because ${why}`, 0.9, 'self_observed', { now: t });
      this.o.logger.info({ module: 'awareness', task: key, why }, 'stuck');
      this.o.bus.emit({ type: 'stuck', skill: r.skill });
    } else if (mismatch) {
      pushWorkmem(this.o.store, `${describe(r)} seemed to work but I didn't get ${r.expected}`, 0.6, 'self_observed', { now: t });
    } else {
      pushWorkmem(this.o.store, `${describe(r)} failed: ${why}`, 0.5, 'self_observed', { now: t });
    }
  }
}
