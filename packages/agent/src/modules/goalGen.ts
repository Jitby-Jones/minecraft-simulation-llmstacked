// Goal Generation (§4.2 module 10), as planning: the agent makes its own plan (what it means to get done over the
// next half hour or so, as a few steps in its own words) and works through it, the step at hand being its current
// goal. L3 makes the plan from the persona (life goals, values), what it has and sees, how it feels, the people it
// knows and what it remembers; it looks the plan over every 3–5 min (slower under quota pressure, §22.4) and changes
// it when it should. After a talk with someone, L2 weighs what was said (who does what, a better idea, a favour taken
// on) into it: plans are refined by talking them over. Without a model the code default makes a plan from the
// agent's needs and leanings, with chance in it, so code-only agents don't all go through the same steps either.
// A step about having things carries a code-checkable `doneWhen`; one without gets a time on it.

import { type AgentState, type Logger, type Plan, type PlanStep } from '@agora/shared';
import { type LlmClient, SingleFlight, ladder } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { SLOW_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { evalCondition } from './conditions';
import { advancePlan, beginNext, currentStep, describePlan, planFinished } from './plan';
import { dayPart } from './bottleneck';
import { DEATH_RULE, personaCore } from './prompts';
import { EDIBLE } from './villageMove';
import { isOff } from '../state/switches';

const StepSchema = z.object({ text: z.string().min(3).max(140), doneWhen: z.string().max(80).optional() });

export const PlanOutputSchema = z.object({
  /** Keep the current plan as it is. */
  keep: z.boolean().default(false),
  plan: z
    .object({
      aim: z.string().min(3).max(160),
      steps: z.array(StepSchema).min(1).max(6),
      why: z.string().max(300).default(''),
    })
    .optional(),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

/** A plan as made: what it's for, its steps, and why. */
export interface PlanDraft {
  aim: string;
  steps: { text: string; doneWhen?: string }[];
  why: string;
}

/** A step the code default has not finished in this long is given up: without a model nothing else would. */
export const STALE_GOAL_MS = 20 * 60_000;
/** A step with nothing code can check is done after this long at it. */
const OPEN_STEP_MIN = 6;
/** A talk is weighed into the plan at most this often. */
const REFINE_EVERY_MS = 90_000;

export const PLAN_FORMAT = `Each step has "text" (in your words) and, when code can check it, "doneWhen": inventoryHas:<item>>=<n> (having things; "log", "planks", "food" count any kind), villageWork:<kind> (your part in the village, as given), explored:<n> (looking around n times), talkedWith:<name> (a talk with them), spent:<minutes> (time on it).
JSON: {"keep": false, "plan": {"aim": "...", "steps": [{"text": "...", "doneWhen": "..."}], "why": "..."}}`;

/** Empty parts of a model's plan (a doneWhen of "" or "none", an empty why) taken out before validation. */
export function tidyPlan(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const p = o.plan;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    delete o.plan;
    return o;
  }
  const plan = { ...(p as Record<string, unknown>) };
  if (Array.isArray(plan.steps)) {
    plan.steps = plan.steps
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>).text === 'string' && ((s as Record<string, unknown>).text as string).trim().length >= 3)
      .map((s) => {
        const d = typeof s.doneWhen === 'string' ? s.doneWhen.trim() : '';
        return { text: String(s.text).trim(), ...(d && !/^(none|n\/a|null|-)$/i.test(d) ? { doneWhen: d } : {}) };
      })
      .slice(0, 6);
  }
  if (typeof plan.why !== 'string') plan.why = '';
  if (typeof plan.aim !== 'string' || plan.aim.trim().length < 3 || !Array.isArray(plan.steps) || plan.steps.length === 0) delete o.plan;
  else o.plan = plan;
  return o;
}

function held(s: AgentState, re: RegExp): number {
  return s.self.inventory.filter((x) => re.test(x.item)).reduce((a, x) => a + x.qty, 0);
}

