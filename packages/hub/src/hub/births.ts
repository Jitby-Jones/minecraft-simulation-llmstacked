// §19.3 births, on the Hub's side: the rules, kept apart from the supervisor that acts on them. Each partner who lies
// in their bed beside the other asleep reports it (conception); with both reports from the same night (only ours when
// the partner is a person playing, whom the system has no bot for), room in the population, the couple's cooldown
// passed and neither in their youth, a child comes after gestationSec. The Hub never tells a bot any of this: the
// child's greeting is how its parents, and anyone else in earshot, learn of it.

import type { Sex, Vec3, WorldConfig } from '@agora/shared';
import type { PendingBirth, RosterEntry } from './roster';

export interface ConceptionReport {
  username: string;
  partner: string;
  partnerModel: Record<string, number>;
  partnerSex: Sex | 'unknown';
  bedPos: Vec3;
  /** When the Hub heard it (its own clock, not the bot's). */
  at: number;
}

/** The two reports of one bed ritual come within this of each other (the same night). */
export const PAIR_WINDOW_MS = 15 * 60_000;

export const coupleKey = (a: string, b: string): string => [a, b].sort().join('+');
export const sameCouple = (x: readonly string[], y: readonly string[]): boolean => x.length === 2 && y.length === 2 && coupleKey(x[0] ?? '', x[1] ?? '') === coupleKey(y[0] ?? '', y[1] ?? '');

/** The partner's own report of the same night, naming the reporter, if it came. */
export function matchReport(reports: ReadonlyMap<string, ConceptionReport>, r: ConceptionReport): ConceptionReport | null {
  const other = reports.get(r.partner);
  return other && other.partner === r.username && Math.abs(other.at - r.at) <= PAIR_WINDOW_MS ? other : null;
}

/** In their youth: born in-world, less than youthSec ago. Founders are adults from the start. */
export function isYoungEntry(e: RosterEntry, youthSec: number, now: number): boolean {
  return Boolean(e.parents) && now - e.bornAt < youthSec * 1000;
}

/** Why no child comes of this couple's bed ritual now, or null when one will. */
export function whyNoBirth(o: { world: WorldConfig; parents: readonly [string, string]; agents: readonly RosterEntry[]; pending: readonly PendingBirth[]; now: number }): string | null {
  const { world, parents, agents, pending, now } = o;
  if (!world.reproduction.enabled) return 'reproduction is off';
  const living = agents.filter((a) => a.status === 'alive');
  if (living.length + pending.length >= world.population.maxAlive) return 'the population is at maxAlive';
  if (pending.some((p) => sameCouple(p.parents, parents))) return 'a child of theirs is already on the way';
  const last = Math.max(-Infinity, ...agents.filter((a) => a.parents && sameCouple(a.parents, parents)).map((a) => a.bornAt));
  if (now - last < world.reproduction.coupleCooldownSec * 1000) return "the couple's cooldown has not passed";
  const young = parents.filter((u) => {
    const e = agents.find((a) => a.username === u);
    return e ? isYoungEntry(e, world.reproduction.youthSec, now) : false;
  });
  if (young.length > 0) return `${young.join(' and ')} too young`;
  return null;
}
