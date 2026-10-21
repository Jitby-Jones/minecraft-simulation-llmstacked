// The supervisor (§3, §16.2, §16.3, §19.7, §23.4): one OS process per bot, so a crash or a loop takes down only
// that bot. It keeps the population between minAlive and maxAlive, assigns each slot its persona and username for
// this life (pool first, then generated, balanced by sex), hands out the starter kit, restarts crashed bots as the
// same agent, replaces the dead after respawnDelaySec under a new name (never reused), archives their memory to the
// graveyard, and shuts everyone down gracefully, writing roster.json for the next start.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  type DataPaths,
  type Logger,
  type Persona,
  type Random,
  type SexDifferences,
  type WorldConfig,
  agentDbPath,
  generatePersona,
  generateUsername,
  isValidUsername,
} from '@agora/shared';
import type { Hub, HubSession } from './hub';
import { type Roster, type RosterEntry, livingAgents, loadRoster, saveRoster } from './roster';

export interface BotProcess {
  slot: string;
  pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export type Launcher = (slot: string) => BotProcess;

/** Runs `node --import tsx <entry> --slot <slot> --hub <url>` with output appended to logs/bots/<slot>.log. */
export function nodeLauncher(o: { entry: string; cwd: string; hubUrl: string; logDir: string; env?: NodeJS.ProcessEnv }): Launcher {
  return (slot) => {
    fs.mkdirSync(o.logDir, { recursive: true });
    const out = fs.openSync(path.join(o.logDir, `${slot}.log`), 'a');
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', o.entry, '--slot', slot, '--hub', o.hubUrl], {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ['ignore', out, out],
    });
    fs.closeSync(out);
    return {
      slot,
      pid: child.pid,
      kill: (signal = 'SIGTERM') => child.kill(signal),
      onExit: (cb) => child.once('exit', cb),
    };
  };
}

export interface SupervisorOptions {
  hub: Hub;
  paths: DataPaths;
  world: WorldConfig;
  sexDiffs: SexDifferences;
  pool: readonly Persona[];
  launcher: Launcher;
  logger: Logger;
  rng: Random;
  /** Server console access for starter kits (never used to tell a bot anything). */
  rcon?: (cmd: string) => Promise<string>;
  /** Override population.initial (tests, `pnpm start --population`). */
  initial?: number;
  now?: () => number;
}

interface Running {
  proc: BotProcess;
  startedAt: number;
  crashes: number[];
}

export class Supervisor {
  private roster: Roster;
  private readonly running = new Map<string, Running>();
  private stopping = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly now: () => number;
  private target: number;

  constructor(private readonly o: SupervisorOptions) {
    this.now = o.now ?? Date.now;
    this.roster = loadRoster(o.paths.roster);
    this.target = o.initial ?? o.world.population.initial;
    o.hub.on('hello', (s) => this.onHello(s));
    o.hub.on('ready', (s, name) => void this.onReady(s, name));
    o.hub.on('died', (s, m) => this.onDied(s, m.username, m.cause));
    o.hub.on('bye', (_s, m) => this.o.logger.info({ module: 'supervisor', agent: m.username, reason: m.reason }, 'bot said bye'));
  }

  get living(): RosterEntry[] {
    return livingAgents(this.roster);
  }

  get rosterSnapshot(): Roster {
    return structuredClone(this.roster);
  }

  /** Reconnects the living agents from roster.json, then fills up to the target population, staggered. */
  async start(): Promise<void> {
    const resumed = this.living;
    for (const a of resumed) this.launch(a.slot);
    if (resumed.length > 0) this.o.logger.info({ module: 'supervisor', agents: resumed.map((a) => a.username) }, 'resuming agents');
    const want = Math.max(this.target, this.o.world.population.minAlive) - resumed.length;
    const stagger = this.o.world.population.spawnStaggerSec * 1000;
    for (let i = 0; i < want; i++) {
      if (this.stopping) return;
      if (i > 0 || resumed.length > 0) await this.sleep(stagger);
      if (this.stopping) return;
      this.spawnNew();
    }
  }

  /** `ctl population <n>` (§16.2): adds agents now, or retires the newest ones. */
  setPopulation(n: number): void {
    const max = this.o.world.population.maxAlive;
    this.target = Math.max(0, Math.min(max, n));
    const alive = this.living;
    if (alive.length < this.target) for (let i = alive.length; i < this.target; i++) this.spawnNew();
    else {
      for (const a of alive.slice(this.target).reverse()) {
        a.status = 'retired';
        this.o.hub.bySlot(a.slot)?.send({ t: 'retire', reason: 'population reduced' });
      }
      this.save();
    }
  }

