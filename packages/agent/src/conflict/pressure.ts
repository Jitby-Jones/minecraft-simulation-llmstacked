// The conflict evaluator's arithmetic (§17.4, §17.5, §17.10): power from what can be seen, fear from the gap,
// motive against deterrence, an escalation ladder with hysteresis, and the mandatory code gate for fights. Pure
// functions: the LLM may propose a fight, but only these numbers let it happen (and code never starts one on its
// own except in self-defense or to defend a friend).

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface PowerInputs {
  /** Visible armor and weapon, 0..1 (gearScore). */
  gear: number;
  killsSeen: number;
  fightsWonSeen: number;
  followersSeen: number;
  /** Last seen health 0..1, if visible. */
  healthFrac?: number;
  /** Own (known) combat ability, for myPower only. */
  combat?: number;
}

/** §17.4 perceived power in 0..1, from gear, reputation, company and condition. */
export function powerOf(i: PowerInputs): number {
  const rep = 1 - Math.exp(-(i.killsSeen * 0.6 + i.fightsWonSeen * 0.35));
  const company = 1 - Math.exp(-i.followersSeen * 0.5);
  const base = 0.45 * i.gear + 0.2 * rep + 0.2 * company + 0.15 * (i.combat ?? 0.4);
  return clamp(base * (0.5 + 0.5 * (i.healthFrac ?? 1)), 0, 1);
}

/** §17.4 fearOf(X) = sigmoid(k·(power(X) − myPower − alliesNearbyBonus)) · (0.5 + caution). */
export function fearOf(theirPower: number, myPower: number, alliesBonus: number, caution: number, k = 6): number {
  return clamp(sigmoid(k * (theirPower - myPower - alliesBonus)) * (0.5 + caution), 0, 1);
}

export interface Opportunity {
  alone: boolean;
  hurt: boolean;
  carryingWanted: boolean;
}

export function opportunity(o: Opportunity): number {
  return (o.alone ? 0.3 : 0) + (o.hurt ? 0.3 : 0) + (o.carryingWanted ? 0.2 : 0);
}

export interface MotiveInputs {
  resentment: number;
  aggression: number;
  dominance: number;
  opportunity: number;
  /** An insult or demand right now. */
  provocationNow: number;
  /** An ally called for help against them. */
  allyCall: number;
}

export function motive(m: MotiveInputs): number {
  return m.resentment * (0.5 + m.aggression) + m.dominance * m.opportunity + m.provocationNow + m.allyCall;
}

/** Reputation risk: each onlooker's liking of the target counts against attacking them. */
export function witnessCost(onlookerSentimentsTowardTarget: readonly number[]): number {
  return onlookerSentimentsTowardTarget.reduce((a, s) => a + (s / 10) * 0.2, 0);
}

export interface DeterrenceInputs {
  fearOf: number;
  caution: number;
  /** Death is permanent (live/hardcore: 1; test mode's simulated permadeath: 1 as well, §16.3). */
  deathIsPermanent: number;
  witnessCost: number;
  lawCost?: number;
}

export function deterrence(d: DeterrenceInputs): number {
  return d.fearOf + d.caution * d.deathIsPermanent + d.witnessCost + (d.lawCost ?? 0);
}

/** §17.5 rung thresholds (rung 0 is "avoid", the default). */
export const RUNG_THRESHOLDS = [Number.NEGATIVE_INFINITY, 0.2, 0.35, 0.5, 0.75] as const;
export const HYSTERESIS = 0.15;

export interface RungLimits {
  /** world.conflict.maxRung (3: brawls only, 2: words and demands only). */
  maxRung: number;
  /** In live mode lethal also needs vengefulness or dominance ≥ 0.6 (§17.5). */
  lethalAllowed: boolean;
  /** A crowd lowers thresholds by 0.1 (§18.4.2). */
  thresholdShift?: number;
}

/** The rung for this pressure, stepping up past a threshold and down only 0.15 below it. */
export function rungFor(pressure: number, current: number, lim: RungLimits): number {
  const shift = lim.thresholdShift ?? 0;
  const cap = Math.min(lim.maxRung, lim.lethalAllowed ? 4 : 3);
  let r = 0;
  for (let i = 1; i <= cap; i++) {
    const t = (RUNG_THRESHOLDS[i] ?? Number.POSITIVE_INFINITY) + shift;
    if (pressure >= t || (i <= current && pressure >= t - HYSTERESIS)) r = i;
  }
  return r;
}

export type FightIntent = 'brawl' | 'lethal' | 'impulse';

export interface GateInput {
  intent: FightIntent;
  pressure: number;
  lim: RungLimits;
  /** Pair cooldown after a fight (§17.10). */
  cooldownUntil: number;
  /** Newcomer grace: a new agent doesn't start rung ≥ 3 (§17.10). */
  graceUntil: number;
  /** The world-wide concurrent fight cap is reached (§17.10). */
  fightCapReached: boolean;
  /** They gave up a fight with us just now (§17.6): a yield is let stand; only a fight to the death ignores it. */
  justYielded?: boolean;
  now: number;
}

/** §17.5 code gate: the only way a proposed fight happens. Returns null when allowed, else why not. */
export function gateFight(g: GateInput): string | null {
  const need = g.intent === 'lethal' ? 4 : 3;
  if (need > g.lim.maxRung) return `fighting is limited to rung ${g.lim.maxRung} here`;
  if (g.intent === 'lethal' && !g.lim.lethalAllowed) return 'not angry or ruthless enough to fight to the death';
  if (g.now < g.graceUntil) return 'too new here to start a fight';
  if (g.now < g.cooldownUntil) return 'fought them too recently';
  if (g.justYielded && g.intent !== 'lethal') return 'they just gave up';
  // The world-wide cap (§17.10): the agent only holds back; it never learns that fights are going on elsewhere.
  if (g.fightCapReached) return 'you hold back for now';
  // An impulsive single punch clears a lower bar (§18.5: threshold − 0.15).
  const threshold = (RUNG_THRESHOLDS[need] ?? 1) + (g.lim.thresholdShift ?? 0) - (g.intent === 'impulse' ? 0.15 : 0);
  if (g.pressure < threshold) return `not angry enough to fight (pressure ${g.pressure.toFixed(2)} < ${threshold.toFixed(2)})`;
  return null;
}

/** Health at which a fighter gives up (§17.6): cautious people yield sooner. */
export function yieldHealth(caution: number): number {
  return Math.round(4 + 6 * clamp(caution, 0, 1));
}

/** The chance a winner spares a yielding foe (§17.6): mercy, less what resentment takes, much less in a fight to the death. */
export function spareChance(mercy: number, resentment: number, rung: number): number {
  return clamp(mercy * (1 - 0.6 * resentment) * (rung >= 4 ? 0.4 : 1), 0, 1);
}

/** Winner's mercy toward a yielding foe (§17.6). */
export function sparesYielder(mercy: number, resentment: number, rung: number, roll: number): boolean {
  return roll < spareChance(mercy, resentment, rung);
}

/**
 * §17.7 compliance: comply when fear outweighs resentment plus pride (pride = 1 − loyalty·0.5). A demand from a leader
 * or an idol clears a lower bar (§18.4 authority bias): `authority` comes off the threshold.
 */
export function complies(fearOfDemander: number, resentment: number, loyalty: number, authority = 0): boolean {
  return fearOfDemander > resentment + (1 - loyalty * 0.5) - authority;
}
