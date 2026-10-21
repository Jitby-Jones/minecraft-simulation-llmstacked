// Cognitive Controller (§4.2 module 9, §4.3): the one place high-level decisions are made. It sees only the
// bottleneck packet, answers in strict JSON (zod-validated, one repair retry in the client) and broadcasts the
// decision: the executor runs its task, Talking phrases its speech intent. Woken by events (option ended, danger
// cleared, a request needing an answer, a new goal) plus a ≤ 30 s heartbeat when idle; while an option runs, only
// requests wake it (§4.4). Semantically wrong decisions get one retry with the reason, then the code default, which
// also keeps the agent working in code-only mode (§22.4).

import { type AgentName, type Commitment, type ConvId, type Decision, type DecisionOutput, DecisionOutputSchema, type Goal, type Logger, type Task } from '@agora/shared';
import { type ChatMessage, type LlmClient, SingleFlight } from '@agora/llm';
import type { AgentBus } from '../bus';
import { getSkill, skillCatalog } from '../body/skills/registry';
import { CC_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import type { ActionAwareness } from './awareness';
import { taskKey } from './awareness';
import { buildPacket } from './bottleneck';
import { evalCondition } from './conditions';
import type { SkillExecutor } from './executor';
import type { MindLevers } from './levers';
import { DECISION_FORMAT, DECISION_RULES, personaCore } from './prompts';

export interface DecideContext {
  /** A request from someone that needs an answer (wakes the CC even mid-option). */
  convId?: ConvId;
  from?: AgentName;
  urgent?: boolean;
}

export interface ValidationEnv {
  me: AgentName;
  isStuck: (skill: string, args: Record<string, unknown>) => boolean;
  canPerceive: (name: AgentName) => boolean;
}

/** Code checks on a schema-valid decision. Returns the reason it can't be used, or null. */
export function validateDecision(d: DecisionOutput, env: ValidationEnv): string | null {
  if ((d.option === 'work' || d.option === 'help') && !d.task) return `option ${d.option} needs a task (skill + args)`;
  if (d.task) {
    const skill = getSkill(d.task.skill);
    if (!skill) return `there is no skill "${d.task.skill}"`;
    const parsed = skill.parseArgs(d.task.args);
    if (!parsed.ok) return `bad arguments for ${skill.name}: ${parsed.error}`;
    if (env.isStuck(skill.name, d.task.args)) return `you are stuck on ${skill.name} ${JSON.stringify(d.task.args)}; choose something else`;
  }
  if ((d.option === 'talk' || d.option === 'follow') && !d.target?.agent) return `option ${d.option} needs target.agent`;
  if (d.option === 'move' && !d.target?.pos && !d.target?.agent) return 'option move needs target.pos or target.agent';
  const who = d.target?.agent;
  if (who && who !== env.me && ['talk', 'follow', 'help', 'trade', 'move'].includes(d.option) && !env.canPerceive(who)) {
    return `you can't see or hear ${who} right now`;
  }
  return null;
}

let seq = 0;
const newId = (p: string, now: number) => `${p}${now.toString(36)}${(seq++).toString(36)}`;

/** The non-LLM decision (§5 "CC default"), also the code-only brain (§22.4). Null = keep doing what you're doing. */
export function codeDecision(s: AgentStateStore['state'], ctx: DecideContext, busy: boolean, isStuck: ValidationEnv['isStuck']): DecisionOutput | null {
  if (ctx.from) {
    return {
      option: busy ? (s.option?.option ?? 'rest') : 'rest',
      target: { agent: ctx.from },
      speechIntent: { stance: 'decline', gist: "you can't think it through right now; maybe later", mayCommit: false },
      terminate: { maxSeconds: 20 },
      rationale: 'code default: answered a request without committing',
    };
  }
  if (busy) return null;
  // Survive the night (M1 shelter).
  if (!s.self.isDay && !s.flags.inDanger && !isStuck('shelter', { untilMorning: true })) {
    return { option: 'work', task: { skill: 'shelter', args: { untilMorning: true } }, terminate: { maxSeconds: 900 }, rationale: 'code default: night, dig in' };
  }
  const next = s.taskQueue[0];
  if (next && !isStuck(next.skill, next.args)) {
    return { option: 'work', task: { skill: next.skill, args: next.args }, terminate: { maxSeconds: 600 }, rationale: `code default: next planned task (${next.note ?? next.skill})` };
  }
  // Work toward a goal with a machine-checkable target: obtain it (or the prerequisite it said to get first).
  const want = s.goals.current?.doneWhen ? /^inventoryHas:([a-z0-9_]+)\s*>=\s*(\d+)$/i.exec(s.goals.current.doneWhen) : null;
  if (want?.[1] && want[2]) {
    const first = [...s.actionLog]
      .reverse()
      .find((a) => a.skill === 'obtain' && !a.ok)
      ?.error?.match(/get ([a-z0-9_]+) first/)?.[1];
    const item = first && !isStuck('obtain', { item: first, qty: 1 }) ? first : want[1];
    const qty = item === want[1] ? Number(want[2]) : 1;
    if (!isStuck('obtain', { item, qty })) {
      return { option: 'work', task: { skill: 'obtain', args: { item, qty } }, terminate: { maxSeconds: 600 }, rationale: `code default: get ${item} for the goal` };
    }
    return { option: 'explore', terminate: { maxSeconds: 60 }, rationale: 'code default: stuck on the goal, look around' };
  }
  return { option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'code default: nothing to do' };
}

export interface CCOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: AgentName;
  levers: () => MindLevers;
  awareness: ActionAwareness;
  executor: SkillExecutor;
  /** People perceivable now (seen or heard). */
  canPerceive: (name: AgentName) => boolean;
  /** Retrieved memories for the packet (M4). */
  memories?: (state: AgentStateStore['state']) => string[];
  heartbeatMs?: number;
  now?: () => number;
}

