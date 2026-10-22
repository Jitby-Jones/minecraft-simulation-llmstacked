// The `pnpm ctl` end of the control endpoint (§23.3): the dashboard's POST /api/ctl on this machine, with the RCON
// password from .env as the bearer token. Null means nothing is listening (the system is not running).

import { loadEnv, loadHubConfig } from '@agora/shared';

export interface CtlResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

function refused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(cause?.code ?? '');
}

export async function ctlRequest(cmd: string, args: string[] = [], timeoutMs = 60_000): Promise<CtlResult | null> {
  loadEnv();
  const cfg = loadHubConfig().dashboard;
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}/api/ctl`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RCON_PASSWORD ?? ''}` },
      body: JSON.stringify({ cmd, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await r.json()) as CtlResult;
  } catch (err) {
    if (refused(err)) return null;
    throw err;
  }
}

/** What the operator sees for `status`. */
export function formatStatus(r: CtlResult): string {
  const d = (r.data ?? {}) as {
    mode?: string;
    uptimeSec?: number;
    target?: number;
    living?: { username: string; slot: string; online: boolean; since: number }[];
    server?: string;
    quota?: { level: number; codeOnly: boolean; weeklyPercent: number | null } | null;
    dashboard?: string;
  };
  const lines = [
    `mode ${d.mode ?? '?'}, up ${Math.round((d.uptimeSec ?? 0) / 60)} min, server ${d.server ?? '?'}`,
    `population ${d.living?.length ?? 0} of ${d.target ?? '?'}`,
    ...(d.living ?? []).map((a) => `  ${a.online ? '●' : '○'} ${a.username} (${a.slot})`),
    d.quota ? `quota: level ${d.quota.level}${d.quota.codeOnly ? ', code-only' : ''}${d.quota.weeklyPercent === null ? '' : `, ${Math.round(d.quota.weeklyPercent * 100)}% of the week used`}` : 'quota: no key (code-only)',
    ...(d.dashboard ? [`dashboard ${d.dashboard}`] : []),
  ];
  return lines.join('\n');
}
