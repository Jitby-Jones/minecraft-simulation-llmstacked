// Runs Paper as a child process (§23.2): -Xmx from config, ready detection, stdin commands, graceful stop.

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { Logger } from '@agora/shared';

export interface PaperProcessOptions {
  javaPath: string;
  jarPath: string;
  cwd: string;
  heapMb: number;
  extraJvmArgs?: string[];
  logger: Logger;
}

/** Aikar-style flags PaperMC recommends for 26.1 (from the Fill API), minus AlwaysPreTouch for faster startup. */
export const RECOMMENDED_JVM_FLAGS = [
  '-XX:+DisableExplicitGC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:+PerfDisableSharedMem',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1NewSizePercent=30',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:G1ReservePercent=20',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:MaxGCPauseMillis=200',
  '-XX:MaxTenuringThreshold=1',
  '-XX:SurvivorRatio=32',
];

export class PaperProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private readyFlag = false;
  private exited = false;
  private readonly lines: string[] = [];

  constructor(private readonly opts: PaperProcessOptions) {
    super();
  }

  get ready(): boolean {
    return this.readyFlag;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Last ~200 console lines (for doctor/ctl). */
  recentLines(): readonly string[] {
    return this.lines;
  }

  start(): void {
    if (this.child) throw new Error('Paper already started');
    const { javaPath, jarPath, cwd, heapMb, logger } = this.opts;
    const args = [
      `-Xms${Math.max(512, Math.floor(heapMb / 2))}M`,
      `-Xmx${heapMb}M`,
      ...RECOMMENDED_JVM_FLAGS,
      ...(this.opts.extraJvmArgs ?? []),
      '-jar',
      jarPath,
      '--nogui',
    ];
    logger.info({ module: 'paper', javaPath, heapMb }, 'starting Paper');
    const child = spawn(javaPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const onLine = (line: string): void => {
      this.lines.push(line);
      if (this.lines.length > 200) this.lines.shift();
      this.emit('line', line);
      if (!this.readyFlag && /\bDone \([\d.,]+s\)!/.test(line)) {
        this.readyFlag = true;
        logger.info({ module: 'paper' }, 'Paper is ready');
        this.emit('ready');
      }
      if (/\b(WARN|ERROR)\]/.test(line)) logger.debug({ module: 'paper' }, line);
    };
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', onLine);
    if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', onLine);
    child.on('exit', (code, signal) => {
      this.exited = true;
      logger.info({ module: 'paper', code, signal }, 'Paper exited');
      this.emit('exit', code, signal);
    });
    child.on('error', (err) => {
      logger.error({ module: 'paper', err: err.message }, 'failed to launch Paper');
      this.emit('error', err);
    });
  }

  waitReady(timeoutMs = 300_000): Promise<void> {
    if (this.readyFlag) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup();
        reject(new Error(`Paper not ready after ${timeoutMs} ms`));
      }, timeoutMs);
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`Paper exited before ready (code ${code}). Last lines:\n${this.lines.slice(-15).join('\n')}`));
      };
      const cleanup = (): void => {
        clearTimeout(t);
        this.off('ready', onReady);
        this.off('exit', onExit);
      };
      this.on('ready', onReady);
      this.on('exit', onExit);
    });
  }

  /** Writes a console command (no leading slash). */
  command(cmd: string): void {
    if (!this.child?.stdin || this.exited) throw new Error('Paper is not running');
    this.child.stdin.write(`${cmd}\n`);
  }

  /** `save-all` then `stop`; kills after the timeout. */
  async stop(timeoutMs = 60_000): Promise<void> {
    if (!this.child || this.exited) return;
    const child = this.child;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      this.command('save-all flush');
      this.command('stop');
    } catch {
      // already gone
    }
    const timer = setTimeout(() => {
      this.opts.logger.warn({ module: 'paper' }, 'Paper did not stop in time; killing');
      child.kill('SIGKILL');
    }, timeoutMs);
    await exited;
    clearTimeout(timer);
  }
}
