// The Hub (§3, §8): infrastructure only. It hands out LLM rate tokens from the one shared bucket (NanoGPT allows
// 25 rps per account; we use 20), budgets, the shared local embedder (§23.5) and the global speech guard (§6.2),
// and it collects logs and telemetry for the dashboard. It never sends a bot anything about the world or other
// players: chat goes through the Minecraft server and its proximity plugin (§15, §16.1). Every message is checked
// with zod on both ends; the socket binds to localhost by default (§23.3).

import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { type BotToHub, type HubConfig, type HubToBot, type Logger, parseBotToHub } from '@agora/shared';
import { type Embedder, LocalRateLimiter, type QuotaStatus, agentDegrade, perAgentHourly } from '@agora/llm';

export interface HubSession {
  id: number;
  slot: string | null;
  username: string | null;
  pid: number | null;
  /** Input tokens this agent used in the current hour (its share of the budget, §5). */
  spent: { hourStart: number; tokens: number };
  send(msg: HubToBot): void;
  close(): void;
}

export interface HubEvents {
  hello: [HubSession];
  ready: [HubSession, string];
  died: [HubSession, Extract<BotToHub, { t: 'died' }>];
  bye: [HubSession, Extract<BotToHub, { t: 'bye' }>];
  snapshotDone: [HubSession, Extract<BotToHub, { t: 'snapshotDone' }>];
  telemetry: [HubSession, Extract<BotToHub, { t: 'telemetry' | 'log' | 'cost' }>];
  closed: [HubSession];
}

export interface HubOptions {
  config: HubConfig;
  logger: Logger;
  /** The shared embedder; null when embeddings are unavailable. */
  embedder: Embedder | null;
  /** Current quota status (null: no key, code-only). */
  quota: () => QuotaStatus | null;
  runtimeHoursPerWeek: number;
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

export class Hub extends EventEmitter<HubEvents> {
  private wss: WebSocketServer | null = null;
  private readonly sessions = new Map<number, HubSession>();
  private nextId = 1;
  private readonly limiter: LocalRateLimiter;
  private readonly speech: SpeechBucket;
  private readonly now: () => number;
  private budgetTimer: NodeJS.Timeout | null = null;
  readonly counters = { llmGranted: 0, llmDenied: 0, speechGranted: 0, speechDenied: 0, embedded: 0 };

  constructor(private readonly o: HubOptions) {
    super();
    this.now = o.now ?? Date.now;
    this.limiter = new LocalRateLimiter({ rps: o.config.rateLimit.rps, burst: o.config.rateLimit.burst, now: this.now });
    this.speech = new SpeechBucket(o.config.speech.globalPerSec, this.now);
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

  /** Budgets go out when they change (the caller's governor) and once a minute. */
  start(): void {
    this.budgetTimer = setInterval(() => this.broadcastBudget('periodic'), 60_000);
    this.budgetTimer.unref();
  }

  async close(): Promise<void> {
    if (this.budgetTimer) clearInterval(this.budgetTimer);
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
      spent: { hourStart: this.now(), tokens: 0 },
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
        this.sendBudget(s, 'joined');
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
      case 'cost': {
        const t = this.now();
        if (t - s.spent.hourStart >= 3_600_000) s.spent = { hourStart: t, tokens: 0 };
        s.spent.tokens += msg.inputTokens;
        this.emit('telemetry', s, msg);
        return;
      }
      case 'died':
        this.emit('died', s, msg);
        return;
      case 'bye':
        this.emit('bye', s, msg);
        return;
      case 'snapshotDone':
        this.emit('snapshotDone', s, msg);
        return;
      case 'log':
      case 'telemetry':
        this.emit('telemetry', s, msg);
        return;
      case 'conception':
        // Reproduction (M9b).
        return;
    }
  }

  /** The agent's budget message: its share of the hourly quota (§5, §22.4). */
  private budgetFor(s: HubSession): Extract<HubToBot, { t: 'budget' }> {
    const q = this.o.quota();
    if (!q) return { t: 'budget', remainingTokensThisHour: 0, degrade: 3, codeOnly: true, resetAt: null, reason: 'no NanoGPT key: code-only' };
    const living = Math.max(1, this.list().filter((x) => x.username).length);
    const share = perAgentHourly(q.remaining, q.resetAt, living, this.o.runtimeHoursPerWeek, this.now());
    const d = agentDegrade(s.spent.tokens, share);
    const level = Math.max(q.level, d.codeOnly ? 3 : d.l2ToL1 ? 2 : d.l3Off ? 1 : 0) as 0 | 1 | 2 | 3;
    return {
      t: 'budget',
      remainingTokensThisHour: share === null ? -1 : Math.max(0, Math.round(share - s.spent.tokens)),
      degrade: level,
      codeOnly: q.codeOnly || d.codeOnly,
      resetAt: q.resetAt,
      reason: q.codeOnly ? q.reason : d.codeOnly ? 'this hour’s share is used up' : q.reason,
    };
  }

  sendBudget(s: HubSession, why: string): void {
    const b = this.budgetFor(s);
    s.send(b);
    this.o.logger.debug({ module: 'hub', agent: s.username, why, degrade: b.degrade, codeOnly: b.codeOnly }, 'budget');
  }

  broadcastBudget(why: string): void {
    for (const s of this.list()) if (s.username) this.sendBudget(s, why);
  }

  broadcast(msg: HubToBot): void {
    for (const s of this.list()) s.send(msg);
  }
}
