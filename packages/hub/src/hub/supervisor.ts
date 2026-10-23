// The supervisor (§3, §16.2, §16.3, §16.5, §19.3, §19.7, §23.4): one OS process per bot, so a crash or a loop takes
// down only that bot. It keeps the population between minAlive and maxAlive, assigns each slot its persona and
// username for this life (pool first, then generated, balanced by sex), dresses each new agent in its skin before it
// first logs in, hands out the starter kit, restarts crashed bots as the same agent, replaces the dead after
// respawnDelaySec under a new name (never reused), archives their memory to the graveyard, brings children into the
// world after a couple's bed ritual (at their beds, with their inherited traits), and shuts everyone down gracefully,
// writing roster.json for the next start.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  type BirthFacts,
  type BotToHub,
  type DataPaths,
  type Logger,
  type Persona,
  type Random,
  type Sex,
  type SexDifferences,
  type WorldConfig,
  agentDbPath,
  generatePersona,
  generateUsername,
  inheritPersona,
  isValidUsername,
  perceivedPersona,
} from '@agora/shared';
import type { AgentSkin } from '../skins/service';
import { type ConceptionReport, matchReport, sameCouple, whyNoBirth } from './births';
import type { Hub, HubSession } from './hub';
import { type PendingBirth, type Roster, type RosterEntry, livingAgents, loadRoster, saveRoster } from './roster';
import type { WriteContext } from './personaWriter';

/** The master model that writes a person from code's numbers (personaWriter.ts), or a stand-in. */
export interface PersonaSource {
  write(draft: Persona, ctx: WriteContext): Promise<Persona>;
}

/** Where agents' skins come from (§16.5): the SkinService, or a stand-in. */
export interface SkinSource {
  /** A skin for a new agent of this sex, not one of `taken` (NameMC ids worn by the living), or null. */
  skinFor(sex: Sex, taken: ReadonlySet<string>): Promise<AgentSkin | null>;
  /** Tells the server who wears what (each puts it on as they log in). */
  publish(entries: readonly { username: string; skin?: AgentSkin | undefined }[]): void;
}

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
  /** Server console access for starter kits and skins (never used to tell a bot anything). */
  rcon?: (cmd: string) => Promise<string>;
  /** Agents' skins (§16.5); without it, agents wear the default skin. */
  skins?: SkinSource;
  /** The master model, writing each generated person and each child (§16.2, §20); without it, code's words stand. */
  writer?: PersonaSource;
  /** Override population.initial (tests, `pnpm start --population`). */
  initial?: number;
  now?: () => number;
}

interface Running {
  proc: BotProcess;
  startedAt: number;
  crashes: number[];
}

/** The extinction brake looks at the deaths of the last hour (§17.10). */
const HOUR_MS = 60 * 60_000;
/** How long a birth waits for the master model still writing the child (its call has its own timeout). */
const WRITE_WAIT_MS = 60_000;

export class Supervisor {
  private roster: Roster;
  /** When agents died this past hour, and until when the extinction brake holds (§17.10). */
  private readonly deaths: number[] = [];
  private brakeUntil = 0;
  private readonly running = new Map<string, Running>();
  /** Conception reports waiting for the partner's (§19.3), by reporter. */
  private readonly reports = new Map<string, ConceptionReport>();
  private stopping = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Aborts the master model's calls at shutdown. */
  private readonly halt = new AbortController();
  /** Children the master model is writing now, by their birth on the way. */
  private readonly writing = new Map<PendingBirth, Promise<void>>();
  private readonly now: () => number;
  private target: number;

  constructor(private readonly o: SupervisorOptions) {
    this.now = o.now ?? Date.now;
    this.roster = loadRoster(o.paths.roster);
    this.target = o.initial ?? o.world.population.initial;
    const onHello = (s: HubSession) => this.onHello(s);
    const onReady = (s: HubSession, name: string) => void this.onReady(s, name);
    const onDied = (s: HubSession, m: { username: string; cause: string }) => this.onDied(s, m.username, m.cause);
    const onBye = (_s: HubSession, m: { username: string; reason: string }) => this.o.logger.info({ module: 'supervisor', agent: m.username, reason: m.reason }, 'bot said bye');
    const onConception = (s: HubSession, m: Extract<BotToHub, { t: 'conception' }>) => this.onConception(s, m);
    o.hub.on('hello', onHello);
    o.hub.on('ready', onReady);
    o.hub.on('died', onDied);
    o.hub.on('bye', onBye);
    o.hub.on('conception', onConception);
    this.detach = () => {
      o.hub.off('hello', onHello);
      o.hub.off('ready', onReady);
      o.hub.off('died', onDied);
      o.hub.off('bye', onBye);
      o.hub.off('conception', onConception);
    };
  }

