// Cognitive Controller (§4.2 module 9, §4.3): the one place high-level decisions are made. It sees only the
// bottleneck packet, answers in strict JSON (zod-validated, one repair retry in the client) and broadcasts the
// decision: the executor runs its task, Talking phrases its speech intent. Woken by events (option ended, danger
// cleared, a request needing an answer, a new goal) plus a ≤ 30 s heartbeat when idle; while an option runs, only
// requests wake it (§4.4). Semantically wrong decisions get one retry with the reason, then the code default, which
// also keeps the agent working in code-only mode (§22.4).

import {
  type ActionRecord,
  type AgentName,
  type AgentState,
  type AssignedTask,
  type BlockChange,
  type Commitment,
  type CommitmentDraft,
  type ConvId,
  type Decision,
  type DecisionOutput,
  DecisionOutputSchema,
  type Goal,
  type ItemStack,
  type Logger,
  type SeenEntity,
  type Task,
} from '@agora/shared';
import { type ChatMessage, type LlmClient, SingleFlight } from '@agora/llm';
import type { AgentBus } from '../bus';
import { itemMatcher } from '../body/items';
import { complies, spareChance, yieldHealth } from '../conflict/pressure';
import { type Demand, demandFor, joinsRally, parseDemand, parseRally } from '../conflict/coercion';
import { type Offer, amountOf, judgeOffer, parseHelpRequest, parseTradeOffer, stacksText } from '../social/trades';
import { opinionLine, readOpinionAsk, statedOpinion } from '../social/opinions';
import { getSkill, skillCatalog } from '../body/skills/registry';
import type { AnySkill } from '../body/skills/types';
import { CC_POLICY, CC_UNDER_FIRE_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import type { ActionAwareness } from './awareness';
import { taskKey } from './awareness';
import { buildPacket } from './bottleneck';
import { evalCondition, held } from './conditions';
import { EXPLORE_ARGS, type SkillExecutor } from './executor';
import type { MindLevers } from './levers';
import { CHOICES, DEATH_RULE, DECISION_FORMAT, EXPERIENCE, THINKING, UNDER_FIRE_FORMAT, UNDER_FIRE_THINKING, personaCore } from './prompts';
import { URGENT_STRENGTH } from '../mind/expectations';
import { cueFrom } from '../mind/later';
import { addLesson, matchTask } from '../mind/learning';
import { tidyDecision } from './decisionTidy';
import { CHANGE_MS, describeChange } from '../perception/surroundings';
import { routeItemTask } from './itemTasks';
import { villageWorkOf, whyNoChest } from '../social/village';
import { deathNoticeMove, foodMove, hungerMove, hurtMove, villageMove } from './villageMove';
import { isOff } from '../state/switches';
import { planFinished } from './plan';
import { type PowerMoveCtx, type PowerView, escortMove, gossipMove, rallyMove, uprisingMove } from './powerMove';
import { ACCEPTANCE, DECLINE_LINES, FLIRT_BACK, GIFT_LINE, PROPOSAL, PROPOSE_RE, type RomanceView, isAdvance } from '../social/romanceWatch';
import { FAMILY_HAPPY, FAMILY_NOT_YET, FAMILY_PROPOSAL, FAMILY_YES, type FamilyStep, type FamilyView, isFamilyAsk, isFamilyYes } from '../social/familyWatch';

export interface DecideContext {
  /** A request from someone that needs an answer (wakes the CC even mid-option). */
  convId?: ConvId;
  from?: AgentName;
  urgent?: boolean;
  /** Things just got worse with this person (a rung went up, §17.5): the conflict moves apply even mid-task. */
  atOdds?: AgentName;
  /** §17.8: one we resent is alone or hurt, with others who resent them too: the call to rise comes first, mid-task too. */
  opening?: AgentName;
  /** A block of ours around us changed just now (a wall of the shelter we are in broken, a hut's door): seen to mid-task too. */
  change?: BlockChange;
  /** §17.7: we have just begun to follow this person: a stroll begun before gives way to their side. */
  leader?: AgentName;
  /** In danger: thought about at once, and what is chosen is done at once (owner request, 2026-10-24: think, don't
   *  follow directives; a player in a fight still thinks: eats, runs somewhere, digs through, turns and fights). */
  emergency?: boolean;
}

export interface ValidationEnv {
  me: AgentName;
  isStuck: (skill: string, args: Record<string, unknown>) => boolean;
  /** M10: a skill the agent wrote for itself (verified, or on trial), by name. */
  learnedSkill?: (name: string) => AnySkill | null;
  canPerceive: (name: AgentName) => boolean;
  /** A person (not a mob): fighting them needs the gate. */
  isPerson?: (name: AgentName) => boolean;
  /** §17.5 code gate: null when a fight with them may happen, else why not. */
  mayFight?: (target: AgentName, intent: 'brawl' | 'lethal', joining?: boolean) => string | null;
  /** §19.2, §19.6: null when courting them may happen (not family, not the young, within the soft cap), else why not. */
  mayCourt?: (name: AgentName) => string | null;
  /** §19.3: null when we may ask them to start a family (our partner, and all else in place), else why not. */
  mayStartFamily?: (name: AgentName) => string | null;
  /** The code-only brain decides (no model, §22.4): its own routines (the night's hole) may be used. */
  codeOnly?: boolean;
  /** Null when a move there makes sense (near, or somewhere the agent knows), else why not (a made-up far place). */
  mayGo?: (pos: { x: number; y: number; z: number }) => string | null;
  /** Null when a chest is known at that spot, else why not (a made-up chest). */
  chestThere?: (pos: { x: number; y: number; z: number }) => string | null;
}

/** Health lost since steps were meant that stops them for a thought. */
const HURT_SINCE = 6;

/** How long a try at a thought under fire may take before the next model is tried. */
const UNDER_FIRE_TIMEOUT_MS = 7000;

/** A move farther than this goes only to somewhere the agent knows (home, the chest, a hut, a find). */
export const FAR_MOVE = 160;

/** Null when a move to `pos` makes sense for one in state `s`: near, or within 24 blocks of a place it knows. */
export function whyNotGo(s: AgentState, pos: { x: number; y: number; z: number }): string | null {
  const me = s.self.pos;
  const dist = Math.hypot(pos.x - me.x, pos.z - me.z);
  if (dist <= FAR_MOVE) return null;
  const v = s.village;
  const known = [v.home, v.chest?.pos, v.board, ...v.huts, ...v.finds.map((f) => f.pos)].filter((p): p is NonNullable<typeof p> => Boolean(p));
  if (known.some((k) => Math.hypot(k.x - pos.x, k.z - pos.z) <= 24)) return null;
  const home = v.home ? `; home is at ${Math.round(v.home.x)},${Math.round(v.home.y)},${Math.round(v.home.z)}` : '';
  return `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} is ${Math.round(dist)} blocks away and you know of nothing there: pick a place you can see or one you know${home}`;
}

/** Code checks on a schema-valid decision. Returns the reason it can't be used, or null. */
export function validateDecision(d: DecisionOutput, env: ValidationEnv): string | null {
  if ((d.option === 'work' || d.option === 'help') && !d.task) return `option ${d.option} needs a task (skill + args)`;
  // §17.5: fighting a person happens only through the code gate.
  const aimedAt = d.task?.args.target;
  const victim = d.option === 'fight' ? (d.fight?.target ?? d.target?.agent) : ['attack', 'duel'].includes(getSkill(d.task?.skill ?? '')?.name ?? '') && typeof aimedAt === 'string' ? aimedAt : '';
  if (victim && env.isPerson?.(victim)) {
    const why = env.mayFight ? env.mayFight(victim, d.fight?.intent ?? 'brawl', d.fight?.joining === true) : 'fighting people is not possible here';
    if (why) return `you can't fight ${victim}: ${why}`;
  }
  if (d.option === 'fight' && !victim) return 'option fight needs fight.target';
  if (d.task) {
    const skill = getSkill(d.task.skill) ?? env.learnedSkill?.(d.task.skill) ?? null;
    // A routine of the code's own is no hand of a mind's: as if there were none (the skill writer may write one).
    if (!skill || (skill.codeOnly && !env.codeOnly)) return `there is no skill "${d.task.skill}"`;
    const parsed = skill.parseArgs(d.task.args);
    if (!parsed.ok) return `bad arguments for ${skill.name}: ${parsed.error}`;
    if (env.isStuck(skill.name, d.task.args)) return `you are stuck on ${skill.name} ${JSON.stringify(d.task.args)}; choose something else`;
    // A chest is a thing in the world: one named by its position must be there.
    const a = d.task.args;
    if ((skill.name === 'deposit' || skill.name === 'withdraw') && env.chestThere && [a.x, a.y, a.z].every((n) => Number.isFinite(Number(n)) && n !== undefined && n !== null)) {
      const why = env.chestThere({ x: Number(a.x), y: Number(a.y), z: Number(a.z) });
      if (why) return why;
    }
  }
  if ((d.option === 'talk' || d.option === 'follow' || d.option === 'court') && !d.target?.agent) return `option ${d.option} needs target.agent`;
  // §19.2: courting only whom one may court; a step in romance is with someone, by name.
  const wooed = d.option === 'court' ? d.target?.agent : d.romance && ['flirt', 'return', 'propose'].includes(d.romance.phase) ? d.romance.with : undefined;
  if (wooed && env.mayCourt) {
    const why = env.mayCourt(wooed);
    if (why) return `you can't court ${wooed}: ${why}`;
  }
  // §19.3: asking, or saying yes, only when all is in place from our side (each side checks its own).
  if ((d.family?.phase === 'propose' || d.family?.phase === 'accept') && env.mayStartFamily) {
    const why = env.mayStartFamily(d.family.with);
    if (why) return `you can't ${d.family.phase === 'propose' ? 'ask' : 'agree with'} ${d.family.with} to start a family: ${why}`;
  }
  if (d.option === 'move' && !d.target?.pos && !d.target?.agent) return 'option move needs target.pos or target.agent';
  if (d.option === 'move' && d.target?.pos && env.mayGo) {
    const why = env.mayGo(d.target.pos);
    if (why) return why;
  }
  const who = d.target?.agent;
  if (who && who !== env.me && ['talk', 'follow', 'help', 'trade', 'move', 'demand', 'recruit', 'court'].includes(d.option) && !env.canPerceive(who)) {
    return `you can't see or hear ${who} right now`;
  }
  return null;
}

let seq = 0;
const newId = (p: string, now: number) => `${p}${now.toString(36)}${(seq++).toString(36)}`;

const ORE_LIKE = /ore$|^raw_|^(coal|diamond|emerald|lapis_lazuli|redstone|quartz|ancient_debris)$/;

export interface SocialChance {
  /** People in range this agent may start a conversation with now (pair cooldowns respected). */
  candidates: readonly AgentName[];
  /** Uniform 0..1, compared with persona.social.initiateChance. */
  roll: number;
  /** A place someone claimed holds something, not yet checked (§6.5). */
  claim?: { pos: { x: number; y: number; z: number }; by: AgentName; item: string };
  /** How much we like someone, gut and facts mixed by the override (§18.5); sentiment without it. */
  liking?: (name: AgentName) => number;
  /** The conflict core (§17.5): rungs, fear, the gate, and whom we warned lately. */
  conflict?: ConflictView;
  /** Whether a word names a thing one can have ("give me a sec" asks for no item). */
  isItem?: (word: string) => boolean;
  /** Power structures (§17.7, §17.8): whom we follow, who resents whom, coalitions. */
  power?: PowerView;
  /** Lines already answered (by utterance id): a later reason to decide doesn't answer them again. */
  answered?: ReadonlySet<string>;
  /** Romance (§19.2): whom we're drawn to and how far it has gone, how we take an advance. */
  romance?: RomanceView;
  /** Families (§19.3–19.5): starting one, the bed ritual, children and parents. */
  family?: FamilyView;
  /** The code default is the whole brain (no model, §22.4): it may hide when the gate allows (else that's the model's call). */
  codeOnly?: boolean;
}

export interface ConflictView {
  rungOf: (name: AgentName) => number;
  fearOf: (name: AgentName) => number;
  mayBrawl: (name: AgentName) => boolean;
  /** §17.6 groupAttack: joining a fight a sworn ally is in with them just now is allowed (no pair cooldown). */
  mayJoin?: (name: AgentName) => boolean;
  /** §17.5 rung 4 through the gate: a fight to the death is allowed now. */
  mayKill?: (name: AgentName) => boolean;
  /** How much we resent someone (0..1): mercy toward a yielding foe shrinks with it. */
  resentmentOf?: (name: AgentName) => number;
  /** §18.4 authority bias: how much lower the bar to comply is for a demand from them (a leader or an idol). */
  authorityOf?: (name: AgentName) => number;
  /** §18.4.1 behavioral conformity: most of those they asked paid, so paying comes easier (the pull, × 0.3). */
  bandwagon?: (name: AgentName) => number;
  /** §17.8: fear of someone faced together with these allies. */
  fearWith?: (name: AgentName, allies: readonly AgentName[]) => number;
  /** §17.7 tribute: they gave in to us before, and it's time they paid again. */
  tributeDue?: (name: AgentName) => boolean;
  /** §17.7: we demanded something of them just now, or they are paying it or paid lately: no blows for that. */
  demandPending?: (name: AgentName) => boolean;
  /** §17.7: we have said a demand to them in the last few minutes, since we last fought them (a tyrant asks before he
   *  beats). */
  demandedLately?: (name: AgentName) => boolean;
  warnedLately: (name: AgentName) => boolean;
}

/** "can you give me 8 logs?", "bring me some bread", "I need some wood" → what and how many (default 1). */
export function parseItemRequest(text: string): { item: string; qty: number } | null {
  const m =
    /\b(?:give|bring|lend|spare|get|pass)\s+me\s+(?:some\s+|a\s+few\s+|a\s+couple\s+of\s+|a\s+|an\s+)?(\d{1,3})?\s*([a-z][a-z_]{1,23})/i.exec(text) ??
    /\bi\s+need\s+(?:some|a|an|any)\s+(\d{1,3})?\s*([a-z][a-z_]{1,23})/i.exec(text);
  if (!m?.[2]) return null;
  const word = m[2].toLowerCase();
  if (NOT_ITEMS.has(word)) return null;
  return { item: word.replace(/(ie)?s$/, (x) => (x === 'ies' ? 'y' : '')), qty: m[1] ? Number(m[1]) : 1 };
}

const GENEROUS = /generous|kind|helpful|giving|warm/i;
/** Words that follow "give me" without being things: "give me a sec", "give me a hand". */
const NOT_ITEMS = new Set(['hand', 'minute', 'min', 'moment', 'second', 'sec', 'bit', 'break', 'favor', 'favour', 'chance', 'ride', 'go', 'try', 'shot', 'look', 'clue', 'hint', 'idea', 'reason', 'call', 'lift', 'tour', 'hug', 'kiss', 'answer', 'word', 'promise', 'heads', 'rest', 'space', 'time', 'peace']);
export { amountOf } from '../social/trades';

/** Both halves of a deal as promises: we give `ours`, they give `theirs` (§6.6). */
export function dealDrafts(me: AgentName, other: AgentName, ours: readonly ItemStack[], theirs: readonly ItemStack[]): CommitmentDraft[] {
  const draft = (debtor: AgentName, creditor: AgentName, x: ItemStack): CommitmentDraft => ({
    debtor,
    creditor,
    what: { kind: 'give', item: x.item, qty: x.qty, text: amountOf(x.item, x.qty) },
    dueInSec: DEAL_DUE_SEC,
  });
  return [...ours.map((x) => draft(me, other, x)), ...theirs.map((x) => draft(other, me, x))];
}

/** How long either side has to hand over its half of a deal. */
const DEAL_DUE_SEC = 600;
/** Time of day from which the code default digs in for the night (sunset; monsters come out at about 13000). */
const DUSK = 12_500;
/** Hostile talk toward the same person at most this often. */
const WARN_EVERY_MS = 3 * 60_000;
/** Options that are about a person: the same one with someone else is another option (an answer's person is only
 *  whom it is said to). */
const WITH_SOMEONE: ReadonlySet<string> = new Set(['talk', 'trade', 'demand', 'recruit', 'follow', 'help']);
/** Skills that are only a stroll or a look about: anything with a purpose comes before them. */
const STROLLS: ReadonlySet<string> = new Set(['wander', 'lookAround']);

/**
 * A fight with the same person to the same end (a brawl, or to the death) is the fight already under way, whatever
 * its other terms: deciding on it again goes on with it rather than breaking it off to start it anew.
 */
function sameFight(aSkill: string, a: Record<string, unknown>, bSkill: string, b: Record<string, unknown>): boolean {
  return aSkill === 'duel' && bSkill === 'duel' && a.target === b.target && Boolean(a.lethal) === Boolean(b.lethal);
}
/** Grumbling to the same friend, or calling on the same person to rise, at most this often. */
const SPOKE_EVERY_MS = 10 * 60_000;
/** A question put to us is still worth answering this long after it was asked. */
const ASKED_FRESH_MS = 30_000;
/** A demand waits this long for its answer before it comes to blows (§17.7). */
const DEMAND_ANSWER_MS = 60_000;
/** One who refused a demand of ours is gone after if seen this close (§17.7 "or else"). */
const REFUSER_SIGHT = 24;
/** A demand said this recently still stands: one who hasn't paid it may be beaten for it (once: a beating answers it). */
const DEMANDED_LATELY_MS = 10 * 60_000;
/** Tribute is asked of those who gave in this often (§17.7 "every day": a few minutes, as days go here). */
const TRIBUTE_EVERY_MS = 5 * 60_000;
/** Someone who paid up lately isn't beaten for it: they are worth more paying (§17.7). */
const PAID_SPARES_MS = 10 * 60_000;

type Ask = { kind: 'trade'; offer: Offer } | { kind: 'help'; item: string; qty: number } | { kind: 'item'; item: string; qty: number };

/** What a line asks of us, if anything: a trade offer, a hand with gathering, or some items. */
export function readAsk(text: string, isItem: (word: string) => boolean = () => true): Ask | null {
  const offer = parseTradeOffer(text);
  if (offer && [...offer.give, ...offer.want].every((x) => isItem(x.item))) return { kind: 'trade', offer };
  const help = parseHelpRequest(text);
  if (help && isItem(help.item)) return { kind: 'help', ...help };
  const want = parseItemRequest(text);
  return want && isItem(want.item) ? { kind: 'item', ...want } : null;
}

/**
 * The code default's answer to someone asking us something (§6.3 share policy, §6.6 trades, §6.7 help). A
 * follow-up ("so, can you?") refers back to what they asked earlier in this conversation; what we already promised
 * them is restated, never promised twice.
 */
/**
 * What we were at, to go on with while we answer someone: work with its task, or exploring. Anything aimed at someone
 * else (following, a talk, a fight) gives way to the answer, and so does work stuck on its task.
 */
function keepDoing(s: AgentStateStore['state'], busy: boolean, isStuck: ValidationEnv['isStuck']): Pick<DecisionOutput, 'option' | 'task'> {
  const o = s.option;
  if (!busy || !o) return { option: 'rest' };
  // A fight goes on too: a demand put to someone mid-fight is answered with the blows still coming.
  if ((o.option === 'work' || o.option === 'fight') && o.skill && !isStuck(o.skill, o.args ?? {})) return { option: o.option, task: { skill: o.skill, args: o.args ?? {} } };
  return { option: o.option === 'explore' ? 'explore' : 'rest' };
}

function answerRequest(
  s: AgentStateStore['state'],
  from: AgentName,
  convId: ConvId | undefined,
  busy: boolean,
  isStuck: ValidationEnv['isStuck'],
  judge?: (name: AgentName) => number,
  isItem?: (word: string) => boolean,
  conflict?: ConflictView,
  power?: PowerView,
  answered?: ReadonlySet<string>,
  romance?: RomanceView,
  family?: FamilyView,
): DecisionOutput {
  const persona = s.self.persona;
  const me = s.self.username;
  const keep = keepDoing(s, busy, isStuck);
  // Only what they said that we haven't answered yet: a demand paid once isn't paid again on the next reason to decide.
  const said = s.perception.heardSpeech.filter((u) => u.from === from && u.addressedToMe && (!convId || u.convId === convId));
  const theirs = said.filter((u) => !answered?.has(u.id)).slice(-4);
  if (said.length > 0 && theirs.length === 0) return { ...keep, terminate: { maxSeconds: 20 }, rationale: `code default: nothing new from ${from} to answer` };
  // §19.2, §19.10 A: an advance (a compliment, a gift, "will you be my partner?"), taken as the roll has it.
  const advance = romance ? theirs.filter((u) => isAdvance(u.text)).at(-1) : undefined;
  if (romance && advance) return answerAdvance(from, PROPOSE_RE.test(advance.text), romance, keep);
  // §19.3: our partner asking to start a family: yes, when all is in place from our side too; otherwise not yet.
  if (family && theirs.some((u) => isFamilyAsk(u.text))) {
    const why = family.whyNotFamily(from);
    return why === null
      ? { ...keep, target: { agent: from }, speechIntent: { stance: 'agree', gist: FAMILY_YES, mayCommit: false }, family: { with: from, phase: 'accept' }, terminate: { maxSeconds: 20 }, rationale: `code default: yes to a family with ${from}` }
      : { ...keep, target: { agent: from }, speechIntent: { stance: 'decline', gist: FAMILY_NOT_YET, mayCommit: false }, family: { with: from, phase: 'decline' }, terminate: { maxSeconds: 20 }, rationale: `code default: not yet a family with ${from} (${why})` };
  }
  // Their yes to ours.
  if (family && s.family.partner === from && theirs.some((u) => isFamilyYes(u.text))) {
    return { ...keep, target: { agent: from }, speechIntent: { stance: 'chat', gist: FAMILY_HAPPY, mayCommit: false }, terminate: { maxSeconds: 20 }, rationale: `code default: ${from} wants a family too` };
  }
  // §17.8: a call to rise against someone is weighed by resentment of them, trust in who asks, and fear.
  const known = Object.keys(s.social);
  const foe = theirs.map((u) => parseRally(u.text, known)).filter((n): n is AgentName => n !== null && n !== me && n !== from).at(-1);
  if (foe) return answerRally(s, from, foe, busy, isStuck, conflict, power);
  // §18.4.1: asked what we think of someone, we say it, unless the fear of speaking up turns it into a safe word.
  const about = theirs.map((u) => readOpinionAsk(u.text, known)).filter((n): n is AgentName => n !== null && n !== me && n !== from).at(-1);
  if (about) {
    const felt = Math.max(-1, Math.min(1, ((judge?.(about) ?? s.social[about]?.sentiment ?? 5) - 5) / 5 - 0.5 * (conflict?.resentmentOf?.(about) ?? 0)));
    const said = statedOpinion(felt, power?.quiet?.(about) ?? 0);
    return {
      ...keep,
      target: { agent: from },
      speechIntent: { stance: 'inform', gist: opinionLine(about, said), mayCommit: false },
      terminate: { maxSeconds: 20 },
      rationale: `code default: asked about ${about} (feel ${felt.toFixed(2)}, say ${said.toFixed(2)})`,
    };
  }
  // §17.7: a demand ("give me 3 bread, or else") is weighed by fear, not by liking.
  const demand = theirs.map((u) => parseDemand(u.text)).filter((d): d is Demand => d !== null && (isItem?.(d.item) ?? true)).at(-1);
  if (demand) return answerDemand(s, from, demand, busy, isStuck, conflict);
  const ask = theirs.map((u) => readAsk(u.text, isItem)).filter((a) => a !== null).at(-1) ?? null;
  const liking = judge?.(from) ?? s.social[from]?.sentiment ?? persona.social.baselineSentiment;
  const owing = s.commitments.filter((c) => c.debtor === me && c.status === 'accepted').length;
  const have = (item: string) => {
    const m = itemMatcher(item);
    return s.self.inventory.filter((x) => m.matches(x.item)).reduce((a, x) => a + x.qty, 0);
  };
  const decline = (gist: string, rationale: string): DecisionOutput => ({
    ...keep,
    target: { agent: from },
    speechIntent: { stance: 'decline', gist, mayCommit: false },
    terminate: { maxSeconds: 20 },
    rationale: `code default: ${rationale}`,
  });
  if (ask?.kind === 'trade') {
    const v = judgeOffer(ask.offer, { sentiment: liking, trust: s.social[from]?.trust ?? 0.5, have, quirks: persona.quirks });
    const ours = ask.offer.want;
    const first = ours[0];
    if (v.kind === 'accept' && first && !s.flags.inDanger) {
      return {
        option: 'work',
        target: { agent: from },
        task: { skill: 'give', args: { to: from, item: first.item, qty: first.qty } },
        trade: { with: from, phase: 'accept', give: ours, want: ask.offer.give },
        speechIntent: { stance: 'agree', gist: `I'll give you ${stacksText(ours)} for your ${stacksText(ask.offer.give)}`, mayCommit: true },
        terminate: { maxSeconds: 120 },
        rationale: `code default: a fair trade with ${from}`,
      };
    }
    if (v.kind === 'counter') {
      const mine = v.offer.want;
      return {
        ...keep,
        target: { agent: from },
        trade: { with: from, phase: 'counter', give: mine, want: ask.offer.give },
        speechIntent: { stance: 'negotiate', gist: `how about ${stacksText(mine)} for your ${stacksText(ask.offer.give)}?`, mayCommit: false },
        terminate: { maxSeconds: 30 },
        rationale: `code default: countered ${from}'s offer`,
      };
    }
    return { ...decline(v.kind === 'decline' ? v.why : 'not now', `turned down ${from}'s offer`), trade: { with: from, phase: 'decline', give: [], want: [] } };
  }
  const kind = ask?.kind === 'help' ? 'help' : 'give';
  const promised = ask && s.commitments.find((c) => c.debtor === me && c.creditor === from && c.status === 'accepted' && c.what.kind === kind && c.what.item === ask.item);
  if (promised) {
    // Asked again: say so, and keep at it.
    const keepOn = busy ? null : codeDecision(s, {}, busy, isStuck);
    return {
      ...(keepOn ?? { ...keep, terminate: { maxSeconds: 20 } }),
      target: { agent: from },
      speechIntent: { stance: 'agree', gist: kind === 'help' ? `I'm on it, helping you gather ${promised.what.item ?? ''}`.trim() : `I'm on it, bringing you ${promised.what.text}`, mayCommit: true },
      rationale: `code default: already promised ${from} ${promised.what.text}`,
    };
  }
  if (ask?.kind === 'help') {
    if (s.flags.inDanger || owing >= 2 || liking < 6) return decline('you have too much on right now', `could not help ${from}`);
    const what = amountOf(ask.item, ask.qty);
    return {
      option: 'help',
      target: { agent: from },
      task: { skill: 'gather', args: { item: ask.item, qty: ask.qty } },
      speechIntent: { stance: 'agree', gist: `I'll help you gather ${ask.item}`, mayCommit: true },
      commitmentsToCreate: [{ debtor: me, creditor: from, what: { kind: 'help', item: ask.item, qty: ask.qty, target: from, text: `help gather ${what}` }, dueInSec: 900 }],
      terminate: { maxSeconds: 600 },
      rationale: `code default: helping ${from} gather ${ask.item}`,
    };
  }
  // §6.3 policy: share with people you like (sentiment ≥ 6) what you have, or can get if you're the generous kind.
  const generous = persona.big5.agreeableness >= 0.6 || persona.traits.some((t) => GENEROUS.test(t));
  if (ask?.kind === 'item' && !s.flags.inDanger && owing < 2 && liking >= 6) {
    const got = have(ask.item);
    if (got >= ask.qty || generous) {
      const what = amountOf(ask.item, ask.qty);
      return {
        option: 'work',
        target: { agent: from },
        task: got >= ask.qty ? { skill: 'give', args: { to: from, item: ask.item, qty: ask.qty } } : { skill: 'obtain', args: { item: ask.item, qty: ask.qty } },
        speechIntent: { stance: 'agree', gist: `I'll bring you ${what}`, mayCommit: true },
        commitmentsToCreate: [{ debtor: me, creditor: from, what: { kind: 'give', item: ask.item, qty: ask.qty, text: what }, dueInSec: 900 }],
        terminate: { maxSeconds: 600 },
        rationale: `code default: happy to help ${from}`,
      };
    }
  }
  return decline("you can't think it through right now; maybe later", 'answered a request without committing');
}

/** How long an agreed uprising waits for its moment (§17.8). */
const FIGHT_DUE_SEC = 30 * 60;

/**
 * §17.8: join an uprising against X when we resent X enough, trust the one who asks, and fear of X is in check; one
 * of X's own followers won't. Joining is a promise to fight X together (commitment kind `fight`).
 */
/**
 * §19.2, §19.10 A: an advance answered. Returned (a flirt back, or yes to "will you be my partner?" when we're drawn
 * to them, fond of them and free); otherwise turned down as the roll has it: kindly, coldly, with disgust, or
 * hostile. An ignored one gets no answer at all. Each side decides for itself.
 */
function answerAdvance(from: AgentName, proposal: boolean, romance: RomanceView, keep: Pick<DecisionOutput, 'option' | 'task'>): DecisionOutput {
  const how = romance.reactionTo(from);
  if (how === 'reciprocate' && (!proposal || romance.wouldAccept(from))) {
    return proposal
      ? { ...keep, target: { agent: from }, speechIntent: { stance: 'agree', gist: ACCEPTANCE, mayCommit: true }, romance: { with: from, phase: 'accept' }, terminate: { maxSeconds: 20 }, rationale: `code default: yes to ${from}` }
      : { ...keep, target: { agent: from }, speechIntent: { stance: 'flirt', gist: FLIRT_BACK, mayCommit: false }, romance: { with: from, phase: 'return' }, terminate: { maxSeconds: 20 }, rationale: `code default: returned ${from}'s affection` };
  }
  // Drawn to them, but not ready to be partners: a kind no.
  const reaction = how === 'reciprocate' ? 'politeDecline' : how;
  const line = DECLINE_LINES[reaction];
  return {
    ...keep,
    target: { agent: from },
    speechIntent: line ? { stance: reaction === 'hostile' ? 'hostile' : 'decline', gist: line, mayCommit: false } : { stance: 'none', gist: '', mayCommit: false },
    romance: { with: from, phase: 'decline', reaction },
    terminate: { maxSeconds: 20 },
    rationale: `code default: ${from}'s advance taken: ${reaction}`,
  };
}

/** §19.3–19.5: the family's next step: the question, the bed ritual, keeping close, food for a child. */
function familyMove(step: FamilyStep, isStuck: ValidationEnv['isStuck']): DecisionOutput | null {
  switch (step.kind) {
    case 'ask':
      return { option: 'talk', target: { agent: step.to }, speechIntent: { stance: 'propose', gist: FAMILY_PROPOSAL, mayCommit: false }, family: { with: step.to, phase: 'propose' }, terminate: { maxSeconds: 40 }, rationale: `code default: asking ${step.to} to start a family` };
    case 'sleep': {
      const args = { near: { x: Math.round(step.near.x), y: Math.round(step.near.y), z: Math.round(step.near.z) } };
      if (isStuck('sleep', args)) return null;
      return { option: 'work', task: { skill: 'sleep', args }, terminate: { maxSeconds: 600 }, rationale: `code default: night, to bed beside ${step.with}` };
    }
    case 'keepClose':
      if (isStuck('follow', { agent: step.to, distance: 3 })) return null;
      return { option: 'follow', target: { agent: step.to }, terminate: { maxSeconds: 30 }, rationale: `code default: ${step.why}` };
    case 'warn':
      return { option: 'talk', target: { agent: step.to }, speechIntent: { stance: 'inform', gist: step.line, mayCommit: false }, family: { with: step.to, phase: 'warn', about: step.about }, terminate: { maxSeconds: 30 }, rationale: `code default: warning my child ${step.to} about ${step.about}` };
    case 'feed': {
      const args = { to: step.to, item: step.item, qty: step.qty };
      if (isStuck('give', args)) return null;
      return { option: 'work', task: { skill: 'give', args }, terminate: { maxSeconds: 60 }, rationale: `code default: food for my child ${step.to}` };
    }
  }
}

/** §19.2: the next step in courting someone (a compliment, a small gift, the question), when it's time for one. */
function courtMove(romance: RomanceView): DecisionOutput | null {
  const step = romance.courtship();
  if (!step) return null;
  const to = step.with;
  // A crush seeks them out: over to be near them.
  if (step.kind === 'approach') return { option: 'move', target: { agent: to }, terminate: { maxSeconds: 30 }, rationale: `code default: going over to be near ${to}` };
  if (step.kind === 'propose') {
    return { option: 'court', target: { agent: to }, speechIntent: { stance: 'propose', gist: PROPOSAL, mayCommit: false }, romance: { with: to, phase: 'propose' }, terminate: { maxSeconds: 40 }, rationale: `code default: asking ${to} to be my partner` };
  }
  if (step.kind === 'gift') {
    return {
      option: 'court',
      target: { agent: to },
      task: { skill: 'give', args: { to, item: step.item, qty: 1 } },
      speechIntent: { stance: 'flirt', gist: GIFT_LINE, mayCommit: false },
      romance: { with: to, phase: 'flirt' },
      terminate: { maxSeconds: 60 },
      rationale: `code default: a little gift for ${to}`,
    };
  }
  return { option: 'court', target: { agent: to }, speechIntent: { stance: 'flirt', gist: step.line, mayCommit: false }, romance: { with: to, phase: 'flirt' }, terminate: { maxSeconds: 40 }, rationale: `code default: courting ${to}` };
}

function answerRally(s: AgentStateStore['state'], from: AgentName, x: AgentName, busy: boolean, isStuck: ValidationEnv['isStuck'], c?: ConflictView, power?: PowerView): DecisionOutput {
  const keep = keepDoing(s, busy, isStuck);
  const resentment = c?.resentmentOf?.(x) ?? 0;
  // Facing X together: with the one who asks and the others we know resent X.
  const allies = [...new Set([from, ...(power?.coalition(x).members ?? [])])];
  const fear = c?.fearWith?.(x, allies) ?? c?.fearOf(x) ?? s.social[x]?.fearOf ?? 0;
  const followsTarget = power?.leader() === x;
  if (!joinsRally({ resentment, trust: s.social[from]?.trust ?? 0.5, fear, followsTarget })) {
    return {
      ...keep,
      target: { agent: from },
      speechIntent: { stance: 'decline', gist: followsTarget ? `no. ${x} looks after me` : `not me. I'm staying out of it`, mayCommit: false },
      terminate: { maxSeconds: 20 },
      rationale: `code default: not joining against ${x} (resentment ${resentment.toFixed(2)}, fear ${fear.toFixed(2)})`,
    };
  }
  return {
    ...keep,
    target: { agent: from },
    speechIntent: { stance: 'agree', gist: `fine. I'll fight ${x} with you.`, mayCommit: true },
    commitmentsToCreate: [{ debtor: s.self.username, creditor: from, what: { kind: 'fight', target: x, text: `fight ${x} together with ${from}` }, dueInSec: FIGHT_DUE_SEC }],
    terminate: { maxSeconds: 20 },
    rationale: `code default: with ${from} against ${x} (resentment ${resentment.toFixed(2)}, fear ${fear.toFixed(2)})`,
  };
}

/**
 * §17.7 compliance: give in when fear of the demander outweighs resentment of them plus pride (1 − 0.5·loyalty),
 * a lower bar for a leader or an idol (§18.4 authority). Giving in is a coerced commitment: owed like any promise,
 * and every payment a small grievance against them.
 */
function answerDemand(s: AgentStateStore['state'], from: AgentName, d: Demand, busy: boolean, isStuck: ValidationEnv['isStuck'], c?: ConflictView): DecisionOutput {
  const fear = c?.fearOf(from) ?? s.social[from]?.fearOf ?? 0;
  const resent = c?.resentmentOf?.(from) ?? 0;
  const keep = keepDoing(s, busy, isStuck);
  const what = amountOf(d.item, d.qty);
  if (s.flags.inDanger || !complies(fear, resent, s.self.persona.temperament.loyalty, (c?.authorityOf?.(from) ?? 0) + (c?.bandwagon?.(from) ?? 0))) {
    return {
      ...keep,
      target: { agent: from },
      speechIntent: { stance: 'hostile', gist: 'no. you get nothing from me.', mayCommit: false },
      terminate: { maxSeconds: 20 },
      rationale: `code default: not giving in to ${from} (fear ${fear.toFixed(2)}, resentment ${resent.toFixed(2)})`,
    };
  }
  const m = itemMatcher(d.item);
  const have = s.self.inventory.filter((x) => m.matches(x.item)).reduce((a, x) => a + x.qty, 0);
  return {
    option: 'work',
    target: { agent: from },
    task: have >= d.qty ? { skill: 'give', args: { to: from, item: d.item, qty: d.qty } } : { skill: 'obtain', args: { item: d.item, qty: d.qty } },
    speechIntent: { stance: 'agree', gist: `fine. I'll give you ${what}`, mayCommit: true },
    commitmentsToCreate: [{ debtor: s.self.username, creditor: from, what: { kind: 'give', item: d.item, qty: d.qty, text: what }, dueInSec: 600, coerced: true }],
    terminate: { maxSeconds: 600 },
    rationale: `code default: afraid of ${from}, giving in (fear ${fear.toFixed(2)})`,
  };
}

/** What the conflict rungs call for with the people nearby (§17.5), if anything. */
function conflictMove(s: AgentStateStore['state'], c: ConflictView, liking?: (name: AgentName) => number, leader?: AgentName | null): DecisionOutput | null {
  const near = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.distance <= 12).sort((a, b) => c.rungOf(b.name) - c.rungOf(a.name));
  // §17.7 "or else": a domineering agent goes after one who heard his demand and didn't pay, if they're in sight.
  const tyrant = s.self.persona.temperament.dominance >= 0.5;
  const refuser = tyrant
    ? s.perception.nearbyEntities.find(
        (e) => e.kind === 'player' && e.visible && e.distance <= REFUSER_SIGHT && c.rungOf(e.name) >= 3 && (c.demandedLately?.(e.name) ?? false) && !c.demandPending?.(e.name) && c.mayBrawl(e.name),
      )
    : undefined;
  if (refuser) {
    return {
      option: 'fight',
      target: { agent: refuser.name },
      task: { skill: 'duel', args: { target: refuser.name, stopAtHealth: yieldHealth(s.drives.caution) } },
      fight: { target: refuser.name, intent: 'brawl', withAllies: [] },
      speechIntent: { stance: 'threaten', gist: 'I told you to pay up', mayCommit: false },
      terminate: { maxSeconds: 90 },
      rationale: `code default: ${refuser.name} wouldn't pay`,
    };
  }
  for (const e of near) {
    const rung = c.rungOf(e.name);
    if (rung >= 4 && c.mayKill?.(e.name)) {
      const t = s.self.persona.temperament;
      return {
        option: 'fight',
        target: { agent: e.name },
        task: { skill: 'duel', args: { target: e.name, stopAtHealth: yieldHealth(s.drives.caution), lethal: true, spareChance: Math.round(spareChance(t.mercy, c.resentmentOf?.(e.name) ?? 0.5, 4) * 100) / 100, seconds: 120 } },
        fight: { target: e.name, intent: 'lethal', withAllies: [] },
        speechIntent: { stance: 'threaten', gist: 'this ends now', mayCommit: false },
        terminate: { maxSeconds: 150 },
        rationale: `code default: ${e.name} has to go`,
      };
    }
    // A domineering agent's "or else" comes before the blows: a beating is for one who heard the demand and didn't pay.
    if (rung >= 3 && c.mayBrawl(e.name) && !c.demandPending?.(e.name) && (!tyrant || (c.demandedLately?.(e.name) ?? true))) {
      return {
        option: 'fight',
        target: { agent: e.name },
        task: { skill: 'duel', args: { target: e.name, stopAtHealth: yieldHealth(s.drives.caution) } },
        fight: { target: e.name, intent: 'brawl', withAllies: [] },
        speechIntent: { stance: 'threaten', gist: "you've had this coming", mayCommit: false },
        terminate: { maxSeconds: 90 },
        rationale: `code default: I've had enough of ${e.name}`,
      };
    }
    // Words and distance come now and then, not on every decision.
    if (c.warnedLately(e.name)) continue;
    // §17.7: a domineering agent's threat is a demand: tribute, or else; and who gave in pays again in time.
    if ((rung >= 2 || c.tributeDue?.(e.name)) && tyrant) return demandOf(s, e.name);
    if (rung >= 1) {
      return {
        option: 'talk',
        target: { agent: e.name },
        speechIntent: rung >= 2 ? { stance: 'threaten', gist: 'warn them off: back off, or there will be trouble', mayCommit: false } : { stance: 'hostile', gist: 'tell them to keep their distance', mayCommit: false },
        terminate: { maxSeconds: 30 },
        rationale: `code default: warning ${e.name} off`,
      };
    }
    // Rung 0 (§17.5 avoid): someone we fear and don't like, close by: keep our distance (unless we follow them).
    const like = liking?.(e.name) ?? s.social[e.name]?.sentiment ?? 5;
    if (e.distance <= 6 && like < 5 && c.fearOf(e.name) >= 0.7 && e.name !== leader) {
      const me = s.self.pos;
      const dx = me.x - e.pos.x;
      const dz = me.z - e.pos.z;
      const n = Math.hypot(dx, dz) || 1;
      return {
        option: 'move',
        target: { agent: e.name, pos: { x: Math.round(me.x + (dx / n) * 12), y: Math.round(me.y), z: Math.round(me.z + (dz / n) * 12) } },
        terminate: { maxSeconds: 20 },
        rationale: `code default: keeping away from ${e.name}`,
      };
    }
  }
  // Tribute due from one in sight further off: gone over to and asked for.
  const payer = tyrant ? s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.visible && e.distance <= REFUSER_SIGHT && (c.tributeDue?.(e.name) ?? false) && !c.warnedLately(e.name)) : undefined;
  return payer ? demandOf(s, payer.name) : null;
}

