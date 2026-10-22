// Cognitive Controller (§4.2 module 9, §4.3): the one place high-level decisions are made. It sees only the
// bottleneck packet, answers in strict JSON (zod-validated, one repair retry in the client) and broadcasts the
// decision: the executor runs its task, Talking phrases its speech intent. Woken by events (option ended, danger
// cleared, a request needing an answer, a new goal) plus a ≤ 30 s heartbeat when idle; while an option runs, only
// requests wake it (§4.4). Semantically wrong decisions get one retry with the reason, then the code default, which
// also keeps the agent working in code-only mode (§22.4).

import {
  type ActionRecord,
  type AgentName,
  type Commitment,
  type CommitmentDraft,
  type ConvId,
  type Decision,
  type DecisionOutput,
  DecisionOutputSchema,
  type Goal,
  type ItemStack,
  type Logger,
  type Task,
} from '@agora/shared';
import { type ChatMessage, type LlmClient, SingleFlight } from '@agora/llm';
import type { AgentBus } from '../bus';
import { itemMatcher } from '../body/items';
import { yieldHealth } from '../conflict/pressure';
import { type Offer, amountOf, judgeOffer, parseHelpRequest, parseTradeOffer, stacksText } from '../social/trades';
import { getSkill, skillCatalog } from '../body/skills/registry';
import { CC_POLICY } from '../state/policies';
import type { AgentStateStore } from '../state/store';
import type { ActionAwareness } from './awareness';
import { taskKey } from './awareness';
import { buildPacket } from './bottleneck';
import { evalCondition } from './conditions';
import { EXPLORE_ARGS, type SkillExecutor } from './executor';
import type { MindLevers } from './levers';
import { DEATH_RULE, DECISION_FORMAT, DECISION_RULES, personaCore } from './prompts';
import { villageWorkOf } from '../social/village';
import { deathNoticeMove, villageMove } from './villageMove';

export interface DecideContext {
  /** A request from someone that needs an answer (wakes the CC even mid-option). */
  convId?: ConvId;
  from?: AgentName;
  urgent?: boolean;
  /** Things just got worse with this person (a rung went up, §17.5): the conflict moves apply even mid-task. */
  atOdds?: AgentName;
}

export interface ValidationEnv {
  me: AgentName;
  isStuck: (skill: string, args: Record<string, unknown>) => boolean;
  canPerceive: (name: AgentName) => boolean;
  /** A person (not a mob): fighting them needs the gate. */
  isPerson?: (name: AgentName) => boolean;
  /** §17.5 code gate: null when a fight with them may happen, else why not. */
  mayFight?: (target: AgentName, intent: 'brawl' | 'lethal') => string | null;
}

/** Code checks on a schema-valid decision. Returns the reason it can't be used, or null. */
export function validateDecision(d: DecisionOutput, env: ValidationEnv): string | null {
  if ((d.option === 'work' || d.option === 'help') && !d.task) return `option ${d.option} needs a task (skill + args)`;
  // §17.5: fighting a person happens only through the code gate.
  const aimedAt = d.task?.args.target;
  const victim = d.option === 'fight' ? (d.fight?.target ?? d.target?.agent) : ['attack', 'duel'].includes(getSkill(d.task?.skill ?? '')?.name ?? '') && typeof aimedAt === 'string' ? aimedAt : '';
  if (victim && env.isPerson?.(victim)) {
    const why = env.mayFight ? env.mayFight(victim, d.fight?.intent ?? 'brawl') : 'fighting people is not possible here';
    if (why) return `you can't fight ${victim}: ${why}`;
  }
  if (d.option === 'fight' && !victim) return 'option fight needs fight.target';
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
}

export interface ConflictView {
  rungOf: (name: AgentName) => number;
  fearOf: (name: AgentName) => number;
  mayBrawl: (name: AgentName) => boolean;
  warnedLately: (name: AgentName) => boolean;
}

