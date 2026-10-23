// M10 (§1.4, §7, §9, §21.1): the skills an agent writes for itself, in the sandbox, and reflection's trait
// annotations, without Minecraft: the sandbox's limits, a draft's checks, the library, the writer against the mocked
// NanoGPT (written, tried, kept or written again, given up, its gates), the CC reaching for one, and how what happened
// to an agent becomes a note on how it has changed. The live exit test is tests/live/m10-skills.test.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Bot, Vec3 } from '@agora/agent/body/bot';
import { type Commitment, ModelsConfigSchema, PersonaSchema, SeededRandom, type SocialProfile, WorldConfigSchema, isPrivateHost, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import type { Body } from '@agora/agent/body/body';
import type { SkillContext } from '@agora/agent/body/skills/types';
import { AgentBus } from '@agora/agent/bus';
import { MemoryDB } from '@agora/agent/memory/db';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { CognitiveController, validateDecision } from '@agora/agent/modules/cc';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { personaCore } from '@agora/agent/modules/prompts';
import { MAX_ANNOTATIONS, Reflection, cleanAnnotation, experienceFor, formativeExperiences } from '@agora/agent/modules/reflection';
import { SkillWriter } from '@agora/agent/modules/skillWriter';
import { type SkillDraft, SkillLibrary, asSkill, checkExpectation, fillCheck, lintDraft } from '@agora/agent/skills/learned';
import { loadSandbox, runSandboxed } from '@agora/agent/skills/sandbox';
import { withGrievance } from '@agora/agent/social/math';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, standardModels, schemaNameOf } from '../llm/fakeNanoGpt';

const LIMITS = { memoryMb: 16, cpuMs: 200, wallMs: 5000, maxCalls: 5 };
const ada = PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['inventive'], abilities: { intelligence: 0.9 } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !f(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(10);
  }
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const f of stops.splice(0)) f();
});

const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: 'torch_row',
  description: 'gets a row of torches ready',
  args: { n: 'number' },
  check: 'inventoryHas:torch>={n}',
  code: "const r = await api.skill('obtain', { item: 'torch', qty: args.n });\nreturn { ok: r.ok, observed: r.observed };",
  ...over,
});
const noApi = { skill: () => Promise.resolve({ ok: true, observed: 'done' }), look: () => ({ pos: { x: 1, y: 2, z: 3 } }) };
const slowApi = { ...noApi, skill: () => new Promise<{ ok: boolean; observed: string }>((res) => setTimeout(() => res({ ok: true, observed: 'late' }), 3000)) };