/** §17.7: "give me 3 bread, or else" (logs when we have food enough), promising nothing. */
function demandOf(s: AgentStateStore['state'], name: AgentName): DecisionOutput {
  const want = demandFor(s.self.inventory.filter((x) => /^(bread|apple|cooked_\w+|baked_potato|carrot)$/.test(x.item)).reduce((a, x) => a + x.qty, 0));
  return {
    option: 'demand',
    target: { agent: name },
    speechIntent: { stance: 'threaten', gist: `give me ${amountOf(want.item, want.qty)}, or else`, mayCommit: false },
    terminate: { maxSeconds: 40 },
    rationale: `code default: ${name} will pay up`,
  };
}

/**
 * §17.7 tribute: someone who gave in to a demand of ours this past hour pays again every TRIBUTE_EVERY_MS ("every
 * day"), once nothing they owe us is still open.
 */
export function tributeDue(commitments: readonly Commitment[], me: AgentName, name: AgentName, now: number): boolean {
  const theirs = commitments.filter((k) => k.coerced && k.creditor === me && k.debtor === name);
  if (theirs.some((k) => k.status === 'accepted' || k.status === 'proposed')) return false;
  const last = Math.max(...theirs.filter((k) => k.status === 'fulfilled').map((k) => k.resolvedAt ?? 0), -Infinity);
  return now - last < 60 * 60_000 && now - last >= TRIBUTE_EVERY_MS;
}

