// The controller (owner request, 2026-10-24: "a secondary master model … would see all the actions of the agents and
// drive changes if it sees something wrong … only odd and irregular activities"). It reads every agent's telemetry
// (what each decided, did and said, and where it stands), and code looks for what has plainly gone wrong: a talk
// going round in circles, talk that never turns into doing anything, the same two starting the same talk over and
// over, someone standing stuck, the same task failing again and again, a mind that keeps changing, someone doing
// nothing at all. Each case goes to the master model, which judges it (most are let be) and words the push that ends
// it. The agent takes the push as its own urge (agent modules/urges.ts) and never learns of the controller: the
// thought is in its own words about what it did itself, with nothing it doesn't perceive. Without a model, or when
// the call fails, code pushes in the clearest cases. Seldom: each person and each kind of trouble at most once in a
// while, and at most `maxPerHour` urges an hour for everyone.

import { z } from 'zod';
import { NOT_PG_RE, type TelemetryKind, type Urge, UrgeActSchema, type UrgeAct, mentionsName, tokenize } from '@agora/shared';
import type { LlmClient } from '@agora/llm';
import type { Logger } from '@agora/shared';
import { OUT_OF_WORLD } from './personaWriter';

export type OddityKind = 'repeating' | 'talk_again' | 'talk_forever' | 'fail_loop' | 'stuck' | 'restless' | 'idle';

/** Something that looks wrong with one person (and whoever else is in it). */
export interface Oddity {
  kind: OddityKind;
  agent: string;
  /** The others in it: the people a talk went round in circles with. */
  others: string[];
  /** What looks wrong, in a line. */
  summary: string;
  /** What fails over and over (fail_loop). */
  task?: { skill: string; item?: string };
}

interface Line {
  text: string;
  at: number;
}
interface SkillRow {
  skill: string;
  item: string | null;
  ok: boolean;
  error: string | null;
  at: number;
}
interface StateRow {
  at: number;
  x: number;
  y: number;
  z: number;
  option: string | null;
  skill: string | null;
  status: string | null;
  startedAt: number | null;
  progress: string | null;
  goal: string | null;
}
interface DecisionRow {
  at: number;
  option: string;
  skill: string | null;
}
interface ConvRow {
  at: number;
  with: string[];
  turns: number;
  reason: string;
}

/** What the controller keeps of one agent: its last lines, deeds, decisions, talks and states. */
export interface Track {
  name: string;
  firstSeen: number;
  lines: Line[];
  skills: SkillRow[];
  states: StateRow[];
  decisions: DecisionRow[];
  convs: ConvRow[];
}

const MIN = 60_000;
const KEEP = { lines: 40, skills: 40, states: 160, decisions: 40, convs: 20 } as const;
/** Skills that do nothing much, or wait by nature: they say nothing about being stuck or busy. */
const TRIVIAL = new Set(['wait', 'look', 'lookAround', 'say', 'wander']);
/** Skills one stands still for: smelting a stack, sleeping, fishing, hiding for the night. */
const STILL = new Set(['smelt', 'sleep', 'wait', 'fish', 'shelter', 'hide', 'rest']);
/** Failures that are no failures: stopped, or out of time. */
const NOT_FAILED = /^(aborted|stopped|time is up|interrupted)/;

const r1 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strOr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function push<T>(list: T[], row: T, keep: number): void {
  list.push(row);
  if (list.length > keep) list.splice(0, list.length - keep);
}

/** Word and word-pair overlap in 0..1 (as the agents' own repetition check): 1 is the same line. */
export function similarity(a: string, b: string): number {
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

/** How many of the lines say again what an earlier one did. */
function repeats(lines: readonly Line[]): number {
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i];
    if (a && lines.slice(0, i).some((b) => similarity(a.text, b.text) >= 0.6)) n++;
  }
  return n;
}

function spread(states: readonly StateRow[]): number {
  if (states.length === 0) return 0;
  const xs = states.map((s) => s.x);
  const ys = states.map((s) => s.y);
  const zs = states.map((s) => s.z);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs));
}

const did = (t: Track, since: number) => t.skills.filter((s) => s.at >= since && s.ok && !TRIVIAL.has(s.skill)).length;

