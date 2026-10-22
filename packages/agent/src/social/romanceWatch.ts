// Romance as one agent lives it (§19.1, §19.2, §19.10), all code. The sex others take someone to be, from what
// they say of themselves and the pronouns others use; how drawn we are to each person, and the stage we're at with
// them (a crush, courting, partners, exes); advances made and answered, each side deciding for itself; how a
// rejection is taken; jealousy of a rival, a breakup, and grief. Everything said is PG (§19.6).

import { type AgentName, type GrievanceKind, type Logger, type Relationship, type SocialProfile, type Utterance, GAME_DAY_MS, GAME_WEEK_MS, mentionsName, openingName, withoutOpeningName } from '@agora/shared';
import type { DecisionOutput, Sex } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AppraisalEvent } from '../mind/emotions';
import type { AgentStateStore } from '../state/store';
import { newSocialProfile } from '../state/social';
import { pushWorkmem } from '../state/workmem';
import { type AdvanceContext, type AdvanceReaction, type RejectionReaction, advanceWeights, attraction, orientationFit, persistenceCap, pronounSex, rejectionWeights, rollReaction, statedSex } from './romance';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A compliment, a shy smile, a small gift: a flirt (§19.2 courting). */
export const FLIRT_RE =
  /\b(you look (so )?(great|lovely|nice|wonderful|cute|beautiful|handsome) today|you'?re (so |really )?(sweet|cute|lovely|pretty|handsome|beautiful|charming|adorable)|i (really )?like (spending time|being) with you|you (always )?make me smile|this is for you|\*(blushes|smiles shyly)\*)/i;
/** "Will you be my partner?" */
export const PROPOSE_RE = /\b(will|would) you be my (partner|sweetheart)\b|\bbe my partner\b|\bgo out with me\b/i;
/** Yes to a proposal ("Ned, yes! I'd love to be your partner."). */
const ACCEPT_RE = /^\W*(?:[A-Za-z0-9_]{1,16},\s*)?(yes|yeah|of course|i'?d love (to|that)|absolutely)\b/i;
/** No to an advance, kindly or not. */
const DECLINE_RE = /\b(no\b|nope|not interested|don'?t feel (that way|the same)|just friends|rather you didn'?t|not a chance|no way|back off|leave me alone|stop it|not looking for that)/i;
/** A partner ending it. */
const BREAKUP_RE = /\b(we'?re (done|through)|it'?s over between us|break(ing)? up with you|we should break up)\b/i;

/** The lines courting takes in code (PG, §19.6), so that a listener's code reading takes them the same way. */
export const COMPLIMENTS: readonly string[] = ['you look lovely today.', 'I like spending time with you.', 'you always make me smile.', "you're really sweet, you know that?"];
export const PROPOSAL = 'will you be my partner?';
export const ACCEPTANCE = "yes! I'd love to be your partner.";
export const FLIRT_BACK = "hehe, you're sweet too.";
export const GIFT_LINE = 'this is for you.';
export const BREAKUP_LINE = "I think we're done.";
/** §19.10 A: a declined advance, said in character (an ignored one is not answered at all). */
export const DECLINE_LINES = {
  politeDecline: "that's sweet of you, but I don't feel that way.",
  ignore: '',
  uncomfortable: "uh... I'd rather you didn't.",
  disgusted: 'ew, no. not a chance.',
  hostile: 'back off. I mean it.',
} as const;
/** §19.10 B: a rejection, taken in character (jealousy is taken out on the rival, not said here). */
export const REJECTION_LINES: Readonly<Record<RejectionReaction, string>> = {
  graceful: 'oh, okay. no hard feelings.',
  sadWithdrawal: 'oh... okay.',
  persist: 'think about it, okay?',
  jealousy: '',
  resentment: 'fine. your loss.',
  rage: "you'll regret that!",
};

export function isAdvance(text: string): boolean {
  return FLIRT_RE.test(text) || PROPOSE_RE.test(text);
}

const TICK_MS = 10_000;
/** Within this, two people are together (§19.2 shared time), which fades with a half-life of half an hour. */
const TOGETHER = 8;
const TOGETHER_HALF_LIFE_MS = 30 * 60_000;
/** Half an hour of it, lately, is all it can add. */
const TOGETHER_FULL_S = 30 * 60;
/** Gifts from someone count this long, three at most. */
const GIFTS_MS = 2 * 60 * 60_000;
/** Romantic interest moves this much of the way toward attraction each tick while they're about. */
const LEAN = 0.04;
/** A crush from this interest, gone again below DRIFT; the question asked from PROPOSE_AT. */
export const CRUSH_AT = 0.5;
const DRIFT = 0.3;
const COURT_AT = 0.6;
const PROPOSE_AT = 0.75;
/** Courting (§19.2): a compliment at most this often, a small gift this often, the question this often. */
const FLIRT_EVERY_MS = 3 * 60_000;
const GIFT_EVERY_MS = 10 * 60_000;
const PROPOSE_EVERY_MS = 10 * 60_000;
/** A crush seeks them out (goes near) at most this often. */
const APPROACH_EVERY_MS = 2 * 60_000;
/** Wrongs by a partner that end it (§19.2 breakup: betrayal, coercion, being hit). */
const PARTNER_WRONGS: ReadonlySet<string> = new Set(['attack', 'betrayal', 'coercion']);
/** They returned it this many times: the question may be asked. */
const RETURNED_TO_PROPOSE = 2;
/** Courted in sight within this. */
const COURT_SIGHT = 24;
/** An answer to an advance comes within this. */
const ANSWER_MS = 40_000;
/** Nerves near a crush at most this often (§19.2 crush). */
const NERVES_EVERY_MS = 2 * 60_000;
/** Turned down and sad, or put off: keep away from them this long. */
const SULK_MS = 10 * 60_000;
/** Partners: no time together this long, or liking under 5 for COLD_MS, ends it (§19.2 breakup). */
const NEGLECT_MS = 2 * GAME_DAY_MS;
const COLD_MS = 10 * 60_000;
/** One seen courting our partner stays suspected this long; jealousy at most every JEALOUS_EVERY_MS per rival. */
const SUSPECT_MS = 30 * 60_000;
const JEALOUS_EVERY_MS = 5 * 60_000;
/** Grief: as sad as one gets, then a pang now and then for an in-game day. */
const GRIEF_MS = GAME_DAY_MS;
const PANG_EVERY_MS = 5 * 60_000;
/** Flowers make the best small gift; food will do. */
const FLOWERS = /^(poppy|dandelion|blue_orchid|allium|azure_bluet|\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony)$/;
const FOOD_GIFT = /^(bread|apple|cooked_\w+|baked_potato|carrot|cookie)$/;

export type CourtStep =
  | { with: AgentName; kind: 'approach' }
  | { with: AgentName; kind: 'flirt'; line: string }
  | { with: AgentName; kind: 'gift'; item: string }
  | { with: AgentName; kind: 'propose' };

/** What the CC needs (§19.2, §19.10). */
export interface RomanceView {
  partner(): AgentName | null;
  relationshipWith(name: AgentName): Relationship;
  /** The next courting step to take now, if any (seen within reach, paced, within the soft cap). */
  courtship(): CourtStep | null;
  /** How we take an advance from them now, rolled from our traits and the moment (§19.10 A). */
  reactionTo(from: AgentName): AdvanceReaction;
  /** Their proposal is one we'd say yes to (drawn to them, fond of them, free). */
  wouldAccept(from: AgentName): boolean;
  /** Why we may not court them (family, the young, not whom we're drawn to, asked too often), or null. */
  mayCourt(name: AgentName): string | null;
}

export interface RomanceOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  enabled?: boolean;
  /** Gut and facts mixed (§18.5), 0..10. */
  liking?: (name: AgentName) => number;
  /** How strong someone looks (§17.4), 0..1: their standing, as the vain see it. */
  powerOf?: (name: AgentName) => number;
  resentmentOf?: (name: AgentName) => number;
  /** A wrong done to us (§17.2). */
  grieve?: (name: AgentName, kind: GrievanceKind, note: string, weight?: number) => void;
  /** Feel something (§18.2). */
  feel?: (ev: AppraisalEvent, who?: AgentName) => void;
  /** Say a line to someone at once: how a rejection was taken. */
  say?: (to: AgentName, text: string) => void;
  /** Act on an impulse (§18.5): a rage at a rejection, through the gate's lower bar. */
  impulse?: (out: DecisionOutput) => boolean;
  /** System 2 override now (§18.5): it may veto a violent reaction. */
  override?: () => number;
  combat?: () => number;
  rng?: () => number;
  now?: () => number;
  tickMs?: number;
}

export class RomanceWatch implements RomanceView {
  /** Seconds spent together lately, fading. */
  private readonly together = new Map<AgentName, { s: number; at: number }>();
  private readonly giftsFrom = new Map<AgentName, number[]>();
  /** Advances made to us, by whom and when (the soft cap and harsher answers, §19.10). */
  private readonly advancesFrom = new Map<AgentName, number[]>();
  /** Our own advance waiting for its answer. */
  private pending: { to: AgentName; kind: 'flirt' | 'propose'; at: number } | null = null;
  /** How often they returned an advance of ours (a flirt back, a yes). */
  private readonly returned = new Map<AgentName, number>();
  /** When we last made each kind of courting step toward someone. */
  private readonly stepAt = new Map<string, number>();
  /** People we keep away from for a while (turned down and sulking, or put off by them). */
  private readonly avoid = new Map<AgentName, number>();
  /** Those seen courting our partner, and when; and when we were last jealous of each. */
  private readonly suspects = new Map<AgentName, number>();
  private readonly jealousAt = new Map<AgentName, number>();
  private nervesAt = 0;
  private coldSince: number | null = null;
  private lastWithPartner = 0;
  private grief: { until: number; pangAt: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(private readonly o: RomanceOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
  }

  start(): void {
    if (this.o.enabled === false) return;
    const b = this.o.bus;
    this.lastWithPartner = this.now();
    this.offs.push(b.on('heard', (e) => this.onHeard(e.utterance)));
    this.offs.push(b.on('decision', (e) => this.onDecision(e.decision)));
    this.offs.push(
      b.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind !== 'gave' || !a.target || a.actor === this.o.me) return;
        const partner = this.partner();
        if (a.target === this.o.me) this.giftsFrom.set(a.actor, [...(this.giftsFrom.get(a.actor) ?? []), this.now()].slice(-3));
        // Someone giving our partner things is courting them, as far as we can tell.
        else if (partner && a.target === partner) this.suspect(a.actor, `${a.actor} gave ${partner} a gift`);
      }),
    );
    this.offs.push(b.on('peerDied', (e) => e.name === this.partner() && this.mourn(e.name, e.killer)));
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  partner(): AgentName | null {
    return this.o.store.state.family.partner ?? null;
  }

  relationshipWith(name: AgentName): Relationship {
    return this.o.store.state.social[name]?.relationship ?? 'none';
  }

  private young(): boolean {
    const life = this.o.store.state.life;
    return life.born && this.now() < life.youthUntil;
  }

  private profile(name: AgentName): SocialProfile {
    const s = this.o.store.state;
    return s.social[name] ?? newSocialProfile(name, s.self.persona, this.now());
  }

  private update(name: AgentName, f: (p: SocialProfile) => SocialProfile, reason: string): void {
    const p = this.profile(name);
    this.o.store.update('social', (all) => ({ ...all, [name]: f(p) }), reason);
  }

  private liking(name: AgentName): number {
    return this.o.liking?.(name) ?? this.o.store.state.social[name]?.sentiment ?? 5;
  }

  /** §19.1: orientation against the sex we take them to be (0, 1, or 0.5 when we don't know). */
  private fit(name: AgentName): number {
    const me = this.o.store.state.self.persona;
    return orientationFit(me.orientation, me.sex, this.o.store.state.social[name]?.perceivedSex ?? 'unknown');
  }

  /** Family is family, and the young are not courted (§19.5, §19.6). */
  private eligible(name: AgentName): boolean {
    const p = this.o.store.state.social[name];
    return name !== this.o.me && Boolean(p) && (p?.kin === null || p?.kin === 'partner') && !this.young();
  }

  /** §19.2 attraction: what shows (gear, their standing in our eyes), how well we'd get on, time together, gifts. */
  private attractionTo(name: AgentName): number {
    const s = this.o.store.state;
    const p = s.social[name];
    if (!p) return 0;
    const t = this.now();
    const tg = this.together.get(name);
    const shared = tg ? (tg.s * 0.5 ** ((t - tg.at) / TOGETHER_HALF_LIFE_MS)) / TOGETHER_FULL_S : 0;
    const gifts = (this.giftsFrom.get(name) ?? []).filter((at) => t - at < GIFTS_MS).length / 3;
    // How well we'd get on: as L2 judged it after talking (§19.2); without a model, read from how we've come to feel.
    const compatibility = p.estTraits.compatibility ?? clamp01(0.35 + 0.65 * ((this.liking(name) - 3) / 7));
    const superficial = clamp01(0.3 + 0.7 * Math.max(p.gearScore, p.admiration));
    return attraction(s.self.persona.mind.vanity, { superficial, compatibility, sharedTime: clamp01(shared), gifts: clamp01(gifts) }) * this.fit(name);
  }

  /** Further attempts this in-game week after the first rejection, against the soft cap (§19.10). */
  private locked(to: AgentName): boolean {
    const a = this.o.store.state.family.advances[to];
    if (!a || this.now() - a.weekStart >= GAME_WEEK_MS) return false;
    return a.rejections > persistenceCap(this.o.store.state.self.persona.big5.agreeableness);
  }

  private attemptsLeft(to: AgentName): number {
    const a = this.o.store.state.family.advances[to];
    const cap = persistenceCap(this.o.store.state.self.persona.big5.agreeableness);
    if (!a || this.now() - a.weekStart >= GAME_WEEK_MS) return cap;
    return Math.max(0, cap - Math.max(0, a.rejections - 1));
  }

  courtship(): CourtStep | null {
    if (this.o.enabled === false || this.young()) return null;
    const s = this.o.store.state;
    const t = this.now();
    const partner = this.partner();
    const seen = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.visible && e.distance <= COURT_SIGHT);
    const candidates = seen
      .filter((e) => this.eligible(e.name) && (partner === null || e.name === partner) && this.fit(e.name) > 0 && !this.locked(e.name) && !((this.avoid.get(e.name) ?? 0) > t))
      .map((e) => ({ n: e.name, d: e.distance, interest: s.social[e.name]?.romanticInterest ?? 0 }))
      .filter((c) => c.interest >= CRUSH_AT || c.n === partner)
      .sort((a, b) => b.interest - a.interest);
    const top = candidates[0];
    if (!top) return null;
    const n = top.n;
    const since = (kind: string) => t - (this.stepAt.get(`${kind}:${n}`) ?? -Infinity);
    // §19.2 crush: seeking them out.
    if (top.d > TOGETHER && since('approach') >= APPROACH_EVERY_MS) {
      this.stepAt.set(`approach:${n}`, t);
      return { with: n, kind: 'approach' };
    }
    // Courting is for one whose sex we know, and once we're drawn enough (a partner, always).
    if (n !== partner && (this.fit(n) !== 1 || top.interest < COURT_AT)) return null;
    if (n !== partner && top.interest >= PROPOSE_AT && this.liking(n) >= 7 && (this.returned.get(n) ?? 0) >= RETURNED_TO_PROPOSE && since('propose') >= PROPOSE_EVERY_MS) {
      return { with: n, kind: 'propose' };
    }
    if (since('gift') >= GIFT_EVERY_MS) {
      const flower = s.self.inventory.find((x) => FLOWERS.test(x.item))?.item;
      const food = s.self.inventory.filter((x) => FOOD_GIFT.test(x.item)).sort((a, b) => b.qty - a.qty)[0];
      const item = flower ?? (food && food.qty >= 3 ? food.item : undefined);
      if (item) return { with: n, kind: 'gift', item };
    }
    // Partners keep it up too, less often.
    if (since('flirt') >= FLIRT_EVERY_MS * (n === partner ? 3 : 1)) return { with: n, kind: 'flirt', line: COMPLIMENTS[Math.floor(this.rng() * COMPLIMENTS.length)] ?? COMPLIMENTS[0] ?? '' };
    return null;
  }

  advanceContext(from: AgentName): AdvanceContext {
    const s = this.o.store.state;
    const p = s.social[from];
    const t = this.now();
    const made = (this.advancesFrom.get(from) ?? []).filter((at) => t - at < GAME_WEEK_MS).length;
    return {
      attraction: this.attractionTo(from),
      admiration: p?.admiration ?? 0,
      sentiment: this.liking(from),
      status: this.o.powerOf?.(from) ?? p?.perceivedPower ?? 0.5,
      friction: p?.friction ?? 0,
      resentment: this.o.resentmentOf?.(from) ?? 0,
      joy: s.emotions.joy,
      attempt: Math.max(0, made - 1),
    };
  }

  reactionTo(from: AgentName): AdvanceReaction {
    const p = this.o.store.state.self.persona;
    return rollReaction(advanceWeights(p, this.advanceContext(from)), this.rng, this.o.override?.() ?? 0);
  }

  mayCourt(name: AgentName): string | null {
    if (this.o.enabled === false) return 'romance is off here';
    const p = this.o.store.state.social[name];
    if (this.young()) return 'you are too young for that';
    if (p?.kin && p.kin !== 'partner') return `${name} is family`;
    if (this.fit(name) === 0) return `${name} is not someone you are drawn to that way`;
    if (this.locked(name)) return `${name} has said no too often this week; leave them be`;
    const partner = this.partner();
    if (partner && partner !== name) return `${partner} is your partner`;
    return null;
  }

  wouldAccept(from: AgentName): boolean {
    const partner = this.partner();
    return this.eligible(from) && (partner === null || partner === from) && this.fit(from) > 0 && (this.o.store.state.social[from]?.romanticInterest ?? 0) >= CRUSH_AT && this.liking(from) >= 6;
  }

  /** Lines for the CC packet (§19.2): crushes, courting, a partner, a rival. */
  mindLines(): string[] {
    const s = this.o.store.state;
    const out: string[] = [];
    const partner = this.partner();
    if (partner) out.push(`${partner} is your partner.`);
    for (const p of Object.values(s.social)) {
      if (p.name === partner) continue;
      if (p.relationship === 'crush') out.push(`You have a crush on ${p.name}.`);
      if (p.relationship === 'courting') out.push(`You are courting ${p.name}${(this.returned.get(p.name) ?? 0) > 0 ? '; they have returned your affection' : ''}.`);
    }
    const t = this.now();
    for (const [rival, at] of this.suspects) if (t - at < SUSPECT_MS && partner) out.push(`You suspect ${rival} is after ${partner}.`);
    return out;
  }

  private setSex(name: AgentName, sex: Sex, how: string): void {
    const p = this.o.store.state.social[name];
    if (!p || p.perceivedSex !== 'unknown' || name === this.o.me) return;
    this.update(name, (x) => ({ ...x, perceivedSex: sex }), `sex from ${how}`);
  }

  private onHeard(u: Utterance): void {
    if (u.from === this.o.me) return;
    const s = this.o.store.state;
    const t = this.now();
    // §19.1: what someone says of themselves, and the pronoun used for the one person a line is about.
    const stated = statedSex(u.text);
    if (stated) this.setSex(u.from, stated, 'what they said of themselves');
    const body = withoutOpeningName(u.text, (w) => Boolean(s.social[w]) || w === this.o.me);
    const about = Object.keys(s.social).filter((n) => n !== u.from && n !== this.o.me && mentionsName(body, n));
    if (about.length === 1 && about[0]) {
      const sex = pronounSex(body);
      if (sex) this.setSex(about[0], sex, `the pronoun ${u.from} used`);
    }
    const advance = isAdvance(u.text);
    const named = openingName(u.text);
    const toMe = u.addressedToMe || u.heardAs === 'me' || named === this.o.me;
    if (advance && toMe) this.advancesFrom.set(u.from, [...(this.advancesFrom.get(u.from) ?? []), t].slice(-10));
    // An advance made to our partner by someone else: a rival, as far as we can tell (§19.2 jealousy).
    const partner = this.partner();
    if (advance && partner && u.from !== partner && (named === partner || (Array.isArray(u.to) && u.to.length === 1 && u.to[0] === partner))) {
      this.suspect(u.from, `${u.from} is courting ${partner}`);
    }
    // The answer to our own advance.
    const p = this.pending;
    if (p && p.to === u.from && t - p.at < ANSWER_MS) {
      if (p.kind === 'propose' && ACCEPT_RE.test(u.text)) {
        this.pending = null;
        this.partnered(u.from);
      } else if (FLIRT_RE.test(u.text) || (p.kind === 'flirt' && ACCEPT_RE.test(u.text))) {
        this.pending = null;
        this.returned.set(u.from, (this.returned.get(u.from) ?? 0) + 1);
        this.o.feel?.({ kind: 'welcomeAdvance' }, u.from);
      } else if (DECLINE_RE.test(u.text)) {
        this.pending = null;
        const inPublic = s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name !== u.from && e.distance <= 12);
        this.turnedDown(u.from, p.kind, inPublic);
      }
    }
    if (partner && u.from === partner && BREAKUP_RE.test(u.text) && toMe) this.brokeUp(partner, false);
  }

  private onDecision(d: DecisionOutput): void {
    const r = d.romance;
    if (!r) return;
    const t = this.now();
    if (r.phase === 'flirt' || r.phase === 'propose') {
      const kind = r.phase === 'propose' ? 'propose' : d.task?.skill === 'give' ? 'gift' : 'flirt';
      this.stepAt.set(`${kind}:${r.with}`, t);
      this.pending = { to: r.with, kind: r.phase, at: t };
      this.o.store.update(
        'family',
        (f) => {
          const a = f.advances[r.with];
          const fresh = !a || t - a.weekStart >= GAME_WEEK_MS;
          return { ...f, advances: { ...f.advances, [r.with]: fresh ? { count: 1, weekStart: t, rejections: 0 } : { ...a, count: a.count + 1 } } };
        },
        'an advance',
      );
      if (this.relationshipWith(r.with) !== 'partner') this.update(r.with, (p) => ({ ...p, relationship: 'courting' }), 'courting');
      return;
    }
    if (r.phase === 'accept') return this.partnered(r.with);
    if (r.phase === 'breakup') return this.brokeUp(r.with, true);
    if (r.phase === 'decline') this.declined(r.with, r.reaction ?? 'politeDecline');
  }

  /** §19.10 A: how we took an advance we turned down, for us. */
  private declined(from: AgentName, how: NonNullable<NonNullable<DecisionOutput['romance']>['reaction']>): void {
    const t = this.now();
    if (how === 'uncomfortable' || how === 'disgusted') {
      this.o.feel?.({ kind: 'unwantedAdvance', disgust: how === 'disgusted' }, from);
      this.avoid.set(from, t + SULK_MS);
    }
    if (how === 'disgusted' || how === 'hostile') {
      this.o.grieve?.(from, 'unwanted_advance', `${from} would not leave me alone`);
      this.update(from, (p) => ({ ...p, sentiment: Math.max(0, p.sentiment - 1.5) }), 'an unwanted advance');
    }
    // Asked again after a no: a little less fond of them each time.
    if (how === 'politeDecline' && (this.advancesFrom.get(from) ?? []).filter((at) => t - at < GAME_WEEK_MS).length >= 2) {
      this.update(from, (p) => ({ ...p, sentiment: Math.max(0, p.sentiment - 0.3) }), 'asked again');
    }
  }

  /** §19.10 B: we were turned down. How we take it is rolled from our traits and the moment. */
  private turnedDown(by: AgentName, kind: 'flirt' | 'propose', inPublic: boolean): void {
    const s = this.o.store.state;
    const t = this.now();
    const persona = s.self.persona;
    this.o.store.update(
      'family',
      (f) => {
        const a = f.advances[by] ?? { count: 1, weekStart: t, rejections: 0 };
        return { ...f, advances: { ...f.advances, [by]: { ...a, rejections: a.rejections + 1 } } };
      },
      'turned down',
    );
    this.o.feel?.({ kind: 'turnedDown', inPublic }, by);
    const interest = s.social[by]?.romanticInterest ?? 0;
    const rival = this.rivalsOf(by).length > 0;
    const how = rollReaction(
      rejectionWeights(persona, { romanticInterest: interest, rival, public: inPublic, shame: s.emotions.shame, arousal: s.emotions.arousal, combat: this.o.combat?.() ?? persona.abilities.combat, attemptsLeft: this.attemptsLeft(by) }),
      this.rng,
      this.o.override?.() ?? 0,
    );
    this.o.logger.info({ module: 'romance', by, kind, how, inPublic }, 'turned down');
    const fade = how === 'graceful' ? 0.6 : how === 'sadWithdrawal' ? 0.8 : how === 'persist' ? 0.95 : 0.7;
    this.update(by, (p) => ({ ...p, romanticInterest: p.romanticInterest * fade, ...(how === 'resentment' || how === 'rage' ? { sentiment: Math.max(0, p.sentiment - 2) } : {}) }), `turned down (${how})`);
    if (how === 'sadWithdrawal') this.avoid.set(by, t + SULK_MS);
    if (how === 'resentment') this.o.grieve?.(by, 'rejection', `${by} turned me down`);
    if (how === 'jealousy') for (const r of this.rivalsOf(by)) this.jealous(r, by);
    const line = REJECTION_LINES[how];
    if (line) this.o.say?.(by, line);
    if (how === 'rage') {
      this.o.grieve?.(by, 'rejection', `${by} humiliated me`, 0.3);
      // §18.5 the impulse path: one blow in the heat of it, through the gate's lower bar.
      this.o.impulse?.({ option: 'fight', target: { agent: by }, task: { skill: 'attack', args: { target: by, seconds: 2 } }, terminate: { maxSeconds: 10 }, rationale: `lost my temper with ${by}, who turned me down` });
    }
    pushWorkmem(this.o.store, kind === 'propose' ? `${by} turned down my proposal` : `${by} wasn't interested in me`, 0.6, 'self_observed', { aboutAgent: by, now: t });
  }

  /** A rival, as one turned down sees it: someone the one who said no goes about with (§19.10 B jealousy). */
  private rivalsOf(name: AgentName): AgentName[] {
    return (this.o.store.state.social[name]?.companions ?? []).filter((c) => c !== this.o.me);
  }

  private suspect(rival: AgentName, why: string): void {
    const fresh = !this.suspects.has(rival);
    this.suspects.set(rival, this.now());
    if (fresh) {
      pushWorkmem(this.o.store, why, 0.6, 'self_observed', { aboutAgent: rival, now: this.now() });
      this.o.logger.info({ module: 'romance', rival, why }, 'a rival');
    }
  }

  /** §19.2 jealousy: envy and anger, and a grievance against the rival (which may come to a §17 conflict). */
  private jealous(rival: AgentName, over: AgentName): void {
    const t = this.now();
    if (t - (this.jealousAt.get(rival) ?? -Infinity) < JEALOUS_EVERY_MS) return;
    this.jealousAt.set(rival, t);
    this.o.feel?.({ kind: 'jealous' }, rival);
    this.o.grieve?.(rival, 'romantic_rival', `${rival} is after ${over}`);
    this.o.logger.info({ module: 'romance', rival, over }, 'jealous');
  }

  private partnered(name: AgentName): void {
    const t = this.now();
    if (this.partner() === name) return;
    this.o.store.update('family', (f) => ({ ...f, partner: name }), 'partners');
    this.update(name, (p) => ({ ...p, relationship: 'partner', relationshipSince: t, kin: 'partner', romanticInterest: Math.max(p.romanticInterest, 0.8) }), 'partners');
    this.lastWithPartner = t;
    this.coldSince = null;
    this.o.feel?.({ kind: 'welcomeAdvance' }, name);
    pushWorkmem(this.o.store, `${name} and I are partners now`, 0.9, 'self_observed', { aboutAgent: name, now: t });
    this.o.logger.info({ module: 'romance', partner: name }, 'partners');
  }

  private brokeUp(name: AgentName, byMe: boolean): void {
    const t = this.now();
    this.o.store.update(
      'family',
      (f) => {
        const next = { ...f };
        if (next.partner === name) delete next.partner;
        return next;
      },
      'broke up',
    );
    this.update(name, (p) => ({ ...p, relationship: 'ex', relationshipSince: t, kin: null, romanticInterest: p.romanticInterest * 0.5 }), 'broke up');
    if (!byMe) this.o.feel?.({ kind: 'turnedDown', inPublic: false }, name);
    pushWorkmem(this.o.store, byMe ? `I broke up with ${name}` : `${name} broke up with me`, 0.8, 'self_observed', { aboutAgent: name, now: t });
    this.o.logger.info({ module: 'romance', with: name, byMe }, 'broke up');
  }

  /** §19.2 grief: a partner's death. As sad as one gets, a lasting grievance against the killer. */
  private mourn(name: AgentName, killer: AgentName | undefined): void {
    const t = this.now();
    this.o.store.update(
      'family',
      (f) => {
        const next = { ...f };
        delete next.partner;
        return next;
      },
      'partner died',
    );
    this.grief = { until: t + GRIEF_MS, pangAt: t };
    this.o.feel?.({ kind: 'grief', fresh: true });
    if (killer && killer !== this.o.me) this.o.grieve?.(killer, 'killed_partner', `${killer} killed ${name}, my partner`);
    pushWorkmem(this.o.store, `${name}, my partner, is dead`, 1, 'self_observed', { aboutAgent: name, now: t });
  }

  private tick(): void {
    const s = this.o.store.state;
    const t = this.now();
    if (this.grief && t < this.grief.until && t - this.grief.pangAt >= PANG_EVERY_MS) {
      this.grief.pangAt = t;
      this.o.feel?.({ kind: 'grief', fresh: false });
    }
    if (this.young()) return;
    const dt = (this.o.tickMs ?? TICK_MS) / 1000;
    const near = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.visible && e.distance <= TOGETHER).map((e) => e.name);
    for (const n of near) {
      const g = this.together.get(n);
      const now = g ? g.s * 0.5 ** ((t - g.at) / TOGETHER_HALF_LIFE_MS) : 0;
      this.together.set(n, { s: now + dt, at: t });
    }
    const partner = this.partner();
    if (partner && near.includes(partner)) this.lastWithPartner = t;
    const around = new Set(s.perception.nearbyEntities.filter((e) => e.kind === 'player').map((e) => e.name));
    for (const p of Object.values(s.social)) {
      if (!this.eligible(p.name) || p.relationship === 'partner') continue;
      const fit = this.fit(p.name);
      // Drawn closer while they're about, drifting off slowly while not.
      const target = around.has(p.name) ? this.attractionTo(p.name) : 0;
      const lean = around.has(p.name) ? LEAN : LEAN / 10;
      const interest = clamp01(p.romanticInterest + (target - p.romanticInterest) * lean);
      let rel: Relationship = p.relationship;
      if (fit > 0 && interest >= CRUSH_AT && rel === 'none') rel = 'crush';
      if ((rel === 'crush' || rel === 'courting') && (interest < DRIFT || fit === 0)) rel = 'none';
      if (Math.abs(interest - p.romanticInterest) >= 0.005 || rel !== p.relationship) {
        this.update(p.name, (x) => ({ ...x, romanticInterest: Math.round(interest * 1000) / 1000, relationship: rel }), rel !== p.relationship ? `romance: ${rel}` : 'romantic interest');
        if (rel === 'crush' && p.relationship !== 'crush') pushWorkmem(this.o.store, `I think I have a crush on ${p.name}`, 0.6, 'self_observed', { aboutAgent: p.name, now: t });
      }
      // §19.2 crush: nerves near them.
      if ((rel === 'crush' || rel === 'courting') && near.includes(p.name) && t - this.nervesAt >= NERVES_EVERY_MS) {
        this.nervesAt = t;
        this.o.feel?.({ kind: 'nearCrush' }, p.name);
      }
    }
    if (!partner) return;
    // §19.2 jealousy: our partner with someone who seems to be after them.
    for (const [rival, at] of this.suspects) {
      if (t - at >= SUSPECT_MS) {
        this.suspects.delete(rival);
        continue;
      }
      const together = s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === rival && e.visible) && (s.social[partner]?.companions ?? []).includes(rival);
      const withPartner = near.includes(rival) && near.includes(partner);
      if (together || withPartner) this.jealous(rival, partner);
    }
    // §19.2 breakup: a heart gone cold, no time together for days, or a wrong done by them since we got together.
    const since = s.social[partner]?.relationshipSince ?? 0;
    if ((s.social[partner]?.grievances ?? []).some((g) => PARTNER_WRONGS.has(g.kind) && g.ts > since)) {
      this.o.say?.(partner, BREAKUP_LINE);
      this.brokeUp(partner, true);
      return;
    }
    const cold = this.liking(partner) < 5;
    this.coldSince = cold ? (this.coldSince ?? t) : null;
    if ((this.coldSince !== null && t - this.coldSince >= COLD_MS) || t - this.lastWithPartner >= NEGLECT_MS) {
      this.o.say?.(partner, BREAKUP_LINE);
      this.brokeUp(partner, true);
    }
  }
}
