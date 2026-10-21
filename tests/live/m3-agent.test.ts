// M3 exit test (§10): one agent pursues "get stone tools" on its own, talks, and never promises what the CC didn't
// approve. This environment has no NanoGPT key, so the model is played two ways:
//   1. code-only (the §22.4 code default brain), and
//   2. a scripted stand-in model served through the real LLM stack (guarded fetch, allowlist, tiers, zod), which
//      checks the PIANO plumbing end to end: packet → decision → executor → awareness → new decision, and Talking's
//      guard (the stand-in deliberately tries to promise).
// The quality of real model decisions is for the owner to judge with a key (`pnpm agent --persona pip --goal …`).

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Logger, ModelsConfigSchema, type Persona, WorldConfigSchema, createLogger, loadPersonaPool, loadVersionsConfig, parseProximityLine, sleep } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { countItem } from '@agora/agent/body/inventory';
import { PROMISE_RE } from '@agora/agent/modules/talking';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const world = WorldConfigSchema.parse({});
const Y = -60;
const pool = loadPersonaPool();
const persona = (id: string): Persona => {
  const p = pool.find((x) => x.id === id);
  if (!p) throw new Error(`persona ${id} missing`);
  return p;
};

/** A stand-in model with plausible, deterministic behavior. */
function scriptedBrain(fake: FakeNanoGpt): void {
  fake.chat = ({ body }) => {
    const messages = body.messages as { role: string; content: string }[];
    const system = messages[0]?.content ?? '';
    const user = messages.at(-1)?.content ?? '';
    const schema = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
    if (schema === 'summary') return { text: JSON.stringify({ summary: 'I am making stone tools.' }) };
    if (schema === 'decision') {
      const doing = /Doing now: work obtain (\{[^}]*\})/.exec(user)?.[1];
      if (/asked you something/.test(user)) {
        const task = doing ? { skill: 'obtain', args: JSON.parse(doing) as Record<string, unknown> } : { skill: 'wait', args: { seconds: 5 } };
        return {
          text: JSON.stringify({
            option: 'work',
            task,
            target: { agent: 'Bram' },
            speechIntent: { stance: 'decline', gist: "busy making tools, can't spare logs now", mayCommit: false },
            terminate: { maxSeconds: 600 },
            rationale: 'my tools come first',
          }),
        };
      }
      if (/Current goal: none set/.test(user)) return { text: JSON.stringify({ option: 'rest', terminate: { maxSeconds: 30 }, rationale: 'nothing to do' }) };
      const lastObtain = [...user.matchAll(/obtain \{"item":"([a-z_]+)"[^}]*\}: (ok|FAILED)[^\n]*/g)].at(-1);
      const needFirst = lastObtain?.[2] === 'FAILED' ? /get ([a-z_]+) first/.exec(lastObtain[0])?.[1] : undefined;
      const item = needFirst ?? 'stone_pickaxe';
      return { text: JSON.stringify({ option: 'work', task: { skill: 'obtain', args: { item, qty: 1 } }, terminate: { maxSeconds: 600 }, rationale: `need ${item}` }) };
    }
    // Talking: first try to promise (the guard must catch it), then comply with the stricter instruction.
    if (/You may agree/.test(system)) return { text: 'sure, deal!' };
    if (/IMPORTANT: your last draft/.test(system)) return { text: "hmm, I'm busy with my tools right now" };
    return { text: "Sure, I'll bring you 8 logs right away!" };
  };
}