/** The people near `t` who spoke lately: those a talk is with. */
function companions(t: Track, all: ReadonlyMap<string, Track>, now: number): string[] {
  const me = t.states.at(-1);
  if (!me) return [];
  const out: string[] = [];
  for (const o of all.values()) {
    if (o.name === t.name) continue;
    const at = o.states.at(-1);
    if (!at || Math.hypot(at.x - me.x, at.z - me.z) > 12) continue;
    if (o.lines.some((l) => now - l.at < 2 * MIN)) out.push(o.name);
  }
  return out.slice(0, 4);
}

/**
 * What looks wrong with this one person now, the worst first (at most one); null when all is well. Thresholds are
 * well past the ordinary: two people chatting for a few minutes, a long smelt or a night spent hiding are not odd.
 */
export function oddityOf(t: Track, all: ReadonlyMap<string, Track>, now: number): Oddity | null {
  const name = t.name;
  // A talk going round in circles: many of the last lines say again what was said already.
  const recent = t.lines.filter((l) => now - l.at < 5 * MIN);
  if (recent.length >= 5 && repeats(recent) >= 3) {
    const others = companions(t, all, now);
    return { kind: 'repeating', agent: name, others, summary: `${name} keeps saying the same things${others.length > 0 ? ` to ${others.join(' and ')}` : ''}: ${repeats(recent)} of their last ${recent.length} lines say again what they said already` };
  }
  // The same talk started over and over with the same person.
  const counts = new Map<string, number>();
  for (const c of t.convs.filter((c) => now - c.at < 12 * MIN)) for (const w of c.with) counts.set(w, (counts.get(w) ?? 0) + 1);
  const again = [...counts.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])[0];
  if (again) return { kind: 'talk_again', agent: name, others: [again[0]], summary: `${name} and ${again[0]} have started and ended ${again[1]} talks in twelve minutes` };
  // Talk that never turns into doing anything: lines and lines, nothing done, standing about.
  const talk8 = t.lines.filter((l) => now - l.at < 8 * MIN);
  const states8 = t.states.filter((s) => now - s.at < 8 * MIN);
  if (talk8.length >= 16 && did(t, now - 8 * MIN) === 0 && states8.length >= 30 && spread(states8) < 6) {
    const others = companions(t, all, now);
    return { kind: 'talk_forever', agent: name, others, summary: `${name} has said ${talk8.length} lines in eight minutes${others.length > 0 ? ` with ${others.join(' and ')}` : ''} and done nothing else, standing in one place` };
  }
  // The same task failing again and again (in one way after another: the agent's own stuck mark is for one way).
  const fails = new Map<string, SkillRow[]>();
  for (const s of t.skills.filter((s) => now - s.at < 10 * MIN)) {
    const k = `${s.skill}:${s.item ?? ''}`;
    if (s.ok) fails.delete(k);
    else if (!NOT_FAILED.test(s.error ?? '')) fails.set(k, [...(fails.get(k) ?? []), s]);
  }
  const loop = [...fails.values()].filter((xs) => xs.length >= 4).sort((a, b) => b.length - a.length)[0];
  const first = loop?.[0];
  if (loop && first) {
    const errs = [...new Set(loop.map((x) => x.error ?? 'failed'))].slice(-2).join('; ');
    return {
      kind: 'fail_loop',
      agent: name,
      others: [],
      summary: `${name} has tried ${first.skill}${first.item ? ` ${first.item}` : ''} ${loop.length} times in ten minutes and it failed every time (${errs})`,
      task: { skill: first.skill, ...(first.item ? { item: first.item } : {}) },
    };
  }
  const last = t.states.at(-1);
  const talking = t.lines.some((l) => now - l.at < 2 * MIN);
  // Standing stuck: six minutes in one spot, nothing done, no progress, not talking, not resting or waiting by nature.
  const states6 = t.states.filter((s) => now - s.at < 6 * MIN);
  if (last && now - t.firstSeen >= 6 * MIN && states6.length >= 40 && spread(states6) < 2.5 && !talking && did(t, now - 6 * MIN) === 0) {
    const still = last.option === 'rest' || STILL.has(last.skill ?? '') || last.option === null;
    const progressed = new Set(states6.map((s) => s.progress ?? '')).size > 1;
    if (!still && !progressed) return { kind: 'stuck', agent: name, others: [], summary: `${name} has stood in one spot for six minutes trying to ${last.skill ?? last.option ?? 'do something'}, getting nowhere` };
  }
  // A mind that keeps changing: decision after decision, nothing done.
  const decided = t.decisions.filter((d) => now - d.at < 3 * MIN);
  const kinds = new Set(decided.map((d) => `${d.option}:${d.skill ?? ''}`));
  if (decided.length >= 12 && kinds.size >= 3 && did(t, now - 3 * MIN) <= 1) return { kind: 'restless', agent: name, others: [], summary: `${name} has changed their mind ${decided.length} times in three minutes and done next to nothing` };
  // Doing nothing at all: no decision, no deed, no word for six minutes while here, and nothing under way (a long
  // task under way is busy, or else stuck, above).
  const quiet = (xs: readonly { at: number }[]) => !xs.some((x) => now - x.at < 6 * MIN);
  if (last && now - t.firstSeen >= 6 * MIN && now - last.at < MIN && quiet(t.decisions) && quiet(t.skills) && quiet(t.lines)) {
    const underWay = last.option !== null && last.status === 'running';
    if (!underWay) return { kind: 'idle', agent: name, others: [], summary: `${name} has done and said nothing for six minutes` };
  }
  return null;
}

