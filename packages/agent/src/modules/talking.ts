// Talking (§4.2 module 8, §6.2): phrases what the CC decided, in character, over proximity chat. Coherence rule
// (§13 rule 3): without `mayCommit` Talking never promises anything. That is in the prompt AND checked in code
// (regenerate once, then "let me think about it."). A request gets a quick non-committal reply and wakes the CC with
// `needsDecision`; the CC's speechIntent then drives the real answer. Reply timing follows the busy matrix; lines
// that arrive while a reply is pending are answered together (batching).

import { type AgentName, type ConvId, type Decision, type EmotionName, type EmotionState, type Logger, type SpeechIntent, type Utterance, capWords } from '@agora/shared';
import type { ChatMessage, LlmClient } from '@agora/llm';
import { SingleFlight } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import type { Body } from '../body/body';
import { SURRENDER_RE } from '../body/skills/duel';
import { talkPolicy } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import type { Conversations } from './conversations';
import type { SkillExecutor } from './executor';
import { topEmotion } from '../mind/emotions';
import { parseTradeOffer } from '../social/trades';
import { NO_PROMISE_RULE, STRICT_NO_PROMISE_RULE, personaCore, talkRules } from './prompts';

export const PROMISE_RE =
  /\b(i'?ll|i will|i can do (that|it)|sure,? i can|deal\b|i promise|you got it|i'?m on it|on it\b|consider it done|will do\b|count me in|leave it to me|i'?ll (bring|get|give|grab|fetch|help|build|make|meet))\b/i;
export const GIVEAWAY_RE = /\b(as an ai|an ai\b|ai model|a bot\b|language model|chatbot|virtual assistant|openai|anthropic|llm\b|i am an? (ai|bot|program))\b/i;
export const REQUEST_RE =
  /\b(can|could|would|will) you\b|\b(give|bring|lend|show|teach|help) me\b|\bwanna\b|\bwant to\b|\blet'?s\b|\btrade\b|\bfollow me\b|\bcome (here|with|over)\b|\bdo you have\b|\bi need (some|a|an|any)\b/i;

const AddressedSchema = z.object({ addressedToMe: z.boolean() });

/** Options whose speech intent is said first, once the person is in range. */
const OPENS_WITH_A_LINE: ReadonlySet<string> = new Set(['talk', 'fight', 'demand', 'recruit']);

export function looksLikePromise(text: string): boolean {
  return PROMISE_RE.test(text);
}

export function needsDecision(text: string): boolean {
  return REQUEST_RE.test(text) || parseTradeOffer(text) !== null;
}

/** One clean chat line from a model reply: no "Name:" prefix, no quotes, no commands, capped. */
export function cleanReply(raw: string, me: string, maxWords: number): string {
  let t = (raw.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  t = t.replace(new RegExp(`^(${me}|me|you)\\s*[:>»-]\\s*`, 'i'), '');
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  t = t.replace(/^[/\\]+/, '');
  return capWords(t, maxWords);
}

const GREETINGS: readonly string[] = ['hey!', 'hi there', 'hello!', 'oh, hey', 'hey, how is it going?'];

/** Small talk when one feeling is strong (§18.2 expression). */
const FEELING_LINES: Partial<Record<EmotionName, readonly string[]>> = {
  anger: ['what now?', 'not in the mood.', 'ugh. what?'],
  sadness: ['*sighs*', 'yeah... I guess.', "it's been a rough day."],
  joy: ['haha, yes!', 'what a day!', 'ooh, this is great!'],
  fear: ["it's not safe here...", 'did you hear that?'],
  shame: ['...sorry.', "I'd rather not talk about it."],
};

/** "angry", "a little sad": the feeling worth mentioning to the model (§18.2 expression). */
export function feelingText(e: EmotionState): string | null {
  const t = topEmotion(e);
  if (!t) return null;
  const word: Record<EmotionName, string> = { anger: 'angry', fear: 'afraid', joy: 'happy', sadness: 'sad', disgust: 'disgusted', shame: 'ashamed', envy: 'envious', affection: 'warm toward people' };
  return `${t.intensity > 0.7 ? 'very ' : t.intensity < 0.4 ? 'a little ' : ''}${word[t.name]}`;
}

const CANNED: Readonly<Record<SpeechIntent['stance'], readonly string[]>> = {
  agree: ['sure', 'ok, can do', 'yeah, alright'],
  decline: ['nah, not right now', 'sorry, can\'t right now'],
  negotiate: ["what's in it for me?", 'maybe, what do I get?'],
  inform: ['hm'],
  ask: ['hmm, let me think about it', 'what for?', 'give me a sec to think'],
  chat: ['heh', 'yeah', 'hey'],
  none: [''],
  hostile: ['what do you want?', 'leave me alone.', 'keep your distance.', 'get lost.'],
  threaten: ['back off, or else.', "don't push me.", 'leave, or we fight.'],
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
  /** The conflict rung toward someone (§17.5): 1 hostile talk, 2 threats. */
  rungOf?: (name: AgentName) => number;
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
    this.offs.push(this.o.bus.on('heard', () => this.heardLines++));
    this.offs.push(this.o.bus.on('overheard', (e) => this.onOverheard(e.utterance)));
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

  private heardLines = 0;
  /** heardLines at our last unaddressed interjection. */
  private lastChime = -100;

  /**
   * §6.2 group floor control: a line not addressed to us. An unclear one gets a tiny L1 check when there is a
   * model; one meant for us in particular is answered right away. Otherwise wait 1.5–4 s and chime in only if
   * nobody else has answered, at most once per three turns, and lines aimed at someone else rarely.
   */
  private onOverheard(u: Utterance): void {
    const s = this.o.store.state;
    if (s.flags.inDanger || u.volume === 'whisper' || this.heardLines - this.lastChime < 3) return;
    if (u.heardAs === 'other' && this.rng() > s.self.persona.big5.extraversion * 0.3) return;
    if (u.heardAs !== 'other' && u.heardAs !== 'unsure') return;
    const go = async () => {
      if (u.heardAs === 'unsure' && this.o.llm && !s.flags.codeOnly && this.busyLevel() !== 'critical') {
        const forMe = await this.classify(u);
        if (forMe) {
          this.lastChime = this.heardLines;
          this.o.conversations.adopt(u);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 1500 + this.rng() * 2500));
      if (this.someoneAnswered(u) || this.heardLines - this.lastChime < 3) return;
      this.lastChime = this.heardLines;
      this.o.conversations.adopt(u);
    };
    void go().catch((err: unknown) => this.o.logger.info({ module: 'talking', err: String(err) }, 'interjection failed'));
  }

  /** Someone other than the speaker (and us) spoke after `u`: the floor is taken. */
  private someoneAnswered(u: Utterance): boolean {
    return this.o.store.state.perception.heardSpeech.some((x) => x.ts > u.ts && x.from !== u.from && x.from !== this.o.me);
  }

  /** Tiny L1 check on an unclear line: meant for me in particular? (General questions to everyone are not.) */
  private async classify(u: Utterance): Promise<boolean> {
    const llm = this.o.llm;
    if (!llm) return false;
    const s = this.o.store.state;
    const around = this.o.conversations.active().flatMap((c) => c.participants).filter((p) => p !== this.o.me);
    const r = await llm.call<{ addressedToMe: boolean }>({
      tier: 'L1',
      module: 'talking',
      agent: this.o.me,
      schema: AddressedSchema,
      schemaName: 'addressed',
      fallback: () => ({ addressedToMe: false }),
      messages: [
        {
          role: 'system',
          content: `You are ${s.self.persona.name}. Decide whether a line someone said nearby is meant for you in particular. A general question to everyone counts as false. JSON: {"addressedToMe": true|false}`,
        },
        { role: 'user', content: `${u.from} said: "${u.text}". People around: ${[...new Set(around)].join(', ') || 'unknown'}.` },
      ],
    });
    return r.ok && r.value.addressedToMe;
  }

  /** People we won't talk to for a while (refused on impulse, §18.5): name → until. */
  private readonly refusing = new Map<AgentName, number>();

  /** Says something right away to them, no model and no waiting (§18.5 outbursts); replaces a reply in the making. */
  async blurt(to: AgentName, text: string, volume: SpeechIntent['volume'] = 'normal'): Promise<boolean> {
    const conv = this.o.conversations.withPartner(to) ?? this.o.conversations.open(to, true);
    const p = this.pending.get(conv.convId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(conv.convId);
    }
    return this.send(conv.convId, text, volume);
  }

  /** Says a line to the nearest person in earshot, if anyone is (§6.8: what one is doing for the village). */
  async announce(text: string, range = 12): Promise<boolean> {
    const near = this.o.store.state.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.visible && e.distance <= range).sort((a, b) => a.distance - b.distance)[0];
    return near ? this.blurt(near.name, text) : false;
  }

  /** Won't answer them for `ms` (sulking, refusing to talk). */
  refuse(name: AgentName, ms: number): void {
    this.refusing.set(name, this.now() + ms);
  }

  private onAddressed(u: Utterance): void {
    if (!u.convId) return;
    if ((this.refusing.get(u.from) ?? 0) > this.now()) return;
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
    // Someone giving up a fight is let stand (§17.6): no answer, least of all a threat.
    if (p.lines.every((l) => SURRENDER_RE.test(l.text))) return;
    const request = p.lines.some((l) => needsDecision(l.text));
    const from = p.lines[p.lines.length - 1]?.from;
    let intent: SpeechIntent;
    if (request) {
      this.awaiting.set(convId, this.now());
      this.o.bus.emit({ type: 'needsDecision', reason: 'request', convId, from });
      intent = { stance: 'ask', gist: 'you need a moment to think about it; maybe ask a short question', mayCommit: false };
    } else if (from && (this.o.rungOf?.(from) ?? 0) >= 1) {
      // §17.5 rungs 1–2: short and sharp, or a warning, unless we just decided to say something else to them.
      const aimed = this.o.store.state.decision?.target?.agent === from ? this.currentIntent(from) : null;
      intent =
        aimed ??
        ((this.o.rungOf?.(from) ?? 0) >= 2
          ? { stance: 'threaten', gist: "warn them off; you're close to a fight", mayCommit: false }
          : { stance: 'hostile', gist: "you can't stand them: short and sharp", mayCommit: false });
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
    // A talk option opens with its line; so does a fight (a threat, then blows), a demand (§17.7) and a call to
    // rise together (§17.8).
    if (OPENS_WITH_A_LINE.has(d.option) && person) void this.openWhenInRange(person, intent, d.id);
  }

  private async openWhenInRange(person: AgentName, intent: SpeechIntent, decisionId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      if (this.o.store.state.decision?.id !== decisionId) return;
      const near = this.o.store.state.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === person && e.distance <= 8);
      if (near) {
        // A warning or a threat doesn't wait out the pause between friendly chats.
        const sharp = intent.stance === 'hostile' || intent.stance === 'threaten';
        if (!sharp && !this.o.conversations.mayInitiate(person) && !this.o.conversations.withPartner(person)) return;
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
      // Chiming in (floor control): someone else may have answered while we were thinking or typing.
      const chimingIn = incoming.length > 0 && incoming.every((u) => u.heardAs !== 'me');
      const stillWanted = chimingIn ? () => !incoming.some((u) => this.someoneAnswered(u)) : undefined;
      const text = await this.compose(convId, incoming, intent);
      const sent = !text || (stillWanted && !stillWanted()) ? false : await this.send(convId, text, intent.volume, stillWanted);
      if (!sent && chimingIn) {
        this.o.logger.info({ module: 'talking' }, 'someone else answered first; staying quiet');
        this.o.conversations.discardIfUnspoken(convId);
      }
    });
  }

  private passes(text: string, intent: SpeechIntent): boolean {
    return text.length > 0 && !GIVEAWAY_RE.test(text) && (intent.mayCommit || !looksLikePromise(text));
  }

  private async send(convId: ConvId, text: string, volume: SpeechIntent['volume'] = 'normal', stillWanted?: () => boolean): Promise<boolean> {
    const conv = this.o.conversations.get(convId);
    try {
      const sent = await this.o.body.say(text, volume ?? 'normal', conv?.participants.filter((p) => p !== this.o.me) ?? [], stillWanted);
      if (!sent) return false;
    } catch (err) {
      this.o.logger.info({ module: 'talking', err: String(err) }, 'did not say a line');
      return false;
    }
    this.o.conversations.noteOwnUtterance(convId, text);
    return true;
  }

  /**
   * A line without a model. What the CC worded (a promise, a counter-offer, a demand, a call to rise, news) is said
   * as worded, once per conversation (`said` tells what we already said there); after that the stance's own lines.
   */
  private canned(intent: SpeechIntent, opening = false, said: (line: string) => boolean = () => false): string {
    const persona = this.o.store.state.self.persona;
    const worded = this.worded(intent);
    if (worded && !said(worded)) return worded;
    // §18.2 expression: a strong feeling colors small talk.
    const felt = topEmotion(this.o.store.state.emotions);
    if (intent.stance === 'chat' && felt && felt.intensity > 0.55) {
      const moodLines = FEELING_LINES[felt.name];
      if (moodLines) return moodLines[Math.floor(this.rng() * moodLines.length)] ?? '';
    }
    const pool = opening && intent.stance === 'chat' ? GREETINGS : intent.stance === 'agree' && !intent.mayCommit ? CANNED.ask : CANNED[intent.stance];
    if (intent.stance === 'chat' && persona.speech.catchphrases.length > 0 && this.rng() < 0.3) {
      return persona.speech.catchphrases[Math.floor(this.rng() * persona.speech.catchphrases.length)] ?? '';
    }
    return pool[Math.floor(this.rng() * pool.length)] ?? '';
  }

  /** What the CC worded to be said as it is, if anything. */
  private worded(intent: SpeechIntent): string | null {
    // A promise the CC allowed is said plainly, so the other side knows what was agreed (§6.4).
    if (intent.stance === 'agree' && intent.mayCommit && /^I('ll|'m) /.test(intent.gist) && intent.gist.length <= 80) return `sure! ${intent.gist}`;
    // A counter-offer is said as it is, so the other side can take it or leave it (§6.6).
    if (intent.stance === 'negotiate' && /^how about /i.test(intent.gist) && intent.gist.length <= 100) return intent.gist;
    // A demand (§17.7), the signal to strike together, a call to rise up, or news about someone (§17.8): said as
    // worded, so it is understood.
    if (intent.stance === 'threaten' && /^(give|bring|hand|now!)/i.test(intent.gist) && intent.gist.length <= 100) return intent.gist;
    if ((intent.stance === 'rally' || intent.stance === 'inform') && intent.gist.length > 0 && intent.gist.length <= 120) return intent.gist;
    // Giving in to a demand: said grudgingly, but plainly (§17.7).
    if (intent.stance === 'agree' && intent.mayCommit && /^fine\. I'll /.test(intent.gist) && intent.gist.length <= 80) return intent.gist;
    return null;
  }

  /** The line to say, with the commitment and giveaway guards applied. */
  private async compose(convId: ConvId, incoming: Utterance[], intent: SpeechIntent): Promise<string> {
    const s = this.o.store.state;
    const persona = s.self.persona;
    const llm = this.o.llm;
    if (!llm) {
      const transcript = s.conversations[convId]?.transcript ?? [];
      return this.canned(intent, incoming.length === 0 && transcript.length === 0, (line) => transcript.some((u) => u.from === this.o.me && u.text === line));
    }
    const conv = s.conversations[convId];
    const transcript = (conv?.transcript ?? []).slice(-8).map((u) => `${u.from === this.o.me ? 'You' : u.from}: ${u.text}`);
    const activity = s.option ? `${s.option.option}${s.option.skill ? ` (${s.option.skill})` : ''}${s.option.progress ? `, ${s.option.progress}` : ''}` : 'nothing in particular';
    const query = incoming.map((u) => u.text).join(' ') || intent.gist;
    const remembered = this.o.recall ? await this.o.recall(query, 3).catch(() => [] as string[]) : [];
    const onMind = s.workmem
      .slice(-3)
      .map((w) => w.text)
      .filter((t) => !remembered.includes(t));
    // How we feel about them colors the reply (§6.3), and open promises are fair to bring up (§6.4).
    const partners = (conv?.participants ?? []).filter((p) => p !== this.o.me);
    const about = partners.map((name) => {
      const p = s.social[name];
      if (!p) return `${name} is new to you.`;
      const owes = s.commitments.filter((c) => c.status === 'accepted' && ((c.debtor === name && c.creditor === this.o.me) || (c.debtor === this.o.me && c.creditor === name)));
      const promises = owes.map((c) => (c.debtor === name ? `${name} owes you ${c.what.text}` : `you owe ${name} ${c.what.text}`));
      return `You feel ${Math.round(p.sentiment)}/10 about ${name}${p.trust < 0.35 ? ' and don\u2019t trust them much' : ''}.${p.summary ? ` ${p.summary}` : ''}${promises.length > 0 ? ` ${promises.join('; ')}.` : ''}`;
    });
    const feeling = feelingText(s.emotions);
    const user = [
      `Right now you are: ${activity}.`,
      s.selfSummary ? `About you: ${s.selfSummary}` : '',
      feeling ? `You feel ${feeling}; let it show in how you talk.` : '',
      ...about,
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
        // §5: stream, and send the first sentence as soon as it is complete (if it passes the guards). When chiming
        // in, it still yields to anyone who answered first (§6.2 floor control).
        const st: { buf: string; first: string | null; sent: Promise<boolean> | null } = { buf: '', first: null, sent: null };
        const chimingIn = incoming.length > 0 && incoming.every((u) => u.heardAs !== 'me');
        const stillWanted = chimingIn ? () => !incoming.some((u) => this.someoneAnswered(u)) : undefined;
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
            if (st.first) st.sent = this.send(convId, sentence, intent.volume, stillWanted);
          },
        });
        if (!r.ok && (r.reason === 'stale' || r.reason === 'aborted')) return '';
        const text = cleanReply(r.value, persona.name, persona.speech.maxWords);
        if (st.sent && st.first) {
          if (!(await st.sent)) return '';
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
