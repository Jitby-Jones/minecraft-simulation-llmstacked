// Self-Monitor (§4.2 module 6): keeps a short first-person narrative (`selfSummary`, ≤ 120 words) from working
// memory and the previous summary. The check's model, given time (`thoughts.summary`), debounced 5–10 s after
// something salient. Code default: a plain summary built from the state.

import type { Logger, Persona } from '@agora/shared';
import { type ChatMessage, type LlmClient, SingleFlight } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { SUMMARY_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { personaCore } from './prompts';
import { isOff } from '../state/switches';
import { countOf } from '../perception/sceneWords';
import { dayPart } from './bottleneck';

export const SummarySchema = z.object({ summary: z.string().min(1).max(1200) });

/** The self-summary as asked (and as the thought benchmark asks it). */
export function summaryMessages(
  persona: Persona,
  traitAnnotations: readonly string[],
  o: { previous: string; goal: string; recent: readonly string[]; onMind: readonly string[]; now?: string },
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `${personaCore(persona, traitAnnotations)}\n\nWrite your private summary of your situation and recent experiences: first person, at most 120 words. JSON: {"summary": "..."}`,
    },
    {
      role: 'user',
      content: [
        `Previous summary: ${o.previous || '(none)'}`,
        ...(o.now ? [`Now, as your senses have it (where the previous summary says otherwise, this is so): ${o.now}`] : []),
        `Goal: ${o.goal || 'none'}`,
        `Recent actions: ${o.recent.join('; ') || 'none'}`,
        `On your mind:\n${o.onMind.map((w) => `- ${w}`).join('\n') || '- nothing'}`,
      ].join('\n'),
    },
  ];
}

export interface SelfMonitorOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: string;
  rng?: () => number;
  now?: () => number;
}

/**
 * Where one is and how, as the senses have it, for the summary to be written from: one wrote "I'm at the staircase top,
 * y77, a safe spot" from her last summary while she stood in a cave at y34 with seven silverfish and a spider on her,
 * and every thought in the danger began with it.
 */
export function nowLine(s: AgentStateStore['state']): string {
  const self = s.self;
  const kinds = new Map<string, number>();
  for (const c of s.scene.creatures) if (c.kind === 'hostile' && c.distance <= 16) kinds.set(c.name, (kinds.get(c.name) ?? 0) + 1);
  const about = [...kinds].map(([name, n]) => countOf(n, name)).join(', ');
  const world = String(self.dimension ?? 'overworld').replace(/^minecraft:/, '');
  return [
    `health ${Math.round(self.health)}/20, food ${self.food}/20, ${dayPart(self.time, self.isDay)}`,
    `at ${Math.round(self.pos.x)},${Math.round(self.pos.y)},${Math.round(self.pos.z)}${world !== 'overworld' ? ` in ${world === 'the_nether' ? 'the Nether' : 'the End'}` : ''}${s.scene.where ? ` (${s.scene.where})` : ''}`,
    ...(s.flags.inDanger ? ['in danger'] : []),
    ...(about ? [`monsters about: ${about}`] : []),
  ].join('; ');
}

export function codeSummary(s: AgentStateStore['state']): string {
  const parts: string[] = [];
  if (s.goals.current) parts.push(`I'm working on: ${s.goals.current.text}.`);
  if (s.option) parts.push(`Right now I'm ${s.option.option}${s.option.skill ? ` (${s.option.skill})` : ''}.`);
  const notes = [...s.workmem].sort((a, b) => b.salience - a.salience).slice(0, 3).map((w) => w.text);
  if (notes.length > 0) parts.push(`On my mind: ${notes.join('; ')}.`);
  return parts.join(' ').split(' ').slice(0, 120).join(' ');
}

export class SelfMonitor {
  private timer: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private lastWorkmemVersion = -1;
  private readonly flight = new SingleFlight<void>();
  private readonly rng: () => number;
  private readonly onChange = (c: { facet: string; next: AgentStateStore['state'] }) => {
    if (c.facet !== 'workmem') return;
    const newest = c.next.workmem[c.next.workmem.length - 1];
    if (newest && newest.salience >= 0.5) this.schedule();
  };

  constructor(private readonly o: SelfMonitorOptions) {
    this.rng = o.rng ?? Math.random;
  }

  start(): void {
    this.o.store.on('change', this.onChange);
    this.beat = setInterval(() => {
      if (this.o.store.facetVersion('workmem') !== this.lastWorkmemVersion) this.schedule();
    }, 90_000);
    this.beat.unref();
  }

  stop(): void {
    this.o.store.off('change', this.onChange);
    if (this.timer) clearTimeout(this.timer);
    if (this.beat) clearInterval(this.beat);
    this.timer = null;
    this.beat = null;
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = 5000 + this.rng() * 5000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flight.run('self', () => this.run()).catch((err: unknown) => this.o.logger.warn({ module: 'selfMonitor', err: String(err) }, 'self summary failed'));
    }, wait);
    this.timer.unref();
  }

  async run(): Promise<void> {
    if (isOff(this.o.store.state, 'selfMonitor')) return;
    this.lastWorkmemVersion = this.o.store.facetVersion('workmem');
    const s = this.o.store.state;
    const fallback = () => ({ summary: codeSummary(s) });
    let summary = fallback().summary;
    if (this.o.llm) {
      const guard = this.o.store.guard(SUMMARY_POLICY);
      try {
        const recent = s.actionLog.slice(-3).map((a) => `${a.skill}: ${a.ok ? 'ok' : `failed (${a.error ?? a.observed})`}`);
        const r = await this.o.llm.call({
          tier: 'L1',
          module: 'selfMonitor',
          agent: this.o.me,
          schema: SummarySchema,
          schemaName: 'summary',
          fallback,
          signal: guard.signal,
          isStale: guard.isStale,
          messages: summaryMessages(s.self.persona, s.traitAnnotations, { previous: s.selfSummary, goal: s.goals.current?.text ?? '', recent, onMind: s.workmem.map((w) => w.text), now: nowLine(s) }),
        });
        if (!r.ok && r.reason === 'stale') return;
        summary = r.value.summary;
      } finally {
        guard.dispose();
      }
    }
    const capped = summary.split(/\s+/).slice(0, 120).join(' ');
    if (capped !== this.o.store.state.selfSummary) this.o.store.set('selfSummary', capped, 'self-monitor');
  }
}
