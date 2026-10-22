// Skill Executor (§4.2 module 3, §4.4 option–action). Once the CC sets an option, the cheap layers drive it: this
// runs the matching verified skill until a code-checked termination (maxSeconds, the `until` condition, the skill
// finishing, or a danger preemption), records expected vs. observed, and wakes the CC.

import type { ActionRecord, ActiveOption, Logger } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { Body } from '../body/body';
import type { AgentStateStore } from '../state/store';
import { evalCondition } from './conditions';
import type { MindLevers } from './levers';

export interface ExecutorOptions {
  store: AgentStateStore;
  bus: AgentBus;
  body: Body;
  logger: Logger;
  levers: () => MindLevers;
  /** Recipe knowledge gate (§21.2, M6); everything is known until then. */
  knowsRecipe?: (item: string) => boolean;
  now?: () => number;
}

const ACTION_LOG = 30;

/** "that's enough", "we're done, thanks": the person being helped calls it off (§6.7). */
export const HELP_DONE_RE = /\b(that'?s enough|enough|we'?re done|i'?m done|done now|all done|you can stop|stop now|that'?s all|that'?ll do|all good now)\b/i;

/** Which skill an option runs, and with what. */
/** What the `explore` option runs (also its stuck key). */
export const EXPLORE_ARGS = { distance: 32 } as const;

export function skillForOption(opt: ActiveOption, nearAgent: (name: string, within: number) => boolean): { skill: string; args: Record<string, unknown> } {
  switch (opt.option) {
    case 'work':
      return opt.skill ? { skill: opt.skill, args: opt.args ?? {} } : { skill: 'wait', args: { seconds: 5 } };
    // §6.7: help works near the person; walk over first if they are far.
    case 'help':
      if (opt.targetAgent && !nearAgent(opt.targetAgent, 8)) return { skill: 'goTo', args: { agent: opt.targetAgent, range: 4 } };
      return opt.skill ? { skill: opt.skill, args: opt.args ?? {} } : { skill: 'wait', args: { seconds: 5 } };
    case 'move':
      if (opt.targetPos) return { skill: 'goTo', args: { ...opt.targetPos, range: 1 } };
      if (opt.targetAgent) return { skill: 'goTo', args: { agent: opt.targetAgent, range: 3 } };
      return { skill: 'wait', args: { seconds: 5 } };
    case 'follow':
      return opt.targetAgent ? { skill: 'follow', args: { agent: opt.targetAgent, distance: 3 } } : { skill: 'wait', args: { seconds: 5 } };
    case 'explore':
      return { skill: 'explore', args: { ...EXPLORE_ARGS } };
    case 'flee':
      return { skill: 'flee', args: opt.targetAgent ? { from: opt.targetAgent } : {} };
    // A trade is talked through (§6.6); the hand-over is a give task once it's agreed.
    case 'talk':
    case 'trade':
      if (opt.targetAgent && !nearAgent(opt.targetAgent, 6)) return { skill: 'goTo', args: { agent: opt.targetAgent, range: 4 } };
      return { skill: 'wait', args: { seconds: Math.min(opt.maxSeconds, 600) } };
    // Conflict and romance options get their own skills in M6b–M9; until then they pass time.
    case 'fight':
    case 'demand':
    case 'yield':
    case 'recruit':
    case 'court':
    case 'apologize':
    case 'rest':
      return { skill: 'wait', args: { seconds: Math.min(Math.max(opt.maxSeconds, 1), 120) } };
  }
}

export class SkillExecutor {
  private current: { opt: ActiveOption; ac: AbortController; reason: string | null; skill?: string } | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: ExecutorOptions) {
    this.now = o.now ?? Date.now;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** Nothing physical going on (resting or just looking around): upkeep reflexes like picking things up may run. */
  get idleBody(): boolean {
    const skill = this.current?.skill ?? this.current?.opt.skill;
    return this.current === null || skill === 'wait' || skill === 'look';
  }

  /** The running option's skill can continue during a conversation (§6.2 busy matrix). */
  talkOverable(): boolean {
    const name = this.current?.skill ?? this.current?.opt.skill;
    return !name || this.o.body.skill(name)?.talkOverable !== false;
  }

  start(): void {
    const onChange = (c: { facet: string; prev: { option: ActiveOption | null }; next: { option: ActiveOption | null } }) => {
      if (c.facet !== 'option') return;
      const opt = c.next.option;
      if (!opt || opt.status !== 'running') return;
      if (this.current?.opt.decisionId === opt.decisionId) return;
      if (this.current) this.abort('replaced by a new decision');
      void this.run(opt);
    };
    this.o.store.on('change', onChange);
    this.offs.push(() => this.o.store.off('change', onChange));
    this.offs.push(this.o.bus.on('danger', () => this.abort('danger')));
    // Helping ends when the person we help says it's enough (§6.7 shared termination).
    this.offs.push(
      this.o.bus.on('addressed', (e) => {
        const opt = this.current?.opt;
        if (opt?.option === 'help' && opt.targetAgent === e.utterance.from && HELP_DONE_RE.test(e.utterance.text)) this.abort('they said done');
      }),
    );
    // A talk option is over when its conversation is.
    this.offs.push(
      this.o.bus.on('conversationEnded', (e) => {
        const opt = this.current?.opt;
        const who = opt?.targetAgent;
        if (opt?.option !== 'talk' || !who) return;
        if (this.o.store.state.conversations[e.convId]?.participants.includes(who)) this.abort('conversation over');
      }),
    );
  }

  stop(): void {
    this.abort('shutting down');
    for (const off of this.offs.splice(0)) off();
  }

  abort(reason: string): void {
    if (!this.current || this.current.ac.signal.aborted) return;
    this.current.reason = reason;
    this.current.ac.abort(new Error(reason));
  }

  private nearAgent(name: string, within: number): boolean {
    return this.o.store.state.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === name && e.distance <= within);
  }

  private async run(opt: ActiveOption): Promise<void> {
    const ac = new AbortController();
    const me: { opt: ActiveOption; ac: AbortController; reason: string | null; skill?: string } = { opt, ac, reason: null };
    this.current = me;
    const { store, bus, body, logger } = this.o;
    const L = this.o.levers();
    const deadline = setTimeout(() => {
      me.reason = 'time is up';
      ac.abort(new Error('time is up'));
    }, opt.maxSeconds * 1000);
    let warned = false;
    const watch = setInterval(() => {
      if (!opt.until) return;
      const v = evalCondition(opt.until, store.state);
      if (v === null && !warned) {
        warned = true;
        logger.warn({ module: 'executor', until: opt.until }, 'unknown until-condition; only maxSeconds applies');
      }
      if (v === true) {
        me.reason = `until ${opt.until}`;
        ac.abort(new Error('condition met'));
      }
    }, 1000);
    store.update('flags', (f) => ({ ...f, busyLevel: f.inDanger ? 'critical' : 'working' }), 'option started');
    let ok = false;
    let rec: ActionRecord | null = null;
    // A talk option walks into range first, then waits while Talking does the talking.
    let step = skillForOption(opt, (n, w) => this.nearAgent(n, w));
    for (let leg = 0; leg < 2; leg++) {
      me.skill = step.skill;
      store.update('option', (o) => (o && o.decisionId === opt.decisionId ? { ...o, skill: step.skill, args: step.args } : o), `running ${step.skill}`);
      const r = await body.run(step.skill, step.args, {
        signal: ac.signal,
        slipChance: L.slipChance,
        knowsRecipe: this.o.knowsRecipe,
        planDepth: L.planDepth,
        progress: (note) => store.update('option', (o) => (o && o.decisionId === opt.decisionId ? { ...o, progress: note } : o), 'progress'),
      });
      ok = r.ok && !r.mismatch;
      rec = {
        id: r.id,
        skill: r.skill,
        args: r.args,
        expected: r.expected,
        observed: r.observed,
        ok,
        ts: r.startedAt,
        durationMs: r.durationMs,
        ...(r.error ? { error: r.error } : r.mismatch ? { error: `expected ${r.expected}, saw ${r.observed}` } : {}),
        ...(!ok && r.progressed ? { progressed: true } : {}),
      };
      store.update('actionLog', (log) => [...log, rec as ActionRecord].slice(-ACTION_LOG), `action ${r.skill}`);
      logger.info({ module: 'executor', skill: r.skill, args: r.args, ok, expected: r.expected, observed: r.observed, error: rec.error, ms: r.durationMs, slip: r.slip }, 'action');
      bus.emit({ type: 'actionRecorded', record: rec });
      if ((opt.option === 'talk' || opt.option === 'trade') && leg === 0 && step.skill === 'goTo' && ok && !ac.signal.aborted) {
        step = { skill: 'wait', args: { seconds: Math.max(1, Math.round((opt.startedAt + opt.maxSeconds * 1000 - this.now()) / 1000)) } };
        continue;
      }
      if (opt.option === 'help' && leg === 0 && step.skill === 'goTo' && ok && !ac.signal.aborted && opt.skill) {
        step = { skill: opt.skill, args: opt.args ?? {} };
        continue;
      }
      break;
    }
    clearTimeout(deadline);
    clearInterval(watch);
    const reason = me.reason ?? (ok ? 'done' : (rec?.error ?? 'failed'));
    // A condition that came true or a timer counts as a normal end, not a failure.
    const success =
      ok || reason.startsWith('until ') || reason === 'conversation over' || reason === 'they said done' || (reason === 'time is up' && ['rest', 'follow', 'talk', 'trade', 'explore'].includes(opt.option));
    if (this.current === me) this.current = null;
    store.update(
      'option',
      (o) => (o && o.decisionId === opt.decisionId ? { ...o, status: me.reason ? 'terminated' : success ? 'succeeded' : 'failed', progress: reason } : o),
      `option ${reason}`,
    );
    store.update('flags', (f) => ({ ...f, busyLevel: f.inDanger ? 'critical' : this.current ? 'working' : 'idle' }), 'option ended');
    bus.emit({ type: 'optionTerminated', reason, ok: success, option: opt.option, ...(opt.targetAgent ? { targetAgent: opt.targetAgent } : {}) });
  }
}
