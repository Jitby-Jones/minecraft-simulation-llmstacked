// State snapshot for graceful shutdown and resume (§23.4). What makes the agent who it is right now (goals,
// commitments, the social model, emotions, growth) goes into its own SQLite file. Perception, conversations and the
// running option don't: the world is perceived afresh. On resume the time offline counts as time passed: emotions
// have faded and overdue commitments are no longer pending.

import type { AgentState } from '@agora/shared';
import type { MemoryDB } from '../memory/db';
import { newSocialProfile } from './social';
import type { AgentStateStore } from './store';

export const SNAPSHOT_FACETS = [
  'selfSummary',
  'goals',
  'taskQueue',
  'commitments',
  'social',
  'drives',
  'emotions',
  'mood',
  'heardOpinions',
  'knowledge',
  'conflict',
  'family',
  'life',
  'growth',
  'traitAnnotations',
  'inoculation',
] as const satisfies readonly (keyof AgentState)[];
type SnapshotFacet = (typeof SNAPSHOT_FACETS)[number];

const KEY = 'stateSnapshot';
/** Emotions halve every 30 minutes offline (the §18 decay, coarsely). */
const EMOTION_HALF_LIFE_MS = 30 * 60_000;

export function saveSnapshot(db: MemoryDB, state: AgentState, now = Date.now()): void {
  const facets: Partial<Record<SnapshotFacet, unknown>> = {};
  for (const f of SNAPSHOT_FACETS) facets[f] = state[f];
  db.setKV(KEY, { version: 1, savedAt: now, facets }, now);
}

/** Applies a saved snapshot to a fresh store. Returns how long the agent was offline, or null without a snapshot. */
export function restoreSnapshot(db: MemoryDB, store: AgentStateStore, now = Date.now()): number | null {
  const row = db.getKV(KEY);
  const snap = row?.value as { version: number; savedAt: number; facets: Partial<Record<SnapshotFacet, unknown>> } | undefined;
  if (!snap || snap.version !== 1) return null;
  const offline = Math.max(0, now - snap.savedAt);
  const set = <K extends SnapshotFacet>(facet: K, value: AgentState[K]) => store.update(facet, () => value, 'resume');
  for (const f of SNAPSHOT_FACETS) {
    const v = snap.facets[f];
    if (v === undefined) continue;
    set(f, v as AgentState[typeof f]);
  }
  // Profiles saved before a field existed get its default (the snapshot outlives code changes).
  const persona = store.state.self.persona;
  store.update(
    'social',
    (all) => Object.fromEntries(Object.entries(all).map(([name, p]) => [name, { ...newSocialProfile(name, persona, p.firstMet), ...p }])),
    'resume: profile defaults',
  );
  const fade = 0.5 ** (offline / EMOTION_HALF_LIFE_MS);
  store.update(
    'emotions',
    (e) => {
      const out = { ...e };
      for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] = Math.round(out[k] * fade * 1000) / 1000;
      return out;
    },
    'time passed',
  );
  store.update(
    'commitments',
    (cs) => cs.map((c) => (c.dueBy !== undefined && c.dueBy < now && (c.status === 'accepted' || c.status === 'proposed') ? { ...c, status: 'broken' as const } : c)),
    'time passed',
  );
  return offline;
}
