// `pnpm ctl status|stop|restart|save|population <n>|mode test|live [--new-world]|say <msg>|rcon "<cmd>"` (§23.3):
// control of the running system from any shell on the same machine (over SSH too), without attaching to the
// server console. Exit status: 0 done, 1 refused or failed, 3 not running.

import { ctlRequest, formatStatus } from './lib/ctl-client';

const USAGE = 'usage: pnpm ctl status | stop | restart | save | population <n> | mode test|live [--new-world] | say <message> | rcon "<command>"';
const COMMANDS = new Set(['status', 'stop', 'restart', 'save', 'population', 'mode', 'say', 'rcon']);

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || !COMMANDS.has(cmd)) {
    console.error(USAGE);
    process.exit(2);
  }
  if ((cmd === 'population' && !/^\d+$/.test(args[0] ?? '')) || (cmd === 'mode' && !['test', 'live'].includes(args[0] ?? '')) || ((cmd === 'say' || cmd === 'rcon') && args.length === 0)) {
    console.error(USAGE);
    process.exit(2);
  }
  const r = await ctlRequest(cmd, cmd === 'say' ? [args.join(' ')] : args);
  if (!r) {
    console.error('[ctl] agora is not running (nothing on the dashboard port). Start it with `pnpm start`.');
    process.exit(3);
  }
  console.log(cmd === 'status' && r.ok ? formatStatus(r) : `[ctl] ${r.message}`);
  process.exit(r.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`[ctl] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
