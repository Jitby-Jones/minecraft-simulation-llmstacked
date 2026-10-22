// The dashboard's model (M7, §22.4, §18.8): what the operator sees, built from the bots' telemetry, their LLM cost
// reports and the Hub's own lifecycle events. Per agent: its latest state, recent decisions with their rationale,
// what it did and said, its view of each person it knows, and its fear over time. Overall: the chat, notable
// events, tokens per hour by module, tier and agent, and the projected exhaustion of the weekly quota. Read-only
// infrastructure (§8): nothing here ever reaches a bot.

import type { QuotaStatus } from '@agora/llm';
import { type BotToHub, type TelemetryKind, shannonEntropy } from '@agora/shared';

export type Row = { ts: number } & Record<string, unknown>;

class Ring<T> {
  private readonly xs: T[] = [];
  constructor(private readonly cap: number) {}
  push(x: T): void {
    this.xs.push(x);
    if (this.xs.length > this.cap) this.xs.splice(0, this.xs.length - this.cap);
  }
  items(): T[] {
    return [...this.xs];
  }
  last(n: number): T[] {
    return this.xs.slice(-n);
  }
  get size(): number {
    return this.xs.length;
  }
}

export interface PersonRow {
  name: string;
  sentiment: number;
  evidence: number;
  trust: number;
  admiration: number;
  fear: number;
  friction: number;
  resentment: number;
  rung: number;
  lastSeen?: number;
  lastFight?: string;
  grievances?: number;
}

interface AgentView {
  name: string;
  slot: string | null;
  online: boolean;
  firstSeen: number;
  lastSeen: number;
  state: Row | null;
  people: PersonRow[];
  decisions: Ring<Row>;
  actions: Ring<Row>;
  events: Ring<Row>;
  said: Ring<Row>;
  fear: Ring<{ ts: number; v: number }>;
  /** Decisions by where they came from: the model, the code default, an impulse, a reflex (§18.8 overrides vs. impulses). */
  sources: Record<string, number>;
  died?: { ts: number; cause: string };
}

type Cost = Extract<BotToHub, { t: 'cost' }>;
interface CostBucket {
  minute: number;
  agent: string;
  module: string;
  tier: string;
  input: number;
  output: number;
  calls: number;
  errors: number;
}

export interface DashboardModelOptions {
  /** World mode, for the header. */
  mode: () => string;
  quota?: () => QuotaStatus | null;
  /** Persona facts for the agents the supervisor knows (traits, sex, abilities). */
  personas?: () => readonly { username: string; traits: string[]; sex: string; status: string }[];
  now?: () => number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Words too common to say anything about what people talk about. */
const STOPWORDS = new Set(
  'that this with have what your just like from they will there then them been were would could should about some into here okay yeah sure know think want need well good right really going doing maybe thing things still also only very much more than when where which while because does done didn sorry thanks hello there their over again back come came gonna gotta mean said says tell told look looks make made take took give gave something anything nothing everyone someone anyone hmm hmmm'.split(' '),
);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class DashboardModel {
  private readonly agents = new Map<string, AgentView>();
  private readonly chat = new Ring<Row>(400);
  private readonly events = new Ring<Row>(300);
  private readonly problems = new Ring<Row>(100);
  private readonly costs: CostBucket[] = [];
  private readonly totals = { input: 0, output: 0, calls: 0, errors: 0 };
  private readonly now: () => number;
  readonly startedAt: number;

  constructor(private readonly o: DashboardModelOptions) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
  }

  private view(name: string): AgentView {
    let v = this.agents.get(name);
    if (!v) {
      const t = this.now();
      v = {
        name,
        slot: null,
        online: false,
        firstSeen: t,
        lastSeen: t,
        state: null,
        people: [],
        decisions: new Ring(80),
        actions: new Ring(80),
        events: new Ring(80),
        said: new Ring(80),
        fear: new Ring(360),
        sources: {},
      };
      this.agents.set(name, v);
    }
    return v;
  }

  private event(name: string | null, what: string, extra: Record<string, unknown> = {}): void {
    const row: Row = { ...extra, ts: this.now(), ...(name ? { agent: name } : {}), what };
    this.events.push(row);
    if (name) this.view(name).events.push(row);
  }

  online(name: string, slot: string | null): void {
    const v = this.view(name);
    v.online = true;
    v.slot = slot;
    v.lastSeen = this.now();
    this.event(name, 'joined');
  }

  offline(name: string, reason: string): void {
    const v = this.agents.get(name);
    if (!v || !v.online) return;
    v.online = false;
    this.event(name, 'left', { reason });
  }

