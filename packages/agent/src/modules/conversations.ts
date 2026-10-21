// Conversations (§6.2, v0.2 §16.1): emergent and local. Each bot keeps its own ConversationState, keyed by a local
// guess (participants plus time gap); nothing is shared. Addressing is code first. Endings are code: turn cap,
// repetition, partner out of range or silent, danger, or the CC moving on. Ending sets a pair cooldown and fires
// `conversationEnded` for Social Awareness and commitment extraction (M6).

import { type AgentName, type ConversationState, type ConvId, type Logger, type Utterance, maxTurnsFor, mentionsName, tokenize } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';

export type Addressee = 'me' | 'other' | 'unsure';

export interface AddresseeInput {
  text: string;
  me: AgentName;
  speaker: AgentName;
  /** People I perceive within speech range (seen or recently heard), excluding me. */
  inRange: readonly AgentName[];
  /** I'm in an active one-on-one conversation with the speaker. */
  inConversationWith: boolean;
}

/** §6.2/§16.1 addressee detection: `@name` or a name mention, an ongoing one-on-one, or being the only one in range. */
export function detectAddressee(i: AddresseeInput): Addressee {
  if (mentionsName(i.text, i.me)) return 'me';
  const others = i.inRange.filter((n) => n !== i.speaker && n !== i.me);
  if (others.some((n) => mentionsName(i.text, n))) return 'other';
  if (i.inConversationWith) return 'me';
  return others.length === 0 ? 'me' : 'unsure';
}

/** Word-bigram overlap in 0..1: a cheap stand-in for embedding cosine until M4's local embeddings. */
export function textSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const w = tokenize(s);
    const out = new Set<string>(w);
    for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / Math.min(x.size, y.size);
}

export interface ConversationsOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** Who is perceivable within speech range right now. */
  inRange: () => AgentName[];
  rng?: () => number;
  now?: () => number;
  /** Similarity above which a line counts as repeating (§6.2: 0.92 with embeddings). */
  repeatThreshold?: number;
}

const RING_SPEECH = 30;
const TRANSCRIPT = 20;
const IDLE_END_MS = 60_000;
const OUT_OF_RANGE_MS = 10_000;
const SILENT_NUDGE_MS = 20_000;
const SILENT_END_MS = 40_000;

