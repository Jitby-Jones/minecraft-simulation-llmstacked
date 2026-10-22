// pino logs: JSON lines to DATA_DIR/logs/<name>.log (rotated by size) plus a compact line on stdout.

import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger, type Level } from 'pino';
import { redactSecrets } from './env';

export type { Logger } from 'pino';

export interface LoggerOptions {
  name: string;
  level?: Level;
  logDir?: string;
  /** Rotate when the file exceeds this many MB (checked at startup and every 1000 lines). */
  rotateMb?: number;
  keep?: number;
  console?: boolean;
}

const LEVEL_NAMES: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };

/** Formats one pino JSON line as `HH:MM:SS LEVEL [name/module] msg {extra}`. Exported for `pnpm logs`. */
export function formatLogLine(line: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const time = typeof obj.time === 'number' ? new Date(obj.time).toISOString().slice(11, 19) : '--:--:--';
  const level = LEVEL_NAMES[typeof obj.level === 'number' ? obj.level : 30] ?? 'INFO';
  const name = typeof obj.name === 'string' ? obj.name : '';
  const mod = typeof obj.module === 'string' ? `/${obj.module}` : '';
  const msg = typeof obj.msg === 'string' ? obj.msg : '';
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!['time', 'level', 'name', 'module', 'msg', 'pid', 'hostname', 'v'].includes(k)) extra[k] = v;
  }
  const extraText = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  return `${time} ${level.padEnd(5)} [${name}${mod}] ${msg}${extraText}`;
}

class RotatingFile extends Writable {
  private fd: number;
  private size: number;
  private lines = 0;

  constructor(
    private readonly file: string,
    private readonly maxBytes: number,
    private readonly keep: number,
  ) {
    super();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.rotateIfNeeded(true);
    this.fd = fs.openSync(file, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  private rotateIfNeeded(atStartup = false): void {
    let size: number;
    try {
      size = atStartup ? fs.statSync(this.file).size : this.size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    if (!atStartup) fs.closeSync(this.fd);
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    if (!atStartup) {
      this.fd = fs.openSync(this.file, 'a');
      this.size = 0;
    }
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    try {
      fs.writeSync(this.fd, chunk);
      this.size += chunk.length;
      this.lines++;
      if (this.lines % 1000 === 0) this.rotateIfNeeded();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _final(cb: (error?: Error | null) => void): void {
    try {
      fs.closeSync(this.fd);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

class PrettyStdout extends Writable {
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length > 0) process.stdout.write(`${formatLogLine(line)}\n`);
    }
    cb();
  }
}

class RedactingStream extends Writable {
  constructor(private readonly inner: Writable) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.inner.write(redactSecrets(chunk.toString('utf8')), cb);
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const level: Level = opts.level ?? ((process.env.LOG_LEVEL as Level | undefined) ?? 'info');
  const streams: pino.StreamEntry[] = [];
  if (opts.logDir) {
    const file = new RotatingFile(
      path.join(opts.logDir, `${opts.name}.log`),
      (opts.rotateMb ?? 20) * 1024 * 1024,
      opts.keep ?? 5,
    );
    streams.push({ level, stream: new RedactingStream(file) });
  }
  if (opts.console !== false) streams.push({ level, stream: new RedactingStream(new PrettyStdout()) });
  if (streams.length === 0) return pino({ level, enabled: false });
  return pino(
    { name: opts.name, level, base: { pid: process.pid }, timestamp: pino.stdTimeFunctions.epochTime },
    pino.multistream(streams),
  );
}

/** Silent logger for tests. */
export function nullLogger(): Logger {
  return pino({ enabled: false });
}
