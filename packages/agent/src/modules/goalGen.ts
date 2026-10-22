// Goal Generation (§4.2 module 10): picks the agent's next concrete goal from its persona (life goals, values),
// self-summary, the people it knows and what it remembers. L3; every 3–5 min (slower under quota pressure, §22.4),
// right after a goal is done, and on reflection. A goal about having things carries a code-checkable `doneWhen`.
// Code default: a sensible tech ladder (wooden tools → stone tools → furnace → iron), so code-only agents still
// build goal chains.

import { type AgentState, type Logger } from '@agora/shared';
import { type LlmClient, SingleFlight, ladder } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { SLOW_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { evalCondition } from './conditions';
import { DEATH_RULE, personaCore } from './prompts';

export const GoalOutputSchema = z.object({
  /** Keep the current goal instead of switching. */
  keep: z.boolean().default(false),
  goal: z
    .object({
      text: z.string().min(3).max(120),
      doneWhen: z.string().max(80).optional(),
      why: z.string().max(240).default(''),
    })
    .optional(),
});
export type GoalOutput = z.infer<typeof GoalOutputSchema>;

function held(s: AgentState, item: string): number {
  return s.self.inventory.filter((x) => x.item === item).reduce((a, x) => a + x.qty, 0);
}

/** The code-default goal ladder. Null when the agent should keep what it has. */
export function codeGoal(s: AgentState): { text: string; doneWhen?: string } | null {
  if (s.goals.current) return null;
  const done = new Set(s.goals.history.filter((g) => g.status === 'done').map((g) => g.doneWhen));
  const steps: { text: string; doneWhen: string; have: () => boolean }[] = [
    { text: 'make a wooden pickaxe', doneWhen: 'inventoryHas:wooden_pickaxe>=1', have: () => held(s, 'wooden_pickaxe') + held(s, 'stone_pickaxe') + held(s, 'iron_pickaxe') > 0 },
    { text: 'get stone tools', doneWhen: 'inventoryHas:stone_pickaxe>=1', have: () => held(s, 'stone_pickaxe') + held(s, 'iron_pickaxe') > 0 },
    { text: 'build a furnace', doneWhen: 'inventoryHas:furnace>=1', have: () => held(s, 'furnace') > 0 },
    { text: 'make an iron pickaxe', doneWhen: 'inventoryHas:iron_pickaxe>=1', have: () => held(s, 'iron_pickaxe') > 0 },
    { text: 'stock up on cobblestone for building', doneWhen: 'inventoryHas:cobblestone>=32', have: () => held(s, 'cobblestone') >= 32 },
  ];
  const next = steps.find((st) => !st.have() && !done.has(st.doneWhen));
  if (next) return { text: next.text, doneWhen: next.doneWhen };
  const life = s.goals.life[Math.floor((Date.now() / 600_000) % Math.max(1, s.goals.life.length))];
  return life ? { text: life } : null;
}

export interface GoalGenOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: string;
  setGoal: (text: string, doneWhen?: string) => void;
  memories?: (k: number) => Promise<string[]>;
  rng?: () => number;
  now?: () => number;
}

export class GoalGen {
  private timer: NodeJS.Timeout | null = null;
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(private readonly o: GoalGenOptions) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('goalDone', () => this.soon('goal done', 2000)));
    this.scheduleNext();
    if (!this.o.store.state.goals.current) this.soon('starting', 1500);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    const cadence = ladder(this.o.store.state.flags.degrade).cadence('goal');
    const ms = (180_000 + this.rng() * 120_000) * cadence;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flight.run('goal', () => this.run('periodic'));
      this.scheduleNext();
    }, ms);
    this.timer.unref();
  }

  soon(reason: string, ms: number): void {
    setTimeout(() => void this.flight.run('goal', () => this.run(reason)), ms).unref();
  }

  async run(reason: string): Promise<void> {
    const s = this.o.store.state;
    if (s.flags.inDanger) return;
    let out: { text: string; doneWhen?: string } | null = null;
    if (this.o.llm && !s.flags.codeOnly && ladder(s.flags.degrade).enabled('goal')) {
      const guard = this.o.store.guard(SLOW_POLICY);
      try {
        const memories = (await this.o.memories?.(5)) ?? [];
        const inv = s.self.inventory.map((x) => `${x.qty} ${x.item}`).join(', ') || 'nothing';
        const people = Object.values(s.social)
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .slice(0, 6)
          .map((p) => `${p.name} (you feel ${Math.round(p.sentiment)}/10)`);
        const history = s.goals.history.slice(-5).map((g) => `${g.text} (${g.status})`);
        // §18.3 idolization: the agent imitates someone it admires.
        const idols = Object.values(s.social)
          .filter((p) => p.admiration > 0.75)
          .slice(0, 2)
          .map((p) => `You admire ${p.name}${p.perceivedRole ? `, a ${p.perceivedRole}` : ''}${p.perceivedGoals[0] ? `; they seem to want ${p.perceivedGoals[0]}` : ''}. You'd like to be more like them.`);
        const r = await this.o.llm.call<GoalOutput>({
          tier: 'L3',
          module: 'goal',
          agent: this.o.me,
          schema: GoalOutputSchema,
          schemaName: 'goal',
          fallback: (): GoalOutput => ({ keep: true }),
          signal: guard.signal,
          isStale: guard.isStale,
          messages: [
            {
              role: 'system',
              content: `${personaCore(s.self.persona, s.traitAnnotations)}\n${DEATH_RULE}\n\nChoose your next concrete goal: something you can finish in the next 5–20 minutes that moves you toward your life goals or helps people you care about. If the goal is about having items, set doneWhen to inventoryHas:<item>>=<n>. If your current goal is still right, answer {"keep": true}. JSON: {"keep": false, "goal": {"text": "...", "doneWhen": "...", "why": "..."}}`,
            },
            {
              role: 'user',
              content: [
                `Why now: ${reason}.`,
                `About you: ${s.selfSummary || 'nothing notable yet.'}`,
                `Current goal: ${s.goals.current ? `${s.goals.current.text} (for ${Math.round((this.now() - s.goals.current.createdAt) / 60000)} min)` : 'none'}`,
                `Recent goals: ${history.join('; ') || 'none'}`,
                `Carrying: ${inv}. It is ${s.self.isDay ? 'day' : 'night'}.`,
                `People you know: ${people.join(', ') || 'nobody yet'}`,
                ...idols,
                memories.length > 0 ? `You remember:\n${memories.map((m) => `- ${m}`).join('\n')}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        });
        if (!r.ok && r.reason === 'stale') return;
        if (r.ok && !r.value.keep && r.value.goal) {
          const g = r.value.goal;
          const checkable = g.doneWhen && evalCondition(g.doneWhen, s) !== null ? g.doneWhen : undefined;
          out = { text: g.text, ...(checkable ? { doneWhen: checkable } : {}) };
        }
      } finally {
        guard.dispose();
      }
    }
    out ??= codeGoal(this.o.store.state);
    if (!out || out.text === this.o.store.state.goals.current?.text) return;
    this.o.logger.info({ module: 'goal', reason, goal: out.text, doneWhen: out.doneWhen }, 'new goal');
    this.o.setGoal(out.text, out.doneWhen);
  }
}