describe.skipIf(!liveJavaPath())('M3 live: a single agent', () => {
  let server: LiveServer;
  let logger: Logger;

  async function scene(x: number, z: number): Promise<void> {
    await server.cmd(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    for (const [dx, dz] of [
      [8, 6],
      [10, -6],
      [-9, 8],
    ] as const) {
      await server.cmd(`place feature minecraft:oak ${x + dx} ${Y} ${z + dz}`);
    }
    await server.cmd(`fill ${x - 7} ${Y - 2} ${z - 3} ${x - 3} ${Y - 1} ${z - 1} minecraft:stone`);
  }

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm3', port: 25569, rconPort: 25579 });
    logger = createLogger({ name: 'm3-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    await server.cmd('gamerule advance_time false');
    await server.cmd('gamerule advance_weather false');
    await server.cmd('weather clear');
    await server.cmd('time set 1000');
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('code-only: works its way up to a stone pickaxe on its own', async () => {
    await scene(0, 0);
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Mira', version: versions.minecraft.version, logger });
    await server.cmd(`tp Mira 0 ${Y} 0`);
    await sleep(1500);
    const agent = new Agent({ body, persona: persona('mira'), username: 'Mira', llm: null, logger, world, goalGen: false });
    const decisions: string[] = [];
    agent.bus.on('decision', (e) => decisions.push(`${e.decision.source}:${e.decision.task?.skill ?? e.decision.option} ${JSON.stringify(e.decision.task?.args ?? {})}`));
    agent.start();
    agent.setGoal('get stone tools', 'inventoryHas:stone_pickaxe>=1');
    try {
      await waitFor(() => agent.store.state.goals.history.some((g) => g.text === 'get stone tools' && g.status === 'done'), 300_000, 'goal done', 1000);
    } finally {
      console.log(`[m3 code-only] ${decisions.join(' | ')}`);
      console.log(`[m3 code-only] actions: ${agent.store.state.actionLog.map((a) => `${a.skill}:${a.ok ? 'ok' : `FAIL(${a.error})`}`).join(', ')}`);
      await agent.stop();
      await body.disconnect();
    }
    expect(countItem(body.bot, 'stone_pickaxe')).toBeGreaterThanOrEqual(1);
    expect(decisions.every((d) => d.startsWith('default:'))).toBe(true);
  }, 360_000);

  it('with a model: pursues the goal step by step, answers a request and never promises without mayCommit', async () => {
    await scene(300, 0);
    const fake = new FakeNanoGpt(standardModels());
    scriptedBrain(fake);
    const rt = await startLlm({
      apiKey: 'scripted',
      config: ModelsConfigSchema.parse({}),
      logger,
      fetch: fake.fetch,
      background: false,
      limiter: new LocalRateLimiter({ rps: 50 }),
    });
    const body = await Body.connect({ host: server.host, port: server.port, username: 'Tobin', version: versions.minecraft.version, logger });
    const bram = await Body.connect({ host: server.host, port: server.port, username: 'Bram', version: versions.minecraft.version, logger });
    await server.cmd(`tp Tobin 300 ${Y} 0`);
    await server.cmd(`tp Bram 303 ${Y} 0`);
    await sleep(1500);
    const tobinSaid: string[] = [];
    bram.bot.on('messagestr', (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech' && p.speaker === 'Tobin') tobinSaid.push(p.text);
    });
    const agent = new Agent({ body, persona: persona('tobin'), username: 'Tobin', llm: rt.client, logger, world, goalGen: false });
    const actions: { skill: string; ok: boolean; error?: string }[] = [];
    agent.bus.on('actionRecorded', (e) => actions.push({ skill: e.record.skill, ok: e.record.ok, error: e.record.error }));
    const decisions: { source: string; skill?: string; item?: unknown; stance?: string; mayCommit?: boolean; rationale: string }[] = [];
    agent.bus.on('decision', (e) =>
      decisions.push({
        source: e.decision.source,
        skill: e.decision.task?.skill,
        item: e.decision.task?.args.item,
        stance: e.decision.speechIntent?.stance,
        mayCommit: e.decision.speechIntent?.mayCommit,
        rationale: e.decision.rationale,
      }),
    );
    agent.start();
    agent.setGoal('get stone tools', 'inventoryHas:stone_pickaxe>=1');
    try {
      await waitFor(() => decisions.length > 0, 30_000, 'first decision');
      await sleep(4000);
      await server.cmd('tp Bram Tobin');
      await sleep(1000);
      await bram.say('Tobin, can you give me 8 logs?');
      await waitFor(() => tobinSaid.length > 0, 30_000, 'a reply to Bram', 250);
      await waitFor(() => agent.store.state.goals.history.some((g) => g.text === 'get stone tools' && g.status === 'done'), 300_000, 'goal done', 1000);
    } finally {
      console.log(`[m3 model] decisions: ${decisions.map((d) => `${d.source}:${d.skill ?? ''}(${JSON.stringify(d.item ?? '')})${d.stance ? ` ${d.stance}/${String(d.mayCommit)}` : ''}`).join(' | ')}`);
      console.log(`[m3 model] Tobin said: ${tobinSaid.join(' | ')}`);
      console.log(`[m3 model] actions: ${agent.store.state.actionLog.map((a) => `${a.skill}(${JSON.stringify(a.args.item ?? '')}):${a.ok ? 'ok' : `FAIL(${a.error})`}`).join(', ')}`);
      await agent.stop();
      await body.disconnect();
      await bram.disconnect();
      rt.stop();
    }
    expect(countItem(body.bot, 'stone_pickaxe')).toBeGreaterThanOrEqual(1);
    // Real decisions through the LLM path, each with a rationale.
    expect(decisions.filter((d) => d.source === 'llm').length).toBeGreaterThanOrEqual(2);
    expect(decisions.every((d) => d.rationale.length > 0)).toBe(true);
    // A low-intelligence planner can't plan stone tools in one go: it was told what to get first.
    expect(actions.some((a) => a.skill === 'obtain' && !a.ok && /first/.test(a.error ?? ''))).toBe(true);
    // The request was answered without a promise, and the CC was asked to decide on it.
    expect(decisions.some((d) => d.stance === 'decline' && d.mayCommit === false)).toBe(true);
    expect(tobinSaid.length).toBeGreaterThan(0);
    expect(tobinSaid.some((t) => PROMISE_RE.test(t))).toBe(false);
  }, 420_000);
});
