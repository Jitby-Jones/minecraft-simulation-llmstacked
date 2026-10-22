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

/**
 * §17.7 compliance: comply when fear of the demander outweighs resentment of them plus pride
 * (pride = 1 − 0.5·loyalty; the loyal bend more easily).
 */
export function complies(fearOfDemander: number, resentmentOfDemander: number, loyalty: number): boolean {
  return fearOfDemander > resentmentOfDemander + (1 - 0.5 * loyalty);
}

/** The grievance a coerced payment leaves against the demander (small, but it accumulates). */
export const COERCION_GRIEVANCE = 0.12;

export interface FollowInput {
  /** Times we complied with them in the last hour. */
  complied: number;
  /** Our strongest fear of anyone else. */
  fearOfOthers: number;
  sentiment: number;
  /** How strong they look to us (0..1). */
  power: number;
}

/** §17.7: we follow X after complying twice, or for protection (afraid of others, fond of a strong X). */
export function follows(i: FollowInput): boolean {
  return i.complied >= 2 || (i.fearOfOthers >= 0.6 && i.sentiment >= 6 && i.power >= 0.6);
}

/** §17.7: a leader, as onlookers infer it: two or more seen following them, or tribute seen paid to them. */
export function looksLikeLeader(followersSeen: number, tributeSeen: number): boolean {
  return followersSeen >= 2 || tributeSeen >= 2;
}

/** Who among `people` someone was seen accompanying (within 8 blocks, at least 3 of the last 4 sightings). */
export function companionsOf(sightings: readonly { with: readonly AgentName[] }[]): AgentName[] {
  const recent = sightings.slice(-4);
  const counts = new Map<AgentName, number>();
  for (const s of recent) for (const n of new Set(s.with)) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 3).map(([n]) => n);
}
