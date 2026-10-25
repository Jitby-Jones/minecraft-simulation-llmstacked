// The Hub (§3, §8): infrastructure only. It hands out LLM rate tokens from the one shared bucket (NanoGPT's
// subscription takes 60 text requests a minute per key; we use 54), the shared local embedder (§23.5) and the global speech guard (§6.2),
// and it collects logs and telemetry for the dashboard. It never sends a bot anything about the world or other
// players: chat goes through the Minecraft server and its proximity plugin (§15, §16.1). Every message is checked
// with zod on both ends; the socket binds to localhost by default (§23.3).

import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { type BotToHub, type HubConfig, type HubToBot, type Logger, parseBotToHub } from '@agora/shared';
import { type Embedder, LocalRateLimiter, type TokenSource } from '@agora/llm';

export interface HubSession {
  id: number;
  slot: string | null;
  username: string | null;
  pid: number | null;
  send(msg: HubToBot): void;
  close(): void;
}

export interface HubEvents {
  hello: [HubSession];
  ready: [HubSession, string];
  died: [HubSession, Extract<BotToHub, { t: 'died' }>];
  conception: [HubSession, Extract<BotToHub, { t: 'conception' }>];
  bye: [HubSession, Extract<BotToHub, { t: 'bye' }>];
  snapshotDone: [HubSession, Extract<BotToHub, { t: 'snapshotDone' }>];
  debugResult: [HubSession, Extract<BotToHub, { t: 'debugResult' }>];
  telemetry: [HubSession, Extract<BotToHub, { t: 'telemetry' | 'log' | 'cost' }>];
  closed: [HubSession];
}

export interface HubOptions {
  config: HubConfig;
  logger: Logger;
  /** The shared embedder; null when embeddings are unavailable. */
  embedder: Embedder | null;
  /** world.conflict.maxConcurrentFights (§17.10). */
  maxConcurrentFights?: number;
  now?: () => number;
}