  private readonly detach: () => void;

  get living(): RosterEntry[] {
    return livingAgents(this.roster);
  }

  /** The population the supervisor keeps (`ctl population`). */
  get targetPopulation(): number {
    return this.target;
  }

  get rosterSnapshot(): Roster {
    return structuredClone(this.roster);
  }

  /** Reconnects the living agents from roster.json, then fills up to the target population, staggered. */
  async start(): Promise<void> {
    const resumed = this.living;
    this.publishSkins();
    // One without a skin yet (it couldn't be had when it was created) gets one before it logs in again.
    for (const a of resumed) void this.dress(a).then(() => this.launch(a.slot));
    if (resumed.length > 0) this.o.logger.info({ module: 'supervisor', agents: resumed.map((a) => a.username) }, 'resuming agents');
    // Children on the way when we last stopped come when they're due (at once, if that's past), written if not yet.
    for (const pb of this.roster.pendingBirths) {
      this.scheduleBirth(pb);
      if (!pb.written) this.write(pb);
    }
    const want = Math.max(this.target, this.o.world.population.minAlive) - resumed.length;
    const stagger = this.o.world.population.spawnStaggerSec * 1000;
    for (let i = 0; i < want; i++) {
      if (this.stopping) return;
      // The next person is written while they wait their turn to come in.
      const next = this.drawn();
      if (i > 0 || resumed.length > 0) await this.sleep(stagger);
      const persona = await next;
      if (this.stopping) return;
      await this.enter(persona);
    }
  }

  /**
   * Debug controls: one more agent now, counted in the population. From the persona pool by id or name, or
   * generated (of the sex asked for, if any); a name asked for is used when it is a valid one nobody has had.
   * Returns the new entry, or why not.
   */
  async addAgent(o: { persona?: string; name?: string; sex?: Sex } = {}): Promise<RosterEntry | string> {
    const max = this.o.world.population.maxAlive;
    if (this.living.length >= max) return `the population is at maxAlive (${max}); raise population.maxAlive in config/world.yaml`;
    const used = this.usedNames();
    if (o.name && (!isValidUsername(o.name) || used.has(o.name))) return `"${o.name}" can't be used: names are 3–16 letters, digits or _, and never reused`;
    let persona: Persona;
    if (o.persona) {
      const want = o.persona.toLowerCase();
      const p = this.o.pool.find((x) => (x.id ?? '').toLowerCase() === want || x.name.toLowerCase() === want);
      if (!p) return `no persona "${o.persona}" in personas/ (try one of: ${this.o.pool.map((x) => x.id ?? x.name).join(', ')})`;
      persona = p;
    } else {
      persona = generatePersona({ rng: this.o.rng, world: this.o.world, sexDiffs: this.o.sexDiffs, takenNames: used, ...(o.sex ? { sex: o.sex } : {}) });
    }
    if (o.name) persona = { ...persona, name: o.name };
    persona = await this.drawn(persona, Boolean(o.name));
    // Others may have come in while this one was being written.
    if (this.living.length >= max) return `the population is at maxAlive (${max}); raise population.maxAlive in config/world.yaml`;
    this.target = Math.min(max, Math.max(this.target, this.living.length) + 1);
    this.o.logger.info({ module: 'supervisor', persona: persona.id ?? persona.name, name: o.name ?? null, target: this.target }, 'agent added by the operator');
    return this.enter(persona);
  }

