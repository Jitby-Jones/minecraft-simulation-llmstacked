// The server console as the dashboard shows it (owner request, 2026-10-24): the Minecraft server's own output, and
// the commands typed in the page with their answers, kept in memory only (the last MAX lines) and read behind the
// control token. Nothing here reaches a bot.

const MAX = 1000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export type ConsoleKind = 'server' | 'in' | 'out';

export interface ConsoleLine {
  /** Counts up from 1; `since(n)` returns the lines after n. */
  n: number;
  ts: number;
  kind: ConsoleKind;
  text: string;
}

export class ConsoleLog {
  private lines: ConsoleLine[] = [];
  private last = 0;

  constructor(private readonly now: () => number = Date.now) {}

  push(kind: ConsoleKind, text: string): void {
    for (const part of text.replace(ANSI, '').split(/\r?\n/)) {
      if (!part.trim() && kind === 'server') continue;
      this.lines.push({ n: ++this.last, ts: this.now(), kind, text: part });
    }
    if (this.lines.length > MAX) this.lines.splice(0, this.lines.length - MAX);
  }

  /** The lines after `n` (all that are kept when n is 0), and the number to ask from next. */
  since(n: number, limit = 300): { next: number; lines: ConsoleLine[] } {
    const fresh = this.lines.filter((l) => l.n > n);
    const lines = fresh.slice(-limit);
    return { next: this.last, lines };
  }
}
