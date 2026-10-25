// The bot's side of the Hub link (§8). Infrastructure only: who this bot is this life (assign), LLM rate tokens,
// the shared embedder, the global speech guard and lifecycle. Nothing about the world or other players
// ever arrives here (§3, §16.1). Uses Node's built-in WebSocket; reconnects with backoff. While the Hub is
// unreachable, rate tokens come from a local bucket of 20/N rps (§5) and the speech guard lets lines through
// (the per-bot and per-pair guards still hold).

import { type BotToHub, type HubToBot, type LlmModule, type Logger, parseHubToBot } from '@agora/shared';
import { type Embedder, LocalRateLimiter, SUBSCRIPTION_BURST, SUBSCRIPTION_RPS, type TokenSource } from '@agora/llm';

type Assign = Extract<HubToBot, { t: 'assign' }>;

export interface HubClientOptions {
  url: string;
  slot: string;
  logger: Logger;
  /** Local fallback rate when the Hub is down: 20 rps shared by this many bots. */
  expectedBots?: number;
  /** Give up on a request the Hub doesn't answer in time. */
  requestTimeoutMs?: number;
}

interface PendingReq {
  resolve: (msg: HubToBot) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let seq = 0;

export class HubClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;
  private readonly pending = new Map<string, PendingReq>();
  private readonly handlers = new Map<HubToBot['t'], ((m: HubToBot) => void)[]>();
  private readonly fallback: LocalRateLimiter;
  private openWaiters: (() => void)[] = [];
  private lastAssign: Assign | null = null;

  constructor(private readonly o: HubClientOptions) {
    this.fallback = new LocalRateLimiter({ rps: SUBSCRIPTION_RPS / Math.max(1, o.expectedBots ?? 1), burst: SUBSCRIPTION_BURST });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retryMs = 500;
      this.send({ t: 'hello', pid: process.pid, slot: this.o.slot });
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const w of waiters) w();
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = parseHubToBot(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (!msg) {
        this.o.logger.warn({ module: 'hub' }, 'ignored an invalid message from the Hub');
        return;
      }
      this.dispatch(msg);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('hub disconnected'));
        this.pending.delete(id);
      }
      if (this.closed) return;
      const wait = this.retryMs;
      this.retryMs = Math.min(10_000, this.retryMs * 2);
      setTimeout(() => this.connect(), wait).unref();
    });
    ws.addEventListener('error', () => {
      // 'close' follows and schedules the retry.
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  /** Resolves once connected (or after `ms`). */
  waitOpen(ms: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      this.openWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  send(msg: BotToHub): boolean {
    if (!this.connected || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  on<T extends HubToBot['t']>(t: T, handler: (m: Extract<HubToBot, { t: T }>) => void): void {
    const list = this.handlers.get(t) ?? [];
    list.push(handler as (m: HubToBot) => void);
    this.handlers.set(t, list);
    if (t === 'assign' && this.lastAssign) handler(this.lastAssign as Extract<HubToBot, { t: T }>);
  }

  /** The first assign (who this bot is this life). */
  assigned(): Promise<Assign> {
    if (this.lastAssign) return Promise.resolve(this.lastAssign);
    return new Promise((resolve) => this.on('assign', (m) => resolve(m)));
  }

  private dispatch(msg: HubToBot): void {
    if (msg.t === 'assign') this.lastAssign = msg;
    // A reqId on a grant answers one of our requests; the Hub's own requests (a snapshot, an operator's debug
    // request) carry theirs and go to the handlers.
    const reqId = 'reqId' in msg ? msg.reqId : undefined;
    if (reqId && msg.t !== 'snapshot' && msg.t !== 'debug') {
      const p = this.pending.get(reqId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.resolve(msg);
      }
      return;
    }
    for (const h of this.handlers.get(msg.t) ?? []) {
      try {
        h(msg);
      } catch (err) {
        this.o.logger.warn({ module: 'hub', t: msg.t, err: String(err) }, 'hub message handler failed');
      }
    }
  }

  private request(build: (reqId: string) => BotToHub, timeoutMs = this.o.requestTimeoutMs ?? 20_000, signal?: AbortSignal): Promise<HubToBot> {
    const reqId = `${this.o.slot}-${(seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      if (!this.send(build(reqId))) {
        reject(new Error('hub not connected'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('hub did not answer in time'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(reqId, { resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          const p = this.pending.get(reqId);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(reqId);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  /** Rate tokens from the Hub's shared bucket (§5); the local 20/N bucket while the Hub is unreachable. */
  tokenSource(): TokenSource {
    return {
      acquire: async (priority, signal, module: LlmModule = 'cc') => {
        if (!this.connected) return this.fallback.acquire(priority, signal);
        let r: HubToBot;
        try {
          r = await this.request((reqId) => ({ t: 'llmToken', reqId, priority, module, estTokens: 0 }), undefined, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          return this.fallback.acquire(priority, signal);
        }
        if (r.t === 'llmDeny') throw new Error(`rate limit: ${r.reason}`);
      },
      backOff: () => this.fallback.backOff(),
    };
  }

  /** The global speech guard (§6.2: ≤ 5 utterances/s across all bots). */
  async speechToken(): Promise<boolean> {
    if (!this.connected) return true;
    try {
      const r = await this.request((reqId) => ({ t: 'speechToken', reqId }), 5000);
      return r.t === 'speechGrant' ? r.ok : true;
    } catch {
      return true;
    }
  }

  /** §17.10: a world-wide fight slot. Granted without a Hub (the cap only exists across a population). */
  async fightSlot(): Promise<boolean> {
    if (!this.connected) return true;
    try {
      const r = await this.request((reqId) => ({ t: 'fightStart', reqId }), 5000);
      return r.t === 'fightGrant' ? r.ok : true;
    } catch {
      return true;
    }
  }

  fightDone(): void {
    if (this.connected) this.send({ t: 'fightEnd' });
  }

  /** The Hub's shared local embedder (§23.5). */
  embedder(dims: number, model: string): Embedder {
    return {
      dims,
      model,
      embed: async (texts) => {
        if (texts.length === 0) return [];
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += 64) {
          const chunk = texts.slice(i, i + 64);
          if (!this.connected) await this.waitOpen(15_000);
          const r = await this.request((reqId) => ({ t: 'embed', reqId, texts: [...chunk] }), 30_000);
          if (r.t !== 'embedResult' || !r.vectors) throw new Error('the Hub could not embed');
          for (const v of r.vectors) out.push(Float32Array.from(v));
        }
        return out;
      },
    };
  }
}
