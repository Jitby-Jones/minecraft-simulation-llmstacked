// What `pnpm ctl` can do to the running system (§23.3): status, stop, restart, save, population, mode, say, rcon.
// The handler only drives infrastructure (the supervisor, the server console, the Hub's snapshot request); it never
// tells a bot anything about the world. `say` is an ordinary server message every player in range of chat sees.

import { LLM_MODULES, type LlmModule, type Sex, TUNABLE_MODULES, type TierName, type TunableModule } from '@agora/shared';
import type { QuotaStatus } from '@agora/llm';
import type { TuningStore } from '../hub/tuning';
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
  /** Debug controls; without them, the debug commands are refused. */
  debug?: DebugDeps;
  now?: () => number;
}

/** What the debug commands drive: the agents (through the Hub), the operator's settings, and the supervisor. */
export interface DebugDeps {
  /** A debug request to one agent (inspect, memory, goal, plan, decide, do, …). */
  request: (username: string, op: string, args: Record<string, unknown>) => Promise<ControlResult>;
  tuning: TuningStore;
  /** Sends the current settings to everyone, or to one agent. */
  sendTuning: (scope: string) => void;
  addAgent: (o: { persona?: string; name?: string; sex?: Sex }) => Promise<{ username: string } | string>;
  retireAgent: (username: string) => string | null;
  restartAgent: (username: string) => string | null;
  /** The persona pool (personas/*.yaml). */
  personas: () => { id: string; name: string; sex: string; traits: string[] }[];
  /** The subscription models (§22.3), for choosing one; null without a key. */
  models: () => Promise<{ id: string; capabilities: string[]; thinking: boolean }[] | null>;
}

/** `key=value` pairs, or one JSON object, as a debug request's arguments. */
export function debugArgs(parts: readonly string[]): Record<string, unknown> {
  const joined = parts.join(' ').trim();
  if (joined.startsWith('{')) {
    try {
      const v = JSON.parse(joined) as unknown;
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const out: Record<string, unknown> = {};
  let rest: string[] = [];
  for (const p of parts) {
    const m = /^([A-Za-z][\w.]*)=(.*)$/s.exec(p);
    if (m?.[1]) {
      rest = [];
      out[m[1]] = m[2] ?? '';
      continue;
    }
    // A word after key=value belongs to it ("text=Mira hid iron" given unquoted).
    const keys = Object.keys(out);
    const last = keys.at(-1);
    if (last && typeof out[last] === 'string') out[last] = `${String(out[last])} ${p}`;
    else rest.push(p);
  }
  if (rest.length > 0 && !('text' in out)) out.text = rest.join(' ');
  return out;
}

const TIER_RE = /^L[123]$/;

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
      case 'mode':
      case 'test-mode': {
        // `test-mode on|off` says the same as `mode test|live` (§16.3): off is live, hardcore.
        const m = cmd === 'mode' ? args[0] : args[0] === 'on' ? 'test' : args[0] === 'off' ? 'live' : undefined;
        if (m !== 'test' && m !== 'live') return { ok: false, message: cmd === 'mode' ? 'mode is test or live' : 'test-mode is on or off' };
        const r = await d.setMode(m, args.includes('--new-world'));
        if (!r.ok) return /--new-world/.test(r.message) ? { ok: false, message: `${r.message} (a fresh world for it; the old one stays in its folder)` } : r;
        return { ok: true, message: `test mode ${m === 'test' ? 'on' : 'off'}: ${r.message}. Run \`pnpm ctl restart\` to apply.` };
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
      default: {
        const dbg = d.debug;
        if (!dbg || !DEBUG_COMMANDS.has(cmd)) return { ok: false, message: `unknown command ${cmd}` };
        return debugCommand(dbg, d, cmd, args);
      }
    }
  };
}

const DEBUG_COMMANDS: ReadonlySet<string> = new Set(['agents', 'personas', 'models', 'add', 'remove', 'kill', 'restart-agent', 'agent', 'module', 'model', 'tier', 'pause', 'resume', 'tuning']);

