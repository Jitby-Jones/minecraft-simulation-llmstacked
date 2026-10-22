// Chat text helpers: color stripping, 256-char splitting at sentence boundaries, word caps.

/** Vanilla chat messages are capped at 256 characters. */
export const CHAT_MAX_CHARS = 256;

/** Removes legacy § color/format codes. */
export function stripColorCodes(text: string): string {
  return text.replace(/§[0-9a-fk-orx]/gi, '');
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Splits text into chunks of at most `max` chars, preferring sentence boundaries, then word boundaries.
 * Never returns empty chunks.
 */
export function splitForChat(text: string, max = CHAT_MAX_CHARS): string[] {
  const clean = normalizeWhitespace(text);
  if (clean.length === 0) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let current = '';
  const pushCurrent = (): void => {
    const c = current.trim();
    if (c.length > 0) chunks.push(c);
    current = '';
  };
  for (const raw of sentences) {
    const s = raw.trim();
    if (s.length === 0) continue;
    if (s.length > max) {
      pushCurrent();
      for (const piece of splitByWords(s, max)) chunks.push(piece);
      continue;
    }
    const candidate = current.length === 0 ? s : `${current} ${s}`;
    if (candidate.length <= max) {
      current = candidate;
    } else {
      pushCurrent();
      current = s;
    }
  }
  pushCurrent();
  return chunks;
}

function splitByWords(text: string, max: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  let current = '';
  for (const w of words) {
    if (w.length > max) {
      if (current) out.push(current);
      current = '';
      for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length <= max) current = candidate;
    else {
      out.push(current);
      current = w;
    }
  }
  if (current) out.push(current);
  return out;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/** Truncates to at most `maxWords` words, keeping sentence punctuation if cut. */
export function capWords(text: string, maxWords: number): string {
  const words = normalizeWhitespace(text).split(' ');
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, Math.max(1, maxWords)).join(' ').replace(/[,;:]$/, '') + '…';
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Lowercase word tokens (letters, digits, apostrophes). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** True if `name` appears as a whole word (case-insensitive), also matching "@name". */
export function mentionsName(text: string, name: string): boolean {
  if (name.length === 0) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])@?${escaped}($|[^A-Za-z0-9_])`, 'i').test(text);
}

const OPENING_NAME = /^\s*(?:@([A-Za-z0-9_]{1,16})\b|([A-Za-z0-9_]{1,16})\s*[,:])\s*/;

/** The word a line opens with as if naming whom it is for ("Tib, give me..." or "@Tib ..."); null if none. */
export function openingName(text: string): string | null {
  const m = OPENING_NAME.exec(text);
  return m?.[1] ?? m?.[2] ?? null;
}

/** The line without the name it opens with, when that word is a name (`isName`). */
export function withoutOpeningName(text: string, isName: (word: string) => boolean): string {
  const name = openingName(text);
  return name && isName(name) ? text.replace(OPENING_NAME, '') : text;
}

export function quote(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}
