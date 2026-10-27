// `pnpm bench-thoughts` (docs/plan-thinking-models.md §5): asks the models a kind of thought might run on to decide the
// golden cases (bench/thoughts/<kind>.jsonl: for the mind and under fire, packets the agents saw in the long runs, each
// with what a sensible player might do and what is plainly wrong; for the quick checks, what a person would answer),
// through the subscription-locked client with the thought's own reply cap, time and effort. Prints, for each setup:
// valid replies, cut off, p50/p90 of the valid ones, and the rubric's score. Every reply goes to
// data/bench/thoughts-<time>.json. Spends real subscription quota.
//
//   pnpm bench-thoughts --kind mind --setups z-ai/glm-5.3@none,z-ai/glm-5.3@low,deepseek/deepseek-v4-pro [--reps 2]
//                       [--cases pillar,night] [--concurrency 4]
//   pnpm bench-thoughts --kind check --setups deepseek/deepseek-v4-flash,xiaomi/mimo-v2.6-flash

import fs from 'node:fs';
import path from 'node:path';
import { DecisionOutputSchema, PersonaSchema, ReasoningEffortSchema, createLogger, loadEnv, loadModelsConfig, repoRoot, requireNanoGptKey } from '@agora/shared';
import { startLlm } from '@agora/llm';
import { mindSystemPrompt } from '@agora/agent/modules/prompts';
import { getSkill, skillCatalog } from '@agora/agent/body/skills/registry';
import { tidyDecision } from '@agora/agent/modules/decisionTidy';
import { type BenchCase, BenchCaseSchema, type BenchResult, actOf, parseSetup, summarize, verdict } from './lib/thought-bench';
import { type CheckCase, CheckCaseSchema, checkRequest, checkVerdict } from './lib/check-bench';

type Kind = 'mind' | 'underFire' | 'check';
const KINDS: readonly Kind[] = ['mind', 'underFire', 'check'];

interface Args {
  kinds: Kind[];
  setups: string[];
  reps: number;
  cases: string[];
  concurrency: number;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { kinds: ['mind', 'underFire'], setups: [], reps: 1, cases: [], concurrency: 4 };
  const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k);
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => String(argv[++i] ?? '');
    if (v === '--kind') a.kinds = next().split(',').filter(isKind);
    else if (v === '--setups') a.setups = next().split(',').filter(Boolean);
    else if (v === '--reps') a.reps = Math.max(1, Math.min(5, Number(next()) || 1));
    else if (v === '--cases') a.cases = next().split(',').filter(Boolean);
    else if (v === '--concurrency') a.concurrency = Math.max(1, Math.min(12, Number(next()) || 4));
  }
  return a;
}

