// Minimal Source RCON client for the operator tools and scenario setup. Admin infrastructure only:
// nothing read over RCON is ever given to an agent (§6.1, rule 4).

import net from 'node:net';

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length);
  return buf;
}

export class RconClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (body: string) => void; reject: (err: Error) => void }>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
  ) {}

  async connect(timeoutMs = 5000): Promise<void> {
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('error', (err) => this.failAll(err));
    socket.on('close', () => this.failAll(new Error('rcon connection closed')));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('rcon connect timeout')), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
      socket.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const id = this.nextId++;
    const authed = new Promise<string>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    socket.write(encode(id, TYPE_AUTH, this.password));
    await withTimeout(authed, timeoutMs, 'rcon auth timeout');
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + len) return;
      const id = this.buffer.readInt32LE(4);
      const body = this.buffer.toString('utf8', 12, 4 + len - 2);
      this.buffer = this.buffer.subarray(4 + len);
      if (id === -1) {
        this.failAll(new Error('rcon authentication failed (check RCON_PASSWORD)'));
        return;
      }
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p.resolve(body);
      }
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async command(cmd: string, timeoutMs = 10000): Promise<string> {
    if (!this.socket) throw new Error('rcon not connected');
    const id = this.nextId++;
    const res = new Promise<string>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.write(encode(id, TYPE_COMMAND, cmd));
    return withTimeout(res, timeoutMs, `rcon command timeout: ${cmd}`);
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function rconOnce(host: string, port: number, password: string, cmd: string): Promise<string> {
  const c = new RconClient(host, port, password);
  try {
    await c.connect();
    return await c.command(cmd);
  } finally {
    c.close();
  }
}