/** "can you give me 8 logs?", "bring me some bread", "I need some wood" → what and how many (default 1). */
export function parseItemRequest(text: string): { item: string; qty: number } | null {
  const m =
    /\b(?:give|bring|lend|spare|get|pass)\s+me\s+(?:some\s+|a\s+few\s+|a\s+couple\s+of\s+|a\s+|an\s+)?(\d{1,3})?\s*([a-z][a-z_]{1,23})/i.exec(text) ??
    /\bi\s+need\s+(?:some|a|an|any)\s+(\d{1,3})?\s*([a-z][a-z_]{1,23})/i.exec(text);
  if (!m?.[2]) return null;
  const word = m[2].toLowerCase();
  if (['hand', 'minute', 'moment', 'second', 'break', 'favor', 'favour', 'chance', 'ride'].includes(word)) return null;
  return { item: word.replace(/(ie)?s$/, (x) => (x === 'ies' ? 'y' : '')), qty: m[1] ? Number(m[1]) : 1 };
}

const GENEROUS = /generous|kind|helpful|giving|warm/i;
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
/** Hostile talk toward the same person at most this often. */
const WARN_EVERY_MS = 3 * 60_000;

type Ask = { kind: 'trade'; offer: Offer } | { kind: 'help'; item: string; qty: number } | { kind: 'item'; item: string; qty: number };

/** What a line asks of us, if anything: a trade offer, a hand with gathering, or some items. */
export function readAsk(text: string): Ask | null {
  const offer = parseTradeOffer(text);
  if (offer) return { kind: 'trade', offer };
  const help = parseHelpRequest(text);
  if (help) return { kind: 'help', ...help };
  const want = parseItemRequest(text);
  return want ? { kind: 'item', ...want } : null;
}

/**
 * The code default's answer to someone asking us something (§6.3 share policy, §6.6 trades, §6.7 help). A
 * follow-up ("so, can you?") refers back to what they asked earlier in this conversation; what we already promised
 * them is restated, never promised twice.
 */