function loadLines(kind: string): unknown[] {
  const file = path.join(repoRoot(), 'bench', 'thoughts', `${kind}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

const picked = <T extends { id: string }>(all: T[], only: readonly string[]) => (only.length > 0 ? all.filter((c) => only.some((o) => c.id.includes(o))) : all);
const loadCases = (kind: string, only: readonly string[]): BenchCase[] => picked(loadLines(kind).map((l) => BenchCaseSchema.parse(l)), only);
const loadChecks = (only: readonly string[]): CheckCase[] => picked(loadLines('check').map((l) => CheckCaseSchema.parse(l)), only);

async function pool<T>(jobs: readonly (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await (jobs[i] as () => Promise<T>)();
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const config = loadModelsConfig();
  const logger = createLogger({ name: 'bench-thoughts', console: false, logDir: path.join(repoRoot(), 'data', 'bench', 'logs') });
  const rt = await startLlm({ apiKey: requireNanoGptKey(), config, logger, background: false, pollUsage: false });
  const results: BenchResult[] = [];
  try {
    for (const kind of args.kinds) {
      const setups = args.setups.length > 0 ? args.setups : [config.thoughts[kind]?.model ?? ''].filter(Boolean);
      const checks = kind === 'check' ? loadChecks(args.cases) : [];
      const cases = kind === 'check' ? [] : loadCases(kind, args.cases);
      const ids = kind === 'check' ? checks.map((c) => c.id) : cases.map((c) => c.id);
      if (ids.length === 0 || setups.length === 0) continue;
      console.log(`\n${kind}: ${ids.length} cases × ${setups.length} setups × ${args.reps}`);
      const show = (setup: string, res: BenchResult) =>
        process.stdout.write(`  ${setup.padEnd(36)} ${res.caseId.padEnd(26)} ${res.ok ? `${res.verdict.padEnd(7)} ${String(res.ms).padStart(6)} ms  ${res.act ?? ''}` : `FAIL ${res.reason ?? ''}`}\n`);
      const checkJobs = setups.flatMap((setup) =>
        checks.flatMap((c) =>
          Array.from({ length: args.reps }, (_, rep) => async (): Promise<BenchResult> => {
            const { model, effort } = parseSetup(setup);
            const q = checkRequest(c);
            const r = await rt.client.call<unknown>({
              tier: 'L1',
              module: q.module,
              thought: 'check',
              agent: 'bench',
              model,
              ...(effort ? { effort: ReasoningEffortSchema.parse(effort) } : {}),
              messages: q.messages,
              schema: q.schema,
              schemaName: q.schemaName,
              fallback: () => null,
            });
            const res: BenchResult = {
              setup,
              caseId: c.id,
              rep,
              ok: r.ok,
              ...(r.ok ? {} : { reason: `${r.reason}${r.error ? `: ${r.error.slice(0, 160)}` : ''}` }),
              truncated: Boolean(r.ok && r.truncated),
              ms: r.ms,
              verdict: r.ok ? checkVerdict(c, r.value) : 'invalid',
              ...(r.ok ? { act: JSON.stringify(r.value).slice(0, 160) } : {}),
            };
            show(setup, res);
            return res;
          }),
        ),
      );
      const mindJobs = setups.flatMap((setup) =>
        cases.flatMap((c) =>
          Array.from({ length: args.reps }, (_, rep) => async (): Promise<BenchResult> => {
            const { model, effort } = parseSetup(setup);
            const persona = PersonaSchema.parse({ name: c.who, sex: c.sex, traits: c.traits, abilities: { intelligence: 0.75 } });
            const system = mindSystemPrompt(persona, { emergency: kind === 'underFire', skills: skillCatalog() });
            const r = await rt.client.call({
              tier: 'L2',
              module: 'cc',
              thought: kind,
              agent: 'bench',
              model,
              ...(effort ? { effort: ReasoningEffortSchema.parse(effort) } : {}),
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: c.packet },
              ],
              schema: DecisionOutputSchema,
              schemaName: 'decision',
              formatInPrompt: true,
              prepare: (j: unknown) => tidyDecision(j, { me: c.who, isSkill: (x: string) => Boolean(getSkill(x)) }),
              fallback: () => null,
            });
            const d = r.ok ? r.value : null;
            const a = actOf(d);
            const res: BenchResult = {
              setup,
              caseId: c.id,
              rep,
              ok: r.ok,
              ...(r.ok ? {} : { reason: `${r.reason}${r.error ? `: ${r.error.slice(0, 160)}` : ''}` }),
              truncated: Boolean(r.ok && r.truncated),
              ms: r.ms,
              verdict: r.ok ? verdict(c, d) : 'invalid',
              ...(a ? { act: `${a.act}${a.args.length > 0 ? ` ${a.args.join(' ')}` : ''}` } : {}),
              ...(d && typeof (d as { thought?: unknown }).thought === 'string' ? { thought: String((d as { thought: string }).thought).slice(0, 400) } : {}),
            };
            show(setup, res);
            return res;
          }),
        ),
      );
      results.push(...(await pool([...checkJobs, ...mindJobs], args.concurrency)));
      console.log(`\n${kind}: setup | valid | cut | p50 ms | p90 ms | score | good | bad`);
      for (const s of summarize(results.filter((r) => ids.includes(r.caseId)))) {
        console.log(`  ${s.setup.padEnd(36)} ${s.valid}/${s.n} | ${s.cutOff} | ${s.msP50 ?? '-'} | ${s.msP90 ?? '-'} | ${s.score.toFixed(2)} | ${s.good} | ${s.bad}`);
      }
    }
  } finally {
    rt.stop();
  }
  const dir = path.join(repoRoot(), 'data', 'bench');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `thoughts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ args, results, summary: summarize(results) }, null, 2));
  console.log(`\nEvery reply: ${file}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
