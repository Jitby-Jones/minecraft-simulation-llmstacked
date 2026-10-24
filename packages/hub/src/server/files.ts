// Other generated server files: ProximityChat! config, ops.json, eula.txt and mode state.

import fs from 'node:fs';
import path from 'node:path';
import { type DataPaths, type WorldConfig, renderProximityChatConfig, writeFileAtomic } from '@agora/shared';
import type { Mode } from './properties';

export interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

export function readOps(paths: DataPaths): OpEntry[] {
  const file = path.join(paths.server, 'ops.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as OpEntry[]) : [];
  } catch {
    return [];
  }
}

/** Offline-mode UUID: v3 UUID of "OfflinePlayer:<name>", exactly as the server computes it. */
export async function offlineUuid(name: string): Promise<string> {
  const crypto = await import('node:crypto');
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = ((md5[6] ?? 0) & 0x0f) | 0x30;
  md5[8] = ((md5[8] ?? 0) & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Ensures the owner (if configured) is op. Never removes manual ops. */
export async function ensureOwnerOp(paths: DataPaths, owner: string | undefined): Promise<void> {
  if (!owner) return;
  const ops = readOps(paths);
  if (ops.some((o) => o.name.toLowerCase() === owner.toLowerCase())) return;
  ops.push({ uuid: await offlineUuid(owner), name: owner, level: 4, bypassesPlayerLimit: true });
  writeFileAtomic(path.join(paths.server, 'ops.json'), JSON.stringify(ops, null, 2));
}

/** Startup check (§15.4): the agents that are op (a warning: the operator may op anyone from the console). */
export function opsContainingBots(paths: DataPaths, botNames: Iterable<string>): string[] {
  const ops = new Set(readOps(paths).map((o) => o.name.toLowerCase()));
  return [...botNames].filter((n) => ops.has(n.toLowerCase()));
}

export function writeProximityChatConfig(paths: DataPaths, world: WorldConfig): void {
  writeFileAtomic(
    path.join(paths.plugins, 'ProximityChat', 'config.yml'),
    renderProximityChatConfig({
      normalRange: world.chat.normalRange,
      whisperRange: world.chat.whisperRange,
      shoutRange: world.chat.shoutRange,
      fadeStart: world.chat.fadeStart,
      cooldownSec: world.chat.cooldownSec,
    }),
  );
}

export function eulaAccepted(paths: DataPaths): boolean {
  const file = path.join(paths.server, 'eula.txt');
  return fs.existsSync(file) && /^\s*eula\s*=\s*true\s*$/m.test(fs.readFileSync(file, 'utf8'));
}

export function acceptEula(paths: DataPaths): void {
  writeFileAtomic(
    path.join(paths.server, 'eula.txt'),
    `# Accepted via \`pnpm run setup --accept-eula\` on ${new Date().toISOString()} (https://aka.ms/MinecraftEULA)\neula=true\n`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mode state (§16.3): which mode and world folder the server files were last written for.

export interface ModeState {
  mode: Mode;
  levelName: string;
  appliedAt: number;
}

export function modeStatePath(paths: DataPaths): string {
  return path.join(paths.server, '.agora-mode.json');
}

export function readModeState(paths: DataPaths): ModeState | null {
  const file = modeStatePath(paths);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ModeState;
  } catch {
    return null;
  }
}

export function writeModeState(paths: DataPaths, state: ModeState): void {
  writeFileAtomic(modeStatePath(paths), JSON.stringify(state, null, 2));
}

export function worldExists(paths: DataPaths, levelName: string): boolean {
  return fs.existsSync(path.join(paths.server, levelName, 'level.dat'));
}

export function freshLevelName(base: string, mode: Mode, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${base}-${mode}-${stamp}`;
}

export interface ModeSwitchPlan {
  ok: boolean;
  levelName: string;
  reason: string;
}

/**
 * Decides the level name for a requested mode. Switching mode on an existing world is refused unless
 * `newWorld` is set, so hardcore applies cleanly (§16.3).
 */
export function planModeSwitch(
  current: ModeState | null,
  requested: Mode,
  baseLevel: string,
  existing: (level: string) => boolean,
  newWorld: boolean,
  now = new Date(),
): ModeSwitchPlan {
  if (newWorld) return { ok: true, levelName: freshLevelName(baseLevel, requested, now), reason: 'new world requested' };
  if (!current) {
    if (requested === 'live' && existing(baseLevel)) {
      return { ok: false, levelName: baseLevel, reason: `world "${baseLevel}" already exists; live mode needs --new-world` };
    }
    return { ok: true, levelName: baseLevel, reason: 'first setup' };
  }
  if (current.mode === requested) return { ok: true, levelName: current.levelName, reason: 'mode unchanged' };
  if (existing(current.levelName)) {
    return {
      ok: false,
      levelName: current.levelName,
      reason: `refusing to switch existing world "${current.levelName}" from ${current.mode} to ${requested}; pass --new-world`,
    };
  }
  return { ok: true, levelName: current.levelName, reason: 'world not generated yet' };
}
