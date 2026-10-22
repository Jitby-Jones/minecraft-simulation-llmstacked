// Social Goal Generation (§4.2 module 11, §6.8): what this agent takes on for the village and the people around it,
// toward the community goal. L2, every 60–120 s while others are around (Sid ran it every 5–10 s; too costly), half
// as often under quota pressure and off from 85 % (§22.4), and soon after a death (cooperation, §16.3) or a piece of
// village work done. Code default: what the village needs as this agent sees it, what it likes doing and who it
// sees doing what already (social/village.ts), which is where the division of labor comes from without a model.
// The goals reach the CC packet and Goal Gen; the role they add up to (Sid's, from the last five) goes to the
// dashboard.

import { type AgentName, type Goal, type Logger } from '@agora/shared';
import { type LlmClient, SingleFlight, ladder } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { type VillageKind, type VillageView, VILLAGE_KINDS, chooseWork, describeVillage, isVillageKind, roleFrom } from '../social/village';
import { SLOW_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { WORK_SAYS } from '../social/roles';
import { DEATH_RULE, personaCore } from './prompts';

export const SocialGoalSchema = z.object({
  goals: z
    .array(
      z.object({
        text: z.string().min(3).max(120),
        kind: z.enum(VILLAGE_KINDS),
        with: z.string().max(16).optional(),
      }),
    )
    .max(2),
  why: z.string().max(240).default(''),
});
export type SocialGoalOutput = z.infer<typeof SocialGoalSchema>;

/** How each kind of work reads as a goal (the code default's wording). */
export const WORK_TEXT: Readonly<Record<VillageKind, string>> = {
  wood: 'bring logs to the village chest',
  stone: 'mine stone for the village',
  food: 'hunt and cook food to share',
  build: 'build a hut in the village',
  guard: 'keep the village safe from mobs',
  tools: 'make tools for the village',
  scout: 'scout the land and post what I find',
};

export interface SocialGoalGenOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: AgentName;
  community: string;
  /** What this agent knows of the village (its own perception, §13 rule 4). */
  view: () => VillageView;
  onRole?: (role: string, before: string | null) => void;
  /** Says a line to whoever is around (taking work up, the agent says what it will be doing). */
  announce?: (text: string) => void;
  rng?: () => number;
  now?: () => number;
}

type Picked = { text: string; kind: VillageKind; with?: AgentName };

