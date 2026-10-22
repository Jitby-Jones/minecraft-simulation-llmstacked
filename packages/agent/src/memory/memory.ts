// Memory (§4.2 module 5, §4.7 Summarize-and-Forget). workmem holds ~5 items in RAM; what falls out goes to
// recentmem (SQLite, ~50 items, near-duplicates replaced at cosine > 0.90). When recentmem is full, its older part is
// clustered (agglomerative, cosine ≥ 0.80), each cluster summarized by L1 (code fallback), and moved to longmem,
// deduplicated again. Retrieval ranks by cosine × recency × importance. Every memory keeps its source; what someone
// told us is hearsay (`told_by:X`, confidence = trust × 0.8) and is labeled as such in the CC packet (§6.5).

import { type AgentName, type Logger, type MemorySource, type WorkItem } from '@agora/shared';
import { type Embedder, type LlmClient, cosine } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import type { MemoryDB, MemoryRow } from './db';

export interface MemoryOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  db: MemoryDB;
  embedder: Embedder;
  llm: LlmClient | null;
  me: AgentName;
  now?: () => number;
  recentCap?: number;
  dedupAt?: number;
  clusterAt?: number;
  halfLifeMs?: number;
}

export interface Recalled {
  id: string;
  text: string;
  /** As shown to the CC: hearsay is labeled. */
  label: string;
  score: number;
  source: MemorySource;
}

const MergedSchema = z.object({ text: z.string().min(1).max(400) });

/** Agglomerative clustering with average linkage; returns index groups. */
export function clusterVectors(vecs: readonly Float32Array[], threshold: number): number[][] {
  const groups = vecs.map((_, i) => [i]);
  const sim = (a: number[], b: number[]) => {
    let s = 0;
    for (const i of a) for (const j of b) s += cosine(vecs[i] as Float32Array, vecs[j] as Float32Array);
    return s / (a.length * b.length);
  };
  for (;;) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const s = sim(groups[i] as number[], groups[j] as number[]);
        if (s > best) {
          best = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (best < threshold || bi < 0) return groups;
    groups[bi] = [...(groups[bi] as number[]), ...(groups[bj] as number[])];
    groups.splice(bj, 1);
  }
}

let seq = 0;

export class Memory {
  private readonly now: () => number;
  private readonly offs: (() => void)[] = [];
  private consolidating: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly o: MemoryOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const onChange = (c: { facet: string; prev: { workmem: WorkItem[] }; next: { workmem: WorkItem[] } }) => {
      if (c.facet !== 'workmem') return;
      const kept = new Set(c.next.workmem.map((w) => w.id));
      const dropped = c.prev.workmem.filter((w) => !kept.has(w.id));
      if (dropped.length > 0) void this.enqueue(() => this.ingest(dropped));
    };
    this.o.store.on('change', onChange);
    this.offs.push(() => this.o.store.off('change', onChange));
    // What people tell us goes on our mind as hearsay (and from there into memory).
    this.offs.push(
      this.o.bus.on('addressed', (e) => {
        const u = e.utterance;
        if (u.text.split(/\s+/).length < 4) return;
        const trust = this.o.store.state.social[u.from]?.trust ?? 0.5;
        const asked = /\?\s*$/.test(u.text);
        pushWorkmem(this.o.store, `${u.from} ${asked ? 'asked' : 'said'}: "${u.text}"`, (asked ? 0.25 : 0.35) + 0.2 * trust, `told_by:${u.from}`, {
          aboutAgent: u.from,
          now: this.now(),
        });
      }),
    );
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Flushes current workmem into memory (graceful shutdown, §23.4). */
  async flush(): Promise<void> {
    const items = this.o.store.state.workmem;
    await this.enqueue(() => this.ingest(items));
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch((err: unknown) => this.o.logger.warn({ module: 'memory', err: String(err) }, 'memory job failed'));
    return this.chain;
  }

  /** workmem → recentmem, replacing near-duplicates. */
  async ingest(items: readonly WorkItem[]): Promise<void> {
    if (items.length === 0 || !this.o.db.isOpen) return;
    const vecs = await this.o.embedder.embed(items.map((w) => w.text));
    // The database may have closed while we waited (shutdown).
    if (!this.o.db.isOpen) return;
    const recent = this.o.db.list('recent');
    for (const [i, w] of items.entries()) {
      const v = vecs[i];
      if (!v) continue;
      const dupes = recent.filter((r) => r.embedding && cosine(r.embedding, v) > (this.o.dedupAt ?? 0.9)).map((r) => r.id);
      if (dupes.length > 0) this.o.db.delete(dupes);
      const told = w.source.startsWith('told_by:') ? w.source.slice('told_by:'.length) : null;
      // Hearsay is as good as its teller; an admired one's word counts for more (§18.3 halo).
      const teller = told ? this.o.store.state.social[told] : undefined;
      const trust = told ? Math.min(1, (teller?.trust ?? 0.5) + 0.2 * (teller?.admiration ?? 0) * this.o.store.state.self.persona.mind.biasProfile.halo) : 1;
      this.o.db.insert({
        id: `m${this.now().toString(36)}${(seq++).toString(36)}`,
        tier: 'recent',
        text: w.text,
        embedding: v,
        ts: w.ts,
        importance: w.salience,
        source: w.source,
        aboutAgent: w.aboutAgent ?? null,
        confidence: told ? trust * 0.8 : 1,
        isFalse: false,
      });
    }
    if (this.o.db.count('recent') > (this.o.recentCap ?? 50)) await this.consolidate();
  }

