// Reflection as debiasing (§18.6; the bias audit of module 12, L3). Every `reflectionEveryMin` minutes (8–25, by
// intelligence; twice as long under quota pressure), and once calm again after a strong feeling, the agent looks
// again at its strongest feelings about people against what it has actually seen of them: a dislike that rests on
// hearsay, someone blamed without cause, an idol who did wrong, going along with a crowd, a first impression. Each
// correction is applied with probability rationality (the stubborn resist), and inoculates against that bias about
// that person for the rest of the life (×0.5 susceptibility). Every correction applied adds a little rationality
// (+0.02, up to +0.2); mobs joined and not thought better of afterwards add a little conformity (+0.01 each, up to
// +0.2). Without a model the audit is code: the same candidates, each taken as its own correction.
//
// Reflection also notices how the agent has changed (§7 evolution, M10): what has happened to it that would change
// anyone (robbed, beaten, a fight won, a partner or parent lost, a child of its own, promises broken, made to pay,
// often helped, its own judgments found unfair) is weighed at most once an hour, and L3 may write a trait annotation
// from it ("has grown wary of strangers since being robbed"). The annotation joins the persona prompt as how it has
// changed lately (the five latest) and its memory; the persona itself is never rewritten. Without a model, code's own
// words for the strongest such experience stand. Each experience is weighed once in a life.

