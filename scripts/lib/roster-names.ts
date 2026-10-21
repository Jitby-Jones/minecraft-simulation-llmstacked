// Reads every username ever used from roster.json without depending on the supervisor (scripts only).

import fs from 'node:fs';
import type { DataPaths } from '@agora/shared';

export function readRosterNames(paths: DataPaths): string[] {
  if (!fs.existsSync(paths.roster)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(paths.roster, 'utf8')) as { usedNames?: unknown };
    return Array.isArray(raw.usedNames) ? raw.usedNames.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}
