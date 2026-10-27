// When a talk has settled something (owner request, 2026-10-24): people stood about talking long after they had
// agreed what to do, and a stroll stays put while a talk is live. With a model, a line that sounds like a yes (or
// every few lines of a group talk) is followed, after a pause in which anyone may push back, by a short L1 question
// about what was said: did the talk settle on something to do now, what, and what is our part in it? Players type
// loosely ("sounds good but lemme finish these logs", questions without a question mark), so the model judges, not
// the words alone; at most once every MIN_CHECK_MS. Without a model, a yes to something someone else put forward is
// taken at its word. Settled: our talks with those in it end ('agreed'), what was agreed goes on our mind, and the
// mind decides at once with it (cc.ts).

import type { AgentName, ConvId, Logger, Utterance } from '@agora/shared';
import type { ChatMessage, LlmClient } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { isOff } from '../state/switches';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import type { Conversations } from './conversations';

/** A line that puts something forward to do, or asks who does what. */
export const PROPOSAL_RE =
  /\b(let'?s|lets|we (should|could|gotta|need to|need|can)|how about|wanna|want to|shall we|why don'?t we|can (we|you|u|someone)|should we|could (you|u)|will (you|u)|you in|u in|i'?ll (take|get|grab|do|bring)|i can (get|take|do|grab|bring)|who'?s (on|getting|taking)|who (gets|takes|wants|is on)|you (take|get|grab)|meet (at|by|back))\b|\?\s*$/i;