/** The debug commands (the dashboard's controls and `pnpm ctl`): the operator's hands on the agents. */
async function debugCommand(dbg: DebugDeps, d: ControlDeps, cmd: string, args: string[]): Promise<ControlResult> {
  const living = () => d.supervisor.living.map((a) => a.username);
  const scopeOf = (who: string | undefined): string | ControlResult => {
    if (!who) return { ok: false, message: 'name an agent, or all' };
    if (who === 'all') return 'all';
    const name = living().find((n) => n.toLowerCase() === who.toLowerCase());
    return name ?? { ok: false, message: `no living agent ${who}` };
  };
  switch (cmd) {
    case 'agents': {
      const online = d.online();
      const rows = d.supervisor.living.map((a) => ({ username: a.username, slot: a.slot, online: online.has(a.username), since: a.bornAt, tuning: dbg.tuning.for(a.username) }));
      return { ok: true, message: rows.map((r) => `${r.online ? '●' : '○'} ${r.username}${r.tuning.paused ? ' (paused)' : ''}${r.tuning.off.length > 0 ? ` off: ${r.tuning.off.join(', ')}` : ''}`).join('\n') || 'no agents', data: rows };
    }
    case 'personas': {
      const ps = dbg.personas();
      return { ok: true, message: ps.map((p) => `${p.id} (${p.name}, ${p.sex}): ${p.traits.join(', ')}`).join('\n') || 'the pool is empty', data: ps };
    }
    case 'models': {
      const ms = await dbg.models();
      if (!ms) return { ok: false, message: 'no NanoGPT key: no models to choose from' };
      const filter = args[0]?.toLowerCase();
      const shown = filter ? ms.filter((m) => m.id.toLowerCase().includes(filter)) : ms;
      return { ok: true, message: `${shown.length} subscription models${filter ? ` matching "${filter}"` : ''}:\n${shown.slice(0, 80).map((m) => `${m.id}${m.thinking ? ' (thinking)' : ''}${m.capabilities.length > 0 ? ` [${m.capabilities.join(', ')}]` : ''}`).join('\n')}`, data: shown };
    }
    case 'add': {
      const o: { persona?: string; name?: string; sex?: Sex } = {};
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[i + 1];
        if (a === '--persona' && v) {
          o.persona = v;
          i++;
        } else if (a === '--name' && v) {
          o.name = v;
          i++;
        } else if (a === '--sex' && (v === 'male' || v === 'female')) {
          o.sex = v;
          i++;
        } else if (a && !a.startsWith('--') && !o.persona) o.persona = a;
      }
      const r = await dbg.addAgent(o);
      return typeof r === 'string' ? { ok: false, message: r } : { ok: true, message: `added ${r.username}; joining now` };
    }
    case 'remove':
    case 'restart-agent': {
      const who = scopeOf(args[0]);
      if (typeof who !== 'string' || who === 'all') return typeof who === 'string' ? { ok: false, message: 'name one agent' } : who;
      const why = cmd === 'remove' ? dbg.retireAgent(who) : dbg.restartAgent(who);
      return why ? { ok: false, message: why } : { ok: true, message: cmd === 'remove' ? `${who} is leaving for good (the population is one smaller)` : `${who} is restarting` };
    }
    case 'kill': {
      const who = scopeOf(args[0]);
      if (typeof who !== 'string' || who === 'all') return typeof who === 'string' ? { ok: false, message: 'name one agent' } : who;
      if (!d.rcon) return { ok: false, message: 'the server console is not available (started with --no-server?)' };
      const out = await d.rcon(`kill ${who}`);
      return { ok: true, message: `${who}: ${out.trim() || 'killed'} (a death like any other: replaced as the population needs)` };
    }
    case 'agent': {
      const [who, op, ...rest] = args;
      const name = scopeOf(who);
      if (typeof name !== 'string' || name === 'all') return typeof name === 'string' ? { ok: false, message: 'name one agent' } : name;
      if (!op) return { ok: false, message: 'agent <name> <inspect|memory.list|memory.add|memory.edit|memory.delete|goal|plan|replan|plan.clear|decide|do|abort|say|set> [args]' };
      return dbg.request(name, op, debugArgs(rest));
    }
    case 'module': {
      const [who, mod, onOff] = args;
      const scope = scopeOf(who);
      if (typeof scope !== 'string') return scope;
      if (!mod || !(TUNABLE_MODULES as readonly string[]).includes(mod) || (onOff !== 'on' && onOff !== 'off')) return { ok: false, message: `module <name|all> <${TUNABLE_MODULES.join('|')}> on|off` };
      dbg.tuning.setModule(scope, mod as TunableModule, onOff === 'on');
      dbg.sendTuning(scope);
      return { ok: true, message: `${mod} ${onOff} for ${scope === 'all' ? 'everyone' : scope}` };
    }
    case 'model': {
      const [who, tier, model] = args;
      const scope = scopeOf(who);
      if (typeof scope !== 'string') return scope;
      if (!tier || !TIER_RE.test(tier) || !model) return { ok: false, message: 'model <name|all> <L1|L2|L3> <model-id|auto>' };
      if (model !== 'auto') {
        const ms = await dbg.models();
        if (!ms) return { ok: false, message: 'no NanoGPT key: no models to choose from' };
        if (!ms.some((m) => m.id === model)) return { ok: false, message: `${model} is not a subscription model (see \`pnpm ctl models\`)` };
      }
      dbg.tuning.setModel(scope, tier as TierName, model === 'auto' ? null : model);
      dbg.sendTuning(scope);
      return { ok: true, message: `${tier} ${model === 'auto' ? 'back to the automatic choice' : `tries ${model} first`} for ${scope === 'all' ? 'everyone' : scope}` };
    }
    case 'tier': {
      const [who, mod, tier] = args;
      const scope = scopeOf(who);
      if (typeof scope !== 'string') return scope;
      if (!mod || !(LLM_MODULES as readonly string[]).includes(mod) || !tier || (tier !== 'auto' && !TIER_RE.test(tier))) return { ok: false, message: `tier <name|all> <${LLM_MODULES.join('|')}> <L1|L2|L3|auto>` };
      dbg.tuning.setTier(scope, mod as LlmModule, tier === 'auto' ? null : (tier as TierName));
      dbg.sendTuning(scope);
      return { ok: true, message: `${mod} uses ${tier === 'auto' ? 'its own tier' : tier} for ${scope === 'all' ? 'everyone' : scope}` };
    }
    case 'pause':
    case 'resume': {
      const scope = scopeOf(args[0]);
      if (typeof scope !== 'string') return scope;
      dbg.tuning.setPaused(scope, cmd === 'pause');
      dbg.sendTuning(scope);
      return { ok: true, message: `${scope === 'all' ? 'everyone' : scope} ${cmd === 'pause' ? 'paused (the reflexes still keep them alive)' : 'going on'}` };
    }
    case 'tuning': {
      if (args[0] === 'reset') {
        const scope = scopeOf(args[1] ?? 'all');
        if (typeof scope !== 'string') return scope;
        dbg.tuning.reset(scope);
        dbg.sendTuning(scope);
        return { ok: true, message: `settings reset for ${scope === 'all' ? 'everyone' : scope}` };
      }
      const scope = args[0] ? scopeOf(args[0]) : 'all';
      if (typeof scope !== 'string') return scope;
      const snap = dbg.tuning.snapshot();
      return { ok: true, message: JSON.stringify(scope === 'all' ? snap : dbg.tuning.for(scope)), data: scope === 'all' ? snap : dbg.tuning.for(scope) };
    }
    default:
      return { ok: false, message: `unknown command ${cmd}` };
  }
}
