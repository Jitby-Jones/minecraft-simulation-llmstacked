// `pnpm ctl <command>` (§23.3): control of the running system from any shell on the same machine (over SSH too),
// without attaching to the server console, and the debug controls (the same as the dashboard's). Exit status: 0 done,
// 1 refused or failed, 2 usage, 3 not running.

import { ctlRequest, formatStatus } from './lib/ctl-client';

const USAGE = `usage: pnpm ctl <command>
  status | stop | restart | save
  population <n>                              keep this many agents
  test-mode on|off [--new-world]              off = hardcore, real permadeath (a played world needs --new-world)
  mode test|live [--new-world]                the same, by mode name
  say <message> | rcon "<command>"
debug controls:
  agents | personas | models [filter]         who is here, the persona pool, the subscription models
  add [persona-id] [--name N] [--sex male|female]   a new agent now (from the pool, or generated)
  remove <name> | restart-agent <name> | kill <name>
  pause <name|all> | resume <name|all>        no decisions while paused (the reflexes still keep them alive)
  module <name|all> <module> on|off           llm cc.llm talking.llm goalGen socialGoals reflection selfMonitor
                                              impulses conflict romance family skillWriter
  model <name|all> <L1|L2|L3> <model-id|auto> the model a tier tries first
  tier <name|all> <module> <L1|L2|L3|auto>    the tier a module uses (e.g. tier all talking L3)
  tuning [name] | tuning reset [name|all]
  agent <name> inspect                        state, plan, the packet its mind sees now, its last model exchange
  agent <name> memory.list [q=<words>] [tier=recent|long] [limit=N]
  agent <name> memory.add text=<words> [importance=0..1] [mind=true]
  agent <name> memory.edit id=<id> [text=<words>] [importance=0..1] [isFalse=true|false]
  agent <name> memory.delete id=<id> [mind=true]
  agent <name> task text=<words>               a task in words; it works out how, and says when it is done or why not
  agent <name> goal text=<words> [doneWhen=<condition>]
  agent <name> plan aim=<words> steps="<step>; <step>; …" | replan | plan.clear
  agent <name> decide | abort | say text=<words>
  agent <name> do '{"option":"explore","terminate":{"maxSeconds":60}}'
  agent <name> set what=<caution|fear|anger|joy|…> value=0..1`;

const COMMANDS = new Set([
  'status',
  'stop',
  'restart',
  'save',
  'population',
  'test-mode',
  'mode',
  'say',
  'rcon',
  'agents',
  'personas',
  'models',
  'add',
  'remove',
  'kill',
  'restart-agent',
  'agent',
  'module',
  'model',
  'tier',
  'pause',
  'resume',
  'tuning',
]);

/** What comes back as data worth printing in full (state, memories, lists). */
const PRINT_DATA = (cmd: string, args: string[]) => (cmd === 'agent' && ['inspect', 'memory.list'].includes(args[1] ?? '')) || cmd === 'tuning';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || !COMMANDS.has(cmd)) {
    console.error(USAGE);
    process.exit(cmd === 'help' ? 0 : 2);
  }
  if (
    (cmd === 'population' && !/^\d+$/.test(args[0] ?? '')) ||
    (cmd === 'mode' && !['test', 'live'].includes(args[0] ?? '')) ||
    (cmd === 'test-mode' && !['on', 'off'].includes(args[0] ?? '')) ||
    ((cmd === 'say' || cmd === 'rcon') && args.length === 0)
  ) {
    console.error(USAGE);
    process.exit(2);
  }
  const r = await ctlRequest(cmd, cmd === 'say' ? [args.join(' ')] : args);
  if (!r) {
    console.error('[ctl] agora is not running (nothing on the dashboard port). Start it with `pnpm start`.');
    process.exit(3);
  }
  console.log(cmd === 'status' && r.ok ? formatStatus(r) : `[ctl] ${r.message}`);
  if (r.ok && r.data !== undefined && PRINT_DATA(cmd, args)) console.log(JSON.stringify(r.data, null, 2));
  process.exit(r.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`[ctl] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
