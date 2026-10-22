// Coercion, followers and leaders (§17.7), all code. A demand is a request with a threat on it ("give me 5 iron, or
// else"); the target complies when fear of the demander beats resentment and pride, and then owes it as a coerced
// commitment. Each payment adds a small `coercion` grievance against the demander, so tribute breeds resentment.
// Someone who keeps complying with X, or who seeks X's protection, follows X; someone followed by two or more is a
// leader, to those who see it.

import type { AgentName } from '@agora/shared';

export interface Demand {
  item: string;
  qty: number;
  /** "every day": tribute rather than a one-off. */
  recurring: boolean;
}

/** The threat that turns a request into a demand. */
const THREAT = /\b(or else|or you'?ll (regret|be sorry|pay)|or i'?ll|or we fight|or there'?ll be trouble|unless you want (trouble|a fight)|if you know what'?s good for you|or face me|hand it over|or get hurt)\b/i;
const ASK = /\b(?:give|bring|hand(?:\s+over)?|pay)\s+(?:me|us)?\s*(?:some\s+|a\s+|an\s+|your\s+)?(\d{1,3})?\s*([a-z][a-z_]{1,23})/i;
const NOT_ITEMS = new Set(['hand', 'minute', 'moment', 'break', 'chance', 'it', 'over', 'that', 'what', 'everything', 'up']);

/** "give me 5 iron or else", "bring me bread every day or you'll regret it" → the demand; a plain request → null. */
export function parseDemand(text: string): Demand | null {
  if (!THREAT.test(text)) return null;
  const m = ASK.exec(text);
  const word = m?.[2]?.toLowerCase();
  if (!m || !word || NOT_ITEMS.has(word)) return null;
  return { item: word.replace(/(ie)?s$/, (x) => (x === 'ies' ? 'y' : '')), qty: m[1] ? Number(m[1]) : 1, recurring: /\bevery (day|morning|night)\b|\bdaily\b/i.test(text) };
}

export { complies } from './pressure';

/** What a dominant agent demands of someone (§17.7): food when short of it, else wood for the village. */
export function demandFor(food: number): { item: string; qty: number } {
  return food < 4 ? { item: 'bread', qty: 3 } : { item: 'log', qty: 8 };
}

/** The grievance a coerced payment leaves against the demander (small, but it accumulates). */
export const COERCION_GRIEVANCE = 0.12;

export interface FollowInput {
  /** Times we complied with them in the last hour. */
  complied: number;
  /** How afraid of them we are now (giving in out of fear only binds while the fear lasts). */
  fear: number;
  /** Our strongest fear of anyone else. */
  fearOfOthers: number;
  sentiment: number;
  /** How strong they look to us (0..1). */
  power: number;
}

/**
 * §17.7: we follow X after complying twice while still afraid of X (§18.4.1: as the fear falls, so does the
 * following), or for protection (afraid of others, fond of a strong X).
 */
export function follows(i: FollowInput): boolean {
  return (i.complied >= 2 && i.fear >= 0.4) || (i.fearOfOthers >= 0.6 && i.sentiment >= 6 && i.power >= 0.6);
}

/** §17.7: a leader, as onlookers infer it: two or more seen following them, or tribute seen paid to them. */
export function looksLikeLeader(followersSeen: number, tributeSeen: number): boolean {
  return followersSeen >= 2 || tributeSeen >= 2;
}

/** §18.4 authority bias: how much lower the bar to comply is for a demand from a leader or an idol. */
export function authorityShift(i: { leader: boolean; admiration: number; susceptibility: number; override: number }): number {
  const authority = i.leader ? 1 : i.admiration >= 0.7 ? 0.6 : 0;
  return 0.3 * authority * i.susceptibility * (1 - i.override);
}

/** Talk of ganging up on someone (§17.8): "let's deal with Rex together", "join me against Rex", "help me take Rex down". */
const RALLY = [
  /\b(?:let'?s|we should|we (?:have|need) to|we must|we could)\s+(?:deal with|take(?: down)?|stop|stand up to|get rid of|run off|fight|beat|go after|teach)\s+(?<who>[a-z0-9_]{3,16})\b/i,
  /\b(?:join me|with me|stand with me|help me)\s+(?:against|fight|take down|deal with|stand up to)\s+(?<who>[a-z0-9_]{3,16})\b/i,
  /\b(?:fight|take down|deal with)\s+(?<who>[a-z0-9_]{3,16})\s+(?:with me|together)\b/i,
];

/** The person a line proposes to gang up on, if it names someone we know; else null. */
export function parseRally(text: string, known: readonly AgentName[]): AgentName | null {
  for (const re of RALLY) {
    const who = re.exec(text)?.groups?.who?.toLowerCase();
    const name = who ? known.find((n) => n.toLowerCase() === who) : undefined;
    if (name) return name;
  }
  return null;
}

/** "I'll fight Rex with you", "count me in against Rex": a promise to join a fight against someone. */
export function parseFightPromise(text: string, known: readonly AgentName[]): AgentName | null {
  const m = /\b(?:i'?ll|i will|count me in)\b[^.!?]*?\b(?:fight|against|take on|deal with|stand up to)\s+(?<who>[a-z0-9_]{3,16})\b/i.exec(text);
  const who = m?.groups?.who?.toLowerCase();
  return (who && known.find((n) => n.toLowerCase() === who)) ?? null;
}

export interface RallyInput {
  resentment: number;
  ambition: number;
  vengefulness: number;
  loyalty: number;
  /** Others we believe resent the target too and whom we trust. */
  members: number;
  /** Our side's power against theirs (§17.8), and whether the target is alone or hurt now. */
  power: number;
  against: number;
  opening: boolean;
}

/** §17.8: someone ambitious, vengeful or loyal to the wronged proposes an uprising when the odds or the moment favor it. */
export function mayRally(i: RallyInput): boolean {
  return i.resentment >= 0.5 && Math.max(i.ambition, i.vengefulness, i.loyalty) >= 0.6 && i.members >= 1 && (i.power > i.against || i.opening);
}

/** §17.8: whether to join a proposed uprising: enough resentment of the target, trust in who asks, fear in check. */
export function joinsRally(i: { resentment: number; trust: number; fear: number; followsTarget: boolean }): boolean {
  return !i.followsTarget && i.resentment >= 0.4 && i.trust >= 0.5 && i.fear < i.resentment + 0.3;
}

/**
 * §17.8 side-taking: a follower whose leader is set upon stays loyal while loyalty (with fondness) and fear of the
 * leader outweigh fear of those attacking; otherwise it defects.
 */
export function defects(i: { loyalty: number; sentiment: number; fearOfLeader: number; fearOfCoalition: number }): boolean {
  return i.fearOfCoalition > i.loyalty * (i.sentiment / 10) + 0.5 * i.fearOfLeader;
}

/** Who among `people` someone was seen accompanying (within 8 blocks, at least 3 of the last 4 sightings). */
export function companionsOf(sightings: readonly { with: readonly AgentName[] }[]): AgentName[] {
  const recent = sightings.slice(-4);
  const counts = new Map<AgentName, number>();
  for (const s of recent) for (const n of new Set(s.with)) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 3).map(([n]) => n);
}
