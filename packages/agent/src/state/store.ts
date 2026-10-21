// The Agent State blackboard (§4.1). Modules read immutable snapshots and write through `update`, which replaces
// one facet (top-level key) copy-on-write, bumps the global and per-facet versions and emits a change event.
// LLM calls take a `guard` (§4.2): it stamps the versions at call time, aborts the call as soon as a change makes it
// pointless (danger, the conversation ended), and tells the caller at reply time whether the state moved on too
// far for the result to be used.

import { EventEmitter } from 'node:events';
import type { AgentState } from '@agora/shared';

export type Facet = Exclude<keyof AgentState, 'version'>;

export interface StateChange {
  facet: Facet;
  /** Global version after this change. */
  version: number;
  reason: string;
  prev: AgentState;
  next: AgentState;
}

export interface StateStamp {
  version: number;
  facets: Readonly<Record<Facet, number>>;
}

export interface StalePolicy {
  name: string;
  /** Facets whose changes count toward `maxChanges`. */
  watch: readonly Facet[];
  /** More changes than this to watched facets and the reply is thrown away (default: no limit). */
  maxChanges?: number;
  /** A change that makes the call pointless: abort it immediately. Returns the reason, or null. */
  abortOn?: (change: StateChange) => string | null;
}

export interface CallGuard {
  readonly signal: AbortSignal;
  readonly stamp: StateStamp;
  /** The version check at reply time (safe to pass around unbound: `isStale: guard.isStale`). */
  readonly isStale: () => boolean;
  /** Why the call went stale, if it did. */
  readonly reason: () => string | null;
  readonly dispose: () => void;
}

function isPlain(v: unknown): v is Record<string, unknown> | unknown[] {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-freezes plain objects and arrays so a module that mutates a snapshot fails loudly. Class instances (e.g.
 * mineflayer's live Vec3s) are left alone: freezing them would break the library that owns them.
 */
export function deepFreeze<T>(v: T): T {
  if (!isPlain(v) || Object.isFrozen(v)) return v;
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  return v;
}

export class AgentStateStore extends EventEmitter<{ change: [StateChange] }> {
  private s: AgentState;
  private readonly fv: Record<Facet, number>;

  constructor(initial: AgentState) {
    super();
    this.setMaxListeners(100);
    this.s = deepFreeze({ ...initial });
    this.fv = Object.fromEntries(Object.keys(initial).filter((k) => k !== 'version').map((k) => [k, 0])) as Record<Facet, number>;
  }

  /** The current snapshot. Never mutate it; write with `update`. */
  get state(): AgentState {
    return this.s;
  }

  get version(): number {
    return this.s.version;
  }

  facetVersion(facet: Facet): number {
    return this.fv[facet];
  }

  /**
   * Replaces one facet with `fn(current)`. Returning the same reference is a no-op (no version bump, no event),
   * so callers can bail out cheaply.
   */
  update<K extends Facet>(facet: K, fn: (current: AgentState[K]) => AgentState[K], reason: string = facet): AgentState {
    const prev = this.s;
    const value = fn(prev[facet]);
    if (Object.is(value, prev[facet])) return prev;
    const next = deepFreeze({ ...prev, [facet]: value, version: prev.version + 1 });
    this.s = next;
    this.fv[facet]++;
    this.emit('change', { facet, version: next.version, reason, prev, next });
    return next;
  }

  set<K extends Facet>(facet: K, value: AgentState[K], reason: string = facet): AgentState {
    return this.update(facet, () => value, reason);
  }

  stamp(): StateStamp {
    return { version: this.s.version, facets: { ...this.fv } };
  }

  /** Changes to `facets` since `stamp`. */
  changesSince(stamp: StateStamp, facets: readonly Facet[]): number {
    return facets.reduce((a, f) => a + (this.fv[f] - (stamp.facets[f] ?? 0)), 0);
  }

  /** Stamps the state for one LLM call (§4.2). Pass `parent` to chain a shutdown signal. */
  guard(policy: StalePolicy, parent?: AbortSignal): CallGuard {
    const stamp = this.stamp();
    const ac = new AbortController();
    let why: string | null = null;
    const stale = (reason: string) => {
      if (why !== null) return;
      why = reason;
      ac.abort(new Error(`stale: ${reason}`));
    };
    const onChange = (c: StateChange) => {
      const r = policy.abortOn?.(c) ?? null;
      if (r !== null) stale(r);
    };
    const onParent = () => {
      if (why === null) why = 'shut down';
      ac.abort(parent?.reason);
    };
    this.on('change', onChange);
    if (parent) {
      if (parent.aborted) onParent();
      else parent.addEventListener('abort', onParent, { once: true });
    }
    const dispose = () => {
      this.off('change', onChange);
      parent?.removeEventListener('abort', onParent);
    };
    return {
      signal: ac.signal,
      stamp,
      isStale: () => {
        if (why !== null) return true;
        if (policy.maxChanges !== undefined && this.changesSince(stamp, policy.watch) > policy.maxChanges) {
          why = `${this.changesSince(stamp, policy.watch)} changes to ${policy.watch.join('/')} (limit ${policy.maxChanges})`;
          return true;
        }
        return false;
      },
      reason: () => why,
      dispose,
    };
  }
}