/** How likely the village's work comes before one's own next step (§6.8): the agreeable and loyal more, the ambitious less. */
export function villageFirst(s: AgentState): number {
  const p = s.self.persona;
  return Math.max(0.2, Math.min(0.95, 0.5 + 0.3 * p.big5.agreeableness + 0.2 * p.temperament.loyalty - 0.3 * p.temperament.ambition));
}

interface Aim {
  aim: string;
  weight: number;
  steps: () => { text: string; doneWhen?: string }[];
}

/**
 * The code default's plan: one of the things this agent could want to do now, by what it needs (tools, food, a roof,
 * company) and what it leans toward (its values and temperament), drawn by chance, with its own amounts. Sometimes a
 * second aim's first step follows. Null while it has a plan with steps left.
 */
export function codePlan(s: AgentState, rng: () => number = Math.random): PlanDraft | null {
  if (s.goals.plan && !planFinished(s.goals.plan)) return null;
  const p = s.self.persona;
  const values = new Set(p.values.map((x) => x.toLowerCase()));
  const v = (name: string) => (values.has(name) ? 1 : 0);
  const n = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = held(s, /_pickaxe$/) > 0;
  const stonePick = held(s, /^(stone|iron|diamond|netherite)_pickaxe$/) > 0;
  const ironPick = held(s, /^(iron|diamond|netherite)_pickaxe$/) > 0;
  const food = held(s, EDIBLE);
  const social = s.goals.social.find((g) => g.status === 'active' && g.work);
  // Someone around or known whom we haven't talked with much yet.
  const people = [...new Set([...s.perception.nearbyEntities.filter((e) => e.kind === 'player').map((e) => e.name), ...Object.keys(s.social)])];
  const stranger = people.find((name) => (s.social[name]?.interactions ?? 0) < 3);
  const life = s.goals.life[Math.floor(rng() * Math.max(1, s.goals.life.length))];
  const aims: Aim[] = [
    {
      aim: 'get some tools together',
      weight: (pick ? (stonePick ? 0.1 : 0.8) : 1.4) * (0.7 + 0.5 * p.big5.conscientiousness + 0.3 * v('hard work') + 0.3 * v('success')),
      steps: () => {
        const logs = n(5, 12);
        const out: { text: string; doneWhen?: string }[] = [];
        if (!pick) out.push({ text: `gather ${logs} logs`, doneWhen: `inventoryHas:log>=${logs}` }, { text: 'make a wooden pickaxe', doneWhen: 'inventoryHas:wooden_pickaxe>=1' });
        if (!stonePick) out.push({ text: 'make a stone pickaxe', doneWhen: 'inventoryHas:stone_pickaxe>=1' });
        if (rng() < 0.4) out.push(rng() < 0.5 ? { text: 'make a stone axe', doneWhen: 'inventoryHas:stone_axe>=1' } : { text: 'make a stone sword', doneWhen: 'inventoryHas:stone_sword>=1' });
        return out;
      },
    },
    {
      aim: 'put a roof over my head',
      weight: 0.3 + 0.6 * v('safety') + 0.5 * s.drives.caution + (s.self.isDay ? 0 : 0.3),
      steps: () => [{ text: `gather ${n(10, 20)} logs for building`, doneWhen: `inventoryHas:log>=${n(10, 14)}` }, { text: 'build a little hut', doneWhen: 'villageWork:build' }],
    },
    {
      aim: 'find something to eat',
      weight: (food < 3 ? 1.1 : 0.15) * (s.self.food < 14 ? 2 : 1),
      steps: () => [{ text: 'hunt or gather some food', doneWhen: `inventoryHas:food>=${n(3, 6)}` }],
    },
    {
      aim: 'see what is out there',
      weight: 0.3 + 0.8 * p.big5.openness + v('exploration') + 0.3 * v('independence') + 0.3 * v('fun'),
      steps: () => [{ text: 'look around the area', doneWhen: `explored:${n(2, 3)}` }, ...(rng() < 0.5 ? [{ text: 'look for a cave or some ore', doneWhen: 'explored:2' }] : [])],
    },
    {
      aim: stranger ? `get to know ${stranger}` : 'get to know people',
      weight: stranger ? 0.2 + 0.8 * p.big5.extraversion + 0.8 * v('friendship') + 0.3 * v('loyalty') : 0,
      steps: () => (stranger ? [{ text: `talk with ${stranger} and find out what they are up to`, doneWhen: `talkedWith:${stranger}` }] : []),
    },
    {
      aim: social ? social.text : 'help the village',
      weight: social ? villageFirst(s) * (stonePick ? 1.2 : 0.5) : 0,
      steps: () => (social?.work ? [{ text: social.text, doneWhen: `villageWork:${social.work}` }] : []),
    },
    {
      aim: 'stock up on stone',
      weight: pick ? 0.25 + 0.5 * v('hard work') + 0.2 * p.big5.conscientiousness : 0,
      steps: () => {
        const k = n(12, 32);
        return [{ text: `mine ${k} cobblestone`, doneWhen: `inventoryHas:cobblestone>=${k}` }];
      },
    },
    {
      aim: 'get iron tools',
      weight: stonePick && !ironPick ? 0.2 + 0.6 * p.temperament.ambition + 0.4 * v('success') : 0,
      steps: () => [
        { text: 'build a furnace', doneWhen: 'inventoryHas:furnace>=1' },
        { text: 'make an iron pickaxe', doneWhen: 'inventoryHas:iron_pickaxe>=1' },
      ],
    },
    {
      aim: life ?? 'take it easy for a while',
      weight: stonePick && food >= 2 && life ? 0.3 : 0,
      steps: () => (life ? [{ text: `work toward this: ${life}`, doneWhen: `spent:${n(6, 10)}` }] : []),
    },
  ].filter((a) => a.weight > 0);
  const draw = (from: Aim[]): Aim | null => {
    const total = from.reduce((a, x) => a + x.weight, 0);
    let r = rng() * total;
    for (const a of from) {
      r -= a.weight;
      if (r <= 0) return a;
    }
    return from.at(-1) ?? null;
  };
  const first = draw(aims);
  if (!first) return null;
  const steps = first.steps();
  if (steps.length === 0) return null;
  // Now and then, something else after it.
  const second = rng() < 0.4 ? draw(aims.filter((a) => a !== first)) : null;
  const more = second?.steps()[0];
  if (more && steps.length < 5) steps.push(more);
  return { aim: first.aim, steps, why: 'what I need and feel like doing now' };
}

