// The code default's moves for power structures (§17.7, §17.8). A follower goes about with its leader. Someone who
// resents a person grumbles about them to a friend, out of their earshot, and says it as a shared grudge when the
// friend resents them too. When the odds or the moment favor it (the target alone or hurt), the ambitious, the
// vengeful or the loyal rally those who share the grudge; and those sworn to take someone on meet up and go after
// them together. The fight itself still goes through the conflict gate (§17.5): rung 3 a brawl, rung 4 to the death.

import type { AgentName, AgentState, DecisionOutput } from '@agora/shared';
import { mayRally } from '../conflict/coercion';
import { spareChance, yieldHealth } from '../conflict/pressure';

/** At a moment like that (alone or hurt), a call to rise may be made again this soon. */
const RALLY_AGAIN_MS = 2 * 60_000;

export interface PowerView {
  /** Whom we follow (§17.7), or null. */
  leader: () => AgentName | null;
  /** §17.8 coalitionPower against someone: who would join, our side's power, theirs, and whether this is the moment. */
  coalition: (target: AgentName) => { members: AgentName[]; power: number; against: number; opening: boolean };
  /** People we believe resent someone (§17.8 knownResenters). */
  knownResenters: (target: AgentName) => AgentName[];
  /** We said this kind of thing to them lately: grumbling (`inform`) or a call to rise (`rally`). */
  saidLately: (stance: 'inform' | 'rally', to: AgentName, withinMs?: number) => boolean;
}

export interface PowerMoveCtx {
  isStuck: (skill: string, args: Record<string, unknown>) => boolean;
  power: PowerView;
  resentmentOf: (name: AgentName) => number;
  mayBrawl: (name: AgentName) => boolean;
  mayKill: (name: AgentName) => boolean;
  liking: (name: AgentName) => number;
  /** People in range we may start a conversation with now. */
  candidates: readonly AgentName[];
  roll: number;
}

/** Within this, someone hears what is said about them. */
const EARSHOT = 20;
/** Resentment worth speaking of. */
const GRUDGE = 0.4;
/** Sworn allies count as with us within this (§17.6 groupAttack). */
const TOGETHER = 10;

const player = (s: AgentState, name: AgentName) => s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === name);

/** Whom we resent enough to speak against, most first. */
function grudges(s: AgentState, v: PowerMoveCtx): AgentName[] {
  return Object.keys(s.social)
    .filter((n) => n !== s.self.username && v.resentmentOf(n) >= GRUDGE)
    .sort((a, b) => v.resentmentOf(b) - v.resentmentOf(a));
}

/** §17.7: a follower stays near its leader (and the reflexes defend the leader). */
export function escortMove(s: AgentState, v: PowerMoveCtx): DecisionOutput | null {
  const leader = v.power.leader();
  const them = leader ? player(s, leader) : undefined;
  if (!leader || !them || them.distance <= 8 || them.distance > 48 || v.isStuck('follow', { agent: leader, distance: 3 })) return null;
  return { option: 'follow', target: { agent: leader }, terminate: { maxSeconds: 60 }, rationale: `code default: staying with ${leader}` };
}

/** §17.8 grievance sharing: grumbling about X to a friend out of X's earshot; a grudge they share is said as one. */
export function gossipMove(s: AgentState, v: PowerMoveCtx): DecisionOutput | null {
  const foes = grudges(s, v);
  if (foes.length === 0) return null;
  for (const y of v.candidates) {
    if (foes.includes(y) || v.liking(y) < 6 || v.power.saidLately('inform', y)) continue;
    const x = foes.find((f) => f !== y && (player(s, f)?.distance ?? Infinity) > EARSHOT);
    if (!x) continue;
    const shared = v.power.knownResenters(x).includes(y);
    if (!shared && v.roll >= 0.35) continue;
    return {
      option: 'talk',
      target: { agent: y },
      speechIntent: { stance: 'inform', gist: shared ? `${x} wronged you too. ${x} is a bully, I can't stand ${x}.` : `${x} is a bully. I can't stand ${x}.`, mayCommit: false },
      terminate: { maxSeconds: 60 },
      rationale: shared ? `code default: ${y} and I share a grudge against ${x}` : `code default: grumbling to ${y} about ${x}`,
    };
  }
  return null;
}

