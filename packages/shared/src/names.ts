// Player-like usernames (§16.1): 3–16 chars of [A-Za-z0-9_], no "Bot"/"AI" giveaways, never reused.

import { type Random, pick, randInt, chance } from './random';

const VALID = /^[A-Za-z0-9_]{3,16}$/;

/** Rejects names that would give a bot away. "Kai" is fine; "PipAI", "AI_Pip", "Robo_bot" are not. */
export function isGiveawayName(name: string): boolean {
  if (/bot/i.test(name)) return true;
  if (/AI/.test(name)) return true;
  if (/(^|_)ai($|_)/i.test(name)) return true;
  if (/^(npc|agent|llm|gpt)|(npc|agent|llm|gpt)$/i.test(name)) return true;
  return false;
}

export function isValidUsername(name: string): boolean {
  return VALID.test(name) && !isGiveawayName(name);
}

const GIVEN_NAMES = [
  'Pip', 'Bram', 'Lira', 'Kai', 'Nona', 'Tobin', 'Mara', 'Ezra', 'Wren', 'Juno', 'Rook', 'Ivy', 'Otto', 'Sage',
  'Milo', 'Tess', 'Finn', 'Nell', 'Cass', 'Remy', 'Hazel', 'Arlo', 'Dell', 'Fern', 'Gus', 'Iris', 'Jory', 'Kit',
  'Lane', 'Moss', 'Nico', 'Opal', 'Pell', 'Quin', 'Rhea', 'Sol', 'Tamsin', 'Uma', 'Vale', 'Wade', 'Yara', 'Zeke',
  'Ash', 'Bea', 'Cole', 'Dara', 'Elo', 'Flint', 'Greta', 'Hale', 'Ines', 'Jasper', 'Kenna', 'Leif', 'Maeve',
  'Ned', 'Orla', 'Piers', 'Rue', 'Silas', 'Tova', 'Ulric', 'Vera', 'Wynn', 'Xan', 'Yves', 'Zora', 'Bryn', 'Cyra',
  'Dax', 'Edie', 'Fitz', 'Gwen', 'Hugo', 'Isla', 'Jett', 'Kaia', 'Lux', 'Mabel', 'Noor', 'Oren', 'Pia', 'Rafe',
];

const SUFFIXES = ['', '_', 'x', 'y', 'o', 'ie', 'ster', 'man', 'girl', 'craft', 'mc', 'yy', 'zz'];
const WORDS = ['Stone', 'Moss', 'Fox', 'Oak', 'Ember', 'River', 'Frost', 'Pine', 'Wolf', 'Hawk', 'Dusk', 'Clay', 'Reed'];

export function givenNamePool(): readonly string[] {
  return GIVEN_NAMES;
}

/**
 * Generates a unique player-like username derived from `base` (e.g. "Pip" → "Pip", "Pipster", "pip_92").
 * `taken` must contain every username ever used (alive or dead).
 */
export function generateUsername(base: string, taken: ReadonlySet<string>, rng: Random): string {
  const lowerTaken = new Set([...taken].map((n) => n.toLowerCase()));
  const cleanBase = base.replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || pick(rng, GIVEN_NAMES);
  const ok = (n: string): boolean => isValidUsername(n) && !lowerTaken.has(n.toLowerCase());
  if (ok(cleanBase)) return cleanBase;
  for (let attempt = 0; attempt < 200; attempt++) {
    let cand: string;
    const style = attempt % 4;
    if (style === 0) cand = cleanBase + pick(rng, SUFFIXES);
    else if (style === 1) cand = `${chance(rng, 0.5) ? cleanBase.toLowerCase() : cleanBase}_${randInt(rng, 2, 99)}`;
    else if (style === 2) cand = `${cleanBase}${pick(rng, WORDS)}`;
    else cand = `${pick(rng, WORDS)}${cleanBase}${chance(rng, 0.5) ? randInt(rng, 1, 9) : ''}`;
    cand = cand.slice(0, 16);
    if (ok(cand)) return cand;
  }
  for (let i = 100; i < 100000; i++) {
    const cand = `${cleanBase.slice(0, 10)}${i}`;
    if (ok(cand)) return cand;
  }
  throw new Error(`could not generate a unique username for ${base}`);
}

/** Born agents: `<Given>_<FamilyInitial>` or similar; always unique (§19.4). */
export function generateChildUsername(given: string, familyName: string, taken: ReadonlySet<string>, rng: Random): string {
  const initial = familyName.replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase() || 'X';
  const g = given.replace(/[^A-Za-z0-9]/g, '').slice(0, 13);
  const lowerTaken = new Set([...taken].map((n) => n.toLowerCase()));
  const first = `${g}_${initial}`;
  if (isValidUsername(first) && !lowerTaken.has(first.toLowerCase())) return first;
  return generateUsername(first, taken, rng);
}
