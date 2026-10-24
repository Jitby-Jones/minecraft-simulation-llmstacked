// One bot process under the Hub (§3): connect to the Hub, learn who it is this life (assign), join the server and run
// the agent. Shutdown (§23.4): flush memory, write the state snapshot, disconnect, say bye. Death (§16.3): the life
// ends there in either mode. The agent stops every activity at once (Agent.die: no respawn, nothing more said or
// done, no model call); then the bot reports `died` and exits, and the supervisor archives its memory and replaces it.

import path from 'node:path';
import {
  type DataPaths,
  type Logger,
  type ModelsConfig,
  type VersionsConfig,
  type WorldConfig,
  agentDbPath,
  createLogger,
  getNanoGptKey,
  repoRoot,
} from '@agora/shared';
import { type LlmRuntime, loadBenchFile, startLlm } from '@agora/llm';
import { Agent } from '../agent';
import { Body } from '../body/body';
import { inventoryStacks } from '../body/inventory';
import { MemoryDB } from '../memory/db';
import { restoreSnapshot, saveSnapshot } from '../state/snapshot';
import { HubClient } from './client';
import { startTelemetry } from './telemetry';
import { debugOp } from './debug';

export interface RunBotOptions {
  hubUrl: string;
  slot: string;
  paths: DataPaths;
  world: WorldConfig;
  versions: VersionsConfig;
  models: ModelsConfig;
  /** Fallback rate share while the Hub is unreachable. */
  expectedBots?: number;
  /** Tests: a fake NanoGPT. */
  fetch?: typeof fetch;
  apiKey?: string;
  logger?: Logger;
  /** Exit the process when done (the real bot process); tests keep it. */
  exit?: (code: number) => void;
}

const GOODBYES = ['I think I’ll head off now. Take care!', 'gotta go, see you around', 'alright, I’m off. bye all'];

export interface RunningBot {
  username: string;
  agent: Agent;
  /** Resolves with the reason once the bot has finished. */
  done: Promise<string>;
  stop(reason: string): Promise<string>;
}

