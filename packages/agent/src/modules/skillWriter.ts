// The skill writer (§1.4, §4 module 12, §9, §21.1; M10, L3). When the CC reaches for a skill there is none of
// ("build_marker_row"), an agent clever enough (intelligence 0.7 and up, by default) on a private server, with the
// writer turned on, writes one: a few lines of JavaScript built from its verified skills, with a check of what will be
// true once it has worked. It tries the draft out at once, in the world (the trial is an option like any other, and
// the runner checks the result against the check, as it does for every skill). A draft that did what it said is kept
// and offered to the CC from then on; one that didn't is written again with what went wrong, at most `attempts`
// times. Every model call has its tier, timeout, fallback, abort signal, state-version check, schema and cost log.

import type { AgentName, Logger, WorldConfig } from '@agora/shared';
import { type LlmClient, SingleFlight, ladder } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { getSkill } from '../body/skills/registry';
import { CALLABLE, type SkillDraft, SkillDraftSchema, type SkillLibrary, lintDraft, parseArgs } from '../skills/learned';
import { loadSandbox } from '../skills/sandbox';
import { SLOW_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import { personaCore } from './prompts';
import { isOff } from '../state/switches';

const ReplySchema = z.object({ skill: SkillDraftSchema.nullable() });
type Reply = z.infer<typeof ReplySchema>;

/** A name we gave up on isn't tried again for this long. */
const GIVE_UP_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** A trial cut short this often (something more pressing came up each time) is given up on. */
const MAX_CUT = 3;
/** A trial that hasn't run this long after its run would have ended is set aside. */
const TRIAL_GRACE_SEC = 90;

export interface SkillWriterOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: AgentName;
  config: WorldConfig['skillWriter'];
  /** server.host is on loopback or a private network, or the owner said the server is private. */
  privateServer: boolean;
  intelligence: number;
  library: SkillLibrary;
  /** Puts a draft on trial: runs it now, as the agent's next option. False if it couldn't be started. */
  tryOut: (skill: string, args: Record<string, unknown>, why: string) => boolean;
  /** An embedding of the description, to find the skill again when it is wanted (§1.4). */
  embed?: (text: string) => Promise<Float32Array | null>;
  now?: () => number;
}

interface Trial {
  draft: SkillDraft;
  args: Record<string, unknown>;
  why: string;
  tries: number;
  /** What went wrong before, told to the next try. */
  history: string[];
  /** Times its trial was cut short (not the code's doing). */
  cut: number;
}

export class SkillWriter {
  private trial: Trial | null = null;
  private trialTimer: ReturnType<typeof setTimeout> | null = null;
  /** Drafts whose trial was cut short or couldn't start: tried again, as written, when next wanted. */
  private readonly shelved = new Map<string, Trial>();
  private readonly written: number[] = [];
  private readonly gaveUp = new Map<string, number>();
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private toldOff = false;
  private readonly now: () => number;