  /** recentmem (older two thirds) → clusters → longmem. */
  consolidate(): Promise<void> {
    this.consolidating ??= (async () => {
      try {
        const recent = this.o.db.list('recent').filter((r) => r.embedding);
        const take = recent.slice(0, Math.ceil((recent.length * 2) / 3));
        const groups = clusterVectors(
          take.map((r) => r.embedding as Float32Array),
          this.o.clusterAt ?? 0.8,
        );
        const long = this.o.db.list('long');
        for (const g of groups) {
          const rows = g.map((i) => take[i] as MemoryRow);
          if (rows.length === 1) {
            const only = rows[0] as MemoryRow;
            this.dedupLong(long, only.embedding as Float32Array);
            this.o.db.setTier([only.id], 'long');
            continue;
          }
          const text = await this.merge(rows);
          const [v] = await this.o.embedder.embed([text]);
          if (!this.o.db.isOpen) return;
          if (!v) continue;
          const sources = new Set(rows.map((r) => r.source));
          const about = new Set(rows.map((r) => r.aboutAgent));
          this.dedupLong(long, v);
          this.o.db.insert({
            id: `m${this.now().toString(36)}${(seq++).toString(36)}`,
            tier: 'long',
            text,
            embedding: v,
            ts: Math.max(...rows.map((r) => r.ts)),
            importance: Math.max(...rows.map((r) => r.importance)),
            source: sources.size === 1 ? (rows[0] as MemoryRow).source : 'inferred',
            aboutAgent: about.size === 1 ? (rows[0] as MemoryRow).aboutAgent : null,
            confidence: Math.min(...rows.map((r) => r.confidence)),
            isFalse: rows.every((r) => r.isFalse),
          });
          this.o.db.delete(rows.map((r) => r.id));
        }
        this.o.logger.info({ module: 'memory', moved: take.length, clusters: groups.length }, 'consolidated recent memories');
      } finally {
        this.consolidating = null;
      }
    })();
    return this.consolidating;
  }

  private dedupLong(long: MemoryRow[], v: Float32Array): void {
    const dupes = long.filter((r) => r.embedding && cosine(r.embedding, v) > (this.o.dedupAt ?? 0.9)).map((r) => r.id);
    if (dupes.length > 0) this.o.db.delete(dupes);
  }

  private async merge(rows: readonly MemoryRow[]): Promise<string> {
    const fallback = () => ({ text: rows.map((r) => r.text).slice(-3).join('; ').slice(0, 300) });
    if (!this.o.llm || this.o.store.state.flags.codeOnly) return fallback().text;
    const r = await this.o.llm.call({
      tier: 'L1',
      module: 'memory',
      agent: this.o.me,
      schema: MergedSchema,
      schemaName: 'memory',
      fallback,
      messages: [
        { role: 'system', content: 'Combine these memories into one short sentence (at most 30 words). Keep names, places, numbers and who said what. JSON: {"text": "..."}' },
        { role: 'user', content: rows.map((m) => `- ${m.text}`).join('\n') },
      ],
    });
    return r.value.text;
  }

  /** A claim turned out false (§6.5): memories quoting it never come back as true. */
  markFalseMatching(text: string): number {
    const needle = text.trim().toLowerCase();
    if (needle.length < 8 || !this.o.db.isOpen) return 0;
    const rows = this.o.db.list().filter((r) => r.text.toLowerCase().includes(needle));
    for (const r of rows) this.o.db.markFalse(r.id);
    return rows.length;
  }

  /** Top-k memories for a query: cosine × recency × importance, scaled by confidence; false ones never come back. */
  async recall(query: string, k = 4): Promise<Recalled[]> {
    if (!query.trim() || !this.o.db.isOpen) return [];
    const [q] = await this.o.embedder.embed([query]);
    if (!q || !this.o.db.isOpen) return [];
    const now = this.now();
    const half = this.o.halfLifeMs ?? 6 * 3_600_000;
    return this.o.db
      .list()
      .filter((r) => r.embedding && !r.isFalse)
      .map((r) => {
        const recency = Math.max(0.25, 0.5 ** ((now - r.ts) / half));
        const score = cosine(r.embedding as Float32Array, q) * recency * (0.5 + r.importance) * (0.5 + 0.5 * r.confidence);
        const told = r.source.startsWith('told_by:') ? r.source.slice('told_by:'.length) : null;
        return { id: r.id, text: r.text, label: told ? `${r.text} (heard from ${told}, unverified)` : r.text, score, source: r.source };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Memories that bear on something just said (Talking), hearsay labeled; nothing already on mind. */
  async relevantTo(text: string, k = 3, minScore = 0.2): Promise<string[]> {
    const onMind = new Set(this.o.store.state.workmem.map((w) => w.text));
    return (await this.recall(text, k + onMind.size)).filter((m) => !onMind.has(m.text) && m.score >= minScore).slice(0, k).map((m) => m.label);
  }

  /** What the CC packet should be reminded of now: the goal, the people around, the last thing said to us. */
  async forPacket(k: number): Promise<string[]> {
    const s = this.o.store.state;
    const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player').map((e) => e.name);
    const lastHeard = s.perception.heardSpeech.filter((u) => u.addressedToMe).at(-1)?.text ?? '';
    const query = [s.goals.current?.text ?? '', people.join(' '), lastHeard, s.option?.skill ?? ''].filter(Boolean).join('. ');
    const onMind = new Set(s.workmem.map((w) => w.text));
    return (await this.recall(query, k + onMind.size)).filter((m) => !onMind.has(m.text) && m.score > 0.05).slice(0, k).map((m) => m.label);
  }
}
