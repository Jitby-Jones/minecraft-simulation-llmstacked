// Tier resolution and hot-swapping (§22.3). Each tier gets an ordered chain of ≥ 3 allowlisted models that have
// its `need` capabilities: configured ids first, then `auto` picks (bench results when present, otherwise price as
// a size/speed proxy). An empty tier maps to the next lower one (L3 → L2 → L1); an empty L1 means code-only.

import { EventEmitter } from 'node:events';
import type { Capability, Logger } from '@agora/shared';
import { type ModelAllowlist, type ModelCapability, type ModelInfo, NOT_AUTO_PICKED } from './models';

export type TierName = 'L1' | 'L2' | 'L3';
export const TIERS: readonly TierName[] = ['L1', 'L2', 'L3'];
const LOWER: Readonly<Record<TierName, TierName | null>> = { L3: 'L2', L2: 'L1', L1: null };

export const MIN_CHAIN = 3;
const MAX_CHAIN = 5;

export interface TierSpec {
  primary: string;
  fallbacks: readonly string[];
  need: readonly Capability[];
  timeoutMs: number;
}

/** config/model-bench.json, written by `pnpm bench-models` (§11 latency check). */
export interface BenchFile {
  measuredAt: string;
  results: readonly {
    model: string;
    calls: number;
    okRate: number;
    jsonOkRate: number;
    p50Ms: number;
    p90Ms: number;
    /** Time to first streamed token (Talking), when measured. */
    ttftP50Ms?: number;
    /** CC decisions naming a real skill with valid args, when measured. */
    toolArgOkRate?: number;
  }[];
}

export interface TierResolution {
  /** Own chain per tier, before mapping. */
  own: Record<TierName, string[]>;
  /** Effective chain per tier after mapping empty tiers down. */
  chains: Record<TierName, string[]>;
  /** Which tier's models a tier actually uses (null: none left). */
  mappedTo: Record<TierName, TierName | null>;
  codeOnly: boolean;
  notes: string[];
}

function price(m: ModelInfo): number {
  return m.priceIn === null && m.priceOut === null ? Number.POSITIVE_INFINITY : (m.priceIn ?? 0) + (m.priceOut ?? 0);
}

function fits(m: ModelInfo, need: readonly Capability[]): boolean {
  return m.chat && need.every((c) => m.capabilities.has(c as ModelCapability));
}

/** Auto ordering for one tier; earlier = preferred. */
function autoOrder(tier: TierName, candidates: ModelInfo[], spec: TierSpec, bench: BenchFile | null | undefined): ModelInfo[] {
  const benched = new Map((bench?.results ?? []).map((r) => [r.model, r]));
  const json = spec.need.includes('structured_output');
  const good = (m: ModelInfo) => {
    const r = benched.get(m.id);
    return r !== undefined && r.okRate >= 0.9 && (!json || r.jsonOkRate >= 0.9) && r.p90Ms < spec.timeoutMs;
  };
  const measured = candidates.filter(good);
  const rest = candidates.filter((m) => !good(m));
  const byPrice = (a: ModelInfo, b: ModelInfo) => price(a) - price(b) || a.id.localeCompare(b.id);
  // 2 = a :thinking variant, 1 = may reason by default, 0 = plain.
  const slow = (m: ModelInfo) => (m.thinking ? 2 : m.capabilities.has('reasoning') ? 1 : 0);
  let measuredSorted: ModelInfo[];
  let restSorted: ModelInfo[];
  switch (tier) {
    case 'L1':
      // Fastest measured, else the cheapest-listed; models that may think by default come last (5 s budget).
      measuredSorted = [...measured].sort((a, b) => (benched.get(a.id)?.p50Ms ?? 0) - (benched.get(b.id)?.p50Ms ?? 0));
      restSorted = [...rest].sort((a, b) => slow(a) - slow(b) || byPrice(a, b));
      break;
    case 'L2': {
      // Mid-sized: around the 60th price percentile, plain models first (6 s budget).
      const sorted = [...rest].sort(byPrice);
      const finite = (m: ModelInfo) => (Number.isFinite(price(m)) ? price(m) : 1e6);
      const pivot = sorted[Math.floor(sorted.length * 0.6)];
      const target = pivot ? finite(pivot) : 0;
      const dist = (m: ModelInfo) => Math.abs(Math.log((finite(m) + 0.01) / (target + 0.01)));
      measuredSorted = [...measured].sort((a, b) => price(b) - price(a));
      restSorted = sorted.sort((a, b) => slow(a) - slow(b) || dist(a) - dist(b) || a.id.localeCompare(b.id));
      break;
    }
    case 'L3':
      // Largest: reasoning-flagged, then the priciest-listed, then the longest context. A :thinking variant comes
      // after the rest: it often runs past even the 45 s budget (35–45 s replies are common).
      measuredSorted = [...measured].sort((a, b) => price(b) - price(a));
      restSorted = [...rest].sort(
        (a, b) =>
          Number(a.thinking) - Number(b.thinking) ||
          Number(b.capabilities.has('reasoning')) - Number(a.capabilities.has('reasoning')) ||
          (Number.isFinite(price(b)) ? price(b) : -1) - (Number.isFinite(price(a)) ? price(a) : -1) ||
          (b.contextLength ?? 0) - (a.contextLength ?? 0) ||
          a.id.localeCompare(b.id),
      );
      break;
  }
  return [...measuredSorted, ...restSorted];
}

