// With the key: the parts of the design only a model does, against the real subscription models (§22.8). Reflection's
// bias audit (M8c, §18.6) and its trait annotation (M10, §7 evolution), run through Reflection itself; a skill written
// by L3 (M10, §1.4) and tried out in the world on a Paper server, everything else scripted (the CC is told to reach
// for a skill there is none of); an agent on the real model whose shelter is broken open at night (owner request:
// agents should see what changes around them and react); and the master model writing new people and a child around
// numbers drawn by code (owner request: agents weren't fully randomized). Spends real subscription quota, so it only runs with
// NANOGPT_API_KEY set AND AGORA_LIVE_LLM=1, through the same subscription lock and model measurements as the agents.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentEvent,
  type Logger,
  ModelsConfigSchema,
  NUMERIC_TRAIT_KEYS,
  type Persona,
  PersonaSchema,
  SeededRandom,
  SexDifferencesSchema,
  type SocialProfile,
  WorldConfigSchema,
  createLogger,
  generatePersona,
  getTrait,
  inheritPersona,
  loadEnv,
  loadModelsConfig,
  loadVersionsConfig,
  repoRoot,
  seedFromString,
  sleep,
} from '@agora/shared';
import { type Embedder, type LlmCallOptions, type LlmResult, type LlmRuntime, LocalRateLimiter, loadBenchFile, startLlm } from '@agora/llm';
import { PersonaWriter } from '@agora/hub';
import { Agent, MemoryDB } from '@agora/agent';
import { AgentBus } from '@agora/agent/bus';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { isEnclosed } from '@agora/agent/body/world';
import { countItem } from '@agora/agent/body/inventory';
import { leversFor } from '@agora/agent/modules/levers';
import { Reflection, formativeExperiences } from '@agora/agent/modules/reflection';
import { withGrievance } from '@agora/agent/social/math';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, standardModels, schemaNameOf } from '../llm/fakeNanoGpt';
import { type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

loadEnv();
const key = process.env.NANOGPT_API_KEY?.trim();
const enabled = Boolean(key) && process.env.AGORA_LIVE_LLM === '1';
const versions = loadVersionsConfig();
const T = 10_000_000;

/** What a real call came back with: the model's answer (validated) or the fallback, and which model. */
interface Seen {
  schema: string;
  ok: boolean;
  model: string;
  value: unknown;
  reason?: string;
}

/** The real runtime, as the agents start it: the subscription lock, the measured tier order. */
function real(logger: Logger): Promise<LlmRuntime> {
  return startLlm({ apiKey: key ?? '', config: loadModelsConfig(), logger, bench: loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'), logger), background: false, pollUsage: false });
}

/** Each call through `rt` is recorded in `seen` as it comes back. */
function recorded(rt: LlmRuntime, seen: Seen[]): LlmRuntime['client']['call'] {
  const call = rt.client.call.bind(rt.client);
  return async <T,>(o: LlmCallOptions<T>): Promise<LlmResult<T>> => {
    const r = await call(o);
    seen.push({ schema: o.schemaName ?? '', ok: r.ok, model: r.ok ? r.model : '', value: r.value, ...(r.ok ? {} : { reason: r.reason }) });
    return r;
  };
}

const sage = PersonaSchema.parse({ name: 'Ana', sex: 'female', traits: ['calm', 'fair-minded'], mind: { arousal: 0, rationality: 0.9, conformity: 0.2 }, abilities: { intelligence: 0.9 } });

function world(people: string[]): AgentStateStore {
  const s = new AgentStateStore(createInitialState({ persona: sage, username: 'Ana', now: 0 }));
  s.update('social', (all) => ({ ...all, ...Object.fromEntries(people.map((n) => [n, { ...newSocialProfile(n, sage, T), lastSeen: T }])) }), 'test');
  return s;
}
const set = (s: AgentStateStore, name: string, f: (p: SocialProfile) => SocialProfile) =>
  s.update('social', (all) => ({ ...all, [name]: f(all[name] ?? newSocialProfile(name, sage, T)) }), 'test');

describe.skipIf(!enabled)('Live with a key: what only a model does', () => {
  let logger: Logger;
  let rt: LlmRuntime;
  const seen: Seen[] = [];

  beforeAll(async () => {
    logger = createLogger({ name: 'real-models', console: process.env.AGORA_DEBUG === '1' });
    rt = await real(logger);
    rt.client.call = recorded(rt, seen);
  });

  afterAll(() => {
    rt?.stop();
  });

  it('the bias audit (M8c): L3 sees the dislike that rests on hearsay, and nobody it was not asked about is touched', async () => {
    const s = world(['Bram', 'Dov', 'Zed']);
    // Bram: Cass says he stole and speaks badly of him; Bram has only ever done right by Ana.
    set(s, 'Bram', (p) => ({ ...withGrievance(p, 'theft', sage, { now: T, witnessed: false, source: 'told_by:Cass', note: 'Cass says Bram stole', weight: 0.33 }), sentiment: 2.5, evidence: 7 }));
    s.update('heardOpinions', () => [{ speaker: 'Cass', target: 'Bram', valence: -0.7, ts: T }], 'test');
    // Dov: much admired, though what he has actually done to her is poor.
    set(s, 'Dov', (p) => ({ ...p, admiration: 0.9, sentiment: 8, evidence: 3 }));
    // Zed: she saw him take her iron herself. A fair grudge: not a candidate, and the model is not asked about him.
    set(s, 'Zed', (p) => ({ ...withGrievance(p, 'theft', sage, { now: T, witnessed: true, source: 'self_observed', note: 'Zed took my iron' }), sentiment: 3, evidence: 3 }));
    const zed = s.state.social.Zed;
    // Every correction is taken (rng 0): what is tested is the model's judgment, not her rationality.
    const r = new Reflection({ store: s, bus: new AgentBus(), logger, llm: rt.client, me: 'Ana', levers: () => leversFor(0.9), rng: () => 0, now: () => T });
    await r.run('test');
    const audit = seen.find((x) => x.schema === 'audit');
    console.log(`[real audit] ${audit?.model ?? '-'} ${audit?.ok ? 'answered' : `fell back (${audit?.reason ?? ''})`}: ${JSON.stringify(audit?.value)}`);
    console.log(`[real audit] Bram ${s.state.social.Bram?.sentiment.toFixed(1)} (grievances ${s.state.social.Bram?.grievances.length}); Dov admiration ${s.state.social.Dov?.admiration}; workmem: ${s.state.workmem.map((w) => w.text).join(' | ')}`);
    expect(audit?.ok).toBe(true);
    const named = (audit?.value as { corrections: { who: string; kind: string }[] }).corrections;
    expect(named.find((c) => c.who === 'Bram')?.kind).toBe('hearsay');
    // Corrected: the hearsay grudge gone, the feeling moved toward the facts, inoculated against it.
    expect(s.state.social.Bram?.grievances).toEqual([]);
    expect(s.state.social.Bram?.sentiment).toBeGreaterThan(5);
    expect(s.state.social.Bram?.inoculated).toContain('conformity');
    expect(s.state.social.Zed).toEqual(zed);
  }, 120_000);

  it('a trait annotation (M10): L3 says how being robbed and beaten changed her, in its own words, and it is kept', async () => {
    const s = world(['Vex']);
    set(s, 'Vex', (p) => ({ ...withGrievance(p, 'theft', sage, { now: T, witnessed: true, source: 'self_observed', note: 'Vex took my iron' }), lastFight: { ts: T, outcome: 'yielded' } }));
    const code = formativeExperiences(s.state).map((f) => f.becomes);
    const r = new Reflection({ store: s, bus: new AgentBus(), logger, llm: rt.client, me: 'Ana', levers: () => leversFor(0.9), rng: () => 0, now: () => T });
    const before = seen.length;
    await r.annotate();
    const note = seen.slice(before).find((x) => x.schema === 'annotation');
    console.log(`[real annotation] ${note?.model ?? '-'} ${note?.ok ? 'answered' : `fell back (${note?.reason ?? ''})`}: ${JSON.stringify(note?.value)}; kept: ${JSON.stringify(s.state.traitAnnotations)}; code's words: ${code.join(' / ')}`);
    expect(note?.ok).toBe(true);
    expect(s.state.traitAnnotations).toHaveLength(1);
    // The model's own words, not code's.
    expect(code).not.toContain(s.state.traitAnnotations[0]);
    expect(s.state.growth.evolved?.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('the master model: four newcomers and a child, each their own person around the numbers code drew', async () => {
    const w = WorldConfigSchema.parse({});
    const sexDiffs = SexDifferencesSchema.parse({});
    const rng = new SeededRandom(seedFromString(`real-personas-${Date.now()}`));
    const writer = new PersonaWriter({ llm: rt.client, logger, rng });
    const taken = new Set<string>();
    const living: Persona[] = [];
    const pairs: { draft: Persona; p: Persona }[] = [];
    const sameNumbers = (a: Persona, b: Persona) => NUMERIC_TRAIT_KEYS.every((k) => getTrait(a, k) === getTrait(b, k)) && a.abilities.intelligence === b.abilities.intelligence && a.abilities.combat === b.abilities.combat;
    const show = (p: Persona) => {
      const high = NUMERIC_TRAIT_KEYS.filter((k) => getTrait(p, k) >= 0.7).map((k) => `${k} ${getTrait(p, k).toFixed(2)}`);
      const low = NUMERIC_TRAIT_KEYS.filter((k) => getTrait(p, k) <= 0.3).map((k) => `${k} ${getTrait(p, k).toFixed(2)}`);
      return `${p.name} (${p.sex}, ${p.source}${p.familyName ? `, ${p.familyName} family` : ''}) high: ${high.join(', ') || '-'}; low: ${low.join(', ') || '-'}\n    traits: ${p.traits.join(', ')}\n    ${p.description ?? ''}\n    talks: ${p.speech.style}${p.speech.catchphrases.length > 0 ? ` ("${p.speech.catchphrases.join('", "')}")` : ''}\n    values: ${p.values.join(', ')}; wants: ${p.lifeGoals.join('; ')}; unsure: ${p.insecurities.join('; ') || '-'}`;
    };
    const before = seen.length;
    for (const sex of ['female', 'male', 'female', 'male'] as const) {
      const draft = generatePersona({ rng, world: w, sexDiffs, takenNames: taken, sex });
      const p = await writer.write(draft, { takenNames: taken, living });
      taken.add(p.name);
      living.push(p);
      pairs.push({ draft, p });
    }
    const [mum, dad] = living as [Persona, Persona];
    const cdraft = inheritPersona({ rng, world: w, a: mum, b: dad, takenNames: taken });
    const child = await writer.write(cdraft, { takenNames: taken, living, parents: [mum, dad] });
    pairs.push({ draft: cdraft, p: child });
    const calls = seen.slice(before).filter((x) => x.schema === 'persona');
    for (const [i, { draft, p }] of pairs.entries()) console.log(`[real persona] ${calls[i]?.model ?? '-'} ${calls[i]?.ok ? '' : `fell back (${calls[i]?.reason ?? ''}) `}${show(p)}\n    code's words were: ${draft.name}; ${draft.traits.join(', ')}`);
    // Each answered and written (not code's words), the numbers code drew kept, the sex as drawn.
    expect(calls.map((c) => c.ok)).toEqual([true, true, true, true, true]);
    for (const { draft, p } of pairs) {
      expect(p.description).not.toBe(draft.description);
      expect(sameNumbers(p, draft)).toBe(true);
      expect(p.sex).toBe(draft.sex);
    }
    // Each their own: five names, five ways of putting who they are.
    const people = pairs.map((x) => x.p);
    expect(new Set(people.map((p) => p.name.toLowerCase())).size).toBe(5);
    expect(new Set(people.map((p) => p.traits.join(','))).size).toBe(5);
    expect(new Set(people.map((p) => p.speech.style)).size).toBe(5);
    // The child: born to them, of their family, its name with the family's initial.
    expect(child).toMatchObject({ source: 'born', familyName: cdraft.familyName, generation: cdraft.generation });
    expect(child.name).toMatch(/_[A-Z]$/);
  }, 300_000);

  describe.skipIf(!liveJavaPath())('in the world', () => {
    let server: LiveServer;

    beforeAll(async () => {
      server = await startLiveServer({ name: 'real-models', port: 25608, rconPort: 25609 });
      for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000']) await server.cmd(c);
    });

    afterAll(async () => {
      await server?.stop();
    });

    it('a wall of her shelter knocked out at night: her model is told, and sees to it', async () => {
      const x = 1700;
      const Y = -60;
      await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
      // A stone cell round her, two high, roofed: the shelter she is in.
      await server.cmd(`fill ${x - 1} ${Y - 1} -1 ${x + 1} ${Y + 2} 1 minecraft:cobblestone hollow`);
      const body = await Body.connect({ host: server.host, port: server.port, username: 'Bea', version: versions.minecraft.version, logger });
      await server.cmd(`tp Bea ${x + 0.5} ${Y} 0.5`);
      await server.cmd('clear Bea');
      await server.cmd('give Bea minecraft:cobblestone 16');
      await server.cmd('give Bea minecraft:bread 4');
      await server.cmd('time set 18000');
      await sleep(2000);
      const bea = new Agent({
        body,
        persona: PersonaSchema.parse({ name: 'Bea', sex: 'female', traits: ['careful', 'practical'], social: { initiateChance: 0 }, abilities: { intelligence: 0.8 } }),
        username: 'Bea',
        llm: rt.client,
        logger,
        world: WorldConfigSchema.parse({}),
        goalGen: false,
        socialGoals: false,
      });
      const decisions: { at: number; source: string; option: string; task?: string; rationale: string }[] = [];
      bea.bus.on('decision', (e) => void decisions.push({ at: Date.now(), source: e.decision.source, option: e.decision.option, task: e.decision.task ? `${e.decision.task.skill} ${JSON.stringify(e.decision.task.args)}` : undefined, rationale: e.decision.rationale }));
      bea.start();
      try {
        await waitFor(() => isEnclosed(body.bot), 20_000, 'Bea walled in', 500);
        await sleep(4000);
        const feet = body.bot.entity.position.floored();
        const hole = feet.offset(1, 1, 0);
        const knocked = Date.now();
        await server.cmd(`setblock ${hole.x} ${hole.y} ${hole.z} air`);
        await waitFor(() => bea.store.state.perception.blockChanges.some((c) => c.ours === 'shelter'), 10_000, 'the hole noticed', 250);
        // Her model decides with it in front of it.
        const after = () => decisions.find((d) => d.at > knocked && d.source === 'llm');
        await waitFor(after, 90_000, "her model's decision after the hole", 500);
        const ex = bea.cc.lastExchange;
        const told = ex?.packet.split('\n').filter((l) => /Why you are deciding now|Changes around you|of your shelter/.test(l)).join(' | ');
        console.log(`[real aware] told: ${told}\n[real aware] decided: ${JSON.stringify(after())}\n[real aware] reply: ${ex?.replies.at(-1)?.model ?? '-'} ${ex?.replies.at(-1)?.text.slice(0, 400) ?? ''}`);
        const d = after();
        expect(ex?.packet).toMatch(new RegExp(`Changes around you:\\n {2}the cobblestone of your shelter beside you to the east, at head height was broken, at ${hole.x},${hole.y},${hole.z}`));
        // Seen to: the hole patched by her, or a fight or getting away (with nobody and nothing there, patching is it).
        const patched = await waitFor(() => body.bot.blockAt(new Vec3(hole.x, hole.y, hole.z))?.name !== 'air' || null, 60_000, 'the hole patched', 500).catch(() => null);
        console.log(`[real aware] patched: ${patched ? body.bot.blockAt(new Vec3(hole.x, hole.y, hole.z))?.name : 'no'}; decisions: ${decisions.map((x) => `${x.source}:${x.option}${x.task ? ` ${x.task}` : ''} (${x.rationale})`).join(' | ')}`);
        expect(Boolean(patched) || ['flee', 'fight'].includes(d?.option ?? '')).toBe(true);
      } finally {
        await bea.stop();
        await body.disconnect();
      }
    }, 300_000);

    it('wants a skill it lacks, L3 writes it, it is tried in the world and kept, and used again', async () => {
      const x = 1500;
      const z = 0;
      const Y = -60;
      await server.cmd(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
      // A grove of bare oak trunks, three logs high, a few steps away: more than M10's exit test has, as a model's
      // skill may well spend some (one live run's made a chest to keep them in).
      for (const [dx, dz] of [
        [4, 0],
        [5, 3],
        [3, -3],
        [-4, 1],
        [-3, -4],
        [2, 5],
        [-5, -1],
        [6, -2],
        [-2, 6],
        [1, -6],
        [7, 4],
        [-6, 4],
      ] as const) {
        await server.cmd(`fill ${x + dx} ${Y} ${z + dz} ${x + dx} ${Y + 2} ${z + dz} minecraft:oak_log`);
      }
      // Scripted: the CC reaches for a skill there is none of, then waits; once it is learned, reaches for it again (for
      // six logs). The skill itself is the real L3's to write.
      let phase: 'want' | 'wait' | 'reuse' | 'done' = 'want';
      const fake = new FakeNanoGpt(standardModels());
      fake.chat = ({ body }) => {
        const messages = body.messages as { role: string; content: string }[];
        const rest = { option: 'rest', terminate: { maxSeconds: 20 }, rationale: 'waiting a bit' };
        switch (schemaNameOf(body) ?? '') {
          case 'decision':
            if (phase === 'want') {
              phase = 'wait';
              return { text: JSON.stringify({ option: 'work', task: { skill: 'stock_up_logs', args: { qty: 3 } }, terminate: { maxSeconds: 300 }, rationale: 'I need a few logs put by' }) };
            }
            if (phase === 'reuse') {
              phase = 'done';
              return { text: JSON.stringify({ option: 'work', task: { skill: 'stock_up_logs', args: { qty: 6 } }, terminate: { maxSeconds: 300 }, rationale: 'more logs for the build' }) };
            }
            return { text: JSON.stringify(rest) };
          case 'summary':
            return { text: JSON.stringify({ summary: 'Getting logs together, one way or another.' }) };
          case 'memory':
            return { text: JSON.stringify({ text: messages.at(-1)?.content.split('\n')[0]?.slice(2) || 'worked on logs' }) };
          case 'audit':
            return { text: JSON.stringify({ corrections: [] }) };
          case 'annotation':
            return { text: JSON.stringify({ key: null, annotation: null }) };
          default:
            return { text: JSON.stringify(rest) };
        }
      };
      const scripted = await startLlm({ apiKey: 'scripted', config: ModelsConfigSchema.parse({}), logger, fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 50 }) });
      const scriptedCall = scripted.client.call.bind(scripted.client);
      scripted.client.call = <T,>(o: LlmCallOptions<T>): Promise<LlmResult<T>> => (o.schemaName === 'skill' ? rt.client.call(o) : scriptedCall(o));
      const memDir = path.join(server.dir, '..', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      const file = path.join(memDir, 'Ada.sqlite');
      fs.rmSync(file, { force: true });
      const db = new MemoryDB(file);
      const embedder: Embedder = { dims: 3, model: 'fixed', embed: (texts) => Promise.resolve(texts.map(() => new Float32Array([1, 0, 0]))) };
      const ada = PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['inventive', 'patient'], abilities: { intelligence: 0.9 }, social: { initiateChance: 0 } });
      const body = await Body.connect({ host: server.host, port: server.port, username: 'Ada', version: versions.minecraft.version, logger });
      await server.cmd(`tp Ada ${x} ${Y} ${z}`);
      await sleep(1500);
      const agent = new Agent({ body, persona: ada, username: 'Ada', llm: scripted.client, logger, world: WorldConfigSchema.parse({ skillWriter: { enabled: true } }), memory: { db, embedder }, goalGen: false });
      const events: AgentEvent[] = [];
      for (const type of ['skillWanted', 'skillLearned', 'actionRecorded'] as const) agent.bus.on(type, (e: AgentEvent) => events.push(e));
      const runs = () => events.flatMap((e) => (e.type === 'actionRecorded' && e.record.skill === 'stock_up_logs' ? [e.record] : []));
      const writes = () => seen.filter((x) => x.schema === 'skill');
      agent.start();
      const t0 = Date.now();
      const at = () => `${Math.round((Date.now() - t0) / 1000)} s`;
      try {
        agent.cc.trigger('the logs are running low', { urgent: true });
        await waitFor(() => events.some((e) => e.type === 'skillWanted' && e.name === 'stock_up_logs'), 60_000, 'the skill wanted');
        await waitFor(() => events.some((e) => e.type === 'skillLearned'), 600_000, 'the skill learned', 500);
        for (const w of writes()) console.log(`[real skill] ${at()} ${w.model || '-'} ${w.ok ? 'wrote' : `fell back (${w.reason ?? ''})`}:\n${JSON.stringify(w.value, null, 2)}`);
        const tries = runs();
        const kept = tries.at(-1);
        console.log(`[real skill] ${at()} trials: ${tries.map((r) => `${r.ok ? 'ok' : 'FAILED'} ${r.observed} (${r.expected ?? ''})`).join(' | ')}; oak_log held: ${countItem(body.bot, 'oak_log')}`);
        expect(writes().length).toBeGreaterThanOrEqual(1);
        expect(writes().at(-1)?.ok).toBe(true);
        expect(kept?.ok).toBe(true);
        expect(countItem(body.bot, 'oak_log')).toBeGreaterThanOrEqual(3);
        expect(db.skills().find((r) => r.name === 'stock_up_logs')?.verified).not.toBeNull();
        // Used again as a skill she has: not written again.
        const written = writes().length;
        const before = tries.length;
        phase = 'reuse';
        agent.cc.trigger('more logs wanted for the build', { urgent: true });
        await waitFor(() => runs().length > before, 300_000, 'the skill used again', 500);
        const again = runs().at(-1);
        console.log(`[real skill] ${at()} reused: ${again?.ok ? 'ok' : 'FAILED'}, ${again?.observed ?? ''}; oak_log held: ${countItem(body.bot, 'oak_log')}`);
        expect(again?.ok).toBe(true);
        expect(countItem(body.bot, 'oak_log')).toBeGreaterThanOrEqual(6);
        expect(writes()).toHaveLength(written);
      } finally {
        await agent.stop();
        await body.disconnect();
        scripted.stop();
        db.close();
      }
    }, 900_000);
  });
});