export class Conversations {
  private readonly now: () => number;
  private readonly rng: () => number;
  /** partner → epoch ms until which I may not start another conversation with them. */
  private readonly cooldownUntil = new Map<AgentName, number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly o: ConversationsOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
  }

  start(): void {
    this.offs.push(this.o.bus.on('heard', (e) => this.onHeard(e.utterance)));
    this.offs.push(
      this.o.bus.on('danger', () => {
        for (const c of this.active()) this.end(c.convId, 'danger');
      }),
    );
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  active(): ConversationState[] {
    return Object.values(this.o.store.state.conversations).filter((c) => c.status !== 'ended');
  }

  get(convId: ConvId): ConversationState | undefined {
    return this.o.store.state.conversations[convId];
  }

  withPartner(name: AgentName): ConversationState | undefined {
    return this.active().find((c) => c.participants.includes(name));
  }

  /** We ended a conversation with them recently. */
  coolingDown(partner: AgentName): boolean {
    return (this.cooldownUntil.get(partner) ?? 0) > this.now();
  }

  /** Each side may initiate once per pair cooldown (§6.2). */
  mayInitiate(partner: AgentName): boolean {
    return (this.cooldownUntil.get(partner) ?? 0) <= this.now() && !this.withPartner(partner);
  }

  /** CC option `talk` (or Talking replying to a stranger): opens a conversation. */
  open(partner: AgentName, initiatedByMe: boolean): ConversationState {
    const existing = this.withPartner(partner);
    if (existing) return existing;
    const now = this.now();
    const conv: ConversationState = {
      convId: `c${now.toString(36)}-${partner}`,
      participants: [this.o.me, partner],
      startedAt: now,
      lastActivity: now,
      turns: 0,
      myTurns: 0,
      lastEmbeds: [],
      status: 'active',
      transcript: [],
      initiatedByMe,
      nudged: false,
    };
    this.write(conv, `conversation started with ${partner}`);
    this.o.bus.emit({ type: 'conversationStarted', convId: conv.convId });
    return conv;
  }

  /** Talking reports what it said. Returns false when that line ended the conversation (cap or repetition). */
  noteOwnUtterance(convId: ConvId, text: string): boolean {
    const conv = this.get(convId);
    if (!conv || conv.status === 'ended') return false;
    const now = this.now();
    const mine = conv.transcript.filter((u) => u.from === this.o.me).slice(-4);
    const repeating = mine.some((u) => textSimilarity(u.text, text) > (this.o.repeatThreshold ?? 0.92));
    const u: Utterance = {
      id: `u${now.toString(36)}`,
      convId,
      from: this.o.me,
      to: conv.participants.filter((p) => p !== this.o.me),
      text,
      ts: now,
      pos: null,
      volume: 'normal',
      outOfSight: false,
      addressedToMe: false,
    };
    const next: ConversationState = {
      ...conv,
      transcript: [...conv.transcript, u].slice(-TRANSCRIPT),
      turns: conv.turns + 1,
      myTurns: conv.myTurns + 1,
      lastActivity: now,
    };
    this.write(next, 'said a line');
    if (repeating) {
      this.end(convId, 'repetition');
      return false;
    }
    if (next.myTurns >= maxTurnsFor(this.o.store.state.self.persona)) {
      this.end(convId, 'turn cap');
      return false;
    }
    return true;
  }

  end(convId: ConvId, reason: string): void {
    const conv = this.get(convId);
    if (!conv || conv.status === 'ended') return;
    for (const p of conv.participants) {
      if (p !== this.o.me) this.cooldownUntil.set(p, this.now() + 60_000 + this.rng() * 60_000);
    }
    this.write({ ...conv, status: 'ended', endedReason: reason }, `conversation ended: ${reason}`);
    this.o.bus.emit({ type: 'conversationEnded', convId, reason });
  }

  private onHeard(u: Utterance): void {
    const now = this.now();
    let conv = this.withPartner(u.from);
    if (conv && now - conv.lastActivity > IDLE_END_MS) {
      this.end(conv.convId, 'went quiet');
      conv = undefined;
    }
    // A line right after we ended a conversation with them is its tail, not a new one (pair cooldown, §6.2), unless
    // they call us by name. Otherwise two people alone would reopen it forever ("the only one in range").
    const tail = !conv && u.addressedToMe && this.coolingDown(u.from) && !mentionsName(u.text, this.o.me);
    if (!conv && u.addressedToMe && !tail) conv = this.open(u.from, false);
    const inConv = Boolean(conv);
    const addressed = !tail && (u.addressedToMe || (inConv && conv?.participants.length === 2));
    const utter: Utterance = { ...u, convId: conv?.convId ?? '', addressedToMe: addressed };
    this.o.store.update(
      'perception',
      (p) => ({ ...p, heardSpeech: [...p.heardSpeech, utter].slice(-RING_SPEECH) }),
      `heard ${u.from}`,
    );
    if (conv) {
      const fresh = this.get(conv.convId) ?? conv;
      this.write(
        {
          ...fresh,
          transcript: [...fresh.transcript, utter].slice(-TRANSCRIPT),
          turns: fresh.turns + 1,
          lastActivity: now,
          nudged: false,
          partnerOutOfRangeSince: undefined,
        },
        `heard ${u.from}`,
      );
    }
    if (addressed) this.o.bus.emit({ type: 'addressed', utterance: utter });
    else if (!tail) this.o.bus.emit({ type: 'overheard', utterance: utter });
  }

  /** Chiming in on a line that wasn't addressed to us (§6.2 floor control): it becomes a conversation turn. */
  adopt(u: Utterance): Utterance {
    const conv = this.withPartner(u.from) ?? this.open(u.from, false);
    const utter: Utterance = { ...u, convId: conv.convId, addressedToMe: true };
    const fresh = this.get(conv.convId) ?? conv;
    this.write({ ...fresh, transcript: [...fresh.transcript, utter].slice(-TRANSCRIPT), turns: fresh.turns + 1, lastActivity: this.now() }, `chimed in on ${u.from}`);
    this.o.bus.emit({ type: 'addressed', utterance: utter });
    return utter;
  }

  /** 1 Hz: partner out of range (> 10 s), silent (nudge at 20 s, end at 40 s). */
  private sweep(): void {
    const now = this.now();
    const inRange = new Set(this.o.inRange());
    for (const c of this.active()) {
      const partners = c.participants.filter((p) => p !== this.o.me);
      if (partners.every((p) => !inRange.has(p))) {
        const since = c.partnerOutOfRangeSince ?? now;
        if (c.partnerOutOfRangeSince === undefined) this.write({ ...c, partnerOutOfRangeSince: now }, 'partner out of range');
        else if (now - since > OUT_OF_RANGE_MS) this.end(c.convId, 'partner left');
        continue;
      }
      const lastTheirs = Math.max(c.startedAt, ...c.transcript.filter((u) => u.from !== this.o.me).map((u) => u.ts));
      if (now - lastTheirs > SILENT_END_MS && c.nudged) this.end(c.convId, 'partner silent');
      else if (now - lastTheirs > SILENT_NUDGE_MS && !c.nudged && c.myTurns > 0) {
        this.write({ ...c, nudged: true }, 'nudge');
        this.o.bus.emit({ type: 'needsDecision', reason: 'nudge', convId: c.convId });
      }
    }
  }

  private write(conv: ConversationState, reason: string): void {
    this.o.store.update('conversations', (all) => ({ ...all, [conv.convId]: conv }), reason);
  }
}
