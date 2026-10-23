// The master model (owner request, 2026-10-23: agents weren't fully randomized; §16.2, §20). Every new person's numbers
// are drawn by code: from the population's distributions, or from the parents for a child (true randomness, which a
// model writing numbers itself would not give). L3 then writes the person around those numbers, never from the sex
// label (that decides only the name and the pronouns): a given name, the words for their character, a short life
// story, how they talk, what they value and want, what they are unsure of. A spark drawn by code (where they come
// from, what they did) and the people already here keep one person from being like the last. What the model writes
// is checked (zod, PG, nothing of games or machines, a name nobody has had); anything that won't do keeps code's own
// words. One call per person, at the lowest priority on the shared rate limit; a child is written while it is on
// the way.

import { z } from 'zod';
import {
  type Logger,
  NOT_PG_RE,
  NUMERIC_TRAIT_KEYS,
  type Persona,
  PersonaSchema,
  type Random,
  generateChildUsername,
  generateUsername,
  getTrait,
  isValidUsername,
  pick,
} from '@agora/shared';
import type { LlmClient } from '@agora/llm';

export interface PersonaWriterOptions {
  llm: LlmClient;
  logger: Logger;
  rng: Random;
}

/** What else the writer knows about the person to write. */
export interface WriteContext {
  /** Every username ever used, alive or dead (never reused, §16.3). */
  takenNames: ReadonlySet<string>;
  /** The people here now (written to be unlike them). */
  living: readonly Persona[];
  /** A child: its parents (as the family knows them). */
  parents?: readonly [Persona, Persona];
  /** The operator chose the name: it is kept. */
  keepName?: boolean;
  signal?: AbortSignal;
}

// Lenient where code can trim (a long story, one doubt too many): a call isn't wasted over it.
const WrittenSchema = z.object({
  givenName: z.string().min(2).max(14),
  traits: z.array(z.string().min(2).max(40)).min(2).max(6),
  description: z.string().min(40).max(900),
  speechStyle: z.string().min(3).max(120),
  catchphrases: z.array(z.string().min(2).max(120)).max(4).default([]),
  values: z.array(z.string().min(2).max(40)).min(1).max(5),
  lifeGoals: z.array(z.string().min(5).max(160)).min(1).max(5),
  insecurities: z.array(z.string().min(3).max(120)).max(4).default([]),
});
export type Written = z.infer<typeof WrittenSchema>;

/** Words a person of this world wouldn't use about themselves: games, machines, the world as a program. */
const OUT_OF_WORLD = /\b(ai|a\.i\.|bots?|robots?|npcs?|language model|assistant|simulation|simulated|minecraft|video ?games?|gamer|players?|servers?|program(med)?|algorithm|chatgpt|gpt)\b/i;

/** Where they come from and what they did: a spark to start from, drawn by code. */
const ORIGINS = [
  'grew up on a windy coast',
  'comes from a mountain hamlet',
  'was raised on the open plains',
  'grew up deep in a birch forest',
  'comes from a sandy desert town',
  'was raised by the river in a fishing family',
  'comes from a snowy valley',
  'grew up in a busy market town',
  'was raised by an old shepherd',
  'grew up among swamps and willows',
  'comes from a village of beekeepers',
  'was raised in a family of many brothers and sisters',
  'grew up an only child far from anyone',
  'left home young to wander',
];
const CRAFTS = [
  'herded sheep',
  'baked bread',
  'worked wood',
  'fished',
  'dug in the mines',
  'gathered herbs',
  'cut stone',
  'drew maps',
  'kept bees',
  'sewed and mended',
  'told stories by the fire',
  'farmed wheat and carrots',
  'hunted in the woods',
  'shaped clay pots',
  'traded at fairs',
  'tended a lighthouse',
  'looked after horses',
  'played the flute',
];

/** How the story is told, drawn by code: left to itself, the model builds each one alike ("grew up in…; now arrives…"). */
const ANGLES = [
  'through a habit of theirs',
  'through something they are proud of',
  'through what they miss most',
  'through a day that changed them',
  'through what they do first each morning',
  'through what people notice about them first',
  'through a mistake they learned from',
  'through someone who shaped them',
  'through what makes them laugh',
  'through what they always carry',
];
/** The letter a given name begins with, drawn by code: the model has favourite names, world after world. */
const INITIALS = 'ABCDEFGHIJKLMNOPRSTVWY'.split('');

/** Every prompt the person thinks with starts with their story (prompts.ts personaCore): kept short. */
const STORY_MAX = 300;

