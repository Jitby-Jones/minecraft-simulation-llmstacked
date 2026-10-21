// server.properties generation (§15.4, §16.3, §23.3). Unknown existing keys are preserved.

import type { WorldConfig } from '@agora/shared';

export type Mode = WorldConfig['mode'];

export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
    const idx = line.search(/[=:]/);
    if (idx < 0) continue;
    out.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return out;
}

export function renderProperties(props: ReadonlyMap<string, string>, header: string): string {
  const lines = [`#${header}`];
  for (const [k, v] of [...props.entries()].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${k}=${v}`);
  return `${lines.join('\n')}\n`;
}

export interface ServerPropsInput {
  world: WorldConfig;
  mode: Mode;
  levelName: string;
  rconPassword: string;
}

/**
 * The properties agora owns. Everything else in an existing file is left alone. 26.1 dropped the `pvp`,
 * `spawn-monsters`, `enable-command-block` and `allow-nether` properties; the first three are gamerules now
 * (STARTUP_GAMERULES in managed.ts).
 */
export function managedProperties(input: ServerPropsInput): Map<string, string> {
  const { world, mode } = input;
  const s = world.server;
  const maxPlayers = world.population.maxAlive + s.extraPlayerSlots;
  return new Map<string, string>([
    // bots use offline accounts; humans join with a vanilla client
    ['online-mode', 'false'],
    // avoid signed-chat issues with plugin-rebroadcast chat
    ['enforce-secure-profile', 'false'],
    ['spawn-protection', '0'],
    ['max-players', String(maxPlayers)],
    ['difficulty', 'hard'],
    ['hardcore', mode === 'live' ? 'true' : 'false'],
    ['gamemode', 'survival'],
    ['force-gamemode', 'true'],
    ['server-ip', s.host],
    ['server-port', String(s.port)],
    ['enable-rcon', 'true'],
    ['rcon.port', String(s.rconPort)],
    ['rcon.password', input.rconPassword],
    ['broadcast-rcon-to-ops', 'false'],
    ['enable-query', 'false'],
    ['level-name', input.levelName],
    ['level-seed', s.seed],
    ['view-distance', String(s.viewDistance)],
    ['simulation-distance', String(s.simulationDistance)],
    ['motd', s.motd],
    // mineflayer's physics occasionally trips the fly check; vanilla survival clients cannot fly anyway
    ['allow-flight', 'true'],
    ['white-list', 'false'],
    ['enforce-whitelist', 'false'],
  ]);
}

export function buildServerProperties(existingText: string | null, input: ServerPropsInput): string {
  const props = existingText ? parseProperties(existingText) : new Map<string, string>();
  for (const [k, v] of managedProperties(input)) props.set(k, v);
  return renderProperties(props, `Managed by agora scripts/server-mode.ts (${input.mode} mode). Edit config/world.yaml.`);
}

/** §23.3: warn if the server would be reachable from outside localhost/VPN. */
export function bindingWarning(serverIp: string): string | null {
  const ip = serverIp.trim();
  if (ip === '' || ip === '0.0.0.0' || ip === '::') {
    return `server-ip is "${ip || '(empty)'}": Minecraft listens on every interface. With online-mode=false anyone who can reach the port can join under any name. Use 127.0.0.1 plus an SSH tunnel, or a VPN address.`;
  }
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1') return null;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) return null;
  return `server-ip ${ip} looks like a public address. Never expose offline-mode Minecraft to the internet (§23.3).`;
}
