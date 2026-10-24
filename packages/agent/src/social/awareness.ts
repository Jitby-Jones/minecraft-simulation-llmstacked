// Social Awareness (§4.2, §6.3, §6.4): keeps the profile of everyone this agent has met. After a conversation, one
// batched L2 call (never one per line) turns the transcript into a sentiment change (±2), what they seem to want,
// their role, new facts, a short summary, how much their manner grates (friction, §17.3) and what they said about
// third parties (heard opinions, §18.4.1). A separate L1 pass extracts what they promised us (§6.4) when a line of
// theirs sounds like a promise. Notable deeds use code-only deltas; sentiment drifts back to the persona's baseline.

import {
  type AgentName,
  type Commitment,
  type ConversationState,
  type HeardOpinion,
  type Logger,
  type Persona,
  type SocialProfile,
  type Utterance,
  withoutOpeningName,
} from '@agora/shared';
import { type LlmClient, SingleFlight } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { personaCore } from '../modules/prompts';
import { looksLikePromise } from '../modules/talking';
import { newSocialProfile } from '../state/social';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import { parentsWhileYoung } from '../state/youth';
import { confirmationScaled, conformityOf, conformityPull, heardConsensus, inoculation, pulledSentiment, rationalityOf, susceptibilityToward } from '../mind/biases';
import { DEED_DELTAS, type Deed, GRIEVANCE_WEIGHT, TRUST_DELTAS, driftSentiment, withEvidence, withGrievance, withSentiment, withTrust } from './math';
import { type ToldDeed, namedIn, readDeeds, readOpinions } from './opinions';
import { parseDemand, parseFightPromise } from '../conflict/coercion';
import { itemMatcher } from '../body/items';

export const SocialUpdateSchema = z.object({
  sentimentDelta: z.number().min(-2).max(2).default(0),
  frictionDelta: z.number().min(-0.3).max(0.3).default(0),
  frictionReason: z.string().max(120).default(''),
  perceivedGoals: z.array(z.string().min(1).max(80)).max(3).default([]),
  perceivedRole: z.string().max(40).optional(),
  facts: z.array(z.string().min(1).max(160)).max(3).default([]),
  summary: z.string().max(500).default(''),
  /** What they said about other people: valence −1 (very negative) … 1. */
  opinions: z.array(z.object({ target: z.string().min(1).max(16), valence: z.number().min(-1).max(1) })).max(5).default([]),
  /** They insulted me (an appraisal event for emotions, §18.2). */
  insultedMe: z.boolean().default(false),
  /** How clever they came across, 0..1 (§21.4 perceived intelligence). */
  seemedClever: z.number().min(0).max(1).optional(),
  /** §19.1: the sex they came across as, from what they said of themselves or how others spoke of them. */
  theirSex: z.enum(['male', 'female', 'unknown']).default('unknown'),
  /** §19.2: how well we'd get on as partners, from what was perceived of them (values, humor, energy), 0..1. */
  compatibility: z.number().min(0).max(1).optional(),
});
export type SocialUpdate = z.infer<typeof SocialUpdateSchema>;

const KINDS = ['give', 'gather', 'meet', 'help', 'build', 'follow', 'fight', 'custom'] as const;
/** An uprising agreed to (§17.8) waits this long for its moment before it lapses. */
const FIGHT_DUE_SEC = 30 * 60;
export const PromisesSchema = z.object({
  promises: z
    .array(
      z.object({
        what: z.object({
          kind: z.enum(KINDS),
          item: z.string().max(40).optional(),
          qty: z.number().int().min(1).max(256).optional(),
          target: z.string().min(1).max(32).optional(),
          text: z.string().min(1).max(160),
        }),
        dueInSec: z.number().int().min(10).max(24 * 3600).optional(),
      }),
    )
    .max(4)
    .default([]),
});
export type Promises = z.infer<typeof PromisesSchema>;

let seq = 0;
const newId = (p: string, now: number) => `${p}${now.toString(36)}${(seq++).toString(36)}`;