/** The story cut at the last sentence that fits in `max` (at least the first sentence, cut at a word if need be). */
export function clipStory(text: string, max = STORY_MAX): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const x of sentences) {
    if ((out + x).trim().length > max) break;
    out += x;
  }
  if (out.trim()) return out.trim();
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
}

/** "Brisk and plain." → "brisk and plain" (it follows "You talk" and "Your life goals:"). */
const lowerFirst = (x: string) => x.trim().replace(/[.;]+$/, '').replace(/^(?!I\b)[A-Z](?![A-Z])/, (c) => c.toLowerCase());

function level(v: number): string {
  return v >= 0.8 ? 'very high' : v >= 0.62 ? 'high' : v > 0.38 ? 'about average' : v > 0.2 ? 'low' : 'very low';
}

/** The person's numbers in words for the model: each 0..1 trait with how far from average it is. */
export function describeNumbers(p: Persona): string {
  const traits = NUMERIC_TRAIT_KEYS.map((k) => `${k} ${getTrait(p, k).toFixed(2)} (${level(getTrait(p, k))})`);
  return [...traits, `intelligence ${p.abilities.intelligence.toFixed(2)} (${level(p.abilities.intelligence)})`, `fighting ${p.abilities.combat.toFixed(2)} (${level(p.abilities.combat)})`].join(', ');
}

const RULES = `You write people for a village in a world of blocky hills, forests and caves, one new person at a time. Write them from their numbers (each 0..1, 0.5 is average): a high number shows plainly in who they are, an average one not at all. Their sex decides only their name and how others speak of them, never their character. Make them their own person, unlike the people already here: a fresh name, their own way of talking, their own wants. Plain, warm words, PG. No famous people, no real places, nothing about games or machines.
JSON: {"givenName": "a first name, letters only, 3-12 letters, not one already taken", "traits": ["3 to 5 words for their character"], "description": "1 or 2 short sentences, under 220 characters, in the third person, starting with their name: who they are, told the way asked", "speechStyle": "how they talk, a few words to follow 'talks', like 'quick and teasing' or 'slowly, weighing each word'", "catchphrases": ["0 to 2 short things they often say, a few words each, in their own voice"], "values": ["2 or 3 things they care about most, a word or two each"], "lifeGoals": ["2 or 3 things they want to do here, each starting with a verb, plain and doable: building, farming, mining, crafting, exploring, trading, friends and family"], "insecurities": ["0 to 2 sore spots: a few words for what stings them to hear, like 'being called lazy' or 'looking foolish'"]}`;

export class PersonaWriter {
  /** The sparks drawn for the last few people, not drawn again for a while. */
  private readonly recent = { origins: [] as string[], crafts: [] as string[], angles: [] as string[], initials: [] as string[] };

  constructor(private readonly o: PersonaWriterOptions) {}