/** How each kind of trouble is ended when code does it: the push, and the thought that comes with it. */
const CODE_PUSH: Readonly<Record<OddityKind, { act: UrgeAct; thought: (o: Oddity) => string; say?: string }>> = {
  repeating: { act: 'move_on', thought: () => "We keep going over the same things; I've said my piece, time to get on with something", say: 'aight im gonna go get stuff done, cya' },
  talk_again: { act: 'move_on', thought: (o) => `${o.others[0] ?? 'They'} and I keep starting the same talk; I'll leave it for now and get on with things`, say: 'ok gtg, talk later' },
  talk_forever: { act: 'move_on', thought: () => "I've stood here talking long enough; time to actually do something", say: 'ok enough talk, lets get to it' },
  fail_loop: { act: 'drop_task', thought: (o) => `Trying to ${o.task?.skill ?? 'do that'}${o.task?.item ? ` ${o.task.item.replace(/_/g, ' ')}` : ''} again and again isn't working; I'll do something else for now` },
  stuck: { act: 'wander', thought: () => "I've been stuck in this spot too long; I should move" },
  restless: { act: 'rethink', thought: () => 'I keep changing my mind; I should pick one thing and stick with it' },
  idle: { act: 'rethink', thought: () => "I've been standing around doing nothing; what should I do next?" },
};

/** Words that would give the controller away, or make a thought into something told rather than thought. */
const GIVES_AWAY = /\b(controllers?|overseers?|nudged?|pushed|forced|told (me )?to|being watched|watching over|someone wants|instructed|ordered to)\b/i;

/** A thought (or a goodbye) fit to be the agent's own: plain words, nothing out of the world, no numbers or strangers. */
export function fitWords(text: string, people: readonly string[], everyone: readonly string[]): boolean {
  // Words, not a placeholder ("...").
  if ((text.match(/[a-z]/gi)?.length ?? 0) < 6 || /\d/.test(text) || NOT_PG_RE.test(text) || OUT_OF_WORLD.test(text) || GIVES_AWAY.test(text)) return false;
  // Names of anyone but the people in it would be news from elsewhere.
  return everyone.every((n) => people.includes(n) || !mentionsName(text, n));
}

const ReplySchema = z.object({
  wrong: z.boolean(),
  why: z.string().max(400).default(''),
  urges: z
    .array(
      z.object({
        who: z.string().min(1),
        act: UrgeActSchema,
        thought: z.string().min(3).max(240),
        say: z.string().max(140).optional(),
      }),
    )
    .max(4)
    .default([]),
});
type Reply = z.infer<typeof ReplySchema>;

