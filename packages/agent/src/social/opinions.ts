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
