// One SQLite file per bot (§4.7): memories(id, tier, text, embedding BLOB, ts, importance, source, about_agent),
// kv (the state snapshot for resume, §23.4) and skills (the skills it wrote for itself, M10). WAL mode, so the
// dashboard can read while the bot writes.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { MemorySource } from '@agora/shared';
import { fromBlob, toBlob } from '@agora/llm';

export type MemoryTier = 'recent' | 'long';

/** A skill the agent wrote for itself (M10), as kept. */
export interface SkillRow {
  name: string;
  description: string;
  /** Argument name → type ("number" | "string" | "boolean"). */
  args: Record<string, string>;
  /** What holds once it has worked (a condition), e.g. "inventoryHas:torch>={qty}". */
  check: string | null;
  code: string;
  created: number;
  /** When a trial run did what it said it would (null: not yet). */
  verified: number | null;
  uses: number;
  successes: number;
  embedding: Float32Array | null;
}

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
    // M10 columns on a database from before them.
    const have = new Set((this.db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]).map((c) => c.name));
    for (const [col, def] of [
      ['args', "TEXT NOT NULL DEFAULT '{}'"],
      ['check_cond', 'TEXT'],
      ['successes', 'INTEGER NOT NULL DEFAULT 0'],
      ['embedding', 'BLOB'],
    ] as const) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE skills ADD COLUMN ${col} ${def}`);
    }
  }

  /** The skills it wrote for itself (M10), verified or not. */
  skills(): SkillRow[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY created').all() as {
      name: string;
      description: string;
      args: string;
      check_cond: string | null;
      code: string;
      created: number;
      verified: number;
      uses: number;
      successes: number;
      embedding: Buffer | null;
    }[];
    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      args: JSON.parse(r.args) as Record<string, string>,
      check: r.check_cond,
      code: r.code,
      created: r.created,
      verified: r.verified > 0 ? r.verified : null,
      uses: r.uses,
      successes: r.successes,
      embedding: r.embedding ? fromBlob(r.embedding) : null,
    }));
  }

  saveSkill(r: SkillRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO skills (name, description, args, check_cond, code, created, verified, uses, successes, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.name, r.description, JSON.stringify(r.args), r.check, r.code, r.created, r.verified ?? 0, r.uses, r.successes, r.embedding ? toBlob(r.embedding) : null);
  }

  /** A run of a skill it wrote: counted, and counted as a success if it worked. */
  skillUsed(name: string, ok: boolean): void {
    this.db.prepare('UPDATE skills SET uses = uses + 1, successes = successes + ? WHERE name = ?').run(ok ? 1 : 0, name);
  }

  insert(r: MemoryRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO memories (id, tier, text, embedding, ts, importance, source, about_agent, confidence, is_false) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.id, r.tier, r.text, r.embedding ? toBlob(r.embedding) : null, r.ts, r.importance, r.source, r.aboutAgent, r.confidence, r.isFalse ? 1 : 0);
  }

  /** One memory by id, or null. */
  get(id: string): MemoryRow | null {
    return this.list().find((r) => r.id === id) ?? null;
  }

  /** Changes a memory's text (with its new embedding), importance, or whether it is known false (debug controls). */
  update(id: string, patch: { text?: string; embedding?: Float32Array | null; importance?: number; isFalse?: boolean; source?: MemorySource }): boolean {
    const r = this.get(id);
    if (!r) return false;
    this.insert({
      ...r,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.embedding !== undefined ? { embedding: patch.embedding } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      ...(patch.isFalse !== undefined ? { isFalse: patch.isFalse } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
    });
    return true;
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

  /** False once closed (shutdown): late callers find nothing instead of an error. */
  get isOpen(): boolean {
    return this.db.open;
  }

  close(): void {
    this.db.close();
  }
}