export class CognitiveController {
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private beat: NodeJS.Timeout | null = null;
  private lastDecisionAt = 0;
  private deferred: { reason: string; ctx: DecideContext } | null = null;
  private readonly now: () => number;

  constructor(private readonly o: CCOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const b = this.o.bus;
    this.offs.push(b.on('optionTerminated', (e) => this.trigger(`what you were doing ended (${e.reason})`)));
    this.offs.push(
      b.on('dangerCleared', () => {
        const d = this.deferred;
        this.deferred = null;
        this.trigger(d ? `the danger is over; earlier: ${d.reason}` : 'the danger is over', d?.ctx ?? {});
      }),
    );
    this.offs.push(
      b.on('needsDecision', (e) => {
        if (e.reason === 'request') this.trigger(`${e.from ?? 'someone'} asked you something`, { convId: e.convId, from: e.from, urgent: true });
      }),
    );
    this.offs.push(b.on('newGoal', (e) => this.trigger(`new goal: ${e.goal.text}`, { urgent: !this.o.executor.busy })));
    this.beat = setInterval(() => {
      const s = this.o.store.state;
      if (s.flags.inDanger || this.o.executor.busy || this.flight.inFlight('cc')) return;
      if (this.now() - this.lastDecisionAt >= (this.o.heartbeatMs ?? 30_000)) this.trigger(this.lastDecisionAt === 0 ? 'you just arrived' : 'checking in');
    }, 2000);
    this.beat.unref();
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** Sets the current goal (Goal Gen does this from M4 on; the runner/tests before that). */
  setGoal(text: string, doneWhen?: string): Goal {
    const goal: Goal = { id: newId('g', this.now()), text, kind: 'current', createdAt: this.now(), status: 'active', ...(doneWhen ? { doneWhen } : {}) };
    this.o.store.update('goals', (g) => ({ ...g, current: goal, history: g.current ? [...g.history, { ...g.current, status: 'abandoned' as const }].slice(-20) : g.history }), 'goal set');
    this.o.bus.emit({ type: 'newGoal', goal });
    return goal;
  }

  trigger(reason: string, ctx: DecideContext = {}): void {
    if (this.o.store.state.flags.inDanger) {
      // The reflex owns the body; decide when it's over (§4.5).
      this.deferred = { reason, ctx };
      return;
    }
    void this.flight.run('cc', () => this.decide(reason, ctx));
  }

  private checkGoal(): void {
    const g = this.o.store.state.goals.current;
    if (!g?.doneWhen || evalCondition(g.doneWhen, this.o.store.state) !== true) return;
    const done: Goal = { ...g, status: 'done' };
    this.o.store.update('goals', (x) => ({ ...x, current: null, history: [...x.history, done].slice(-20) }), 'goal done');
    this.o.bus.emit({ type: 'goalDone', goal: done });
  }

  private async decide(reason: string, ctx: DecideContext): Promise<void> {
    this.checkGoal();
    const { store, logger } = this.o;
    const s = store.state;
    if (s.flags.inDanger) return;
    const busy = this.o.executor.busy;
    if (busy && !ctx.urgent) return;
    const isStuck = (skill: string, args: Record<string, unknown>) => this.o.awareness.isStuckOn(skill, args);
    const env: ValidationEnv = { me: this.o.me, isStuck, canPerceive: this.o.canPerceive };
    let out: DecisionOutput | null = null;
    let source: Decision['source'] = 'default';
    const L = this.o.levers();
    if (this.o.llm && !s.flags.codeOnly) {
      const tier = reason.startsWith('new goal') && L.planningBurst ? 'L3' : L.ccTier;
      const system = `${personaCore(s.self.persona, s.traitAnnotations)}\n\nYou decide what ${s.self.persona.name} does next.\n${DECISION_RULES}\n\nSkills:\n${skillCatalog()}\n\n${DECISION_FORMAT}`;
      const packet = buildPacket({ state: s, levers: L, reason, stuck: this.o.awareness.stuckList(), memories: this.o.memories?.(s), now: this.now() });
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: packet },
      ];
      const guard = store.guard(CC_POLICY);
      try {
        for (let attempt = 0; attempt < 2 && !out; attempt++) {
          const r = await this.o.llm.call<DecisionOutput | null>({
            tier,
            module: 'cc',
            agent: this.o.me,
            messages,
            schema: DecisionOutputSchema,
            schemaName: 'decision',
            fallback: () => null,
            signal: guard.signal,
            isStale: guard.isStale,
          });
          if (!r.ok) {
            if (r.reason === 'stale' || r.reason === 'aborted') {
              logger.info({ module: 'cc', reason: guard.reason() }, 'decision went stale; dropped');
              return;
            }
            break;
          }
          if (!r.value) break;
          const why = validateDecision(r.value, env);
          if (!why) {
            out = r.value;
            source = 'llm';
            break;
          }
          logger.info({ module: 'cc', why }, 'decision rejected by code checks');
          messages.push({ role: 'assistant', content: r.text.slice(0, 2000) }, { role: 'user', content: `That decision can't be used: ${why}. Decide again.` });
        }
      } finally {
        guard.dispose();
      }
    }
    if (!out) {
      out = codeDecision(store.state, ctx, busy, isStuck);
      source = 'default';
      if (out && validateDecision(out, env)) out = null;
    }
    if (!out) return;
    this.apply(out, source, ctx);
  }

  private apply(out: DecisionOutput, source: Decision['source'], ctx: DecideContext): void {
    const { store, bus, logger } = this.o;
    const now = this.now();
    const decision: Decision = { ...out, id: newId('d', now), createdAt: now, stateVersion: store.version, source };
    if (decision.task) {
      const skill = getSkill(decision.task.skill);
      if (skill) decision.task = { skill: skill.name, args: decision.task.args };
    }
    this.lastDecisionAt = now;
    store.set('decision', decision, `decision ${decision.option}`);
    // Our own promises become commitments and tasks only when the CC allowed committing (§6.4).
    const promises = decision.speechIntent?.mayCommit ? (decision.commitmentsToCreate ?? []).filter((c) => c.debtor === this.o.me || c.debtor.toLowerCase() === 'you') : [];
    if (promises.length > 0) {
      const made: Commitment[] = promises.map((c) => ({
        id: newId('k', now),
        debtor: this.o.me,
        creditor: c.creditor,
        what: c.what,
        ...(c.dueInSec ? { dueBy: now + c.dueInSec * 1000 } : {}),
        status: 'accepted',
        createdFromConv: ctx.convId ?? '',
        createdAt: now,
        ...(c.coerced ? { coerced: true } : {}),
      }));
      store.update('commitments', (all) => [...all, ...made], 'promised');
      const tasks: Task[] = made.flatMap((k): Task[] => {
        const w = k.what;
        if (w.kind === 'give' && w.item) {
          return [
            { id: newId('t', now), skill: 'obtain', args: { item: w.item, qty: w.qty ?? 1 }, source: 'commitment', commitmentId: k.id, createdAt: now, priority: 1, note: `for ${k.creditor}` },
            { id: newId('t', now), skill: 'give', args: { agent: k.creditor, item: w.item, qty: w.qty ?? 1 }, source: 'commitment', commitmentId: k.id, createdAt: now, priority: 1, note: `promised ${k.creditor}` },
          ];
        }
        if (w.kind === 'gather' && w.item) {
          return [{ id: newId('t', now), skill: 'obtain', args: { item: w.item, qty: w.qty ?? 1 }, source: 'commitment', commitmentId: k.id, createdAt: now, priority: 1, note: `promised ${k.creditor}` }];
        }
        return [];
      });
      if (tasks.length > 0) store.update('taskQueue', (q) => [...tasks, ...q].slice(0, this.o.levers().queueDepth + tasks.length), 'promise tasks');
    }
    const cur = store.state.option;
    const sameTask =
      cur?.status === 'running' &&
      cur.option === decision.option &&
      (!decision.task || (cur.skill !== undefined && taskKey(cur.skill, cur.args ?? {}) === taskKey(decision.task.skill, decision.task.args)));
    if (!sameTask) {
      // A queued task that is now being run leaves the queue.
      if (decision.task) {
        const k = taskKey(decision.task.skill, decision.task.args);
        store.update('taskQueue', (q) => (q.some((t) => taskKey(t.skill, t.args) === k) ? q.filter((t) => taskKey(t.skill, t.args) !== k) : q), 'task started');
      }
      store.set(
        'option',
        {
          decisionId: decision.id,
          option: decision.option,
          startedAt: now,
          maxSeconds: decision.terminate.maxSeconds,
          ...(decision.terminate.until ? { until: decision.terminate.until } : {}),
          ...(decision.target?.agent ? { targetAgent: decision.target.agent } : {}),
          ...(decision.target?.pos ? { targetPos: decision.target.pos } : {}),
          ...(decision.target?.item ? { targetItem: decision.target.item } : {}),
          ...(decision.task ? { skill: decision.task.skill, args: decision.task.args } : {}),
          status: 'running',
        },
        `option ${decision.option}`,
      );
    }
    logger.info(
      { module: 'cc', source, option: decision.option, task: decision.task, stance: decision.speechIntent?.stance, mayCommit: decision.speechIntent?.mayCommit, rationale: decision.rationale },
      'decision',
    );
    bus.emit({ type: 'decision', decision });
  }
}