/** §17.8: an uprising against X proposed to one who resents X too, when the odds or the moment favor it. */
export function rallyMove(s: AgentState, v: PowerMoveCtx): DecisionOutput | null {
  const t = s.self.persona.temperament;
  const leader = v.power.leader();
  for (const x of grudges(s, v)) {
    if (x === leader || s.commitments.some((c) => c.what.kind === 'fight' && c.what.target === x && c.status === 'accepted')) continue;
    const c = v.power.coalition(x);
    if (!mayRally({ resentment: v.resentmentOf(x), ambition: t.ambition, vengefulness: t.vengefulness, loyalty: t.loyalty, members: c.members.length, power: c.power, against: c.against, opening: c.opening })) continue;
    // The moment (they're alone or hurt) is worth a call again, even to someone already called on not long ago.
    const y = c.members.find((m) => v.candidates.includes(m) && !v.power.saidLately('rally', m, c.opening ? RALLY_AGAIN_MS : undefined));
    if (!y) continue;
    return {
      option: 'recruit',
      target: { agent: y },
      speechIntent: { stance: 'rally', gist: `${x} has pushed us around long enough. let's deal with ${x} together.`, mayCommit: false },
      terminate: { maxSeconds: 60 },
      rationale: `code default: rallying ${y} against ${x}${c.opening ? ` (${x} is alone or hurt)` : ''}`,
    };
  }
  return null;
}

/**
 * §17.8 execution: those sworn to take X on meet up, go where X is, and set upon X together once all are at hand;
 * the gate decides between a brawl and a fight to the death, and lets nothing through before the anger is there.
 */
export function uprisingMove(s: AgentState, v: PowerMoveCtx): DecisionOutput | null {
  const me = s.self.username;
  const pacts = s.commitments.filter((c) => c.what.kind === 'fight' && c.status === 'accepted' && c.what.target && (c.debtor === me || c.creditor === me));
  const x = pacts[0]?.what.target;
  if (!x) return null;
  const sworn = pacts.filter((c) => c.what.target === x).map((c) => (c.debtor === me ? c.creditor : c.debtor));
  const alliesNear = sworn.filter((n) => (player(s, n)?.distance ?? Infinity) <= TOGETHER);
  const them = player(s, x);
  if (them && them.distance <= 24 && alliesNear.length > 0) {
    const lethal = v.mayKill(x);
    if (lethal || v.mayBrawl(x)) {
      const spare = spareChance(s.self.persona.temperament.mercy, v.resentmentOf(x), 4);
      return {
        option: 'fight',
        target: { agent: x },
        task: { skill: 'duel', args: { target: x, stopAtHealth: yieldHealth(s.drives.caution), seconds: 120, ...(lethal ? { lethal: true, spareChance: Math.round(spare * 100) / 100 } : {}) } },
        fight: { target: x, intent: lethal ? 'lethal' : 'brawl', withAllies: alliesNear },
        speechIntent: { stance: 'threaten', gist: `now! we've had enough of you, ${x}`, mayCommit: false },
        terminate: { maxSeconds: 150 },
        rationale: `code default: with ${alliesNear.join(' and ')}, taking on ${x}`,
      };
    }
    // All here, but the anger isn't there yet: close in on X with the others and let it build.
    if (v.isStuck('follow', { agent: x, distance: 3 })) return null;
    return { option: 'follow', target: { agent: x }, terminate: { maxSeconds: 30 }, rationale: `code default: closing in on ${x} with ${alliesNear.join(' and ')}` };
  }
  // Meet up first: with the nearest sworn ally in sight, else where one was last seen.
  if (alliesNear.length === 0) {
    const inSight = sworn.find((n) => player(s, n));
    if (inSight && !v.isStuck('follow', { agent: inSight, distance: 3 })) {
      return { option: 'follow', target: { agent: inSight }, terminate: { maxSeconds: 45 }, rationale: `code default: meeting up with ${inSight} against ${x}` };
    }
    const last = sworn.map((n) => s.social[n]?.lastSeenPos).find(Boolean);
    const args = last ? { x: Math.round(last.x), y: Math.round(last.y), z: Math.round(last.z), range: 3 } : null;
    if (args && !v.isStuck('goTo', args)) return { option: 'work', task: { skill: 'goTo', args }, terminate: { maxSeconds: 90 }, rationale: `code default: going to meet the others against ${x}` };
    return null;
  }
  // Together, with X out of sight: go where X was last seen.
  const seen = s.social[x]?.lastSeenPos;
  const args = seen ? { x: Math.round(seen.x), y: Math.round(seen.y), z: Math.round(seen.z), range: 4 } : null;
  if (args && !v.isStuck('goTo', args)) return { option: 'work', task: { skill: 'goTo', args }, terminate: { maxSeconds: 90 }, rationale: `code default: looking for ${x} with ${alliesNear.join(' and ')}` };
  return null;
}
