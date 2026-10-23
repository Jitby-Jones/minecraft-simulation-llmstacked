// Skills an agent writes for itself (§1.4 Voyager, §9, §21.1, M10). A skill is a short piece of JavaScript, run in
// the sandbox, built only from the agent's verified skills (and only those that act on the world: no fighting, no
// giving things away, no speaking, which go through their own gates). It says what will be true once it has worked
// (its check), so the runner verifies it as it verifies any skill; it is kept once a trial run did what it said
// (self-verification), and offered to the CC thereafter, the most relevant first.

import { z } from 'zod';
import { Vec3 } from 'vec3';
import { cosine } from '@agora/llm';
import type { MemoryDB, SkillRow } from '../memory/db';
import { getSkill } from '../body/skills/registry';
import { runSkill } from '../body/skills/runner';
import type { AnySkill, Expectation, SkillContext, SkillResult } from '../body/skills/types';
import { type SandboxLimits, loadSandbox, runSandboxed } from './sandbox';

/** The verified skills a written one may use: those that act on the world and nothing else. */
export const CALLABLE: ReadonlySet<string> = new Set([
  'goTo',
  'follow',
  'explore',
  'wander',
  'look',
  'lookAround',
  'wait',
  'gather',
  'mine',
  'pickup',
  'prospect',
  'craft',
  'smelt',
  'obtain',
  'place',
  'shelter',
  'deposit',
  'withdraw',
  'eat',
  'equip',
  'sleep',
  'hunt',
  'build',
]);

const ArgTypeSchema = z.enum(['number', 'string', 'boolean']);

/** A skill as the writer drafts it. */
export const SkillDraftSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
  description: z.string().min(5).max(160),
  args: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,15}$/), ArgTypeSchema).default({}),
  /** What holds once it has worked: inventoryHas:<item>>=<n>, blockAt:<x>,<y>,<z>=<block> or near:<x>,<y>,<z>, with {arg} for arguments. */
  check: z.string().min(5).max(100),
  code: z.string().min(10).max(6000),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

/** What the code must not reach for. The sandbox has none of it anyway; a draft that tries is refused early. */
const FORBIDDEN = /\b(require|import|process|eval|Function|globalThis|constructor|__proto__|prototype|WebAssembly|Atomics|SharedArrayBuffer)\b/;
const CHECK_RE = /^(inventoryHas:[a-z0-9_{}]+>=[0-9{}a-zA-Z_]+|blockAt:[^=]+=[a-z0-9_]+|near:[^,]+,[^,]+,[^,]+)$/;

/** Why a draft won't do, before it is ever run; null when it may be tried. */
export function lintDraft(d: SkillDraft): string | null {
  if (getSkill(d.name)) return `"${d.name}" is a skill you already have`;
  const m = FORBIDDEN.exec(d.code);
  if (m) return `the code uses "${m[0]}", which a skill may not`;
  const called = [...d.code.matchAll(/api\.skill\(\s*['"`]([A-Za-z_]+)['"`]/g)].map((x) => x[1] ?? '');
  if (called.length === 0) return 'the code never calls api.skill("...")';
  const bad = called.find((n) => !CALLABLE.has(getSkill(n)?.name ?? ''));
  if (bad) return `a skill may not call "${bad}" (only: ${[...CALLABLE].join(', ')})`;
  if (!CHECK_RE.test(d.check.replace(/\s+/g, ''))) return `"${d.check}" is not a check (inventoryHas:<item>>=<n>, blockAt:<x>,<y>,<z>=<block>, near:<x>,<y>,<z>)`;
  return null;
}

/** The check with the arguments put in ("inventoryHas:torch>={qty}" → "inventoryHas:torch>=4"). */
export function fillCheck(check: string, args: Record<string, unknown>): string {
  return check.replace(/\s+/g, '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k: string) => {
    const v = args[k];
    return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? String(v) : `{${k}}`;
  });
}

/** The check as the runner's postcondition. */
export function checkExpectation(check: string, args: Record<string, unknown>): Expectation {
  const c = fillCheck(check, args);
  let m = /^inventoryHas:([a-z0-9_]+)>=(\d+)$/.exec(c);
  if (m?.[1] && m[2]) return { kind: 'inventoryHas', item: m[1], atLeast: Number(m[2]) };
  m = /^blockAt:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)=([a-z0-9_]+)$/.exec(c);
  if (m?.[1] && m[2] && m[3] && m[4]) return { kind: 'blockAt', pos: new Vec3(Math.floor(Number(m[1])), Math.floor(Number(m[2])), Math.floor(Number(m[3]))), block: m[4] };
  m = /^near:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(c);
  if (m?.[1] && m[2] && m[3]) return { kind: 'near', pos: new Vec3(Number(m[1]), Number(m[2]), Number(m[3])), within: 3 };
  return { kind: 'none' };
}

/** The arguments a call gives, against what the skill takes. */
export function parseArgs(spec: Readonly<Record<string, string>>, raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(spec)) {
    const v = given[k];
    if (v === undefined) return { ok: false, error: `${k}: missing` };
    if (typeof v !== t) return { ok: false, error: `${k}: expected ${t}` };
    if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false, error: `${k}: not a number` };
    args[k] = v;
  }
  return { ok: true, args };
}

/** A written skill as a skill the executor can run (verified or on trial). */
export function asSkill(d: { name: string; description: string; args: Readonly<Record<string, string>>; check: string; code: string }, limits: SandboxLimits): AnySkill {
  const argText = Object.entries(d.args)
    .map(([k, t]) => `${k}: ${t}`)
    .join(', ');
  return {
    name: d.name,
    description: `${d.name} {${argText}} — ${d.description} (a skill you wrote)`,
    talkOverable: false,
    slipKinds: [],
    parseArgs: (raw) => parseArgs(d.args, raw),
    expect: (args) => checkExpectation(d.check, args as Record<string, unknown>),
    run: (ctx, args) => runWritten(d.code, args as Record<string, unknown>, ctx, limits),
  };
}

