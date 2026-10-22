// What people say about each other (§18.4.1 heard opinions), read in code from every line heard: "Bram is a
// thief", "Tobin's great", "don't trust Mira". The L2 social update reads them from whole conversations as well;
// this is the cheap System 1 pass that also works without a model.

import { type AgentName, type HeardOpinion, mentionsName } from '@agora/shared';

/** Things said of someone bad (a negation doesn't turn these around: "never trust Bram"). */
const BAD_DEEDS = /\b(can'?t stand|don'?t trust|never trust|stay away from|watch out for|steals?|stole|lies|lied|robbed|attacked|hit me|killed|hates? (?:him|her|them))\b/i;
const BAD =
  /\b(thief|thieves|liar|cheat(?:er)?|jerk|idiot|creep|traitor|coward|bully|snake|rat|useless|lazy|mean|nasty|dangerous|crook|murderer|killer|psycho|selfish|greedy|rude|weird)\b/i;
const GOOD =
  /\b(great|nice|kind|helpful|generous|friendly|trustworthy|honest|brave|good|awesome|amazing|the best|a hero|smart|clever|fair|reliable|cool|funny|strong)\b|\b(love|like|trust|admire|helped me|saved me|gave me)\b/i;
const NEGATED = /\b(not|isn'?t|aren'?t|wasn'?t|never|no longer|hardly)\b/i;

/** Splits a line into clauses, so "Bram is nice but Mira is a thief" reads as two opinions. */
function clauses(text: string): string[] {
  return text.split(/[.!?;]+|\bbut\b|\bwhile\b|,\s*(?:and|though)\b/i).map((c) => c.trim()).filter(Boolean);
}

/** Opinions in one line about people we know of (never about the speaker themselves). Valence −1..1. */
export function readOpinions(text: string, speaker: AgentName, known: readonly AgentName[], now: number): HeardOpinion[] {
  const out = new Map<AgentName, number>();
  for (const clause of clauses(text)) {
    for (const target of known) {
      if (target === speaker || !mentionsName(clause, target)) continue;
      const negated = NEGATED.test(clause);
      // "X isn't a thief" is mild praise; "X isn't nice" a mild knock.
      const valence = BAD_DEEDS.test(clause) ? -0.7 : BAD.test(clause) ? (negated ? 0.3 : -0.7) : GOOD.test(clause) ? (negated ? -0.4 : 0.6) : null;
      if (valence !== null) out.set(target, valence);
    }
  }
  return [...out].map(([target, valence]) => ({ speaker, target, valence, ts: now }));
}

/** A warning about someone, or a judgment of them, naming them whether or not we know them ("watch out for Rex"). */
const NAMED_RE =
  /\b(?:watch out for|stay away from|beware of|keep away from|don'?t trust|never trust|can'?t stand)\s+@?([A-Za-z0-9_]{3,16})\b|\b([A-Z][A-Za-z0-9_]{2,15}) (?:is|was) (?:a |an )?(?:thief|liar|bully|cheat|traitor|murderer|killer|snake|rat|dangerous|mean|nasty)\b/g;
/** Words a warning names that are no one in particular. */
const NO_ONE = new Set(['him', 'her', 'them', 'that', 'this', 'there', 'people', 'strangers', 'anyone', 'anybody', 'everyone', 'everybody', 'someone', 'somebody', 'mobs', 'monsters', 'creepers', 'zombies', 'skeletons', 'spiders', 'the', 'night', 'lava', 'you', 'yourself']);

/**
 * People a line warns about or judges, by name, known to us or not: how a stranger's name first reaches someone
 * (§19.5 a parent warning a child: "watch out for Rex. Rex is a bully.").
 */
export function namedIn(text: string): AgentName[] {
  const out = new Set<AgentName>();
  for (const m of text.matchAll(NAMED_RE)) {
    const name = m[1] ?? m[2];
    if (name && !NO_ONE.has(name.toLowerCase())) out.add(name);
  }
  return [...out];
}

/** Being asked what we think of someone: "what do you think of Rex?", "how do you feel about Rex", "thoughts on Rex?". */
export const OPINION_ASK_RE = /\b(?:what do you (?:think|make) of|how do you feel about|what'?s your (?:view|take|opinion) (?:of|on)|(?:any )?thoughts on)\s+@?([A-Za-z0-9_]{2,16})\b/i;

/** Whom a line asks our opinion of, if it names someone we know. */
export function readOpinionAsk(text: string, known: readonly AgentName[]): AgentName | null {
  const w = OPINION_ASK_RE.exec(text)?.[1]?.toLowerCase();
  return w ? (known.find((n) => n.toLowerCase() === w) ?? null) : null;
}

/** What it is safe to say of someone one fears: a mild good word. */
const SAFE_WORD = 0.3;

/**
 * §18.4.1 what one says of someone when asked (−1..1): what one feels, but a low opinion is pulled toward a safe word
 * by the pull to keep quiet (conformity, raised by fear of them or of the leader). Dissent goes quiet under fear.
 */
export function statedOpinion(felt: number, quiet: number): number {
  return felt >= SAFE_WORD ? felt : felt + (SAFE_WORD - felt) * Math.min(1, Math.max(0, quiet));
}

/** The line for an opinion, worded so that a listener's code reading (readOpinions) takes it the same way. */
export function opinionLine(name: AgentName, v: number): string {
  if (v >= 0.45) return `${name} is good to us.`;
  if (v >= 0.15) return `${name} isn't mean, I suppose.`;
  if (v > -0.15) return `${name}? I couldn't say.`;
  if (v > -0.45) return `${name} isn't nice.`;
  return `${name} is a bully. I can't stand ${name}.`;
}

/** A wrong someone is said to have done (§17.8 hearsay grievances): "Bram stole my iron", "Rex hit Cass". */
export interface ToldDeed {
  speaker: AgentName;
  target: AgentName;
  deed: 'theft' | 'attack' | 'kill' | 'lie';
  /** Whom it was done to, when named (for a killing: a friend of ours makes it the heaviest wrong). */
  victim?: AgentName;
}

const DEEDS: readonly [RegExp, ToldDeed['deed']][] = [
  [/\b(stole|steals|robbed|took my|takes my|swiped)\b/i, 'theft'],
  [/\b(killed|murdered)\b/i, 'kill'],
  [/\b(hit|attacked|beat|punched|hurt)\b/i, 'attack'],
  [/\b(lied|lies to|cheated|tricked)\b/i, 'lie'],
];

/** Wrongs told of in one line: the named doer comes first in the clause, and a negation takes it back. */
export function readDeeds(text: string, speaker: AgentName, known: readonly AgentName[]): ToldDeed[] {
  const out: ToldDeed[] = [];
  for (const clause of clauses(text)) {
    if (NEGATED.test(clause)) continue;
    for (const [re, deed] of DEEDS) {
      const m = re.exec(clause);
      if (!m) continue;
      const before = clause.slice(0, m.index);
      const after = clause.slice(m.index + m[0].length);
      const target = known.find((n) => n !== speaker && mentionsName(before, n));
      if (!target) continue;
      const victim = known.find((n) => n !== target && mentionsName(after, n));
      out.push({ speaker, target, deed, ...(victim ? { victim } : {}) });
      break;
    }
  }
  return out;
}
