// M7 (§23.2–23.4): the operator's tools against temp directories. `pnpm logs` filters and reads backlogs from the
// end without mangling characters; export leaves out secrets, caches and what setup downloads again, and import
// round-trips it and takes only plain files under data/ and config/; the systemd unit and the Docker files keep the
// safety rules (loopback-only ports, pinned images, no .env in the image).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';
import YAML from 'yaml';
import { repoRoot } from '@agora/shared';
import { keepLine, logFiles, tail } from '../../scripts/logs';
import { createExport, exportable, extractExport } from '../../scripts/lib/archive';
import { formatStatus } from '../../scripts/lib/ctl-client';
import { renderUnit } from '../../scripts/deploy-systemd';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-m7-'));
  dirs.push(d);
  return d;
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const line = (o: Record<string, unknown>) => JSON.stringify({ level: 30, time: 1000, name: 'agora', ...o });

describe('pnpm logs', () => {
  it('filters by agent, module, level and time; plain lines only pass unfiltered', () => {
    const pip = line({ name: 'agent-Pip', module: 'cc', msg: 'decision' });
    expect(keepLine(pip, '/logs/agents/agent-Pip.log', { agent: 'pip' })).toBe(true);
    expect(keepLine(line({ module: 'supervisor', agent: 'Pip', msg: 'bot said bye' }), '/logs/agora.log', { agent: 'Pip' })).toBe(true);
    expect(keepLine(line({ name: 'agent-Rex', module: 'cc' }), '/logs/agents/agent-Rex.log', { agent: 'Pip' })).toBe(false);
    expect(keepLine(pip, 'x', { module: 'talking' })).toBe(false);
    expect(keepLine(line({ level: 30 }), 'x', { minLevel: 40 })).toBe(false);
    expect(keepLine(line({ level: 50 }), 'x', { minLevel: 40 })).toBe(true);
    expect(keepLine(line({ time: 5 }), 'x', { sinceTs: 10 })).toBe(false);
    expect(keepLine('Exception in thread main', 'x', {})).toBe(true);
    expect(keepLine('Exception in thread main', 'x', { module: 'cc' })).toBe(false);
  });

  it('finds every log file, and reads the last lines from the end even across chunk edges', () => {
    const d = tmp();
    write(path.join(d, 'agora.log'), '');
    write(path.join(d, 'agents', 'agent-Pip.log'), '');
    write(path.join(d, 'bots', 's0.log'), '');
    write(path.join(d, 'telemetry.jsonl'), '');
    expect(logFiles(d).map((f) => path.relative(d, f)).sort()).toEqual(['agents/agent-Pip.log', 'agora.log', 'bots/s0.log'].map((p) => p.split('/').join(path.sep)).sort());
    // 3000 lines of ~70 bytes (several 64 KB chunks), each with a multi-byte character somewhere.
    const lines = Array.from({ length: 3000 }, (_, i) => line({ msg: `line ${i} ünïcödé ✓`, time: i, module: i % 3 === 0 ? 'cc' : 'talking' }));
    const f = path.join(d, 'big.log');
    write(f, `${lines.join('\n')}\n`);
    const last = tail(f, 5, {});
    expect(last).toEqual(lines.slice(-5));
    const cc = tail(f, 1000, { module: 'cc' });
    expect(cc).toHaveLength(1000);
    expect(cc.every((l) => (JSON.parse(l) as { module?: string }).module === 'cc' && l.includes('ünïcödé ✓'))).toBe(true);
    expect(tail(f, 99_999, {})).toEqual(lines);
  });
});