async function runWritten(code: string, args: Record<string, unknown>, ctx: SkillContext, limits: SandboxLimits): Promise<SkillResult> {
  const ivm = await loadSandbox();
  if (!ivm) return { ok: false, observed: 'did not start', error: 'the sandbox (isolated-vm) is not installed' };
  const done: string[] = [];
  const r = await runSandboxed(
    ivm,
    code,
    args,
    {
      skill: async (name, a) => {
        const s = getSkill(name);
        if (!s || !CALLABLE.has(s.name)) return { ok: false, observed: 'did not start', error: `no skill "${name}" to use here` };
        const rec = await runSkill(s, a, {
          bot: ctx.bot,
          logger: ctx.logger,
          rng: ctx.rng,
          signal: ctx.signal,
          movements: ctx.movements,
          knowsRecipe: ctx.knowsRecipe,
          say: ctx.say,
          slipChance: 0,
          progress: ctx.progress,
          planDepth: ctx.planDepth,
          home: ctx.home,
          ...(ctx.combat !== undefined ? { combat: ctx.combat } : {}),
        });
        done.push(`${s.name}: ${rec.observed}`);
        return { ok: rec.ok, observed: rec.observed, ...(rec.error ? { error: rec.error } : {}) };
      },
      look: () => {
        const p = ctx.bot.entity.position;
        const inventory: Record<string, number> = {};
        for (const i of ctx.bot.inventory.items()) inventory[i.name] = (inventory[i.name] ?? 0) + i.count;
        return { pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, inventory, health: ctx.bot.health, food: ctx.bot.food, isDay: ctx.bot.time.isDay };
      },
    },
    limits,
    ctx.signal,
  );
  const steps = done.slice(-4).join('; ');
  if (!r.ok) return { ok: false, observed: steps || 'nothing done', error: `the skill's code failed: ${r.error}`, data: { logs: r.logs, calls: r.calls } };
  const said = r.value && typeof r.value === 'object' ? (r.value as { ok?: unknown; observed?: unknown }) : null;
  const ok = said?.ok !== false;
  const observed = typeof said?.observed === 'string' ? said.observed : typeof r.value === 'string' ? r.value : steps || 'done';
  return { ok, observed: String(observed).slice(0, 200), ...(ok ? {} : { error: 'the skill says it did not work' }), data: { logs: r.logs, calls: r.calls } };
}

/** The skills an agent wrote, kept with its memory; the verified ones offered, the most relevant first. */
export class SkillLibrary {
  private readonly rows = new Map<string, SkillRow>();

  constructor(
    private readonly db: MemoryDB | null,
    private readonly limits: SandboxLimits,
  ) {
    for (const r of db?.skills() ?? []) this.rows.set(r.name, r);
  }

  get(name: string): SkillRow | undefined {
    return this.rows.get(name);
  }

  verified(): SkillRow[] {
    return [...this.rows.values()].filter((r) => r.verified !== null);
  }

  /** Verified skills as runnable skills, plus a draft on trial if there is one. */
  skills(trial?: SkillDraft | null): AnySkill[] {
    const out = this.verified().map((r) => asSkill({ ...r, check: r.check ?? '' }, this.limits));
    if (trial && !this.rows.get(trial.name)?.verified) out.push(asSkill(trial, this.limits));
    return out;
  }

  /** One by name: a verified one, or the draft on trial. */
  find(name: string, trial?: SkillDraft | null): AnySkill | null {
    if (trial?.name === name) return asSkill(trial, this.limits);
    const r = this.rows.get(name);
    return r?.verified ? asSkill({ ...r, check: r.check ?? '' }, this.limits) : null;
  }

  /** Lines for the model's skill list: the verified ones most to do with `query`, at most k. */
  offered(k: number, query?: Float32Array | string | null): string[] {
    return this.relevant(k, query).map((r) => asSkill({ ...r, check: r.check ?? '' }, this.limits).description);
  }

  /** The verified ones most to do with `query` (by embedding if there is one, else by shared words), at most k. */
  relevant(k: number, query?: Float32Array | string | null): SkillRow[] {
    const all = this.verified();
    if (all.length <= k || !query) return all.sort((a, b) => b.successes - a.successes).slice(0, k);
    const score = (r: SkillRow): number => {
      if (typeof query !== 'string') return r.embedding ? cosine(r.embedding, query) : 0;
      const words = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
      return `${r.name.replace(/_/g, ' ')} ${r.description}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => words.has(w)).length;
    };
    return all.sort((a, b) => score(b) - score(a) || b.successes - a.successes).slice(0, k);
  }

  /** Kept: verified (a trial did what it said), or a draft that didn't make it (not offered, kept for its name). */
  save(d: SkillDraft, verified: number | null, embedding: Float32Array | null, now: number): void {
    const prev = this.rows.get(d.name);
    const row: SkillRow = {
      name: d.name,
      description: d.description,
      args: d.args,
      check: d.check,
      code: d.code,
      created: prev?.created ?? now,
      verified,
      uses: prev?.uses ?? 0,
      successes: prev?.successes ?? 0,
      embedding: embedding ?? prev?.embedding ?? null,
    };
    this.rows.set(d.name, row);
    this.db?.saveSkill(row);
  }

  used(name: string, ok: boolean): void {
    const r = this.rows.get(name);
    if (!r) return;
    r.uses++;
    if (ok) r.successes++;
    this.db?.skillUsed(name, ok);
  }
}