export class SocialGoalGen {
  private timer: NodeJS.Timeout | null = null;
  private readonly soonTimers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(private readonly o: SocialGoalGenOptions) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const community = this.o.community.trim();
    if (community && this.o.store.state.goals.community !== community) this.o.store.update('goals', (g) => ({ ...g, community }), 'community goal');
    this.offs.push(this.o.bus.on('peerDied', (e) => this.soon(`${e.name} died (${e.cause})`, 3000)));
    this.offs.push(this.o.bus.on('goalDone', (e) => e.goal.doneWhen?.startsWith('villageWork:') && this.soon('village work done', 1500)));
    this.schedule();
    this.soon('arrived in the village', 8000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.soonTimers) clearTimeout(t);
    this.soonTimers.clear();
    for (const off of this.offs.splice(0)) off();
  }

  private kick(reason: string): void {
    this.flight.run('social', () => this.run(reason)).catch((err: unknown) => this.o.logger.warn({ module: 'socialGoal', err: String(err) }, 'social goals failed'));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    // §22.4: half as often under quota pressure (the per-agent 80 % step folds into level 1), off from level 2.
    const slow = this.o.store.state.flags.degrade >= 1 ? 2 : 1;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.kick('periodic');
        this.schedule();
      },
      (60_000 + this.rng() * 60_000) * slow,
    );
    this.timer.unref();
  }

  soon(reason: string, ms: number): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.soonTimers.delete(t);
      this.kick(reason);
    }, ms);
    t.unref();
    this.soonTimers.add(t);
  }

  /** Someone else has been around in the last two minutes: the module runs only in company (§4.2). */
  inCompany(): boolean {
    const t = this.now();
    return Object.values(this.o.store.state.social).some((p) => p.name !== this.o.me && t - p.lastSeen < 120_000);
  }

  async run(reason: string): Promise<void> {
    const s = this.o.store.state;
    if (this.stopped || s.flags.inDanger || !this.inCompany()) return;
    const view = this.o.view();
    const current = s.goals.social.find((g) => g.status === 'active')?.work;
    let out: Picked[] | null = null;
    if (this.o.llm && !s.flags.codeOnly && ladder(s.flags.degrade).enabled('socialGoal')) {
      const guard = this.o.store.guard(SLOW_POLICY);
      try {
        const t = this.now();
        const people = Object.values(s.social)
          .filter((p) => p.name !== this.o.me && t - p.lastSeen < 30 * 60_000)
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .slice(0, 6)
          .map((p) => `${p.name} (you feel ${Math.round(p.sentiment)}/10${p.perceivedRole ? `, seems to be a ${p.perceivedRole}` : ''}${p.perceivedGoals[0] ? `, wants ${p.perceivedGoals[0]}` : ''})`);
        const deaths = s.perception.systemEvents.filter((e) => e.kind === 'death' && t - e.ts < 30 * 60_000).map((e) => e.text);
        const signs = s.village.signs.slice(-3).map((x) => `"${x.text}"`);
        const r = await this.o.llm.call<SocialGoalOutput>({
          tier: 'L2',
          module: 'socialGoal',
          agent: this.o.me,
          schema: SocialGoalSchema,
          schemaName: 'socialGoal',
          fallback: (): SocialGoalOutput => ({ goals: [], why: '' }),
          signal: guard.signal,
          isStale: guard.isStale,
          messages: [
            {
              role: 'system',
              content: `${personaCore(s.self.persona, s.traitAnnotations)}\n${DEATH_RULE}\n\nYou live in a village with other people${s.goals.community ? `; everyone hopes to ${s.goals.community}` : ''}. Choose what you will do for the village or the people around you over the next while: one or two goals, each with its kind of work (${VILLAGE_KINDS.join(', ')}) and, if it is with or for someone, their name. Do what is needed and what suits you, and leave to others what they already do. Stay in character. JSON: {"goals": [{"text": "...", "kind": "...", "with": "name"}], "why": "..."}`,
            },
            {
              role: 'user',
              content: [
                `Why now: ${reason}.`,
                `What you know of the village: ${describeVillage(view)}.`,
                `People: ${people.join('; ') || 'nobody yet'}.`,
                deaths.length > 0 ? `Lately: ${deaths.join('; ')}. Think about keeping each other safe.` : '',
                signs.length > 0 ? `Signs you have read: ${signs.join(' ')}` : '',
                `Your part so far: ${s.goals.social.map((g) => g.text).join('; ') || 'none yet'}.`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        });
        if (!r.ok && r.reason === 'stale') return;
        if (r.ok && r.value.goals.length > 0) out = r.value.goals.map((g) => ({ text: g.text, kind: g.kind, ...(g.with ? { with: g.with } : {}) }));
      } finally {
        guard.dispose();
      }
    }
    if (this.stopped) return;
    if (!out) {
      const top = chooseWork(s.self.persona, view, isVillageKind(current) ? current : null, this.rng)[0];
      if (top) out = [{ text: WORK_TEXT[top.kind], kind: top.kind }];
    }
    if (out && out.length > 0) this.apply(out, reason);
  }

  private apply(goals: Picked[], reason: string): void {
    const t = this.now();
    const s = this.o.store.state;
    const active = s.goals.social.filter((g) => g.status === 'active');
    const kinds = [...(s.goals.socialKinds ?? []), ...goals.slice(0, 1).map((g) => g.kind)].slice(-5);
    const role = roleFrom(kinds.filter(isVillageKind));
    const before = s.goals.role ?? null;
    const same = goals.length === active.length && goals.every((g, i) => active[i]?.work === g.kind && active[i]?.text === g.text);
    // The same work again still counts toward the role; the goals themselves stay as they are.
    const social: Goal[] = same
      ? s.goals.social
      : goals.map((g, i) => ({ id: `sg-${t.toString(36)}-${i}`, text: g.text, kind: 'social', createdAt: t, status: 'active', work: g.kind, ...(g.with ? { with: g.with } : {}) }));
    this.o.store.update('goals', (g) => ({ ...g, social, socialKinds: kinds, role }), 'social goals');
    if (!same) this.o.logger.info({ module: 'socialGoal', reason, goals: goals.map((g) => `${g.kind}: ${g.text}`), role }, 'social goals');
    // Taking up other work, it says so to those around: what one does out of their sight they know from that.
    const top = goals[0]?.kind;
    if (top && top !== active[0]?.work && this.inCompany()) this.o.announce?.(WORK_SAYS[top]);
    if (role && role !== before) {
      this.o.logger.info({ module: 'socialGoal', role, before }, 'role');
      this.o.onRole?.(role, before);
    }
  }
}