describe('the sandbox (§9)', () => {
  it('runs a skill body with only the skill API: its calls, what it sees of itself, its log', async () => {
    const ivm = await loadSandbox();
    if (!ivm) throw new Error('isolated-vm is not installed');
    const calls: string[] = [];
    const api = {
      skill: (name: string, a: Record<string, unknown>) => {
        calls.push(`${name} ${JSON.stringify(a)}`);
        return Promise.resolve({ ok: true, observed: 'waited' });
      },
      look: () => ({ pos: { x: 7, y: 64, z: 0 } }),
    };
    const code = "const here = api.look();\napi.log('at ' + here.pos.x);\nconst a = await api.skill('wait', { seconds: args.n });\nreturn { ok: a.ok, observed: 'waited from ' + here.pos.x };";
    const r = await runSandboxed(ivm, code, { n: 2 }, api, LIMITS);
    expect(r).toMatchObject({ ok: true, value: { ok: true, observed: 'waited from 7' }, logs: ['at 7'], calls: 1 });
    expect(calls).toEqual(['wait {"seconds":2}']);
  });

  it('has nothing of the host in it: no require, process, timers or network, and the API cannot be changed', async () => {
    const ivm = await loadSandbox();
    if (!ivm) throw new Error('isolated-vm is not installed');
    const r = await runSandboxed(ivm, "api.skill = null;\nreturn [typeof require, typeof process, typeof setTimeout, typeof fetch, typeof __skill, typeof api.skill].join(',');", {}, noApi, LIMITS);
    expect(r).toMatchObject({ ok: true, value: 'undefined,undefined,undefined,undefined,undefined,function' });
  });

  it('stops code that never yields, before an await or after one, by its CPU time', async () => {
    const ivm = await loadSandbox();
    if (!ivm) throw new Error('isolated-vm is not installed');
    const first = await runSandboxed(ivm, 'while (true) {}', {}, noApi, LIMITS);
    expect(first).toMatchObject({ ok: false, error: expect.stringMatching(/CPU|timed out/) as unknown });
    const later = await runSandboxed(ivm, "await api.skill('wait', {});\nwhile (true) {}", {}, noApi, LIMITS);
    expect(later).toMatchObject({ ok: false, error: expect.stringMatching(/CPU/) as unknown });
  });

  it('stops a run that takes too long, calls too many skills, wants too much memory, or is called off', async () => {
    const ivm = await loadSandbox();
    if (!ivm) throw new Error('isolated-vm is not installed');
    const t0 = Date.now();
    const slow = await runSandboxed(ivm, "await api.skill('wait', {});\nreturn 1;", {}, slowApi, { ...LIMITS, wallMs: 300 });
    expect(slow).toMatchObject({ ok: false, error: expect.stringMatching(/longer than/) as unknown });
    expect(Date.now() - t0).toBeLessThan(2000);
    const many = await runSandboxed(ivm, "for (let i = 0; i < 10; i++) await api.skill('wait', {});\nreturn 1;", {}, noApi, LIMITS);
    expect(many).toMatchObject({ ok: false, calls: 6, error: expect.stringMatching(/more than 5 skill calls/) as unknown });
    const big = await runSandboxed(ivm, 'const a = [];\nwhile (true) a.push(new Array(1e6).fill(1));', {}, noApi, { ...LIMITS, cpuMs: 5000 });
    expect(big.ok).toBe(false);
    const ac = new AbortController();
    const off = runSandboxed(ivm, "await api.skill('wait', {});\nreturn 1;", {}, slowApi, LIMITS, ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect(await off).toMatchObject({ ok: false, error: 'stopped' });
  });
});

describe('a draft, checked before it is ever run', () => {
  it('is built only from verified skills that act on the world, and says what will hold once it has worked', () => {
    expect(lintDraft(draft())).toBeNull();
    expect(lintDraft(draft({ name: 'gather' }))).toMatch(/already have/);
    expect(lintDraft(draft({ code: "const fs = require('fs');\nawait api.skill('wait', {});" }))).toMatch(/"require"/);
    expect(lintDraft(draft({ code: 'return { ok: true, observed: "nothing" };' }))).toMatch(/never calls/);
    expect(lintDraft(draft({ code: "await api.skill('duel', { target: 'Bo' });" }))).toMatch(/may not call "duel"/);
    expect(lintDraft(draft({ code: "await api.skill('say', { text: 'hi' });" }))).toMatch(/may not call "say"/);
    expect(lintDraft(draft({ check: 'it works now' }))).toMatch(/not a check/);
  });

  it("fills its check with the arguments: the runner's postcondition", () => {
    expect(fillCheck('inventoryHas:torch >= {n}', { n: 4 })).toBe('inventoryHas:torch>=4');
    expect(checkExpectation('inventoryHas:torch>={n}', { n: 4 })).toEqual({ kind: 'inventoryHas', item: 'torch', atLeast: 4 });
    expect(checkExpectation('blockAt:{x},64,{z}=oak_planks', { x: 3.7, z: -2 })).toMatchObject({ kind: 'blockAt', block: 'oak_planks', pos: { x: 3, y: 64, z: -2 } });
    expect(checkExpectation('near:10,64,{z}', { z: 5 })).toMatchObject({ kind: 'near', within: 3, pos: { x: 10, y: 64, z: 5 } });
    expect(checkExpectation('inventoryHas:torch>={n}', {})).toEqual({ kind: 'none' });
  });

  it('runs as a skill: its arguments checked, its verified skills run for real, only those it may use', async () => {
    const bot = { inventory: { items: () => [], slots: [] }, entity: { position: new Vec3(5, 64, 5) }, food: 20, health: 20, time: { isDay: true }, registry: { foodsByName: {} } } as unknown as Bot;
    const ctx: SkillContext = {
      bot,
      signal: new AbortController().signal,
      logger: nullLogger(),
      rng: new SeededRandom(1),
      movements: () => {
        throw new Error('no pathfinding here');
      },
      knowsRecipe: () => true,
      say: () => Promise.resolve(),
      slip: null,
      home: null,
      progress: () => undefined,
      planDepth: 3,
    };
    const rest = asSkill(draft({ name: 'short_rest', args: { seconds: 'number' }, check: 'near:5,64,5', code: "const r = await api.skill('wait', { seconds: args.seconds });\napi.log(r.observed);\nreturn { ok: r.ok, observed: 'rested ' + args.seconds + 's' };" }), LIMITS);
    expect(rest.parseArgs({ seconds: 1 }).ok).toBe(true);
    expect(rest.parseArgs({ seconds: 'one' })).toMatchObject({ ok: false });
    expect(rest.expect({ seconds: 1 }, { inventory: new Map(), pos: new Vec3(0, 0, 0), food: 20, health: 20, ts: 0 }, bot)).toMatchObject({ kind: 'near' });
    expect(await rest.run(ctx, { seconds: 1 })).toMatchObject({ ok: true, observed: 'rested 1s', data: { logs: ['waited 1s; no inventory change'], calls: 1 } });
    // Code that reaches past the rules anyway finds nothing there.
    const sly = asSkill(draft({ name: 'sly_one', args: {}, code: "const r = await api.skill('duel', { target: 'Bo' });\nreturn r;" }), LIMITS);
    expect(await sly.run(ctx, {})).toMatchObject({ ok: false, observed: expect.stringMatching(/did not start/) as unknown });
  });
});

describe('the skill library (§1.4)', () => {
  it('keeps the verified ones with its memory, offers the most relevant, and counts their uses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-m10-'));
    const file = path.join(dir, 'ada.sqlite');
    const db = new MemoryDB(file);
    const lib = new SkillLibrary(db, LIMITS);
    lib.save(draft(), 1000, null, 1000);
    lib.save(draft({ name: 'fence_garden', description: 'fences in a small garden plot', check: 'near:0,64,0' }), 1000, null, 1000);
    lib.save(draft({ name: 'half_done', description: 'a draft that never worked' }), null, null, 1000);
    lib.used('fence_garden', true);
    lib.used('torch_row', false);
    expect(lib.verified().map((r) => r.name).sort()).toEqual(['fence_garden', 'torch_row']);
    expect(lib.offered(1, 'build a fence around the garden')).toEqual(['fence_garden {n: number} — fences in a small garden plot (a skill you wrote)']);
    expect(lib.offered(1, 'more torches please')).toEqual([expect.stringMatching(/^torch_row/) as unknown]);
    // Not verified: not offered, not found, unless it is the one on trial.
    expect(lib.find('half_done')).toBeNull();
    expect(lib.find('half_done', draft({ name: 'half_done' }))?.name).toBe('half_done');
    expect(lib.skills(draft({ name: 'on_trial' })).map((s) => s.name).sort()).toEqual(['fence_garden', 'on_trial', 'torch_row']);
    db.close();
    const again = new SkillLibrary(new MemoryDB(file), LIMITS);
    expect(again.get('fence_garden')).toMatchObject({ uses: 1, successes: 1, verified: 1000, args: { n: 'number' }, check: 'near:0,64,0' });
    expect(again.get('torch_row')).toMatchObject({ uses: 1, successes: 0 });
    expect(again.skills().map((s) => s.name).sort()).toEqual(['fence_garden', 'torch_row']);
  });

  it('by embedding, when the skills and the goal have one', () => {
    const lib = new SkillLibrary(null, LIMITS);
    lib.save(draft({ name: 'aaa_one' }), 1, new Float32Array([1, 0]), 1);
    lib.save(draft({ name: 'bbb_two' }), 1, new Float32Array([0, 1]), 1);
    expect(lib.relevant(1, new Float32Array([0.1, 0.9])).map((r) => r.name)).toEqual(['bbb_two']);
    expect(lib.relevant(1, new Float32Array([0.9, 0.1])).map((r) => r.name)).toEqual(['aaa_one']);
  });
});