const POSITIVE = /\b(thanks|thank you|great|nice|awesome|love|appreciate|cheers|good job|well done)\b/i;
const NEGATIVE = /\b(idiot|stupid|shut up|hate|liar|thief|useless|go away|loser|jerk)\b/i;

/** The code default after a conversation: a small sentiment step from tone words (no LLM). */
export function codeSocialUpdate(theirLines: readonly string[]): SocialUpdate {
  const pos = theirLines.filter((t) => POSITIVE.test(t)).length;
  const neg = theirLines.filter((t) => NEGATIVE.test(t)).length;
  return SocialUpdateSchema.parse({
    sentimentDelta: Math.max(-2, Math.min(2, 0.3 * pos - 0.6 * neg + (theirLines.length > 0 ? 0.1 : 0))),
    insultedMe: neg > 0,
  });
}

const NUM = /\b(\d{1,3})\b/;
const ITEMISH = /\b(?:\d{1,3}\s+)?([a-z_]{3,24}?)s?\b(?=[\s,.!?]|$)/i;

/**
 * The code default for a promise someone made us: "I'll bring you 8 logs" → give 8 logs; "I'll fight Rex with you"
 * → a fight against Rex (§17.8), when Rex is someone we know of.
 */
export function codePromises(theirLines: readonly string[], known: readonly AgentName[] = []): Promises {
  const isName = (w: string) => known.some((n) => n.toLowerCase() === w.toLowerCase());
  const promises = theirLines
    .filter((t) => looksLikePromise(t))
    .slice(0, 2)
    .map((line) => {
      // "Rex, fine. I'll give you 3 bread": the promise is what follows the name.
      const t = withoutOpeningName(line, isName);
      const foe = parseFightPromise(t, known);
      if (foe) return { what: { kind: 'fight' as const, target: foe, text: t.slice(0, 160) }, dueInSec: FIGHT_DUE_SEC };
      const m = /\b(?:bring|give|get|fetch|grab)\s+(?:you\s+)?(?:some\s+|the\s+|a\s+|an\s+|those\s+|these\s+)?(\d{1,3})?\s*([a-z_]{3,24})/i.exec(t);
      const qty = m?.[1] ? Number(m[1]) : NUM.exec(t)?.[1] ? Number(NUM.exec(t)?.[1]) : undefined;
      const item = m?.[2] ?? ITEMISH.exec(t)?.[1];
      return m ? { what: { kind: 'give' as const, ...(item ? { item: item.toLowerCase().replace(/s$/, '') } : {}), ...(qty ? { qty } : {}), text: t.slice(0, 160) } } : { what: { kind: 'custom' as const, text: t.slice(0, 160) } };
    });
  return { promises };
}

/** Two names for what is asked and promised are the same thing: "logs" and "log", "oak_log" and "log". */
export function sameItem(a: string, b: string): boolean {
  return a === b || itemMatcher(a).matches(b) || itemMatcher(b).matches(a);
}

export interface SocialAwarenessOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: AgentName;
  /** How long after a conversation ends to read it, so a last reply heard after the end is included. */
  settleMs?: number;
  /**
   * System 2 and fear (§18.4, §18.5): biases weaken as the override grows; fear makes people conform. A leader's or
   * an idol's word counts for more (authority), and those of our own group get the benefit of the doubt (in-group).
   */
  mind?: { override(): number; fearLevel(): number; authorityOf?(name: AgentName): number; ingroup?(name: AgentName): boolean };
  now?: () => number;
}

const SETTLE_MS = 8000;
/** Giving in to a demand of ours this long after it was made still counts as giving in to it. */
const DEMAND_HEARD_MS = 10 * 60_000;

export class SocialAwareness {
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly settling = new Set<NodeJS.Timeout>();
  private readonly now: () => number;

  constructor(private readonly o: SocialAwarenessOptions) {
    this.now = o.now ?? Date.now;
  }

  private get persona(): Persona {
    return this.o.store.state.self.persona;
  }

