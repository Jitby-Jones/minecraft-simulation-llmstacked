// Finds a Java runtime new enough for the pinned Paper build (§15.1, §23.1).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface JavaInfo {
  path: string;
  major: number;
  versionLine: string;
}

/** Parses `java -version` stderr. Handles "1.8.0_x" and modern "25.0.4". Ignores JAVA_TOOL_OPTIONS noise. */
export function parseJavaVersion(output: string): { major: number; line: string } | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /version "([^"]+)"/.exec(line);
    if (!m?.[1]) continue;
    const v = m[1];
    const parts = v.split(/[.+_-]/);
    const first = Number(parts[0]);
    const major = first === 1 ? Number(parts[1]) : first;
    if (Number.isFinite(major)) return { major, line: line.trim() };
  }
  return null;
}

export function probeJava(javaPath: string): JavaInfo | null {
  const r = spawnSync(javaPath, ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  const parsed = parseJavaVersion(`${r.stderr}\n${r.stdout}`);
  return parsed ? { path: javaPath, major: parsed.major, versionLine: parsed.line } : null;
}

export function javaCandidates(configured?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const out: string[] = [];
  if (configured) out.push(configured);
  if (env.AGORA_JAVA) out.push(env.AGORA_JAVA);
  if (env.JAVA_HOME) out.push(path.join(env.JAVA_HOME, 'bin', exe));
  out.push(exe);
  return [...new Set(out)];
}

/** Returns the first candidate whose major version is at least `minMajor`, plus everything probed. */
export function findJava(
  minMajor: number,
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): { found: JavaInfo | null; probed: JavaInfo[] } {
  const probed: JavaInfo[] = [];
  for (const cand of javaCandidates(configured, env)) {
    if (cand.includes(path.sep) && !fs.existsSync(cand)) continue;
    const info = probeJava(cand);
    if (!info) continue;
    probed.push(info);
    if (info.major >= minMajor) return { found: info, probed };
  }
  return { found: null, probed };
}
