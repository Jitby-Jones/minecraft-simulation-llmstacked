// Learning from experience (owner request, 2026-10-24: agents "learn how to play the game without being told
// directly"). A long-time player already knows the game; what they learn as they play is about this world and
// themselves: what worked here and what didn't, what a mistake cost them, what to expect of the people and things
// about. Lessons come from the mind itself (a "lesson" with a decision) and from thinking back now and then over what
// happened (L3, slow: what worked, what failed and why, what surprised). They are kept for life (knowledge.lessons,
// snapshotted), the ones that bear on what is going on are brought to mind with each decision (bottleneck.ts), and
// each also goes to long-term memory by way of working memory.

import type { ActionRecord, AgentState, AssignedTask, Lesson, Logger } from '@agora/shared';
import { type LlmClient, SingleFlight, ladder } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { personaCore } from '../modules/prompts';
import { SLOW_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';

/** Lessons kept at most (the oldest, least used go first). */
export const MAX_LESSONS = 60;
const WORD = /[a-z0-9][a-z0-9_']{2,}/g;
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'not', 'but', 'have', 'has', 'can', 'its', "it's", 'when', 'then', 'there', 'they', 'them', 'from', 'what', 'will', 'just', 'get', 'got']);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));
}

/** How much two texts say the same: shared words over the smaller set. */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

