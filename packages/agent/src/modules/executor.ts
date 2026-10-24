// Skill Executor (§4.2 module 3, §4.4 option–action). Once the CC sets an option, the cheap layers drive it: this
// runs the matching verified skill until a code-checked termination (maxSeconds, the `until` condition, the skill
// finishing, or a danger preemption), records expected vs. observed, and wakes the CC.

import type { ActionRecord, ActiveOption, AgentState, Logger } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { Body } from '../body/body';
import type { AnySkill, DesignAsk, SkillResult } from '../body/skills/types';
import type { AgentStateStore } from '../state/store';
import { cueCame, cueFrom } from '../mind/later';
import { evalCondition } from './conditions';
import type { MindLevers } from './levers';
import { whoMakesChests } from '../social/village';

export interface ExecutorOptions {
  store: AgentStateStore;
  bus: AgentBus;
  body: Body;
  logger: Logger;
  levers: () => MindLevers;
  /** Recipe knowledge gate (§21.2, M6); everything is known until then. */
  knowsRecipe?: (item: string) => boolean;
  /** Fighting ability with growth (§21.3), for the duel's technique. */
  combat?: () => number;
  /** A world-wide fight slot (§17.10 maxConcurrentFights, the Hub's fight tokens); always granted without a Hub. */
  acquireFight?: () => Promise<boolean>;
  releaseFight?: () => void;
  /** M10: the skills the agent wrote for itself (verified, and the one on trial), to run by name. */
  extraSkills?: () => readonly AnySkill[];
  /** The architect, for the `design` skill (owner request, 2026-10-24). */
  architect?: (ask: DesignAsk) => Promise<SkillResult>;
  now?: () => number;
}

const ACTION_LOG = 30;
/** A conversation with a line this recent is one going on (a stroll stays for it); older, it has gone quiet. */
const TALK_LIVE_MS = 15_000;
/** A blow this recent between two others is a fight going on (a stroll stops to watch). */
const FIGHT_SEEN_MS = 8_000;
/** How long a new option waits for the one it replaced to clean up (its last stop of motion). */
const SETTLE_MS = 1500;

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
      // The walk the mind gave, as it gave it (its "within 10 blocks" had become 1).
      if (opt.skill === 'goTo' && opt.args) return { skill: 'goTo', args: opt.args };
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
    case 'demand':
    case 'recruit':
      if (opt.targetAgent && !nearAgent(opt.targetAgent, 6)) return { skill: 'goTo', args: { agent: opt.targetAgent, range: 4 } };
      // While talking: facing them, an eye on what's around.
      return { skill: 'lookAround', args: { seconds: Math.min(opt.maxSeconds, 600), ...(opt.targetAgent ? { at: opt.targetAgent } : {}) } };
    // A fight is a duel until someone yields (the conflict gate let it through, §17.5).
    case 'fight':
      if (opt.skill) return { skill: opt.skill, args: opt.args ?? {} };
      // A person is fought until someone yields; a mob just until it's gone.
      if (opt.targetAgent) return { skill: nearAgent(opt.targetAgent, 32) ? 'duel' : 'attack', args: { target: opt.targetAgent } };
      return { skill: 'wait', args: { seconds: 5 } };
    // §19.2 courting: walk over, then the small gift (a give task) or a moment while the line is said.
    case 'court':
      if (opt.targetAgent && !nearAgent(opt.targetAgent, 6)) return { skill: 'goTo', args: { agent: opt.targetAgent, range: 3 } };
      return opt.skill ? { skill: opt.skill, args: opt.args ?? {} } : { skill: 'lookAround', args: { seconds: Math.min(opt.maxSeconds, 60), ...(opt.targetAgent ? { at: opt.targetAgent } : {}) } };
    // Resting is not standing frozen: one stays put and keeps an eye on what's around (on whom we face, if anyone).
    case 'yield':
    case 'apologize':
    case 'rest':
      return { skill: 'lookAround', args: { seconds: Math.min(Math.max(opt.maxSeconds, 1), 120), ...(opt.targetAgent ? { at: opt.targetAgent } : {}) } };
  }
}

