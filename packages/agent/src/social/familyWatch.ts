// Families (§19.3–19.5), the agent's side, all code. Partners of long enough (partnerMinDays in-game days), fond of
// each other (8), with a home (two beds side by side within 16 blocks of a chest) and food put by: one asks "want to
// start a family?", and the other answers for itself. Agreed, at night both go to bed in the two beds; each that
// lies in its bed and sees its partner asleep in the one beside tells the Hub (conception), which, with both, brings
// a child after gestationSec. The child greets its parents by name ("Ned, Ivy: hi dad, hi mom!"), which is how they
// know it: nothing is told to anyone. A child in its youth keeps to a parent; parents keep their young child close
// and give it food. Who is family is kin (§19.5): the strongest in-group, and the defend reflex for them is strong.

import { type AgentName, type Logger, type Sex, type Utterance, type Vec3, GAME_DAY_MS, mentionsName, openingName } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AppraisalEvent } from '../mind/emotions';
import { EDIBLE } from '../modules/villageMove';
import { newSocialProfile } from '../state/social';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import { isYoung } from '../state/youth';

export const FAMILY_PROPOSAL = 'want to start a family?';
export const FAMILY_YES = "yes, let's start a family!";
export const FAMILY_NOT_YET = 'not yet, I think.';
/** The one who asked, hearing yes. */
export const FAMILY_HAPPY = 'that makes me so happy!';
/** Starting a family, asked or answered: "want to start a family?", "shall we have a child?" */
export const FAMILY_RE = /\b(start a family|have (a|our) (baby|child|kid)|raise a (child|kid|family))\b/i;
const YES_RE = /^\W*(?:[A-Za-z0-9_]{1,16},\s*)?(yes|yeah|of course|i'?d love (to|that)|absolutely|sure)\b/i;
/** Asked to start a family (a question), not the answer to it. */
export const isFamilyAsk = (text: string): boolean => FAMILY_RE.test(text) && text.includes('?') && !YES_RE.test(text);
/** Yes to starting a family. */
export const isFamilyYes = (text: string): boolean => FAMILY_RE.test(text) && YES_RE.test(text);
/** A child's first words to its parents. */
export const GREETING_RE = /\bhi (mom|dad|mum|mama|papa|parent)\b/i;

/** A child's first words, to its parents by name (§19.3: "Hi mom, hi dad!"). */
export function greeting(parents: readonly { name: string; sex: Sex | 'unknown' }[]): string {
  const word = (sex: Sex | 'unknown') => (sex === 'female' ? 'mom' : sex === 'male' ? 'dad' : 'parent');
  return `${parents.map((p) => p.name).join(', ')}: ${parents.map((p) => `hi ${word(p.sex)}`).join(', ')}!`;
}

/** Beds take sleepers from this time of day to this one (ticks). */
const NIGHT_FROM = 12_542;
const NIGHT_TO = 23_459;
const TICK_MS = 2000;
/** Asking again after a "not yet". */
const ASK_EVERY_MS = 10 * 60_000;
/** The answer to our question comes within this. */
const ANSWER_MS = 60_000;
/** Two beds and a chest within this make a home. */
const HOME_RADIUS = 16;
/** Our partner asleep in a bed beside ours: within this. */
const BESIDE = 3;
/** A young child of ours farther than this: go to it. */
const KEEP_CLOSE = 10;
/** A newborn's first words wait this long (the supervisor puts it at its parents' beds first). */
const GREET_AFTER_MS = 8000;
/** A parent this close is greeted in person, once. */
const GREET_RANGE = 12;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export type FamilyStep =
  | { kind: 'ask'; to: AgentName }
  | { kind: 'sleep'; near: Vec3; with: AgentName }
  | { kind: 'keepClose'; to: AgentName; why: string }
  | { kind: 'feed'; to: AgentName; item: string; qty: number }
  | { kind: 'warn'; to: AgentName; about: AgentName; line: string };

/** Resentment from which a parent warns its young child about someone. */
const WARN_RESENTMENT = 0.5;

/** A parent's warning to its child: who, and what they did if that's short to say (§19.5 culture and grudges). */
export function warnLine(about: AgentName, deed?: string): string {
  const told = deed && deed.startsWith(about) && deed.length <= 60 ? deed.replace(/[.!]+$/, '') : `${about} is a bully`;
  return `watch out for ${about}. ${told}.`;
}

/** What the CC asks of the family watch. */
export interface FamilyView {
  /** The next thing to do for the family, if any (the code default's family step). */
  step(): FamilyStep | null;
  /** Whether we'd say yes to starting a family with them now; otherwise why not. */
  whyNotFamily(name: AgentName): string | null;
  young(): boolean;
}

export interface FamilyOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** reproduction.enabled (§19.7). */
  enabled: boolean;
  config: { partnerMinDays: number; coupleCooldownSec: number; minFoodItems: number; youthSec: number };
  /** How we feel about someone, 0..10 (gut and facts, §18.5). */
  liking: (name: AgentName) => number;
  /** How much we resent someone, 0..1 (§17.5): whom a parent warns its child about. */
  resentmentOf?: (name: AgentName) => number;
  /** Tell the Hub (§19.3): we lie in our bed beside our partner asleep in theirs. */
  conceived?: (partner: AgentName, bed: Vec3) => void;
  feel?: (ev: AppraisalEvent, who?: AgentName) => void;
  /** Says a line to these people (a newborn's greeting is shouted). */
  say?: (text: string, to: readonly AgentName[], volume: 'normal' | 'shout') => void;
  now?: () => number;
  tickMs?: number;
}