/** When we last said a demand to them (§17.7), as our side of the conversations with them has it; −∞ if never. */
export function lastDemandSaid(s: AgentStateStore['state'], name: AgentName): number {
  return lastSaidTo(s, name, (text) => Boolean(parseDemand(text)));
}

/** When we last said something (`which`: a line like that) in a conversation they're in. */
export function lastSaidTo(s: AgentStateStore['state'], name: AgentName, which: (text: string) => boolean = () => true): number {
  let last = -Infinity;
  for (const c of Object.values(s.conversations)) {
    if (!c.participants.includes(name)) continue;
    for (const u of c.transcript) if (u.from === s.self.username && u.ts > last && which(u.text)) last = u.ts;
  }
  return last;
}

/** A warning or a threat we're on our way to say: its option still running, and nothing said to them since. */
export function owesThreat(s: AgentStateStore['state']): boolean {
  const d = s.decision;
  const who = d?.target?.agent;
  const stance = d?.speechIntent?.stance;
  if (!d || !who || (stance !== 'threaten' && stance !== 'hostile')) return false;
  return s.option?.decisionId === d.id && s.option.status === 'running' && lastSaidTo(s, who) < d.createdAt;
}

/** §17.7: they owe us under threat, or paid up lately; either way a demand of ours is working on them. */
export function paying(commitments: readonly Commitment[], me: AgentName, name: AgentName, now: number): boolean {
  return commitments.some(
    (k) => k.coerced && k.debtor === name && k.creditor === me && (k.status === 'accepted' || (k.status === 'fulfilled' && now - (k.resolvedAt ?? 0) < PAID_SPARES_MS)),
  );
}

