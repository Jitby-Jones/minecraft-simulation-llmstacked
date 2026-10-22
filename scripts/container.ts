// The container's entry (deploy/Dockerfile, §23.2): setup on every start (pinned, hash-checked downloads into the
// DATA_DIR volume; quick when everything is already there), then start. The Minecraft EULA is accepted only when
// the operator set AGORA_ACCEPT_EULA=true in .env after reading it.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadEnv, repoRoot } from '@agora/shared';

loadEnv();
const eula = process.env.AGORA_ACCEPT_EULA === 'true' ? ['--accept-eula'] : [];
const setup = spawnSync(process.execPath, ['--import', 'tsx', path.join(repoRoot(), 'scripts', 'setup.ts'), ...eula], { stdio: 'inherit' });
if (setup.status !== 0) process.exit(setup.status ?? 1);
await import('./start');