const RULES = `You look after a village of people living in a world of blocks: they build, farm, mine, explore and talk things over with each other. You see what each one does and says. Almost all of it is theirs to choose and you leave it be: never step in on what they decide, how they feel, whom they like or how they get on, and putting off their own goals to talk, rest or play is theirs to decide too. A long talk that keeps moving on to new things (getting to know each other, telling stories, making plans, settling a quarrel) is theirs however long it runs; it is not going round in circles. You step in only when something has plainly gone wrong: a talk going round in circles (the same things said again and again, or agreed and never acted on), someone standing stuck in one spot, the same task failing again and again, a mind that keeps changing and never does anything, someone doing nothing at all. Code has found something that may be such a case; often it isn't, and then you leave it be.
When something has gone wrong, choose the smallest push that ends it, for each person who needs one (in a talk going round in circles, one walking off is often enough). Each takes it as their own idea.
Pushes:
- move_on: end the talk and walk off (a talk going round in circles)
- wander: walk a little way off (standing stuck)
- drop_task: give up what keeps failing and do something else
- rethink: think again about what to do (a mind that won't settle, doing nothing)
For each push write "thought": what they think to themselves, in the first person, one short plain sentence about what they did and what they'll do instead, like "I've said all I had to; time to get on with the wall". Only what they know: what they did and said themselves, and the people they were with. No numbers, no places, nothing new about the world, nothing about anyone watching or pushing them.
For move_on, "say" may be a short goodbye as people type in the chat here: lowercase, a few words, casual, like "aight gtg, gonna go finish the wall".
JSON: {"wrong": true|false, "why": "a few words", "urges": [{"who": "a name", "act": "move_on|wander|drop_task|rethink", "thought": "...", "say": "..."}]}. When nothing is wrong: {"wrong": false, "why": "...", "urges": []}.`;

const ago = (now: number, at: number) => {
  const m = Math.round((now - at) / MIN);
  return m <= 0 ? 'just now' : `${m} min ago`;
};

/** The case for the model: what looks wrong, and the last of what each one in it said and did. */
export function describeOddity(o: Oddity, all: ReadonlyMap<string, Track>, now: number): string {
  const out = [`What looks wrong: ${o.summary}.`];
  for (const who of [o.agent, ...o.others]) {
    const t = all.get(who);
    if (!t) continue;
    const st = t.states.at(-1);
    const doing = st ? `${st.option ?? 'nothing'}${st.skill ? ` (${st.skill})` : ''}${st.progress ? `: ${st.progress}` : ''}` : 'unknown';
    out.push(`\n${who} now: ${doing}${st?.goal ? `; goal: ${st.goal}` : ''}.`);
    const lines = t.lines.slice(o.others.length > 0 ? -10 : -6);
    if (lines.length > 0) out.push(`${who}'s last lines (oldest first):\n${lines.map((l) => `- (${ago(now, l.at)}) ${l.text}`).join('\n')}`);
    const deeds = t.skills.slice(-6);
    if (deeds.length > 0) out.push(`${who}'s last tasks:\n${deeds.map((s) => `- (${ago(now, s.at)}) ${s.skill}${s.item ? ` ${s.item}` : ''}: ${s.ok ? 'done' : `failed${s.error ? ` (${s.error.slice(0, 100)})` : ''}`}`).join('\n')}`);
  }
  return out.join('\n');
}

export interface ControllerConfig {
  enabled: boolean;
  models: readonly string[];
  timeoutMs: number;
  everySec: number;
  maxPerHour: number;
}

/** One time the controller looked at something: what, what it judged, and the urges sent (the dashboard, the log). */
export interface ControllerStep {
  kind: OddityKind;
  agents: string[];
  summary: string;
  wrong: boolean;
  why: string;
  by: 'model' | 'code';
  urges: { who: string; urge: Urge }[];
}

export interface ControllerOptions {
  llm: LlmClient | null;
  logger: Logger;
  config: ControllerConfig;
  /** Sends an urge to a connected agent; false if it isn't here. */
  send: (name: string, urge: Urge) => boolean;
  /** Agents left be: the controller switched off for them by the operator, or paused. */
  leaveBe?: (name: string) => boolean;
  /** Each time it looked at something (the dashboard). */
  onStep?: (step: ControllerStep) => void;
  now?: () => number;
}

/** How long one person is let be after a push, and the same trouble with them after it was looked at. */
const QUIET_MS = 3 * MIN;
const AGAIN_MS = 10 * MIN;

