// The RCON client sends one command at a time: Minecraft's RCON server reads a single packet per read, so commands
// written together can arrive in one read, the rest is lost, and the server drops the connection (seen live: a
// test's keeper sending six teleports at once, and every command after it timing out).

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RconClient } from '@agora/hub';

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A server that answers each request 20 ms after it comes, noting any that came while one was still unanswered. */
async function fakeServer() {
  const seen = { commands: [] as string[], overlapped: 0 };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let unanswered = 0;
    socket.on('data', (d: Buffer) => {
      buffer = Buffer.concat([buffer, d]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const len = buffer.readInt32LE(0);
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, 4 + len - 2);
        buffer = buffer.subarray(4 + len);
        if (type === 3) {
          socket.write(packet(id, 2, ''));
          continue;
        }
        if (unanswered > 0) seen.overlapped++;
        unanswered++;
        seen.commands.push(body);
        setTimeout(() => {
          unanswered--;
          socket.write(packet(id, 0, `ok: ${body}`));
        }, 20);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, seen };
}

describe('RCON client', () => {
  it('sends commands one at a time, in order, each answered', async () => {
    const { port, seen } = await fakeServer();
    const c = new RconClient('127.0.0.1', port, 'pw');
    await c.connect();
    const cmds = ['tp Lin 1 2 3', 'tp Moe 4 5 6', 'tp Vex 0 0 0', 'tp Dag 7 8 9', 'tp Eli 1 1 1', 'tp Fen 2 2 2'];
    const answers = await Promise.all(cmds.map((x) => c.command(x)));
    c.close();
    expect(answers).toEqual(cmds.map((x) => `ok: ${x}`));
    expect(seen.commands).toEqual(cmds);
    expect(seen.overlapped).toBe(0);
  });

  it('goes on after a command that timed out', async () => {
    const { port } = await fakeServer();
    const c = new RconClient('127.0.0.1', port, 'pw');
    await c.connect();
    await expect(c.command('slow', 5)).rejects.toThrow(/timeout: slow/);
    expect(await c.command('next')).toBe('ok: next');
    c.close();
  });
});
