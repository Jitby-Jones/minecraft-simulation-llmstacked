// Reflection as debiasing (§18.6; the bias audit of module 12, L3). Every `reflectionEveryMin` minutes (8–25, by
// intelligence; twice as long under quota pressure), and once calm again after a strong feeling, the agent looks
// again at its strongest feelings about people against what it has actually seen of them: a dislike that rests on
// hearsay, someone blamed without cause, an idol who did wrong, going along with a crowd, a first impression. Each
// correction is applied with probability rationality (the stubborn resist), and inoculates against that bias about
// that person for the rest of the life (×0.5 susceptibility). Every correction applied adds a little rationality
// (+0.02, up to +0.2); mobs joined and not thought better of afterwards add a little conformity (+0.01 each, up to
// +0.2). Without a model the audit is code: the same candidates, each taken as its own correction.

import type { AgentName, AgentState, Inoculable, Logger, SocialProfile } from '@agora/shared';
import { type LlmClient, SingleFlight, ladder } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { rationalityOf } from '../mind/biases';
import { SLOW_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import type { MindLevers } from './levers';
import { personaCore } from './prompts';

export const CORRECTION_KINDS = ['hearsay', 'scapegoat', 'idol', 'crowd', 'first_impression'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const AuditSchema = z.object({
  corrections: z
    .array(z.object({ who: z.string().min(1).max(32), kind: z.enum(CORRECTION_KINDS), why: z.string().max(240).default('') }))
    .max(3)
    .default([]),
});
export type Audit = z.infer<typeof AuditSchema>;

/** Someone a feeling about might rest on a bias, and which one. */
export interface Suspect {
  name: AgentName;
  kind: CorrectionKind;
  why: string;
}

/** Which bias a correction inoculates against (§18.6). */
const INOCULATES: Readonly<Record<CorrectionKind, Inoculable>> = {
  hearsay: 'conformity',
  scapegoat: 'scapegoat',
  idol: 'halo',
  crowd: 'conformity',
  first_impression: 'halo',
};

/** How far a correction moves the gut toward the facts. */
const TOWARD_FACTS = 0.6;
const MAX_GROWTH = 0.2;
/** A strong feeling, and calm enough again to think it over. */
const STRONG = 0.7;
const CALM = 0.3;

/** "On reflection" lines for working memory, by kind. */
const SAYS: Readonly<Record<CorrectionKind, (n: AgentName) => string>> = {
  hearsay: (n) => `On reflection, my dislike of ${n} rests on what others said; ${n} has done right by me.`,
  scapegoat: (n) => `On reflection, I blamed ${n} for something nobody saw ${n} do.`,
  idol: (n) => `On reflection, I looked up to ${n} too much; ${n} has done wrong.`,
  crowd: (n) => `On reflection, I went along with the others against ${n}; ${n} did nothing to me.`,
  first_impression: (n) => `On reflection, my first impression of ${n} was off.`,
};

/** What code finds worth a second look (and, without a model, the audit itself), strongest gap first. */
export function auditCandidates(s: AgentState): Suspect[] {
  const me = s.self.username;
  const out: (Suspect & { gap: number })[] = [];
  for (const p of Object.values(s.social)) {
    if (p.name === me) continue;
    const gap = p.evidence - p.sentiment;
    const hearsay = p.grievances.filter((g) => g.source.startsWith('told_by:')).reduce((a, g) => a + g.weight, 0);
    const seen = p.grievances.filter((g) => g.source === 'self_observed' && g.kind !== 'scapegoat').reduce((a, g) => a + g.weight, 0);
    const badTalk = s.heardOpinions.some((o) => o.target === p.name && o.valence <= -0.3);
    const mobbed = s.workmem.some((w) => w.aboutAgent === p.name && /^Everyone is against /.test(w.text));
    // Blame with nothing seen behind it comes first: it is the plainest of them.
    if (p.grievances.some((g) => g.kind === 'scapegoat')) out.push({ name: p.name, kind: 'scapegoat', why: `blamed ${p.name} without seeing anything`, gap: Math.abs(gap) + 3 });
    else if (gap >= 1.5 && (hearsay > seen || (badTalk && seen === 0))) out.push({ name: p.name, kind: 'hearsay', why: `what others said, not what ${p.name} did`, gap });
    else if (mobbed && p.evidence >= 6 && gap >= 1) out.push({ name: p.name, kind: 'crowd', why: `went along with a crowd against ${p.name}`, gap });
    else if (p.admiration >= 0.75 && p.evidence <= 4) out.push({ name: p.name, kind: 'idol', why: `looked up to ${p.name}, who has done wrong`, gap: Math.abs(gap) + p.admiration });
    else if (p.interactions >= 3 && Math.abs(gap) >= 2.5 && seen === 0 && hearsay === 0) out.push({ name: p.name, kind: 'first_impression', why: 'a first impression the facts never bore out', gap: Math.abs(gap) });
  }
  return out
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 4)
    .map(({ gap: _gap, ...x }) => x);
}

/** One correction applied to a profile: the bias's work undone toward the facts, and inoculated against. */
export function corrected(p: SocialProfile, kind: CorrectionKind): SocialProfile {
  let grievances = p.grievances;
  if (kind === 'hearsay') grievances = grievances.filter((g) => !g.source.startsWith('told_by:'));
  if (kind === 'scapegoat') grievances = grievances.filter((g) => g.kind !== 'scapegoat');
  const sentiment = p.sentiment + (p.evidence - p.sentiment) * TOWARD_FACTS;
  const admiration = kind === 'idol' ? p.admiration * 0.5 : p.admiration;
  const bias = INOCULATES[kind];
  const inoculated = [...new Set([...(p.inoculated ?? []), bias])];
  return { ...p, grievances, sentiment: Math.min(10, Math.max(0, sentiment)), admiration, inoculated };
}

/** §18.6: applied with probability rationality; the stubborn resist (half as likely). */
export function acceptsCorrection(rationality: number, traits: readonly string[], roll: number): boolean {
  const stubborn = traits.some((t) => /stubborn|obstinate|pig-?headed|closed-?minded/i.test(t));
  return roll < rationality * (stubborn ? 0.5 : 1);
}

export interface ReflectionOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: AgentName;
  levers: () => MindLevers;
  rng?: () => number;
  now?: () => number;
}