/** Adds picks to `chain` until it has `want` models, preferring providers not yet in it (5xx resilience, §22.6). */
function fill(chain: string[], ordered: ModelInfo[], want: number, allow: ModelAllowlist): void {
  const owners = new Set(chain.map((id) => allow.get(id)?.ownedBy));
  for (const pass of [0, 1]) {
    for (const m of ordered) {
      if (chain.length >= want) return;
      if (chain.includes(m.id)) continue;
      if (pass === 0 && owners.has(m.ownedBy)) continue;
      chain.push(m.id);
      owners.add(m.ownedBy);
    }
  }
}

export function resolveTiers(
  allow: ModelAllowlist,
  specs: Readonly<Record<TierName, TierSpec>>,
  bench?: BenchFile | null,
  unreliable: ReadonlyMap<TierName, ReadonlySet<string>> = new Map(),
): TierResolution {
  const notes: string[] = [];
  const own = { L1: [], L2: [], L3: [] } as Record<TierName, string[]>;
  for (const tier of TIERS) {
    const spec = specs[tier];
    const skip = unreliable.get(tier) ?? new Set<string>();
    const configured = [spec.primary, ...spec.fallbacks].filter((id) => id !== 'auto');
    const chain: string[] = [];
    for (const raw of configured) {
      const m = allow.get(raw);
      if (!m) {
        notes.push(`${tier}: configured model ${raw} is not in the subscription list`);
        continue;
      }
      if (!fits(m, spec.need)) {
        notes.push(`${tier}: ${m.id} lacks ${spec.need.filter((c) => !m.capabilities.has(c as ModelCapability)).join(', ')}`);
        continue;
      }
      if (skip.has(m.id)) {
        notes.push(`${tier}: ${m.id} is marked unreliable for this tier`);
        continue;
      }
      if (!chain.includes(m.id)) chain.push(m.id);
    }
    const wantsAuto = spec.primary === 'auto' || spec.fallbacks.includes('auto') || chain.length === 0;
    if (wantsAuto || chain.length < MIN_CHAIN) {
      const candidates = allow.list().filter((m) => fits(m, spec.need) && !NOT_AUTO_PICKED.has(m.id) && !skip.has(m.id));
      fill(chain, autoOrder(tier, candidates, spec, bench), wantsAuto ? MAX_CHAIN : MIN_CHAIN, allow);
    }
    if (chain.length > 0 && chain.length < MIN_CHAIN) notes.push(`${tier}: only ${chain.length} model(s) fit`);
    own[tier] = chain;
  }
  const mappedTo = { L1: null, L2: null, L3: null } as Record<TierName, TierName | null>;
  const chains = { L1: [], L2: [], L3: [] } as Record<TierName, string[]>;
  for (const tier of TIERS) {
    let t: TierName | null = tier;
    while (t && own[t].length === 0) t = LOWER[t];
    mappedTo[tier] = t;
    chains[tier] = t ? own[t] : [];
    if (t && t !== tier) notes.push(`${tier} has no models; using ${t}'s`);
  }
  const codeOnly = own.L1.length === 0;
  if (codeOnly) notes.push('L1 has no models: code-only');
  return { own, chains, mappedTo, codeOnly, notes };
}