  constructor(private readonly o: SkillWriterOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('skillWanted', (e) => this.wish(e.name, e.args, e.why)));
    this.offs.push(
      this.o.bus.on('actionRecorded', (e) => {
        const r = e.record;
        if (this.trial && r.skill === this.trial.draft.name) return void this.judge(r.ok, r.observed, r.error);
        if (this.o.library.get(r.skill)?.verified) this.o.library.used(r.skill, r.ok);
      }),
    );
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.trialTimer) clearTimeout(this.trialTimer);
    this.trialTimer = null;
  }

  /** The draft on trial, for the executor to run by name. */
  onTrial(): SkillDraft | null {
    return this.trial?.draft ?? null;
  }

  /** Why no skill is written here, or null when one may be. */
  async whyOff(): Promise<string | null> {
    const c = this.o.config;
    if (!c.enabled) return 'the skill writer is off (skillWriter.enabled)';
    if (isOff(this.o.store.state, 'skillWriter')) return 'the skill writer is switched off for this agent';
    if (!this.o.privateServer) return 'skills are only written on a private server';
    if (this.o.intelligence < c.minIntelligence) return 'not clever enough to write skills';
    if (!this.o.llm) return 'no model to write with';
    if (!(await loadSandbox())) return 'the sandbox (isolated-vm) is not installed';
    return null;
  }

  wish(name: string, args: Record<string, unknown>, why: string): void {
    this.flight.run('write', () => this.begin(name, args, why)).catch((err: unknown) => this.o.logger.warn({ module: 'skillWriter', err: String(err) }, 'writing a skill failed'));
  }

  private async begin(name: string, args: Record<string, unknown>, why: string): Promise<void> {
    const t = this.now();
    if (this.trial || getSkill(name) || this.o.library.get(name)?.verified) return;
    if (t - (this.gaveUp.get(name) ?? -Infinity) < GIVE_UP_MS) return;
    const off = await this.whyOff();
    const waiting = this.shelved.get(name);
    if (waiting && !off) {
      this.shelved.delete(name);
      return this.putOnTrial({ ...waiting, args, why });
    }
    if (off) {
      if (!this.toldOff) this.o.logger.info({ module: 'skillWriter', wanted: name, why: off }, 'no skill written');
      this.toldOff = true;
      return;
    }
    while (this.written.length > 0 && t - (this.written[0] ?? t) > HOUR_MS) this.written.shift();
    if (this.written.length >= this.o.config.perHour) return;
    this.written.push(t);
    await this.write({ draft: { name, description: '', args: {}, check: '', code: '' }, args, why, tries: 0, history: [], cut: 0 });
  }

  /** One try: a draft from the model, checked in code, then put on trial (or tried again, told why). */
  private async write(tr: Trial): Promise<void> {
    const s = this.o.store.state;
    const llm = this.o.llm;
    if (!llm || s.flags.codeOnly || !ladder(s.flags.degrade).enabled('skillWriter')) return;
    const guard = this.o.store.guard(SLOW_POLICY);
    let draft: SkillDraft | null;
    try {
      const r = await llm.call<Reply>({
        tier: 'L3',
        module: 'skillWriter',
        agent: this.o.me,
        schema: ReplySchema,
        schemaName: 'skill',
        fallback: (): Reply => ({ skill: null }),
        signal: guard.signal,
        isStale: guard.isStale,
        messages: [
          { role: 'system', content: `${personaCore(s.self.persona, s.traitAnnotations)}\n\n${WRITER_RULES}\n\nSkills you can use in it:\n${callableCatalog()}` },
          { role: 'user', content: this.ask(tr) },
        ],
      });
      // No model to be had just now (budget, an outage, the state moved on): not a verdict on the skill.
      if (!r.ok) {
        if (r.reason !== 'stale') this.o.logger.info({ module: 'skillWriter', wanted: tr.draft.name, reason: r.reason }, 'no draft written');
        return;
      }
      draft = r.value.skill;
    } finally {
      guard.dispose();
    }
    const tries = tr.tries + 1;
    const wanted = tr.draft.name || draft?.name || '';
    if (!draft) return this.giveUp(wanted, 'it cannot be done with the skills there are');
    // It is the skill that was wanted: the CC asked for it by that name.
    draft = { ...draft, name: wanted || draft.name };
    const fit = parseArgs(draft.args, tr.args);
    const lint = lintDraft(draft) ?? (fit.ok ? null : `it must take the arguments it was reached for with, ${JSON.stringify(tr.args)} (${fit.error})`);
    if (lint) {
      this.o.logger.info({ module: 'skillWriter', skill: draft.name, try: tries, why: lint }, 'draft refused');
      if (tries >= this.o.config.attempts) return this.giveUp(draft.name, lint);
      return this.write({ ...tr, draft, tries, history: [...tr.history, `Your last draft was refused: ${lint}.`] });
    }
    this.putOnTrial({ ...tr, draft, tries });
  }

  /** Runs a draft for real, now; set aside to be tried when next wanted if it can't start (we're in danger, say). */
  private putOnTrial(tr: Trial): void {
    const d = tr.draft;
    this.trial = tr;
    this.o.logger.info({ module: 'skillWriter', skill: d.name, try: tr.tries, check: d.check }, 'trying out a skill');
    if (!this.o.tryOut(d.name, tr.args, tr.why)) {
      this.trial = null;
      this.shelve(tr, 'it could not start');
      return;
    }
    this.trialTimer = setTimeout(
      () => {
        this.trialTimer = null;
        if (this.trial !== tr) return;
        this.trial = null;
        this.shelve(tr, 'it never ran');
      },
      (this.o.config.wallSec + TRIAL_GRACE_SEC) * 1000,
    );
    this.trialTimer.unref();
  }

  private shelve(tr: Trial, why: string): void {
    const cut = tr.cut + 1;
    if (cut >= MAX_CUT) return this.giveUp(tr.draft.name, `its trial was cut short ${cut} times (${why})`);
    this.shelved.set(tr.draft.name, { ...tr, cut });
    this.o.logger.info({ module: 'skillWriter', skill: tr.draft.name, why }, 'trial set aside');
  }

  /** The trial's result: kept if it did what its check said; otherwise another try, told what went wrong. */
  private judge(ok: boolean, observed: string, error?: string): void {
    const tr = this.trial;
    if (!tr) return;
    this.trial = null;
    if (this.trialTimer) clearTimeout(this.trialTimer);
    this.trialTimer = null;
    const d = tr.draft;
    // Cut short by something more pressing: not the code's doing, so no try is spent.
    if (!ok && observed.startsWith('interrupted')) return this.shelve(tr, 'interrupted');
    if (ok) {
      void this.keep(d, tr);
      return;
    }
    const what = `It ran and ${observed}${error ? ` (${error})` : ''}; the check ${d.check} did not hold.`;
    this.o.logger.info({ module: 'skillWriter', skill: d.name, try: tr.tries, observed, error }, 'trial failed');
    if (tr.tries >= this.o.config.attempts) return this.giveUp(d.name, what);
    this.flight.run('write', () => this.write({ ...tr, history: [...tr.history, `Your last try:\n${d.code}\n${what}`] })).catch(() => undefined);
  }

  private async keep(d: SkillDraft, tr: Trial): Promise<void> {
    const t = this.now();
    const embedding = (await this.o.embed?.(`${d.name.replace(/_/g, ' ')}: ${d.description}`).catch(() => null)) ?? null;
    this.o.library.save(d, t, embedding, t);
    this.o.library.used(d.name, true);
    pushWorkmem(this.o.store, `I worked out a new skill: ${d.name} (${d.description})`, 0.7, 'self_observed', { now: t });
    this.o.logger.info({ module: 'skillWriter', skill: d.name, tries: tr.tries, check: d.check }, 'skill learned');
    this.o.bus.emit({ type: 'skillLearned', name: d.name, description: d.description });
  }

  private giveUp(name: string, why: string): void {
    this.gaveUp.set(name, this.now());
    this.o.logger.info({ module: 'skillWriter', skill: name, why }, 'gave up on a skill');
  }

  private ask(tr: Trial): string {
    const s = this.o.store.state;
    const inv = s.self.inventory.map((i) => `${i.qty} ${i.item}`).join(', ') || 'nothing';
    const p = s.self.pos;
    return [
      `You wanted to: ${tr.why || 'do something there is no skill for yet'}.`,
      `The skill you reached for: ${tr.draft.name || '(no name)'} with arguments ${JSON.stringify(tr.args)}.`,
      `You are at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}, carrying ${inv}.`,
      ...tr.history,
      'Write it.',
    ].join('\n');
  }
}