export class Reflection {
  private timer: NodeJS.Timeout | null = null;
  private watch: NodeJS.Timeout | null = null;
  private stopped = false;
  private stirred = false;
  private mobsSeen: number;
  private readonly flight = new SingleFlight<void>();
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(private readonly o: ReflectionOptions) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
    this.mobsSeen = o.store.state.growth.mobParticipations;
  }

  start(): void {
    this.schedule();
    // After a strong feeling, think it over once calm again.
    this.watch = setInterval(() => {
      const a = this.o.store.state.emotions.arousal;
      if (a >= STRONG) this.stirred = true;
      else if (this.stirred && a < CALM) {
        this.stirred = false;
        this.kick('calm again after a strong feeling');
      }
    }, 5000);
    this.watch.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watch) clearInterval(this.watch);
    this.timer = null;
    this.watch = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const every = this.o.levers().reflectionEveryMin * 60_000 * ladder(this.o.store.state.flags.degrade).cadence('reflection');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick('periodic');
      this.schedule();
    }, every);
    this.timer.unref();
  }

  kick(reason: string): void {
    this.flight.run('reflection', () => this.run(reason)).catch((err: unknown) => this.o.logger.warn({ module: 'reflection', err: String(err) }, 'reflection failed'));
  }

  async run(reason: string): Promise<void> {
    const s = this.o.store.state;
    // Arousal blocks reflection (§18.2); so does danger.
    if (this.stopped || s.flags.inDanger || s.emotions.arousal >= CALM) return;
    const suspects = auditCandidates(s);
    let corrections: Suspect[] = suspects;
    if (suspects.length > 0 && this.o.llm && !s.flags.codeOnly && ladder(s.flags.degrade).enabled('reflection')) {
      const guard = this.o.store.guard(SLOW_POLICY);
      try {
        const r = await this.o.llm.call<Audit>({
          tier: 'L3',
          module: 'reflection',
          agent: this.o.me,
          schema: AuditSchema,
          schemaName: 'audit',
          fallback: (): Audit => ({ corrections: suspects.map(({ name, kind, why }) => ({ who: name, kind, why })) }),
          signal: guard.signal,
          isStale: guard.isStale,
          messages: [
            {
              role: 'system',
              content: `${personaCore(s.self.persona, s.traitAnnotations)}\n\nTake a quiet moment to look again at how you feel about some people, against what you actually saw them do. A feeling can rest on hearsay (what others said), on blaming someone nobody saw do anything (scapegoat), on looking up to someone too much (idol), on going along with a crowd (crowd), or on a first impression. Name the feelings that do; leave the ones that are fair. JSON: {"corrections": [{"who": "name", "kind": "hearsay|scapegoat|idol|crowd|first_impression", "why": "..."}]}`,
            },
            { role: 'user', content: suspects.map((x) => this.describe(s, x)).join('\n\n') },
          ],
        });
        if (!r.ok && r.reason === 'stale') return;
        // Only about the people asked about: the model cannot bring in someone new.
        const asked = new Set(suspects.map((x) => x.name));
        corrections = r.value.corrections.filter((c) => asked.has(c.who)).map((c) => ({ name: c.who, kind: c.kind, why: c.why }));
      } finally {
        guard.dispose();
      }
    }
    if (this.stopped) return;
    this.apply(corrections, reason);
  }

  /** What the agent knows of one person, for the audit: the gut, the facts, and where the grudges came from. */
  private describe(s: AgentState, x: Suspect): string {
    const p = s.social[x.name];
    if (!p) return `${x.name}: nothing known.`;
    const told = p.grievances.filter((g) => g.source.startsWith('told_by:')).map((g) => `${g.note ?? g.kind} (${g.source.replace('told_by:', 'told by ')})`);
    const seen = p.grievances.filter((g) => g.source === 'self_observed').map((g) => g.note ?? g.kind);
    const said = s.heardOpinions.filter((o) => o.target === x.name).slice(-3).map((o) => `${o.speaker} spoke ${o.valence < 0 ? 'badly' : 'well'} of them`);
    return [
      `${x.name}: you feel ${p.sentiment.toFixed(1)}/10 about them; what they actually did to you comes to ${p.evidence.toFixed(1)}/10; you admire them ${Math.round(p.admiration * 100)}%.`,
      seen.length > 0 ? `Seen yourself: ${seen.join('; ')}.` : 'Seen yourself: nothing against them.',
      told.length > 0 ? `Heard from others: ${told.join('; ')}.` : '',
      said.length > 0 ? `${said.join('; ')}.` : '',
      `It may be: ${x.why}.`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private apply(corrections: readonly Suspect[], reason: string): void {
    const t = this.now();
    const s = this.o.store.state;
    const traits = s.self.persona.traits;
    let applied = 0;
    let crowd = false;
    for (const c of corrections) {
      const p = this.o.store.state.social[c.name];
      if (!p) continue;
      if (!acceptsCorrection(rationalityOf(this.o.store.state), traits, this.rng())) {
        this.o.logger.info({ module: 'reflection', who: c.name, kind: c.kind, reason }, 'not convinced');
        continue;
      }
      const next = corrected(p, c.kind);
      this.o.store.update('social', (all) => ({ ...all, [c.name]: next }), `reflection: ${c.kind} about ${c.name}`);
      pushWorkmem(this.o.store, SAYS[c.kind](c.name), 0.6, 'reflection', { aboutAgent: c.name, now: t });
      this.o.logger.info({ module: 'reflection', who: c.name, kind: c.kind, why: c.why, sentiment: [Number(p.sentiment.toFixed(1)), Number(next.sentiment.toFixed(1))] }, 'corrected a belief');
      applied++;
      if (c.kind === 'crowd') crowd = true;
    }
    // Growth (§18.6): self-corrections make one a little more rational; mobs not thought better of, more conformist.
    const g = this.o.store.state.growth;
    const mobs = g.mobParticipations - this.mobsSeen;
    this.mobsSeen = g.mobParticipations;
    const persona = s.self.persona.mind;
    const rationalityBonus = Math.min(MAX_GROWTH, Math.min(1 - persona.rationality, g.rationalityBonus + 0.02 * applied));
    const conformityBonus = crowd || mobs <= 0 ? g.conformityBonus : Math.min(MAX_GROWTH, Math.min(1 - persona.conformity, g.conformityBonus + 0.01 * mobs));
    if (applied > 0 || conformityBonus !== g.conformityBonus) {
      this.o.store.update('growth', (x) => ({ ...x, rationalityBonus, conformityBonus, selfCorrections: x.selfCorrections + applied }), 'reflection');
    }
  }
}