describe('export and import (§23.4)', () => {
  it('knows what to leave out', () => {
    for (const p of ['agents/Pip.db', 'agents/Pip.db-wal', 'agents/roster.json', 'graveyard/Bram-1.db', 'server/world/level.dat', 'server/server.properties', 'server/plugins/ProximityChat/config.yml']) expect(exportable(p), p).toBe(true);
    for (const p of ['cache/models/x.onnx', 'live-test/m6/server', 'logs/agora.log', 'server/paper-26.1.2.jar', 'server/plugins/ProximityChat.jar', 'server/libraries/a.jar', 'server/versions/26.1.2', 'server/cache/mojang.jar', 'server/logs/latest.log', 'server/world/session.lock', '.env', 'agents/roster.json.tmp']) {
      expect(exportable(p), p).toBe(false);
    }
    expect(exportable('logs/agora.log', true)).toBe(true);
  });

  it('round-trips the world, the agents and the config, without secrets or downloads', async () => {
    const src = tmp();
    const data = path.join(src, 'data');
    const cfg = path.join(src, 'config');
    write(path.join(data, 'agents', 'roster.json'), '{"version":1}');
    write(path.join(data, 'agents', 'Pip.db'), 'sqlite');
    write(path.join(data, 'graveyard', 'Bram-1.db'), 'old');
    write(path.join(data, 'server', 'world', 'level.dat'), 'world');
    write(path.join(data, 'server', 'paper.jar'), 'jar');
    write(path.join(data, 'cache', 'models', 'm.onnx'), 'model');
    write(path.join(data, 'logs', 'agora.log'), 'log');
    write(path.join(data, '.env'), 'NANOGPT_API_KEY=secret');
    write(path.join(cfg, 'world.yaml'), 'mode: test\n');
    const out = path.join(src, 'export.tar.gz');
    const r = await createExport({ dataDir: data, configDir: cfg, out });
    expect(r.bytes).toBeGreaterThan(0);
    const listed: string[] = [];
    await tar.t({ file: out, onReadEntry: (e) => void listed.push(e.path.replace(/\/$/, '')) });
    expect(listed).toEqual(expect.arrayContaining(['data/agents/roster.json', 'data/agents/Pip.db', 'data/graveyard/Bram-1.db', 'data/server/world/level.dat', 'config/world.yaml']));
    expect(listed.some((p) => /paper\.jar|m\.onnx|agora\.log|\.env/.test(p))).toBe(false);
    // Somewhere else, after setup already put the Paper jar there: merged in, nothing lost.
    const dst = tmp();
    write(path.join(dst, 'data', 'server', 'paper.jar'), 'fresh jar');
    const got = await extractExport({ file: out, dataDir: path.join(dst, 'data'), configDir: path.join(dst, 'config') });
    expect(got.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(dst, 'data', 'agents', 'Pip.db'), 'utf8')).toBe('sqlite');
    expect(fs.readFileSync(path.join(dst, 'data', 'server', 'world', 'level.dat'), 'utf8')).toBe('world');
    expect(fs.readFileSync(path.join(dst, 'data', 'server', 'paper.jar'), 'utf8')).toBe('fresh jar');
    expect(fs.readFileSync(path.join(dst, 'config', 'world.yaml'), 'utf8')).toBe('mode: test\n');
    expect(fs.existsSync(path.join(dst, 'data', '.env'))).toBe(false);
  });

  it('takes only plain files under data/ and config/: no links, nothing outside', async () => {
    const src = tmp();
    write(path.join(src, 'pack', 'data', 'agents', 'ok.db'), 'fine');
    write(path.join(src, 'pack', 'data', '.env'), 'NANOGPT_API_KEY=planted');
    write(path.join(src, 'pack', 'stray.txt'), 'stray');
    write(path.join(src, 'outside.txt'), 'outside');
    fs.symlinkSync('/etc/passwd', path.join(src, 'pack', 'data', 'agents', 'link'));
    const evil = path.join(src, 'evil.tar.gz');
    await tar.c({ file: evil, gzip: true, cwd: path.join(src, 'pack'), preservePaths: true }, ['data', 'stray.txt', '../outside.txt']);
    const dst = tmp();
    const got = await extractExport({ file: evil, dataDir: path.join(dst, 'data'), configDir: path.join(dst, 'config') });
    expect(fs.readFileSync(path.join(dst, 'data', 'agents', 'ok.db'), 'utf8')).toBe('fine');
    expect(fs.existsSync(path.join(dst, 'data', 'agents', 'link'))).toBe(false);
    expect(fs.existsSync(path.join(dst, 'data', '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dst, 'stray.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(dst), 'outside.txt'))).toBe(false);
    expect(got.skipped.length).toBeGreaterThanOrEqual(4);
  });
});

describe('deployment files (§23.2, §23.3)', () => {
  it('writes a systemd user unit that restarts on a crash and after `ctl restart`, with quoted paths', () => {
    const u = renderUnit({ root: '/srv/my agents', node: '/usr/bin/node', dataDir: '/srv/data' });
    expect(u).toContain('WorkingDirectory="/srv/my agents"');
    expect(u).toContain('ExecStart=/usr/bin/node --import tsx "/srv/my agents/scripts/start.ts"');
    expect(u).toContain('Environment=DATA_DIR=/srv/data');
    expect(u).toMatch(/^Restart=on-failure$/m);
    expect(u).toMatch(/^RestartForceExitStatus=75$/m);
    expect(u).toMatch(/^WantedBy=default\.target$/m);
    expect(u).not.toMatch(/NANOGPT|RCON_PASSWORD/);
  });

  it('keeps the container safe: pinned image and Node, loopback-only ports, no .env or data in the image', () => {
    const root = repoRoot();
    const docker = fs.readFileSync(path.join(root, 'deploy', 'Dockerfile'), 'utf8');
    expect(docker).toMatch(/^FROM eclipse-temurin:\d+[.\d_]*-jre-noble@sha256:[0-9a-f]{64}$/m);
    expect(docker).toMatch(/ARG NODE_VERSION=22\.\d+\.\d+/);
    expect(docker).toMatch(/NODE_SHA256_X64=[0-9a-f]{64}/);
    expect(docker).toMatch(/sha256sum -c -/);
    expect(docker).toMatch(/pnpm install --frozen-lockfile/);
    expect(docker).not.toMatch(/COPY\s+\.env/);
    const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split('\n');
    for (const p of ['.env', 'data', 'node_modules']) expect(ignore).toContain(p);
    const compose = YAML.parse(fs.readFileSync(path.join(root, 'deploy', 'compose.yaml'), 'utf8')) as { services: { agora: { ports: string[]; volumes: string[] } } };
    const ports = compose.services.agora.ports;
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p.startsWith('127.0.0.1:'), p).toBe(true);
    expect(compose.services.agora.volumes).toContain('../.env:/app/.env');
  });
});

describe('pnpm ctl', () => {
  it('prints the status the operator needs', () => {
    const text = formatStatus({
      ok: true,
      message: 'running',
      data: { mode: 'test', uptimeSec: 3720, target: 3, server: 'running', living: [{ username: 'Pip', slot: 's0', online: true, since: 0 }, { username: 'Rex', slot: 's1', online: false, since: 0 }], quota: { level: 1, codeOnly: false, weeklyPercent: 0.72 }, dashboard: 'http://127.0.0.1:8080' },
    });
    expect(text.split('\n')).toEqual(['test mode on (mode test), up 62 min, server running', 'population 2 of 3', '  ● Pip (s0)', '  ○ Rex (s1)', 'quota: level 1, 72% of the week used', 'dashboard http://127.0.0.1:8080']);
  });
});