/** A token bucket that never queues: the speech guard drops lines instead of delaying them (§6.2). */
class SpeechBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perSec: number,
    private readonly now: () => number,
  ) {
    this.tokens = perSec;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perSec, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** A fight slot lasts at most this long (a duel runs a minute or two). */
const FIGHT_SLOT_MS = 5 * 60_000;

export class Hub extends EventEmitter<HubEvents> {
  private wss: WebSocketServer | null = null;
  private readonly sessions = new Map<number, HubSession>();
  /** Sessions holding a fight slot, since when (a slot a crashed fight never gave back lapses, FIGHT_SLOT_MS). */
  private readonly fighting = new Map<number, number>();
  private nextId = 1;
  private readonly limiter: LocalRateLimiter;
  private readonly speech: SpeechBucket;
  private readonly now: () => number;
  readonly counters = { llmGranted: 0, llmDenied: 0, speechGranted: 0, speechDenied: 0, embedded: 0 };

  constructor(private readonly o: HubOptions) {
    super();
    this.now = o.now ?? Date.now;
    this.limiter = new LocalRateLimiter({ rps: o.config.rateLimit.rps, burst: o.config.rateLimit.burst, now: this.now });
    this.speech = new SpeechBucket(o.config.speech.globalPerSec, this.now);
  }

  /** The shared rate limit, for the Hub's own model calls (the persona writer): the bucket the agents draw on. */
  tokens(): TokenSource {
    return { acquire: (priority, signal) => this.limiter.acquire(priority, signal), backOff: () => this.limiter.backOff() };
  }

  get port(): number {
    const a = this.wss?.address();
    return a && typeof a === 'object' ? a.port : this.o.config.hub.port;
  }

  listen(port = this.o.config.hub.port): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.o.config.hub.host, port, maxPayload: 1 << 20 });
      wss.once('listening', () => resolve());
      wss.once('error', reject);
      wss.on('connection', (ws) => this.accept(ws));
      this.wss = wss;
    });
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) s.close();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }

  list(): HubSession[] {
    return [...this.sessions.values()];
  }

  bySlot(slot: string): HubSession | undefined {
    return this.list().find((s) => s.slot === slot);
  }

  private accept(ws: WebSocket): void {
    const session: HubSession = {
      id: this.nextId++,
      slot: null,
      username: null,
      pid: null,
      send: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: () => ws.close(),
    };
    this.sessions.set(session.id, session);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = parseBotToHub(data.toString('utf8'));
      if (!msg) {
        this.o.logger.warn({ module: 'hub', session: session.id }, 'ignored an invalid message');
        return;
      }
      void this.handle(session, msg).catch((err: unknown) => this.o.logger.warn({ module: 'hub', t: msg.t, err: String(err) }, 'message handling failed'));
    });
    ws.on('close', () => {
      this.sessions.delete(session.id);
      this.fighting.delete(session.id);
      this.emit('closed', session);
    });
    ws.on('error', (err) => this.o.logger.warn({ module: 'hub', session: session.id, err: String(err) }, 'socket error'));
  }

  private async handle(s: HubSession, msg: BotToHub): Promise<void> {
    switch (msg.t) {
      case 'hello':
        s.slot = msg.slot;
        s.pid = msg.pid;
        this.emit('hello', s);
        return;
      case 'ready':
        s.username = msg.username;
        this.emit('ready', s, msg.username);
        return;
      case 'llmToken': {
        const signal = AbortSignal.timeout(this.o.config.rateLimit.queueTimeoutMs);
        try {
          await this.limiter.acquire(msg.priority, signal);
          this.counters.llmGranted++;
          s.send({ t: 'llmGrant', reqId: msg.reqId });
        } catch {
          this.counters.llmDenied++;
          s.send({ t: 'llmDeny', reqId: msg.reqId, reason: 'the shared rate limit queue is full' });
        }
        return;
      }
      case 'speechToken': {
        const ok = this.speech.take();
        if (ok) this.counters.speechGranted++;
        else {
          this.counters.speechDenied++;
          this.o.logger.warn({ module: 'hub', agent: s.username }, 'global speech guard hit');
        }
        s.send({ t: 'speechGrant', reqId: msg.reqId, ok });
        return;
      }
      case 'fightStart': {
        const t = this.now();
        for (const [id, at] of this.fighting) if (t - at > FIGHT_SLOT_MS) this.fighting.delete(id);
        const ok = this.fighting.has(s.id) || this.fighting.size < (this.o.maxConcurrentFights ?? 2);
        if (ok) this.fighting.set(s.id, t);
        else this.o.logger.info({ module: 'hub', agent: s.username, fights: this.fighting.size }, 'fight cap reached');
        s.send({ t: 'fightGrant', reqId: msg.reqId, ok });
        return;
      }
      case 'fightEnd':
        this.fighting.delete(s.id);
        return;
      case 'embed': {
        if (!this.o.embedder) {
          s.send({ t: 'embedResult', reqId: msg.reqId, vectors: null });
          return;
        }
        try {
          const vecs = await this.o.embedder.embed(msg.texts);
          this.counters.embedded += msg.texts.length;
          s.send({ t: 'embedResult', reqId: msg.reqId, vectors: vecs.map((v) => Array.from(v)) });
        } catch (err) {
          this.o.logger.warn({ module: 'hub', err: String(err) }, 'embedding failed');
          s.send({ t: 'embedResult', reqId: msg.reqId, vectors: null });
        }
        return;
      }
      case 'cost':
        this.emit('telemetry', s, msg);
        return;
      case 'died':
        this.emit('died', s, msg);
        return;
      case 'bye':
        this.emit('bye', s, msg);
        return;
      case 'snapshotDone':
        this.emit('snapshotDone', s, msg);
        return;
      case 'debugResult':
        this.emit('debugResult', s, msg);
        return;
      case 'log':
      case 'telemetry':
        this.emit('telemetry', s, msg);
        return;
      case 'conception':
        this.emit('conception', s, msg);
        return;
    }
  }

  /**
   * §23.4 (`ctl save`, `pnpm export --hot`): every assigned bot writes its snapshot and checkpoints its memory.
   * Resolves with how many confirmed in time.
   */
  async snapshotAll(timeoutMs = 20_000): Promise<number> {
    const sessions = this.list().filter((s) => s.username);
    const one = (s: HubSession) =>
      new Promise<boolean>((resolve) => {
        const reqId = `snap-${s.id}-${this.now().toString(36)}`;
        const done = (x: HubSession, m: { reqId: string; ok: boolean }) => {
          if (x.id !== s.id || m.reqId !== reqId) return;
          clearTimeout(timer);
          this.off('snapshotDone', done);
          resolve(m.ok);
        };
        const timer = setTimeout(() => {
          this.off('snapshotDone', done);
          resolve(false);
        }, timeoutMs);
        this.on('snapshotDone', done);
        s.send({ t: 'snapshot', reqId });
      });
    return (await Promise.all(sessions.map(one))).filter(Boolean).length;
  }

  /** The session of a living agent by name (debug controls). */
  byName(username: string): HubSession | undefined {
    const low = username.toLowerCase();
    return this.list().find((s) => s.username?.toLowerCase() === low);
  }

  /**
   * An operator's debug request to one agent (dashboard, `pnpm ctl agent`): sent as `debug`, answered with
   * `debugResult`. Resolves with the answer, or with ok false if the agent isn't here or doesn't answer in time.
   */
  request(username: string, op: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<{ ok: boolean; message: string; data?: unknown }> {
    const s = this.byName(username);
    if (!s) return Promise.resolve({ ok: false, message: `${username} is not connected` });
    return new Promise((resolve) => {
      const reqId = `dbg-${s.id}-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const done = (x: HubSession, m: Extract<BotToHub, { t: 'debugResult' }>) => {
        if (x.id !== s.id || m.reqId !== reqId) return;
        clearTimeout(timer);
        this.off('debugResult', done);
        resolve({ ok: m.ok, message: m.message, ...(m.data !== undefined ? { data: m.data } : {}) });
      };
      const timer = setTimeout(() => {
        this.off('debugResult', done);
        resolve({ ok: false, message: `${username} did not answer in ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      this.on('debugResult', done);
      s.send({ t: 'debug', reqId, op, args });
    });
  }

  broadcast(msg: HubToBot): void {
    for (const s of this.list()) s.send(msg);
  }
}