type SwConfig = ReturnType<typeof WorldConfigSchema.parse>['skillWriter'];

async function writer(replies: string[], over: { config?: Partial<SwConfig>; privateServer?: boolean; intelligence?: number; start?: boolean; llm?: boolean } = {}) {
  const fake = new FakeNanoGpt(standardModels());
  const asked: Record<string, unknown>[] = [];
  fake.chat = ({ body }) => {
    asked.push(body);
    return { text: replies[asked.length - 1] ?? replies.at(-1) ?? '{"skill": null}' };
  };
  const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
  const s = new AgentStateStore(createInitialState({ persona: ada, username: 'Ada', now: 0 }));
  const bus = new AgentBus();
  const lib = new SkillLibrary(null, LIMITS);
  const tried: { skill: string; args: Record<string, unknown> }[] = [];
  const learned: string[] = [];
  bus.on('skillLearned', (e) => learned.push(e.name));
  const clock = { t: 1_000_000 };
  const w = new SkillWriter({
    store: s,
    bus,
    logger: nullLogger(),
    llm: over.llm === false ? null : rt.client,
    me: 'Ada',
    config: { ...WorldConfigSchema.parse({}).skillWriter, enabled: true, ...over.config },
    privateServer: over.privateServer ?? true,
    intelligence: over.intelligence ?? 0.9,
    library: lib,
    tryOut: (skill, args) => {
      tried.push({ skill, args });
      return true;
    },
    now: () => clock.t,
  });
  w.start();
  stops.push(() => {
    w.stop();
    rt.stop();
  });
  const want = (name: string, args: Record<string, unknown> = { n: 4 }) => bus.emit({ type: 'skillWanted', name, args, why: 'light the path home' });
  const ran = (skill: string, ok: boolean, observed: string, error?: string) =>
    bus.emit({ type: 'actionRecorded', record: { id: `r${tried.length}`, skill, args: {}, expected: '', observed, ok, ts: clock.t, durationMs: 10, ...(error ? { error } : {}) } });
  const user = (i: number) => ((asked[i]?.messages as { role: string; content: string }[] | undefined) ?? []).find((m) => m.role === 'user')?.content ?? '';
  return { asked, s, lib, w, tried, learned, clock, want, ran, user };
}
const reply = (d: SkillDraft | null) => JSON.stringify({ skill: d });

