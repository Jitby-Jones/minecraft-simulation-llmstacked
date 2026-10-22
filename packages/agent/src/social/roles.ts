// What others seem to do for the village, from what they're seen doing (§6.3 perceivedRole, in code; the L2
// conversation read can still name one). Each deed seen adds to a tally per person that halves every 10 minutes;
// the role is the work with the biggest tally once it reaches 3: someone seen chopping three logs is a woodcutter,
// for now. Digging dirt, the stuff huts are made of, counts half toward building: a builder gathers long before
// setting a block down, and a few dug for a shelter or on the way to stone don't make a builder. It feeds the
// division of labor (village.ts `others`) and what the agent knows of people.

import type { AgentName, ObservedAction } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { KIND_OF_ROLE, ROLE_OF, type VillageKind } from './village';

const HALF_LIFE_MS = 10 * 60_000;
const ROLE_AT = 3;
const HOSTILE = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|spider|cave_spider|creeper|witch|enderman|slime|phantom|pillager|vindicator|silverfish)$/;
const ANIMAL = /^(cow|pig|sheep|chicken|rabbit|mooshroom|goat)$/;
const BUILDING_DIRT = /^(dirt|grass_block|coarse_dirt|rooted_dirt)$/;

/** The kind of work a deed shows, or null. */
export function workOf(a: ObservedAction): VillageKind | null {
  const item = a.item ?? '';
  if (a.kind === 'dig') {
    if (/_(log|wood|stem)$/.test(item)) return 'wood';
    if (/(^stone$|cobblestone|deepslate|_ore$|^andesite$|^diorite$|^granite$|^tuff$)/.test(item)) return 'stone';
    return BUILDING_DIRT.test(item) ? 'build' : null;
  }
  // A blow at a mob (a person is never `item`, and a fight with a person has a `target`).
  if (a.kind === 'attack' && !a.target) return HOSTILE.test(item) ? 'guard' : ANIMAL.test(item) ? 'food' : null;
  if (a.kind === 'place' && !/(torch|sign|_bed|crafting_table|furnace|chest)$/.test(item)) return 'build';
  return null;
}

/** How much a deed counts toward its kind of work: dirt dug counts half (gathering, maybe for something else). */
export function weightOf(a: ObservedAction): number {
  return a.kind === 'dig' && BUILDING_DIRT.test(a.item ?? '') ? 0.5 : 1;
}

export interface RoleWatchOptions {
  store: AgentStateStore;
  bus: AgentBus;
  me: AgentName;
  now?: () => number;
}

export class RoleWatch {
  private readonly tallies = new Map<AgentName, Map<VillageKind, { v: number; at: number }>>();
  private off: (() => void) | null = null;

  constructor(private readonly o: RoleWatchOptions) {}

  start(): void {
    this.off = this.o.bus.on('observedAction', (e) => this.saw(e.action));
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  private saw(a: ObservedAction): void {
    if (a.actor === this.o.me) return;
    const kind = workOf(a);
    if (!kind) return;
    const t = this.now;
    const per = this.tallies.get(a.actor) ?? new Map<VillageKind, { v: number; at: number }>();
    this.tallies.set(a.actor, per);
    const cur = per.get(kind);
    per.set(kind, { v: (cur ? cur.v * 0.5 ** ((t - cur.at) / HALF_LIFE_MS) : 0) + weightOf(a), at: t });
    const role = this.roleOf(a.actor, t);
    if (role && this.o.store.state.social[a.actor]?.perceivedRole !== role) {
      this.o.store.update(
        'social',
        (all) => {
          const p = all[a.actor];
          return p ? { ...all, [a.actor]: { ...p, perceivedRole: role } } : all;
        },
        `role:${a.actor}`,
      );
    }
  }

  /** The role a person seems to have now, from deeds (null under ROLE_AT). */
  roleOf(name: AgentName, t = this.now): string | null {
    const per = this.tallies.get(name);
    if (!per) return null;
    let best: [VillageKind, number] | null = null;
    for (const [k, x] of per) {
      const v = x.v * 0.5 ** ((t - x.at) / HALF_LIFE_MS);
      if (!best || v > best[1]) best = [k, v];
    }
    return best && best[1] >= ROLE_AT ? ROLE_OF[best[0]] : null;
  }

  /**
   * Others' work by kind, for the division of labor: people seen at it lately, or known to have that role from what
   * they said (perceivedRole from the conversation read) while they've been around in the last half hour.
   */
  others(t = this.now): Partial<Record<VillageKind, number>> {
    const out: Partial<Record<VillageKind, number>> = {};
    const seen = new Set<AgentName>();
    for (const name of this.tallies.keys()) {
      const role = this.roleOf(name, t);
      const kind = role ? KIND_OF_ROLE[role] : undefined;
      if (!kind) continue;
      seen.add(name);
      out[kind] = (out[kind] ?? 0) + 1;
    }
    for (const p of Object.values(this.o.store.state.social)) {
      if (seen.has(p.name) || p.name === this.o.me || t - p.lastSeen > 30 * 60_000) continue;
      const kind = p.perceivedRole ? KIND_OF_ROLE[p.perceivedRole] : undefined;
      if (kind) out[kind] = (out[kind] ?? 0) + 1;
    }
    return out;
  }
}
