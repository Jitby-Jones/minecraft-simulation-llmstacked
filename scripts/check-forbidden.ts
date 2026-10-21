// §22.2 lint rule: fail if any billing-bypass option appears in code outside the LLM guard's strip list.
// Allowed: packages/llm/src/guard.ts (the strip list itself) and tests/llm/** (tests asserting the strip).

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@agora/shared';

/** Case-insensitive needles. Written as fragments so this file does not match itself. */
const FORBIDDEN: readonly string[] = [
  ['x-', 'provider'],
  ['x-', 'billing-mode'],
  ['x-nanogpt-', 'billing'],
  ['billing', '_mode'],
  ['billing', 'Mode'],
  ['cache', '_control'],
  ['service', '_tier'],
  ['prompt', '_caching'],
  ['prompt', 'Caching'],
  ['sticky', 'provider'],
  ['x-use-', 'byok'],
  ['x-byok', '-'],
  ['x-', 'payment'],
  ['x-', 'x402'],
  ['x-prompt-', 'caching'],
  ['x-anthropic-', 'cache'],
  ['x-cache-', 'depth'],
  ['/api/', 'paid'],
  ['/api/v1/chat', '/completions'],
].map((parts) => parts.join('').toLowerCase());

const ALLOWED_FILES = new Set([path.join('packages', 'llm', 'src', 'guard.ts'), path.join('scripts', 'check-forbidden.ts')]);
const ALLOWED_DIRS = [path.join('tests', 'llm') + path.sep];
const SCAN_DIRS = ['packages', 'scripts', 'tests', 'config', 'deploy'];
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml']);

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
}

const root = repoRoot();
const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(root, d), files);

const violations: string[] = [];
for (const file of files) {
  const rel = path.relative(root, file);
  if (ALLOWED_FILES.has(rel) || ALLOWED_DIRS.some((d) => rel.startsWith(d))) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const needle of FORBIDDEN) {
      if (lower.includes(needle)) violations.push(`${rel}:${i + 1}: contains forbidden "${needle}"`);
    }
  });
}

if (violations.length > 0) {
  console.error('Subscription lock violation (§22.2): billing-bypass options found outside the guard strip list:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`check-forbidden: OK (${files.length} files scanned)`);