  private save(): void {
    saveRoster(this.o.paths.roster, this.roster, this.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.add(t);
    });
  }

  private usedNames(): Set<string> {
    return new Set(this.roster.usedNames);
  }

  /** The next persona: unused pool entries first (balancing sex among the living), then a generated one. */
  private nextPersona(): Persona {
    const living = this.living;
    const females = living.filter((a) => a.persona.sex === 'female').length;
    const wantSex = females * 2 < living.length ? 'female' : females * 2 > living.length ? 'male' : undefined;
    const usedIds = new Set(this.roster.agents.map((a) => a.persona.id ?? a.persona.name));
    const allowed = this.o.world.personas;
    const fresh = this.o.pool.filter((p) => !usedIds.has(p.id ?? p.name) && (allowed === 'auto' || allowed.includes(p.id ?? p.name)));
    const pick = fresh.find((p) => !wantSex || p.sex === wantSex) ?? fresh[0];
    if (pick) return pick;
    return generatePersona({ rng: this.o.rng, world: this.o.world, sexDiffs: this.o.sexDiffs, takenNames: this.usedNames(), ...(wantSex ? { sex: wantSex } : {}) });
  }

  private spawnNew(): RosterEntry {
    const persona = this.nextPersona();
    const used = this.usedNames();
    const username = isValidUsername(persona.name) && !used.has(persona.name) ? persona.name : generateUsername(persona.name, used, this.o.rng);
    const entry: RosterEntry = { username, persona, slot: `a${this.roster.nextSlot}`, bornAt: this.now(), status: 'alive', kitGiven: false };
    this.roster.nextSlot++;
    this.roster.agents.push(entry);
    this.roster.usedNames.push(username);
    this.save();
    this.o.logger.info({ module: 'supervisor', agent: username, persona: persona.id ?? persona.name, source: persona.source }, 'new agent');
    this.launch(entry.slot);
    return entry;
  }

  private launch(slot: string, crashes: number[] = []): void {
    if (this.stopping || this.running.has(slot)) return;
    const proc = this.o.launcher(slot);
    const run: Running = { proc, startedAt: this.now(), crashes };
    this.running.set(slot, run);
    proc.onExit((code, signal) => this.onExit(slot, run, code, signal));
  }

  private onExit(slot: string, run: Running, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.running.get(slot) === run) this.running.delete(slot);
    const entry = this.roster.agents.find((a) => a.slot === slot);
    if (this.stopping || !entry) return;
    if (entry.status === 'dead') {
      this.archive(entry);
      this.scheduleReplacement();
      return;
    }
    if (entry.status === 'retired') return;
    // A crash or a lost connection is not a death: restart the same agent, with backoff.
    const t = this.now();
    const crashes = [...run.crashes, t].filter((x) => t - x < 10 * 60_000);
    const delay = Math.min(60_000, 2000 * 2 ** (crashes.length - 1));
    this.o.logger.warn({ module: 'supervisor', agent: entry.username, code, signal, restartInMs: delay }, 'bot process exited; restarting');
    const t2 = setTimeout(() => {
      this.timers.delete(t2);
      this.launch(slot, crashes);
    }, delay);
    this.timers.add(t2);
  }

  private onHello(s: HubSession): void {
    const entry = this.roster.agents.find((a) => a.slot === s.slot);
    if (!entry || entry.status !== 'alive') {
      s.send({ t: 'shutdown', reason: 'no such living agent' });
      return;
    }
    const resume = fs.existsSync(this.memoryFile(entry.username));
    const kit = this.o.world.population.starterKit;
    const giveKit = !entry.kitGiven && (kit === 'persona' || (kit === 'auto' && this.o.world.mode === 'test'));
    s.send({ t: 'assign', persona: entry.persona, username: entry.username, resume, giveStarterKit: giveKit });
  }

  private async onReady(s: HubSession, username: string): Promise<void> {
    const entry = this.roster.agents.find((a) => a.slot === s.slot && a.username === username);
    if (!entry) return;
    const kit = this.o.world.population.starterKit;
    if (!entry.kitGiven && (kit === 'persona' || (kit === 'auto' && this.o.world.mode === 'test')) && this.o.rcon) {
      for (const it of entry.persona.inventory) {
        if (!/^[a-z0-9_]+$/.test(it.item)) continue;
        await this.o.rcon(`give ${username} minecraft:${it.item} ${it.qty}`).catch(() => '');
      }
    }
    entry.kitGiven = true;
    this.save();
  }

  private onDied(s: HubSession, username: string, cause: string): void {
    const entry = this.roster.agents.find((a) => a.slot === s.slot && a.username === username);
    if (!entry || entry.status !== 'alive') return;
    entry.status = 'dead';
    entry.diedAt = this.now();
    entry.cause = cause;
    this.save();
    this.o.logger.info({ module: 'supervisor', agent: username, cause }, 'agent died');
  }

  private memoryFile(username: string): string {
    return agentDbPath(this.o.paths, username);
  }

  /** §16.3: the dead agent's memory goes to the graveyard and is never loaded into anyone. */
  private archive(entry: RosterEntry): void {
    const src = this.memoryFile(entry.username);
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(this.o.paths.graveyard, { recursive: true });
    const dest = path.join(this.o.paths.graveyard, `${entry.username}-${entry.diedAt ?? this.now()}.db`);
    fs.copyFileSync(src, dest);
    // A bot that crashed may leave its last writes in the WAL; SQLite replays it when the copy is opened.
    if (fs.existsSync(`${src}-wal`)) fs.copyFileSync(`${src}-wal`, `${dest}-wal`);
    for (const f of [src, `${src}-wal`, `${src}-shm`]) fs.rmSync(f, { force: true });
    this.o.logger.info({ module: 'supervisor', agent: entry.username, dest }, 'memory archived to the graveyard');
  }

  private scheduleReplacement(): void {
    if (this.living.length >= Math.max(this.o.world.population.minAlive, this.target)) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopping && this.living.length < Math.max(this.o.world.population.minAlive, this.target)) this.spawnNew();
    }, this.o.world.population.respawnDelaySec * 1000);
    this.timers.add(t);
  }

  /** §23.4: everyone flushes memory and writes a snapshot, then disconnects; roster.json is saved last. */
  async shutdown(reason: string, timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const waiting = [...this.running.keys()];
    this.o.hub.broadcast({ t: 'shutdown', reason });
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline && waiting.some((slot) => this.running.has(slot))) await new Promise((r) => setTimeout(r, 200));
    for (const [slot, run] of this.running) {
      this.o.logger.warn({ module: 'supervisor', slot }, 'bot did not exit in time; killing it');
      run.proc.kill('SIGKILL');
    }
    this.save();
  }
}