export class FamilyWatch implements FamilyView {
  private askedAt = 0;
  private reportedAt = -Infinity;
  /** When each child of ours turned up, and whether we gave it food yet. */
  private readonly childSince = new Map<AgentName, number>();
  private readonly fed = new Set<AgentName>();
  /** Child → those we warned it about. */
  private readonly warned = new Map<AgentName, Set<AgentName>>();
  private timer: NodeJS.Timeout | null = null;
  private greetTimer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: FamilyOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('heard', (e) => this.onHeard(e.utterance)));
    this.offs.push(
      this.o.bus.on('decision', (e) => {
        const f = e.decision.family;
        if (!f) return;
        if (f.phase === 'propose') this.askedAt = this.now();
        if (f.phase === 'accept') this.agreed(f.with);
        if (f.phase === 'warn' && f.about) this.warned.set(f.with, new Set([...(this.warned.get(f.with) ?? []), f.about]));
      }),
    );
    // Food handed to a child of ours: given, once.
    this.offs.push(
      this.o.bus.on('actionRecorded', (e) => {
        const to = e.record.args.to;
        if (e.record.skill === 'give' && e.record.ok && typeof to === 'string' && this.childSince.has(to)) this.fed.add(to);
      }),
    );
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? TICK_MS);
    this.timer.unref();
    // A newborn's first words, to both parents (§19.3): heard by those near, like anything said.
    const s = this.o.store.state;
    if (this.young() && s.family.parents.length > 0 && (s.family.greeted ?? []).length === 0) {
      this.greetTimer = setTimeout(() => {
        const parents = this.o.store.state.family.parents;
        this.o.say?.(greeting(parents.map((n) => ({ name: n, sex: this.o.store.state.social[n]?.perceivedSex ?? 'unknown' }))), parents, 'shout');
      }, GREET_AFTER_MS);
      this.greetTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.greetTimer) clearTimeout(this.greetTimer);
    this.greetTimer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** A born agent in its youth (§19.5). */
  young(): boolean {
    return isYoung(this.o.store.state, this.now());
  }

  /** Two beds side by side within 16 blocks of a chest, as last seen (§19.3); remembered once seen. */
  home(): { beds: Vec3[]; chest: Vec3 } | null {
    const s = this.o.store.state;
    const notes = s.perception.nearbyBlocksOfInterest;
    const beds = notes.filter((b) => b.name.endsWith('_bed')).map((b) => b.pos);
    for (const chest of notes.filter((b) => /^(chest|trapped_chest|barrel)$/.test(b.name)).map((b) => b.pos)) {
      const near = beds.filter((b) => dist(b, chest) <= HOME_RADIUS);
      // Each bed is two blocks: two beds side by side are four bed blocks close together.
      const pair = near.filter((b) => near.filter((c) => dist(b, c) <= 2.5).length >= 4);
      if (pair.length < 4) continue;
      const known = s.family.home;
      if (!known?.chest || dist(known.chest, chest) > 0.5 || known.beds.length !== pair.length) {
        this.o.store.update('family', (f) => ({ ...f, home: { beds: pair, chest } }), 'a home');
      }
      return { beds: pair, chest };
    }
    const known = s.family.home;
    return known?.chest && known.beds.length >= 4 ? { beds: known.beds, chest: known.chest } : null;
  }

  /** Food we hold, and what the home chest held when last looked in (§19.3: 20 or more put by). */
  private food(chest: Vec3 | null): number {
    const s = this.o.store.state;
    const held = s.self.inventory.filter((i) => EDIBLE.test(i.item)).reduce((a, i) => a + i.qty, 0);
    const c = s.village.chest;
    const stored = c?.contents && chest && dist(c.pos, chest) <= 0.5 ? Object.entries(c.contents).filter(([k]) => EDIBLE.test(k)).reduce((a, [, n]) => a + n, 0) : 0;
    return held + stored;
  }

  /** §19.3 from our side: partners long enough, fond, a home with food, no child just now, grown up. */
  whyNotFamily(name: AgentName): string | null {
    const s = this.o.store.state;
    const t = this.now();
    if (!this.o.enabled) return 'children are not possible here';
    if (s.family.partner !== name) return `${name} is not my partner`;
    if (this.young()) return 'too young';
    const since = s.social[name]?.relationshipSince ?? t;
    if (t - since < this.o.config.partnerMinDays * GAME_DAY_MS) return 'not together long enough yet';
    if (this.o.liking(name) < 8) return 'not sure about us yet';
    if (t - (s.family.lastConceptionTs ?? -Infinity) < this.o.config.coupleCooldownSec * 1000) return 'we only just had a child';
    const home = this.home();
    if (!home) return 'no home yet (two beds by a chest)';
    if (this.food(home.chest) < this.o.config.minFoodItems) return 'not enough food put by';
    return null;
  }

  step(): FamilyStep | null {
    const s = this.o.store.state;
    const t = this.now();
    const seen = (n: AgentName) => s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === n && e.visible);
    // §19.5: a child in its youth keeps to a parent.
    if (this.young()) {
      const parent = s.family.parents.map((n) => seen(n)).filter((e) => e !== undefined).sort((a, b) => a.distance - b.distance)[0];
      return parent && parent.distance > 6 ? { kind: 'keepClose', to: parent.name, why: 'keeping close to my parent' } : null;
    }
    // Agreed: at night, to bed beside each other.
    const plan = s.family.planning;
    const home = this.home();
    if (plan && home && !s.self.isSleeping && s.self.time >= NIGHT_FROM && s.self.time <= NIGHT_TO) {
      const bed = [...home.beds].sort((a, b) => dist(a, s.self.pos) - dist(b, s.self.pos))[0];
      if (bed) return { kind: 'sleep', near: bed, with: plan.with };
    }
    // Parents: a young child of ours kept close, given food once, and warned about those we resent.
    for (const child of this.youngChildren()) {
      const c = seen(child);
      if (!c) continue;
      const food = s.self.inventory.filter((i) => EDIBLE.test(i.item)).sort((a, b) => b.qty - a.qty)[0];
      if (!this.fed.has(child) && food && food.qty >= 4 && c.distance <= 8) return { kind: 'feed', to: child, item: food.item, qty: Math.min(3, food.qty - 1) };
      if (c.distance > KEEP_CLOSE) return { kind: 'keepClose', to: child, why: 'looking after my child' };
      const foe = this.foeToWarn(child);
      if (foe && c.distance <= 8) return { kind: 'warn', to: child, about: foe.name, line: warnLine(foe.name, foe.deed) };
    }
    const partner = s.family.partner;
    if (partner && !plan && seen(partner) && t - this.askedAt >= ASK_EVERY_MS && this.whyNotFamily(partner) === null) return { kind: 'ask', to: partner };
    return null;
  }

  /** Children of ours still in their youth, as far as we know (from when they greeted us). */
  private youngChildren(): AgentName[] {
    const t = this.now();
    return [...this.childSince].filter(([, since]) => t - since < this.o.config.youthSec * 1000).map(([n]) => n);
  }

  /** The one we resent most whom we haven't warned this child about (not family, not the child itself). */
  private foeToWarn(child: AgentName): { name: AgentName; deed?: string } | null {
    const s = this.o.store.state;
    const told = this.warned.get(child) ?? new Set<AgentName>();
    const resent = this.o.resentmentOf;
    if (!resent) return null;
    const foe = Object.values(s.social)
      .filter((p) => p.name !== child && p.name !== this.o.me && !p.kin && p.name !== s.family.partner && !told.has(p.name) && resent(p.name) >= WARN_RESENTMENT)
      .sort((a, b) => resent(b.name) - resent(a.name))[0];
    if (!foe) return null;
    const worst = [...foe.grievances].sort((a, b) => b.weight - a.weight)[0];
    return { name: foe.name, ...(worst?.note ? { deed: worst.note } : {}) };
  }

  /** §19.5: what Goal Gen is told about the family (teach and protect a young child; a young one keeps to its parents). */
  hint(): string | null {
    const s = this.o.store.state;
    if (this.young()) return s.family.parents.length > 0 ? `You are young: stay close to your parents (${s.family.parents.join(' and ')}) and learn from them.` : null;
    const kids = this.youngChildren();
    if (kids.length > 0) return `You have a young child (${kids.join(', ')}): teach and protect them. Share food, guide them, and warn them about dangers and people to avoid.`;
    const plan = s.family.planning;
    if (plan && !this.home()) return `You and ${plan.with} want to start a family: you need a home (two beds side by side near a chest) with food put by.`;
    return null;
  }

  private agreed(partner: AgentName): void {
    if (this.o.store.state.family.planning?.with === partner) return;
    this.o.store.update('family', (f) => ({ ...f, planning: { with: partner, at: this.now() } }), 'starting a family');
    pushWorkmem(this.o.store, `${partner} and I want to start a family`, 0.8, 'self_observed', { aboutAgent: partner, now: this.now() });
    this.o.logger.info({ module: 'family', partner }, 'starting a family');
  }

  private onHeard(u: Utterance): void {
    if (u.from === this.o.me) return;
    const s = this.o.store.state;
    // The answer to our question.
    if (u.from === s.family.partner && this.now() - this.askedAt < ANSWER_MS && YES_RE.test(u.text)) this.agreed(u.from);
    // A newcomer greeting us as its parent: our child (§19.3). The greeting names its parents first.
    const named = openingName(u.text);
    if (GREETING_RE.test(u.text) && (named === this.o.me || mentionsName(u.text.split(':')[0] ?? '', this.o.me)) && !s.family.children.includes(u.from)) this.ourChild(u.from);
  }

  private ourChild(name: AgentName): void {
    const t = this.now();
    this.childSince.set(name, t);
    this.o.store.update('family', (f) => ({ ...f, children: [...f.children, name] }), 'our child');
    this.o.store.update(
      'social',
      (all) => {
        const p = all[name] ?? newSocialProfile(name, this.o.store.state.self.persona, t);
        return { ...all, [name]: { ...p, kin: 'child', sentiment: Math.max(p.sentiment, 9), evidence: Math.max(p.evidence, 9), trust: Math.max(p.trust, 0.9) } };
      },
      'our child',
    );
    this.o.feel?.({ kind: 'goalAchieved' });
    pushWorkmem(this.o.store, `our child ${name} was born`, 0.95, 'self_observed', { aboutAgent: name, now: t });
    this.o.logger.info({ module: 'family', child: name }, 'our child');
  }

  /** A young one greets each parent the first time it sees them close by (they may not have heard the first words). */
  private greetParents(): void {
    const s = this.o.store.state;
    if (!this.young()) return;
    const greeted = s.family.greeted ?? [];
    const parent = s.family.parents.find((n) => !greeted.includes(n) && s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === n && e.visible && e.distance <= GREET_RANGE));
    if (!parent) return;
    this.o.store.update('family', (f) => ({ ...f, greeted: [...(f.greeted ?? []), parent] }), `greeted ${parent}`);
    this.o.say?.(greeting([{ name: parent, sex: s.social[parent]?.perceivedSex ?? 'unknown' }]), [parent], 'normal');
  }

  /** For the CC packet: where the family stands. */
  mindLines(): string[] {
    const s = this.o.store.state;
    const plan = s.family.planning;
    const lines: string[] = [];
    if (plan) lines.push(`You and ${plan.with} agreed to start a family: at night, both of you sleep in your beds at home.`);
    const hint = this.hint();
    if (hint && !plan) lines.push(hint);
    return lines;
  }

  private tick(): void {
    this.greetParents();
    const s = this.o.store.state;
    const plan = s.family.planning;
    const partner = s.family.partner;
    if (!plan || !partner || plan.with !== partner || !s.self.isSleeping) return;
    const t = this.now();
    if (t - this.reportedAt < 10 * 60_000) return;
    const them = s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === partner);
    if (!them?.sleeping || dist(them.pos, s.self.pos) > BESIDE) return;
    // Each of us, asleep beside the other, tells the Hub; with both, a child comes after gestation (§19.3).
    this.reportedAt = t;
    this.o.store.update(
      'family',
      (f) => {
        const next = { ...f, lastConceptionTs: t };
        delete next.planning;
        return next;
      },
      'the bed ritual',
    );
    this.o.conceived?.(partner, s.self.pos);
    pushWorkmem(this.o.store, `${partner} and I may have a child soon`, 0.9, 'self_observed', { aboutAgent: partner, now: t });
    this.o.logger.info({ module: 'family', partner }, 'conception');
  }
}