  /**
   * Debug controls: an agent leaves for good (says goodbye and logs off; its memory stays with the roster entry, not
   * the graveyard), and the population it was counted in is one smaller, so nobody replaces it.
   */
  retireAgent(username: string): string | null {
    const entry = this.living.find((a) => a.username.toLowerCase() === username.toLowerCase());
    if (!entry) return `no living agent ${username}`;
    entry.status = 'retired';
    this.target = Math.max(0, this.target - 1);
    this.save();
    this.publishSkins();
    const session = this.o.hub.bySlot(entry.slot);
    // Not connected (starting up, or stuck): its process is stopped instead.
    if (session) session.send({ t: 'retire', reason: 'removed by the operator' });
    else this.running.get(entry.slot)?.proc.kill('SIGTERM');
    this.o.logger.info({ module: 'supervisor', agent: entry.username, target: this.target }, 'agent removed by the operator');
    return null;
  }

  /** Debug controls: the agent's process saves and stops, and starts again as the same agent (from its snapshot). */
  restartAgent(username: string): string | null {
    const entry = this.living.find((a) => a.username.toLowerCase() === username.toLowerCase());
    if (!entry) return `no living agent ${username}`;
    const run = this.running.get(entry.slot);
    if (!run) return `${entry.username} is not running right now`;
    run.proc.kill('SIGTERM');
    this.o.logger.info({ module: 'supervisor', agent: entry.username }, 'agent restarted by the operator');
    return null;
  }

  /** `ctl population <n>` (§16.2): adds agents now, or retires the newest ones. */
  setPopulation(n: number): void {
    const max = this.o.world.population.maxAlive;
    this.target = Math.max(0, Math.min(max, n));
    const alive = this.living;
    if (alive.length < this.target) for (let i = alive.length; i < this.target; i++) void this.spawnNew();
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

  /** The master model's version of a drawn person; the draft itself without one, or if it fails. */
  private async written(draft: Persona, o: { keepName?: boolean; parents?: readonly [Persona, Persona] } = {}): Promise<Persona> {
    if (!this.o.writer) return draft;
    // Its own name isn't taken from it (a child's is kept for it from its conception).
    const taken = this.usedNames();
    taken.delete(draft.name);
    try {
      return await this.o.writer.write(draft, { takenNames: taken, living: this.living.map((a) => a.persona), signal: this.halt.signal, ...o });
    } catch (err) {
      this.o.logger.warn({ module: 'supervisor', err: String(err) }, 'persona writer failed; code drew this person');
      return draft;
    }
  }

  /**
   * The next persona: with personas 'generated', always a new one; otherwise unused pool entries first (balancing sex
   * among the living), then a generated one.
   */
  private nextPersona(): Persona {
    const living = this.living;
    const females = living.filter((a) => a.persona.sex === 'female').length;
    const wantSex = females * 2 < living.length ? 'female' : females * 2 > living.length ? 'male' : undefined;
    const usedIds = new Set(this.roster.agents.map((a) => a.persona.id ?? a.persona.name));
    const allowed = this.o.world.personas;
    const fresh = allowed === 'generated' ? [] : this.o.pool.filter((p) => !usedIds.has(p.id ?? p.name) && (allowed === 'auto' || allowed.includes(p.id ?? p.name)));
    const pick = fresh.find((p) => !wantSex || p.sex === wantSex) ?? fresh[0];
    if (pick) return pick;
    return generatePersona({ rng: this.o.rng, world: this.o.world, sexDiffs: this.o.sexDiffs, takenNames: this.usedNames(), ...(wantSex ? { sex: wantSex } : {}) });
  }

  private async spawnNew(given?: Persona, keepName = false): Promise<RosterEntry> {
    return this.enter(await this.drawn(given, keepName));
  }

  /** The next person (or the one given): a generated one written by the master model, a pool one as its author wrote it. */
  private async drawn(given?: Persona, keepName = false): Promise<Persona> {
    const persona = given ?? this.nextPersona();
    return persona.source === 'generated' ? this.written(persona, { keepName }) : persona;
  }

  private async enter(persona: Persona): Promise<RosterEntry> {
    const used = this.usedNames();
    const username = isValidUsername(persona.name) && !used.has(persona.name) ? persona.name : generateUsername(persona.name, used, this.o.rng);
    const entry: RosterEntry = { username, persona, slot: `a${this.roster.nextSlot}`, bornAt: this.now(), status: 'alive', kitGiven: false, placed: false };
    this.roster.nextSlot++;
    this.roster.agents.push(entry);
    this.roster.usedNames.push(username);
    this.save();
    this.o.logger.info({ module: 'supervisor', agent: username, persona: persona.id ?? persona.name, source: persona.source }, 'new agent');
    await this.dress(entry);
    this.launch(entry.slot);
    return entry;
  }

  /**
   * §16.5: the agent's skin, before it logs in. Should it take longer than skins.waitSec, the agent logs in
   * without one, and puts it on when it comes (the plugin reloads skins.tsv for those online).
   */
  private async dress(entry: RosterEntry): Promise<void> {
    const skins = this.o.skins;
    if (!skins || entry.skin) return;
    const taken = new Set(this.living.flatMap((a) => (a.skin ? [a.skin.id] : [])));
    const got = skins.skinFor(entry.persona.sex, taken).then(
      (skin) => {
        if (!skin || entry.status !== 'alive') return false;
        entry.skin = skin;
        this.save();
        this.publishSkins();
        this.o.logger.info({ module: 'supervisor', agent: entry.username, skin: skin.id, tag: skin.tag, variant: skin.variant }, 'agent dressed');
        return true;
      },
      (err: unknown) => {
        this.o.logger.warn({ module: 'supervisor', agent: entry.username, err: String(err) }, 'no skin for the agent');
        return false;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.o.world.skins.waitSec * 1000);
      timer.unref();
    });
    const inTime = await Promise.race([got, late]);
    clearTimeout(timer);
    if (inTime !== 'late') return;
    this.o.logger.info({ module: 'supervisor', agent: entry.username }, 'skin not ready yet: logging in without it for now');
    void got.then(async (ok) => {
      if (ok && this.o.rcon) await this.o.rcon('agoraskins reload').catch(() => '');
    });
  }

