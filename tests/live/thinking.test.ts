// The thinking agent, live (owner request, 2026-10-24). On a Paper server:
// - what Ada sees: trees, a pond, ore showing in a wall, the sheep and the cow about, put the way a player takes it in;
// - the flyer: someone in creative mode flies up and hangs in the air near her; nobody tells her to watch for that,
//   and she notices, because people fall (with the model: she thinks about it);
// - with the model: wool, with only two sheep about and a task to get it. Nothing in her code says how; she works it
//   out (shears keep the sheep), and doesn't go round in circles.
// The model cases spend real subscription quota: only with NANOGPT_API_KEY set and AGORA_LIVE_LLM=1.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Logger, PersonaSchema, WorldConfigSchema, createLogger, loadEnv, loadModelsConfig, loadVersionsConfig, repoRoot, sleep } from '@agora/shared';
import { type LlmRuntime, loadBenchFile, startLlm } from '@agora/llm';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { countItem } from '@agora/agent/body/inventory';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

loadEnv();
const key = process.env.NANOGPT_API_KEY?.trim();
const withModel = Boolean(key) && process.env.AGORA_LIVE_LLM === '1';
const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

function real(logger: Logger): Promise<LlmRuntime> {
  return startLlm({ apiKey: key ?? '', config: loadModelsConfig(), logger, bench: loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'), logger), background: false, pollUsage: false });
}

describe.skipIf(!liveJavaPath())('live: a thinking agent', () => {
  let server: LiveServer;
  // Outside the server's folder, which is cleared when the server starts.
  const logger = createLogger({ name: 'thinking-live', logDir: path.join(repoRoot(), 'data', 'live-test', 'thinking-agents'), console: process.env.AGORA_DEBUG === '1' });

  beforeAll(async () => {
    server = await startLiveServer({ name: 'thinking', port: 25630, rconPort: 25631, deepGround: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty peaceful']) await server.cmd(c);
  }, 300_000);

  afterAll(async () => {
    await server?.stop();
  });

  const join = async (name: string, x: number, z: number): Promise<Body> => {
    const body = await Body.connect({ host: server.host, port: server.port, username: name, version: versions.minecraft.version, logger });
    await server.cmd(`tp ${name} ${x} ${Y} ${z}`);
    await server.cmd(`clear ${name}`);
    return body;
  };

  const agentFor = (body: Body, name: string, llm: LlmRuntime | null) => {
    const cfg = loadModelsConfig();
    return new Agent({
      body,
      persona: PersonaSchema.parse({ name, sex: 'female', traits: ['practical', 'curious'], social: { initiateChance: 0 }, abilities: { intelligence: 0.7 } }),
      username: name,
      llm: llm?.client ?? null,
      logger,
      world: WorldConfigSchema.parse({}),
      goalGen: false,
      socialGoals: false,
      speechTier: cfg.speech.tier,
      speechModels: cfg.speech.models,
      ...(cfg.speech.timeoutMs ? { speechTimeoutMs: cfg.speech.timeoutMs } : {}),
      mindModels: cfg.mind.models,
      ...(cfg.mind.timeoutMs ? { mindTimeoutMs: cfg.mind.timeoutMs } : {}),
    });
  };

  it('sees what a player sees: the trees, the pond, ore in a wall, the animals, and where it all is', async () => {
    const x = 4000;
    await server.cmd(`forceload add ${x - 48} -48 ${x + 48} 48`);
    // A tree to the north-east, a pond to the west, iron showing in a stone wall to the south, two sheep and a cow.
    await server.cmd(`fill ${x + 8} ${Y} -8 ${x + 8} ${Y + 4} -8 oak_log`);
    await server.cmd(`fill ${x + 6} ${Y + 4} -10 ${x + 10} ${Y + 6} -6 oak_leaves[persistent=true] keep`);
    await server.cmd(`fill ${x - 14} ${Y - 1} -2 ${x - 10} ${Y - 1} 2 water`);
    await server.cmd(`fill ${x - 2} ${Y} 10 ${x + 2} ${Y + 3} 10 stone`);
    await server.cmd(`setblock ${x} ${Y + 1} 10 iron_ore`);
    await server.cmd(`setblock ${x + 1} ${Y + 2} 10 iron_ore`);
    for (const [dx, dz] of [
      [-4, -8],
      [-6, -9],
    ] as const) await server.cmd(`summon sheep ${x + dx} ${Y} ${dz} {Color:0b}`);
    await server.cmd(`summon cow ${x + 5} ${Y} 5`);
    const body = await join('Ada', x, 0);
    await sleep(2500);
    const ada = agentFor(body, 'Ada', null);
    ada.perception.start();
    try {
      await waitFor(() => ada.store.state.scene.features.length >= 3, 20_000, 'a look around', 250);
      await sleep(3000);
      const s = ada.store.state.scene;
      const f = s.features.map((k) => `${k.kind}:${k.what}:${k.bearing}`);
      process.stdout.write(`SCENE ${JSON.stringify({ where: s.where, f, c: s.creatures.map((k) => `${k.name}|${k.details.join(',')}|${k.bearing}|${k.distance}`), all: Object.values(body.bot.entities).map((e) => `${e.name}/${String(e.type)}@${e.position.floored().toString()}`) })}\n`);
      expect(s.where).toMatch(/^In plains, standing on grass block, under the open sky/);
      expect(f.some((k) => /^trees:1 oak tree:north-east$/.test(k))).toBe(true);
      expect(f.some((k) => /^water:.*:west$/.test(k))).toBe(true);
      expect(f.some((k) => /^ore:iron ore \(2 blocks\):south$/.test(k))).toBe(true);
      const c = s.creatures.map((k) => `${k.name}|${k.details.join(',')}`);
      expect(c.filter((k) => k === 'sheep|white wool')).toHaveLength(2);
      expect(c).toContain('cow|');
      // Remembered where they are, for later.
      expect((ada.store.state.knowledge.places ?? []).some((p) => p.kind === 'animals' && p.names.includes('sheep'))).toBe(true);
      expect((ada.store.state.knowledge.places ?? []).some((p) => p.kind === 'ore')).toBe(true);
    } finally {
      ada.perception.stop();
      await ada.stop();
      await body.disconnect();
    }
  }, 120_000);

  it('notices someone flying, though nothing tells her to watch for it (with the model: she thinks about it)', async () => {
    const x = 4300;
    await server.cmd(`forceload add ${x - 48} -48 ${x + 48} 48`);
    const adaBody = await join('Ada', x, 0);
    const kelby = await join('Kelby', x + 6, 4);
    await sleep(2500);
    const rt = withModel ? await real(logger) : null;
    const ada = agentFor(adaBody, 'Ada', rt);
    const thoughts: string[] = [];
    ada.bus.on('decision', (e) => {
      if (e.decision.source === 'llm') thoughts.push(`${e.decision.thought ?? ''} | ${e.decision.speechIntent?.gist ?? ''} | ${e.decision.rationale}`);
    });
    if (rt) ada.start();
    else ada.perception.start();
    try {
      // Someone she has never met, come into view, stands out (two put down together never spoke in twenty minutes).
      await waitFor(() => ada.store.state.scene.notices.some((n) => n.about === 'Kelby' && n.key === 'met'), 20_000, 'Ada noticed Kelby, whom she has not met', 250);
      expect(ada.store.state.scene.notices.find((n) => n.key === 'met')?.text).toMatch(/^Someone you haven't met: Kelby, \d+ m /);
      await sleep(8000);
      // Kelby goes creative and flies up, and hangs there.
      await server.cmd('gamemode creative Kelby');
      await sleep(1000);
      const k = kelby.bot as unknown as { creative: { startFlying(): void; flyTo(p: unknown): Promise<void> } };
      k.creative.startFlying();
      const up = kelby.bot.entity.position.offset(0, 7, 0);
      await k.creative.flyTo(up);
      const noticedAt = Date.now();
      await waitFor(() => ada.store.state.scene.notices.some((n) => n.about === 'Kelby' && (n.key === 'hover' || n.key === 'rise')), 20_000, 'Ada noticed Kelby in the air', 250);
      const n = ada.store.state.scene.notices.find((x2) => x2.about === 'Kelby' && (x2.key === 'hover' || x2.key === 'rise'));
      expect(n?.text).toMatch(/^Kelby is (\d+(\.\d)? m up in the air|up off the ground|rising straight up)/);
      expect(n?.text).toMatch(/You've never seen anyone do that\./);
      expect(ada.store.state.workmem.some((w) => w.text === n?.text)).toBe(true);
      if (rt) {
        // Her model thinks about it: the next thoughts make something of a person flying.
        await waitFor(() => thoughts.some((t) => /fl(y|ying|ies|ew)|in the air|float|hover|creative|levitat|hack|admin|magic/i.test(t)), 120_000, 'a thought about the flyer', 500);
        const t = thoughts.find((x2) => /fl(y|ying|ies|ew)|in the air|float|hover|creative|levitat|hack|admin|magic/i.test(x2));
        logger.info({ test: 'flyer', thought: t, after: Date.now() - noticedAt }, 'Ada on the flyer');
        expect(t).toBeDefined();
      }
    } finally {
      await ada.stop();
      await adaBody.disconnect();
      await kelby.disconnect();
    }
  }, 300_000);

  it('hungry with nothing to eat, a cow in view catches her eye (one starving strolled past a chicken)', async () => {
    const x = 4900;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    const body = await join('Ada', x, 0);
    await sleep(1500);
    // On peaceful hunger never comes: easy for this, by day on open ground.
    await server.cmd('difficulty easy');
    await server.cmd('effect give Ada minecraft:hunger 10 200');
    await waitFor(() => body.bot.food <= 12, 20_000, 'hungry', 100);
    await server.cmd('effect clear Ada');
    const ada = agentFor(body, 'Ada', null);
    ada.perception.start();
    try {
      await sleep(3000);
      await server.cmd(`summon cow ${x + 8} ${Y} 3`);
      await waitFor(() => ada.store.state.scene.notices.some((n) => n.key === 'food'), 20_000, 'the cow noticed as food', 250);
      expect(ada.store.state.scene.notices.find((n) => n.key === 'food')?.text).toMatch(/^A cow, \d+ m [a-z-]+: meat, and you are (hungry|starving) with nothing to eat on you/);
    } finally {
      await server.cmd('kill @e[type=minecraft:cow]');
      await server.cmd('difficulty peaceful');
      await ada.stop();
      await body.disconnect();
    }
  }, 120_000);

  it.skipIf(!withModel)('wool with only two sheep about: she works out a way that keeps them, and does not go round in circles', async () => {
    const x = 4600;
    await server.cmd(`forceload add ${x - 48} -48 ${x + 48} 48`);
    // Two white sheep in a pen by her; she has two iron ingots (shears are two), planks and a crafting table.
    await server.cmd(`fill ${x + 3} ${Y} -4 ${x + 9} ${Y} 4 oak_fence`);
    // A ring of fence: the inside cleared (a one-high hollow fill is solid).
    await server.cmd(`fill ${x + 4} ${Y} -3 ${x + 8} ${Y} 3 air`);
    await server.cmd(`setblock ${x + 3} ${Y} 0 oak_fence_gate[facing=west]`);
    for (const dz of [-2, 2]) await server.cmd(`summon sheep ${x + 6} ${Y} ${dz} {Color:0b}`);
    const body = await join('Ada', x, 0);
    await server.cmd('give Ada minecraft:iron_ingot 2');
    await server.cmd('give Ada minecraft:oak_planks 8');
    await server.cmd('give Ada minecraft:crafting_table 1');
    await server.cmd('give Ada minecraft:bread 4');
    await sleep(2500);
    const rt = await real(logger);
    const ada = agentFor(body, 'Ada', rt);
    const acts: { skill: string; args: string; ok: boolean; error?: string }[] = [];
    ada.bus.on('actionRecorded', (e) => void acts.push({ skill: e.record.skill, args: JSON.stringify(e.record.args), ok: e.record.ok, ...(e.record.error ? { error: e.record.error } : {}) }));
    const thoughts: string[] = [];
    ada.bus.on('decision', (e) => void (e.decision.thought && thoughts.push(e.decision.thought)));
    const sheep = () => Object.values(body.bot.entities).filter((e) => e.name === 'sheep' && Math.hypot(e.position.x - (x + 6), e.position.z) <= 12).length;
    ada.start();
    try {
      ada.giveTask('Get 3 white wool.', 'the operator');
      const wool = () => countItem(body.bot, 'white_wool');
      await waitFor(() => wool() >= 2, 8 * 60_000, 'some wool', 2000);
      // She got it a way that keeps the sheep.
      expect(sheep()).toBe(2);
      // And never did the same failing thing over and over.
      let run = 0;
      let worst = 0;
      for (let i = 1; i < acts.length; i++) {
        const a = acts[i];
        const b = acts[i - 1];
        run = a && b && !a.ok && !b.ok && a.skill === b.skill && a.args === b.args ? run + 1 : 0;
        worst = Math.max(worst, run);
      }
      logger.info({ test: 'wool', acts, thoughts: thoughts.slice(-6), wool: wool(), sheep: sheep() }, 'wool run');
      expect(worst).toBeLessThan(3);
      expect(thoughts.length).toBeGreaterThan(0);
    } finally {
      process.stdout.write(`WOOL ${JSON.stringify({ wool: countItem(body.bot, 'white_wool'), sheep: sheep(), acts, thoughts })}\n`);
      await ada.stop();
      await body.disconnect();
    }
  }, 600_000);
});