import type { AgentName, AgentState, Inoculable, Logger, SocialProfile } from '@agora/shared';
import { type LlmClient, SingleFlight } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { rationalityOf } from '../mind/biases';
import { SLOW_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { NOT_PG_RE } from '../social/romance';
import { pushWorkmem } from '../state/workmem';
import type { MindLevers } from './levers';
import { personaCore } from './prompts';
import { isOff } from '../state/switches';

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

/** Something that may have changed who the agent is (§7 evolution), as code finds it in what it lived through. */
export interface Formative {
  /** The kind of experience; each is weighed once in a life (growth.evolved). */
  key: string;
  /** What happened, for the model. */
  what: string;
  /** How it would change most people, in code's words: the annotation when there is no model. */
  becomes: string;
  weight: number;
}

export const AnnotationSchema = z.object({
  /** Which experience it comes from, or null if none of them changed the agent. */
  key: z.string().max(40).nullable(),
  annotation: z.string().max(200).nullable(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

/** Trait annotations kept (the persona prompt's "how you have changed lately"). */
export const MAX_ANNOTATIONS = 5;
const ANNOTATE_EVERY_MS = 60 * 60_000;
/** A few promises broken, tributes paid, favours done, judgments corrected, before they shape someone. */
const MANY = 2;
const OFTEN_HELPED = 3;
const CORRECTED = 3;

/** The experiences that may have changed the agent and haven't been weighed yet, the most formative first. */
export function formativeExperiences(s: AgentState): Formative[] {
  const me = s.self.username;
  const done = new Set(s.growth.evolved ?? []);
  const out = new Map<string, Formative>();
  const add = (f: Formative) => {
    if (!done.has(f.key) && (out.get(f.key)?.weight ?? -1) < f.weight) out.set(f.key, f);
  };
  for (const p of Object.values(s.social)) {
    if (p.name === me) continue;
    const kinds = new Set(p.grievances.map((g) => g.kind));
    const seen = new Set(p.grievances.filter((g) => g.source === 'self_observed').map((g) => g.kind));
    if (kinds.has('killed_partner')) add({ key: 'lost_partner', what: `${p.name} killed your partner`, becomes: 'has grown hard and watchful since losing a partner', weight: 5 });
    if (kinds.has('killed_parent')) add({ key: 'lost_parent', what: `${p.name} killed your parent`, becomes: 'has had to grow up fast since losing a parent', weight: 5 });
    if (p.kin === 'child') add({ key: 'parent', what: `you became a parent (${p.name})`, becomes: 'has grown more protective since becoming a parent', weight: 3 });
    if (seen.has('theft')) add({ key: 'robbed', what: `${p.name} stole from you`, becomes: 'has grown wary of strangers since being robbed', weight: 2 });
    if (p.lastFight?.outcome === 'yielded') add({ key: 'beaten', what: `${p.name} beat you in a fight`, becomes: 'has grown careful about picking fights since being beaten', weight: 2 });
    if (p.lastFight?.outcome === 'won') add({ key: 'bold', what: `you beat ${p.name} in a fight`, becomes: 'has grown bolder since winning a fight', weight: 1.5 });
  }
  const owed = s.commitments.filter((c) => c.creditor === me && c.debtor !== me);
  const broken = owed.filter((c) => c.status === 'broken').length;
  if (broken >= MANY) add({ key: 'let_down', what: `${broken} promises made to you were broken`, becomes: 'has grown slow to trust promises since being let down', weight: 1.5 });
  const helped = owed.filter((c) => c.status === 'fulfilled' && !c.coerced).length;
  if (helped >= OFTEN_HELPED) add({ key: 'helped', what: `others kept ${helped} promises to you`, becomes: 'has grown warmer toward others since being helped', weight: 1 });
  const paid = s.commitments.filter((c) => c.debtor === me && c.coerced && c.status === 'fulfilled').length;
  if (paid >= MANY) add({ key: 'coerced', what: `you were made to pay ${paid} times`, becomes: 'has grown quiet and resentful since being made to pay', weight: 2 });
  if (s.growth.selfCorrections >= CORRECTED) add({ key: 'self_corrections', what: `you found ${s.growth.selfCorrections} of your judgments of people unfair`, becomes: 'has learned to look twice before judging people', weight: 1 });
  return [...out.values()].sort((a, b) => b.weight - a.weight);
}

/** An annotation as it may be kept: short, about the agent in the third person, plain and PG; null if not. */
export function cleanAnnotation(raw: string, name: string): string | null {
  let t = raw.trim().replace(/\s+/g, ' ').replace(/^["'“]+|["'”.!]+$/g, '');
  if (t.toLowerCase().startsWith(`${name.toLowerCase()} `)) t = t.slice(name.length + 1);
  if (t.length < 8 || t.length > 100) return null;
  if (/\b(i|me|my|mine|myself|you|your|yours|yourself)\b/i.test(t) || NOT_PG_RE.test(t)) return null;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

const ANNOTATE_RULES = `Look back at what has happened to you lately. Has any of it changed you? If so, write one short note about how, in the third person and without your name, the way a friend who knows you would put it, in your own words: "has grown <how> since <what happened>". At most 100 characters, plain words, nothing crude. If none of it changed you, say so with null.
JSON: {"key": "the name of the experience it comes from, as listed before its colon", "annotation": "has ..."} or {"key": null, "annotation": null}`;

/**
 * The experience a model's note comes from: the key as listed, or as the model put it in its own words ("robbed by
 * Zed", "lost parent", what happened). With a single experience, that one.
 */
export function experienceFor(found: readonly Formative[], key: string | null): Formative | undefined {
  if (key === null) return undefined;
  const k = key.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const said = key.trim().toLowerCase();
  return (
    found.find((x) => x.key === k) ??
    found.find((x) => k.includes(x.key) || said.includes(x.what.toLowerCase())) ??
    (found.length === 1 ? found[0] : undefined)
  );
}

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
    // A dislike that drifted from the facts, or a grudge that is only what we were told: hearsay either way.
    else if ((gap >= 1.5 || hearsay >= 0.1) && (hearsay > seen || (badTalk && seen === 0))) out.push({ name: p.name, kind: 'hearsay', why: `what others said, not what ${p.name} did`, gap: Math.max(gap, hearsay * 5) });
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
  private annotatedAt = -Infinity;
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
    const every = this.o.levers().reflectionEveryMin * 60_000;
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
    if (this.stopped || s.flags.inDanger || isOff(s, 'reflection') || s.emotions.arousal >= CALM) return;
    const suspects = auditCandidates(s);
    let corrections: Suspect[] = suspects;
    if (suspects.length > 0 && this.o.llm) {
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
    await this.annotate();
  }

  /** §7 evolution: at most once an hour, how what happened to the agent has changed it (a trait annotation). */
  async annotate(): Promise<void> {
    const t = this.now();
    const s = this.o.store.state;
    if (this.stopped || isOff(s, 'reflection') || t - this.annotatedAt < ANNOTATE_EVERY_MS) return;
    const found = formativeExperiences(s).slice(0, 3);
    const top = found[0];
    if (!top) return;
    this.annotatedAt = t;
    let pick: { weighed: string[]; text: string | null; key: string } = { weighed: [top.key], text: top.becomes, key: top.key };
    if (this.o.llm) {
      const guard = this.o.store.guard(SLOW_POLICY);
      try {
        const r = await this.o.llm.call<Annotation>({
          tier: 'L3',
          module: 'reflection',
          agent: this.o.me,
          schema: AnnotationSchema,
          schemaName: 'annotation',
          fallback: (): Annotation => ({ key: top.key, annotation: top.becomes }),
          signal: guard.signal,
          isStale: guard.isStale,
          messages: [
            { role: 'system', content: `${personaCore(s.self.persona, s.traitAnnotations)}\n\n${ANNOTATE_RULES}` },
            { role: 'user', content: found.map((f) => `- ${f.key}: ${f.what}`).join('\n') },
          ],
        });
        if (!r.ok && r.reason === 'stale') {
          this.annotatedAt = -Infinity;
          return;
        }
        const f = experienceFor(found, r.value.key);
        // None of it changed them: all of it weighed, nothing kept. A note that won't do gives way to code's words.
        if (!f || r.value.annotation === null) pick = { weighed: found.map((x) => x.key), text: null, key: '' };
        else pick = { weighed: [f.key], text: cleanAnnotation(r.value.annotation, s.self.persona.name) ?? f.becomes, key: f.key };
      } finally {
        guard.dispose();
      }
    }
    if (this.stopped) return;
    this.o.store.update('growth', (g) => ({ ...g, evolved: [...new Set([...(g.evolved ?? []), ...pick.weighed])] }), 'reflection: weighed');
    const text = pick.text;
    if (!text) {
      this.o.logger.info({ module: 'reflection', weighed: pick.weighed }, 'unchanged by it');
      return;
    }
    this.o.store.update('traitAnnotations', (a) => [...a.filter((x) => x !== text), text].slice(-MAX_ANNOTATIONS), 'trait annotation');
    pushWorkmem(this.o.store, `How I have changed: ${text}.`, 0.9, 'reflection', { now: t });
    this.o.logger.info({ module: 'reflection', from: pick.key, annotation: text }, 'trait annotation');
    this.o.bus.emit({ type: 'traitAnnotated', text });
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