/** What the power moves need (§17.7, §17.8), when the conflict core and the power watch are there. */
function powerCtx(social: SocialChance, isStuck: ValidationEnv['isStuck']): PowerMoveCtx | null {
  const c = social.conflict;
  const power = social.power;
  if (!c || !power) return null;
  return {
    isStuck,
    power,
    resentmentOf: (n) => c.resentmentOf?.(n) ?? 0,
    mayBrawl: (n) => c.mayBrawl(n),
    mayKill: (n) => c.mayKill?.(n) ?? false,
    mayJoin: (n) => c.mayJoin?.(n) ?? false,
    liking: (n) => social.liking?.(n) ?? 5,
    candidates: social.candidates,
    roll: social.roll,
  };
}

/** While busy, only the fight itself: the one we swore to take on is here, with the others at hand. */
function uprisingFight(s: AgentStateStore['state'], v: PowerMoveCtx): DecisionOutput | null {
  const d = uprisingMove(s, v);
  return d?.option === 'fight' ? d : null;
}

/** The non-LLM decision (§5 "CC default"), also the code-only brain (§22.4). Null = keep doing what you're doing. */
export function codeDecision(
  s: AgentStateStore['state'],
  ctx: DecideContext,
  busy: boolean,
  isStuck: ValidationEnv['isStuck'],
  social?: SocialChance,
): DecisionOutput | null {
  if (ctx.from) return answerRequest(s, ctx.from, ctx.convId, busy, isStuck, social?.liking, social?.isItem, social?.conflict, social?.power, social?.answered, social?.romance, social?.family);
  const pv = social ? powerCtx(social, isStuck) : null;
  if (busy) {
    // Starving with nothing to eat: food before whatever we are doing.
    const food = s.self.food <= 6 ? hungerMove(s, { isStuck }) : null;
    if (food) return food;
    // A hole just made in what is ours (the shelter we are in, a hut): patched before going on.
    const patched = ctx.change ? patchMove(s, isStuck) : null;
    if (patched) return patched;
    // §17.8: the moment against one we resent (alone or hurt) is worth stopping work for: the others are called on.
    const moment = ctx.opening && pv ? rallyMove(s, pv) : null;
    if (moment) return moment;
    // §17.7: one we have just begun to follow, while we stroll about: by their side from now on, wherever we are.
    const keep = ctx.leader && ctx.leader === social?.power?.leader() && STROLLS.has(s.option?.skill ?? '') ? keepByLeader(s, ctx.leader, isStuck, `following ${ctx.leader} now`) : null;
    if (keep) return keep;
    if (!ctx.atOdds || !social?.conflict) return null;
    // Someone we're at odds with came near: the one we swore to take on (with the others at hand), or the rungs.
    const move = (pv ? uprisingFight(s, pv) : null) ?? conflictMove(s, social.conflict, social.liking, social.power?.leader());
    // A threat we're on our way to say is said before the next one; only blows come first.
    return move && move.option !== 'fight' && owesThreat(s) ? null : move;
  }
  // Starving with nothing to eat comes before anything, even the night (§16.3: carry food).
  const starving = s.self.food <= 6 ? hungerMove(s, { isStuck }) : null;
  if (starving) return starving;
  // §19.3: agreed to start a family: at night, to bed beside each other at home (the bed ritual), not dug in.
  const fam = social?.family?.step() ?? null;
  const ritual = fam?.kind === 'sleep' ? familyMove(fam, isStuck) : null;
  if (ritual) return ritual;
  // A hole in what is ours (the shelter we were in, a hut), still open: patched before the night's or the day's
  // business.
  const patched = patchMove(s, isStuck);
  if (patched) return patched;
  // The night is no reason to dig in (§16.3 caution, not a hole in the ground): back toward home if far from it, close
  // to the others; a guard on duty stays out while fit for it. With a model, hiding is the model's call, and only for
  // one badly scared, alone and far from anyone (the gate in validateDecision). Without one (no key, or the quota
  // spent, §22.4) the code default is the whole brain, with no mind to choose better, and digs in at night as before
  // (M1): out in the open, a village of code-only agents was shot down by skeletons night after night (21 deaths in
  // M8's hour).
  const village = villageWorkOf(s.goals.current?.doneWhen);
  const onGuard = village === 'guard' && s.self.health >= 12 && s.drives.caution < 0.8;
  const night = !s.self.isDay || s.self.time > DUSK;
  const mayHide = Boolean(social?.codeOnly);
  if (night && !s.flags.inDanger && !onGuard) {
    const move = nightMove(s, isStuck, mayHide);
    if (move) return move;
  }
  // Badly hurt: food, then lie low until healed; no work, no quarrels.
  const hurt = hurtMove(s, { isStuck, mayHide });
  if (hurt) return hurt;
  // §19.5: a young child keeps to its parents, and parents to their young child; the question, when it's time.
  const kin = fam && fam.kind !== 'sleep' ? familyMove(fam, isStuck) : null;
  if (kin) return kin;
  // §17.8: an uprising we swore to: meet up, find them, set upon them together.
  const uprising = pv ? uprisingMove(s, pv) : null;
  if (uprising) return uprising;
  // §17.8: the moment against one we resent (alone or hurt) comes before warning them off: the others are called on.
  const moment = ctx.opening && pv ? rallyMove(s, pv) : null;
  if (moment) return moment;
  // §17.5: someone we're at odds with nearby comes first: the brawl the gate allows, a warning, or keeping away.
  const odds = social?.conflict ? conflictMove(s, social.conflict, social.liking, social.power?.leader()) : null;
  if (odds) return odds;
  // Hungry with nothing to eat: food first.
  const hungry = hungerMove(s, { isStuck });
  if (hungry) return hungry;
  // §17.7, §17.8: the moment to rally others against someone; a follower's place by its leader; a grudge shared.
  const power = pv ? (rallyMove(s, pv) ?? escortMove(s, pv) ?? gossipMove(s, pv)) : null;
  if (power) return power;
  // §19.2: courting someone we're drawn to: a compliment, a small gift, the question.
  const court = social?.romance ? courtMove(social.romance) : null;
  if (court) return court;
  const next = s.taskQueue.find((t) => !isStuck(t.skill, t.args));
  if (next) {
    return { option: 'work', task: { skill: next.skill, args: next.args }, terminate: { maxSeconds: 600 }, rationale: `code default: next planned task (${next.note ?? next.skill})` };
  }
  // A death the board doesn't tell yet goes on it (§16.3), before our own work.
  const notice = deathNoticeMove(s, { isStuck });
  if (notice) return notice;
  // Our part in the village (§6.8).
  if (village) {
    const move = villageMove(s, village, { isStuck });
    if (move) return move;
  }
  // The plan's step at hand (§4.2 module 10), by what its doneWhen asks: food, a look around, a talk with someone.
  const goal = s.goals.current;
  const doneWhen = goal?.doneWhen?.trim() ?? '';
  if (/^inventoryHas:food\s*>=/i.test(doneWhen)) {
    const food = foodMove(s, { isStuck }, goal?.text ?? 'getting food');
    if (food) return food;
  }
  if (/^explored:\d+$/.test(doneWhen) && !isStuck('explore', { ...EXPLORE_ARGS })) {
    return { option: 'explore', terminate: { maxSeconds: 120 }, rationale: `code default: ${goal?.text ?? 'looking around'}` };
  }
  const meet = /^talkedWith:([A-Za-z0-9_]{1,16})$/.exec(doneWhen)?.[1];
  if (meet && meet !== s.self.username) {
    const there = s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === meet);
    if (there) {
      return {
        option: 'talk',
        target: { agent: meet },
        speechIntent: { stance: 'chat', gist: `talk with ${meet}: what they are up to, and what you plan`, mayCommit: false },
        terminate: { maxSeconds: 120 },
        rationale: `code default: ${goal?.text ?? `talking with ${meet}`}`,
      };
    }
    if (!isStuck('explore', { ...EXPLORE_ARGS })) return { option: 'explore', terminate: { maxSeconds: 90 }, rationale: `code default: looking for ${meet}` };
  }
  // Work toward a goal with a machine-checkable target: obtain it (or the prerequisite it said to get first).
  const want = doneWhen ? /^inventoryHas:([a-z0-9_]+)\s*>=\s*(\d+)$/i.exec(doneWhen) : null;
  if (want?.[1] && want[2] && want[1].toLowerCase() !== 'food') {
    // Follow only the latest attempt: once the prerequisite is in hand (or the ore found), go back to the goal itself.
    // Interruptions (an impulse, a reflex) are not results; after looking around, try the goal again.
    const last = [...s.actionLog].reverse().find((a) => ['obtain', 'prospect', 'explore'].includes(a.skill) && !a.error?.startsWith('aborted'));
    const err = last && !last.ok ? (last.error ?? '') : '';
    const unseen = last?.skill === 'obtain' ? /haven't seen any ([a-z0-9_]+)/.exec(err)?.[1] : undefined;
    // In a village (a chest or huts seen near home), mines go outside it.
    const dig = { item: unseen, ...(s.village.chest || s.village.huts.length > 0 ? { outside: 24 } : {}) };
    if (unseen && ORE_LIKE.test(unseen) && !isStuck('prospect', dig)) {
      return { option: 'work', task: { skill: 'prospect', args: dig }, terminate: { maxSeconds: 420 }, rationale: `code default: dig for ${unseen}` };
    }
    if ((unseen || (last?.skill === 'prospect' && err)) && !isStuck('explore', { ...EXPLORE_ARGS })) {
      return { option: 'explore', terminate: { maxSeconds: 90 }, rationale: 'code default: look somewhere else' };
    }
    const first = last?.skill === 'obtain' ? /get ([a-z0-9_]+) first/.exec(err)?.[1] : undefined;
    const item = first && !isStuck('obtain', { item: first, qty: 1 }) ? first : want[1];
    const qty = item === want[1] ? Number(want[2]) : 1;
    if (!isStuck('obtain', { item, qty })) {
      return { option: 'work', task: { skill: 'obtain', args: { item, qty } }, terminate: { maxSeconds: 600 }, rationale: `code default: get ${item} for the goal` };
    }
    // Stuck on it for a while (the mark lasts minutes): look around a little, then a stroll before trying again.
    const explored = s.actionLog.slice(-3).filter((a) => a.skill === 'explore').length;
    if (explored >= 2) return { option: 'work', task: { skill: 'wander', args: { radius: 12, seconds: 50 } }, terminate: { maxSeconds: 60 }, rationale: 'code default: stuck on the goal; a stroll before trying again' };
    return { option: 'explore', terminate: { maxSeconds: 60 }, rationale: 'code default: stuck on the goal, look around' };
  }
  // Nothing to work on: go and see whether what someone told us is true (§6.5).
  const claim = social?.claim;
  if (claim && !isStuck('goTo', { x: claim.pos.x, y: claim.pos.y, z: claim.pos.z, range: 3 })) {
    return {
      option: 'work',
      task: { skill: 'goTo', args: { x: claim.pos.x, y: claim.pos.y, z: claim.pos.z, range: 3 } },
      terminate: { maxSeconds: 120 },
      rationale: `code default: ${claim.by} said there is ${claim.item} there; see for myself`,
    };
  }
  // Or say hello to someone nearby (§6.2 conversations start from the talk option): about our plan, if we haven't
  // talked it over with them, since plans are made better by talking them through.
  const who = social?.candidates[0];
  const plan = s.goals.plan;
  const unshared = Boolean(plan && who && !planFinished(plan) && !plan.discussedWith.includes(who));
  if (who && social.roll < s.self.persona.social.initiateChance * (unshared ? 1.5 : 1)) {
    return {
      option: 'talk',
      target: { agent: who },
      speechIntent: {
        stance: 'chat',
        gist: unshared && plan ? `say hello to ${who}; tell them what you mean to do (${plan.aim}) and ask what they are up to; maybe you can split the work` : `say hello to ${who} and chat a little`,
        mayCommit: false,
      },
      terminate: { maxSeconds: 90 },
      rationale: `code default: ${who} is here`,
    };
  }
  // Nothing pressing: never just standing there. A follower keeps by the one it follows (§17.7). Anyone else strolls
  // about looking at what there is (closer to home at night), and with a friend, a partner or kin in sight, about them:
  // people with time on their hands keep company rather than walk off from it.
  const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.visible && e.distance <= COMPANY_RANGE);
  const leader = social?.power?.leader() ?? null;
  const keep = leader ? keepByLeader(s, leader, isStuck, 'nothing pressing') : null;
  if (keep) return keep;
  const friend = companyOf(s, people, social?.liking);
  const stroll = { radius: friend || night ? 8 : 16, seconds: 45 + Math.round(social?.roll ?? 0.5) * 30, ...(friend ? { near: friend } : {}) };
  if (!isStuck('wander', stroll)) return { option: 'work', task: { skill: 'wander', args: stroll }, terminate: { maxSeconds: stroll.seconds + 15 }, rationale: 'code default: nothing pressing; looking around' };
  return { option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'code default: nothing to do' };
}

