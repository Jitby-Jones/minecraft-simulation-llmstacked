// Talking (§4.2 module 8, §6.2): phrases what the CC decided, in character, over proximity chat. Coherence rule
// (§13 rule 3): without `mayCommit` Talking never promises anything. That is in the prompt AND checked in code
// (regenerate once, then "let me think about it."). A request gets a quick non-committal reply and wakes the CC with
// `needsDecision`; the CC's speechIntent then drives the real answer. Reply timing follows the busy matrix; lines
// that arrive while a reply is pending, from anyone, are answered together (batching), one line at a time.

import { type AgentName, type ConvId, type Decision, type EmotionName, type EmotionState, type Logger, type SpeechIntent, type Utterance, countWords, dropUnfinished, endsSentence, fitWords, maxTurnsFor, mentionsName } from '@agora/shared';
import type { ChatMessage, LlmClient } from '@agora/llm';
import { SingleFlight } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import type { Body } from '../body/body';
import { SURRENDER_RE } from '../body/skills/duel';
import { talkPolicy } from '../state/policies';
import { pushWorkmem } from '../state/workmem';
import type { AgentStateStore } from '../state/store';
import type { Conversations } from './conversations';
import type { SkillExecutor } from './executor';
import { topEmotion } from '../mind/emotions';
import { OPINION_ASK_RE } from '../social/opinions';
import { NOT_PG_RE, statedSex } from '../social/romance';
import { ACCEPTANCE, BREAKUP_LINE, COMPLIMENTS, DECLINE_LINES, FLIRT_BACK, GIFT_LINE, PROPOSAL, REJECTION_LINES, isAdvance } from '../social/romanceWatch';
import { FAMILY_HAPPY, FAMILY_NOT_YET, FAMILY_PROPOSAL, FAMILY_YES, isFamilyAsk } from '../social/familyWatch';
import { parseTradeOffer } from '../social/trades';
import { NO_PROMISE_RULE, PG_RULE, STRICT_NO_PROMISE_RULE, personaCore, talkRules } from './prompts';
import { planText } from './plan';
import { isOff } from '../state/switches';

