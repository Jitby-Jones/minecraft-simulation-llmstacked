// `pnpm logs [--agent Pip] [--module cc] [--level warn] [--lines 50] [--since 10] [--no-follow] [--raw]` (§23.3):
// the JSON logs under DATA_DIR/logs, every process at once, merged by time and followed as they grow (rotation
// and new agents' files included), in the same compact form the console uses.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths, formatLogLine, loadEnv } from '@agora/shared';

const LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

export interface LogFilter {
  agent?: string;
  module?: string;
  minLevel?: number;
  sinceTs?: number;
}

/** Whether one log line passes the filter. Lines that aren't JSON (a bot's raw stdout) pass only unfiltered. */
export function keepLine(line: string, file: string, f: LogFilter): boolean {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return !f.agent && !f.module && f.minLevel === undefined && f.sinceTs === undefined && line.trim().length > 0;
  }
  if (f.agent) {
    const a = f.agent.toLowerCase();
    const inFile = path.basename(file).toLowerCase() === `agent-${a}.log`;
    const named = [o.name, o.agent, o.persona, o.username].some((v) => typeof v === 'string' && (v.toLowerCase() === a || v.toLowerCase() === `agent-${a}`));
    if (!inFile && !named) return false;
  }
  if (f.module && o.module !== f.module) return false;
  if (f.minLevel !== undefined && (typeof o.level === 'number' ? o.level : 30) < f.minLevel) return false;
  if (f.sinceTs !== undefined && typeof o.time === 'number' && o.time < f.sinceTs) return false;
  return true;
}

/** Every *.log file under the logs directory (one level of subdirectories: agents/, bots/). */
export function logFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.log')) out.push(p);
    else if (e.isDirectory()) for (const f of fs.readdirSync(p)) if (f.endsWith('.log')) out.push(path.join(p, f));
  }
  return out.sort();
}

function timeOf(line: string): number {
  const m = /"time":(\d+)/.exec(line);
  return m?.[1] ? Number(m[1]) : 0;
}

/** The last `n` lines of a file that pass the filter, read backwards in chunks and split as bytes (a character
 *  cut at a chunk edge is joined again before decoding). */
export function tail(file: string, n: number, f: LogFilter): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    const kept: string[] = [];
    while (pos > 0 && kept.length < n) {
      const len = Math.min(64 * 1024, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const data = Buffer.concat([buf, carry]);
      // The bytes before the first newline may be the end of a line that starts in the next chunk back.
      const first = pos > 0 ? data.indexOf(0x0a) : -1;
      carry = first >= 0 ? data.subarray(0, first) : pos > 0 ? data : Buffer.alloc(0);
      if (pos > 0 && first < 0) continue;
      const lines = data.subarray(first + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && kept.length < n; i--) {
        const l = lines[i] ?? '';
        if (l.trim() && keepLine(l, file, f)) kept.push(l);
      }
    }
    if (pos === 0 && carry.length > 0 && kept.length < n) {
      const l = carry.toString('utf8');
      if (l.trim() && keepLine(l, file, f)) kept.push(l);
    }
    return kept.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

function parseArgs(argv: string[]): { filter: LogFilter; lines: number; follow: boolean; raw: boolean } {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const level = get('--level');
  const since = get('--since');
  if (level && LEVELS[level] === undefined) {
    console.error(`[logs] --level must be one of ${Object.keys(LEVELS).join(', ')}`);
    process.exit(2);
  }
  return {
    filter: {
      ...(get('--agent') ? { agent: get('--agent') } : {}),
      ...(get('--module') ? { module: get('--module') } : {}),
      ...(level ? { minLevel: LEVELS[level] } : {}),
      ...(since ? { sinceTs: Date.now() - Number(since) * 60_000 } : {}),
    },
    lines: Number(get('--lines') ?? 50) || 50,
    follow: !argv.includes('--no-follow'),
    raw: argv.includes('--raw'),
  };
}

async function main(): Promise<void> {
  loadEnv();
  const { filter, lines, follow, raw } = parseArgs(process.argv.slice(2));
  const dir = dataPaths().logs;
  const show = (l: string) => process.stdout.write(`${raw ? l : formatLogLine(l)}\n`);
  // The backlog: the last lines of every file, merged by time.
  const files = logFiles(dir);
  const backlog = files.flatMap((f) => tail(f, lines, filter));
  backlog.sort((a, b) => timeOf(a) - timeOf(b));
  for (const l of backlog.slice(-lines)) show(l);
  if (!follow) return;
  // Follow: poll sizes (fs.watch differs too much between systems); a file that shrank was rotated.
  const offsets = new Map<string, number>(files.map((f) => [f, fs.statSync(f).size]));
  // The unfinished last line of each file, kept as bytes: a character can be cut at the end of a read.
  const partial = new Map<string, Buffer>();
  for (;;) {
    for (const f of logFiles(dir)) {
      let size: number;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      let from = offsets.get(f) ?? 0;
      if (size < from) {
        // Rotated: start over at the top of the new file.
        from = 0;
        partial.delete(f);
      }
      if (size === from) continue;
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      offsets.set(f, size);
      const data = Buffer.concat([partial.get(f) ?? Buffer.alloc(0), buf]);
      const end = data.lastIndexOf(0x0a);
      partial.set(f, end >= 0 ? data.subarray(end + 1) : data);
      if (end < 0) continue;
      for (const l of data.subarray(0, end).toString('utf8').split('\n')) if (l.trim() && keepLine(l, f, filter)) show(l);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[logs] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