/** A change around us that is no emergency wakes the CC at most this often. */
const NOTICE_EVERY_MS = 10_000;
/**
 * Long at one piece of work, a look up from it now and then, as a player looks at the tools, the sky, the hunger bar
 * (one dug six minutes on end, its pickaxes wearing out under it, on into the night with nothing left to fight with).
 */
const LOOK_UP_MS = 3 * 60_000;

/** §17.7: a follower keeps by the one it follows, when they are in sight (within COMPANY_RANGE). */
function keepByLeader(s: AgentStateStore['state'], leader: AgentName, isStuck: ValidationEnv['isStuck'], why: string): DecisionOutput | null {
  const inSight = s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.visible && e.distance <= COMPANY_RANGE && e.name === leader);
  if (!inSight || isStuck('follow', { agent: leader, distance: 3 })) return null;
  return { option: 'follow', target: { agent: leader }, terminate: { maxSeconds: 60 }, rationale: `code default: ${why}; keeping by ${leader}` };
}

/** What a hole is patched with, best first. */
const PATCH_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'sandstone', 'gravel', 'sand'];

/**
 * A hole in the shelter we are in or in a hut, still open: patched with a block we carry. Not with a monster in it
 * (that is for the reflexes), nor from far off. (A block of ours someone took, a table say, is news, not a hole.)
 */
export function patchMove(s: AgentStateStore['state'], isStuck: ValidationEnv['isStuck']): DecisionOutput | null {
  const t = Date.now();
  // Kept until something else happens there (patched, by us or anyone): the latest still open.
  const hole = [...s.perception.blockChanges].reverse().find((c) => c.kind === 'broken' && (c.ours === 'shelter' || c.ours === 'hut') && t - c.ts < CHANGE_MS);
  if (!hole) return null;
  const at = { x: hole.pos.x + 0.5, y: hole.pos.y, z: hole.pos.z + 0.5 };
  const me = s.self.pos;
  if (Math.hypot(me.x - at.x, me.y - at.y, me.z - at.z) > 5) return null;
  if (s.perception.nearbyEntities.some((e) => e.kind === 'hostile' && Math.hypot(e.pos.x - at.x, e.pos.y - at.y, e.pos.z - at.z) <= 2)) return null;
  const carried = (n: string) => s.self.inventory.some((i) => i.item === n);
  const block = PATCH_BLOCKS.find(carried) ?? s.self.inventory.find((i) => i.item.endsWith('_planks'))?.item;
  if (!block) return null;
  const args = { block, x: hole.pos.x, y: hole.pos.y, z: hole.pos.z };
  if (isStuck('place', args)) return null;
  const what = hole.ours === 'shelter' ? 'in my shelter' : 'in the hut';
  return { option: 'work', task: { skill: 'place', args }, terminate: { maxSeconds: 30 }, rationale: `code default: patching the hole ${what} (${hole.where})` };
}

/** Within this, someone in sight is company an idle stroll keeps about. */
const COMPANY_RANGE = 32;

/** The nearest of these people one would keep company with: a partner, kin, one we are drawn to, or a friend. */
function companyOf(s: AgentStateStore['state'], people: readonly SeenEntity[], liking?: (name: AgentName) => number): AgentName | undefined {
  const close = (n: AgentName) => {
    const p = s.social[n];
    return s.family.partner === n || Boolean(p?.kin) || (p?.romanticInterest ?? 0) >= 0.3 || (liking?.(n) ?? p?.sentiment ?? 5) >= 6.5;
  };
  return [...people].sort((a, b) => a.distance - b.distance).find((e) => close(e.name))?.name;
}

/** A run home in the dark this long at most (about twenty seconds at a sprint). */
const HOME_RUN = 80;

/**
 * Night without digging in (§16.3): a code-only agent badly scared, alone and far from anyone may hide (the gate);
 * otherwise, a short run from home, back to it, and farther off, a night's hut there; with someone in sight farther
 * off, over to them. Null: the day's business goes on (the reflexes deal with the monsters).
 */
function nightMove(s: AgentStateStore['state'], isStuck: ValidationEnv['isStuck'], mayHide: boolean): DecisionOutput | null {
  if (mayHide && !isStuck('shelter', { untilMorning: true })) {
    return { option: 'work', task: { skill: 'shelter', args: { untilMorning: true } }, terminate: { maxSeconds: 900 }, rationale: 'code default: night, and no mind to choose otherwise; digging in until morning' };
  }
  // Under a roof or in the ground the dark is no news: going home from there crosses the open in it (an agent sent
  // home so from a tunnel 40 m down died on the way, among a skeleton, two zombies and a spider).
  if (!/under the open sky/.test(s.scene.where)) return null;
  const home = s.village.home;
  const p = s.self.pos;
  const off = home ? Math.hypot(p.x - home.x, p.z - home.z) : 0;
  // Home a short run off, back to it, if there is shelter there; far off, or nothing built there, a night's hut where
  // one is (one sent home so from 200 blocks off walked the whole dark way, and came in with one heart left; one at
  // 3.5 health was sent 40 m through the dark to a home with nothing built at it).
  const near = (v: { x: number; z: number }) => home !== null && Math.hypot(v.x - home.x, v.z - home.z) <= 16;
  const sheltered = Boolean(home) && ([...s.village.huts, ...(s.village.rooms ?? [])].some(near) || (s.village.projects ?? []).some((pr) => pr.doneAt !== null && near(pr.origin)));
  if (home && sheltered && off > 32 && off <= HOME_RUN) {
    const args = { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z), range: 4 };
    if (!isStuck('goTo', args)) return { option: 'work', task: { skill: 'goTo', args }, terminate: { maxSeconds: 120 }, rationale: 'code default: dark now; back home' };
  }
  if (home && (off > HOME_RUN || (off > 32 && !sheltered))) {
    const args = { structure: 'hut', room: 1 };
    if (!isStuck('build', args)) return { option: 'work', task: { skill: 'build', args }, terminate: { maxSeconds: 120 }, rationale: "code default: dark now, and home far off; a night's hut here" };
  }
  const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player').sort((a, b) => a.distance - b.distance);
  const nearest = people[0];
  if (nearest && nearest.distance > 12 && !isStuck('goTo', { agent: nearest.name, range: 4 })) {
    return { option: 'move', target: { agent: nearest.name }, terminate: { maxSeconds: 45 }, rationale: `code default: dark now; staying close to ${nearest.name}` };
  }
  return null;
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
  memories?: (k: number) => Promise<string[]>;
  /** Brings the bot's own snapshot up to date before deciding (perception otherwise lags up to 250 ms). */
  refreshSelf?: () => void;
  /** People in range this agent may start talking to (for the code default's hello). */
  socialCandidates?: () => AgentName[];
  /** Whether a word names an item or a kind of item (the body's registry). */
  isItem?: (word: string) => boolean;
  /** Whether a chest (or barrel) stands at that spot, as the body sees it now; null when it can't tell (out of sight). */
  chestAt?: (pos: { x: number; y: number; z: number }) => boolean | null;
  /** The nearest unchecked claim worth a look (§6.5). */
  claimToCheck?: () => SocialChance['claim'] | undefined;
  /** Gut/facts mix about someone (§18.5) and the packet's lines on feelings and people (§18.2). */
  liking?: (name: AgentName) => number;
  mindLines?: () => string[];
  /** The conflict core (§17.5); without it nobody fights anybody on purpose. */
  conflict?: {
    rungOf(name: AgentName): number;
    fearOf(name: AgentName): number;
    resentmentOf?(name: AgentName): number;
    authorityOf?(name: AgentName): number;
    bandwagon?(name: AgentName): number;
    fearWith?(name: AgentName, allies: readonly AgentName[]): number;
    mayFight(target: AgentName, intent: 'brawl' | 'lethal' | 'impulse', opts?: { joining?: boolean }): string | null;
  };
  /** Power structures (§17.7, §17.8): whom we follow, who resents whom, coalitions. */
  power?: Omit<PowerView, 'saidLately'>;
  /** Romance (§19.2): whom we're drawn to, how far it has gone, how we take an advance; and the gate on courting. */
  romance?: RomanceView;
  /** Families (§19.3–19.5): starting one with our partner, the bed ritual, children and parents. */
  family?: FamilyView;
  /**
   * M10: the skills the agent wrote for itself. `find` looks one up by name (verified, or on trial); `offered` are the
   * lines for the model's skill list, the most relevant first.
   */
  learned?: { find(name: string): AnySkill | null; offered(): string[] };
  /** A person (fights with them are gated) rather than a mob. */
  isPerson?: (name: AgentName) => boolean;
  rng?: () => number;
  heartbeatMs?: number;
  /** What it knows of the game that bears on now (owner request, 2026-10-24), as lines for the packet. */
  knowledge?: () => string[];
  /** The models it thinks with first, and the time a thought may take (config/models.yaml `mind`). */
  mindModels?: readonly string[];
  mindTimeoutMs?: number;
  /** In danger: what the body is doing by itself right now ("running from 3 zombies, the nearest 2 m off"). */
  bodyInDanger?: () => string;
  /** In danger: the body is to run (the mind chose to get away, and leaves the running to the legs). */
  runNow?: () => void;
  now?: () => number;
}

/** The CC's last exchange with the model, for the operator (debug controls): what it saw and what came back. */
export interface Exchange {
  at: number;
  reason: string;
  tier: string;
  packet: string;
  replies: { model: string | null; text: string; error?: string; rejected?: string }[];
}

