// What `pnpm ctl` can do to the running system (§23.3): status, stop, restart, save, population, mode, say, rcon.
// The handler only drives infrastructure (the supervisor, the server console, the Hub's snapshot request); it never
// tells a bot anything about the world. `say` is an ordinary server message every player in range of chat sees.

import type { QuotaStatus } from '@agora/llm';
import type { ControlHandler, ControlResult } from './server';

export interface ControlDeps {
  mode: () => string;
  /** world.owner.username: the one player `ctl rcon "op …"` may make an operator (§13: never a bot). */
  owner?: string;
  startedAt: number;
  supervisor: {
    living: readonly { username: string; slot: string; bornAt: number }[];
    readonly targetPopulation: number;
    setPopulation(n: number): void;
  };
  /** Bots connected to the Hub right now. */
  online: () => Set<string>;
  /** Every bot writes its snapshot and checkpoints its memory; resolves with how many confirmed. */
  snapshotAll: () => Promise<number>;
  /** The server console; absent when this process doesn't run the server. */
  rcon?: (cmd: string) => Promise<string>;
  serverState: () => string;
  quota: () => QuotaStatus | null;
  dashboardUrl: string;
  /** Switches world mode (§16.3) in the config and server files; takes effect on restart. */
  setMode: (mode: 'test' | 'live', newWorld: boolean) => Promise<{ ok: boolean; message: string }>;
  stop: (why: string) => void;
  restart: (why: string) => void;
  now?: () => number;
}

/** §13 rule 9: op and chat spying only for the owner in config/world.yaml, never a bot. Null when the command may run. */
export function grantRefusal(cmd: string, owner?: string): string | null {
  const c = cmd.trim();
  const isOwner = (name: string | undefined) => Boolean(owner && name && name.toLowerCase() === owner.toLowerCase());
  // `op` anywhere in the command: on its own, namespaced, or after `execute … run`.
  for (const m of c.matchAll(/(?:^|\s)\/?(?:minecraft:)?op\s+(\S+)/gi)) {
    if (!isOwner(m[1])) return 'ctl gives op only to the owner in config/world.yaml (§13: never a bot)';
  }
  // Chat spying only as a permission set on the owner's own user, nobody else (no group, no other name).
  const spy = /^\/?lp\s+user\s+(\S+)\s+permission\s+set\s+pchat\.spy\b/i.exec(c);
  if (/pchat\.spy|\bpchat\s+spy\b/i.test(c) && !(spy && isOwner(spy[1]))) return 'ctl grants chat spying only to the owner (§13: never a bot)';
  return null;
}

export function controlHandler(d: ControlDeps): ControlHandler {
  const now = d.now ?? Date.now;
  const later = (f: () => void) => setTimeout(f, 200).unref();
  const needRcon = (): ControlResult | null => (d.rcon ? null : { ok: false, message: 'the server console is not available (started with --no-server?)' });
  return async (cmd, args): Promise<ControlResult> => {
    switch (cmd) {
      case 'status': {
        const online = d.online();
        return {
          ok: true,
          message: 'running',
          data: {
            mode: d.mode(),
            uptimeSec: Math.round((now() - d.startedAt) / 1000),
            target: d.supervisor.targetPopulation,
            living: d.supervisor.living.map((a) => ({ username: a.username, slot: a.slot, online: online.has(a.username), since: a.bornAt })),
            server: d.serverState(),
            quota: d.quota(),
            dashboard: d.dashboardUrl,
          },
        };
      }
      case 'stop':
        later(() => d.stop('ctl stop'));
        return { ok: true, message: 'stopping: every agent saves and leaves, then the server saves and stops' };
      case 'restart':
        later(() => d.restart('ctl restart'));
        return { ok: true, message: 'restarting: everyone saves first, then it comes back with the same agents' };
      case 'save': {
        let world = 'no server console';
        if (d.rcon) world = (await d.rcon('save-all flush')).trim() || 'saved';
        const n = await d.snapshotAll();
        return { ok: true, message: `world: ${world}; ${n} agent snapshot${n === 1 ? '' : 's'} written` };
      }
      case 'population': {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 0) return { ok: false, message: 'population needs a whole number' };
        d.supervisor.setPopulation(n);
        return { ok: true, message: `population target is now ${d.supervisor.targetPopulation}` };
      }
      case 'mode': {
        const m = args[0];
        if (m !== 'test' && m !== 'live') return { ok: false, message: 'mode is test or live' };
        const r = await d.setMode(m, args.includes('--new-world'));
        return r.ok ? { ok: true, message: `${r.message}. Run \`pnpm ctl restart\` to apply.` } : r;
      }
      case 'say': {
        const missing = needRcon();
        if (missing) return missing;
        const text = args.join(' ').replace(/[\r\n]+/g, ' ').trim();
        if (!text) return { ok: false, message: 'nothing to say' };
        await d.rcon?.(`say ${text.slice(0, 200)}`);
        return { ok: true, message: `said: ${text.slice(0, 200)}` };
      }
      case 'rcon': {
        const missing = needRcon();
        if (missing) return missing;
        const c = args.join(' ').trim();
        if (!c) return { ok: false, message: 'no command' };
        const refused = grantRefusal(c, d.owner);
        if (refused) return { ok: false, message: refused };
        const out = (await d.rcon?.(c)) ?? '';
        return { ok: true, message: out.trim() || '(no output)' };
      }
      default:
        return { ok: false, message: `unknown command ${cmd}` };
    }
  };
}