export class Controller {
  private readonly tracks = new Map<string, Track>();
  /** `${agent}:${kind}` → when it was last looked at; agent → until when it is let be. */
  private readonly lookedAt = new Map<string, number>();
  private readonly quietUntil = new Map<string, number>();
  private readonly sent: number[] = [];
  private readonly halt = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private readonly now: () => number;

  constructor(private readonly o: ControllerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (!this.o.config.enabled || this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.o.config.everySec * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.halt.abort();
  }

  /** An agent's telemetry (the Hub's `telemetry` event). */
  observe(name: string, kind: TelemetryKind, data: Record<string, unknown>): void {
    const t = this.now();
    let tr = this.tracks.get(name);
    if (!tr) {
      tr = { name, firstSeen: t, lines: [], skills: [], states: [], decisions: [], convs: [] };
      this.tracks.set(name, tr);
    }
    switch (kind) {
      case 'utterance':
        if (typeof data.text === 'string') push(tr.lines, { text: data.text, at: t }, KEEP.lines);
        return;
      case 'skill': {
        const args = (data.args ?? {}) as Record<string, unknown>;
        const item = strOr(args.item) ?? strOr(args.design) ?? strOr(args.structure) ?? strOr(args.target) ?? strOr(args.to);
        push(tr.skills, { skill: strOr(data.skill) ?? '?', item, ok: data.ok === true, error: strOr(data.error), at: t }, KEEP.skills);
        return;
      }
      case 'state': {
        const pos = (data.pos ?? {}) as Record<string, unknown>;
        const opt = (data.option ?? null) as Record<string, unknown> | null;
        push(
          tr.states,
          {
            at: t,
            x: r1(pos.x),
            y: r1(pos.y),
            z: r1(pos.z),
            option: opt ? strOr(opt.option) : null,
            skill: opt ? strOr(opt.skill) : null,
            status: opt ? strOr(opt.status) : null,
            startedAt: opt && typeof opt.startedAt === 'number' ? opt.startedAt : null,
            progress: opt ? strOr(opt.progress) : null,
            goal: strOr(data.goal),
          },
          KEEP.states,
        );
        return;
      }
      case 'decision': {
        const task = (data.task ?? null) as Record<string, unknown> | null;
        push(tr.decisions, { at: t, option: strOr(data.option) ?? '?', skill: task ? strOr(task.skill) : null }, KEEP.decisions);
        return;
      }
      case 'conversation':
        push(tr.convs, { at: t, with: Array.isArray(data.with) ? data.with.filter((x): x is string => typeof x === 'string') : [], turns: r1(data.turns), reason: strOr(data.reason) ?? '' }, KEEP.convs);
        return;
      // The rest (feelings, people, fights, goals, …) says nothing about anything going wrong.
      case 'option':
      case 'social':
      case 'emotion':
      case 'commitment':
      case 'fight':
      case 'impulse':
      case 'override':
      case 'goal':
      case 'role':
      case 'memory':
      case 'modelSwap':
      case 'guard':
      case 'romance':
      case 'knowledge':
        return;
    }
  }

  /** An agent has left (gone offline, died): nothing more to watch. */
  gone(name: string): void {
    this.tracks.delete(name);
  }

  /** What looks wrong now, one case per person at most (tests, the sweep). */
  oddities(): Oddity[] {
    const t = this.now();
    const out: Oddity[] = [];
    for (const tr of this.tracks.values()) {
      if ((this.quietUntil.get(tr.name) ?? 0) > t || this.o.leaveBe?.(tr.name)) continue;
      const o = oddityOf(tr, this.tracks, t);
      if (!o || t - (this.lookedAt.get(`${o.agent}:${o.kind}`) ?? -Infinity) < AGAIN_MS) continue;
      // The others in it are those not let be just now either.
      out.push({ ...o, others: o.others.filter((n) => !this.o.leaveBe?.(n)) });
    }
    return out;
  }

  /** Looks everyone over and deals with what has gone wrong, one case at a time. */
  async sweep(): Promise<ControllerStep[]> {
    if (this.sweeping || !this.o.config.enabled) return [];
    this.sweeping = true;
    const steps: ControllerStep[] = [];
    try {
      // A cap on every loop (§13 rule 6): a handful of cases a sweep.
      for (const o of this.oddities().slice(0, 4)) {
        if (this.halt.signal.aborted) break;
        const t = this.now();
        // Pushed along with someone else's case just now (both of a talk going round in circles).
        if ((this.quietUntil.get(o.agent) ?? 0) > t) continue;
        while (this.sent.length > 0 && t - (this.sent[0] ?? 0) > 60 * MIN) this.sent.shift();
        if (this.sent.length >= this.o.config.maxPerHour) break;
        this.lookedAt.set(`${o.agent}:${o.kind}`, t);
        const step = await this.consider(o);
        if (step) steps.push(step);
      }
    } finally {
      this.sweeping = false;
    }
    return steps;
  }

  /** Whether the case still holds (a stale verdict is thrown away). */
  private stillOdd(o: Oddity): boolean {
    const tr = this.tracks.get(o.agent);
    return Boolean(tr && oddityOf(tr, this.tracks, this.now())?.kind === o.kind);
  }

  private codeReply(o: Oddity): Reply {
    const p = CODE_PUSH[o.kind];
    return { wrong: true, why: 'code', urges: [{ who: o.agent, act: p.act, thought: p.thought(o), ...(p.say ? { say: p.say } : {}) }] };
  }

  private async consider(o: Oddity): Promise<ControllerStep | null> {
    const cfg = this.o.config;
    let reply: Reply;
    let by: ControllerStep['by'] = 'code';
    if (this.o.llm) {
      const r = await this.o.llm.call<Reply>({
        tier: 'L3',
        module: 'controller',
        agent: 'hub',
        schema: ReplySchema,
        schemaName: 'controller',
        prefer: cfg.models,
        timeoutMs: cfg.timeoutMs,
        fallback: () => this.codeReply(o),
        signal: AbortSignal.any([this.halt.signal, AbortSignal.timeout(cfg.timeoutMs * 3)]),
        isStale: () => !this.stillOdd(o),
        messages: [
          { role: 'system', content: RULES },
          { role: 'user', content: describeOddity(o, this.tracks, this.now()) },
        ],
      });
      if (!r.ok && (r.reason === 'stale' || r.reason === 'aborted')) {
        this.o.logger.info({ module: 'controller', kind: o.kind, agent: o.agent, reason: r.reason }, 'case dropped');
        return null;
      }
      reply = r.value;
      if (r.ok) by = 'model';
    } else reply = this.codeReply(o);
    // The case may have ended while the model thought.
    if (!this.stillOdd(o)) return null;
    const people = [o.agent, ...o.others];
    const everyone = [...this.tracks.keys()];
    const urges: { who: string; urge: Urge }[] = [];
    if (reply.wrong) {
      for (const u of reply.urges) {
        const who = people.find((p) => p.toLowerCase() === u.who.trim().toLowerCase());
        // One push each, and none for someone pushed just now (in another case of the same sweep).
        if (!who || urges.some((x) => x.who === who) || (this.quietUntil.get(who) ?? 0) > this.now()) continue;
        // The model's words, if they will do as the person's own; else code's for this kind of trouble.
        const own = fitWords(u.thought, people, everyone) ? u.thought.trim() : CODE_PUSH[o.kind].thought(o);
        const say = u.act === 'move_on' && u.say && fitWords(u.say, people, everyone) && u.say.length <= 80 ? u.say.trim().toLowerCase() : undefined;
        const urge: Urge = {
          act: u.act,
          thought: own.slice(0, 200),
          ...(say ? { say } : {}),
          avoid: u.act === 'move_on' ? people.filter((p) => p !== who) : [],
          ...(u.act === 'drop_task' && o.task && who === o.agent ? { task: o.task } : {}),
        };
        urges.push({ who, urge });
      }
    }
    for (const { who, urge } of urges) {
      if (!this.o.send(who, urge)) continue;
      this.sent.push(this.now());
      this.quietUntil.set(who, this.now() + QUIET_MS);
    }
    const step: ControllerStep = { kind: o.kind, agents: people, summary: o.summary, wrong: reply.wrong, why: reply.why, by, urges };
    this.o.logger.info({ module: 'controller', kind: o.kind, agents: people, wrong: reply.wrong, why: reply.why, by, urges: urges.map((u) => ({ who: u.who, act: u.urge.act, thought: u.urge.thought })) }, urges.length > 0 ? 'stepped in' : 'let it be');
    this.o.onStep?.(step);
    return step;
  }
}