  died(name: string, cause: string): void {
    const v = this.view(name);
    v.online = false;
    v.died = { ts: this.now(), cause };
    this.event(name, 'died', { cause });
  }

  /** A bot's `log` line at warn or worse (shown as a problem). */
  log(name: string, m: Extract<BotToHub, { t: 'log' }>): void {
    if (m.level === 'warn' || m.level === 'error' || m.level === 'fatal') this.problems.push({ ts: this.now(), agent: name, level: m.level, module: m.module, msg: m.msg });
  }

  telemetry(name: string, kind: TelemetryKind, ts: number, data: Record<string, unknown>): void {
    const v = this.view(name);
    v.lastSeen = this.now();
    const row: Row = { ...data, ts };
    switch (kind) {
      case 'state': {
        v.state = row;
        const e = data.emotions as Record<string, unknown> | undefined;
        v.fear.push({ ts, v: num(e?.fear) });
        return;
      }
      case 'social':
        v.people = Array.isArray(data.people) ? (data.people as PersonRow[]) : [];
        return;
      case 'decision': {
        v.decisions.push(row);
        const src = typeof data.source === 'string' ? data.source : 'unknown';
        v.sources[src] = (v.sources[src] ?? 0) + 1;
        if (src === 'impulse') this.event(name, 'impulse', { option: data.option, rationale: data.rationale });
        return;
      }
      case 'skill':
      case 'option':
        v.actions.push({ ...row, kind });
        return;
      case 'utterance': {
        const line: Row = { ...row, agent: name };
        v.said.push(line);
        this.chat.push(line);
        return;
      }
      case 'fight':
        // A rung climbing toward a fight, or a fight itself, is worth the event feed; small moves stay per agent.
        if (data.kind === 'duel' || num(data.to) >= 2) this.event(name, data.kind === 'duel' ? 'fight' : 'escalation', data);
        else v.events.push({ ...row, what: 'rung' });
        return;
      case 'conversation':
      case 'goal':
      case 'commitment':
      case 'modelSwap':
      case 'guard':
        this.event(name, kind, data);
        return;
      case 'emotion':
      case 'impulse':
      case 'override':
      case 'role':
      case 'memory':
      case 'romance':
      case 'knowledge':
        v.events.push({ ...row, what: kind });
        return;
    }
  }

  cost(name: string, c: Cost): void {
    const minute = Math.floor(this.now() / MINUTE);
    let b = this.costs.find((x) => x.minute === minute && x.agent === name && x.module === c.module && x.tier === c.tier);
    if (!b) {
      b = { minute, agent: name, module: c.module, tier: c.tier, input: 0, output: 0, calls: 0, errors: 0 };
      this.costs.push(b);
    }
    b.input += c.inputTokens;
    b.output += c.outputTokens;
    b.calls += 1;
    if (!c.ok) b.errors += 1;
    this.totals.input += c.inputTokens;
    this.totals.output += c.outputTokens;
    this.totals.calls += 1;
    if (!c.ok) this.totals.errors += 1;
    // Keep two hours of minutes.
    const cut = minute - 120;
    while (this.costs.length > 0 && (this.costs[0]?.minute ?? cut) < cut) this.costs.shift();
  }

  /** Tokens in the last hour, split three ways, and when the weekly quota runs out at this rate (§22.4). */
  costView(): Record<string, unknown> {
    const t = this.now();
    const from = Math.floor((t - HOUR) / MINUTE);
    const recent = this.costs.filter((b) => b.minute > from);
    const sum = (key: 'module' | 'tier' | 'agent') => {
      const out: Record<string, { input: number; output: number; calls: number }> = {};
      for (const b of recent) {
        const k = b[key];
        const r = (out[k] ??= { input: 0, output: 0, calls: 0 });
        r.input += b.input;
        r.output += b.output;
        r.calls += b.calls;
      }
      return out;
    };
    const input = recent.reduce((a, b) => a + b.input, 0);
    const output = recent.reduce((a, b) => a + b.output, 0);
    // A rate over less than an hour of data is scaled up to an hour.
    const span = Math.min(HOUR, Math.max(MINUTE, t - this.startedAt));
    const perHour = (input * HOUR) / span;
    const q = this.o.quota?.() ?? null;
    const remaining = q?.remaining ?? null;
    const resetAt = q?.resetAt ?? null;
    const exhaustAt = remaining !== null && perHour > 0 ? t + (remaining / perHour) * HOUR : null;
    return {
      lastHour: { input, output, calls: recent.reduce((a, b) => a + b.calls, 0), errors: recent.reduce((a, b) => a + b.errors, 0) },
      inputPerHour: Math.round(perHour),
      byModule: sum('module'),
      byTier: sum('tier'),
      byAgent: sum('agent'),
      total: { ...this.totals },
      projection: { exhaustAt, resetAt, beforeReset: exhaustAt !== null && resetAt !== null ? exhaustAt < resetAt : null },
    };
  }

