// Talking (§4.2 module 8, §6.2): phrases what the CC decided, in character, over proximity chat. Coherence rule
// (§13 rule 3): without `mayCommit` Talking never promises anything. That is in the prompt AND checked in code
// (regenerate once, then "let me think about it."). A request gets a quick non-committal reply and wakes the CC with
// `needsDecision`; the CC's speechIntent then drives the real answer. Reply timing follows the busy matrix; lines
// that arrive while a reply is pending are answered together (batching).

import { type AgentName, type ConvId, type Decision, type Logger, type SpeechIntent, type Utterance, capWords } from '@agora/shared';
import type { ChatMessage, LlmClient } from '@agora/llm';
import { SingleFlight } from '@agora/llm';
import type { AgentBus } from '../bus';
import type { Body } from '../body/body';
import { talkPolicy } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import type { Conversations } from './conversations';
import type { SkillExecutor } from './executor';
import { NO_PROMISE_RULE, STRICT_NO_PROMISE_RULE, personaCore, talkRules } from './prompts';

export const PROMISE_RE =
  /\b(i'?ll|i will|i can do (that|it)|sure,? i can|deal\b|i promise|you got it|i'?m on it|on it\b|consider it done|will do\b|count me in|leave it to me|i'?ll (bring|get|give|grab|fetch|help|build|make|meet))\b/i;
export const GIVEAWAY_RE = /\b(as an ai|an ai\b|ai model|a bot\b|language model|chatbot|virtual assistant|openai|anthropic|llm\b|i am an? (ai|bot|program))\b/i;
export const REQUEST_RE =
  /\b(can|could|would|will) you\b|\b(give|bring|lend|show|teach|help) me\b|\bwanna\b|\bwant to\b|\blet'?s\b|\btrade\b|\bfollow me\b|\bcome (here|with|over)\b|\bdo you have\b|\bi need (some|a|an|any)\b/i;

export function looksLikePromise(text: string): boolean {
  return PROMISE_RE.test(text);
}

export function needsDecision(text: string): boolean {
  return REQUEST_RE.test(text);
}

/** One clean chat line from a model reply: no "Name:" prefix, no quotes, no commands, capped. */
export function cleanReply(raw: string, me: string, maxWords: number): string {
  let t = (raw.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  t = t.replace(new RegExp(`^(${me}|me|you)\\s*[:>»-]\\s*`, 'i'), '');
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  t = t.replace(/^[/\\]+/, '');
  return capWords(t, maxWords);
}

const CANNED: Readonly<Record<SpeechIntent['stance'], readonly string[]>> = {
  agree: ['sure', 'ok, can do', 'yeah, alright'],
  decline: ['nah, not right now', 'sorry, can\'t right now'],
  negotiate: ["what's in it for me?", 'maybe, what do I get?'],
  inform: ['hm'],
  ask: ['hmm, let me think about it', 'what for?', 'give me a sec to think'],
  chat: ['heh', 'yeah', 'hey'],
  none: [''],
  hostile: ['back off'],
  threaten: ['you better not'],
  yield: ['ok ok, I give up'],
  rally: ["let's go!"],
  flirt: ['heh, hi'],
  propose: ['how about it?'],
  apologize: ['sorry about that'],
};

export interface TalkingOptions {
  store: AgentStateStore;
  bus: AgentBus;
  body: Body;
  logger: Logger;
  llm: LlmClient | null;
  conversations: Conversations;
  executor: SkillExecutor;
  me: AgentName;
  /** Memories relevant to what was just said (M4), hearsay labeled. */
  recall?: (text: string, k: number) => Promise<string[]>;
  rng?: () => number;
  now?: () => number;
}

interface Pending {
  lines: Utterance[];
  timer: NodeJS.Timeout;
}

export class Talking {
  private readonly pending = new Map<ConvId, Pending>();
  /** Conversations waiting for the CC's answer to a request. */
  private readonly awaiting = new Map<ConvId, number>();
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private lastCanned = 0;
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(private readonly o: TalkingOptions) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('addressed', (e) => this.onAddressed(e.utterance)));
    this.offs.push(this.o.bus.on('decision', (e) => this.onDecision(e.decision)));
    this.offs.push(
      this.o.bus.on('needsDecision', (e) => {
        if (e.reason === 'nudge' && e.convId) void this.say(e.convId, [], { stance: 'ask', gist: 'check whether they are still there', mayCommit: false });
      }),
    );
  }

  stop(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const off of this.offs.splice(0)) off();
  }

  private busyLevel(): 'idle' | 'working' | 'critical' {
    const f = this.o.store.state.flags;
    if (f.inDanger) return 'critical';
    return this.o.executor.busy ? 'working' : 'idle';
  }

  private speakerBusy(name: AgentName): boolean {
    const t = this.now();
    return this.o.store.state.perception.observedActions.some((a) => a.actor === name && t - a.ts < 3000 && (a.kind === 'dig' || a.kind === 'swing'));
  }

  private onAddressed(u: Utterance): void {
    if (!u.convId) return;
    const p = this.pending.get(u.convId);
    if (p) {
      p.lines.push(u); // batched into the pending reply
      return;
    }
    const level = this.busyLevel();
    const j = (lo: number, hi: number) => lo + this.rng() * (hi - lo);
    const delay = level === 'critical' ? j(200, 500) : level === 'working' ? j(600, 1500) : this.speakerBusy(u.from) ? j(1500, 3000) : j(300, 900);
    const timer = setTimeout(() => void this.flush(u.convId), delay);
    this.pending.set(u.convId, { lines: [u], timer });
  }

  private async flush(convId: ConvId): Promise<void> {
    const p = this.pending.get(convId);
    this.pending.delete(convId);
    if (!p) return;
    const level = this.busyLevel();
    if (level === 'critical') {
      const line = this.o.store.state.flags.busySpeech;
      if (line && this.now() - this.lastCanned > 10_000) {
        this.lastCanned = this.now();
        await this.send(convId, line);
      }
      return;
    }
    const request = p.lines.some((l) => needsDecision(l.text));
    const from = p.lines[p.lines.length - 1]?.from;
    let intent: SpeechIntent;
    if (request) {
      this.awaiting.set(convId, this.now());
      this.o.bus.emit({ type: 'needsDecision', reason: 'request', convId, from });
      intent = { stance: 'ask', gist: 'you need a moment to think about it; maybe ask a short question', mayCommit: false };
    } else if (level === 'working' && !this.o.executor.talkOverable()) {
      intent = { stance: 'chat', gist: `you're busy with ${this.o.store.state.option?.skill ?? 'something'}; a short reply`, mayCommit: false };
    } else {
      intent = this.currentIntent(from) ?? { stance: 'chat', gist: 'friendly and short', mayCommit: false };
    }
    await this.say(convId, p.lines, intent);
  }

  /** A fresh CC speech intent aimed at this person (or at whoever we're talking to). */
  private currentIntent(person: AgentName | undefined): SpeechIntent | null {
    const d = this.o.store.state.decision;
    if (!d?.speechIntent || d.speechIntent.stance === 'none' || this.now() - d.createdAt > 60_000) return null;
    if (d.target?.agent && person && d.target.agent !== person) return null;
    return d.speechIntent;
  }

  private onDecision(d: Decision): void {
    const intent = d.speechIntent;
    if (!intent || intent.stance === 'none') return;
    const person = d.target?.agent;
    // The answer to a request we stalled on, or the opening line of a talk option.
    const waiting = [...this.awaiting.keys()].find((id) => !person || this.o.conversations.get(id)?.participants.includes(person));
    if (waiting) {
      this.awaiting.delete(waiting);
      void this.say(waiting, [], intent);
      return;
    }
    if (d.option === 'talk' && person) void this.openWhenInRange(person, intent, d.id);
  }

  private async openWhenInRange(person: AgentName, intent: SpeechIntent, decisionId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      if (this.o.store.state.decision?.id !== decisionId) return;
      const near = this.o.store.state.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === person && e.distance <= 8);
      if (near) {
        if (!this.o.conversations.mayInitiate(person) && !this.o.conversations.withPartner(person)) return;
        const conv = this.o.conversations.open(person, true);
        await this.say(conv.convId, [], intent);
        return;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  private async say(convId: ConvId, incoming: Utterance[], intent: SpeechIntent): Promise<void> {
    await this.flight.run(convId, async () => {
      const conv = this.o.conversations.get(convId);
      if (!conv || conv.status === 'ended') return;
      const text = await this.compose(convId, incoming, intent);
      if (!text) return;
      await this.send(convId, text, intent.volume);
    });
  }

  private passes(text: string, intent: SpeechIntent): boolean {
    return text.length > 0 && !GIVEAWAY_RE.test(text) && (intent.mayCommit || !looksLikePromise(text));
  }

  private async send(convId: ConvId, text: string, volume: SpeechIntent['volume'] = 'normal'): Promise<void> {
    const conv = this.o.conversations.get(convId);
    try {
      await this.o.body.say(text, volume ?? 'normal', conv?.participants.filter((p) => p !== this.o.me) ?? []);
    } catch (err) {
      this.o.logger.info({ module: 'talking', err: String(err) }, 'did not say a line');
      return;
    }
    this.o.conversations.noteOwnUtterance(convId, text);
  }

  private canned(intent: SpeechIntent): string {
    const persona = this.o.store.state.self.persona;
    const pool = intent.stance === 'agree' && !intent.mayCommit ? CANNED.ask : CANNED[intent.stance];
    if (intent.stance === 'chat' && persona.speech.catchphrases.length > 0 && this.rng() < 0.3) {
      return persona.speech.catchphrases[Math.floor(this.rng() * persona.speech.catchphrases.length)] ?? '';
    }
    return pool[Math.floor(this.rng() * pool.length)] ?? '';
  }

  /** The line to say, with the commitment and giveaway guards applied. */
  private async compose(convId: ConvId, incoming: Utterance[], intent: SpeechIntent): Promise<string> {
    const s = this.o.store.state;
    const persona = s.self.persona;
    const llm = this.o.llm;
    if (!llm) return this.canned(intent);
    const conv = s.conversations[convId];
    const transcript = (conv?.transcript ?? []).slice(-8).map((u) => `${u.from === this.o.me ? 'You' : u.from}: ${u.text}`);
    const activity = s.option ? `${s.option.option}${s.option.skill ? ` (${s.option.skill})` : ''}${s.option.progress ? `, ${s.option.progress}` : ''}` : 'nothing in particular';
    const query = incoming.map((u) => u.text).join(' ') || intent.gist;
    const remembered = this.o.recall ? await this.o.recall(query, 3).catch(() => [] as string[]) : [];
    const onMind = s.workmem
      .slice(-3)
      .map((w) => w.text)
      .filter((t) => !remembered.includes(t));
    const user = [
      `Right now you are: ${activity}.`,
      s.selfSummary ? `About you: ${s.selfSummary}` : '',
      onMind.length > 0 ? `On your mind: ${onMind.join('; ')}` : '',
      remembered.length > 0 ? `You remember:\n${remembered.map((m) => `- ${m}`).join('\n')}` : '',
      `What you want to get across: ${intent.stance} — ${intent.gist}`,
      transcript.length > 0 ? `Conversation so far:\n${transcript.join('\n')}` : 'You are starting the conversation.',
      incoming.length > 0 ? `Reply to: ${incoming.map((u) => `${u.from}: "${u.text}"`).join(' / ')}` : '',
      `Write ${persona.name}'s next line.`,
    ]
      .filter(Boolean)
      .join('\n');
    const rule = intent.mayCommit ? `You may agree to this: ${intent.gist}` : NO_PROMISE_RULE;
    const system = (extra: string) => `${personaCore(persona, s.traitAnnotations)}\n\n${talkRules(persona.speech.maxWords)}\n${rule}${extra ? `\n${extra}` : ''}`;
    const guard = this.o.store.guard(talkPolicy(convId));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages: ChatMessage[] = [
          { role: 'system', content: system(attempt === 0 ? '' : STRICT_NO_PROMISE_RULE) },
          { role: 'user', content: user },
        ];
        // §5: stream, and send the first sentence as soon as it is complete (if it passes the guards).
        const st: { buf: string; first: string | null; sent: Promise<void> | null } = { buf: '', first: null, sent: null };
        const r = await llm.call<string>({
          tier: 'L1',
          module: 'talking',
          agent: this.o.me,
          messages,
          fallback: () => this.canned(intent),
          signal: guard.signal,
          isStale: guard.isStale,
          temperature: 0.8,
          onText: (d) => {
            st.buf += d;
            if (st.first !== null) return;
            const m = /^(.{8,}?[.!?])(\s|$)/s.exec(st.buf.trimStart());
            if (!m?.[1]) return;
            const sentence = cleanReply(m[1], persona.name, persona.speech.maxWords);
            st.first = this.passes(sentence, intent) ? sentence : '';
            if (st.first) st.sent = this.send(convId, sentence, intent.volume);
          },
        });
        if (!r.ok && (r.reason === 'stale' || r.reason === 'aborted')) return '';
        const text = cleanReply(r.value, persona.name, persona.speech.maxWords);
        if (st.sent && st.first) {
          await st.sent;
          const at = text.indexOf(st.first);
          const budget = Math.max(1, persona.speech.maxWords - st.first.split(' ').length);
          const rest = cleanReply(text.slice(at >= 0 ? at + st.first.length : st.first.length), persona.name, budget);
          return rest && this.passes(rest, intent) && /[a-z]/i.test(rest) ? rest : '';
        }
        if (this.passes(text, intent)) return text;
        if (!intent.mayCommit && looksLikePromise(text)) this.o.logger.info({ module: 'talking', text }, 'draft sounded like a promise without mayCommit');
      }
      return intent.mayCommit ? this.canned(intent) : 'let me think about it.';
    } finally {
      guard.dispose();
    }
  }
}
