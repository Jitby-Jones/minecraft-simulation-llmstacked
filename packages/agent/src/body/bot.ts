// Creates the mineflayer body. Perception comes only from this client, exactly what a player gets (§6.1).

import mineflayer, { type Bot } from 'mineflayer';

export type { Bot } from 'mineflayer';
export { Vec3 } from 'vec3';

export interface BodyOptions {
  host: string;
  port: number;
  username: string;
  /** e.g. "26.1.2" (protocol 775; mineflayer maps it to its 26.1 data). */
  version: string;
  /** mineflayer view distance; 'tiny' keeps per-bot RAM low (§23.5). */
  viewDistance?: 'far' | 'normal' | 'short' | 'tiny' | number;
  connectTimeoutMs?: number;
}

/** Connects and resolves once the bot has spawned. Rejects on kick/error/timeout. */
export function connectBody(opts: BodyOptions): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: opts.host,
    port: opts.port,
    username: opts.username,
    version: opts.version,
    auth: 'offline',
    viewDistance: opts.viewDistance ?? 'tiny',
    hideErrors: true,
    // Leave chat-pattern matching off; we parse ProximityChat! system lines ourselves (§15.3).
    chatLengthLimit: 256,
  });
  return new Promise<Bot>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      bot.end('connect timeout');
      reject(new Error(`${opts.username}: no spawn within ${opts.connectTimeoutMs ?? 60000} ms`));
    }, opts.connectTimeoutMs ?? 60000);
    const onSpawn = (): void => {
      cleanup();
      resolve(bot);
    };
    const onKicked = (reason: unknown): void => {
      cleanup();
      reject(new Error(`${opts.username} kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEnd = (reason: string): void => {
      cleanup();
      reject(new Error(`${opts.username} disconnected before spawn: ${reason}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      bot.off('spawn', onSpawn);
      bot.off('kicked', onKicked);
      bot.off('error', onError);
      bot.off('end', onEnd);
    };
    bot.once('spawn', onSpawn);
    bot.once('kicked', onKicked);
    bot.once('error', onError);
    bot.once('end', onEnd);
  });
}

export function disconnectBody(bot: Bot, reason = 'bye'): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    bot.once('end', done);
    bot.quit(reason);
    setTimeout(done, 3000);
  });
}