export const PROMISE_RE =
  /\b(i'?ll|i will|i can do (that|it)|sure,? i can|deal\b(?!\s+with)|i promise|you got it|i'?m on it|on it\b|consider it done|will do\b|count me in|leave it to me|i'?ll (bring|get|give|grab|fetch|help|build|make|meet))\b/i;
export const GIVEAWAY_RE = /\b(as an ai|an ai\b|ai model|a bot\b|language model|chatbot|virtual assistant|openai|anthropic|llm\b|i am an? (ai|bot|program))\b/i;
export const REQUEST_RE =
  /\b(can|could|would|will) you\b|\b(give|bring|lend|show|teach|help) me\b(?! a (sec|second|minute|moment)\b)|\bwanna\b|\bwant to\b|\blet'?s\b|\btrade\b|\bfollow me\b|\bcome (here|with|over)\b|\bdo you have\b|\bi need (some|a|an|any)\b/i;

const AddressedSchema = z.object({ addressedToMe: z.boolean() });

/** Options whose speech intent is said first, once the person is in range. */
const OPENS_WITH_A_LINE: ReadonlySet<string> = new Set(['talk', 'fight', 'demand', 'recruit', 'court']);
/** A fight's threat stands this long: a decision going on with the fight doesn't say another. */
const FIGHT_ANNOUNCED_MS = 15_000;
/** §6.2 floor control for a line nobody asked for: said once nobody in earshot has spoken for this long. */
const LULL_MS = 4000;
/**
 * Turn-taking (owner request, 2026-10-24: people talked over each other, and too fast). A line is read before it is
 * answered (READ_BASE_MS plus READ_MS_PER_CHAR a character, up to READ_MAX_MS), and a line waits for a gap of
 * FLOOR_GAP_MS after anyone else's (up to FLOOR_WAIT_MS) before it goes out.
 */
const READ_BASE_MS = 500;
const READ_MS_PER_CHAR = 30;
const READ_MAX_MS = 3500;
const FLOOR_GAP_MS = 1200;
/** Others who spoke this recently count as part of the talk (a group, when there are two or more of them). */
const GROUP_RECENT_MS = 30_000;
/** After a talk settled what to do: small talk waits this long (a question put to us by name doesn't). */
const FOCUS_MS = 45_000;
/** In a group talk, this many lines of ours over the turn cap within GROUP_WINDOW_MS is enough: back to it. */
const GROUP_SLACK = 2;
const GROUP_WINDOW_MS = 120_000;
/** One key for every line: we say one thing at a time. */
const SPEAK = 'speak';
/** Waiting for a lull this many times its length at most; then the line goes unsaid. */
const LULL_PATIENCE = 15;
/**
 * §19.2, §19.3: courting, starting a family, and the answers to them, said as worded so a listener's code reading
 * takes them the same way.
 */
const ROMANCE_LINES: ReadonlySet<string> = new Set(
  [...COMPLIMENTS, PROPOSAL, ACCEPTANCE, FLIRT_BACK, GIFT_LINE, BREAKUP_LINE, ...Object.values(DECLINE_LINES), ...Object.values(REJECTION_LINES), FAMILY_PROPOSAL, FAMILY_YES, FAMILY_NOT_YET, FAMILY_HAPPY].filter(Boolean),
);

/** §19.1: what one loves, as a first hello puts it ("I'm a guy who loves exploring"), from what one values. */
const LOVES: Readonly<Record<string, string>> = {
  exploration: 'exploring',
  friendship: 'meeting people',
  'hard work': 'building things',
  success: 'getting things done',
  safety: 'a safe, cozy home',
  loyalty: 'good friends',
  independence: 'doing things my own way',
  fun: 'a good laugh',
};

export function looksLikePromise(text: string): boolean {
  return PROMISE_RE.test(text);
}

export function needsDecision(text: string): boolean {
  return REQUEST_RE.test(text) || OPINION_ASK_RE.test(text) || parseTradeOffer(text) !== null || isAdvance(text) || isFamilyAsk(text);
}

/**
 * A model's working-out rather than a line in the talk: about the talk instead of in it ("Let me look at the situation.",
 * "I should respond in character", "Bram has been sending meta-lines", "Ada is in Minecraft, chatting with Bram"). Said
 * aloud, such lines turned a first meeting into two people discussing their own chat log.
 */
export function isMeta(line: string, me: string): boolean {
  const t = line.trim();
  if (META_RE.test(t)) return true;
  return new RegExp(`^${me}\\b,?\\s+(is|has|was|should|needs|wants|will|would)\\b`, 'i').test(t);
}
const META_RE =
  /^(let me (look at|understand|consider|figure out|check|read|parse|work out|go over|analy[sz]e|re-?read|review) (the|this|that) (situation|conversation|chat|context|messages?|log|exchange|request)|i (should|need to|will|'ll|must|want to|am going to) (respond|reply|acknowledge|stay in character|keep it (brief|short|casual|light|friendly))|(okay|alright|hmm+),? (let me|i need to|i should) (respond|reply|think about|look at|figure out)|the (user|conversation|context|prompt)\b|looking at (this|the) (conversation|chat|situation|context|messages?)\b|[A-Z][a-z]{1,15} has been (sending|saying|asking)\b)|\b(in character|out of character|meta[- ]?(lines?|messages?|text)|filler line|the chat log|my (next )?(reply|response) (should|will|is))\b/i;

/** The sentences of a reply that are said: from the first one that is not working-out ('' if none is). */
function saidPart(text: string, me: string): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const from = parts.findIndex((p) => !isMeta(p, me));
  return from < 0 ? '' : parts.slice(from).filter((p) => !isMeta(p, me)).join(' ');
}

/** A line of a reply as said: no "Name:" prefix, no quotes around it, no command slash. */
function cleanLine(line: string, me: string): string {
  let t = line.trim().replace(new RegExp(`^(${me}|me|you)\\s*[:>»-]\\s*`, 'i'), '');
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  return t.replace(/^[/\\]+/, '');
}

/**
 * One clean chat line from a model reply: no "Name:" prefix, no quotes, no commands, about `maxWords` words in whole
 * sentences (a line is never cut off mid-sentence just for running long). The first line of the reply, with the
 * next ones when it breaks off mid-sentence (a wrapped line), but never a line that reads as someone else's turn.
 */
export function cleanReply(raw: string, me: string, maxWords: number): string {
  // Working-out lines are not said: the first line that is talk, with what follows it.
  const lines = raw
    .split('\n')
    .map((l) => saidPart(cleanLine(l, me), me))
    .filter((l) => l.length > 0);
  let t = lines[0] ?? '';
  for (const next of lines.slice(1, 3)) {
    if (endsSentence(t) || /^[A-Za-z0-9_]{2,16}\s*[:>»]\s/.test(next)) break;
    t = `${t} ${cleanLine(next, me)}`;
  }
  return fitWords(t, maxWords);
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
  /** How long a lull must be before a line nobody asked for (tests shorten it). */
  lullMs?: number;
}

interface Pending {
  lines: Utterance[];
  timer: NodeJS.Timeout;
}

export class Talking {
  /** The reply in the making: every line put to us since, from anyone, answered together. */
  private pending: Pending | null = null;
  /** Until when small talk waits (a talk just settled what to do, or went on long enough). */
  private focusUntil = -Infinity;
  /** When we said our last lines (any conversation). */
  private saidAt: number[] = [];
  /** Conversations waiting for the CC's answer to a request. */
  private readonly awaiting = new Map<ConvId, number>();
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private lastCanned = 0;
  /** People we've said who we are to (§19.1). */
  private readonly introduced = new Set<AgentName>();
  private readonly rng: () => number;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly o: TalkingOptions) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.offs.push(this.o.bus.on('heard', () => this.heardLines++));
    this.offs.push(this.o.bus.on('overheard', (e) => this.onOverheard(e.utterance)));
    this.offs.push(this.o.bus.on('addressed', (e) => this.onAddressed(e.utterance)));
    this.offs.push(this.o.bus.on('decision', (e) => this.onDecision(e.decision)));
    // A talk settled what to do (consensus.ts): small talk waits a while; what was waiting is dropped, unless it
    // asked us something.
    this.offs.push(
      this.o.bus.on('agreed', () => {
        this.focusUntil = this.now() + FOCUS_MS;
        const p = this.pending;
        if (p && !p.lines.some((l) => needsDecision(l.text) || mentionsName(l.text, this.o.me))) {
          clearTimeout(p.timer);
          this.pending = null;
        }
      }),
    );
    // Turn-taking at the moment a line goes out (after typing): not over someone else's.
    const chat = (this.o.body as { chat?: { setFloor?: (f: () => number) => void } }).chat;
    chat?.setFloor?.(() => this.floorWait());
  }

  stop(): void {
    this.stopped = true;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
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
      if (u.heardAs === 'unsure' && this.o.llm && this.busyLevel() !== 'critical') {
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

  /** How long until the floor is ours: FLOOR_GAP_MS after anyone else's last line (0 when it is). */
  private floorWait(): number {
    const last = Math.max(-Infinity, ...this.o.store.state.perception.heardSpeech.filter((x) => x.from !== this.o.me).map((x) => x.ts));
    return Math.max(0, FLOOR_GAP_MS - (this.now() - last));
  }

  /** Two or more others (the speaker among them) spoke in earshot lately: a group talk. */
  private groupAround(speaker: AgentName | undefined): boolean {
    const t = this.now();
    const others = new Set(this.o.store.state.perception.heardSpeech.filter((x) => x.from !== this.o.me && t - x.ts < GROUP_RECENT_MS).map((x) => x.from));
    if (speaker) others.add(speaker);
    return others.size >= 2;
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
      thought: 'check',
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
  /** The last fight we opened with a threat: whom, and when. */
  private fightOpened: { person: AgentName; optionId: string | undefined; at: number } | null = null;

  /** Says something right away to them, no model and no waiting (§18.5 outbursts); replaces a reply in the making. */
  async blurt(to: AgentName, text: string, volume: SpeechIntent['volume'] = 'normal', urgent = false): Promise<boolean> {
    const conv = this.o.conversations.withPartner(to) ?? this.o.conversations.open(to, true);
    const p = this.pending;
    if (p) {
      p.lines = p.lines.filter((l) => l.from !== to);
      if (p.lines.length === 0) {
        clearTimeout(p.timer);
        this.pending = null;
      }
    }
    return this.send(conv.convId, text, volume, undefined, urgent);
  }

  /**
   * Says a line nobody asked for to those in earshot, if anyone is (§6.8: what one is doing for the village), at a
   * lull (§6.2 floor control): not over someone's question or the answers to it, nor all at once with others who
   * waited for the same quiet (each waits a little, at random, and looks again). Unsaid if no lull comes. It opens
   * no conversation: one of two would take whatever either says next as meant for the other.
   */
  async announce(text: string, range = 12): Promise<boolean> {
    const lull = this.o.lullMs ?? LULL_MS;
    const giveUp = this.now() + lull * LULL_PATIENCE;
    for (;;) {
      await new Promise((r) => setTimeout(r, lull * (0.5 + this.rng())));
      if (this.stopped) return false;
      const heard = this.o.store.state.perception.heardSpeech.filter((u) => u.from !== this.o.me);
      if (heard.every((u) => this.now() - u.ts >= lull)) break;
      if (this.now() >= giveUp) return false;
    }
    const around = this.o.store.state.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.visible && e.distance <= range).sort((a, b) => a.distance - b.distance);
    const near = around[0];
    if (!near) return false;
    // Already talking with them: it goes in that conversation.
    if (this.o.conversations.withPartner(near.name)) return this.blurt(near.name, text);
    try {
      return await this.o.body.say(text, 'normal', around.map((e) => e.name));
    } catch (err) {
      this.o.logger.info({ module: 'talking', err: String(err) }, 'did not say a line');
      return false;
    }
  }

  /** Won't answer them for `ms` (sulking, refusing to talk). */
  refuse(name: AgentName, ms: number): void {
    this.refusing.set(name, this.now() + ms);
  }

  /**
   * Done with talking for now (an urge of our own to move on): a goodbye in the talk if there is one, every talk
   * ended, the people in them (and `avoid`) left be for `holdMs`, and small talk waits as long. The thought goes on
   * our mind. Returns whom we were talking with.
   */
  async moveOn(o: { thought: string; say?: string; avoid?: readonly AgentName[]; holdMs: number }): Promise<AgentName[]> {
    const talks = this.o.conversations.active();
    const people = [...new Set([...talks.flatMap((c) => c.participants), ...(o.avoid ?? [])])].filter((p) => p !== this.o.me);
    const last = talks.sort((a, b) => b.lastActivity - a.lastActivity)[0];
    if (o.say && last) await this.send(last.convId, o.say, 'normal').catch(() => false);
    for (const c of this.o.conversations.active()) this.o.conversations.end(c.convId, 'moved on');
    for (const p of people) this.o.conversations.holdOff(p, o.holdMs);
    this.focusUntil = Math.max(this.focusUntil, this.now() + o.holdMs);
    const p = this.pending;
    if (p && !p.lines.some((l) => needsDecision(l.text))) {
      clearTimeout(p.timer);
      this.pending = null;
    }
    pushWorkmem(this.o.store, o.thought, 0.7, 'self_observed', { now: this.now() });
    return people;
  }

  private onAddressed(u: Utterance): void {
    if (!u.convId) return;
    if ((this.refusing.get(u.from) ?? 0) > this.now()) return;
    // A talk just settled what to do, or went on long enough: small talk waits; a question put to us doesn't.
    if (this.now() < this.focusUntil && !needsDecision(u.text) && !mentionsName(u.text, this.o.me)) return;
    if (this.pending) {
      this.pending.lines.push(u); // batched into the pending reply, whoever said it
      return;
    }
    const level = this.busyLevel();
    const j = (lo: number, hi: number) => lo + this.rng() * (hi - lo);
    // Read it first, as people do: a long line takes longer to answer than "hey".
    const read = Math.min(READ_MAX_MS, READ_BASE_MS + READ_MS_PER_CHAR * u.text.length);
    const delay = level === 'critical' ? j(200, 500) : level === 'working' ? Math.max(read * 0.6, j(600, 1500)) : this.speakerBusy(u.from) ? Math.max(read, j(1500, 3000)) : read + j(0, 600);
    const timer = setTimeout(() => void this.flush(), delay);
    this.pending = { lines: [u], timer };
  }

  private async flush(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    // One line at a time: while one is on its way, what came in since waits for it, and joins the batch.
    if (this.flight.inFlight(SPEAK)) {
      p.timer = setTimeout(() => void this.flush(), 400);
      return;
    }
    this.pending = null;
    // Answered in the conversation of whoever spoke last; the others we answer note the line too.
    const convId = p.lines[p.lines.length - 1]?.convId ?? '';
    const also = [...new Set(p.lines.map((l) => l.convId))].filter((id) => id && id !== convId);
    const level = this.busyLevel();
    if (level === 'critical') {
      const line = this.o.store.state.flags.busySpeech;
      if (line && this.now() - this.lastCanned > 10_000) {
        this.lastCanned = this.now();
        await this.send(convId, line, 'normal', undefined, false, also);
      }
      return;
    }
    // Someone giving up a fight is let stand (§17.6): no answer, least of all a threat.
    if (p.lines.every((l) => SURRENDER_RE.test(l.text))) return;
    const request = p.lines.some((l) => needsDecision(l.text));
    const from = p.lines[p.lines.length - 1]?.from;
    this.o.logger.debug({ module: 'talking', convId, from, lines: p.lines.map((l) => l.text), request, level }, 'reply');
    let intent: SpeechIntent;
    if (request) {
      this.awaiting.set(convId, this.now());
      this.o.bus.emit({ type: 'needsDecision', reason: 'request', convId, from });
      // Decided at once (in code): the answer is already on its way, and no "let me think" comes after it.
      if (!this.awaiting.has(convId)) return;
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
    await this.say(convId, p.lines, intent, from, undefined, also);
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
    const person = d.target?.agent;
    // The answer to a request we stalled on, or the opening line of a talk option.
    const waiting = [...this.awaiting.keys()].find((id) => !person || this.o.conversations.get(id)?.participants.includes(person));
    if (!intent || intent.stance === 'none') {
      // Decided, with nothing to say to them (an advance ignored, §19.10): no stall either.
      if (waiting && person) this.awaiting.delete(waiting);
      return;
    }
    if (waiting) {
      this.awaiting.delete(waiting);
      void this.say(waiting, [], intent, person ?? this.o.conversations.get(waiting)?.participants.find((n) => n !== this.o.me));
      return;
    }
    // A talk option opens with its line; so does a fight (a threat, then blows), a demand (§17.7) and a call to
    // rise together (§17.8).
    if (!OPENS_WITH_A_LINE.has(d.option) || !person) return;
    // A fight already announced (its threat on its way, or just said) isn't announced again by a decision going on
    // with it: the same fight, still running.
    const running = this.o.store.state.option;
    const prior = this.fightOpened;
    if (d.option === 'fight' && prior?.person === person && running?.status === 'running' && running.decisionId === prior.optionId && this.now() - prior.at < FIGHT_ANNOUNCED_MS) return;
    if (d.option === 'fight') this.fightOpened = { person, optionId: running?.decisionId, at: this.now() };
    // Courting (§19.2) and a family's business (§19.3, §19.5) are said on purpose, not small talk.
    void this.openWhenInRange(person, intent, d.id, d.option, d.option === 'court' || d.family !== undefined);
  }

  private async openWhenInRange(person: AgentName, intent: SpeechIntent, decisionId: string, option: string, onPurpose: boolean): Promise<void> {
    // The line opens what was decided, while it's on: no threat once the fight is over (or given up). A decision to
    // go on with what we're doing (the same option with them) keeps it on, as does the option already running,
    // started by an earlier one.
    const optionId = this.o.store.state.option?.decisionId;
    const on = () => {
      const s = this.o.store.state;
      const d = s.decision;
      const same = d?.id === decisionId || (d?.option === option && d.target?.agent === person);
      return same && (!s.option || s.option.decisionId !== optionId || s.option.status === 'running');
    };
    for (let i = 0; i < 40; i++) {
      if (!on()) return;
      const near = this.o.store.state.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === person && e.distance <= 8);
      if (near) {
        // A warning or a threat doesn't wait out the pause between friendly chats; nor does courting (§19.2) or a
        // family's business (§19.3, §19.5): said on purpose, not small talk.
        const sharp = onPurpose || intent.stance === 'hostile' || intent.stance === 'threaten';
        if (!sharp && !this.o.conversations.mayInitiate(person) && !this.o.conversations.withPartner(person)) return;
        const conv = this.o.conversations.open(person, true);
        await this.say(conv.convId, [], intent, person, on);
        return;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  /**
   * Says the line for this intent in the conversation; `to` is whom it is meant for, named in a worded line. `wanted`,
   * if given, is asked again just before the line goes out.
   */
  private async say(convId: ConvId, incoming: Utterance[], intent: SpeechIntent, to?: AgentName, wanted?: () => boolean, also: readonly ConvId[] = []): Promise<void> {
    await this.flight.run(SPEAK, async () => {
      let conv = this.o.conversations.get(convId);
      // An opening line whose conversation ended meanwhile (it had gone quiet): said in a new one.
      if ((!conv || conv.status === 'ended') && incoming.length === 0 && to && (wanted?.() ?? true)) conv = this.o.conversations.open(to, true);
      if (!conv || conv.status === 'ended') return;
      convId = conv.convId;
      // Chiming in (floor control): someone else may have answered while we were thinking or typing. So too in a
      // group, for a line not put to us by name: whoever answers first has the floor, and the rest of us take our turn
      // after, unless we have something else to say (no, a counter-offer, a sharp word).
      const chimingIn = incoming.length > 0 && incoming.every((u) => u.heardAs !== 'me');
      const ours = incoming.some((u) => mentionsName(u.text, this.o.me));
      const contrary = ['decline', 'negotiate', 'hostile', 'threaten', 'apologize'].includes(intent.stance);
      const groupTurn = incoming.length > 0 && !chimingIn && !ours && !contrary && this.groupAround(incoming[incoming.length - 1]?.from);
      const stillWanted = chimingIn || groupTurn ? () => !incoming.some((u) => this.someoneAnswered(u)) && (wanted?.() ?? true) : wanted;
      const text = await this.compose(convId, incoming, intent, to);
      const sent = !text || (stillWanted && !stillWanted()) ? false : await this.send(convId, text, intent.volume, stillWanted, false, also);
      if (!sent && (chimingIn || groupTurn)) {
        this.o.logger.info({ module: 'talking' }, 'someone else answered first; staying quiet');
        this.o.conversations.discardIfUnspoken(convId);
      }
    });
  }

  private passes(text: string, intent: SpeechIntent): boolean {
    return text.length > 0 && !isMeta(text, this.o.me) && !GIVEAWAY_RE.test(text) && !NOT_PG_RE.test(text) && (intent.mayCommit || !looksLikePromise(text));
  }

  private async send(convId: ConvId, text: string, volume: SpeechIntent['volume'] = 'normal', stillWanted?: () => boolean, urgent = false, also: readonly ConvId[] = []): Promise<boolean> {
    const conv = this.o.conversations.get(convId);
    if (this.stopped) return false;
    try {
      const sent = await this.o.body.say(text, volume ?? 'normal', conv?.participants.filter((p) => p !== this.o.me) ?? [], stillWanted, urgent);
      if (!sent) return false;
    } catch (err) {
      this.o.logger.info({ module: 'talking', err: String(err) }, 'did not say a line');
      return false;
    }
    this.o.conversations.noteOwnUtterance(convId, text);
    for (const id of also) this.o.conversations.noteOwnUtterance(id, text);
    this.o.bus.emit({ type: 'spoke', convId, text });
    this.enoughTalk();
    return true;
  }

  /**
   * In a group talk, a few lines past our turn cap in two minutes is enough (owner request, 2026-10-24: people stood
   * about talking): our talks end, and small talk waits a while.
   */
  private enoughTalk(): void {
    const t = this.now();
    this.saidAt = [...this.saidAt.filter((x) => t - x < GROUP_WINDOW_MS), t];
    if (this.saidAt.length < maxTurnsFor(this.o.store.state.self.persona) + GROUP_SLACK || !this.groupAround(undefined)) return;
    for (const c of this.o.conversations.active()) this.o.conversations.end(c.convId, 'talked enough');
    this.focusUntil = t + FOCUS_MS;
    this.saidAt = [];
    pushWorkmem(this.o.store, "I've talked long enough for now; time to get on with things", 0.6, 'self_observed', { now: t });
    this.o.bus.emit({ type: 'needsDecision', reason: 'talkedEnough' });
  }

  /**
   * A line without a model. What the CC worded (a promise, a counter-offer, a demand, a call to rise, news) is said
   * as worded, once per conversation (`said` tells what we already said there), and opens with the name of whom it
   * is for (`to`), so that one answers it and not whoever else is around (§6.2); after that the stance's own lines.
   */
  private canned(asked: SpeechIntent, opening = false, said: (line: string) => boolean = () => false, to?: AgentName, theyIntroduced = false): string {
    const persona = this.o.store.state.self.persona;
    const worded = this.worded(asked);
    const line = worded && to && !mentionsName(worded, to) ? `${to}, ${worded}` : worded;
    if (line && !said(line)) return line;
    // A courting or family line said once in this conversation: what follows is small talk, not that stance's stock
    // line (a second "how about it?" after the question, or "let me think" after a yes).
    const intent: SpeechIntent = line && ROMANCE_LINES.has(asked.gist) ? { stance: 'chat', gist: 'friendly and short', mayCommit: false } : asked;
    // §18.2 expression: a strong feeling colors small talk.
    const felt = topEmotion(this.o.store.state.emotions);
    if (intent.stance === 'chat' && felt && felt.intensity > 0.55) {
      const moodLines = FEELING_LINES[felt.name];
      if (moodLines) return moodLines[Math.floor(this.rng() * moodLines.length)] ?? '';
    }
    // §19.1: a first hello to someone says who one is, as people do ("hey! I'm a gal who loves exploring"); and one who
    // has just said who they are is told in turn.
    if ((opening || theyIntroduced) && intent.stance === 'chat' && to && !this.introduced.has(to)) {
      this.introduced.add(to);
      const hello = GREETINGS[Math.floor(this.rng() * GREETINGS.length)] ?? 'hey!';
      // "hi there", and then who one is: a stop between them.
      return `${/[!?.]$/.test(hello) ? hello : `${hello}!`} I'm a ${persona.sex === 'male' ? 'guy' : 'gal'} who loves ${LOVES[persona.values[0] ?? ''] ?? 'mining'}.`;
    }
    const pool =
      opening && intent.stance === 'chat' ? GREETINGS : intent.stance === 'agree' && !intent.mayCommit ? CANNED.ask : CANNED[intent.stance];
    if (intent.stance === 'chat' && persona.speech.catchphrases.length > 0 && this.rng() < 0.3) {
      return persona.speech.catchphrases[Math.floor(this.rng() * persona.speech.catchphrases.length)] ?? '';
    }
    return pool[Math.floor(this.rng() * pool.length)] ?? '';
  }

  /** What the CC worded to be said as it is, if anything. */
  private worded(intent: SpeechIntent): string | null {
    if (ROMANCE_LINES.has(intent.gist)) return intent.gist;
    // A promise the CC allowed is said plainly, so the other side knows what was agreed (§6.4).
    if (intent.stance === 'agree' && intent.mayCommit && /^I('ll|'m) /.test(intent.gist) && intent.gist.length <= 80) return `sure! ${intent.gist}`;
    // A counter-offer is said as it is, so the other side can take it or leave it (§6.6).
    if (intent.stance === 'negotiate' && /^how about /i.test(intent.gist) && intent.gist.length <= 100) return intent.gist;
    // A demand (§17.7), the signal to strike together, a call to rise up, or news about someone (§17.8): said as
    // worded, so it is understood.
    if (intent.stance === 'threaten' && /^(give|bring|hand|now!)/i.test(intent.gist) && intent.gist.length <= 100) return intent.gist;
    if ((intent.stance === 'rally' || intent.stance === 'inform') && intent.gist.length > 0 && intent.gist.length <= 120) return intent.gist;
    // Turning a demand down, and giving in to one: said plainly (§17.7), so it is understood for what it is.
    if (intent.stance === 'hostile' && /^no\b/i.test(intent.gist) && intent.gist.length <= 80) return intent.gist;
    if (intent.stance === 'agree' && intent.mayCommit && /^fine\. I'll /.test(intent.gist) && intent.gist.length <= 80) return intent.gist;
    return null;
  }

  /** The line to say, with the commitment and giveaway guards applied. */
  private async compose(convId: ConvId, incoming: Utterance[], intent: SpeechIntent, to?: AgentName): Promise<string> {
    const s = this.o.store.state;
    const persona = s.self.persona;
    const llm = isOff(s, 'talking.llm') ? null : this.o.llm;
    if (!llm) {
      const transcript = s.conversations[convId]?.transcript ?? [];
      const theyIntroduced = incoming.some((u) => statedSex(u.text) !== null);
      return this.canned(intent, incoming.length === 0 && transcript.length === 0, (line) => transcript.some((u) => u.from === this.o.me && u.text === line), to, theyIntroduced);
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
    // Who else is around (a group talk names whom a line is for), the time of day, and what we're about.
    const around = s.perception.nearbyEntities
      .filter((e) => e.kind === 'player' && !partners.includes(e.name) && e.distance <= 24)
      .slice(0, 4)
      .map((e) => `${e.name} (${Math.round(e.distance)} m)`);
    const goal = s.goals.current?.text;
    const plan = planText(s);
    const user = [
      `Right now you are: ${activity}. It is ${s.self.isDay ? 'day' : 'night'}.`,
      plan ? `Your plan: ${plan}` : goal ? `What you're working toward: ${goal}.` : '',
      s.selfSummary ? `About you: ${s.selfSummary}` : '',
      feeling ? `You feel ${feeling}; let it show in how you talk.` : '',
      ...about,
      around.length > 0 ? `Also nearby: ${around.join(', ')}.` : '',
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
    const max = persona.speech.maxWords;
    try {
      // §19.6: a draft that isn't PG is written again once, told so; then a neutral line.
      let notPg = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages: ChatMessage[] = [
          { role: 'system', content: system(attempt === 0 ? '' : notPg ? PG_RULE : STRICT_NO_PROMISE_RULE) },
          { role: 'user', content: user },
        ];
        // §5: stream, and send the first sentence as soon as it is complete (if it passes the guards). When chiming
        // in, it still yields to anyone who answered first (§6.2 floor control). A model that fails partway is
        // replaced by the next one; what the failed one streamed was only a draft, so it is dropped, unless its
        // first sentence already went out: then that sentence was the line.
        const st: { buf: string; first: string | null; sent: Promise<boolean> | null; broken: boolean } = { buf: '', first: null, sent: null, broken: false };
        const chimingIn = incoming.length > 0 && incoming.every((u) => u.heardAs !== 'me');
        const stillWanted = chimingIn ? () => !incoming.some((u) => this.someoneAnswered(u)) : undefined;
        // A line is written with the speech model (models.yaml `thoughts.speech`): talk drives how the agents deal with
        // each other, so it gets a strong model and a few seconds (owner request, 2026-10-24).
        const r = await llm.call<string>({
          tier: 'L2',
          module: 'talking',
          thought: 'speech',
          agent: this.o.me,
          messages,
          fallback: () => this.canned(intent, false, undefined, to),
          signal: guard.signal,
          isStale: guard.isStale,
          temperature: 0.8,
          onRetry: () => {
            if (st.first) st.broken = true;
            else st.buf = '';
          },
          onText: (d) => {
            if (st.broken) return;
            st.buf += d;
            if (st.first !== null) return;
            const m = /^(.{8,}?[.!?])(\s|$)/s.exec(st.buf.trimStart());
            if (!m?.[1]) return;
            const sentence = cleanReply(m[1], persona.name, max);
            // A first sentence of working-out is not said, nor sent ahead: the whole reply decides the line.
            st.first = this.passes(sentence, intent) ? sentence : '';
            if (st.first) st.sent = this.send(convId, sentence, intent.volume, stillWanted);
          },
        });
        if (!r.ok && (r.reason === 'stale' || r.reason === 'aborted')) return '';
        if (st.sent && st.first) {
          if (!(await st.sent) || st.broken || !r.ok) return '';
          // The rest of the reply, after the sentence already said: whole sentences only.
          const full = cleanReply(r.truncated ? dropUnfinished(r.value) : r.value, persona.name, max);
          const at = full.indexOf(st.first);
          const rest = at < 0 ? '' : full.slice(at + st.first.length).trim();
          return rest && countWords(st.first) + countWords(rest) <= Math.max(8, Math.round(max * 1.5)) && this.passes(rest, intent) && /[a-z]/i.test(rest) ? rest : '';
        }
        const text = r.ok ? cleanReply(r.truncated ? dropUnfinished(r.value) : r.value, persona.name, max) : r.value;
        if (this.passes(text, intent)) return text;
        notPg = NOT_PG_RE.test(text);
        if (notPg) this.o.logger.info({ module: 'talking' }, 'draft was not PG; writing it again');
        if (!intent.mayCommit && looksLikePromise(text)) this.o.logger.info({ module: 'talking', text }, 'draft sounded like a promise without mayCommit');
      }
      return intent.mayCommit ? this.canned(intent, false, undefined, to) : 'let me think about it.';
    } finally {
      guard.dispose();
    }
  }
}