export class CognitiveController {
  /** The last exchange with the model (debug controls). */
  lastExchange: Exchange | null = null;
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private beat: NodeJS.Timeout | null = null;
  /** Decisions held back by the rate cap: cleared on stop, so none fires into a stopped agent. */
  private readonly waiting = new Set<NodeJS.Timeout>();
  private stopped = false;
  private lastDecisionAt = 0;
  /**
   * The option under way is the mind's own, or a step it meant (not a panic, a reflex or a fallback taking over): only
   * then does what it meant next follow on. An agent ran in a panic out of the hole it was digging, and on finishing
   * the run went straight on to the mining it had meant for after the night.
   */
  private ownOption = false;
  private deferred: { reason: string; ctx: DecideContext } | null = null;
  /** When the last thought under fire was had, and the health then: thought again as things get worse. */
  private underFireAt = -Infinity;
  private underFireHealth = 20;
  /** A thought under fire is asked for and not yet had. */
  private underFireQueued = false;
  /** A question put to us, still to be answered: a later reason to decide doesn't push it out of the queue. */
  private asked: { reason: string; ctx: DecideContext; at: number } | null = null;
  private readonly now: () => number;

  private readonly rng: () => number;
  /** When we last warned someone off (or meant to: `line`, by the decision), and at which rung (words come now and
   *  then, and again when it gets worse). */
  private readonly warned = new Map<AgentName, { at: number; rung: number; decisionId: string; line: boolean }>();
  /** When we last grumbled to someone, or called on them to rise (`inform:Y`, `rally:Y`). */
  private readonly spoke = new Map<string, number>();
  /** Lines put to us that a decision has answered (utterance ids, the latest few hundred). */
  private readonly answered = new Set<string>();

  constructor(private readonly o: CCOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
  }

