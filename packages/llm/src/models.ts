// Layer 3 (§22.3): the subscription model list is the allowlist. GET /api/subscription/v1/models?detailed=true
// returns capabilities directly (checked live, M0), so no /api/v1/models join is needed. Parsed leniently: one
// odd entry must not take the whole list down, and NanoGPT adds fields often.

import { z } from 'zod';
import { SUBSCRIPTION_BASE_URL } from './guard';

export type ModelCapability = 'structured_output' | 'tool_calling' | 'reasoning' | 'vision';

export interface ModelInfo {
  id: string;
  aliases: string[];
  name: string;
  ownedBy: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  capabilities: ReadonlySet<ModelCapability>;
  /** USD per million tokens as listed (a size/speed proxy only: subscription calls are not billed). */
  priceIn: number | null;
  priceOut: number | null;
  /** Produces chat text (not images, audio or "decisions"). */
  chat: boolean;
  /** A `:thinking` variant: slower, never picked automatically for L1. */
  thinking: boolean;
}

// NanoGPT's own router and help bot: allowed when configured by id, never picked by `auto`.
export const NOT_AUTO_PICKED: ReadonlySet<string> = new Set(['auto-model', 'nano-gpt-help']);

const EntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    owned_by: z.string().optional(),
    context_length: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    architecture: z
      .object({ modality: z.string().optional(), output_modalities: z.array(z.string()).optional() })
      .loose()
      .optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    pricing: z.object({ prompt: z.number().nullable().optional(), completion: z.number().nullable().optional() }).loose().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .loose();

const CAPS: readonly ModelCapability[] = ['structured_output', 'tool_calling', 'reasoning', 'vision'];

export function parseModelList(json: unknown): ModelInfo[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('model list: expected { data: [...] }');
  const out: ModelInfo[] = [];
  for (const raw of data) {
    const r = EntrySchema.safeParse(raw);
    if (!r.success) continue;
    const e = r.data;
    const caps = new Set<ModelCapability>(CAPS.filter((c) => e.capabilities?.[c] === true));
    const outputs = e.architecture?.output_modalities;
    const modality = e.architecture?.modality ?? '';
    out.push({
      id: e.id,
      aliases: e.aliases ?? [],
      name: e.name ?? e.id,
      ownedBy: e.owned_by ?? e.id.split('/')[0] ?? 'unknown',
      contextLength: e.context_length ?? null,
      maxOutputTokens: e.max_output_tokens ?? null,
      capabilities: caps,
      priceIn: e.pricing?.prompt ?? null,
      priceOut: e.pricing?.completion ?? null,
      chat: (outputs ? outputs.includes('text') : true) && !modality.endsWith('->decisions'),
      thinking: e.id.endsWith(':thinking'),
    });
  }
  return out;
}

export async function fetchSubscriptionModels(fetchImpl: typeof fetch, apiKey?: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(`${SUBSCRIPTION_BASE_URL}/models?detailed=true`, { method: 'GET', headers, signal });
  if (!res.ok) throw new Error(`model list: HTTP ${res.status}`);
  const models = parseModelList(await res.json());
  if (models.length === 0) throw new Error('model list: empty');
  return models;
}

/** The session's allowlist: the subscription list minus models a rejection removed for this session (§22.6). */
export class ModelAllowlist {
  private byId = new Map<string, ModelInfo>();
  private alias = new Map<string, string>();
  private readonly removed = new Map<string, string>();
  fetchedAt = 0;

  constructor(models: readonly ModelInfo[] = [], now = Date.now()) {
    if (models.length > 0) this.replace(models, now);
  }

  /** Swaps in a fresh list; returns what appeared and what disappeared. */
  replace(models: readonly ModelInfo[], now = Date.now()): { added: string[]; dropped: string[] } {
    const before = new Set(this.byId.keys());
    this.byId = new Map(models.map((m) => [m.id, m]));
    this.alias = new Map();
    for (const m of models) for (const a of m.aliases) this.alias.set(a.toLowerCase(), m.id);
    this.fetchedAt = now;
    const after = new Set(this.byId.keys());
    return { added: [...after].filter((id) => !before.has(id)), dropped: [...before].filter((id) => !after.has(id)) };
  }

  /** Canonical id for an id or alias, or null when it is not (or no longer) allowed. */
  resolve(idOrAlias: string): string | null {
    const id = this.byId.has(idOrAlias) ? idOrAlias : (this.alias.get(idOrAlias.toLowerCase()) ?? null);
    return id && !this.removed.has(id) ? id : null;
  }

  get(idOrAlias: string): ModelInfo | null {
    const id = this.resolve(idOrAlias);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  has(idOrAlias: string): boolean {
    return this.resolve(idOrAlias) !== null;
  }

  /** A 402 / "not covered" answer takes the model out for the rest of the session. */
  removeForSession(id: string, reason: string): void {
    this.removed.set(id, reason);
  }

  removedForSession(): ReadonlyMap<string, string> {
    return this.removed;
  }

  list(): ModelInfo[] {
    return [...this.byId.values()].filter((m) => !this.removed.has(m.id));
  }

  get size(): number {
    return this.list().length;
  }
}
