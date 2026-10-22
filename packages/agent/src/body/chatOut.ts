// Outgoing chat (§6.2 loop guards, §15.3, §16.1): ≤ 1 utterance per 2 s per bot, typing delay
// (~40 ms/char, capped at 3 s), 256-char splitting at sentence boundaries, volume prefixes, and an optional
// global speech token from the Hub. Bots never type commands in chat.

import { type Logger, type Volume, sleep, splitForChat, withVolumePrefix } from '@agora/shared';
import type { Bot } from 'mineflayer';

export interface ChatOutOptions {
  minIntervalMs?: number;
  msPerChar?: number;
  maxTypingMs?: number;
  /** Optional global guard (Hub speechToken). Resolve false to drop the line. */
  acquireGlobalToken?: () => Promise<boolean>;
  /** Per-pair guard (§6.2): ≤ 30 utterances per 10 min to the same listener. */
  pairLimit?: { count: number; windowMs: number };
  logger?: Logger;
  now?: () => number;
}

export interface SayResult {
  sent: boolean;
  reason?: 'empty' | 'command' | 'guard' | 'global' | 'pair' | 'disconnected' | 'superseded';
  parts: number;
}

export class ChatOut {
  private lastSentAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Urgent lines said so far: one goes out ahead of the queue, and what was waiting is dropped. */
  private urgentSaid = 0;
  private readonly pairLog = new Map<string, number[]>();
  private guardHits = 0;

  constructor(
    private readonly bot: Bot,
    private readonly opts: ChatOutOptions = {},
  ) {}

  get guardHitCount(): number {
    return this.guardHits;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Serializes all speech so the rate guard holds across modules. `stillWanted` is asked right before the line goes
   * out, after the typing delay (group floor control: someone else may have answered meanwhile). An urgent line
   * (giving up a fight, calling one off) goes out at once, ahead of anything waiting: blows land while one types.
   * What was waiting then is dropped ("back off, or else" after "I yield" would be a lie).
   */
  say(text: string, volume: Volume = 'normal', listeners: readonly string[] = [], stillWanted?: () => boolean, urgent = false): Promise<SayResult> {
    if (urgent) {
      this.urgentSaid++;
      return this.sendNow(text, volume, listeners, stillWanted, true);
    }
    const before = this.urgentSaid;
    const wanted = (): boolean => this.urgentSaid === before && (!stillWanted || stillWanted());
    const run = async (): Promise<SayResult> => this.sendNow(text, volume, listeners, wanted);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private pairAllowed(listeners: readonly string[]): boolean {
    const limit = this.opts.pairLimit ?? { count: 30, windowMs: 10 * 60_000 };
    const t = this.now();
    for (const l of listeners) {
      const log = (this.pairLog.get(l) ?? []).filter((ts) => t - ts < limit.windowMs);
      this.pairLog.set(l, log);
      if (log.length >= limit.count) return false;
    }
    return true;
  }

  private async sendNow(text: string, volume: Volume, listeners: readonly string[], stillWanted?: () => boolean, urgent = false): Promise<SayResult> {
    const clean = text.replace(/[\r\n]+/g, ' ').trim();
    if (!clean) return { sent: false, reason: 'empty', parts: 0 };
    // Never type commands: a leading slash would run a server command.
    if (clean.startsWith('/')) return { sent: false, reason: 'command', parts: 0 };
    if (!this.pairAllowed(listeners)) {
      this.guardHits++;
      this.opts.logger?.warn({ module: 'chat', listeners }, 'per-pair speech guard hit; staying silent');
      return { sent: false, reason: 'pair', parts: 0 };
    }
    // Leave room for the one-character volume prefix.
    const parts = splitForChat(withVolumePrefix(clean, 'normal'), 255);
    let sentParts = 0;
    for (const part of parts) {
      const minInterval = this.opts.minIntervalMs ?? 2000;
      const typing = Math.min(this.opts.maxTypingMs ?? 3000, part.length * (this.opts.msPerChar ?? 40));
      const wait = urgent ? 0 : Math.max(typing, this.lastSentAt + minInterval - this.now());
      if (wait > 0) await sleep(wait);
      if (!urgent && this.opts.acquireGlobalToken && !(await this.opts.acquireGlobalToken())) {
        this.guardHits++;
        this.opts.logger?.warn({ module: 'chat' }, 'global speech guard hit; staying silent');
        return { sent: sentParts > 0, reason: 'global', parts: sentParts };
      }
      if (stillWanted && !stillWanted()) return { sent: sentParts > 0, reason: 'superseded', parts: sentParts };
      // The bot may have disconnected while we waited.
      const client = this.bot._client as { ended?: boolean } | undefined;
      if (!client || client.ended) return { sent: sentParts > 0, reason: 'disconnected', parts: sentParts };
      const prefixed = withVolumePrefix(part, volume).slice(0, 256);
      this.bot.chat(prefixed);
      this.lastSentAt = this.now();
      sentParts++;
    }
    const t = this.now();
    for (const l of listeners) this.pairLog.get(l)?.push(t);
    return { sent: true, parts: sentParts };
  }
}
