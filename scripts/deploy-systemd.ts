// `pnpm deploy:systemd` (§23.2): writes deploy/minecraft-agents.service, a systemd user unit with this checkout's
// paths, so the whole system starts on boot and comes back after a crash or `pnpm ctl restart` (exit status 75).
// The unit holds no secrets: the API key and RCON password stay in .env, which start.ts reads.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '@agora/shared';

export interface UnitOptions {
  root: string;
  node: string;
  dataDir?: string;
}

/** The unit file's text. Paths with spaces are quoted the way systemd expects. */
export function renderUnit(o: UnitOptions): string {
  const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
  return [
    '# Written by `pnpm deploy:systemd` (DESIGN.md §23.2). Install:',
    '#   mkdir -p ~/.config/systemd/user && cp deploy/minecraft-agents.service ~/.config/systemd/user/',
    '#   systemctl --user daemon-reload && systemctl --user enable --now minecraft-agents',
    '#   loginctl enable-linger "$USER"    # keep it running after you log out, and start it on boot',
    '[Unit]',
    'Description=Agora: layered, social, autonomous Minecraft agents',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${q(o.root)}`,
    'Environment=AGORA_SUPERVISED=1',
    'Environment=NODE_ENV=production',
    ...(o.dataDir ? [`Environment=DATA_DIR=${q(o.dataDir)}`] : []),
    `ExecStart=${q(o.node)} --import tsx ${q(path.join(o.root, 'scripts', 'start.ts'))}`,
    // A crash restarts it; so does `pnpm ctl restart`, which exits with 75 once everything is saved.
    'Restart=on-failure',
    'RestartSec=10',
    'RestartForceExitStatus=75',
    'SuccessExitStatus=75',
    // Graceful shutdown (§23.4): bots flush memory and snapshots, then the server saves; give it time.
    'KillSignal=SIGTERM',
    'KillMode=mixed',
    'TimeoutStopSec=120',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function main(): void {
  const root = repoRoot();
  const out = path.join(root, 'deploy', 'minecraft-agents.service');
  const dataDir = process.env.DATA_DIR?.trim();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderUnit({ root, node: process.execPath, ...(dataDir ? { dataDir: path.resolve(root, dataDir) } : {}) }));
  console.log(`[deploy:systemd] wrote ${out}`);
  console.log('[deploy:systemd] install it as a user unit:');
  console.log('  mkdir -p ~/.config/systemd/user && cp deploy/minecraft-agents.service ~/.config/systemd/user/');
  console.log('  systemctl --user daemon-reload && systemctl --user enable --now minecraft-agents');
  console.log('  loginctl enable-linger "$USER"');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