/** A step's doneWhen as code can check it; one it can't gets time on it instead. */
export function checkableStep(s: AgentState, step: { text: string; doneWhen?: string }): PlanStep {
  const d = step.doneWhen?.trim();
  return { text: step.text, doneWhen: d && evalCondition(d, s) !== null ? d : `spent:${OPEN_STEP_MIN}`, status: 'todo' };
}

let seq = 0;

export interface GoalGenOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: string;
  setGoal: (text: string, doneWhen?: string) => void;
  memories?: (k: number) => Promise<string[]>;
  /** Lines about the agent's own life worth weighing (§19.5: a young child to teach and protect). */
  hints?: () => readonly string[];
  rng?: () => number;
  now?: () => number;
}

export class GoalGen {
  private timer: NodeJS.Timeout | null = null;
  /** Runs asked for soon (goal done, starting): cleared on stop, so none fires into a stopped agent. */
  private readonly soonTimers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private readonly rng: () => number;
  private readonly now: () => number;
  private lastRefine = -Infinity;

  constructor(private readonly o: GoalGenOptions) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('goalDone', (e) => this.stepDone(e.goal.text)));
    this.offs.push(this.o.bus.on('conversationEnded', (e) => this.afterTalk(e.convId)));
    this.offs.push(this.o.bus.on('peerDied', (e) => this.forget(e.name)));
    this.scheduleNext();
    if (!this.o.store.state.goals.current) this.soon('starting', 1500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.soonTimers) clearTimeout(t);
    this.soonTimers.clear();
    for (const off of this.offs.splice(0)) off();
  }

  private kick(reason: string, job: () => Promise<void> = () => this.run(reason)): void {
    this.flight.run('goal', job).catch((err: unknown) => this.o.logger.warn({ module: 'goal', err: String(err) }, 'planning failed'));
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    const cadence = ladder(this.o.store.state.flags.degrade).cadence('goal');
    const ms = (180_000 + this.rng() * 120_000) * cadence;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick('periodic');
      this.scheduleNext();
    }, ms);
    this.timer.unref();
  }

  soon(reason: string, ms: number): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.soonTimers.delete(t);
      this.kick(reason);
    }, ms);
    t.unref();
    this.soonTimers.add(t);
  }

  /** The current goal is done: if it was the plan's step at hand, on to the next one; a finished plan makes a new one. */
  private stepDone(text: string): void {
    const plan = this.o.store.state.goals.plan;
    const step = currentStep(plan);
    if (!plan || !step || step.status !== 'doing' || step.text !== text) {
      this.soon('goal done', 2000);
      return;
    }
    const next = advancePlan(plan, 'done', this.now());
    this.install(next, `step done: ${text}`);
    if (planFinished(next)) this.soon('plan finished', 2000);
  }

  /** Someone died: a step of talking with them can't be done any more, and is dropped (one hung on for 25 minutes). */
  private forget(name: string): void {
    const plan = this.o.store.state.goals.plan;
    if (!plan) return;
    const about = (st: PlanStep) => (st.status === 'todo' || st.status === 'doing') && st.doneWhen?.toLowerCase() === `talkedwith:${name.toLowerCase()}`;
    if (!plan.steps.some(about)) return;
    const cur = currentStep(plan);
    let next: Plan = { ...plan, steps: plan.steps.map((st) => (about(st) && st !== cur ? { ...st, status: 'dropped' as const } : st)) };
    if (cur && about(cur)) next = advancePlan(next, 'dropped', this.now());
    this.o.logger.info({ module: 'goal', who: name }, 'dropped what was about someone who died');
    this.install(next, `${name} died`);
    if (planFinished(next)) this.soon('plan finished', 2000);
  }

  /** Puts the plan in place and makes its step at hand the current goal. */
  install(plan: Plan, reason: string): void {
    const p = beginNext(plan, this.now());
    this.o.store.update('goals', (g) => ({ ...g, plan: p }), `plan: ${reason}`);
    const step = currentStep(p);
    const cur = this.o.store.state.goals.current;
    if (step && (cur?.text !== step.text || cur.doneWhen !== step.doneWhen)) this.o.setGoal(step.text, step.doneWhen);
  }

  /** The plan with its steps' doneWhens made checkable (one code can't check gets time on it). */
  checked(plan: Plan): Plan {
    const s = this.o.store.state;
    return { ...plan, steps: plan.steps.map((x) => ({ ...checkableStep(s, x), status: x.status })) };
  }

  /** A plan from a draft (the model's or the code default's), its steps made checkable. */
  private fromDraft(d: PlanDraft, source: Plan['source'], discussedWith: readonly string[] = []): Plan {
    const now = this.now();
    const s = this.o.store.state;
    return {
      id: `p${now.toString(36)}${(seq++).toString(36)}`,
      aim: d.aim,
      steps: d.steps.map((x) => checkableStep(s, x)),
      createdAt: now,
      updatedAt: now,
      ...(d.why ? { why: d.why } : {}),
      discussedWith: [...discussedWith],
      source,
    };
  }

  /** What the planning prompts tell the model about the agent's world and the people in it. */
  private async context(reason: string): Promise<string[]> {
    const s = this.o.store.state;
    const memories = (await this.o.memories?.(5).catch(() => [])) ?? [];
    const inv = s.self.inventory.map((x) => `${x.qty} ${x.item}`).join(', ') || 'nothing';
    const people = Object.values(s.social)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 6)
      .map((p) => `${p.name} (you feel ${Math.round(p.sentiment)}/10${p.perceivedGoals[0] ? `; seems to want ${p.perceivedGoals[0]}` : ''})`);
    const near = s.perception.nearbyEntities;
    const seen = [
      ...near.filter((e) => e.kind === 'player').map((e) => `${e.name} ${Math.round(e.distance)} m away`),
      ...[...new Set(near.filter((e) => e.kind === 'passive').map((e) => e.name))].slice(0, 4),
      ...[...new Set(near.filter((e) => e.kind === 'hostile').map((e) => `a ${e.name}`))].slice(0, 3),
      ...[...new Set(s.perception.nearbyBlocksOfInterest.map((b) => b.name))].slice(0, 6),
    ];
    const village = s.goals.social.filter((g) => g.status === 'active').map((g) => `${g.text}${g.work ? ` (doneWhen villageWork:${g.work})` : ''}`);
    // §18.3 idolization: the agent imitates someone it admires.
    const idols = Object.values(s.social)
      .filter((p) => p.admiration > 0.75)
      .slice(0, 2)
      .map((p) => `You admire ${p.name}${p.perceivedRole ? `, a ${p.perceivedRole}` : ''}${p.perceivedGoals[0] ? `; they seem to want ${p.perceivedGoals[0]}` : ''}. You'd like to be more like them.`);
    const failed = s.actionLog.filter((a) => !a.ok).slice(-3).map((a) => `${a.skill} ${JSON.stringify(a.args)} (${a.error ?? a.observed})`);
    const history = s.goals.history.slice(-5).map((g) => `${g.text} (${g.status})`);
    return [
      `Why now: ${reason}.`,
      `About you: ${s.selfSummary || 'nothing notable yet.'}`,
      `You: health ${Math.round(s.self.health)}/20, food ${s.self.food}/20. It is ${dayPart(s.self.time, s.self.isDay)}. Carrying: ${inv}.`,
      seen.length > 0 ? `Around you: ${seen.join(', ')}.` : 'Nobody and nothing special around you.',
      s.goals.plan ? `Your plan now: ${describePlan(s.goals.plan)}` : 'You have no plan yet.',
      history.length > 0 ? `Recent goals: ${history.join('; ')}` : '',
      failed.length > 0 ? `What didn't work lately: ${failed.join('; ')}` : '',
      `People you know: ${people.join(', ') || 'nobody yet'}`,
      s.goals.community ? `Everyone here hopes to ${s.goals.community}.` : '',
      village.length > 0 ? `Your part in the village: ${village.join('; ')}. A step for the village can use its doneWhen.` : '',
      ...idols,
      ...(this.o.hints?.() ?? []),
      memories.length > 0 ? `You remember:\n${memories.map((m) => `- ${m}`).join('\n')}` : '',
    ].filter(Boolean);
  }

  /** Asks the model for a plan (or whether to keep the one we have). Null: no answer (no model, failed, stale). */
  private async ask(tier: 'L2' | 'L3', task: string, lines: readonly string[]): Promise<PlanOutput | null> {
    const s = this.o.store.state;
    if (!this.o.llm || s.flags.codeOnly || !ladder(s.flags.degrade).enabled('goal')) return null;
    const guard = this.o.store.guard(SLOW_POLICY);
    try {
      const r = await this.o.llm.call<PlanOutput>({
        tier,
        module: 'goal',
        agent: this.o.me,
        schema: PlanOutputSchema,
        schemaName: 'plan',
        formatInPrompt: true,
        prepare: tidyPlan,
        fallback: (): PlanOutput => ({ keep: true }),
        signal: guard.signal,
        isStale: guard.isStale,
        messages: [
          { role: 'system', content: `${personaCore(s.self.persona, s.traitAnnotations)}\n${DEATH_RULE}\n\n${task}\n${PLAN_FORMAT}` },
          { role: 'user', content: lines.join('\n') },
        ],
      });
      return r.ok ? r.value : null;
    } finally {
      guard.dispose();
    }
  }

  async run(reason: string): Promise<void> {
    const s = this.o.store.state;
    if (this.stopped || s.flags.inDanger || isOff(s, 'goalGen')) return;
    const plan = s.goals.plan ?? null;
    const step = currentStep(plan);
    const cur = s.goals.current;
    // A goal set from outside the plan (the operator, a test) is left alone until it is done or stale.
    const foreign = cur !== null && step?.text !== cur.text;
    // §18.4 sunk cost: the more one is given to it, the longer an unfinished step is held on to (up to ×1.5).
    const holdOn = 1 + 0.5 * s.self.persona.mind.biasProfile.sunkCost;
    const stale = cur !== null && this.now() - cur.createdAt > STALE_GOAL_MS * holdOn;
    if (foreign && !stale) return;
    const fresh = !plan || planFinished(plan);
    const out = await this.ask(
      'L3',
      `Make your own plan for the next half hour or so: what you want to get done, as 2–6 concrete steps, your way. Think about what you have and see around you, the time of day, how you feel, what the others are doing and what you have talked over with them. Don't just do things in the usual order; do what fits you.${fresh ? '' : ' If your current plan is still right, answer {"keep": true}.'}`,
      await this.context(reason),
    );
    if (this.stopped) return;
    if (out && !out.keep && out.plan) {
      const p = this.fromDraft(out.plan, 'llm', this.o.store.state.goals.plan?.discussedWith ?? []);
      this.o.logger.info({ module: 'goal', reason, plan: describePlan(p), why: out.plan.why }, 'new plan');
      this.install(p, reason);
      return;
    }
    if (!fresh && plan) {
      // A goal from outside that went stale gives way to the plan's step at hand.
      if (foreign) {
        this.install(plan, 'back to the plan');
        return;
      }
      // The plan stands; only a step gone stale with no word from a model is given up.
      if (!stale || out) return;
      const next = advancePlan(plan, 'dropped', this.now());
      this.o.logger.info({ module: 'goal', reason, dropped: step?.text }, 'gave up a step');
      if (!planFinished(next)) {
        this.install(next, 'step given up');
        return;
      }
    }
    const now = this.o.store.state;
    const draft = codePlan({ ...now, goals: { ...now.goals, plan: null } }, this.rng);
    if (!draft) return;
    const p = this.fromDraft(draft, 'default');
    this.o.logger.info({ module: 'goal', reason, plan: describePlan(p) }, 'new plan');
    this.install(p, reason);
  }

  /**
   * §6.2, planning together: after a talk, what was said is weighed into the plan (an agreement on who does what, a
   * better idea, something asked of us we said yes to, news). Only with a model; at most every REFINE_EVERY_MS.
   */
  private afterTalk(convId: string): void {
    const s = this.o.store.state;
    const conv = s.conversations[convId];
    if (!conv || !this.o.llm || s.flags.codeOnly || isOff(s, 'goalGen') || this.now() - this.lastRefine < REFINE_EVERY_MS) return;
    const others = conv.participants.filter((p) => p !== this.o.me);
    const theirs = conv.transcript.filter((u) => u.from !== this.o.me);
    const mine = conv.transcript.filter((u) => u.from === this.o.me);
    if (others.length === 0 || theirs.length === 0 || mine.length === 0) return;
    this.lastRefine = this.now();
    this.kick('after a talk', async () => {
      const lines = conv.transcript.slice(-12).map((u) => `${u.from === this.o.me ? 'You' : u.from}: ${u.text}`);
      const out = await this.ask(
        'L2',
        `You just talked with ${others.join(' and ')}. Decide whether what was said changes your plan: an agreement on who does what, something you said you would do, a better idea, news about something. It is your plan: change it only if it should change, and keep what was agreed. If nothing said bears on it, answer {"keep": true}.`,
        [...(await this.context(`you just talked with ${others.join(' and ')}`)), `What was said:\n${lines.join('\n')}`],
      );
      if (this.stopped) return;
      const plan = this.o.store.state.goals.plan;
      const withThem = [...new Set([...(plan?.discussedWith ?? []), ...others])];
      if (out && !out.keep && out.plan) {
        const p = this.fromDraft(out.plan, 'llm', withThem);
        this.o.logger.info({ module: 'goal', with: others, plan: describePlan(p), why: out.plan.why }, 'plan changed after a talk');
        this.install(p, `talked it over with ${others.join(', ')}`);
      } else if (plan) {
        this.o.store.update('goals', (g) => (g.plan ? { ...g, plan: { ...g.plan, discussedWith: withThem } } : g), 'plan talked over');
      }
    });
  }
}
