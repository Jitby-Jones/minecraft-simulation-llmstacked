// One SQLite file per bot (§4.7): memories(id, tier, text, embedding BLOB, ts, importance, source, about_agent),
// kv (the state snapshot for resume, §23.4) and skills(...) for M10. WAL mode, so the dashboard can read while the
// bot writes.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { MemorySource } from '@agora/shared';
import { fromBlob, toBlob } from '@agora/llm';

export type MemoryTier = 'recent' | 'long';

export interface MemoryRow {
  id: string;
  tier: MemoryTier;
  text: string;
  embedding: Float32Array | null;
  ts: number;
  importance: number;
  source: MemorySource;
  aboutAgent: string | null;
  /** 0..1; hearsay starts at trust × 0.8 (§6.5). */
  confidence: number;
  /** Found to be false (a claim that failed a check, §6.5). */
  isFalse: boolean;
}

interface RawRow {
  id: string;
  tier: string;
  text: string;
  embedding: Buffer | null;
  ts: number;
  importance: number;
  source: string;
  about_agent: string | null;
  confidence: number;
  is_false: number;
}

export class MemoryDB {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB,
        ts INTEGER NOT NULL,
        importance REAL NOT NULL,
        source TEXT NOT NULL,
        about_agent TEXT,
        confidence REAL NOT NULL DEFAULT 1,
        is_false INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memories_tier_ts ON memories(tier, ts);
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        code TEXT NOT NULL,
        created INTEGER NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        uses INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  insert(r: MemoryRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO memories (id, tier, text, embedding, ts, importance, source, about_agent, confidence, is_false) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.id, r.tier, r.text, r.embedding ? toBlob(r.embedding) : null, r.ts, r.importance, r.source, r.aboutAgent, r.confidence, r.isFalse ? 1 : 0);
  }

  delete(ids: readonly string[]): void {
    const del = this.db.prepare('DELETE FROM memories WHERE id = ?');
    this.db.transaction((xs: readonly string[]) => {
      for (const id of xs) del.run(id);
    })(ids);
  }

  setTier(ids: readonly string[], tier: MemoryTier): void {
    const up = this.db.prepare('UPDATE memories SET tier = ? WHERE id = ?');
    this.db.transaction((xs: readonly string[]) => {
      for (const id of xs) up.run(tier, id);
    })(ids);
  }

  markFalse(id: string, isFalse = true): void {
    this.db.prepare('UPDATE memories SET is_false = ? WHERE id = ?').run(isFalse ? 1 : 0, id);
  }

  list(tier?: MemoryTier): MemoryRow[] {
    const rows = (tier
      ? this.db.prepare('SELECT * FROM memories WHERE tier = ? ORDER BY ts').all(tier)
      : this.db.prepare('SELECT * FROM memories ORDER BY ts').all()) as RawRow[];
    return rows.map((r) => ({
      id: r.id,
      tier: r.tier === 'long' ? 'long' : 'recent',
      text: r.text,
      embedding: r.embedding ? fromBlob(r.embedding) : null,
      ts: r.ts,
      importance: r.importance,
      source: r.source as MemorySource,
      aboutAgent: r.about_agent,
      confidence: r.confidence,
      isFalse: r.is_false === 1,
    }));
  }

  /** Small JSON values (the state snapshot, §23.4). */
  setKV(key: string, value: unknown, ts = Date.now()): void {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value, ts) VALUES (?, ?, ?)').run(key, JSON.stringify(value), ts);
  }

  getKV(key: string): { value: unknown; ts: number } | null {
    const row = this.db.prepare('SELECT value, ts FROM kv WHERE key = ?').get(key) as { value: string; ts: number } | undefined;
    return row ? { value: JSON.parse(row.value) as unknown, ts: row.ts } : null;
  }

  /** Flushes the WAL into the main file (before archiving or exporting it). */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  count(tier: MemoryTier): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE tier = ?').get(tier) as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