  private summary(v: AgentView): Record<string, unknown> {
    const s = v.state;
    const last = v.decisions.last(1)[0];
    const e = (s?.emotions ?? {}) as Record<string, number>;
    const top = Object.entries(e)
      .filter(([k]) => k !== 'arousal')
      .sort((a, b) => b[1] - a[1])[0];
    const persona = this.o.personas?.().find((p) => p.username === v.name);
    return {
      name: v.name,
      online: v.online,
      ...(v.died ? { died: v.died } : {}),
      ...(persona ? { traits: persona.traits, sex: persona.sex } : {}),
      health: s?.health ?? null,
      food: s?.food ?? null,
      goal: s?.goal ?? null,
      role: typeof s?.role === 'string' ? s.role : null,
      village: Array.isArray(s?.village) ? s.village : [],
      option: s?.option ?? null,
      flags: s?.flags ?? null,
      rungs: s?.rungs ?? {},
      mood: s?.mood ?? null,
      feeling: top && top[1] >= 0.25 ? { name: top[0], intensity: top[1] } : null,
      arousal: e.arousal ?? 0,
      fear: v.fear.last(60).map((f) => f.v),
      lastDecision: last ? { ts: last.ts, source: last.source, option: last.option, rationale: last.rationale } : null,
      sources: v.sources,
      lastSeen: v.lastSeen,
    };
  }

  overview(): Record<string, unknown> {
    const q = this.o.quota?.() ?? null;
    const agents = [...this.agents.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return {
      now: this.now(),
      startedAt: this.startedAt,
      mode: this.o.mode(),
      online: agents.filter((a) => a.online).length,
      quota: q,
      cost: this.costView(),
      agents: agents.map((a) => this.summary(a)),
      society: this.society(),
      events: this.events.last(40).reverse(),
      problems: this.problems.last(20).reverse(),
    };
  }

  agent(name: string): Record<string, unknown> | null {
    const v = this.agents.get(name);
    if (!v) return null;
    return {
      ...this.summary(v),
      slot: v.slot,
      firstSeen: v.firstSeen,
      state: v.state,
      people: v.people,
      decisions: v.decisions.items().reverse(),
      actions: v.actions.items().reverse(),
      said: v.said.items().reverse(),
      events: v.events.items().reverse(),
      fear: v.fear.items(),
    };
  }

  /**
   * §6.8, §11 F: the roles the agents' social goals add up to (those online), how varied they are (Shannon entropy
   * in bits), and the words most used in the chat over the last hour (the culture metrics, counted in code).
   */
  society(): { roles: Record<string, number>; entropy: number; keywords: [string, number][] } {
    const roles: Record<string, number> = {};
    const labels: string[] = [];
    for (const v of this.agents.values()) {
      const r = v.state?.role;
      if (!v.online || typeof r !== 'string' || !r) continue;
      roles[r] = (roles[r] ?? 0) + 1;
      labels.push(r);
    }
    const t = this.now();
    const words = new Map<string, number>();
    for (const l of this.chat.items()) {
      if (t - l.ts > HOUR || typeof l.text !== 'string') continue;
      for (const w of l.text.toLowerCase().match(/[a-z]{4,}/g) ?? []) if (!STOPWORDS.has(w)) words.set(w, (words.get(w) ?? 0) + 1);
    }
    const keywords = [...words.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
    return { roles, entropy: shannonEntropy(labels), keywords };
  }

  /** Who thinks what of whom (§18.8 heatmaps): one cell per observer and person they know. */
  social(): { names: string[]; cells: (PersonRow & { from: string; to: string })[] } {
    const observers = [...this.agents.values()].filter((a) => a.online || a.people.length > 0);
    const names = new Set(observers.map((a) => a.name));
    const cells: (PersonRow & { from: string; to: string })[] = [];
    for (const a of observers) {
      for (const p of a.people) {
        names.add(p.name);
        cells.push({ ...p, from: a.name, to: p.name });
      }
    }
    return { names: [...names].sort(), cells };
  }

  chatSince(since = 0): Row[] {
    return this.chat.items().filter((l) => l.ts > since);
  }

  /** Names known to the dashboard (for the CLI and tests). */
  names(): string[] {
    return [...this.agents.keys()];
  }
}
