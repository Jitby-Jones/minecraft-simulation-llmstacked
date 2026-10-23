// roster.json (§23.1, §23.4): who is alive, as whom, and every username ever used (never reused, §16.3). Written on
// every change and at shutdown; `pnpm start` reloads it and reconnects the same agents with their memories.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BirthFactsSchema, PersonaSchema, Vec3Schema } from '@agora/shared';
import { AgentSkinSchema } from '../skins/service';

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
  /** The skin the agent wears (§16.5), given when it was created. */
  skin: AgentSkinSchema.optional(),
  /** Born in-world (§19.3, §19.4): its parents' usernames, what it starts out knowing, and where it first appears. */
  parents: z.tuple([z.string(), z.string()]).optional(),
  birthFacts: BirthFactsSchema.optional(),
  spawnAt: Vec3Schema.optional(),
  /** Put at spawnAt already (only on the first start of a life). */
  placed: z.boolean().default(false),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

/** A child on the way (§19.3): its parents, where it will appear, when, and how each parent was seen by the other. */
export const PendingBirthSchema = z.object({
  parents: z.tuple([z.string(), z.string()]),
  bedPos: Vec3Schema,
  dueAt: z.number(),
  /** Parent → what the other parent believes of them, and their sex as seen (for a parent we have no persona for). */
  seen: z.record(z.string(), z.object({ model: z.record(z.string(), z.number()), sex: z.enum(['male', 'female', 'unknown']) })),
  /** The child, drawn at conception (its numbers from its parents) and written by the master model while on the way. */
  persona: PersonaSchema.optional(),
  /** The master model has had its turn at writing the child (if not, it is written again after a restart). */
  written: z.boolean().optional(),
});
export type PendingBirth = z.infer<typeof PendingBirthSchema>;

export const RosterSchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  agents: z.array(RosterEntrySchema),
  usedNames: z.array(z.string()),
  nextSlot: z.number().int().min(0),
  pendingBirths: z.array(PendingBirthSchema).default([]),
});
export type Roster = z.infer<typeof RosterSchema>;

export function emptyRoster(): Roster {
  return { version: 1, savedAt: 0, agents: [], usedNames: [], nextSlot: 0, pendingBirths: [] };
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