describe('the skill writer (§1.4, §21.1, L3)', () => {
  it('writes the skill reached for, tries it out at once, and keeps it once it did what it said', async () => {
    const r = await writer([reply(draft())]);
    r.want('torch_row');
    await until(() => r.tried.length === 1);
    expect(r.tried[0]).toEqual({ skill: 'torch_row', args: { n: 4 } });
    expect(r.w.onTrial()?.name).toBe('torch_row');
    expect(r.asked[0]?.model).toBe('p1-big');
    const system = ((r.asked[0]?.messages as { role: string; content: string }[] | undefined) ?? [])[0]?.content ?? '';
    expect(system).toMatch(/async function \(args, api\)/);
    expect(system).toMatch(/obtain \{item/);
    expect(system).not.toMatch(/duel \{/);
    expect(r.user(0)).toMatch(/torch_row with arguments \{"n":4\}/);
    expect(r.user(0)).toMatch(/light the path home/);
    r.ran('torch_row', true, 'holding 4 torch');
    await until(() => r.learned.length === 1);
    expect(r.lib.get('torch_row')).toMatchObject({ verified: r.clock.t, uses: 1, successes: 1 });
    expect(r.w.onTrial()).toBeNull();
    expect(r.s.state.workmem.some((w) => /new skill: torch_row/.test(w.text))).toBe(true);
    // Its later runs are counted.
    r.ran('torch_row', false, 'holding 1 torch');
    expect(r.lib.get('torch_row')).toMatchObject({ uses: 2, successes: 1 });
  });

  it('a trial that did not hold is written again, told what went wrong; after the last try it is given up for an hour', async () => {
    const r = await writer([reply(draft())], { config: { attempts: 2 } });
    r.want('torch_row');
    await until(() => r.tried.length === 1);
    r.ran('torch_row', false, 'holding 1 torch', 'no coal around here');
    await until(() => r.tried.length === 2);
    expect(r.user(1)).toMatch(/Your last try:[\s\S]*api\.skill\('obtain'[\s\S]*holding 1 torch \(no coal around here\); the check inventoryHas:torch>=\{n\} did not hold/);
    r.ran('torch_row', false, 'holding 1 torch', 'no coal around here');
    await wait(100);
    expect(r.lib.get('torch_row')).toBeUndefined();
    r.want('torch_row');
    await wait(100);
    expect(r.asked).toHaveLength(2);
    r.clock.t += 61 * 60_000;
    r.want('torch_row');
    await until(() => r.asked.length === 3);
  });

  it('a draft that breaks the rules, or does not take the arguments it was reached for with, is refused before it runs', async () => {
    const r = await writer([reply(draft({ code: "await api.skill('duel', { target: 'Bo' });" })), reply(draft({ args: { count: 'number' } })), reply(draft())]);
    r.want('torch_row');
    await until(() => r.tried.length === 1);
    expect(r.asked).toHaveLength(3);
    expect(r.user(1)).toMatch(/Your last draft was refused: a skill may not call "duel"/);
    expect(r.user(2)).toMatch(/refused: it must take the arguments it was reached for with, \{"n":4\} \(count: missing\)/);
  });

  it('a trial cut short is not a try: it is tried again, as written, when next wanted', async () => {
    const r = await writer([reply(draft())], { config: { attempts: 1 } });
    r.want('torch_row');
    await until(() => r.tried.length === 1);
    r.ran('torch_row', false, 'interrupted');
    expect(r.w.onTrial()).toBeNull();
    r.want('torch_row', { n: 6 });
    await until(() => r.tried.length === 2);
    expect(r.tried[1]).toEqual({ skill: 'torch_row', args: { n: 6 } });
    expect(r.asked).toHaveLength(1);
    r.ran('torch_row', true, 'holding 6 torch');
    await until(() => r.learned.length === 1);
  });

  it('a skill the model says cannot be made from the skills there are is not asked for again within the hour', async () => {
    const r = await writer([reply(null)]);
    r.want('fly_home');
    await until(() => r.asked.length === 1);
    await wait(50);
    r.want('fly_home');
    await wait(100);
    expect(r.asked).toHaveLength(1);
    expect(r.tried).toEqual([]);
  });

  it('at most perHour new skills an hour', async () => {
    const r = await writer([reply(draft()), reply(draft({ name: 'fence_garden' }))], { config: { perHour: 1 } });
    r.want('torch_row');
    await until(() => r.tried.length === 1);
    r.ran('torch_row', true, 'holding 4 torch');
    await until(() => r.learned.length === 1);
    r.want('fence_garden');
    await wait(100);
    expect(r.asked).toHaveLength(1);
    r.clock.t += 61 * 60_000;
    r.want('fence_garden');
    await until(() => r.tried.length === 2);
  });

  it('writes nothing where it may not: turned off, a server others can reach, not clever enough, no model', async () => {
    const off = await writer([reply(draft())], { config: { enabled: false } });
    expect(await off.w.whyOff()).toMatch(/skillWriter\.enabled/);
    const open = await writer([reply(draft())], { privateServer: false });
    expect(await open.w.whyOff()).toMatch(/private server/);
    const dull = await writer([reply(draft())], { intelligence: 0.5 });
    expect(await dull.w.whyOff()).toMatch(/not clever enough/);
    const mute = await writer([reply(draft())], { llm: false });
    expect(await mute.w.whyOff()).toMatch(/no model/);
    for (const r of [off, open, dull, mute]) r.want('torch_row');
    await wait(150);
    for (const r of [off, open, dull, mute]) expect(r.asked.length + r.tried.length).toBe(0);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
  });
});

describe('a private server (§9)', () => {
  it('is on loopback, a private range or link-local; 0.0.0.0, a public address or a name is not', () => {
    for (const h of ['127.0.0.1', 'localhost', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.1.1', '::1', '[::1]', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.0.1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['0.0.0.0', '8.8.8.8', '172.32.0.1', 'mc.example.com', '2001:db8::1', '::ffff:8.8.8.8', '::']) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe('the CC and the skills it wrote', () => {
  const base = { option: 'work' as const, terminate: { maxSeconds: 60 }, rationale: 'light the way' };

  it('a written skill passes the checks like any other; one there is none of does not', () => {
    const lib = new SkillLibrary(null, LIMITS);
    lib.save(draft(), 1, null, 1);
    const env = { me: 'Ada', isStuck: () => false, canPerceive: () => false };
    expect(validateDecision({ ...base, task: { skill: 'torch_row', args: { n: 4 } } }, { ...env, learnedSkill: (n) => lib.find(n) })).toBeNull();
    expect(validateDecision({ ...base, task: { skill: 'torch_row', args: { n: 'four' } } }, { ...env, learnedSkill: (n) => lib.find(n) })).toMatch(/bad arguments for torch_row/);
    expect(validateDecision({ ...base, task: { skill: 'torch_row', args: { n: 4 } } }, env)).toMatch(/no skill "torch_row"/);
  });

  it('is offered the ones it wrote, and wants one written when it reaches for one there is none of', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let n = 0;
    fake.chat = ({ body }) => {
      const name = schemaNameOf(body);
      if (name !== 'decision') return { text: '{"summary":"ok"}' };
      n++;
      return n === 1
        ? { text: JSON.stringify({ ...base, task: { skill: 'lantern_row', args: { n: 3 } }, rationale: 'lanterns along the path' }) }
        : { text: JSON.stringify({ ...base, task: { skill: 'torch_row', args: { n: 4 } } }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    stops.push(() => rt.stop());
    const s = new AgentStateStore(createInitialState({ persona: ada, username: 'Ada', now: 0 }));
    const bus = new AgentBus();
    const lib = new SkillLibrary(null, LIMITS);
    lib.save(draft(), 1, null, 1);
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.9), extraSkills: () => lib.skills() });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({
      store: s,
      bus,
      logger: nullLogger(),
      llm: rt.client,
      me: 'Ada',
      levers: () => leversFor(0.9),
      awareness,
      executor,
      canPerceive: () => false,
      learned: { find: (k) => lib.find(k), offered: () => lib.offered(5) },
    });
    const wanted: string[] = [];
    bus.on('skillWanted', (e) => wanted.push(`${e.name} ${JSON.stringify(e.args)} (${e.why})`));
    cc.trigger('testing');
    await until(() => s.state.option !== null);
    expect(wanted).toEqual(['lantern_row {"n":3} (lanterns along the path)']);
    expect(s.state.option).toMatchObject({ option: 'work', skill: 'torch_row', status: 'running' });
    const first = (fake.chatRequests()[0]?.body?.messages as { role: string; content: string }[] | undefined) ?? [];
    expect(first[0]?.content).toMatch(/- torch_row \{n: number\} — gets a row of torches ready \(a skill you wrote\)/);
    cc.stop();
  });
});

const T = 50_000_000;
function lived(): AgentStateStore {
  const s = new AgentStateStore(createInitialState({ persona: ada, username: 'Ada', now: 0 }));
  const prof = (name: string, f: (p: SocialProfile) => SocialProfile) => s.update('social', (all) => ({ ...all, [name]: f(newSocialProfile(name, ada, T)) }), 'test');
  prof('Gorm', (p) => withGrievance(p, 'theft', ada, { now: T, witnessed: true, source: 'self_observed', note: 'Gorm stole my iron' }));
  prof('Bo', (p) => ({ ...p, lastFight: { ts: T, outcome: 'yielded' } }));
  prof('Kit', (p) => ({ ...p, kin: 'child' }));
  // Only told of: not lived through.
  prof('Zed', (p) => withGrievance(p, 'theft', ada, { now: T, witnessed: false, source: 'told_by:Bo', note: 'Bo says Zed stole' }));
  const promise = (id: string, status: Commitment['status']): Commitment => ({ id, debtor: 'Bo', creditor: 'Ada', what: { kind: 'give', item: 'bread', qty: 2, text: '2 bread' }, status, createdFromConv: 'c', createdAt: T });
  s.update('commitments', () => [promise('a', 'broken'), promise('b', 'broken'), promise('c', 'fulfilled')], 'test');
  s.update('growth', (g) => ({ ...g, selfCorrections: 3 }), 'test');
  return s;
}

describe('how it has changed (§7 evolution: trait annotations)', () => {
  it('finds what it lived through that would change anyone, the most formative first, each weighed once', () => {
    const s = lived();
    expect(formativeExperiences(s.state).map((f) => f.key)).toEqual(['parent', 'robbed', 'beaten', 'let_down', 'self_corrections']);
    expect(formativeExperiences(s.state)[1]).toMatchObject({ what: 'Gorm stole from you', becomes: 'has grown wary of strangers since being robbed' });
    s.update('growth', (g) => ({ ...g, evolved: ['parent', 'beaten'] }), 'test');
    expect(formativeExperiences(s.state).map((f) => f.key)).toEqual(['robbed', 'let_down', 'self_corrections']);
  });

  it("takes the experience a model's note comes from as listed or in the model's own words", () => {
    const found = formativeExperiences(lived().state);
    const key = (k: string | null, from = found) => experienceFor(from, k)?.key;
    expect(key('robbed')).toBe('robbed');
    // As glm-5.1 put it, live: the key with who did it.
    expect(key('robbed by Gorm')).toBe('robbed');
    expect(key('Let down')).toBe('let_down');
    expect(key('Gorm stole from you')).toBe('robbed');
    expect(key('a bad winter')).toBeUndefined();
    expect(key(null)).toBeUndefined();
    // A single experience: that one, whatever the key says.
    expect(key('a bad winter', found.slice(1, 2))).toBe('robbed');
  });

  it('keeps a note short, in the third person, plain and PG', () => {
    expect(cleanAnnotation('Ada has grown wary of strangers since being robbed.', 'Ada')).toBe('has grown wary of strangers since being robbed');
    expect(cleanAnnotation('"Has become slow to trust promises"', 'Ada')).toBe('has become slow to trust promises');
    expect(cleanAnnotation('I am scared of everyone now', 'Ada')).toBeNull();
    expect(cleanAnnotation('has grown wary of you', 'Ada')).toBeNull();
    expect(cleanAnnotation('sad', 'Ada')).toBeNull();
    expect(cleanAnnotation(`has grown ${'very '.repeat(30)}careful`, 'Ada')).toBeNull();
    expect(cleanAnnotation('has grown horny since spring', 'Ada')).toBeNull();
  });

  async function reflecting(text: (n: number) => string, s = lived()) {
    const fake = new FakeNanoGpt(standardModels());
    const asked: Record<string, unknown>[] = [];
    fake.chat = ({ body }) => {
      asked.push(body);
      return { text: text(asked.length) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    stops.push(() => rt.stop());
    const bus = new AgentBus();
    const noted: string[] = [];
    bus.on('traitAnnotated', (e) => noted.push(e.text));
    const clock = { t: T };
    const r = new Reflection({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Ada', levers: () => leversFor(0.9), rng: () => 0.5, now: () => clock.t });
    return { s, r, asked, noted, clock };
  }

  it('with a model: L3 writes how one of them changed it; it joins the persona prompt and memory; at most once an hour', async () => {
    const x = await reflecting(() => JSON.stringify({ key: 'robbed', annotation: 'Ada has grown wary of strangers since Gorm robbed her' }));
    await x.r.annotate();
    expect(x.asked[0]?.model).toBe('p1-big');
    const user = ((x.asked[0]?.messages as { role: string; content: string }[] | undefined) ?? []).find((m) => m.role === 'user')?.content ?? '';
    expect(user).toBe('- parent: you became a parent (Kit)\n- robbed: Gorm stole from you\n- beaten: Bo beat you in a fight');
    expect(x.s.state.traitAnnotations).toEqual(['has grown wary of strangers since Gorm robbed her']);
    expect(x.noted).toEqual(['has grown wary of strangers since Gorm robbed her']);
    expect(x.s.state.growth.evolved).toEqual(['robbed']);
    expect(x.s.state.workmem.at(-1)).toMatchObject({ text: 'How I have changed: has grown wary of strangers since Gorm robbed her.', salience: 0.9, source: 'reflection' });
    expect(personaCore(ada, x.s.state.traitAnnotations)).toMatch(/How you have changed lately: has grown wary of strangers since Gorm robbed her\./);
    await x.r.annotate();
    expect(x.asked).toHaveLength(1);
    x.clock.t += 61 * 60_000;
    await x.r.annotate();
    expect(x.asked).toHaveLength(2);
  });

  it("a note that won't do gives way to code's words; nothing changed weighs them all and keeps nothing", async () => {
    const x = await reflecting((n) => (n === 1 ? JSON.stringify({ key: 'parent', annotation: 'I would die for my kid' }) : JSON.stringify({ key: null, annotation: null })));
    await x.r.annotate();
    expect(x.s.state.traitAnnotations).toEqual(['has grown more protective since becoming a parent']);
    x.clock.t += 61 * 60_000;
    await x.r.annotate();
    expect(x.s.state.traitAnnotations).toHaveLength(1);
    expect(x.s.state.growth.evolved).toEqual(['parent', 'robbed', 'beaten', 'let_down']);
    expect(formativeExperiences(x.s.state).map((f) => f.key)).toEqual(['self_corrections']);
  });

  it(`without a model, code's words for the strongest; only the ${MAX_ANNOTATIONS} latest are kept`, async () => {
    const s = lived();
    for (const n of ['Al', 'Cy', 'Di']) s.update('social', (all) => ({ ...all, [n]: { ...newSocialProfile(n, ada, T), lastFight: { ts: T, outcome: 'won' } } }), 'test');
    s.update('commitments', (c) => [...c, ...['x', 'y'].map((id): Commitment => ({ id, debtor: 'Ada', creditor: 'Gorm', what: { kind: 'give', item: 'bread', qty: 2, text: '2 bread' }, status: 'fulfilled', coerced: true, createdFromConv: 'c', createdAt: T }))], 'test');
    const clock = { t: T };
    const r = new Reflection({ store: s, bus: new AgentBus(), logger: nullLogger(), llm: null, me: 'Ada', levers: () => leversFor(0.9), rng: () => 0.5, now: () => clock.t });
    for (let i = 0; i < 8; i++) {
      await r.annotate();
      clock.t += 61 * 60_000;
    }
    expect(s.state.growth.evolved).toEqual(['parent', 'robbed', 'beaten', 'coerced', 'bold', 'let_down', 'self_corrections']);
    expect(s.state.traitAnnotations).toEqual([
      'has grown careful about picking fights since being beaten',
      'has grown quiet and resentful since being made to pay',
      'has grown bolder since winning a fight',
      'has grown slow to trust promises since being let down',
      'has learned to look twice before judging people',
    ]);
  });

  it('is part of reflection: once calm, after the bias audit', async () => {
    const x = await reflecting(() => JSON.stringify({ key: 'parent', annotation: 'has grown gentler since becoming a parent' }));
    await x.r.run('test');
    expect(x.s.state.traitAnnotations).toEqual(['has grown gentler since becoming a parent']);
    x.clock.t += 61 * 60_000;
    x.s.update('emotions', (e) => ({ ...e, arousal: 0.8 }), 'test');
    await x.r.run('test');
    expect(x.s.state.traitAnnotations).toHaveLength(1);
  });
});
