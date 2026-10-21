// .env loading (§5). The API key is never logged; use redactSecrets() on anything that might contain it.

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { repoRoot } from './paths';

let loaded = false;

export function loadEnv(file: string = path.join(repoRoot(), '.env')): void {
  if (loaded) return;
  loaded = true;
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, quiet: true });
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'NANOGPT_API_KEY is not set. Copy .env.example to .env in the project root and put your NanoGPT key after ' +
        '"NANOGPT_API_KEY=". Set the key to "Subscription only" in the NanoGPT dashboard (DESIGN.md §22.1).',
    );
    this.name = 'MissingApiKeyError';
  }
}

export function getNanoGptKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.NANOGPT_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/** Fails fast with a clear message pointing at .env. */
export function requireNanoGptKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = getNanoGptKey(env);
  if (!key) throw new MissingApiKeyError();
  return key;
}

const SECRET_ENV_NAMES = ['NANOGPT_API_KEY', 'RCON_PASSWORD'] as const;

/** Replaces any known secret values (and bearer tokens) with a placeholder. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (v && v.length >= 4) out = out.split(v).join(`[${name}]`);
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

/** Upserts KEY=value in a .env file, preserving other lines. */
export function setEnvValue(file: string, key: string, value: string): void {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const out = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (out.length > 0 && out[out.length - 1] === '') out.pop();
    out.push(`${key}=${value}`, '');
  }
  fs.writeFileSync(file, out.join('\n'));
}