export interface ModelSwap {
  tier: TierName;
  from: string | null;
  to: string | null;
  reason: string;
}

export interface ModelRouterOptions {
  allowlist: ModelAllowlist;
  fetchModels: (signal?: AbortSignal) => Promise<ModelInfo[]>;
  specs: Readonly<Record<TierName, TierSpec>>;
  bench?: BenchFile | null;
  refreshMs: number;
  logger: Logger;
  now?: () => number;
}

/**
 * Keeps tier chains current: refreshes the allowlist every few hours and right after a rejection, and hot-swaps
 * when a model in use disappears (`swap` events) instead of failing.
 */
export class ModelRouter extends EventEmitter<{ swap: [ModelSwap]; resolved: [TierResolution] }> {
  private res: TierResolution;
  private readonly unreliable = new Map<TierName, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: ModelRouterOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.res = resolveTiers(opts.allowlist, opts.specs, opts.bench);
  }

  get resolution(): TierResolution {
    return this.res;
  }

  get allowlist(): ModelAllowlist {
    return this.opts.allowlist;
  }

  chain(tier: TierName): readonly string[] {
    return this.res.chains[tier];
  }

  get codeOnly(): boolean {
    return this.res.codeOnly;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh('scheduled'), this.opts.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-fetches the subscription list (single-flight). A failed fetch keeps the old list. */
  refresh(reason: string): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const models = await this.opts.fetchModels(AbortSignal.timeout(15_000));
        const diff = this.opts.allowlist.replace(models, this.now());
        if (diff.dropped.length > 0 || diff.added.length > 0) {
          this.opts.logger.info({ module: 'llm', reason, dropped: diff.dropped, added: diff.added.length }, 'subscription model list changed');
        }
        this.reresolve(`allowlist refresh (${reason})`);
      } catch (err) {
        this.opts.logger.warn({ module: 'llm', reason, err: String(err) }, 'model list refresh failed; keeping the old list');
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** §22.6: a 402 / not-covered answer removes the model for this session. */
  removeForSession(model: string, reason: string): void {
    this.opts.allowlist.removeForSession(model, reason);
    this.reresolve(`${model} removed: ${reason}`);
  }

  /** §22.6: frequent schema failures mark a model unreliable for one tier. */
  markUnreliable(tier: TierName, model: string): void {
    let set = this.unreliable.get(tier);
    if (!set) {
      set = new Set();
      this.unreliable.set(tier, set);
    }
    if (set.has(model)) return;
    set.add(model);
    this.reresolve(`${model} unreliable for ${tier}`);
  }

  private reresolve(reason: string): void {
    const prev = this.res;
    this.res = resolveTiers(this.opts.allowlist, this.opts.specs, this.opts.bench, this.unreliable);
    for (const tier of TIERS) {
      const from = prev.chains[tier][0] ?? null;
      const to = this.res.chains[tier][0] ?? null;
      if (from !== to) {
        const swap: ModelSwap = { tier, from, to, reason };
        this.opts.logger.warn({ module: 'llm', event: 'modelSwap', ...swap }, 'model swap');
        this.emit('swap', swap);
      }
    }
    this.emit('resolved', this.res);
  }
}