/** A line that says yes to it. */
export const AGREE_RE =
  /^\W*(ok(ay)?|k+|sure|yes+|yeah|yea|yep|yup|ya|deal|bet|alright|aight|sounds good|fine|cool|perfect|great|on it|got it|i'?m in|count me in|works for me|agreed|omw|on my way)\b|\b(let'?s (do it|do this|go)|lets (do it|do this|go)|i'?m in|count me in|sounds good|works for me|omw|on my way)\b/i;
/** A line that pushes back. */
export const OBJECT_RE = /^\W*(no+|nah|nope|not (now|yet|me|really)|can'?t|cant|won'?t|wont|wait|hold on|but|idk|i don'?t think|i'?d rather)\b/i;

/** How long after a yes anyone may still push back before it counts. */
const SETTLE_MS = 3000;
/** With a model: at most one check this often, and one every CHECK_EVERY lines of a group talk. */
const MIN_CHECK_MS = 10_000;
const CHECK_EVERY = 6;
/** The lines read: the last minute of talk around us. */
const WINDOW_MS = 60_000;
const MAX_LINES = 10;
/** An agreement seen to is not seen to again (the next lines about it are its tail). */
const AGAIN_MS = 30_000;

export const SettledSchema = z.object({
  settled: z.boolean(),
  what: z.string().max(200).default(''),
  mine: z.string().max(160).default(''),
});

/** The quick check on a talk (and the thought benchmark's): have they agreed on something to do now? `who` is "You"
 *  for one's own lines. */
export function settledMessages(me: string, lines: readonly { who: string; text: string }[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are ${me}. Read what was just said around you and decide whether the people talking have agreed on something to do now, with nobody still against it. Greetings, small talk and a question still open are not agreement. JSON: {"settled": true|false, "what": "what was agreed, in a few plain words", "mine": "your own part in it, if any"}`,
    },
    { role: 'user', content: lines.map((l) => `${l.who}: ${l.text}`).join('\n') },
  ];
}

interface Line {
  from: AgentName;
  text: string;
  ts: number;
}

/**
 * A yes to something someone else put forward in the last few lines, with nobody pushing back in between or since:
 * what was put forward and by whom; null when the lines don't read as settled.
 */
export function readsSettled(lines: readonly Line[]): { proposal: string; by: AgentName } | null {
  const last = lines.at(-1);
  if (!last || OBJECT_RE.test(last.text) || !AGREE_RE.test(last.text)) return null;
  for (let i = lines.length - 2; i >= Math.max(0, lines.length - 6); i--) {
    const l = lines[i];
    if (!l) continue;
    if (OBJECT_RE.test(l.text)) return null;
    if (l.from !== last.from && PROPOSAL_RE.test(l.text)) return { proposal: l.text, by: l.from };
  }
  return null;
}

export interface ConsensusOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  conversations: Conversations;
  me: AgentName;
  settleMs?: number;
  now?: () => number;
}

export class Consensus {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastSettledAt = -Infinity;
  private lastCheckAt = -Infinity;
  private linesSinceCheck = 0;
  private checking = false;
  private stopped = false;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly o: ConsensusOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.offs.push(this.o.bus.on('heard', () => this.onLine()));
    this.offs.push(this.o.bus.on('spoke', () => this.onLine()));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** The talk around us in the last minute, oldest first: what we heard and what we said. */
  lines(): Line[] {
    const s = this.o.store.state;
    const t = this.now();
    const heard = s.perception.heardSpeech.filter((u) => u.from !== this.o.me && t - u.ts < WINDOW_MS);
    const said = Object.values(s.conversations).flatMap((c) => c.transcript.filter((u: Utterance) => u.from === this.o.me && t - u.ts < WINDOW_MS));
    const seen = new Set<string>();
    return [...heard, ...said]
      .filter((u) => {
        const k = `${u.from}|${u.ts}|${u.text}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.ts - b.ts)
      .slice(-MAX_LINES)
      .map((u) => ({ from: u.from, text: u.text, ts: u.ts }));
  }

  /** The model to ask, if there is one and talk with a model isn't switched off. */
  private llm(): LlmClient | null {
    const s = this.o.store.state;
    return isOff(s, 'talking.llm') ? null : this.o.llm;
  }

  /**
   * Each new line: one that may settle it is given a moment for anyone to push back, then checked. With a model, any
   * line that sounds like a yes, or every CHECK_EVERY lines of a group talk; without one, a yes to something put
   * forward.
   */
  private onLine(): void {
    if (this.stopped) return;
    this.linesSinceCheck++;
    const llm = this.llm();
    // With a model, a check already coming reads these lines too (a busy group never pauses for 3 s); without one, a
    // new line is read afresh.
    if (llm && this.timer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const lines = this.lines();
    const last = lines.at(-1);
    if (!last || last.ts <= this.lastSettledAt + AGAIN_MS || OBJECT_RE.test(last.text)) return;
    const group = new Set(lines.map((l) => l.from).filter((n) => n !== this.o.me)).size >= 2;
    const cue = llm ? (AGREE_RE.test(last.text) || (group && this.linesSinceCheck >= CHECK_EVERY)) && this.now() - this.lastCheckAt >= MIN_CHECK_MS : readsSettled(lines) !== null;
    if (!cue) return;
    this.timer = setTimeout(() => void this.check().catch((err: unknown) => this.o.logger.info({ module: 'consensus', err: String(err) }, 'agreement check failed')), this.o.settleMs ?? SETTLE_MS);
    this.timer.unref?.();
  }

  private async check(): Promise<void> {
    this.timer = null;
    if (this.checking || this.stopped) return;
    const lines = this.lines();
    const llm = this.llm();
    const read = readsSettled(lines);
    const last = lines.at(-1);
    // Pushed back on in the pause: not settled.
    if (!last || OBJECT_RE.test(last.text) || (!llm && !read)) return;
    this.checking = true;
    this.lastCheckAt = this.now();
    this.linesSinceCheck = 0;
    try {
      const s = this.o.store.state;
      const people = [...new Set(lines.map((l) => l.from).filter((n) => n !== this.o.me))];
      let what = read?.proposal ?? '';
      let mine = '';
      if (llm) {
        const r = await llm.call<z.infer<typeof SettledSchema>>({
          tier: 'L1',
          module: 'talking',
          thought: 'check',
          agent: this.o.me,
          schema: SettledSchema,
          schemaName: 'settled',
          fallback: () => ({ settled: read !== null, what: read?.proposal ?? '', mine: '' }),
          messages: settledMessages(s.self.persona.name, lines.map((l) => ({ who: l.from === this.o.me ? 'You' : l.from, text: l.text }))),
        });
        if (!r.value.settled) return;
        what = r.value.what.trim() || read?.proposal || '';
        mine = r.value.mine.trim();
      }
      // Pushed back on while we checked, or a stop came: not settled after all.
      const now = this.lines().at(-1);
      if (this.stopped || !what || (now && OBJECT_RE.test(now.text))) return;
      this.lastSettledAt = lines.at(-1)?.ts ?? this.now();
      const ended: ConvId[] = [];
      for (const c of this.o.conversations.active()) {
        if (c.participants.some((p) => p !== this.o.me && people.includes(p))) {
          this.o.conversations.end(c.convId, 'agreed');
          ended.push(c.convId);
        }
      }
      pushWorkmem(this.o.store, `we agreed${people.length > 0 ? ` with ${people.join(', ')}` : ''}: ${what}${mine ? `; my part: ${mine}` : ''}`, 0.75, 'self_observed', { now: this.now() });
      this.o.logger.info({ module: 'consensus', with: people, what, mine, ended: ended.length }, 'talk settled: on to it');
      this.o.bus.emit({ type: 'agreed', with: people, what, ...(mine ? { mine } : {}) });
    } finally {
      this.checking = false;
    }
  }
}