  /** The draft (code's numbers and words), written by the model; the draft as it is if the model's words won't do. */
  async write(draft: Persona, ctx: WriteContext): Promise<Persona> {
    const r = await this.o.llm.call<Written>({
      tier: 'L3',
      module: 'persona',
      agent: 'hub',
      schema: WrittenSchema,
      schemaName: 'persona',
      fallback: () => ({ givenName: draft.name, traits: draft.traits, description: draft.description ?? '', speechStyle: draft.speech.style, catchphrases: [], values: draft.values, lifeGoals: draft.lifeGoals, insecurities: [] }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      messages: [
        { role: 'system', content: RULES },
        { role: 'user', content: this.ask(draft, ctx) },
      ],
    });
    if (!r.ok) {
      this.o.logger.info({ module: 'persona', reason: r.reason }, 'persona kept as code drew it (no model to write it)');
      return draft;
    }
    const w = r.value;
    const words = [w.givenName, ...w.traits, w.description, w.speechStyle, ...w.catchphrases, ...w.values, ...w.lifeGoals, ...w.insecurities];
    const bad = words.find((x) => NOT_PG_RE.test(x) || OUT_OF_WORLD.test(x));
    if (bad) {
      this.o.logger.info({ module: 'persona', model: r.model, bad }, "persona kept as code drew it (the model's words won't do)");
      return draft;
    }
    const name = ctx.keepName ? draft.name : this.username(w.givenName, draft, ctx.takenNames);
    const given = w.givenName.replace(/[^A-Za-z]/g, '');
    // The model wrote the given name into the story: the story names them by their username's given name.
    const story = given && name !== given ? w.description.replace(new RegExp(`\\b${given}\\b`, 'g'), name.replace(/_[A-Z]$/, '')) : w.description;
    const persona = PersonaSchema.parse({
      ...draft,
      id: `${draft.source === 'born' ? 'born' : 'gen'}-${name.toLowerCase()}`,
      name,
      traits: w.traits.slice(0, 5).map((t) => t.toLowerCase()),
      description: clipStory(story),
      // Said as they are, now and then (talking.ts): short ones only.
      speech: { ...draft.speech, style: lowerFirst(w.speechStyle.trim().replace(/^(speaks|talks)\s+/i, '')), catchphrases: w.catchphrases.filter((c) => c.length <= 60).slice(0, 2) },
      values: w.values.slice(0, 3).map((v) => v.toLowerCase()),
      lifeGoals: w.lifeGoals.slice(0, 3).map(lowerFirst),
      // Each word of a sore spot is one an insult can hit (mind/feelings.ts): a few words, not a sentence.
      insecurities: w.insecurities.filter((x) => x.trim().split(/\s+/).length <= 5).slice(0, 2).map(lowerFirst),
    });
    this.o.logger.info({ module: 'persona', model: r.model, name, traits: persona.traits, source: persona.source }, 'persona written');
    return persona;
  }

  /** A username from the given name the model chose: valid, never used before (a child's with its family initial). */
  private username(givenName: string, draft: Persona, taken: ReadonlySet<string>): string {
    const given = givenName.replace(/[^A-Za-z]/g, '').slice(0, 12);
    if (given.length < 2) return draft.name;
    if (draft.source === 'born' && draft.familyName) return generateChildUsername(given, draft.familyName, taken, this.o.rng);
    const lower = new Set([...taken].map((n) => n.toLowerCase()));
    if (isValidUsername(given) && !lower.has(given.toLowerCase())) return given;
    return generateUsername(given, taken, this.o.rng);
  }

  /** One of `list`, not one drawn for the last few people (half the list), so newcomers in a row don't share a past. */
  private spark(list: readonly string[], recent: string[]): string {
    const fresh = list.filter((x) => !recent.includes(x));
    const s = pick(this.o.rng, fresh.length > 0 ? fresh : list);
    recent.push(s);
    if (recent.length > Math.floor(list.length / 2)) recent.shift();
    return s;
  }

  private ask(draft: Persona, ctx: WriteContext): string {
    const who = draft.sex === 'female' ? 'woman' : 'man';
    const lines: string[] = [];
    if (ctx.parents) {
      const [a, b] = ctx.parents;
      const fam = draft.familyName ? ` (the ${draft.familyName} family)` : '';
      lines.push(`A ${draft.sex === 'female' ? 'girl' : 'boy'} is born to ${a.name} and ${b.name}${fam}. Write the person the child will grow into, young now: whom they take after, and how they differ.`);
      lines.push(`${a.name}: ${parentLine(a)}`, `${b.name}: ${parentLine(b)}`);
      lines.push(`The child's own numbers (from the parents): ${describeNumbers(draft)}.`);
      lines.push(`Something of their own: they love to watch how others ${this.spark(CRAFTS, this.recent.crafts)}.`);
      lines.push(`Their given name begins with ${this.spark(INITIALS, this.recent.initials)}.`);
    } else {
      lines.push(`A new ${who} arrives in the village${ctx.keepName ? `, called ${draft.name} (keep that name)` : ''}.`);
      lines.push(`Their numbers: ${describeNumbers(draft)}.`);
      lines.push(`A spark to start from (use it or not): ${draft.sex === 'female' ? 'she' : 'he'} ${this.spark(ORIGINS, this.recent.origins)}, and once ${this.spark(CRAFTS, this.recent.crafts)}.`);
      lines.push(`Tell their story ${this.spark(ANGLES, this.recent.angles)}.${ctx.keepName ? '' : ` Their given name begins with ${this.spark(INITIALS, this.recent.initials)}.`}`);
    }
    const taken = [...ctx.takenNames].slice(-80);
    if (taken.length > 0) lines.push(`Names already taken: ${taken.join(', ')}.`);
    const here = ctx.living.slice(-10);
    // Their whole stories (short, STORY_MAX): a turn of phrase the last one ended on is one to stay clear of.
    if (here.length > 0) lines.push(`People already here (make this one unlike them, and don't reuse their phrases):\n${here.map((p) => `- ${p.name}: ${p.traits.join(', ')}${p.description ? `; ${p.description}` : ''}`).join('\n')}`);
    return lines.join('\n');
  }
}

function parentLine(p: Persona): string {
  return `${p.traits.join(', ')}${p.description ? `; ${p.description.slice(0, 160)}` : ''}`;
}