export class SkillExecutor {
  private current: { opt: ActiveOption; ac: AbortController; reason: string | null; skill?: string } | null = null;
  /** Settles once the latest run, its skill's cleanup included, is over. */
  private settled: Promise<void> = Promise.resolve();
  private stopped = false;
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
    return this.current === null || skill === 'wait' || skill === 'look' || skill === 'lookAround' || skill === 'wander';
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
      // The one replaced cleans up first, a moment at most: its last stop of motion would cut this one's walk short
      // (a gift tossed from where the walk was stopped, short of whom it was for). Replaced again meanwhile, or
      // stopping: not run at all.
      const before = this.settled;
      this.settled = (async () => {
        await Promise.race([before, new Promise((r) => setTimeout(r, SETTLE_MS))]);
        const now = this.o.store.state.option;
        if (this.stopped || now?.decisionId !== opt.decisionId || now.status !== 'running') return;
        await this.run(opt);
      })().catch((err: unknown) => this.o.logger.warn({ module: 'executor', err: String(err) }, 'option failed to run'));
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
    // A talk option is over when its conversation is: one with them that had a line since the option began. An
    // older one going quiet just as we decided to talk to them again is not it (its end would cut off what we meant
    // to say).
    this.offs.push(
      this.o.bus.on('conversationEnded', (e) => {
        const opt = this.current?.opt;
        const who = opt?.targetAgent;
        if (opt?.option !== 'talk' || !who) return;
        const conv = this.o.store.state.conversations[e.convId];
        if (conv?.participants.includes(who) && conv.lastActivity >= opt.startedAt) this.abort('conversation over');
      }),
    );
  }

  stop(): void {
    this.stopped = true;
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
    }, Math.max(opt.maxSeconds, walkSeconds(opt, store.state)) * 1000);
    let warned = false;
    // "Until" is until it comes true: one true already (asked to gather 5 more logs, holding 10, until there are 5)
    // says nothing about when to stop, and stopping at once would leave the work undone. The cues a "later" waits on
    // ("see:pig", "night", "have:shears") say it as well: the mind used them here, and they went unheard.
    const cue = opt.until ? cueFrom(opt.until, Date.now()) : null;
    const until = (u: string): boolean | null => {
      const v = evalCondition(u, store.state);
      if (v !== null || !cue) return v;
      return cueCame({ id: 'until', what: u, cue: cue.cue, since: opt.startedAt, ...(cue.due !== undefined ? { due: cue.due } : {}) }, store.state, Date.now()) !== null;
    };
    const trueAlready = opt.until ? until(opt.until) === true : false;
    if (trueAlready) logger.debug({ module: 'executor', until: opt.until }, 'until-condition true already; not watched');
    const watch = setInterval(() => {
      if (!opt.until || trueAlready) return;
      const v = until(opt.until);
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
    // §17.10: only so many fights at once in the whole world (the agent just holds back; it isn't told why).
    const fighting = opt.option === 'fight';
    if (fighting && this.o.acquireFight && !(await this.o.acquireFight())) me.reason = 'held back';
    // A talk option walks into range first, then waits while Talking does the talking.
    let step = skillForOption(opt, (n, w) => this.nearAgent(n, w));
    for (let leg = 0; leg < 2 && !me.reason; leg++) {
      me.skill = step.skill;
      store.update('option', (o) => (o && o.decisionId === opt.decisionId ? { ...o, skill: step.skill, args: step.args } : o), `running ${step.skill}`);
      const r = await body.run(step.skill, step.args, {
        signal: ac.signal,
        slipChance: L.slipChance,
        knowsRecipe: this.o.knowsRecipe,
        planDepth: L.planDepth,
        ...(this.o.extraSkills ? { extraSkills: this.o.extraSkills() } : {}),
        ...(this.o.combat ? { combat: this.o.combat() } : {}),
        progress: (note) => store.update('option', (o) => (o && o.decisionId === opt.decisionId ? { ...o, progress: note } : o), 'progress'),
        talkingWith: () => {
          const me = store.state.self.username;
          const t = this.now();
          return Object.values(store.state.conversations).find((c) => c.status === 'active' && t - c.lastActivity < TALK_LIVE_MS)?.participants.find((n) => n !== me) ?? null;
        },
        // No chest about: a builder makes one, anyone when there's no builder (owner request, 2026-10-24).
        chestMaker: () => whoMakesChests(store.state, this.now()),
        ...(this.o.architect ? { architect: this.o.architect } : {}),
        portals: {
          list: () => store.state.village.portals ?? [],
          note: (p) =>
            store.update(
              'village',
              (v) => ({ ...v, portals: [...(v.portals ?? []).filter((x) => !(x.dimension === p.dimension && Math.abs(x.pos.x - p.pos.x) <= 2 && Math.abs(x.pos.y - p.pos.y) <= 3 && Math.abs(x.pos.z - p.pos.z) <= 2)), p].slice(-12) }),
              'portal',
            ),
        },
        // A new home: the old village's chest, huts and board are behind us (owner request, 2026-10-24).
        setHome: (pos) => {
          body.home = pos.clone();
          store.update('village', (v) => ({ ...v, home: { x: pos.x, y: pos.y, z: pos.z }, chest: null, huts: [], board: null, signs: [] }), 'settled');
        },
        // Buildings begun, carried on where they were left (owner request, 2026-10-24).
        projects: {
          get: (design) => store.state.village.projects.find((p) => p.design === design && p.doneAt === null) ?? null,
          set: (p) => store.update('village', (v) => ({ ...v, projects: [...v.projects.filter((x) => !(x.design === p.design && x.startedAt === p.startedAt)), p].slice(-12) }), 'building'),
          taken: () => {
            const v = store.state.village;
            const spot = (q: { x: number; z: number }, r: number) => ({ x0: q.x - r, z0: q.z - r, x1: q.x + r, z1: q.z + r });
            return [
              ...v.huts.map((h) => spot(h, 3)),
              ...(v.chest ? [spot(v.chest.pos, 1)] : []),
              ...(v.board ? [spot(v.board, 1)] : []),
              ...v.projects.map((p) => ({ x0: p.origin.x, z0: p.origin.z, x1: p.origin.x + p.size.x - 1, z1: p.origin.z + p.size.z - 1 })),
            ];
          },
        },
        fightNearby: () => {
          const me = store.state.self.username;
          const t = this.now();
          const blows = store.state.perception.observedActions;
          for (let i = blows.length - 1; i >= 0; i--) {
            const a = blows[i];
            if (!a || t - a.ts > FIGHT_SEEN_MS) break;
            if (a.kind === 'attack' && a.target && a.actor !== me && a.target !== me) return a.actor;
          }
          return null;
        },
      });
      // Stopped because what it was for came true: that is the work done, not a failure.
      const reached = me.reason?.startsWith('until ') === true;
      ok = (r.ok && !r.mismatch) || reached;
      rec = {
        id: r.id,
        skill: r.skill,
        args: r.args,
        expected: r.expected,
        observed: reached ? [r.observed.replace(/^interrupted;?\s*/, ''), `stopped once ${opt.until ?? 'it'} came true`].filter(Boolean).join('; ') : r.observed,
        ok,
        ts: r.startedAt,
        durationMs: r.durationMs,
        ...(reached ? {} : r.error ? { error: r.error } : r.mismatch ? { error: `expected ${r.expected}, saw ${r.observed}` } : {}),
        ...(!ok && r.progressed ? { progressed: true } : {}),
        ...(r.data ? { data: r.data } : {}),
      };
      store.update('actionLog', (log) => [...log, rec as ActionRecord].slice(-ACTION_LOG), `action ${r.skill}`);
      logger.info({ module: 'executor', skill: r.skill, args: r.args, ok, expected: r.expected, observed: r.observed, error: rec.error, ms: r.durationMs, slip: r.slip }, 'action');
      bus.emit({ type: 'actionRecorded', record: rec });
      if ((opt.option === 'talk' || opt.option === 'trade' || (opt.option === 'court' && !opt.skill)) && leg === 0 && step.skill === 'goTo' && ok && !ac.signal.aborted) {
        step = { skill: 'lookAround', args: { seconds: Math.max(1, Math.round((opt.startedAt + opt.maxSeconds * 1000 - this.now()) / 1000)), ...(opt.targetAgent ? { at: opt.targetAgent } : {}) } };
        continue;
      }
      if ((opt.option === 'help' || opt.option === 'court') && leg === 0 && step.skill === 'goTo' && ok && !ac.signal.aborted && opt.skill) {
        step = { skill: opt.skill, args: opt.args ?? {} };
        continue;
      }
      break;
    }
    clearTimeout(deadline);
    clearInterval(watch);
    if (fighting) this.o.releaseFight?.();
    const reason = me.reason ?? (ok ? 'done' : (rec?.error ?? 'failed'));
    // A condition that came true or a timer counts as a normal end, not a failure.
    const success =
      ok || reason.startsWith('until ') || reason === 'conversation over' || reason === 'they said done' || (reason === 'time is up' && ['rest', 'follow', 'talk', 'trade', 'explore', 'court'].includes(opt.option));
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

/**
 * How long a walk takes at the least, so the time given for it doesn't cut it off halfway (a long way over hills
 * takes its time): 20 s and 1.5 s a block, up to 4 min. Zero for anything that isn't a walk somewhere.
 */
export function walkSeconds(opt: ActiveOption, s: AgentState): number {
  const a = opt.args ?? {};
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
  let far = 0;
  if (opt.skill === 'goTo' && Number.isFinite(n(a.x)) && Number.isFinite(n(a.z))) far = Math.hypot(n(a.x) - s.self.pos.x, n(a.z) - s.self.pos.z);
  else if (opt.skill === 'explore' && Number.isFinite(n(a.distance))) far = n(a.distance);
  return far > 0 ? Math.min(240, 20 + far * 1.5) : 0;
}
