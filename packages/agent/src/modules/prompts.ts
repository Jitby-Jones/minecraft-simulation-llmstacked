// Prompt pieces (§5 prompt caching: a stable prefix per module, variable content last; §7 prompt quirks in the
// prefix). Nothing here distinguishes kinds of people (§16.1): everyone is just a name.

import type { Persona } from '@agora/shared';

/** Persona core shared by every module that speaks or decides. Stable per persona (cache-friendly). */
export function personaCore(p: Persona, traitAnnotations: readonly string[] = []): string {
  const lines = [
    `You are ${p.name}, living in a Minecraft world with other people.`,
    `Personality: ${p.traits.join(', ')}.${p.description ? ` ${p.description}` : ''}`,
  ];
  if (p.values.length > 0) lines.push(`You value ${p.values.join(', ')}.`);
  if (p.lifeGoals.length > 0) lines.push(`Your life goals: ${p.lifeGoals.join('; ')}.`);
  lines.push(`You talk ${p.speech.style}, at most ${p.speech.maxWords} words at a time.`);
  if (p.speech.catchphrases.length > 0) lines.push(`Things you sometimes say: ${p.speech.catchphrases.map((c) => `"${c}"`).join(', ')}.`);
  if (traitAnnotations.length > 0) lines.push(`How you have changed lately: ${traitAnnotations.join('; ')}.`);
  return lines.join('\n');
}

/** §16.3: said plainly to the modules that plan (the CC and Goal Gen). */
export const DEATH_RULE = 'Death is permanent. If you die, you are gone forever.';

export const DECISION_FORMAT = `Reply with one JSON object:
{"option": "work|talk|move|follow|explore|rest|flee|help|trade",
 "target": {"agent": "name", "pos": {"x":0,"y":0,"z":0}, "item": "name"},   (only what the option needs)
 "task": {"skill": "skill name", "args": {...}},                          (required for work and help)
 "speechIntent": {"stance": "agree|decline|negotiate|inform|ask|chat|apologize|none", "gist": "what you are willing to say", "mayCommit": false},
 "commitmentsToCreate": [{"debtor": "you or them", "creditor": "...", "what": {"kind": "give|gather|meet|help|build|follow|custom", "item": "...", "qty": 1, "text": "..."}}],
 "trade": {"with": "name", "phase": "offer|accept|counter|decline", "give": [{"item": "...", "qty": 1}], "want": [{"item": "...", "qty": 1}]},   (only when trading; give is yours, want is theirs)
 "terminate": {"maxSeconds": 120, "until": "inventoryHas:oak_log>=16"},
 "rationale": "one sentence"}`;

export const DECISION_RULES = `Rules:
- Choose what to do next. Work toward your current goal unless something more important is happening.
- Set mayCommit to true only when you really intend to do what you agree to, starting now. Otherwise talk without promising.
- If you keep failing at something, do something different.
- Trades are talked through: offer what you give for what you want; accepting (with mayCommit) binds both of you, and each hands their part over in person.
- GUT is your first reaction to someone; FACTS is what they have actually done. You may follow your gut, as people do, or reason past it. Stay in character.
- Use only the skills listed. "until" may be: inventoryHas:<item>>=<n>, agentInRange:<name>, agentLeftRange:<name>, timeIs:day|night, healthAbove:<n>, foodAbove:<n>, near:<x>,<y>,<z>.`;

export function talkRules(maxWords: number): string {
  return [
    'You are chatting with people near you in Minecraft.',
    `Write only your next line: plain text, one line, at most ${maxWords} words. No quotes, no name prefix, no commands.`,
    'Stay in character. Talk like a person in this world, about this world.',
    'Don\'t make up facts about places, people or things you haven\'t seen or been told about. When you pass on something you heard from someone, say who told you ("Bram says...") and don\'t present it as certain.',
  ].join('\n');
}

export const NO_PROMISE_RULE =
  'Do not promise, agree to or offer to do anything right now. You may chat, ask a question, or say you will think about it.';
export const STRICT_NO_PROMISE_RULE =
  'IMPORTANT: your last draft sounded like a promise. Do NOT agree, accept or say you will do anything. Ask, chat, or say you need to think about it.';
