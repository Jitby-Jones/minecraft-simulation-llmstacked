// M7 (§22.4, §23.3, §18.8): the dashboard against fakes and a real socket. The model builds per-agent views,
// the chat, the social matrix and the cost per hour from telemetry; the HTTP side serves only to localhost names,
// under a strict CSP, and lets `pnpm ctl` in with the token only; the control commands drive infrastructure and
// refuse to grant op or chat spying to anyone but the owner. The live exit test is tests/live/m7-dashboard.test.ts.

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HubConfigSchema, nullLogger } from '@agora/shared';
import type { QuotaStatus } from '@agora/llm';
import { Hub } from '@agora/hub';
import { controlHandler, grantRefusal } from '@agora/hub/dashboard/control';
import { DashboardModel } from '@agora/hub/dashboard/model';
import { DashboardServer, attachDashboard } from '@agora/hub/dashboard/server';
import { HubClient } from '@agora/agent/hub/client';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A GET with the Host header we choose (fetch won't send one of its own). */
function statusFor(base: string, pathname: string, host: string): Promise<number> {
  const u = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

const quota: QuotaStatus = { level: 0, codeOnly: false, reason: 'ok', resetAt: 1_000_000 + 48 * 3_600_000, weeklyPercent: 0.4, dailyPercent: null, remaining: 1_000_000, unknown: false, polledAt: 0 };

function model(t = { now: 1_000_000 }) {
  return { t, m: new DashboardModel({ mode: () => 'test', quota: () => quota, personas: () => [{ username: 'Pip', traits: ['generous'], sex: 'female', status: 'alive' }], now: () => t.now }) };
}

describe('the dashboard model', () => {
  it('shows what each agent is doing and why, what it said, and how it feels over time', () => {
    const { m, t } = model();
    m.online('Pip', 's0');
    m.telemetry('Pip', 'state', t.now, { health: 18, food: 20, goal: 'build a house', option: { option: 'work', skill: 'gather', args: { item: 'oak_log' } }, emotions: { fear: 0.2, anger: 0.6, arousal: 0.6 }, mood: 0.1, rungs: { Rex: 1 } });
    t.now += 5000;
    m.telemetry('Pip', 'state', t.now, { health: 17, emotions: { fear: 0.4, anger: 0.1, arousal: 0.4 } });
    m.telemetry('Pip', 'decision', t.now, { source: 'llm', option: 'work', task: { skill: 'gather' }, rationale: 'we need wood for the house' });
    m.telemetry('Pip', 'decision', t.now, { source: 'impulse', option: 'talk', rationale: 'snapped at Rex' });
    m.telemetry('Pip', 'skill', t.now, { skill: 'gather', ok: true, observed: '+4 oak_log' });
    m.telemetry('Pip', 'utterance', t.now, { text: 'hey Rex', volume: 'normal' });
    const o = m.overview() as { agents: { name: string; lastDecision: { rationale: string }; sources: Record<string, number>; fear: number[]; traits: string[]; online: boolean }[]; events: { what: string }[] };
    const pip = o.agents[0];
    expect(pip?.name).toBe('Pip');
    expect(pip?.online).toBe(true);
    expect(pip?.traits).toEqual(['generous']);
    expect(pip?.lastDecision.rationale).toBe('snapped at Rex');
    expect(pip?.sources).toEqual({ llm: 1, impulse: 1 });
    expect(pip?.fear).toEqual([0.2, 0.4]);
    expect(o.events.map((e) => e.what)).toEqual(['impulse', 'joined']);
    const d = m.agent('Pip') as { decisions: { rationale: string }[]; actions: { skill: string }[]; said: { text: string }[] };
    expect(d.decisions.map((x) => x.rationale)).toEqual(['snapped at Rex', 'we need wood for the house']);
    expect(d.actions[0]?.skill).toBe('gather');
    expect(m.chatSince(0).map((l) => `${String(l.agent)}: ${String(l.text)}`)).toEqual(['Pip: hey Rex']);
    expect(m.agent('Nobody')).toBeNull();
  });

  it('builds who-thinks-what-of-whom from each agent’s own view', () => {
    const { m, t } = model();
    m.online('Pip', 's0');
    m.online('Rex', 's1');
    m.telemetry('Pip', 'social', t.now, { people: [{ name: 'Rex', sentiment: 2, evidence: 3, trust: 0.2, admiration: 0, fear: 0.6, friction: 0.3, resentment: 0.7, rung: 2 }] });
    m.telemetry('Rex', 'social', t.now, { people: [{ name: 'Pip', sentiment: 7, evidence: 6, trust: 0.6, admiration: 0.4, fear: 0.1, friction: 0, resentment: 0, rung: 0 }] });
    const s = m.social();
    expect(s.names).toEqual(['Pip', 'Rex']);
    expect(s.cells.map((c) => `${c.from}>${c.to}:${c.sentiment}`)).toEqual(['Pip>Rex:2', 'Rex>Pip:7']);
  });

  it('shows the village (§6.8): each one’s role, how varied the roles are, and what people talk about', () => {
    const { m, t } = model();
    for (const [i, [name, role]] of [['Pip', 'woodcutter'], ['Rex', 'guard'], ['Ann', 'woodcutter'], ['Bo', null]].entries()) {
      m.online(name ?? '', `s${i}`);
      m.telemetry(name ?? '', 'state', t.now, { role, village: role ? [`work as a ${role}`] : [] });
    }
    for (const text of ['the zombies came again last night', 'we need more logs for the hut', 'zombies everywhere, stay inside', 'logs are in the chest']) m.telemetry('Pip', 'utterance', t.now, { text, volume: 'normal' });
    const o = m.overview() as { agents: { name: string; role: string | null; village: string[] }[]; society: { roles: Record<string, number>; entropy: number; keywords: [string, number][] } };
    expect(o.agents.find((a) => a.name === 'Rex')).toMatchObject({ role: 'guard', village: ['work as a guard'] });
    expect(o.society.roles).toEqual({ woodcutter: 2, guard: 1 });
    expect(o.society.entropy).toBeCloseTo(0.918, 3);
    expect(o.society.keywords.slice(0, 2)).toEqual([
      ['logs', 2],
      ['zombies', 2],
    ]);
    // Common words don't count; an hour later the chat has aged out of the counts.
    expect(o.society.keywords.map(([w]) => w)).not.toContain('there');
    t.now += 61 * 60_000;
    expect((m.overview() as { society: { keywords: unknown[] } }).society.keywords).toEqual([]);
    m.offline('Rex', 'left');
    expect((m.overview() as { society: { roles: Record<string, number> } }).society.roles).toEqual({ woodcutter: 2 });
  });

  it('shows power (§17.12): who follows whom, and the hour’s fights, kills, defections, uprisings and tribute', () => {
    const { m, t } = model();
    for (const [i, [name, leader]] of [['Rex', null], ['Bo', 'Rex'], ['Cy', 'Rex'], ['Di', 'Ann'], ['Ann', null]].entries()) {
      m.online(name ?? '', `s${i}`);
      m.telemetry(name ?? '', 'state', t.now, { leader });
    }
    m.telemetry('Bo', 'fight', t.now, { kind: 'follow', leader: 'Rex', before: null });
    m.telemetry('Rex', 'fight', t.now, { kind: 'duel', with: 'Ann', outcome: 'won', lethal: false });
    m.telemetry('Ann', 'fight', t.now, { kind: 'duel', with: 'Rex', outcome: 'yielded', lethal: false });
    m.telemetry('Rex', 'fight', t.now, { kind: 'duel', with: 'Di', outcome: 'gone', lethal: true });
    m.telemetry('Cy', 'fight', t.now, { kind: 'defect', from: 'Rex', attackers: ['Ann', 'Di'] });
    m.telemetry('Di', 'commitment', t.now, { debtor: 'Di', creditor: 'Ann', text: 'fight Rex together with Ann', kind: 'fight', status: 'accepted' });
    m.telemetry('Bo', 'commitment', t.now, { debtor: 'Bo', creditor: 'Rex', text: '3 bread', kind: 'give', status: 'fulfilled', coerced: true });
    m.died('Di', 'Di was slain by Rex');
    const o = m.overview() as { power: { leaders: { name: string; followers: string[] }[]; hour: Record<string, number> }; events: { what: string }[] };
    expect(o.power.leaders).toEqual([
      { name: 'Rex', followers: ['Bo', 'Cy'] },
    ]);
    expect(o.power.hour).toEqual({ brawls: 2, lethal: 1, yields: 1, kills: 1, defections: 1, uprisings: 1, coerced: 1 });
    expect(o.events.map((e) => e.what)).toEqual(expect.arrayContaining(['follows', 'defected', 'fight', 'died']));
    t.now += 61 * 60_000;
    expect((m.overview() as { power: { hour: Record<string, number> } }).power.hour.brawls).toBe(0);
  });

  it('shows couples (§19.2), each pair once', () => {
    const { m, t } = model();
    for (const [i, [name, partner]] of [['Ned', 'Ivy'], ['Ivy', 'Ned'], ['Bo', 'Cy'], ['Max', null]].entries()) {
      m.online(name ?? '', `s${i}`);
      m.telemetry(name ?? '', 'state', t.now, { partner });
    }
    expect((m.overview() as { couples: [string, string][] }).couples).toEqual([
      ['Bo', 'Cy'],
      ['Ivy', 'Ned'],
    ]);
  });

  it('counts tokens per hour by module, tier and agent, and projects when the weekly quota runs out', () => {
    const { m, t } = model();
    const cost = (agent: string, module: 'cc' | 'talking', tier: 'L1' | 'L2', input: number) => m.cost(agent, { t: 'cost', module, tier, model: 'm', inputTokens: input, outputTokens: 10, ms: 100, ok: true });
    t.now += 30 * 60_000; // half an hour in
    cost('Pip', 'cc', 'L2', 4000);
    cost('Pip', 'talking', 'L1', 1000);
    cost('Rex', 'cc', 'L2', 5000);
    const c = m.costView() as { lastHour: { input: number }; inputPerHour: number; byModule: Record<string, { input: number }>; byTier: Record<string, { input: number }>; byAgent: Record<string, { input: number }>; projection: { exhaustAt: number; beforeReset: boolean } };
    expect(c.lastHour.input).toBe(10_000);
    expect(c.inputPerHour).toBe(20_000); // 10k in half an hour
    expect(c.byModule.cc?.input).toBe(9000);
    expect(c.byTier.L1?.input).toBe(1000);
    expect(c.byAgent.Rex?.input).toBe(5000);
    // 1M left at 20k/h: 50 h, past the reset in 48 h.
    expect(c.projection.exhaustAt).toBe(t.now + 50 * 3_600_000);
    expect(c.projection.beforeReset).toBe(false);
    // An hour later those calls have aged out.
    t.now += 61 * 60_000;
    expect((m.costView() as { lastHour: { input: number } }).lastHour.input).toBe(0);
  });

  it('keeps deaths, departures and warnings for the operator', () => {
    const { m } = model();
    m.online('Pip', 's0');
    m.log('Pip', { t: 'log', level: 'warn', module: 'cc', msg: 'decision went stale' });
    m.log('Pip', { t: 'log', level: 'info', module: 'cc', msg: 'fine' });
    m.died('Pip', 'was slain by Zombie');
    const o = m.overview() as { problems: { msg: string }[]; events: { what: string; cause?: string }[]; agents: { died?: { cause: string } }[] };
    expect(o.problems.map((p) => p.msg)).toEqual(['decision went stale']);
    expect(o.events[0]).toMatchObject({ what: 'died', cause: 'was slain by Zombie' });
    expect(o.agents[0]?.died?.cause).toBe('was slain by Zombie');
  });
});

describe('the dashboard server', () => {
  async function serve(control?: ConstructorParameters<typeof DashboardServer>[0]['control']) {
    const { m, t } = model();
    m.online('Pip', 's0');
    m.telemetry('Pip', 'decision', t.now, { source: 'default', option: 'rest', rationale: 'code default: nothing to do' });
    const srv = new DashboardServer({ model: m, host: '127.0.0.1', port: 0, logger: nullLogger(), ...(control ? { control } : {}) });
    await srv.listen(0);
    cleanups.push(() => srv.close());
    const base = `http://127.0.0.1:${srv.port}`;
    return { m, base };
  }

  it('serves the page under a strict CSP, and the API as JSON', async () => {
    const { base } = await serve();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/default-src 'none'; script-src 'self'/);
    expect(await page.text()).toContain('<script src="/app.js" defer></script>');
    const js = await fetch(`${base}/app.js`);
    const code = await js.text();
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    // Compiled from TypeScript: no type syntax left, and it still draws the agents table.
    expect(code).not.toMatch(/\binterface\s+\w+\s*\{/);
    expect(code).toContain('/api/overview');
    expect((await fetch(`${base}/app.css`)).headers.get('content-type')).toMatch(/css/);
    const o = (await (await fetch(`${base}/api/overview`)).json()) as { agents: { name: string }[] };
    expect(o.agents.map((a) => a.name)).toEqual(['Pip']);
    const pip = (await (await fetch(`${base}/api/agents/Pip`)).json()) as { decisions: { rationale: string }[] };
    expect(pip.decisions[0]?.rationale).toBe('code default: nothing to do');
    expect((await fetch(`${base}/api/agents/Nobody`)).status).toBe(404);
    expect((await fetch(`${base}/api/agents/${encodeURIComponent('<script>')}`)).status).toBe(400);
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(204);
  });

  it('answers only to its own host names (no reads through DNS rebinding)', async () => {
    const { base } = await serve();
    expect(await statusFor(base, '/api/overview', 'evil.example')).toBe(421);
    expect(await statusFor(base, '/', 'evil.example:80')).toBe(421);
    expect(await statusFor(base, '/api/overview', 'localhost:8080')).toBe(200);
    expect(await statusFor(base, '/api/overview', '[::1]:8080')).toBe(200);
  });

  it('lets ctl in with the token only, as JSON, within a size limit', async () => {
    const seen: string[] = [];
    const { base } = await serve({ token: 'sekret-token', handle: async (cmd, args) => (seen.push(`${cmd} ${args.join(' ')}`), { ok: true, message: `did ${cmd}` }) });
    const post = (body: string, headers: Record<string, string>) => fetch(`${base}/api/ctl`, { method: 'POST', body, headers });
    expect((await post('{"cmd":"status"}', { 'Content-Type': 'application/json' })).status).toBe(401);
    expect((await post('{"cmd":"status"}', { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post('cmd=status', { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer sekret-token' })).status).toBe(415);
    expect((await post('{"cmd":1}', { 'Content-Type': 'application/json', Authorization: 'Bearer sekret-token' })).status).toBe(400);
    expect((await post(JSON.stringify({ cmd: 'say', args: ['x'.repeat(70_000)] }), { 'Content-Type': 'application/json', Authorization: 'Bearer sekret-token' })).status).toBe(413);
    const ok = await post(JSON.stringify({ cmd: 'population', args: ['3'] }), { 'Content-Type': 'application/json', Authorization: 'Bearer sekret-token' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, message: 'did population' });
    expect(seen).toEqual(['population 3']);
    // Without a control handler the endpoint doesn't exist.
    const plain = await serve();
    expect((await fetch(`${plain.base}/api/ctl`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' } })).status).toBe(404);
  });
});

describe('control commands (§23.3)', () => {
  function deps() {
    const calls: string[] = [];
    let target = 2;
    const d: Parameters<typeof controlHandler>[0] = {
      mode: () => 'test',
      owner: 'Owner',
      startedAt: 0,
      supervisor: {
        living: [
          { username: 'Pip', slot: 's0', bornAt: 1 },
          { username: 'Rex', slot: 's1', bornAt: 2 },
        ],
        get targetPopulation() {
          return target;
        },
        setPopulation: (n: number) => {
          target = Math.min(5, n);
          calls.push(`population ${n}`);
        },
      },
      online: () => new Set(['Pip']),
      snapshotAll: async () => (calls.push('snapshots'), 2),
      rcon: async (c: string) => (calls.push(`rcon ${c}`), c.startsWith('save-all') ? 'Saved the game' : 'ok'),
      serverState: () => 'running',
      quota: () => quota,
      dashboardUrl: 'http://127.0.0.1:8080',
      setMode: async (m: string, nw: boolean) => (calls.push(`mode ${m}${nw ? ' new' : ''}`), { ok: true, message: `mode set to ${m}` }),
      stop: (why: string) => void calls.push(`stop ${why}`),
      restart: (why: string) => void calls.push(`restart ${why}`),
      now: () => 60_000,
    };
    return { d, calls, h: controlHandler(d) };
  }

  it('reports status, sets the population, saves everything, and switches mode for the next start', async () => {
    const { h, calls } = deps();
    const st = await h('status', []);
    expect(st.data).toMatchObject({ mode: 'test', uptimeSec: 60, target: 2, server: 'running', living: [{ username: 'Pip', online: true }, { username: 'Rex', online: false }] });
    expect((await h('population', ['9'])).message).toBe('population target is now 5');
    expect((await h('population', ['-1'])).ok).toBe(false);
    expect((await h('save', [])).message).toBe('world: Saved the game; 2 agent snapshots written');
    expect((await h('mode', ['live', '--new-world'])).message).toMatch(/mode set to live\. Run `pnpm ctl restart`/);
    expect((await h('mode', ['hard'])).ok).toBe(false);
    // A refused population (-1) never reaches the supervisor.
    expect(calls).toEqual(['population 9', 'rcon save-all flush', 'snapshots', 'mode live new']);
  });

  it('says things in-world and runs console commands, but never makes a bot an operator or a chat spy', async () => {
    const { h, calls } = deps();
    expect((await h('say', ['server restarts', 'in 5 minutes'])).message).toBe('said: server restarts in 5 minutes');
    expect((await h('rcon', ['list'])).message).toBe('ok');
    expect((await h('rcon', ['op', 'Pip'])).ok).toBe(false);
    expect((await h('rcon', ['op', 'Owner'])).ok).toBe(true);
    expect((await h('rcon', ['lp user Pip permission set pchat.spy true'])).ok).toBe(false);
    expect((await h('rcon', ['lp user Owner permission set pchat.spy true'])).ok).toBe(true);
    expect(calls).toEqual(['rcon say server restarts in 5 minutes', 'rcon list', 'rcon op Owner', 'rcon lp user Owner permission set pchat.spy true']);
    expect(grantRefusal('/OP pip', 'Owner')).toMatch(/only to the owner/);
    expect(grantRefusal('deop Pip', 'Owner')).toBeNull();
    expect(grantRefusal('op Pip')).toMatch(/only to the owner/);
    // However it is wrapped.
    expect(grantRefusal('execute as Owner run op Pip', 'Owner')).toMatch(/only to the owner/);
    expect(grantRefusal('minecraft:op Pip', 'Owner')).toMatch(/only to the owner/);
    expect(grantRefusal('execute run op Owner', 'Owner')).toBeNull();
    expect(grantRefusal('lp user Pip permission set pchat.spy true Owner', 'Owner')).toMatch(/chat spying only to the owner/);
    expect(grantRefusal('lp group default permission set pchat.spy true', 'Owner')).toMatch(/chat spying only to the owner/);
    expect(grantRefusal('lp user owner permission set pchat.spy true', 'Owner')).toBeNull();
  });

  it('stops and restarts after answering', async () => {
    const { h, calls } = deps();
    expect((await h('stop', [])).ok).toBe(true);
    expect((await h('restart', [])).ok).toBe(true);
    expect(calls).toEqual([]);
    await wait(300);
    expect(calls).toEqual(['stop ctl stop', 'restart ctl restart']);
    expect((await h('fly', [])).ok).toBe(false);
  });
});

describe('the dashboard fed by the Hub', () => {
  it('turns bots’ telemetry, cost reports and lifecycle into the model, and nothing goes back', async () => {
    const hub = new Hub({ config: HubConfigSchema.parse({ hub: { host: '127.0.0.1', port: 8765 } }), logger: nullLogger(), embedder: null, quota: () => null, runtimeHoursPerWeek: 30 });
    await hub.listen(0);
    cleanups.push(() => hub.close());
    const { m } = model({ now: Date.now() });
    cleanups.push(attachDashboard(hub, m));
    hub.on('hello', (s) => s.send({ t: 'assign', persona: { id: 'pip', name: 'Pip', sex: 'female', traits: ['kind'] } as never, username: 'Pip', resume: false, giveStarterKit: false }));
    const c = new HubClient({ url: `ws://127.0.0.1:${hub.port}`, slot: 's0', logger: nullLogger(), requestTimeoutMs: 2000 });
    const got: string[] = [];
    c.connect();
    cleanups.push(() => c.close());
    await c.assigned();
    c.send({ t: 'ready', username: 'Pip' });
    c.send({ t: 'telemetry', kind: 'decision', ts: Date.now(), data: { source: 'llm', option: 'explore', rationale: 'looking for iron' } });
    c.send({ t: 'cost', module: 'cc', tier: 'L2', model: 'm', inputTokens: 1234, outputTokens: 56, ms: 300, ok: true });
    for (let i = 0; i < 50 && (m.agent('Pip') as { decisions?: unknown[] } | null)?.decisions?.length !== 1; i++) await wait(20);
    expect((m.agent('Pip') as { decisions: { rationale: string }[]; online: boolean }).decisions[0]?.rationale).toBe('looking for iron');
    expect((m.costView() as { byAgent: Record<string, { input: number }> }).byAgent.Pip?.input).toBe(1234);
    c.close();
    for (let i = 0; i < 50 && (m.agent('Pip') as { online: boolean }).online; i++) await wait(20);
    expect((m.agent('Pip') as { online: boolean }).online).toBe(false);
    expect(got).toEqual([]);
  });
});