export async function runBot(o: RunBotOptions): Promise<RunningBot> {
  const boot = o.logger ?? createLogger({ name: `bot-${o.slot}`, logDir: path.join(o.paths.logs, 'bots'), console: false });
  const hub = new HubClient({ url: o.hubUrl, slot: o.slot, logger: boot, expectedBots: o.expectedBots });
  hub.connect();
  // A shutdown can come before we know who we are (the supervisor stopping while we start): just leave.
  const early: { reason: string | null } = { reason: null };
  hub.on('shutdown', (m) => (early.reason ??= m.reason));
  const first = await Promise.race([hub.assigned(), new Promise<null>((r) => hub.on('shutdown', () => r(null)))]);
  if (!first) {
    hub.close();
    o.exit?.(0);
    throw new Error(`shut down before being assigned: ${early.reason ?? 'unknown'}`);
  }
  const a = first;
  const logger = o.logger ?? createLogger({ name: `agent-${a.username}`, logDir: path.join(o.paths.logs, 'agents'), console: false });
  logger.info({ module: 'agent', slot: o.slot, resume: a.resume }, 'assigned');

  let rt: LlmRuntime | null = null;
  const key = o.apiKey ?? getNanoGptKey();
  if (key) {
    rt = await startLlm({
      apiKey: key,
      config: o.models,
      logger,
      // `pnpm bench-models`' measurements order the tiers (§22.3), as `pnpm run doctor` shows them.
      bench: loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'), logger),
      limiter: hub.tokenSource(),
      pollUsage: false,
      ...(o.fetch ? { fetch: o.fetch } : {}),
      onCost: (r) => hub.send({ t: 'cost', module: r.module, tier: r.tier, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ms: r.ms, ok: r.ok }),
    });
    const governor = rt.governor;
    const applyBudget = (b: NonNullable<HubClient['lastBudget']>) => governor.setExternal(b.degrade, b.codeOnly, b.reason, b.resetAt);
    hub.on('budget', applyBudget);
    if (hub.lastBudget) applyBudget(hub.lastBudget);
  } else {
    logger.warn({ module: 'agent' }, 'NANOGPT_API_KEY is empty: code-only');
  }

  const db = new MemoryDB(agentDbPath(o.paths, a.username));
  const embedder = hub.embedder(o.versions.embeddingModel.dims, o.versions.embeddingModel.id);
  const body = await Body.connect({
    host: o.world.server.host === '0.0.0.0' ? '127.0.0.1' : o.world.server.host,
    port: o.world.server.port,
    username: a.username,
    version: o.versions.minecraft.version,
    logger,
    chat: { acquireGlobalToken: () => hub.speechToken() },
  });
  const agent = new Agent({
    body,
    persona: a.persona,
    username: a.username,
    llm: rt?.client ?? null,
    logger,
    world: o.world,
    governor: rt?.governor,
    memory: { db, embedder },
    speechTier: o.models.speech.tier,
    speechModels: o.models.speech.models,
    mindModels: o.models.mind.models,
    ...(o.models.mind.timeoutMs ? { mindTimeoutMs: o.models.mind.timeoutMs } : {}),
    ...(o.models.speech.timeoutMs ? { speechTimeoutMs: o.models.speech.timeoutMs } : {}),
    architectModels: o.models.architect.models,
    architectTimeoutMs: o.models.architect.timeoutMs,
    fightSlot: { acquire: () => hub.fightSlot(), release: () => hub.fightDone() },
    // §19.4: born in-world, on its first start (a restart resumes from the snapshot instead).
    ...(a.birthFacts && !a.resume ? { birth: { facts: a.birthFacts, youthUntil: Date.now() + o.world.reproduction.youthSec * 1000 } } : {}),
    // §19.3: the bed ritual is reported to the Hub, which alone decides whether a child comes of it.
    onConception: (c) => hub.send({ t: 'conception', username: a.username, partner: c.partner, partnerModel: c.partnerModel, partnerSex: c.partnerSex, bedPos: c.bedPos, ts: Date.now() }),
  });
  if (a.resume) {
    const offline = restoreSnapshot(db, agent.store);
    logger.info({ module: 'agent', offlineMs: offline }, offline === null ? 'no snapshot to resume from' : 'resumed');
  }
  agent.start();
  // The operator's debug settings and requests (the dashboard, `pnpm ctl agent`): outside the simulation, logged.
  hub.on('tuning', (m) => agent.applyTuning(m.tuning));
  hub.on('debug', (m) => {
    logger.info({ module: 'debug', op: m.op }, 'operator request');
    void debugOp(agent, m.op, m.args).then(
      (r) => hub.send({ t: 'debugResult', reqId: m.reqId, ...r }),
      (err: unknown) => hub.send({ t: 'debugResult', reqId: m.reqId, ok: false, message: err instanceof Error ? err.message : String(err) }),
    );
  });
  hub.send({ t: 'ready', username: a.username });
  // The dashboard's view of this agent (M7): sent to the Hub, never to another bot.
  const stopTelemetry = startTelemetry({ agent, bot: body.bot, send: (kind, data) => hub.send({ t: 'telemetry', kind, ts: Date.now(), data }) });

  let finishing: Promise<string> | null = null;
  let resolveDone!: (why: string) => void;
  const done = new Promise<string>((r) => (resolveDone = r));
  const finish = (why: string, opts: { snapshot: boolean; goodbye?: boolean; code?: number }) => {
    finishing ??= (async () => {
      logger.info({ module: 'agent', why }, 'finishing');
      stopTelemetry();
      await agent.stop().catch((err: unknown) => logger.warn({ module: 'agent', err: String(err) }, 'stop failed'));
      if (opts.snapshot) saveSnapshot(db, agent.store.state);
      db.checkpoint();
      db.close();
      if (opts.goodbye) await body.say(GOODBYES[Math.floor(Math.random() * GOODBYES.length)] ?? 'bye').catch(() => undefined);
      await body.disconnect('bye').catch(() => undefined);
      hub.send({ t: 'bye', username: a.username, reason: why });
      rt?.stop();
      await new Promise((r) => setTimeout(r, 200));
      hub.close();
      resolveDone(why);
      o.exit?.(opts.code ?? 0);
      return why;
    })();
    return finishing;
  };

  hub.on('shutdown', (m) => void finish(`shutdown: ${m.reason}`, { snapshot: true }));
  if (early.reason) void finish(`shutdown: ${early.reason}`, { snapshot: true });
  hub.on('retire', (m) => void finish(`retired: ${m.reason}`, { snapshot: true, goodbye: true }));
  hub.on('cautionShift', (m) => agent.brake(m.shift, m.untilTs));
  hub.on('urge', (m) => void agent.urge(m.urge).catch((err: unknown) => logger.warn({ module: 'urge', err: String(err) }, 'urge failed')));
  hub.on('snapshot', (m) => {
    saveSnapshot(db, agent.store.state);
    // Checkpointed too, so a hot export (§23.4) copies a consistent database.
    db.checkpoint();
    hub.send({ t: 'snapshotDone', reqId: m.reqId, ok: true });
  });
  const startedAt = Date.now();
  body.bot.on('death', () => void reportDeath());
  const reportDeath = async () => {
    // §16.3: a life ends here. The public death message (the cause) can trail the death event a little.
    const mine = () => agent.store.state.perception.systemEvents.filter((e) => e.kind === 'death' && e.subject === a.username && e.ts >= Date.now() - 5000).at(-1);
    for (let i = 0; i < 15 && !mine(); i++) await new Promise((r) => setTimeout(r, 100));
    const last = mine();
    const p = body.bot.entity.position;
    hub.send({
      t: 'died',
      username: a.username,
      cause: last?.cause ?? last?.text ?? 'unknown',
      pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      aliveSec: Math.round((Date.now() - startedAt) / 1000),
      inventory: inventoryStacks(body.bot).map((s) => ({ item: s.item, qty: s.qty })),
    });
    await finish('died', { snapshot: false });
  };
  body.bot.on('end', (reason: string) => {
    // Lost the server: exit non-zero so the supervisor restarts this same agent.
    if (!finishing) void finish(`disconnected: ${reason}`, { snapshot: true, code: 1 });
  });
  return { username: a.username, agent, done, stop: (reason) => finish(reason, { snapshot: true }) };
}
