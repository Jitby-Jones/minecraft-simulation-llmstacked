// Tidying a model's decision before validation (§4.3). Models fill in fields they have nothing for: "" or "none" for a
// name, {"x":0,"y":0,"z":0} for a place, a fight or a romance beside an option that has nothing to do with either.
// Those parts are taken out, and what remains is judged as the decision the model meant. Nothing is invented here:
// only empty or placeholder parts go, and a missing time limit gets the option's usual one.

import { OPTIONS } from '@agora/shared';

/** What a model writes into a field it has nothing for. */
const PLACEHOLDER = /^\s*(none|nobody|no ?one|nothing|null|undefined|n\/?a|tbd|unknown|name|someone|anyone|self|myself|yourself|-+|\.{2,}|…|\?+)?\s*$/i;

/** How long an option runs when the model gave no usable time limit. */
const DEFAULT_SECONDS: Readonly<Record<string, number>> = { work: 300, help: 300, talk: 90, move: 60, follow: 60, explore: 120, rest: 30, flee: 30, fight: 90, court: 60 };

/** Options that run a task of their own; for the others a task naming no skill there is is a slip, dropped. */
const TASK_OPTIONS: ReadonlySet<string> = new Set(['work', 'help', 'fight', 'court']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const named = (v: unknown, me: string): v is string => typeof v === 'string' && !PLACEHOLDER.test(v) && v.toLowerCase() !== me.toLowerCase();
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && PLACEHOLDER.test(v));

export interface TidyEnv {
  me: string;
  /** A skill by that name exists (built in, or one the agent wrote). */
  isSkill: (name: string) => boolean;
}

/** The decision with its empty and placeholder parts taken out (the JSON as parsed; validation comes after). */
export function tidyDecision(raw: unknown, env: TidyEnv): unknown {
  if (!isObj(raw)) return raw;
  const d: Obj = { ...raw };
  // An option named by its skill ("gather") is work with that skill.
  if (typeof d.option === 'string' && !(OPTIONS as readonly string[]).includes(d.option)) {
    const opt = d.option.trim().toLowerCase();
    if ((OPTIONS as readonly string[]).includes(opt)) d.option = opt;
    else if (env.isSkill(d.option) && !isObj(d.task)) {
      d.task = { skill: d.option, args: {} };
      d.option = 'work';
    }
  }
  const option = typeof d.option === 'string' ? d.option : '';
  for (const k of Object.keys(d)) if (d[k] === null) delete d[k];

  if (isObj(d.target)) {
    const t: Obj = { ...d.target };
    if (!named(t.agent, env.me)) delete t.agent;
    if (blank(t.item)) delete t.item;
    const p = t.pos;
    if (!isObj(p) || ![p.x, p.y, p.z].every((n) => typeof n === 'number' || (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n)))) || [p.x, p.y, p.z].every((n) => Number(n) === 0)) delete t.pos;
    if (Object.keys(t).length > 0) d.target = t;
    else delete d.target;
  } else delete d.target;

  if (isObj(d.task)) {
    const skill = d.task.skill;
    if (blank(skill) || typeof skill !== 'string' || (!TASK_OPTIONS.has(option) && !env.isSkill(skill))) delete d.task;
    else d.task = { skill, args: isObj(d.task.args) ? d.task.args : {} };
  } else delete d.task;

  // Whom or where an option is about, given only in its task's args ({"option": "move", "task": {"skill": "goTo",
  // "args": {"x": 4, "y": 70, "z": -2}}}): the target it meant.
  const args = isObj(d.task) && isObj(d.task.args) ? d.task.args : null;
  const target: Obj = isObj(d.target) ? { ...d.target } : {};
  if (args && !TASK_OPTIONS.has(option) && !target.agent && !target.pos) {
    const who = [args.agent, args.to, args.target, args.with].find((v) => named(v, env.me));
    const at = [args.x, args.y, args.z].map(Number);
    if (who) target.agent = who;
    else if (option === 'move' && at.every((n) => Number.isFinite(n)) && !at.every((n) => n === 0)) target.pos = { x: at[0], y: at[1], z: at[2] };
    if (Object.keys(target).length > 0) d.target = target;
  }

  const stance = isObj(d.speechIntent) && typeof d.speechIntent.stance === 'string' ? d.speechIntent.stance : 'none';
  if (isObj(d.speechIntent)) {
    const s = d.speechIntent;
    const gist = typeof s.gist === 'string' ? s.gist.trim() : '';
    if (blank(s.stance) || (s.stance === 'none' && !gist)) delete d.speechIntent;
    else d.speechIntent = { ...s, gist, mayCommit: s.mayCommit === true };
  } else delete d.speechIntent;

  if (Array.isArray(d.commitmentsToCreate)) {
    const kept = d.commitmentsToCreate.filter((c) => isObj(c) && !blank(c.creditor) && !blank(c.debtor) && isObj(c.what) && !blank(c.what.text) && !blank(c.what.kind));
    if (kept.length > 0) d.commitmentsToCreate = kept;
    else delete d.commitmentsToCreate;
  } else delete d.commitmentsToCreate;

  if (isObj(d.trade)) {
    const t = d.trade;
    const empty = (!Array.isArray(t.give) || t.give.length === 0) && (!Array.isArray(t.want) || t.want.length === 0);
    const about = option === 'trade' || ['negotiate', 'agree', 'decline'].includes(stance);
    if (!named(t.with, env.me) || !about || (t.phase === 'offer' && empty)) delete d.trade;
  } else delete d.trade;

  if (isObj(d.fight)) {
    if (option !== 'fight' || !named(d.fight.target, env.me)) delete d.fight;
    else if (!Array.isArray(d.fight.withAllies)) d.fight = { ...d.fight, withAllies: [] };
  } else delete d.fight;

  if (isObj(d.romance)) {
    const r = d.romance;
    const about = option === 'court' || ['flirt', 'propose', 'agree', 'decline', 'hostile'].includes(stance);
    if (!named(r.with, env.me) || !about) delete d.romance;
    else if (blank(r.reaction)) {
      const { reaction: _r, ...rest } = r;
      d.romance = rest;
    }
  } else delete d.romance;

  if (isObj(d.family)) {
    const f = d.family;
    const fits: Readonly<Record<string, readonly string[]>> = { propose: ['propose', 'ask'], accept: ['agree'], decline: ['decline'], warn: ['inform'] };
    if (!named(f.with, env.me) || typeof f.phase !== 'string' || !(fits[f.phase] ?? []).includes(stance)) delete d.family;
    else if (blank(f.about)) {
      const { about: _a, ...rest } = f;
      d.family = rest;
    }
  } else delete d.family;

  const term = isObj(d.terminate) ? { ...d.terminate } : {};
  const secs = Number(term.maxSeconds);
  term.maxSeconds = Number.isFinite(secs) && secs >= 5 ? Math.min(900, secs) : (DEFAULT_SECONDS[option] ?? 60);
  if (blank(term.until) || typeof term.until !== 'string') delete term.until;
  d.terminate = term;
  if (typeof d.rationale !== 'string') d.rationale = '';
  else d.rationale = d.rationale.slice(0, 400);
  return d;
}
