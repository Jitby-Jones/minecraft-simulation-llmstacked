// NameMC (§16.5): which skins carry a tag, and the skin images. A tag's listing is a web page that NameMC puts
// behind a Cloudflare challenge for anything that isn't a browser, and this client never tries to get past it:
// turned away, it says so, and the skins come from the pages the owner saved from a browser (or lists of skin
// links) in DATA_DIR/skins/namemc/<tag>/ instead. The images come from NameMC's image host, which serves them as
// they are.

import fs from 'node:fs';
import path from 'node:path';

export const NAMEMC_USER_AGENT = 'agora-skins/0.1 (Minecraft agent simulation; a skin for each of its agents)';
export const NAMEMC_IMAGE_HOST = 's.namemc.com';
/** A skin image is a few KB; anything this big is not one. */
const MAX_PNG_BYTES = 64 * 1024;
const MAX_PAGE_CHARS = 4_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A skin's page (/skin/<id>) or a render of it (…?id=<id>): NameMC skin ids are 16 hex digits. */
const SKIN_ID = /\/skin\/([0-9a-f]{16})\b|[?&]id=([0-9a-f]{16})\b/g;
const BARE_ID = /^\s*([0-9a-f]{16})\s*$/;

/** NameMC turned the request away with a Cloudflare challenge: only a browser gets the page. */
export class NameMcBlockedError extends Error {
  constructor(readonly url: string) {
    super(`NameMC turned the request for ${url} away (a Cloudflare challenge: only a browser gets this page)`);
    this.name = 'NameMcBlockedError';
  }
}

/** The image is not a usable skin: no point trying it again. */
export class SkinImageError extends Error {
  constructor(
    readonly id: string,
    why: string,
  ) {
    super(`NameMC skin ${id}: ${why}`);
    this.name = 'SkinImageError';
  }
}

export function tagUrl(tag: string, page = 1): string {
  return `https://namemc.com/minecraft-skins/tag/${encodeURIComponent(tag)}${page > 1 ? `?page=${page}` : ''}`;
}

/** The skin ids on a NameMC page (a tag's listing, fetched or saved from a browser), in page order, each once. */
export function skinIdsIn(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(SKIN_ID)) {
    const id = m[1] ?? m[2];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Skin ids from a list the owner wrote: a NameMC skin link or a bare id per line. */
export function skinIdsInList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const id of [...skinIdsIn(line), ...(BARE_ID.exec(line)?.slice(1, 2) ?? [])]) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** A Cloudflare challenge rather than the page: the header Cloudflare sets, or its "Just a moment..." page. */
export function isChallenge(status: number, headers: Headers, body: string): boolean {
  if (headers.get('cf-mitigated') === 'challenge') return true;
  return (status === 403 || status === 503 || status === 429) && /<title>Just a moment\.\.\.<\/title>|challenges\.cloudflare\.com|cf-chl-/i.test(body);
}

/** One page of a tag's listing, as NameMC serves it to us. Throws NameMcBlockedError when it won't. */
export async function fetchTagPage(tag: string, page: number, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string[]> {
  const url = tagUrl(tag, page);
  const res = await fetchImpl(url, { headers: { 'user-agent': NAMEMC_USER_AGENT, accept: 'text/html' }, redirect: 'manual', ...(signal ? { signal } : {}) });
  const body = (await res.text()).slice(0, MAX_PAGE_CHARS);
  if (isChallenge(res.status, res.headers, body)) throw new NameMcBlockedError(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return skinIdsIn(body);
}

/**
 * What the owner saved for a tag: every .html/.htm page (a listing saved from a browser) and .txt list in
 * <dir>/<tag>/, in file-name order. Pages and lists the owner chose come before anything fetched.
 */
export function ownerSkinIds(dir: string, tag: string): string[] {
  const tagDir = path.join(dir, tag);
  if (!fs.existsSync(tagDir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(tagDir).sort()) {
    const file = path.join(tagDir, f);
    if (!fs.statSync(file).isFile()) continue;
    const text = /\.(html?|txt)$/i.test(f) ? fs.readFileSync(file, 'utf8').slice(0, MAX_PAGE_CHARS) : null;
    if (text === null) continue;
    for (const id of /\.txt$/i.test(f) ? skinIdsInList(text) : skinIdsIn(text)) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Width and height of a PNG, or null if it isn't one. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A Minecraft skin: a PNG of 64×64, or the old 64×32. */
export function isSkinPng(buf: Buffer): boolean {
  const s = pngSize(buf);
  return buf.length <= MAX_PNG_BYTES && s !== null && s.width === 64 && (s.height === 64 || s.height === 32);
}

/** The skin's image from NameMC's image host; nothing but a skin PNG from that host is accepted. */
export async function fetchSkinImage(id: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`not a NameMC skin id: ${id}`);
  const url = `https://${NAMEMC_IMAGE_HOST}/i/${id}.png`;
  const res = await fetchImpl(url, { headers: { 'user-agent': NAMEMC_USER_AGENT, accept: 'image/png' }, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!isSkinPng(buf)) throw new SkinImageError(id, buf.length === 0 ? 'no image' : 'not a 64×64 or 64×32 skin PNG');
  return buf;
}