  start(): void {
    this.offs.push(
      this.o.bus.on('conversationEnded', (e) => {
        const t = setTimeout(() => {
          this.settling.delete(t);
          const conv = this.o.store.state.conversations[e.convId];
          if (conv) this.flight.run(`conv:${e.convId}`, () => this.afterConversation(conv)).catch((err: unknown) => this.o.logger.warn({ module: 'social', err: String(err) }, 'reading the conversation failed'));
        }, this.o.settleMs ?? SETTLE_MS);
        t.unref();
        this.settling.add(t);
      }),
    );
    // §17.7: giving in to a demand of ours is taken down as it is said; two paid in one conversation are two.
    this.offs.push(this.o.bus.on('addressed', (e) => this.onGivingIn(e.utterance)));
    // §18.4.1: what people say about each other, from every line heard (the L2 read adds more at the end).
    this.offs.push(
      this.o.bus.on('heard', (e) => {
        const u = e.utterance;
        if (u.from === this.o.me) return;
        const s = this.o.store.state;
        // Those we know of, those around, and anyone a warning names (a stranger's name first heard).
        const known = [...new Set([...Object.keys(s.social), ...s.perception.nearbyEntities.filter((x) => x.kind === 'player').map((x) => x.name), ...namedIn(u.text)])].filter((n) => n !== this.o.me);
        const ops = readOpinions(u.text, u.from, known, this.now());
        if (ops.length > 0) this.heard(ops);
        for (const d of readDeeds(u.text, u.from, known)) this.toldOf(d);
      }),
    );
    // §6.3 decay toward the baseline, checked once a minute.
    this.timer = setInterval(() => this.drift(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.settling) clearTimeout(t);
    this.settling.clear();
    for (const off of this.offs.splice(0)) off();
  }

  /** The profile of `name`, created on first need. */
  profile(name: AgentName): SocialProfile {
    return this.o.store.state.social[name] ?? newSocialProfile(name, this.persona, this.now());
  }

  /**
   * §17.8 hearsay grievances: a wrong we were told of is stored as told by the speaker, at half the weight of one
   * seen (scaled down further for a speaker we don't trust), once an hour per telling.
   */
  private toldOf(d: ToldDeed): void {
    if (d.target === this.o.me || d.target === d.speaker) return;
    const s = this.o.store.state;
    const friendKilled = d.deed === 'kill' && d.victim !== undefined && (s.social[d.victim]?.sentiment ?? 5) >= 7;
    const kind = d.deed === 'theft' ? 'theft' : d.deed === 'lie' ? 'betrayal' : friendKilled ? 'killed_friend' : 'attack';
    const verb = { theft: 'stole', attack: 'attacked', kill: 'killed', lie: 'lied' }[d.deed];
    const note = `${d.speaker} says ${d.target} ${verb}${d.victim ? ` ${d.victim}` : ''}`;
    const p = this.profile(d.target);
    const t = this.now();
    if (p.grievances.some((g) => g.note === note && t - g.ts < 3_600_000)) return;
    // A rumor about someone we already saw through on reflection (§18.6) counts half.
    const credence = Math.min(1, Math.max(0.2, (s.social[d.speaker]?.trust ?? 0.5) * 2)) * inoculation(s, 'conformity', d.target);
    // withGrievance takes the unwitnessed down to 0.6 of the weight; together, half of a wrong seen.
    this.write(withGrievance(p, kind, this.persona, { now: t, witnessed: false, source: `told_by:${d.speaker}`, note, weight: ((GRIEVANCE_WEIGHT[kind] * 0.5) / 0.6) * credence }), `told: ${note}`);
  }

  private write(p: SocialProfile, reason: string): void {
    this.o.store.update('social', (all) => ({ ...all, [p.name]: p }), reason);
  }

  private override(): number {
    return this.o.mind?.override() ?? 0;
  }

  /**
   * §18.5: a rational mind's feeling about someone drifts toward what they have actually done (the gap between a
   * first impression and the facts closes after a few interactions for the rational, hardly at all for the rest).
   */
  private aligned(p: SocialProfile): SocialProfile {
    const r = rationalityOf(this.o.store.state);
    return { ...p, sentiment: Math.min(10, Math.max(0, p.sentiment + (p.evidence - p.sentiment) * r * 0.15)) };
  }

  /**
   * Heard opinions (§18.4.1): recorded, and our view of each target pulled toward what people say. While we are
   * young (§19.5), our parents' word counts double, and conformity toward them is ×1.5.
   */
  private heard(ops: readonly HeardOpinion[]): void {
    this.o.store.update('heardOpinions', (all) => [...all, ...ops].slice(-60), 'heard opinions');
    const s = this.o.store.state;
    const pull = conformityPull(conformityOf(s), this.o.mind?.fearLevel() ?? 0, this.override());
    const parents = parentsWhileYoung(s, this.now());
    for (const target of new Set(ops.map((o) => o.target))) {
      if (target === this.o.me) continue;
      const p = this.profile(target);
      const weight = (spk: AgentName) => ((s.social[spk]?.trust ?? 0.5) + (s.social[spk]?.admiration ?? 0) + (this.o.mind?.authorityOf?.(spk) ?? 0)) * (parents.includes(spk) ? 2 : 1);
      const consensus = heardConsensus(s.heardOpinions, target, weight, this.now());
      if (consensus === null) continue;
      const fromParents = ops.some((o) => o.target === target && parents.includes(o.speaker));
      const next = pulledSentiment(p.sentiment, consensus, pull * (fromParents ? 1.5 : 1) * inoculation(s, 'conformity', target));
      if (Math.abs(next - p.sentiment) >= 0.05) this.write({ ...p, sentiment: next }, `what people say about ${target}`);
    }
  }

  /** A notable deed with a code-only delta (§6.3 rule 2). */
  deed(name: AgentName, deed: Deed, note?: string): void {
    if (name === this.o.me) return;
    const p = this.aligned(withEvidence(withSentiment(this.profile(name), DEED_DELTAS[deed], this.persona, this.now()), DEED_DELTAS[deed]));
    this.write(p, `deed ${deed}`);
    if (note) pushWorkmem(this.o.store, note, deed === 'attackedMe' ? 0.85 : 0.5, 'self_observed', { aboutAgent: name, now: this.now() });
  }

  /** A gut feeling about someone shifts (a bias at work, §18.4): sentiment only, never the evidence. */
  nudge(name: AgentName, delta: number, note: string): void {
    if (name === this.o.me) return;
    this.write(withSentiment(this.profile(name), delta, this.persona, this.now()), 'a gut feeling');
    pushWorkmem(this.o.store, note, 0.5, 'self_observed', { aboutAgent: name, now: this.now() });
  }

  /** A commitment was resolved (§6.3 rule 3): kept → trust +0.1, sentiment +0.5; broken → trust −0.2, sentiment −1. */
  promiseResolved(c: Commitment, kept: boolean): void {
    const other = c.debtor === this.o.me ? c.creditor : c.debtor;
    if (c.debtor === this.o.me) return; // our own promises change how others see us, not how we see them
    let p = this.profile(other);
    p = withTrust(p, kept ? TRUST_DELTAS.keptPromise : TRUST_DELTAS.brokePromise);
    p = withSentiment(p, kept ? DEED_DELTAS.keptPromise : DEED_DELTAS.brokePromise, this.persona, this.now());
    p = this.aligned(withEvidence(p, kept ? DEED_DELTAS.keptPromise : DEED_DELTAS.brokePromise));
    p = { ...p, promisesKept: p.promisesKept + (kept ? 1 : 0), promisesBroken: p.promisesBroken + (kept ? 0 : 1) };
    this.write(p, kept ? 'promise kept' : 'promise broken');
    pushWorkmem(this.o.store, kept ? `${other} kept their promise: ${c.what.text}` : `${other} broke their promise: ${c.what.text}`, kept ? 0.55 : 0.75, 'self_observed', { aboutAgent: other, now: this.now() });
  }

  /** A claim they made turned out false (§6.5): trust drops, and they seem more cunning than we thought (§21.4). */
  claimFailed(name: AgentName): void {
    const p = withEvidence(withTrust(this.profile(name), TRUST_DELTAS.falseClaim), -0.5);
    this.write({ ...p, estIntelligence: Math.min(1, p.estIntelligence + 0.05) }, 'false claim');
  }

  private drift(): void {
    const now = this.now();
    const s = this.o.store.state;
    const changed: Record<string, SocialProfile> = {};
    for (const p of Object.values(s.social)) {
      if (now - p.lastSeen < 60_000) continue;
      const next = driftSentiment(p, this.persona, now);
      if (Math.abs(next - p.sentiment) >= 0.01) changed[p.name] = { ...p, sentiment: next, lastSeen: p.lastSeen };
    }
    if (Object.keys(changed).length > 0) this.o.store.update('social', (all) => ({ ...all, ...changed }), 'sentiment drift');
  }

  private async afterConversation(conv: ConversationState): Promise<void> {
    const partners = conv.participants.filter((n) => n !== this.o.me);
    for (const partner of partners) {
      const theirs = conv.transcript.filter((u) => u.from === partner).map((u) => u.text);
      if (theirs.length === 0) continue;
      const update = await this.socialUpdate(partner, conv);
      this.apply(partner, update);
      // In a group, a promise to someone else isn't one to us: only what they said to us counts.
      const toMe = conv.participants.length <= 2 ? theirs : conv.transcript.filter((u) => u.from === partner && (u.addressedToMe || u.heardAs === 'me')).map((u) => u.text);
      if (toMe.some((t) => looksLikePromise(t))) await this.extractPromises(partner, conv, toMe);
    }
  }

  private transcriptText(conv: ConversationState): string {
    return conv.transcript.map((u) => `${u.from === this.o.me ? 'You' : u.from}: ${u.text}`).join('\n');
  }

  private async socialUpdate(partner: AgentName, conv: ConversationState): Promise<SocialUpdate> {
    const theirs = conv.transcript.filter((u) => u.from === partner).map((u) => u.text);
    const fallback = () => codeSocialUpdate(theirs);
    const s = this.o.store.state;
    if (!this.o.llm || s.flags.codeOnly) return fallback();
    const old = this.profile(partner);
    const r = await this.o.llm.call<SocialUpdate>({
      tier: 'L2',
      module: 'social',
      agent: this.o.me,
      schema: SocialUpdateSchema,
      schemaName: 'social',
      fallback,
      messages: [
        {
          role: 'system',
          content: `${personaCore(this.persona, s.traitAnnotations)}\n\nYou just finished talking with ${partner}. Update what you think of them, as yourself (your values and temper decide how their manner strikes you). JSON: {"sentimentDelta": -2..2, "frictionDelta": -0.3..0.3, "frictionReason": "...", "perceivedGoals": ["..."], "perceivedRole": "...", "facts": ["new things you learned about them or from them"], "summary": "at most 60 words about ${partner}", "opinions": [{"target": "a name they talked about", "valence": -1..1}], "insultedMe": false, "seemedClever": 0..1, "theirSex": "male|female|unknown", "compatibility": 0..1}. theirSex: what they are as far as you can tell, from what they said of themselves, the he or she others used for them, or their name; unknown if you can't tell. compatibility: how well you two would get on as partners (shared values and humor, an energy that suits yours), from what you saw of them; leave it out if you can't tell.`,
        },
        {
          role: 'user',
          content: [
            `Before: you felt ${Math.round(old.sentiment)}/10 about ${partner}, trust ${old.trust.toFixed(1)}. ${old.summary || 'You barely know them.'}`,
            old.facts.length > 0 ? `Known about them: ${old.facts.map((f) => f.text).join('; ')}` : '',
            `Conversation:\n${this.transcriptText(conv)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
    return r.value;
  }

  private apply(partner: AgentName, u: SocialUpdate): void {
    const now = this.now();
    const before = this.profile(partner);
    // §18.4 confirmation: what fits how we already feel counts more, what goes against it less.
    // §18.4 in-group: one of our own gets a little warmth on top (the gut only).
    const warmth = this.o.mind?.ingroup?.(partner) ? 0.3 * susceptibilityToward(this.o.store.state, 'ingroup', partner) * (1 - this.override()) : 0;
    const delta = confirmationScaled(u.sentimentDelta, before.sentiment, susceptibilityToward(this.o.store.state, 'confirmation', partner), this.override()) + warmth;
    let p = withEvidence(withSentiment(before, delta, this.persona, now), u.sentimentDelta * 0.5);
    const facts = [...p.facts, ...u.facts.map((text) => ({ text, source: 'told' as const, ts: now }))].slice(-10);
    p = {
      ...p,
      friction: Math.max(0, Math.min(1, p.friction + u.frictionDelta)),
      perceivedGoals: u.perceivedGoals.length > 0 ? u.perceivedGoals.slice(0, 3) : p.perceivedGoals,
      ...(u.perceivedRole ? { perceivedRole: u.perceivedRole } : {}),
      facts,
      summary: u.summary ? u.summary.split(/\s+/).slice(0, 60).join(' ') : p.summary,
      // §21.4: how clever they seem builds up over conversations.
      ...(u.seemedClever !== undefined ? { estIntelligence: p.estIntelligence + (u.seemedClever - p.estIntelligence) * 0.25 } : {}),
      // §19.1, §19.2: what they are, once it's clear; how well we'd get on, first judged, then refreshed.
      ...(u.theirSex !== 'unknown' && p.perceivedSex === 'unknown' ? { perceivedSex: u.theirSex } : {}),
      ...(u.compatibility !== undefined
        ? { estTraits: { ...p.estTraits, compatibility: Math.round((p.estTraits.compatibility === undefined ? u.compatibility : p.estTraits.compatibility + (u.compatibility - p.estTraits.compatibility) * 0.3) * 100) / 100 } }
        : {}),
    };
    // §17.3: lasting friction wears sentiment down slowly.
    if (p.friction > 0.5) p = { ...p, sentiment: Math.max(0, p.sentiment - 0.2) };
    this.write(this.aligned(p), `talked with ${partner}`);
    const opinions: HeardOpinion[] = u.opinions
      .filter((o) => o.target !== partner)
      .map((o) => ({ speaker: partner, target: o.target === 'you' || o.target === 'me' ? this.o.me : o.target, valence: o.valence, ts: now }));
    if (opinions.length > 0) this.heard(opinions);
    if (u.insultedMe) this.o.bus.emit({ type: 'insulted', by: partner });
    this.o.logger.info({ module: 'social', partner, delta: u.sentimentDelta, sentiment: p.sentiment, friction: p.friction }, 'social update');
  }

  /** §6.4: promises the partner made to us become accepted commitments (L1, or code). */
  /** What we demanded of them lately (§17.7), in this conversation or an earlier one, oldest first. */
  private demandsOf(name: AgentName, until: number): { item: string; ts: number }[] {
    const out: { item: string; ts: number }[] = [];
    for (const c of Object.values(this.o.store.state.conversations)) {
      if (!c.participants.includes(name)) continue;
      for (const x of c.transcript) {
        if (x.from !== this.o.me || x.ts > until || until - x.ts > DEMAND_HEARD_MS) continue;
        const d = parseDemand(x.text);
        if (d) out.push({ item: d.item, ts: x.ts });
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Their answer to a demand we made of them lately (§17.7): a promise to give the demanded item is a coerced
   * commitment, recorded at once. One per demand: a payment restated isn't paid twice.
   */
  private onGivingIn(u: Utterance): void {
    const s = this.o.store.state;
    const conv = u.convId ? s.conversations[u.convId] : undefined;
    if (!conv || u.from === this.o.me || !looksLikePromise(u.text)) return;
    const demands = this.demandsOf(u.from, u.ts);
    const last = demands[demands.length - 1];
    if (!last) return;
    const first = demands[0]?.ts ?? u.ts;
    const taken = s.commitments.filter((c) => c.coerced && c.debtor === u.from && c.creditor === this.o.me && c.createdAt >= first);
    if (taken.length >= demands.length) return;
    const pr = codePromises([u.text], [...Object.keys(s.social), this.o.me]).promises[0];
    const item = pr?.what.kind === 'give' ? pr.what.item : undefined;
    if (!pr || !item || !sameItem(last.item, item)) return;
    const now = this.now();
    const k: Commitment = { id: newId('k', now), debtor: u.from, creditor: this.o.me, what: pr.what, dueBy: now + 600_000, status: 'accepted', createdFromConv: conv.convId, createdAt: now, coerced: true };
    this.o.store.update('commitments', (all) => [...all, k], `${u.from} gave in`);
    pushWorkmem(this.o.store, `${u.from} gave in to me: ${k.what.text}`, 0.6, `told_by:${u.from}`, { aboutAgent: u.from, now });
    this.o.logger.info({ module: 'social', partner: u.from, promise: k.what }, 'gave in to our demand');
  }

  private async extractPromises(partner: AgentName, conv: ConversationState, theirs: readonly string[]): Promise<void> {
    const fallback = () => codePromises(theirs, [...Object.keys(this.o.store.state.social), this.o.me]);
    let out: Promises = fallback();
    if (this.o.llm && !this.o.store.state.flags.codeOnly) {
      const r = await this.o.llm.call<Promises>({
        tier: 'L1',
        module: 'social',
        agent: this.o.me,
        schema: PromisesSchema,
        schemaName: 'promises',
        fallback,
        messages: [
          {
            role: 'system',
            content: `List only the promises ${partner} made to you in this conversation (things ${partner} said they would do for you). JSON: {"promises": [{"what": {"kind": "give|gather|meet|help|build|follow|fight|custom", "item": "minecraft item id", "qty": 1, "target": "for fight: whom they will fight with you", "text": "what they promised"}, "dueInSec": 600}]}`,
          },
          { role: 'user', content: this.transcriptText(conv) },
        ],
      });
      out = r.value;
    }
    const now = this.now();
    // A promise said twice (or restated later) is still one promise.
    // So is one already taken down from this conversation as it was said (giving in to a demand, above).
    const open = this.o.store.state.commitments.filter(
      (c) => c.debtor === partner && c.creditor === this.o.me && (c.status === 'accepted' || c.status === 'proposed' || c.createdFromConv === conv.convId),
    );
    const key = (w: Commitment['what']) => `${w.kind}:${w.item ?? w.target ?? w.text}`;
    const seen = new Set(open.map((c) => key(c.what)));
    const fresh: Promises['promises'] = [];
    for (const pr of out.promises) {
      // A fight is against someone (§17.8); a fight against no one in particular promises nothing.
      if (pr.what.kind === 'fight' && (!pr.what.target || !this.o.store.state.social[pr.what.target])) continue;
      if (seen.has(key(pr.what))) continue;
      seen.add(key(pr.what));
      fresh.push(pr);
    }
    // What we demanded of them lately (§17.7): their giving in to it is coerced.
    const demanded = this.demandsOf(partner, now).map((d) => d.item);
    const made: Commitment[] = fresh.map((pr) => ({
      id: newId('k', now),
      debtor: partner,
      creditor: this.o.me,
      what: pr.what,
      dueBy: now + (pr.dueInSec ?? (pr.what.kind === 'fight' ? FIGHT_DUE_SEC : 600)) * 1000,
      status: 'accepted',
      createdFromConv: conv.convId,
      createdAt: now,
      ...(pr.what.item && demanded.some((d) => sameItem(d, pr.what.item ?? '')) ? { coerced: true } : {}),
    }));
    if (made.length === 0) return;
    this.o.store.update('commitments', (all) => [...all, ...made], `${partner} promised`);
    for (const k of made) pushWorkmem(this.o.store, `${partner} promised me: ${k.what.text}`, 0.6, `told_by:${partner}`, { aboutAgent: partner, now });
    this.o.logger.info({ module: 'social', partner, promises: made.map((k) => k.what) }, 'promises recorded');
  }
}