  /** skins.tsv for the plugin: the living and their skins. */
  private publishSkins(): void {
    try {
      this.o.skins?.publish(this.living);
    } catch (err) {
      this.o.logger.warn({ module: 'supervisor', err: String(err) }, 'skins.tsv not written');
    }
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
    s.send({
      t: 'assign',
      persona: entry.persona,
      username: entry.username,
      resume,
      giveStarterKit: giveKit,
      // §19.4: a child's starting knowledge, on its first start; and where it appears (its parents' beds).
      ...(entry.birthFacts && !resume ? { birthFacts: entry.birthFacts } : {}),
      ...(entry.spawnAt && !entry.placed ? { spawnAt: entry.spawnAt } : {}),
    });
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
    // §19.3: a newborn appears at its parents' beds (where its parent lay for the bed ritual).
    if (entry.spawnAt && !entry.placed && this.o.rcon) {
      const p = entry.spawnAt;
      const out = await this.o.rcon(`tp ${username} ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`).catch((err: unknown) => `failed: ${String(err)}`);
      this.o.logger.info({ module: 'supervisor', agent: username, at: p, out }, 'newborn put at its parents’ beds');
    }
    entry.placed = true;
    this.save();
    // Born during the extinction brake: as careful as everyone else for the rest of it.
    const b = this.o.world.conflict.extinctionBrake;
    if (this.now() < this.brakeUntil) s.send({ t: 'cautionShift', shift: b.cautionShift, untilTs: this.brakeUntil });
  }

  private onDied(s: HubSession, username: string, cause: string): void {
    const entry = this.roster.agents.find((a) => a.slot === s.slot && a.username === username);
    if (!entry || entry.status !== 'alive') return;
    entry.status = 'dead';
    entry.diedAt = this.now();
    entry.cause = cause;
    this.save();
    this.publishSkins();
    this.o.logger.info({ module: 'supervisor', agent: username, cause }, 'agent died');
    this.brake();
  }

