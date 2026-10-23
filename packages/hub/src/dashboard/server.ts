// The dashboard's HTTP side (M7, §23.3): a read-only JSON API and one page, on 127.0.0.1 by default, plus the
// token-checked control endpoint `pnpm ctl` talks to. Requests are answered only for the host names this server is
// meant to be reached by (no DNS-rebinding reads from another site), and the page runs under a strict CSP.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Logger } from '@agora/shared';
import type { Hub } from '../hub/hub';
import type { DashboardModel } from './model';

export interface ControlResult {
  ok: boolean;
  message: string;
  data?: unknown;
}
export type ControlHandler = (cmd: string, args: string[]) => Promise<ControlResult>;

export interface DashboardServerOptions {
  model: DashboardModel;
  host: string;
  port: number;
  logger: Logger;
  /** `pnpm ctl`: commands with the RCON password from .env as a bearer token. */
  control?: { token: string; handle: ControlHandler };
}

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const MAX_BODY = 64 * 1024;
const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const;

const asset = (file: string) => fs.readFileSync(new URL(`./client/${file}`, import.meta.url), 'utf8');

/** The page's three files; the script (app.ts and what it imports) is bundled from TypeScript once, at start. */
async function loadAssets(): Promise<{ html: string; css: string; js: string }> {
  const out = await build({ entryPoints: [fileURLToPath(new URL('./client/app.ts', import.meta.url))], bundle: true, write: false, format: 'iife', target: 'es2022', charset: 'utf8', logLevel: 'silent' });
  return { html: asset('index.html'), css: asset('app.css'), js: out.outputFiles[0]?.text ?? '' };
}

function sameToken(given: string, want: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return want.length > 0 && crypto.timingSafeEqual(a, b);
}

export class DashboardServer {
  private server: http.Server | null = null;
  private assets: { html: string; css: string; js: string } | null = null;

  constructor(private readonly o: DashboardServerOptions) {}

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.o.port;
  }

  async listen(port = this.o.port): Promise<void> {
    this.assets = await loadAssets();
    const server = http.createServer((req, res) => void this.route(req, res).catch((err: unknown) => this.fail(res, 500, String(err))));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.o.host, () => resolve());
    });
    this.o.logger.info({ module: 'dashboard', url: `http://${this.o.host}:${this.port}` }, 'dashboard listening');
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Host names this server answers to: loopback, and the address it was told to bind. */
  private hostAllowed(header: string | undefined): boolean {
    if (!header) return false;
    const host = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(host) || (this.o.host !== '0.0.0.0' && host === this.o.host.toLowerCase());
  }

  private send(res: http.ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': type, ...PAGE_HEADERS, ...extra });
    res.end(body);
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    this.send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
  }

  private fail(res: http.ServerResponse, status: number, message: string): void {
    if (!res.headersSent) this.json(res, status, { ok: false, message });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.hostAllowed(req.headers.host)) return this.fail(res, 421, 'unexpected host');
    const url = new URL(req.url ?? '/', 'http://local');
    const a = this.assets;
    if (req.method === 'GET') {
      if (url.pathname === '/' && a) return this.send(res, 200, 'text/html; charset=utf-8', a.html);
      if (url.pathname === '/app.js' && a) return this.send(res, 200, 'text/javascript; charset=utf-8', a.js);
      if (url.pathname === '/app.css' && a) return this.send(res, 200, 'text/css; charset=utf-8', a.css);
      // Browsers ask for an icon on their own; there is none, and that's not an error.
      if (url.pathname === '/favicon.ico') return this.send(res, 204, 'image/x-icon', '');
      if (url.pathname === '/api/overview') return this.json(res, 200, this.o.model.overview());
      if (url.pathname === '/api/social') return this.json(res, 200, this.o.model.social());
      if (url.pathname === '/api/chat') return this.json(res, 200, this.o.model.chatSince(Number(url.searchParams.get('since') ?? 0) || 0));
      const m = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
      if (m?.[1]) {
        const name = decodeURIComponent(m[1]);
        if (!NAME_RE.test(name)) return this.fail(res, 400, 'not a name');
        const view = this.o.model.agent(name);
        return view ? this.json(res, 200, view) : this.fail(res, 404, `no agent ${name}`);
      }
      return this.fail(res, 404, 'not found');
    }
    if (req.method === 'POST' && url.pathname === '/api/ctl') return this.control(req, res);
    return this.fail(res, 405, 'method not allowed');
  }

  private async control(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const c = this.o.control;
    if (!c) return this.fail(res, 404, 'control is not enabled');
    const auth = req.headers.authorization ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!sameToken(given, c.token)) return this.fail(res, 401, 'wrong or missing token');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return this.fail(res, 415, 'send JSON');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const b = chunk as Buffer;
      size += b.length;
      if (size > MAX_BODY) return this.fail(res, 413, 'too large');
      chunks.push(b);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.fail(res, 400, 'not JSON');
    }
    const o = body as { cmd?: unknown; args?: unknown };
    if (typeof o.cmd !== 'string' || (o.args !== undefined && (!Array.isArray(o.args) || !o.args.every((x) => typeof x === 'string')))) return this.fail(res, 400, 'expected {cmd, args[]}');
    const args = o.args ?? [];
    this.o.logger.info({ module: 'dashboard', cmd: o.cmd, args: o.cmd === 'rcon' ? ['…'] : args }, 'control command');
    const r = await c.handle(o.cmd, args);
    this.json(res, r.ok ? 200 : 400, r);
  }
}

/** Feeds the model from the Hub: who is online, who died, and every bot's telemetry, cost and warnings. */
export function attachDashboard(hub: Hub, model: DashboardModel): () => void {
  const onReady = (s: { slot: string | null }, name: string) => model.online(name, s.slot);
  const onBye = (_s: unknown, m: { username: string; reason: string }) => model.offline(m.username, m.reason);
  const onClosed = (s: { username: string | null }) => s.username && model.offline(s.username, 'disconnected');
  const onDied = (_s: unknown, m: { username: string; cause: string }) => model.died(m.username, m.cause);
  const onTelemetry: Parameters<typeof hub.on<'telemetry'>>[1] = (s, m) => {
    const name = s.username;
    if (!name) return;
    if (m.t === 'telemetry') model.telemetry(name, m.kind, m.ts, m.data);
    else if (m.t === 'cost') model.cost(name, m);
    else model.log(name, m);
  };
  hub.on('ready', onReady);
  hub.on('bye', onBye);
  hub.on('closed', onClosed);
  hub.on('died', onDied);
  hub.on('telemetry', onTelemetry);
  return () => {
    hub.off('ready', onReady);
    hub.off('bye', onBye);
    hub.off('closed', onClosed);
    hub.off('died', onDied);
    hub.off('telemetry', onTelemetry);
  };
}
