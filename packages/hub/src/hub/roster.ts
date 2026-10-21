// roster.json (§23.1, §23.4): who is alive, as whom, and every username ever used (never reused, §16.3). Written on
// every change and at shutdown; `pnpm start` reloads it and reconnects the same agents with their memories.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PersonaSchema } from '@agora/shared';

export const RosterEntrySchema = z.object({
  username: z.string(),
  persona: PersonaSchema,
  slot: z.string(),
  bornAt: z.number(),
  status: z.enum(['alive', 'dead', 'retired']),
  diedAt: z.number().optional(),
  cause: z.string().optional(),
  /** Starter kit already handed out (only on the first spawn of a life). */
  kitGiven: z.boolean().default(false),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const RosterSchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  agents: z.array(RosterEntrySchema),
  usedNames: z.array(z.string()),
  nextSlot: z.number().int().min(0),
});
export type Roster = z.infer<typeof RosterSchema>;

export function emptyRoster(): Roster {
  return { version: 1, savedAt: 0, agents: [], usedNames: [], nextSlot: 0 };
}

export function loadRoster(file: string): Roster {
  if (!fs.existsSync(file)) return emptyRoster();
  const parsed = RosterSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file} is not a valid roster: ${parsed.error.message}`);
  return parsed.data;
}

/** Atomic write (temp file + rename), so a crash never leaves half a roster. */
export function saveRoster(file: string, roster: Roster, now = Date.now()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...roster, savedAt: now }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function livingAgents(r: Roster): RosterEntry[] {
  return r.agents.filter((a) => a.status === 'alive');
}
