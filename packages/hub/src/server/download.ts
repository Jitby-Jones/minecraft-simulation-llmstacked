// Hash-verified downloads from official sources only (§23.1). A mismatch aborts; nothing unverified is kept.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type HashAlgo = 'sha256' | 'sha512' | 'sha1';

export class HashMismatchError extends Error {
  constructor(file: string, algo: HashAlgo, expected: string, actual: string) {
    super(`${algo} mismatch for ${file}: expected ${expected}, got ${actual}. Aborting (§23.1).`);
    this.name = 'HashMismatchError';
  }
}

export const ALLOWED_DOWNLOAD_HOSTS = [
  'fill.papermc.io',
  'fill-data.papermc.io',
  'api.modrinth.com',
  'cdn.modrinth.com',
  'huggingface.co',
  'cas-bridge.xethub.hf.co',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
] as const;

export function assertAllowedHost(url: string): void {
  const host = new URL(url).hostname;
  const ok = ALLOWED_DOWNLOAD_HOSTS.some((h) => host === h) || host.endsWith('.hf.co') || host.endsWith('.huggingface.co');
  if (!ok) throw new Error(`refusing to download from non-official host ${host}`);
}

export function hashFile(file: string, algo: HashAlgo): string {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export function fileMatches(file: string, algo: HashAlgo, expected: string): boolean {
  return fs.existsSync(file) && hashFile(file, algo) === expected.toLowerCase();
}

export async function fetchJson<T>(url: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  assertAllowedHost(url);
  const res = await fetchImpl(url, { headers: { 'user-agent': 'agora-setup/0.1 (+https://github.com)' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** Downloads to a temp file, verifies, then renames into place. Skips the download when the file already matches. */
export async function downloadVerified(
  url: string,
  dest: string,
  algo: HashAlgo,
  expected: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'cached' | 'downloaded'> {
  if (fileMatches(dest, algo, expected)) return 'cached';
  assertAllowedHost(url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'agora-setup/0.1' } });
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
  // The final URL after redirects must also be official.
  if (res.url) assertAllowedHost(res.url);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const actual = hashFile(tmp, algo);
  if (actual !== expected.toLowerCase()) {
    fs.rmSync(tmp, { force: true });
    throw new HashMismatchError(dest, algo, expected, actual);
  }
  fs.renameSync(tmp, dest);
  return 'downloaded';
}