  start(): void {
    const b = this.o.bus;
    // The end of one a newer decision replaced is no news: that decision is under way, and its own steps are still to
    // come (a look up's "wait 200 s more" in the hut before dawn was skipped so, its next step taking an agent out
    // among the zombies).
    this.offs.push(
      b.on('optionTerminated', (e) => {
        if (e.decisionId !== undefined && this.o.store.state.option?.decisionId !== e.decisionId) return;
        this.onEnded(e.ok, e.reason);
      }),
    );
    // Owner request, 2026-10-24: what stands out (what doesn't fit what the agent knows is possible, the first of a
    // remarkable thing) is thought about at once when it is strong; the rest waits for the next thought.
    this.offs.push(
      b.on('noticed', (e) => {
        if (e.notice.strength >= URGENT_STRENGTH) this.trigger(`you noticed: ${e.notice.text}`, { urgent: true });
      }),
    );
    // Something put off until a cue: the cue came.
    this.offs.push(b.on('cue', (e) => this.trigger(`you remember: you meant to ${e.deferred.what} once ${e.deferred.cue.replace(':', ' ')}, and now ${e.why}`, { urgent: !this.o.executor.busy })));
    this.offs.push(b.on('taskGiven', (e) => this.trigger(`${e.task.from} gave you a task: ${e.task.text}`, { urgent: true })));
    // Danger is thought about at once, as it starts and as it gets worse (a blow that takes a quarter of what is left,
    // the body taking back over from what was chosen); the reflexes are only the body's first response.
    this.offs.push(
      b.on('danger', (e) => {
        if (e.kind === 'hazard') return;
        this.thinkUnderFire(`danger: ${e.source}`, 2500);
      }),
    );
    this.offs.push(
      b.on('attacked', () => {
        const h = this.o.store.state.self.health;
        if (!this.o.store.state.flags.inDanger || this.underFireHealth - h < Math.max(3, this.underFireHealth / 4)) return;
        this.thinkUnderFire('you were hit again', 2000);
      }),
    );
    this.offs.push(
      b.on('dangerCleared', (e) => {
        const d = this.deferred;
        this.deferred = null;
        // How it ended, as it stands (one still about is not one fought off).
        const over = e.what ? `the danger is over: ${e.what}` : 'the danger is over';
        this.trigger(d ? `${over}; earlier: ${d.reason}` : over, d?.ctx ?? {});
      }),
    );
    this.offs.push(
      b.on('needsDecision', (e) => {
        if (e.reason === 'request') this.trigger(`${e.from ?? 'someone'} asked you something`, { convId: e.convId, from: e.from, urgent: true });
        // They took our offer: hand over our half (the deal's give task is queued).
        if (e.reason === 'deal') this.trigger(`${e.from ?? 'someone'} agreed to your trade`, { urgent: !this.o.executor.busy });
        // A group talk went on long enough (talking.ts): on with things.
        if (e.reason === 'talkedEnough') this.trigger('you have talked long enough for now; get on with things', { urgent: true });
      }),
    );
    this.offs.push(b.on('newGoal', (e) => this.trigger(`new goal: ${e.goal.text}`, { urgent: !this.o.executor.busy })));
    // A talk settled what to do (consensus.ts): on to it now, mid-stroll or mid-talk alike.
    this.offs.push(b.on('agreed', (e) => this.trigger(`you agreed${e.with.length > 0 ? ` with ${e.with.join(', ')}` : ''}: ${e.what}`, { urgent: true })));
    // §17.5: things getting worse with someone, or someone we're at odds with coming near, is worth a decision now,
    // even in the middle of a task.
    this.offs.push(
      b.on('rungChanged', (e) => {
        if (e.to > e.from) this.trigger(`things are getting worse with ${e.name}`, { atOdds: e.name, urgent: true });
      }),
    );
    this.offs.push(b.on('atOddsNearby', (e) => this.trigger(`${e.name} is here, and things are bad between you`, { atOdds: e.name, urgent: true })));
    this.offs.push(b.on('opening', (e) => this.trigger(`${e.name} is alone or hurt: a chance to deal with ${e.name} together`, { opening: e.name, urgent: true })));
    // §17.7: one we now follow. Urgent, so it is seen to mid-task: a stroll gives way to their side; work goes on.
    this.offs.push(
      b.on('leaderChanged', (e) => {
        if (e.leader) this.trigger(`you now follow ${e.leader}`, { leader: e.leader, urgent: true });
      }),
    );
    // What changed around us: something of ours broken or opened, anything right beside us, or a blast is worth a
    // decision now; at once if it opens the shelter we are in, or comes at night. (Blocks set down near a hut, a door
    // shut: news for the packet only.)
    let lastNoticed = -Infinity;
    this.offs.push(
      b.on('surroundingsChanged', (e) => {
        const c = e.change;
        const beside = c.where.startsWith('beside you') || c.where.startsWith('right ');
        const ours = c.ours !== undefined && (c.kind === 'broken' || c.kind === 'opened');
        if (!ours && !beside && c.by !== 'an explosion') return;
        const urgent = c.ours === 'shelter' || c.by === 'an explosion' || (ours && !this.o.store.state.self.isDay);
        if (!urgent && this.now() - lastNoticed < NOTICE_EVERY_MS) return;
        lastNoticed = this.now();
        this.trigger(`you noticed ${describeChange(c)} (at ${c.pos.x},${c.pos.y},${c.pos.z})`, { change: c, urgent });
      }),
    );
    this.offs.push(b.on('actionRecorded', (e) => this.onPromiseTaskResult(e.record)));
    // A promise that is settled (kept, broken or called off) has nothing left to do.
    this.offs.push(
      b.on('commitmentResolved', (e) =>
        this.o.store.update('taskQueue', (q) => (q.some((t) => t.commitmentId === e.commitmentId) ? q.filter((t) => t.commitmentId !== e.commitmentId) : q), 'promise settled'),
      ),
    );
    this.beat = setInterval(() => {
      const s = this.o.store.state;
      if (s.flags.inDanger || s.flags.paused || this.flight.inFlight('cc')) return;
      if (this.o.executor.busy) {
        const opt = s.option;
        const t = this.now();
        // A wait for something (the day, to heal) ends on its own and is broken by whatever happens; looked up from
        // every three minutes, one sealed in for the night went up into the dark to chop a tree "instead of standing
        // idle", and a zombie and a spider killed it.
        const waitingFor = opt?.skill === 'wait' && typeof opt.args?.until === 'string';
        if (opt?.status === 'running' && !waitingFor && t - opt.startedAt >= LOOK_UP_MS && t - this.lastDecisionAt >= LOOK_UP_MS) {
          this.trigger(`you have been at ${opt.skill ?? opt.option} for ${Math.round((t - opt.startedAt) / 60_000)} min${opt.progress ? ` (${opt.progress})` : ''}; you look up from the work a moment`, { urgent: true });
        }
        return;
      }
      if (this.now() - this.lastDecisionAt >= (this.o.heartbeatMs ?? 30_000)) this.trigger(this.lastDecisionAt === 0 ? 'you just arrived' : 'checking in');
    }, 2000);
    this.beat.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    for (const t of this.waiting) clearTimeout(t);
    this.waiting.clear();
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * §6.4: tasks done for a promise stay queued until they succeed, so a failed hand-over is tried again (stuck
   * detection stops endless retries; the deadline settles the rest). A give that finds us short gets the items first.
   */
  private onPromiseTaskResult(r: ActionRecord): void {
    const k = taskKey(r.skill, r.args);
    const q = this.o.store.state.taskQueue;
    const task = q.find((t) => t.source === 'commitment' && taskKey(t.skill, t.args) === k);
    if (!task) return;
    if (r.ok) {
      this.o.store.update('taskQueue', (all) => all.filter((t) => t.id !== task.id), 'promise task done');
      return;
    }
    const short = r.skill === 'give' && /^not enough /.test(r.error ?? '');
    const item = typeof r.args.item === 'string' ? r.args.item : undefined;
    if (!short || !item) return;
    const obtain = { item, qty: Number(r.args.qty ?? 1) };
    if (q.some((t) => t.skill === 'obtain' && taskKey(t.skill, t.args) === taskKey('obtain', obtain))) return;
    const now = this.now();
    const get: Task = { id: newId('t', now), skill: 'obtain', args: obtain, source: 'commitment', ...(task.commitmentId ? { commitmentId: task.commitmentId } : {}), createdAt: now, priority: task.priority, note: task.note ?? 'for a promise' };
    this.o.store.update('taskQueue', (all) => {
      const i = all.findIndex((t) => t.id === task.id);
      return i < 0 ? all : [...all.slice(0, i), get, ...all.slice(i)];
    }, 'get the promised items first');
  }

  /** A deal they agreed to after we offered (the trade tracker saw their "deal!"): both halves are promises now. */
  recordDeal(withWhom: AgentName, ours: readonly ItemStack[], theirs: readonly ItemStack[], convId = ''): void {
    this.recordPromises(dealDrafts(this.o.me, withWhom, ours, theirs), convId);
  }

  /**
   * Records commitments: ours go into the task queue too (get the items, hand them over); theirs only into
   * `commitments`, to be checked when they deliver. The same promise twice is recorded once.
   */
  private recordPromises(drafts: readonly CommitmentDraft[], convId: string): void {
    const { store } = this.o;
    const now = this.now();
    const key = (d: { debtor: string; creditor: string; what: Commitment['what'] }) => `${d.debtor}>${d.creditor}:${d.what.kind}:${d.what.item ?? d.what.text}`;
    const seen = new Set(store.state.commitments.filter((c) => c.status === 'accepted' || c.status === 'proposed').map(key));
    const made: Commitment[] = [];
    for (const d of drafts) {
      if (seen.has(key(d))) continue;
      seen.add(key(d));
      made.push({
        id: newId('k', now),
        debtor: d.debtor,
        creditor: d.creditor,
        what: d.what,
        ...(d.dueInSec ? { dueBy: now + d.dueInSec * 1000 } : {}),
        status: 'accepted',
        createdFromConv: convId,
        createdAt: now,
        ...(d.coerced ? { coerced: true } : {}),
      });
    }
    if (made.length === 0) return;
    store.update('commitments', (all) => [...all, ...made], 'promised');
    const have = (item: string) => {
      const m = itemMatcher(item);
      return store.state.self.inventory.filter((x) => m.matches(x.item)).reduce((a, x) => a + x.qty, 0);
    };
    const task = (k: Commitment, skill: string, args: Record<string, unknown>, note: string): Task => ({ id: newId('t', now), skill, args, source: 'commitment', commitmentId: k.id, createdAt: now, priority: 1, note });
    const tasks: Task[] = made
      .filter((k) => k.debtor === this.o.me)
      .flatMap((k): Task[] => {
        const w = k.what;
        if (!w.item) return [];
        const qty = w.qty ?? 1;
        if (w.kind === 'give') {
          const give = task(k, 'give', { to: k.creditor, item: w.item, qty }, `promised ${k.creditor}`);
          return have(w.item) >= qty ? [give] : [task(k, 'obtain', { item: w.item, qty }, `for ${k.creditor}`), give];
        }
        if (w.kind === 'gather') return [task(k, 'obtain', { item: w.item, qty }, `promised ${k.creditor}`)];
        // Help with gathering (§6.7): the help option does the work; what we gathered is handed over after.
        if (w.kind === 'help') return [task(k, 'give', { to: k.creditor, item: w.item, qty }, `helping ${k.creditor}`)];
        return [];
      });
    if (tasks.length > 0) store.update('taskQueue', (q) => [...tasks, ...q].slice(0, this.o.levers().queueDepth + tasks.length), 'promise tasks');
  }

  /** Validation context; an impulse's punch is judged as an impulse (§18.5: the gate at a lower bar). Modules the
   *  operator switched off (fights, courting, families) refuse what they would have allowed. */
  private env(isStuck: ValidationEnv['isStuck'], impulse = false): ValidationEnv {
    const s = this.o.store.state;
    const c = isOff(s, 'conflict') ? undefined : this.o.conflict;
    const romance = isOff(s, 'romance') ? null : this.o.romance;
    const family = isOff(s, 'family') ? null : this.o.family;
    return {
      me: this.o.me,
      isStuck,
      canPerceive: this.o.canPerceive,
      ...(this.o.isPerson ? { isPerson: this.o.isPerson } : {}),
      ...(c ? { mayFight: (target: AgentName, intent: 'brawl' | 'lethal', joining?: boolean) => c.mayFight(target, impulse ? 'impulse' : intent, { joining: joining === true }) } : {}),
      ...(this.o.romance ? { mayCourt: (name: AgentName) => (romance ? romance.mayCourt(name) : 'courting is switched off for you') } : {}),
      ...(this.o.family ? { mayStartFamily: (name: AgentName) => (family ? family.whyNotFamily(name) : 'starting a family is switched off for you') } : {}),
      ...(this.o.learned ? { learnedSkill: (name: string) => this.o.learned?.find(name) ?? null } : {}),
      // The code-only brain digs in at night (see codeDecision); a mind digs its own way.
      codeOnly: !this.o.llm,
      mayGo: (pos) => whyNotGo(this.o.store.state, pos),
      ...(this.o.chestAt ? { chestThere: (pos: { x: number; y: number; z: number }) => whyNoChest(this.o.store.state, pos, this.o.chestAt?.(pos) ?? null) } : {}),
    };
  }

  /** Sets the current goal (Goal Gen does this from M4 on; the runner/tests before that). */
  setGoal(text: string, doneWhen?: string): Goal {
    const goal: Goal = { id: newId('g', this.now()), text, kind: 'current', createdAt: this.now(), status: 'active', ...(doneWhen ? { doneWhen } : {}) };
    this.o.store.update('goals', (g) => ({ ...g, current: goal, history: g.current ? [...g.history, { ...g.current, status: 'abandoned' as const }].slice(-20) : g.history }), 'goal set');
    this.o.bus.emit({ type: 'newGoal', goal });
    return goal;
  }

  /**
   * The operator's decision (debug controls): tidied and checked like the model's, then carried out as any other
   * (source 'operator'). Returns why it can't be used, or null once it is under way.
   */
  force(raw: unknown): string | null {
    const isStuck = (skill: string, args: Record<string, unknown>) => this.o.awareness.isStuckOn(skill, args);
    const parsed = DecisionOutputSchema.safeParse(this.tidy(raw));
    if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    const why = validateDecision(parsed.data, this.env(isStuck));
    if (why) return why;
    this.apply(parsed.data, 'operator', {});
    return null;
  }

  /** A decision as written (the model's, or the operator's), tidied and with its item task routed (itemTasks.ts). */
  private tidy(raw: unknown): unknown {
    const d = tidyDecision(raw, { me: this.o.me, isSkill: (n) => Boolean(getSkill(n) ?? this.o.learned?.find(n)) });
    const task = typeof d === 'object' && d !== null ? (d as { task?: unknown }).task : undefined;
    if (typeof task !== 'object' || task === null) return d;
    const t = task as { skill: string; args: Record<string, unknown> };
    return { ...(d as object), task: routeItemTask(t, (n) => getSkill(n)?.name ?? null, (item) => held(this.o.store.state, item)) };
  }

  /** The packet the CC would see if it decided now (debug controls). */
  async packetNow(reason = 'the operator is looking'): Promise<string> {
    const L = this.o.levers();
    const memories = this.o.memories ? await this.o.memories(L.memories).catch(() => []) : [];
    return buildPacket({ state: this.o.store.state, levers: L, reason, stuck: this.o.awareness.stuckList(), memories, mind: this.o.mindLines?.() ?? [], knowledge: this.o.knowledge?.() ?? [], now: this.now() });
  }

  /** A quirk or emotion takes over briefly (source 'impulse'); the CC resumes the plan when it ends. */
  impulse(out: DecisionOutput): boolean {
    const s = this.o.store.state;
    if (s.flags.inDanger || s.flags.paused) return false;
    const env = this.env((k, a) => this.o.awareness.isStuckOn(k, a), true);
    if (validateDecision(out, env)) return false;
    this.apply(out, 'impulse', {});
    return true;
  }

  /** A thought had in danger, not more often than `everyMs` (one under way is enough). */
  private thinkUnderFire(why: string, everyMs: number): void {
    const t = this.now();
    // One thought under fire under way is enough. A decision of before the danger in flight is no reason to wait for
    // the next blow: the danger drops it, and this thought comes next (skipped so, five zombies took a body from 7
    // health to none before any thought came).
    if (t - this.underFireAt < everyMs || this.underFireQueued) return;
    this.underFireQueued = true;
    this.trigger(why, { urgent: true, emergency: true });
  }

  trigger(reason: string, ctx: DecideContext = {}): void {
    if (this.o.store.state.flags.inDanger && !ctx.emergency) {
      // The reflex owns the body; decide when it's over (§4.5). A question put to us is kept over lesser reasons.
      if (ctx.from || !this.deferred?.ctx.from) this.deferred = { reason, ctx };
      return;
    }
    // Rate cap (§13 rule 6): non-urgent decisions at most every 2 s.
    const wait = ctx.urgent ? 0 : this.lastDecisionAt + 2000 - this.now();
    if (wait > 0) {
      const t = setTimeout(() => {
        this.waiting.delete(t);
        this.kick(reason, ctx);
      }, wait);
      t.unref();
      this.waiting.add(t);
      return;
    }
    this.kick(reason, ctx);
  }

  private kick(reason: string, ctx: DecideContext): void {
    if (ctx.from) this.asked = { reason, ctx, at: this.now() };
    this.flight
      .run('cc', async () => {
        // A decision waiting behind a running one replaces any older one waiting; a question put to us (a request,
        // a demand) is answered first all the same, while still fresh, and the later reason is taken up after it.
        const q = this.asked && this.now() - this.asked.at < ASKED_FRESH_MS ? this.asked : null;
        this.asked = null;
        if (!q || q.ctx === ctx) return this.decide(reason, ctx);
        await this.decide(q.reason, q.ctx);
        if (ctx.urgent) this.trigger(reason, ctx);
      })
      .catch((err: unknown) => this.o.logger.warn({ module: 'cc', reason, err: String(err) }, 'decision failed'));
  }

  private checkGoal(): void {
    const g = this.o.store.state.goals.current;
    if (!g?.doneWhen || evalCondition(g.doneWhen, this.o.store.state) !== true) return;
    const done: Goal = { ...g, status: 'done' };
    this.o.store.update('goals', (x) => ({ ...x, current: null, history: [...x.history, done].slice(-20) }), 'goal done');
    this.o.bus.emit({ type: 'goalDone', goal: done });
  }

  private async decide(reason: string, ctx: DecideContext): Promise<void> {
    try {
      await this.decideNow(reason, ctx);
    } finally {
      if (ctx.emergency) this.underFireQueued = false;
    }
  }

  private async decideNow(reason: string, ctx: DecideContext): Promise<void> {
    if (this.stopped) return;
    this.o.refreshSelf?.();
    this.checkGoal();
    const { store, logger } = this.o;
    const s = store.state;
    if ((s.flags.inDanger && !ctx.emergency) || (ctx.emergency && !s.flags.inDanger) || s.flags.paused) return;
    const busy = this.o.executor.busy;
    if (busy && !ctx.urgent) return;
    if (ctx.emergency) {
      this.underFireAt = this.now();
      this.underFireHealth = s.self.health;
      // What the body is doing meanwhile, and that the choice is the mind's: said in the reason it thinks now.
      const body = this.o.bodyInDanger?.();
      reason = `${reason}${body ? `; your body is ${body}` : ''}. You are in danger now: think fast. What you choose is done at once (run somewhere, eat, dig, block a way, fight, ...); until you choose, your body keeps on as it is`;
    }
    const isStuck = (skill: string, args: Record<string, unknown>) => this.o.awareness.isStuckOn(skill, args);
    const env = this.env(isStuck);
    let out: DecisionOutput | null = null;
    let source: Decision['source'] = 'default';
    const L = this.o.levers();
    if (this.o.llm && !isOff(s, 'cc.llm')) {
      // Plans are made by Goal Gen (L3); a decision is the next step, on the CC's own tier.
      const tier = L.ccTier;
      const learned = this.o.learned?.offered() ?? [];
      // In a danger, a glance and a choice: the seven steps are for when there is time.
      const thinking = ctx.emergency ? UNDER_FIRE_THINKING : THINKING;
      const format = ctx.emergency ? `${DECISION_FORMAT}\n${UNDER_FIRE_FORMAT}` : DECISION_FORMAT;
      const system = `${personaCore(s.self.persona, s.traitAnnotations)}\n${DEATH_RULE}\n\n${EXPERIENCE}\n\n${thinking}\n\nYou decide what ${s.self.persona.name} does next.\n${CHOICES}\n\nSkills:\n${skillCatalog()}${learned.length > 0 ? `\n${learned.map((l) => `- ${l}`).join('\n')}` : ''}\n\n${format}`;
      const memories = this.o.memories ? await this.o.memories(L.memories).catch(() => []) : [];
      const packet = buildPacket({ state: store.state, levers: L, reason, stuck: this.o.awareness.stuckList(), memories, mind: this.o.mindLines?.() ?? [], knowledge: this.o.knowledge?.() ?? [], now: this.now() });
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: packet },
      ];
      const guard = store.guard(ctx.emergency ? CC_UNDER_FIRE_POLICY : CC_POLICY);
      const exchange: Exchange = { at: this.now(), reason, tier, packet, replies: [] };
      this.lastExchange = exchange;
      try {
        for (let attempt = 0; attempt < 2 && !out; attempt++) {
          const r = await this.o.llm.call<DecisionOutput | null>({
            tier,
            module: 'cc',
            agent: this.o.me,
            ...(this.o.mindModels && this.o.mindModels.length > 0 ? { prefer: this.o.mindModels } : {}),
            // Under fire, a slow reply gives way to the next model sooner (one took 34 s; the danger doesn't wait).
            ...(ctx.emergency ? { timeoutMs: Math.min(this.o.mindTimeoutMs ?? UNDER_FIRE_TIMEOUT_MS, UNDER_FIRE_TIMEOUT_MS) } : this.o.mindTimeoutMs ? { timeoutMs: this.o.mindTimeoutMs } : {}),
            messages,
            schema: DecisionOutputSchema,
            schemaName: 'decision',
            formatInPrompt: true,
            prepare: (json) => this.tidy(json),
            fallback: () => null,
            signal: guard.signal,
            isStale: guard.isStale,
          });
          exchange.replies.push(r.ok ? { model: r.model, text: r.text.slice(0, 2000) } : { model: null, text: '', error: `${r.reason}${r.error ? `: ${r.error}` : ''}` });
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
          this.ruleOut(r.value.task ? `${r.value.task.skill} ${JSON.stringify(r.value.task.args ?? {})}` : r.value.option, why);
          const last = exchange.replies.at(-1);
          if (last) last.rejected = why;
          // M10: a skill reached for that there is none of: the skill writer may write it (if it may write at all).
          const task = r.value.task;
          if (task && why.startsWith('there is no skill')) this.o.bus.emit({ type: 'skillWanted', name: task.skill, args: task.args, why: r.value.rationale });
          messages.push({ role: 'assistant', content: r.text.slice(0, 2000) }, { role: 'user', content: `That decision can't be used: ${why}. Decide again.` });
        }
      } finally {
        guard.dispose();
      }
    }
    // Under fire with no thought come (the model slow or down): the body's own response goes on.
    if (!out && ctx.emergency) return;
    if (!out) {
      const candidates = this.o.socialCandidates?.() ?? [];
      const claim = this.o.claimToCheck?.();
      const c = isOff(store.state, 'conflict') ? undefined : this.o.conflict;
      const t = this.now();
      const conflict: ConflictView | undefined = c && {
        rungOf: (n) => c.rungOf(n),
        fearOf: (n) => c.fearOf(n),
        mayBrawl: (n) => c.mayFight(n, 'brawl') === null,
        mayKill: (n) => c.mayFight(n, 'lethal') === null,
        mayJoin: (n) => c.mayFight(n, 'brawl', { joining: true }) === null,
        ...(c.resentmentOf ? { resentmentOf: (n: AgentName) => c.resentmentOf?.(n) ?? 0 } : {}),
        ...(c.authorityOf ? { authorityOf: (n: AgentName) => c.authorityOf?.(n) ?? 0 } : {}),
        ...(c.bandwagon ? { bandwagon: (n: AgentName) => c.bandwagon?.(n) ?? 0 } : {}),
        ...(c.fearWith ? { fearWith: (n: AgentName, allies: readonly AgentName[]) => c.fearWith?.(n, allies) ?? c.fearOf(n) } : {}),
        tributeDue: (n) => tributeDue(store.state.commitments, this.o.me, n, t),
        demandPending: (n) => t - lastDemandSaid(store.state, n) < DEMAND_ANSWER_MS || paying(store.state.commitments, this.o.me, n, t),
        demandedLately: (n) => {
          // A fight with them since answers that demand: another beating takes another demand first.
          const said = lastDemandSaid(store.state, n);
          return t - said < DEMANDED_LATELY_MS && said > (store.state.social[n]?.lastFight?.ts ?? -Infinity);
        },
        warnedLately: (n) => {
          const w = this.warned.get(n);
          if (!w || t - w.at >= WARN_EVERY_MS || c.rungOf(n) > w.rung) return false;
          // A line counts once said, or while we're still on our way to say it.
          const o = store.state.option;
          return !w.line || lastSaidTo(store.state, n) >= w.at || (o?.decisionId === w.decisionId && o.status === 'running');
        },
      };
      out = codeDecision(store.state, ctx, busy, isStuck, {
        candidates,
        roll: this.rng(),
        ...(claim ? { claim } : {}),
        ...(this.o.liking ? { liking: this.o.liking } : {}),
        ...(conflict ? { conflict } : {}),
        ...(this.o.isItem ? { isItem: this.o.isItem } : {}),
        answered: this.answered,
        codeOnly: !this.o.llm,
        ...(this.o.romance && !isOff(store.state, 'romance') ? { romance: this.o.romance } : {}),
        ...(this.o.family && !isOff(store.state, 'family') ? { family: this.o.family } : {}),
        ...(this.o.power && c ? { power: { ...this.o.power, saidLately: (stance: 'inform' | 'rally', to: AgentName, within = SPOKE_EVERY_MS) => t - (this.spoke.get(`${stance}:${to}`) ?? -Infinity) < within } } : {}),
      });
      source = 'default';
      // Going on with what is under way needs no new checks: a fight went through the gate when it began.
      const cur = store.state.option;
      const goesOn = Boolean(out?.task && cur?.status === 'running' && cur.option === out.option && cur.skill && taskKey(cur.skill, cur.args ?? {}) === taskKey(out.task.skill, out.task.args));
      const why = out && !goesOn ? validateDecision(out, env) : null;
      if (out && why) {
        // An answer is said even when what it would have us go on with no longer holds: it goes out over a rest.
        const { task: _task, ...answer } = out;
        const said: DecisionOutput | null = ctx.from && out.speechIntent && out.option !== 'fight' ? { ...answer, option: 'rest', terminate: { maxSeconds: 20 } } : null;
        logger.debug({ module: 'cc', why, option: out.option, answer: Boolean(said) }, 'code default not valid');
        out = said && !validateDecision(said, env) ? said : null;
      }
    }
    if (!out) return;
    const made = this.apply(out, source, ctx, reason);
    if (source === 'llm') this.takeIn(out, made.id);
    // What they said to us is answered now.
    if (ctx.from) {
      for (const u of store.state.perception.heardSpeech) if (u.from === ctx.from && u.addressedToMe && (!ctx.convId || u.convId === ctx.convId)) this.answered.add(u.id);
      for (const id of [...this.answered].slice(0, Math.max(0, this.answered.size - 300))) this.answered.delete(id);
    }
  }

  private apply(out: DecisionOutput, source: Decision['source'], ctx: DecideContext, why?: string): Decision {
    const { store, bus, logger } = this.o;
    const now = this.now();
    const decision: Decision = { ...out, id: newId('d', now), createdAt: now, stateVersion: store.version, source };
    if (decision.task) {
      const skill = getSkill(decision.task.skill) ?? this.o.learned?.find(decision.task.skill) ?? null;
      if (skill) decision.task = { skill: skill.name, args: decision.task.args };
    }
    this.lastDecisionAt = now;
    this.ownOption = source === 'llm' || source === 'intention';
    store.set('decision', decision, `decision ${decision.option}`);
    // Warning someone off, or walking away from them, counts toward the next one (WARN_EVERY_MS).
    const stance = decision.speechIntent?.stance;
    const who = decision.target?.agent;
    const line = stance === 'hostile' || stance === 'threaten';
    if (who && (line || (decision.option === 'move' && decision.target?.pos))) this.warned.set(who, { at: now, rung: this.o.conflict?.rungOf(who) ?? 0, decisionId: decision.id, line });
    if (who && (stance === 'inform' || stance === 'rally')) this.spoke.set(`${stance}:${who}`, now);
    // Our own promises become commitments and tasks only when the CC allowed committing (§6.4); accepting a deal
    // also records their half of it (§6.6).
    if (decision.speechIntent?.mayCommit) {
      const own = (decision.commitmentsToCreate ?? []).filter((c) => c.debtor === this.o.me || c.debtor.toLowerCase() === 'you').map((c) => ({ ...c, debtor: this.o.me }));
      const t = decision.trade;
      const deal = t?.phase === 'accept' ? dealDrafts(this.o.me, t.with, t.give, t.want) : [];
      this.recordPromises([...own, ...deal], ctx.convId ?? '');
    }
    const cur = store.state.option;
    const underFire = store.state.flags.inDanger;
    // Under fire, getting away is the legs' to do: the mind chose it, and the body runs (the way back along the trail,
    // into a hut of one's own, up out of reach), the thought kept for what comes after.
    if (underFire && (decision.option === 'flee' || decision.task?.skill === 'flee')) {
      this.o.runNow?.();
      logger.info({ module: 'cc', source, option: decision.option, rationale: decision.rationale, ...(why ? { why } : {}) }, 'decision: get away (the body runs)');
      bus.emit({ type: 'decision', decision });
      return decision;
    }
    // The same thing goes on; but talking to (or following, helping) someone else is a new option.
    const sameTask =
      cur?.status === 'running' &&
      cur.option === decision.option &&
      (!WITH_SOMEONE.has(decision.option) || (cur.targetAgent ?? null) === (decision.target?.agent ?? null)) &&
      (!decision.task || (cur.skill !== undefined && (taskKey(cur.skill, cur.args ?? {}) === taskKey(decision.task.skill, decision.task.args) || sameFight(cur.skill, cur.args ?? {}, decision.task.skill, decision.task.args))));
    if (!sameTask) {
      // A queued task that is now being run leaves the queue (promise tasks only once they succeed).
      if (decision.task) {
        const k = taskKey(decision.task.skill, decision.task.args);
        const leaves = (t: Task) => taskKey(t.skill, t.args) === k && t.source !== 'commitment';
        store.update('taskQueue', (q) => (q.some(leaves) ? q.filter((t) => !leaves(t)) : q), 'task started');
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
          ...(underFire ? { underFire: true } : {}),
          status: 'running',
        },
        `option ${decision.option}`,
      );
    }
    logger.info(
      { module: 'cc', source, option: decision.option, task: decision.task, stance: decision.speechIntent?.stance, mayCommit: decision.speechIntent?.mayCommit, rationale: decision.rationale, ...(why ? { why } : {}) },
      'decision',
    );
    bus.emit({ type: 'decision', decision });
    return decision;
  }

  /**
   * What the option under way ended in (owner request, 2026-10-24: "a real player ... would not be so slow and rigid").
   * Done, with a next step meant: on to it at once, without stopping to think, as a person does what they set out to
   * do. Failed, nothing meant, or a new plan made since the steps were meant (they were for the old one): think.
   */
  private onEnded(ok: boolean, reason: string): void {
    const s = this.o.store.state;
    const meant = s.mind.intention;
    const replanned = meant !== null && (s.goals.plan?.createdAt ?? -Infinity) > meant.at;
    if (ok && meant && replanned) {
      this.o.store.update('mind', (m) => ({ ...m, intention: null }), 'a new plan since');
      this.trigger(`what you were doing is done (${reason}), and you have made a new plan since you decided what to do after it`);
      return;
    }
    const goesOn = !s.flags.inDanger || meant?.underFire === true;
    // The world changed since the steps were meant, as anyone takes note of: badly hurt (9 health to 1 on the way;
    // nobody goes on to "gather oak logs" at one heart without a thought), or night come on. The steps wait for one.
    const hurtSince = meant?.health !== undefined && s.self.health <= meant.health - HURT_SINCE;
    // A wait for something cut short before it came: what was meant for after it is not for now (a wait for the day,
    // broken off by a zombie at the door, and the next step went out for wool at 12 health among four monsters).
    const last = s.actionLog.at(-1);
    const until = last?.skill === 'wait' && typeof last.args?.until === 'string' ? last.args.until : null;
    const cutShort = until !== null && /stopped waiting early/.test(last?.observed ?? '');
    // A long wait is settled into where one stands, looked at first: one walked to his home's spot, a wall of his hut
    // by then, stopped outside it, and waited out the night there in the open until a zombie came.
    const step = meant?.steps[0];
    const waitUntil = typeof step?.args?.until === 'string' ? step.args.until : '';
    const longWait = step?.skill === 'wait' && (/^(day|night|timeIs:)/.test(waitUntil) || Number(step.args?.seconds ?? 0) >= 120);
    const openToWait = longWait && !s.self.isDay && /under the open sky/.test(s.scene.where ?? '');
    const since = hurtSince
      ? `you have been hurt since you decided (health ${Math.round(meant?.health ?? 0)} to ${Math.round(s.self.health)})`
      : cutShort
        ? `the wait for ${until} was cut short before it came (${last?.observed ?? ''})`
        : meant?.night === false && !s.self.isDay
          ? 'night has fallen since you decided'
          : openToWait
            ? `where you would wait is out in the dark: ${s.scene.where}`
            : null;
    if (ok && meant && this.ownOption && meant.steps.length > 0 && goesOn && since) {
      this.o.store.update('mind', (m) => ({ ...m, intention: null }), hurtSince ? 'hurt since' : cutShort ? 'wait cut short' : openToWait ? 'open to wait in' : 'night since');
      const next = meant.steps[0];
      this.trigger(`you meant to ${next?.skill ?? next?.text ?? 'go on'} next, but ${since}`, s.flags.inDanger ? { urgent: true, emergency: true } : { urgent: true });
      return;
    }
    if (ok && meant && this.ownOption && meant.steps.length > 0 && goesOn && !s.flags.paused && this.now() - meant.at < INTENTION_MS) {
      const [step, ...rest] = meant.steps;
      this.o.store.update('mind', (m) => ({ ...m, intention: rest.length > 0 ? { ...meant, steps: rest } : null }), 'next step');
      if (step?.skill) {
        const out: DecisionOutput = { option: 'work', task: { skill: step.skill, args: step.args ?? {} }, terminate: { maxSeconds: 600 }, rationale: `on with what I meant to do: ${meant.aim}` };
        const why = validateDecision(out, this.env((k, a) => this.o.awareness.isStuckOn(k, a)));
        if (!why) {
          this.apply(out, 'intention', {}, 'the next step');
          return;
        }
        this.o.logger.info({ module: 'cc', step, why }, 'next step not possible; thinking again');
        this.ruleOut(`${step.skill} ${JSON.stringify(step.args ?? {})}`, why);
        this.trigger(`you meant to ${step.skill} ${JSON.stringify(step.args ?? {})} next, but you can't: ${why}`);
        return;
      }
    }
    if (s.flags.inDanger) {
      // Under fire, what was chosen being over is a thought at once: the body only holds on meanwhile. What was under
      // way before the danger, cut short by it, is thought about with the danger itself.
      if (s.option?.underFire) this.trigger(ok ? `what you chose in the danger is done (${reason})` : `what you chose in the danger failed: ${reason}`, { urgent: true, emergency: true });
      else this.deferred = { reason: ok ? `what you were doing is done (${reason})` : `what you were doing failed: ${reason}`, ctx: {} };
      return;
    }
    this.trigger(ok ? `what you were doing is done (${reason})` : `what you were doing failed: ${reason}`);
  }

  /**
   * What was reached for and can't be done now, kept in mind a while: a solo agent at dusk reached for digging in to
   * hide five times in two minutes, told each time it was not scared enough, each decision starting afresh.
   */
  private ruleOut(what: string, why: string): void {
    const now = this.now();
    this.o.store.update(
      'mind',
      (m) => {
        const kept = (m.ruledOut ?? []).filter((x) => now - x.ts < RULED_OUT_MS);
        const same = kept.find((x) => x.why === why);
        const next = same ? kept.map((x) => (x === same ? { what, why, ts: now, n: x.n + 1 } : x)) : [...kept, { what, why, ts: now, n: 1 }];
        return { ...m, ruledOut: next.slice(-6) };
      },
      'ruled out',
    );
  }

  /** The thinking around a choice the model made: the thought kept, the steps meant next, a lesson, a thing put off, a task settled. */
  private takeIn(out: DecisionOutput, decisionId: string): void {
    const { store, bus } = this.o;
    const now = this.now();
    store.update(
      'mind',
      (m) => {
        let next = m;
        if (out.thought) next = { ...next, thoughts: [...next.thoughts, { ts: now, text: out.thought, decisionId }].slice(-8) };
        // "then" says what comes next (and [] that nothing does); without it, what was meant still stands.
        if (out.then) {
          const underFire = store.state.flags.inDanger;
          next = { ...next, intention: out.then.length > 0 ? { aim: out.rationale || out.thought || 'what I set out to do', steps: out.then.slice(0, 4), from: decisionId, at: now, health: store.state.self.health, night: !store.state.self.isDay, ...(underFire ? { underFire: true } : {}) } : null };
        }
        if (out.later) {
          const cue = cueFrom(out.later.when, now, store.state.self.isDay);
          if (cue) next = { ...next, later: [...next.later.filter((x) => x.what !== out.later?.what), { id: `l${now.toString(36)}`, what: out.later.what, ...cue, since: now }].slice(-6) };
        }
        return next;
      },
      'thought',
    );
    if (out.lesson) {
      const lesson = addLesson(store, out.lesson, 'thought', now);
      if (lesson) bus.emit({ type: 'learned', lesson });
    }
    for (const [text, status] of [
      [out.taskDone, 'done'],
      [out.taskDropped, 'dropped'],
    ] as const) {
      if (!text) continue;
      const t = matchTask(store.state.goals.tasks ?? [], text);
      if (t) store.update('goals', (g) => ({ ...g, tasks: (g.tasks ?? []).map((x) => (x.id === t.id ? { ...x, status, note: text } : x)) }), `task ${status}`);
    }
  }

  /** Someone gives this agent a task (owner request, 2026-10-24): it is taken on, and thought about now. */
  giveTask(text: string, from: string): AssignedTask {
    const now = this.now();
    const task: AssignedTask = { id: newId('t', now), text: text.slice(0, 300), from, at: now, status: 'open' };
    this.o.store.update('goals', (g) => ({ ...g, tasks: [...(g.tasks ?? []), task].slice(-12) }), 'task given');
    this.o.bus.emit({ type: 'taskGiven', task });
    return task;
  }
}

/** Steps meant this long ago are no longer carried on without a thought. */
const INTENTION_MS = 12 * 60_000;
/** What could not be done is kept in mind this long. */
export const RULED_OUT_MS = 10 * 60_000;