  /**
   * §19.3: one partner's report of the bed ritual. A child comes once both partners have reported the same night (just
   * the one, when the partner is a person playing: we have no bot for them, so what ours saw stands), and the rules
   * allow it (births.ts): then after gestationSec, at the reporter's bed.
   */
  private onConception(s: HubSession, m: Extract<BotToHub, { t: 'conception' }>): void {
    const me = this.roster.agents.find((a) => a.slot === s.slot && a.username === m.username && a.status === 'alive');
    if (!me || m.partner === m.username) return;
    const r: ConceptionReport = { username: m.username, partner: m.partner, partnerModel: m.partnerModel, partnerSex: m.partnerSex, bedPos: m.bedPos, at: this.now() };
    const ours = this.roster.agents.some((a) => a.username === m.partner && a.status === 'alive');
    let other: ConceptionReport | null = null;
    if (ours) {
      other = matchReport(this.reports, r);
      if (!other) {
        this.reports.set(r.username, r);
        this.o.logger.info({ module: 'supervisor', agent: m.username, partner: m.partner }, 'bed ritual reported; waiting for the partner’s report');
        return;
      }
      this.reports.delete(other.username);
    }
    const parents: [string, string] = [m.username, m.partner];
    const why = whyNoBirth({ world: this.o.world, parents, agents: this.roster.agents, pending: this.roster.pendingBirths, now: this.now() });
    if (why) {
      this.o.logger.info({ module: 'supervisor', parents, why }, 'no child this time');
      return;
    }
    const seen: PendingBirth['seen'] = { [m.partner]: { model: m.partnerModel, sex: m.partnerSex } };
    if (other) seen[m.username] = { model: other.partnerModel, sex: other.partnerSex };
    const pb: PendingBirth = { parents, bedPos: m.bedPos, dueAt: this.now() + this.o.world.reproduction.gestationSec * 1000, seen };
    this.roster.pendingBirths.push(pb);
    this.save();
    this.o.logger.info({ module: 'supervisor', parents, dueAt: pb.dueAt }, 'a child is on the way');
    this.scheduleBirth(pb);
    this.write(pb);
  }

  /** The parents' personas: ours from the roster (the dead too); one we have none for, as the other parent saw them. */
  private parentPersonas(pb: PendingBirth): [Persona, Persona] | null {
    const [ua, ub] = pb.parents;
    const known = (u: string) => this.roster.agents.find((a) => a.username === u)?.persona;
    const ka = known(ua);
    const kb = known(ub);
    const base = ka ?? kb;
    if (!base) return null;
    const as = (u: string, p: Persona | undefined) => p ?? perceivedPersona(base, { username: u, sex: pb.seen[u]?.sex ?? 'unknown', model: pb.seen[u]?.model ?? {} });
    return [as(ua, ka), as(ub, kb)];
  }

  /** The child drawn and written while it is on the way; its birth waits for that a little (WRITE_WAIT_MS). */
  private write(pb: PendingBirth): void {
    const w = this.conceive(pb).catch((err: unknown) => this.o.logger.warn({ module: 'supervisor', parents: pb.parents, err: String(err) }, 'could not write the child'));
    this.writing.set(pb, w);
    void w.finally(() => this.writing.delete(pb));
  }

  /**
   * The child is drawn at conception (its numbers from its parents; its name kept for it from then) and written by
   * the master model while on the way, so it is ready when it is born.
   */
  private async conceive(pb: PendingBirth): Promise<void> {
    const parents = this.parentPersonas(pb);
    if (!parents) return;
    // Drawn before a restart: the same child.
    const draft = pb.persona ?? inheritPersona({ rng: this.o.rng, world: this.o.world, a: parents[0], b: parents[1], takenNames: this.usedNames() });
    if (!pb.persona) {
      pb.persona = draft;
      this.roster.usedNames.push(draft.name);
      this.save();
    }
    if (!this.o.writer) return;
    const child = await this.written(draft, { parents });
    if (this.stopping || !this.roster.pendingBirths.includes(pb)) return;
    // Its name, kept for it now in place of the one drawn (which nobody ever had).
    if (child.name !== draft.name) this.roster.usedNames = [...this.roster.usedNames.filter((n) => n !== draft.name), child.name];
    pb.persona = child;
    pb.written = true;
    this.save();
  }

