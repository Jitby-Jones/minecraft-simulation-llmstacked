// Vanilla system messages (§6.1, §16.3): deaths, joins, leaves and advancements are global news, the same for
// everyone. Only names on the player list count as subjects, so a chat line can't fake a death notice.

import type { SystemEvent } from '@agora/shared';

const JOIN = /^([A-Za-z0-9_]{3,16}) joined the game$/;
const LEAVE = /^([A-Za-z0-9_]{3,16}) left the game$/;
const ADVANCEMENT = /^([A-Za-z0-9_]{3,16}) has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]$/;
const DEATH =
  /^([A-Za-z0-9_]{3,16}) (was .+|died|drowned.*|blew up|burned to death|fell .+|hit the ground too hard.*|starved to death.*|suffocated in a wall.*|tried to swim in lava.*|withered away.*|froze to death.*|went up in flames|walked into .+|went off with a bang.*|experienced kinetic energy.*|discovered the floor was lava|didn't want to live in the same world as .+|left the confines of this world.*|walked into the danger zone.*|was struck by lightning.*|fell out of the world)$/;
const KILLER = /\bby ([A-Za-z0-9_]{3,16}|[A-Z][a-z]+(?: [A-Z][a-z]+)*)(?: using .+)?$/;

/** Parses a non-speech system line. `isPlayer` checks the tab list. */
export function parseSystemLine(text: string, ts: number, isPlayer: (name: string) => boolean): SystemEvent | null {
  let m = JOIN.exec(text);
  if (m?.[1] && isPlayer(m[1])) return { kind: 'join', ts, text, subject: m[1] };
  m = LEAVE.exec(text);
  if (m?.[1]) return { kind: 'leave', ts, text, subject: m[1] };
  m = ADVANCEMENT.exec(text);
  if (m?.[1] && isPlayer(m[1])) return { kind: 'advancement', ts, text, subject: m[1], cause: m[2] };
  m = DEATH.exec(text);
  if (m?.[1] && m[2] && isPlayer(m[1])) {
    const k = KILLER.exec(m[2]);
    return { kind: 'death', ts, text, subject: m[1], cause: m[2], killer: k?.[1] };
  }
  return null;
}