/** Keeps a lesson; the same lesson again only freshens the one there is. Returns it when it is new. */
export function addLesson(store: AgentStateStore, text: string, from: Lesson['from'], now: number): Lesson | null {
  const clean = text.trim().replace(/\s+/g, ' ').slice(0, 300);
  if (clean.length < 8) return null;
  const all = store.state.knowledge.lessons ?? [];
  const same = all.find((l) => overlap(l.text, clean) >= 0.7);
  if (same) {
    store.update('knowledge', (k) => ({ ...k, lessons: (k.lessons ?? []).map((l) => (l.id === same.id ? { ...l, ts: now } : l)) }), 'lesson again');
    return null;
  }
  const lesson: Lesson = { id: `les${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, text: clean, ts: now, from, uses: 0 };
  store.update(
    'knowledge',
    (k) => {
      const kept = [...(k.lessons ?? []), lesson];
      // Over the limit: the least used of the older ones go.
      while (kept.length > MAX_LESSONS) {
        const old = kept.slice(0, -10);
        const worst = old.reduce((a, b) => (b.uses < a.uses || (b.uses === a.uses && b.ts < a.ts) ? b : a), old[0] as Lesson);
        kept.splice(kept.indexOf(worst), 1);
      }
      return { ...k, lessons: kept };
    },
    'learned',
  );
  // To long-term memory, in its own words, by way of working memory.
  pushWorkmem(store, `I learned: ${clean}`, 0.75, 'self_observed', { now });
  return lesson;
}

/** The open task a note is about: by its number ("1", "task 2") or by the words it shares with it. */
/** Words that say what is done to a thing, not what: no task is told from another by them. */
const DOING = new Set(['make', 'made', 'obtain', 'build', 'built', 'craft', 'find', 'set', 'sets', 'full', 'secure', 'some', 'all', 'into', 'out', 'one', 'two']);

function stem(w: string): string {
  return w.length > 4 ? w.replace(/(ing|ed|s)$/, '') : w;
}

/** "3: why", "3. why", "task 3", "#3" or a bare "3": the task by its number; "12 diamonds" is no number of one. */
const BY_NUMBER = /^\s*(?:task\s*#?\s*(\d{1,2})\b|#(\d{1,2})\b|(\d{1,2})\s*(?:[:.)]|[-–—]\s|$))/i;

/**
 * Which open task a "taskDone"/"taskDropped" means: by its number as listed, else the one whose own words (what it is
 * about, not "make" or "build") are all there. A plan's step "make a crafting table, craft torches" closed "Make an
 * enchanting table" when two shared words were enough.
 */
export function matchTask(tasks: readonly AssignedTask[], text: string): AssignedTask | null {
  const open = tasks.filter((t) => t.status === 'open');
  const m = BY_NUMBER.exec(text);
  const n = m?.[1] ?? m?.[2] ?? m?.[3];
  if (n) return open[Number(n) - 1] ?? null;
  const said = new Set([...words(text)].map(stem));
  let best: AssignedTask | null = null;
  let most = 0;
  for (const t of open) {
    const key = [...words(t.text)].filter((w) => !DOING.has(w) && !/^\d+$/.test(w)).map(stem);
    if (key.length === 0 || !key.every((w) => said.has(w)) || key.length <= most) continue;
    most = key.length;
    best = t;
  }
  return best;
}

export const ReviewSchema = z.object({
  lessons: z.array(z.string().min(8).max(300)).max(3).default([]),
  /** Lessons it already had, by their number in the list shown, that what happened showed to be wrong. */
  wrong: z.array(z.coerce.number().int().min(1).max(20)).max(3).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

/**
 * What it already learned that bears on what happened (by the words they share), with the newest: the ones to set what
 * happened against. One that came of a bed set down the wrong way ("beds won't go down on grass") would otherwise have
 * steered it for good.
 */
export function lessonsToCheck(all: readonly Lesson[], happened: readonly string[], k = 12): Lesson[] {
  const text = happened.join(' ');
  const bearing = [...all].map((l) => ({ l, score: overlap(l.text, text) })).filter((x) => x.score > 0.25).sort((a, b) => b.score - a.score).slice(0, k - 4).map((x) => x.l);
  const out = [...bearing];
  for (const l of all.slice(-k)) if (out.length < k && !out.includes(l)) out.push(l);
  return out;
}

/** Drops lessons shown wrong; returns those dropped. */
export function unlearn(store: AgentStateStore, wrong: readonly Lesson[], now: number): Lesson[] {
  const ids = new Set(wrong.map((l) => l.id));
  const gone = (store.state.knowledge.lessons ?? []).filter((l) => ids.has(l.id));
  if (gone.length === 0) return [];
  store.update('knowledge', (k) => ({ ...k, lessons: (k.lessons ?? []).filter((l) => !ids.has(l.id)) }), 'unlearned');
  for (const l of gone) pushWorkmem(store, `I was wrong about this: ${l.text}`, 0.6, 'self_observed', { now });
  return gone;
}

/** What happened, in a few lines: what was done and how it went, what stood out. */
export function episodes(s: AgentState, since: number): string[] {
  const acts = s.actionLog.filter((a) => a.ts >= since && !['wait', 'lookAround', 'look'].includes(a.skill));
  const lines = acts.slice(-14).map((a: ActionRecord) => `${a.skill} ${JSON.stringify(a.args)}: ${a.ok ? 'worked' : 'FAILED'}: ${a.observed}${a.error ? ` (${a.error})` : ''}`);
  for (const n of s.scene.notices.filter((x) => x.ts >= since)) lines.push(`noticed: ${n.text}`);
  for (const t of s.mind.thoughts.filter((x) => x.ts >= since).slice(-4)) lines.push(`you thought: ${t.text}`);
  return lines;
}

export interface LearningOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: string;
  now?: () => number;
  /** How often to think back over what happened. */
  everyMs?: number;
}

/** Thinks back now and then over what happened, and keeps what it taught (owner request, 2026-10-24). */
export class Learning {
  private timer: NodeJS.Timeout | null = null;
  private readonly flight = new SingleFlight<void>();
  private since: number;
  private readonly now: () => number;
  private off: (() => void) | null = null;
  private failures = 0;

  constructor(private readonly o: LearningOptions) {
    this.now = o.now ?? Date.now;
    this.since = this.now();
  }

  start(): void {
    const every = this.o.everyMs ?? 10 * 60_000;
    this.timer = setInterval(() => this.kick('a while has gone by'), every);
    this.timer.unref();
    // A run of failures is worth thinking back over sooner.
    this.off = this.o.bus.on('actionRecorded', (e) => {
      if (e.record.ok || e.record.error?.startsWith('aborted') || e.record.error === 'time is up') return;
      if (++this.failures >= 4) this.kick('things keep going wrong');
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  kick(reason: string): void {
    this.flight.run('learning', () => this.run(reason)).catch((err: unknown) => this.o.logger.warn({ module: 'learning', err: String(err) }, 'thinking back failed'));
  }

  async run(reason: string): Promise<void> {
    const s = this.o.store.state;
    const from = this.since;
    const lines = episodes(s, from);
    // Too little happened to learn from.
    if (lines.length < 4) return;
    this.since = this.now();
    this.failures = 0;
    if (!this.o.llm || s.flags.codeOnly || !ladder(s.flags.degrade).enabled('reflection')) return;
    const shown = lessonsToCheck(s.knowledge.lessons ?? [], lines);
    const known = shown.map((l, i) => `${i + 1}. ${l.text}`);
    const guard = this.o.store.guard(SLOW_POLICY);
    try {
      const r = await this.o.llm.call<Review>({
        tier: 'L3',
        module: 'learning',
        agent: this.o.me,
        schema: ReviewSchema,
        schemaName: 'review',
        fallback: (): Review => ({ lessons: [], wrong: [] }),
        signal: guard.signal,
        isStale: guard.isStale,
        messages: [
          {
            role: 'system',
            content: `${personaCore(s.self.persona, s.traitAnnotations)}\n\nYou know Minecraft well. Think back over what you have been doing lately, as anyone does now and then: what worked, what didn't and why, what it cost you, what surprised you. Say what it taught you about this world, the people in it, or how you go about things, in your own words, as short lessons you'd want to remember next time (at most 3; none if nothing was learned). Leave out what you already know. And if what happened shows that something you had learned is wrong (it worked after all, or it failed for another reason than you thought), give its number under "wrong", with the right lesson among the lessons.\nJSON: {"lessons": ["..."], "wrong": [numbers]}`,
          },
          { role: 'user', content: `${known.length > 0 ? `What you already learned:\n${known.join('\n')}\n\n` : ''}What happened (${reason}):\n${lines.join('\n')}` },
        ],
      });
      if (!r.ok) return;
      const wrong = r.value.wrong.map((n) => shown[n - 1]).filter((l): l is Lesson => l !== undefined);
      for (const l of unlearn(this.o.store, wrong, this.now())) this.o.logger.info({ module: 'learning', lesson: l.text }, 'unlearned');
      for (const text of r.value.lessons) {
        const lesson = addLesson(this.o.store, text, 'experience', this.now());
        if (lesson) {
          this.o.logger.info({ module: 'learning', lesson: lesson.text }, 'learned');
          this.o.bus.emit({ type: 'learned', lesson });
        }
      }
    } finally {
      guard.dispose();
    }
  }
}