  private scheduleBirth(pb: PendingBirth): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.birth(pb);
    }, Math.max(0, pb.dueAt - this.now()));
    this.timers.add(t);
  }

  /** §19.3, §19.4: the child, with traits from both parents, its starting knowledge, at its parents' beds. */
  private async birth(pb: PendingBirth): Promise<void> {
    if (this.stopping) return;
    // A child the master model is still writing is waited for, a little.
    const writing = this.writing.get(pb);
    if (writing) await Promise.race([writing, this.sleep(WRITE_WAIT_MS)]);
    if (this.stopping) return;
    this.roster.pendingBirths = this.roster.pendingBirths.filter((x) => x !== pb);
    const [ua, ub] = pb.parents;
    if (this.living.length >= this.o.world.population.maxAlive) {
      this.save();
      this.o.logger.info({ module: 'supervisor', parents: pb.parents }, 'no room for the child: the population is at maxAlive');
      return;
    }
    // The dead parent's persona is still on the roster; one we have none for is as the other parent saw them.
    const parents = this.parentPersonas(pb);
    if (!parents) return;
    const [a, b] = parents;
    const known = (u: string) => this.roster.agents.some((x) => x.username === u);
    const ka = known(ua) ? a : undefined;
    const kb = known(ub) ? b : undefined;
    // Drawn at conception and written while on the way (an older roster's child is drawn now).
    const persona = pb.persona ?? inheritPersona({ rng: this.o.rng, world: this.o.world, a, b, takenNames: this.usedNames() });
    const username = persona.name;
    const siblings = this.living.filter((x) => x.parents && sameCouple(x.parents, pb.parents)).map((x) => x.username);
    const parentFact = (u: string, p: Persona, known: boolean) => ({ username: u, name: p.name, sex: known ? p.sex : (pb.seen[u]?.sex ?? 'unknown') });
    const facts: BirthFacts = {
      parents: [parentFact(ua, a, ka !== undefined), parentFact(ub, b, kb !== undefined)],
      siblings,
      home: pb.bedPos,
      ...(persona.familyName ? { familyName: persona.familyName } : {}),
    };
    const entry: RosterEntry = {
      username,
      persona,
      slot: `a${this.roster.nextSlot}`,
      bornAt: this.now(),
      status: 'alive',
      // A newborn brings nothing into the world (§19.4: no starter kit).
      kitGiven: true,
      parents: [ua, ub],
      birthFacts: facts,
      spawnAt: pb.bedPos,
      placed: false,
    };
    this.roster.nextSlot++;
    this.roster.agents.push(entry);
    // Kept for the child since its conception (an older roster's, now).
    if (!this.roster.usedNames.includes(username)) this.roster.usedNames.push(username);
    this.save();
    this.o.logger.info({ module: 'supervisor', agent: username, parents: pb.parents, sex: persona.sex, generation: persona.generation }, 'a child is born');
    await this.dress(entry);
    this.launch(entry.slot);
  }

  /**
   * §17.10 extinction brake: more deaths in an hour than `deathsPerHourMax` raises every living agent's own caution
   * baseline for a while (like a mood; it never changes what they perceive). Each application is logged.
   */
  private brake(): void {
    const t = this.now();
    this.deaths.push(t);
    while (this.deaths.length > 0 && t - (this.deaths[0] ?? t) > HOUR_MS) this.deaths.shift();
    const b = this.o.world.conflict.extinctionBrake;
    if (this.deaths.length <= b.deathsPerHourMax || b.cautionShift <= 0 || b.durationSec <= 0) return;
    this.brakeUntil = t + b.durationSec * 1000;
    const told = this.o.hub.list().filter((x) => x.username);
    for (const x of told) x.send({ t: 'cautionShift', shift: b.cautionShift, untilTs: this.brakeUntil });
    this.o.logger.warn({ module: 'supervisor', deathsLastHour: this.deaths.length, shift: b.cautionShift, until: this.brakeUntil, agents: told.map((x) => x.username) }, 'extinction brake: everyone more careful for a while');
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
      if (!this.stopping && this.living.length < Math.max(this.o.world.population.minAlive, this.target)) void this.spawnNew();
    }, this.o.world.population.respawnDelaySec * 1000);
    this.timers.add(t);
  }

  /** §23.4: everyone flushes memory and writes a snapshot, then disconnects; roster.json is saved last. */
  async shutdown(reason: string, timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    this.halt.abort();
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
    this.detach();
  }
}
