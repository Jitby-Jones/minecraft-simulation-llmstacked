import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorldConfigSchema, dataPaths, ensureDataDirs, loadVersionsConfig } from '@agora/shared';
import {
  HashMismatchError,
  applyServerFiles,
  assertAllowedHost,
  bindingWarning,
  buildServerProperties,
  downloadVerified,
  freshLevelName,
  offlineUuid,
  opsContainingBots,
  parseJavaVersion,
  parseProperties,
  planModeSwitch,
  readModeState,
  verifyInstall,
} from '@agora/hub';

const world = WorldConfigSchema.parse({});

function tmpDataPaths() {
  return ensureDataDirs(dataPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-data-'))));
}

describe('server.properties (§15.4)', () => {
  it('sets offline mode, hard difficulty, localhost binding and hardcore by mode', () => {
    const test = parseProperties(buildServerProperties(null, { world, mode: 'test', levelName: 'world', rconPassword: 'pw' }));
    expect(test.get('online-mode')).toBe('false');
    expect(test.get('enforce-secure-profile')).toBe('false');
    expect(test.get('spawn-protection')).toBe('0');
    expect(test.get('difficulty')).toBe('hard');
    expect(test.get('hardcore')).toBe('false');
    expect(test.get('server-ip')).toBe('127.0.0.1');
    expect(test.get('max-players')).toBe(String(world.population.maxAlive + world.server.extraPlayerSlots));
    const live = parseProperties(buildServerProperties(null, { world, mode: 'live', levelName: 'w2', rconPassword: 'pw' }));
    expect(live.get('hardcore')).toBe('true');
    expect(live.get('level-name')).toBe('w2');
  });

  it('preserves unmanaged keys', () => {
    const out = parseProperties(buildServerProperties('foo=bar\nonline-mode=true\n', { world, mode: 'test', levelName: 'world', rconPassword: 'x' }));
    expect(out.get('foo')).toBe('bar');
    expect(out.get('online-mode')).toBe('false');
  });

  it('warns about unsafe bindings (§23.3)', () => {
    expect(bindingWarning('127.0.0.1')).toBeNull();
    expect(bindingWarning('100.101.5.6')).toBeNull(); // tailscale range
    expect(bindingWarning('192.168.1.10')).toBeNull();
    expect(bindingWarning('0.0.0.0')).toMatch(/every interface/);
    expect(bindingWarning('')).toMatch(/every interface/);
    expect(bindingWarning('8.8.8.8')).toMatch(/public/);
  });
});

describe('mode switching (§16.3)', () => {
  const exists = (names: string[]) => (lvl: string) => names.includes(lvl);
  const now = new Date('2026-10-21T18:00:00Z');

  it('allows the first setup in test mode', () => {
    expect(planModeSwitch(null, 'test', 'world', exists([]), false, now)).toMatchObject({ ok: true, levelName: 'world' });
  });

  it('refuses to switch an existing world without --new-world', () => {
    const cur = { mode: 'test' as const, levelName: 'world', appliedAt: 0 };
    const plan = planModeSwitch(cur, 'live', 'world', exists(['world']), false, now);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/--new-world/);
  });

  it('creates a fresh world folder with --new-world', () => {
    const cur = { mode: 'test' as const, levelName: 'world', appliedAt: 0 };
    const plan = planModeSwitch(cur, 'live', 'world', exists(['world']), true, now);
    expect(plan.ok).toBe(true);
    expect(plan.levelName).toBe(freshLevelName('world', 'live', now));
    expect(plan.levelName).not.toBe('world');
  });

  it('refuses live on a pre-existing world even on first setup', () => {
    expect(planModeSwitch(null, 'live', 'world', exists(['world']), false, now).ok).toBe(false);
  });

  it('applyServerFiles writes files and records the mode', async () => {
    const paths = tmpDataPaths();
    const r = await applyServerFiles(paths, { ...world, owner: { username: 'OwnerGuy' } }, 'pw');
    expect(r.ok).toBe(true);
    expect(readModeState(paths)?.mode).toBe('test');
    expect(fs.readFileSync(path.join(paths.plugins, 'ProximityChat', 'config.yml'), 'utf8')).toContain('default: 15');
    const ops = JSON.parse(fs.readFileSync(path.join(paths.server, 'ops.json'), 'utf8')) as { name: string }[];
    expect(ops.map((o) => o.name)).toEqual(['OwnerGuy']);
    expect(opsContainingBots(paths, ['Pip', 'ownerguy'])).toEqual(['ownerguy']);
  });
});

describe('offline UUIDs', () => {
  it('matches the server algorithm (v3 of "OfflinePlayer:<name>")', async () => {
    // Known value: offline UUID for "Notch".
    expect(await offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
  });
});

describe('java detection', () => {
  it('parses modern and legacy version strings and ignores tool-options noise', () => {
    expect(parseJavaVersion('Picked up JAVA_TOOL_OPTIONS: -Dx=y\nopenjdk version "25.0.4.1" 2026-08-18 LTS')?.major).toBe(25);
    expect(parseJavaVersion('java version "1.8.0_402"')?.major).toBe(8);
    expect(parseJavaVersion('openjdk version "21.0.12.1" 2026-08-18')?.major).toBe(21);
    expect(parseJavaVersion('nothing here')).toBeNull();
  });
});

describe('verified downloads (§23.1)', () => {
  const body = Buffer.from('hello paper');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;

  it('downloads, verifies and caches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-dl-'));
    const dest = path.join(dir, 'paper.jar');
    expect(await downloadVerified('https://fill-data.papermc.io/v1/objects/x/paper.jar', dest, 'sha256', sha, fakeFetch)).toBe('downloaded');
    expect(fs.readFileSync(dest).toString()).toBe('hello paper');
    expect(await downloadVerified('https://fill-data.papermc.io/v1/objects/x/paper.jar', dest, 'sha256', sha, fakeFetch)).toBe('cached');
  });

  it('aborts and keeps nothing on a hash mismatch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-dl-'));
    const dest = path.join(dir, 'paper.jar');
    await expect(downloadVerified('https://cdn.modrinth.com/x.jar', dest, 'sha256', '0'.repeat(64), fakeFetch)).rejects.toBeInstanceOf(
      HashMismatchError,
    );
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('refuses non-official hosts', () => {
    expect(() => assertAllowedHost('https://evil.example.com/paper.jar')).toThrow(/non-official/);
    expect(() => assertAllowedHost('https://fill.papermc.io/v3/projects/paper')).not.toThrow();
    expect(() => assertAllowedHost('https://huggingface.co/Xenova/x/resolve/abc/config.json')).not.toThrow();
  });

  it('verifyInstall reports missing jars', () => {
    const paths = tmpDataPaths();
    const r = verifyInstall(paths, loadVersionsConfig());
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/Paper jar missing/);
    expect(r.problems.join('\n')).toMatch(/ProximityChat! jar missing/);
    expect(r.problems.join('\n')).toMatch(/guard plugin/);
  });
});
