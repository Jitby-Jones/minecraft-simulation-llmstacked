// Layer 5 (§22.5): embeddings are local by default (all-MiniLM-L6-v2 through transformers.js, files installed and
// hash-checked by setup; nothing is downloaded at runtime). They never touch NanoGPT. Requests arriving within a
// few milliseconds are batched into one model call. The Hub serves one embedder for all bots from M5 on (§23.5).

import type { Logger } from '@agora/shared';

export interface Embedder {
  readonly dims: number;
  readonly model: string;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** Cosine similarity; the vectors here are L2-normalized, so this is a dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

interface Waiting {
  texts: readonly string[];
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
}

export interface LocalEmbedderOptions {
  /** Directory that holds `<modelId>/` (DATA_DIR/cache/models). */
  modelDir: string;
  modelId: string;
  dims: number;
  logger: Logger;
  /** Collect requests for this long before one model call. */
  batchMs?: number;
}

export class LocalEmbedder implements Embedder {
  readonly dims: number;
  readonly model: string;
  private pipe: Promise<FeatureExtractor> | null = null;
  private queue: Waiting[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: LocalEmbedderOptions) {
    this.dims = o.dims;
    this.model = o.modelId;
  }

  private load(): Promise<FeatureExtractor> {
    this.pipe ??= (async () => {
      const t = await import('@huggingface/transformers');
      t.env.localModelPath = this.o.modelDir;
      t.env.allowRemoteModels = false;
      t.env.allowLocalModels = true;
      const started = Date.now();
      const p = (await t.pipeline('feature-extraction', this.o.modelId, { dtype: 'q8' })) as unknown as FeatureExtractor;
      this.o.logger.info({ module: 'embed', model: this.o.modelId, ms: Date.now() - started }, 'local embedding model loaded');
      return p;
    })();
    return this.pipe;
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.queue.push({ texts, resolve, reject });
      this.timer ??= setTimeout(() => void this.flush(), this.o.batchMs ?? 15);
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = this.queue;
    this.queue = [];
    const all = batch.flatMap((w) => [...w.texts]);
    try {
      const pipe = await this.load();
      const out = await pipe(all.map((t) => t.slice(0, 2000)), { pooling: 'mean', normalize: true });
      const dim = out.dims[1] ?? this.dims;
      const vecs = all.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
      let at = 0;
      for (const w of batch) {
        w.resolve(vecs.slice(at, at + w.texts.length));
        at += w.texts.length;
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const w of batch) w.reject(e);
    }
  }
}

/**
 * Deterministic bag-of-words hashing embedder: the fallback when the local model is missing, and the embedder for
 * unit tests. Much weaker than MiniLM but keeps dedup and retrieval working.
 */
export class HashEmbedder implements Embedder {
  readonly model = 'hash-bow';
  constructor(readonly dims = 384) {}

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array(this.dims);
        const words = t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
        for (const w of words) {
          let h = 2166136261;
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
          const idx = (h >>> 0) % this.dims;
          v[idx] = (v[idx] ?? 0) + 1;
        }
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
        return v;
      }),
    );
  }
}

/** The configured embedder: local MiniLM when its files are installed, else the hashing fallback (logged). */
export async function createEmbedder(o: LocalEmbedderOptions): Promise<Embedder> {
  const local = new LocalEmbedder(o);
  try {
    await local.embed(['warm up']);
    return local;
  } catch (err) {
    o.logger.warn({ module: 'embed', err: String(err) }, 'local embedding model unavailable (run `pnpm run setup`); using the hashing fallback');
    return new HashEmbedder(o.dims);
  }
}