function answerRequest(
  s: AgentStateStore['state'],
  from: AgentName,
  convId: ConvId | undefined,
  busy: boolean,
  isStuck: ValidationEnv['isStuck'],
  judge?: (name: AgentName) => number,
): DecisionOutput {
  const persona = s.self.persona;
  const me = s.self.username;
  const keep = busy ? (s.option?.option ?? 'rest') : 'rest';
  const theirs = s.perception.heardSpeech.filter((u) => u.from === from && u.addressedToMe && (!convId || u.convId === convId)).slice(-4);
  const ask = theirs.map((u) => readAsk(u.text)).filter((a) => a !== null).at(-1) ?? null;
  const liking = judge?.(from) ?? s.social[from]?.sentiment ?? persona.social.baselineSentiment;
  const owing = s.commitments.filter((c) => c.debtor === me && c.status === 'accepted').length;
  const have = (item: string) => {
    const m = itemMatcher(item);
    return s.self.inventory.filter((x) => m.matches(x.item)).reduce((a, x) => a + x.qty, 0);
  };
  const decline = (gist: string, rationale: string): DecisionOutput => ({
    option: keep,
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
        option: keep,
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
      ...(keepOn ?? { option: keep, terminate: { maxSeconds: 20 } }),
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

/** What the conflict rungs call for with the people nearby (§17.5), if anything. */
function conflictMove(s: AgentStateStore['state'], c: ConflictView, liking?: (name: AgentName) => number): DecisionOutput | null {
  const near = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.distance <= 12).sort((a, b) => c.rungOf(b.name) - c.rungOf(a.name));
  for (const e of near) {
    const rung = c.rungOf(e.name);
    if (rung >= 3 && c.mayBrawl(e.name)) {
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
    if (rung >= 1) {
      return {
        option: 'talk',
        target: { agent: e.name },
        speechIntent: rung >= 2 ? { stance: 'threaten', gist: 'warn them off: back off, or there will be trouble', mayCommit: false } : { stance: 'hostile', gist: 'tell them to keep their distance', mayCommit: false },
        terminate: { maxSeconds: 30 },
        rationale: `code default: warning ${e.name} off`,
      };
    }
    // Rung 0 (§17.5 avoid): someone we fear and don't like, close by: keep our distance.
    const like = liking?.(e.name) ?? s.social[e.name]?.sentiment ?? 5;
    if (e.distance <= 6 && like < 5 && c.fearOf(e.name) >= 0.7) {
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
  return null;
}

/** The non-LLM decision (§5 "CC default"), also the code-only brain (§22.4). Null = keep doing what you're doing. */
export function codeDecision(
  s: AgentStateStore['state'],
  ctx: DecideContext,
  busy: boolean,
  isStuck: ValidationEnv['isStuck'],
  social?: SocialChance,
): DecisionOutput | null {
  if (ctx.from) return answerRequest(s, ctx.from, ctx.convId, busy, isStuck, social?.liking);
  if (busy) return ctx.atOdds && social?.conflict ? conflictMove(s, social.conflict, social.liking) : null;
  // Survive the night (M1 shelter); a guard on duty stays out while fit for it.
  const village = villageWorkOf(s.goals.current?.doneWhen);
  const onGuard = village === 'guard' && s.self.health >= 12 && s.drives.caution < 0.8;
  if (!s.self.isDay && !s.flags.inDanger && !onGuard && !isStuck('shelter', { untilMorning: true })) {
    return { option: 'work', task: { skill: 'shelter', args: { untilMorning: true } }, terminate: { maxSeconds: 900 }, rationale: 'code default: night, dig in' };
  }
  // §17.5: someone we're at odds with nearby comes first: the brawl the gate allows, a warning, or keeping away.
  const odds = social?.conflict ? conflictMove(s, social.conflict, social.liking) : null;
  if (odds) return odds;
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
  // Work toward a goal with a machine-checkable target: obtain it (or the prerequisite it said to get first).
  const want = s.goals.current?.doneWhen ? /^inventoryHas:([a-z0-9_]+)\s*>=\s*(\d+)$/i.exec(s.goals.current.doneWhen) : null;
  if (want?.[1] && want[2]) {
    // Follow only the latest attempt: once the prerequisite is in hand (or the ore found), go back to the goal itself.
    // Interruptions (an impulse, a reflex) are not results; after looking around, try the goal again.
    const last = [...s.actionLog].reverse().find((a) => ['obtain', 'prospect', 'explore'].includes(a.skill) && !a.error?.startsWith('aborted'));
    const err = last && !last.ok ? (last.error ?? '') : '';
    const unseen = last?.skill === 'obtain' ? /haven't seen any ([a-z0-9_]+)/.exec(err)?.[1] : undefined;
    if (unseen && ORE_LIKE.test(unseen) && !isStuck('prospect', { item: unseen })) {
      return { option: 'work', task: { skill: 'prospect', args: { item: unseen } }, terminate: { maxSeconds: 420 }, rationale: `code default: dig for ${unseen}` };
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
    // Stuck on it for a while (the mark lasts minutes): look around a little, then give it a rest before trying again.
    const explored = s.actionLog.slice(-3).filter((a) => a.skill === 'explore').length;
    if (explored >= 2) return { option: 'rest', terminate: { maxSeconds: 60 }, rationale: 'code default: stuck on the goal; a break before trying again' };
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
  // Or say hello to someone nearby (§6.2 conversations start from the talk option).
  const who = social?.candidates[0];
  if (who && social.roll < s.self.persona.social.initiateChance) {
    return {
      option: 'talk',
      target: { agent: who },
      speechIntent: { stance: 'chat', gist: `say hello to ${who} and chat a little`, mayCommit: false },
      terminate: { maxSeconds: 90 },
      rationale: `code default: nothing to do, ${who} is here`,
    };
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
  memories?: (k: number) => Promise<string[]>;
  /** Brings the bot's own snapshot up to date before deciding (perception otherwise lags up to 250 ms). */
  refreshSelf?: () => void;
  /** People in range this agent may start talking to (for the code default's hello). */
  socialCandidates?: () => AgentName[];
  /** The nearest unchecked claim worth a look (§6.5). */
  claimToCheck?: () => SocialChance['claim'] | undefined;
  /** Gut/facts mix about someone (§18.5) and the packet's lines on feelings and people (§18.2). */
  liking?: (name: AgentName) => number;
  mindLines?: () => string[];
  /** The conflict core (§17.5); without it nobody fights anybody on purpose. */
  conflict?: { rungOf(name: AgentName): number; fearOf(name: AgentName): number; mayFight(target: AgentName, intent: 'brawl' | 'lethal' | 'impulse'): string | null };
  /** A person (fights with them are gated) rather than a mob. */
  isPerson?: (name: AgentName) => boolean;
  rng?: () => number;
  heartbeatMs?: number;
  now?: () => number;
}

export class CognitiveController {
  private readonly flight = new SingleFlight<void>();
  private readonly offs: (() => void)[] = [];
  private beat: NodeJS.Timeout | null = null;
  /** Decisions held back by the rate cap: cleared on stop, so none fires into a stopped agent. */
  private readonly waiting = new Set<NodeJS.Timeout>();
  private stopped = false;
  private lastDecisionAt = 0;
  private deferred: { reason: string; ctx: DecideContext } | null = null;
  private readonly now: () => number;

  private readonly rng: () => number;
  /** When we last warned someone off, and at which rung (words come now and then, and again when it gets worse). */
  private readonly warned = new Map<AgentName, { at: number; rung: number }>();

  constructor(private readonly o: CCOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
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
        // They took our offer: hand over our half (the deal's give task is queued).
        if (e.reason === 'deal') this.trigger(`${e.from ?? 'someone'} agreed to your trade`, { urgent: !this.o.executor.busy });
      }),
    );
    this.offs.push(b.on('newGoal', (e) => this.trigger(`new goal: ${e.goal.text}`, { urgent: !this.o.executor.busy })));
    // §17.5: things getting worse with someone, or someone we're at odds with coming near, is worth a decision now,
    // even in the middle of a task.
    this.offs.push(
      b.on('rungChanged', (e) => {
        if (e.to > e.from) this.trigger(`things are getting worse with ${e.name}`, { atOdds: e.name, urgent: true });
      }),
    );
    this.offs.push(b.on('atOddsNearby', (e) => this.trigger(`${e.name} is here, and things are bad between you`, { atOdds: e.name, urgent: true })));
    this.offs.push(b.on('actionRecorded', (e) => this.onPromiseTaskResult(e.record)));
    // A promise that is settled (kept, broken or called off) has nothing left to do.
    this.offs.push(
      b.on('commitmentResolved', (e) =>
        this.o.store.update('taskQueue', (q) => (q.some((t) => t.commitmentId === e.commitmentId) ? q.filter((t) => t.commitmentId !== e.commitmentId) : q), 'promise settled'),
      ),
    );
    this.beat = setInterval(() => {
      const s = this.o.store.state;
      if (s.flags.inDanger || this.o.executor.busy || this.flight.inFlight('cc')) return;
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

  /** Validation context; an impulse's punch is judged as an impulse (§18.5: the gate at a lower bar). */
  private env(isStuck: ValidationEnv['isStuck'], impulse = false): ValidationEnv {
    const c = this.o.conflict;
    return {
      me: this.o.me,
      isStuck,
      canPerceive: this.o.canPerceive,
      ...(this.o.isPerson ? { isPerson: this.o.isPerson } : {}),
      ...(c ? { mayFight: (target: AgentName, intent: 'brawl' | 'lethal') => c.mayFight(target, impulse ? 'impulse' : intent) } : {}),
    };
  }

  /** Sets the current goal (Goal Gen does this from M4 on; the runner/tests before that). */
  setGoal(text: string, doneWhen?: string): Goal {
    const goal: Goal = { id: newId('g', this.now()), text, kind: 'current', createdAt: this.now(), status: 'active', ...(doneWhen ? { doneWhen } : {}) };
    this.o.store.update('goals', (g) => ({ ...g, current: goal, history: g.current ? [...g.history, { ...g.current, status: 'abandoned' as const }].slice(-20) : g.history }), 'goal set');
    this.o.bus.emit({ type: 'newGoal', goal });
    return goal;
  }

  /** A quirk or emotion takes over briefly (source 'impulse'); the CC resumes the plan when it ends. */
  impulse(out: DecisionOutput): boolean {
    const s = this.o.store.state;
    if (s.flags.inDanger) return false;
    const env = this.env((k, a) => this.o.awareness.isStuckOn(k, a), true);
    if (validateDecision(out, env)) return false;
    this.apply(out, 'impulse', {});
    return true;
  }

  trigger(reason: string, ctx: DecideContext = {}): void {
    if (this.o.store.state.flags.inDanger) {
      // The reflex owns the body; decide when it's over (§4.5).
      this.deferred = { reason, ctx };
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
    this.flight.run('cc', () => this.decide(reason, ctx)).catch((err: unknown) => this.o.logger.warn({ module: 'cc', reason, err: String(err) }, 'decision failed'));
  }

  private checkGoal(): void {
    const g = this.o.store.state.goals.current;
    if (!g?.doneWhen || evalCondition(g.doneWhen, this.o.store.state) !== true) return;
    const done: Goal = { ...g, status: 'done' };
    this.o.store.update('goals', (x) => ({ ...x, current: null, history: [...x.history, done].slice(-20) }), 'goal done');
    this.o.bus.emit({ type: 'goalDone', goal: done });
  }

  private async decide(reason: string, ctx: DecideContext): Promise<void> {
    if (this.stopped) return;
    this.o.refreshSelf?.();
    this.checkGoal();
    const { store, logger } = this.o;
    const s = store.state;
    if (s.flags.inDanger) return;
    const busy = this.o.executor.busy;
    if (busy && !ctx.urgent) return;
    const isStuck = (skill: string, args: Record<string, unknown>) => this.o.awareness.isStuckOn(skill, args);
    const env = this.env(isStuck);
    let out: DecisionOutput | null = null;
    let source: Decision['source'] = 'default';
    const L = this.o.levers();
    if (this.o.llm && !s.flags.codeOnly) {
      const tier = reason.startsWith('new goal') && L.planningBurst ? 'L3' : L.ccTier;
      const system = `${personaCore(s.self.persona, s.traitAnnotations)}\n${DEATH_RULE}\n\nYou decide what ${s.self.persona.name} does next.\n${DECISION_RULES}\n\nSkills:\n${skillCatalog()}\n\n${DECISION_FORMAT}`;
      const memories = this.o.memories ? await this.o.memories(L.memories).catch(() => []) : [];
      const packet = buildPacket({ state: store.state, levers: L, reason, stuck: this.o.awareness.stuckList(), memories, mind: this.o.mindLines?.() ?? [], now: this.now() });
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
      const candidates = this.o.socialCandidates?.() ?? [];
      const claim = this.o.claimToCheck?.();
      const c = this.o.conflict;
      const t = this.now();
      const conflict: ConflictView | undefined = c && {
        rungOf: (n) => c.rungOf(n),
        fearOf: (n) => c.fearOf(n),
        mayBrawl: (n) => c.mayFight(n, 'brawl') === null,
        warnedLately: (n) => {
          const w = this.warned.get(n);
          return Boolean(w && t - w.at < WARN_EVERY_MS && c.rungOf(n) <= w.rung);
        },
      };
      out = codeDecision(store.state, ctx, busy, isStuck, { candidates, roll: this.rng(), ...(claim ? { claim } : {}), ...(this.o.liking ? { liking: this.o.liking } : {}), ...(conflict ? { conflict } : {}) });
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
    // Warning someone off, or walking away from them, counts toward the next one (WARN_EVERY_MS).
    const stance = decision.speechIntent?.stance;
    const who = decision.target?.agent;
    if (who && (stance === 'hostile' || stance === 'threaten' || (decision.option === 'move' && decision.target?.pos))) this.warned.set(who, { at: now, rung: this.o.conflict?.rungOf(who) ?? 0 });
    // Our own promises become commitments and tasks only when the CC allowed committing (§6.4); accepting a deal
    // also records their half of it (§6.6).
    if (decision.speechIntent?.mayCommit) {
      const own = (decision.commitmentsToCreate ?? []).filter((c) => c.debtor === this.o.me || c.debtor.toLowerCase() === 'you').map((c) => ({ ...c, debtor: this.o.me }));
      const t = decision.trade;
      const deal = t?.phase === 'accept' ? dealDrafts(this.o.me, t.with, t.give, t.want) : [];
      this.recordPromises([...own, ...deal], ctx.convId ?? '');
    }
    const cur = store.state.option;
    const sameTask =
      cur?.status === 'running' &&
      cur.option === decision.option &&
      (!decision.task || (cur.skill !== undefined && taskKey(cur.skill, cur.args ?? {}) === taskKey(decision.task.skill, decision.task.args)));
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