/** The verified skills a written one may use, as the CC knows them. */
function callableCatalog(): string {
  return [...CALLABLE]
    .map((n) => getSkill(n)?.description)
    .filter((d): d is string => Boolean(d))
    .map((d) => `- ${d}`)
    .join('\n');
}

export const WRITER_RULES = `Write a new skill for yourself in JavaScript, built from the skills you already have.
- The code is the body of: async function (args, api) { ... }. args holds the arguments you declare.
- await api.skill("name", { ...args }) runs one of your skills and resolves to { ok, observed, error }. Check ok.
- api.look() returns { pos: {x,y,z}, inventory: { item: count }, health, food, isDay }. api.log(text) notes something.
- Nothing else is there: no require, no process, no timers, no network, no files.
- Return { ok: true|false, observed: "what happened" }.
- check says what will be true once it has worked, so it can be verified: inventoryHas:<item>>=<n>, blockAt:<x>,<y>,<z>=<block> or near:<x>,<y>,<z>. Use {arg} for an argument, e.g. inventoryHas:torch>={qty}.
- Keep it short and plain. It runs in the world, for real.
JSON: {"skill": {"name": "snake_case_name", "description": "what it does, in a few words", "args": {"x": "number"}, "check": "...", "code": "..."}}, or {"skill": null} if it can't be done with these skills.`;
