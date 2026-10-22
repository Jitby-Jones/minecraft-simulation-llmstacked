// Signs as a player reads and writes them (§6.8 notice board, §16.1 in-world records): the front's lines, and
// four short lines when writing.

import type { Block } from 'prismarine-block';

/** Characters per line that show on a standing sign (the protocol takes 45; the sign shows about 15). */
export const SIGN_WIDTH = 15;
export const SIGN_LINES = 4;

export const isSignBlock = (name: string): boolean => /_sign$/.test(name) && !/_hanging_sign$/.test(name);

/** A text component in any of its shapes (string, JSON string, {text, extra}, NBT {type, value}, list) → plain text. */
export function plainText(c: unknown): string {
  if (typeof c === 'string') {
    const t = c.trim();
    if (t.startsWith('{') || t.startsWith('[') || (t.startsWith('"') && t.endsWith('"'))) {
      try {
        return plainText(JSON.parse(t));
      } catch {
        return c;
      }
    }
    return c;
  }
  if (Array.isArray(c)) return c.map(plainText).join('');
  if (c && typeof c === 'object') {
    const o = c as { text?: unknown; extra?: unknown; value?: unknown; type?: unknown; translate?: unknown };
    if ('type' in o && 'value' in o && !('text' in o)) return plainText(o.value);
    return `${plainText(o.text ?? o.translate ?? '')}${o.extra ? plainText(o.extra) : ''}`;
  }
  return '';
}

/** The front of a sign, its lines joined with spaces; null when it isn't a sign or says nothing. */
export function readSign(block: Block | null): string | null {
  if (!block || !isSignBlock(block.name)) return null;
  const b = block as unknown as {
    entity?: { value?: { front_text?: { value?: { messages?: { value?: { value?: unknown } } } } } };
    getSignText?: () => string[];
  };
  let lines: string[];
  const raw = b.entity?.value?.front_text?.value?.messages?.value?.value;
  if (Array.isArray(raw)) lines = raw.map(plainText);
  else {
    try {
      lines = (b.getSignText?.()[0] ?? '').split('\n');
    } catch {
      lines = [];
    }
  }
  const text = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  return text.length > 0 ? text : null;
}

/** Fits a message onto a sign: whole words, at most four lines of 15; a message that doesn't fit ends in "…". */
export function wrapForSign(text: string, width = SIGN_WIDTH, lines = SIGN_LINES): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  let cur = '';
  let used = 0;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) {
      cur = next;
      used++;
      continue;
    }
    if (cur) out.push(cur);
    if (out.length === lines) {
      cur = '';
      break;
    }
    cur = w.length > width ? `${w.slice(0, width - 1)}…` : w;
    used++;
  }
  if (cur && out.length < lines) out.push(cur);
  if (used < words.length && out.length > 0) {
    const last = out[out.length - 1] ?? '';
    out[out.length - 1] = last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
  }
  return out;
}
