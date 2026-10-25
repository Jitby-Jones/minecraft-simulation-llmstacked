// `pnpm bench-models` (§11 latency check, §22.3): sends representative prompts per tier to allowlisted candidate
// models through the subscription-locked client and writes config/model-bench.json, which `auto` tier resolution
// prefers over price heuristics. Bench hygiene: allowlisted models only, subscription path only, and it refuses to
// run when the quota is tight.
//
//   pnpm bench-models [--count 10] [--tier L1 --tier L2] [--models id1,id2] [--dry-run]

import path from 'node:path';
import { z } from 'zod';
import { createLogger, loadEnv, loadModelsConfig, repoRoot, requireNanoGptKey, writeFileAtomic } from '@agora/shared';
import {
  type ChatMessage,
  ModelAllowlist,
  TIERS,
  type TierName,
  createGuardedFetch,
  fetchSubscriptionModels,
  loadBenchFile,
  resolveTiers,
  startLlm,
  tierRuntimes,
} from '@agora/llm';
import { PLAN_FORMAT, PlanOutputSchema, tidyPlan } from '@agora/agent/modules/goalGen';
import { type BenchSample, mergeBench, summarizeBench } from './lib/bench';

const BENCH_FILE = path.join(repoRoot(), 'config', 'model-bench.json');
const SKILLS = ['gather', 'mine', 'craft', 'goTo', 'say', 'eat', 'shelter', 'give'];

interface Args {
  count: number;
  tiers: TierName[];
  models: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { count: 10, tiers: [], models: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--count') a.count = Math.max(1, Math.min(50, Number(argv[++i] ?? 10)));
    else if (v === '--tier') {
      const t = argv[++i];
      if (t === 'L1' || t === 'L2' || t === 'L3') a.tiers.push(t);
    } else if (v === '--models') a.models.push(...(argv[++i] ?? '').split(',').filter(Boolean));
    else if (v === '--dry-run') a.dryRun = true;
  }
  if (a.tiers.length === 0) a.tiers = [...TIERS];
  return a;
}

const Decision = z.object({
  option: z.enum(['work', 'talk', 'move', 'rest', 'explore', 'flee']),
  task: z.object({ skill: z.string(), args: z.record(z.string(), z.unknown()) }).optional(),
  rationale: z.string().max(200),
});
const Summary = z.object({ summary: z.string().min(1).max(400) });

const situations = [
  'It is early morning. You have 2 oak logs and nothing else. Bram is 6 blocks away chopping trees.',
  'Night is falling. You have a stone sword, 3 bread and 5 dirt. A zombie groaned somewhere nearby.',
  'You promised Bram 8 logs by sunset. You have 3 logs. Trees are 20 blocks north.',
  'You are hungry (food 6/20) and carry 2 raw beef and a furnace. Coal is in your inventory.',
  'Mira asked you where to find iron. You saw iron ore in the ravine east of the village yesterday.',
];

function prompt(tier: TierName, i: number): { messages: ChatMessage[]; kind: 'decision' | 'summary' | 'plan' | 'talk' } {
  const s = situations[i % situations.length] ?? '';
  const sys: ChatMessage = { role: 'system', content: 'You are Pip, a careful, friendly builder in a Minecraft village. Keep it short.' };
  if (tier === 'L1') {
    return i % 2 === 0
      ? { kind: 'talk', messages: [sys, { role: 'user', content: `${s}\nBram says: "hey, how's it going?" Reply in one short line.` }] }
      : { kind: 'summary', messages: [sys, { role: 'user', content: `${s}\nSummarize your situation in one sentence as JSON {"summary": "..."}.` }] };
  }
  if (tier === 'L2') {
    return {
      kind: 'decision',
      messages: [
        sys,
        {
          role: 'user',
          content: `${s}\nSkills: ${SKILLS.join(', ')}. Decide what to do next as JSON {"option", "task"?: {"skill", "args"}, "rationale"}.`,
        },
      ],
    };
  }
  // L3 plans (Goal Gen): its own prompt and format, as agents send them.
  return {
    kind: 'plan',
    messages: [
      {
        role: 'system',
        content: `${sys.content} You value hard work and friendship and want to build a proper home.\n\nMake your own plan for the next half hour or so: what you want to get done, as 2–6 concrete steps, your way. Think about what you have and see around you, the time of day, how you feel, what the others are doing and what you have talked over with them. Don't just do things in the usual order; do what fits you.\n${PLAN_FORMAT}`,
      },
      { role: 'user', content: `Why now: starting.\n${s}\nPeople you know: Bram (you feel 6/10; seems to want stone tools), Mira (you feel 7/10).\nYou have no plan yet.` },
    ],
  };
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const config = loadModelsConfig();
  const logger = createLogger({ name: 'bench', console: true });
  const previous = loadBenchFile(BENCH_FILE, logger);

  if (args.dryRun) {
    const list = await fetchSubscriptionModels(createGuardedFetch(), undefined, AbortSignal.timeout(15_000));
    const res = resolveTiers(new ModelAllowlist(list), tierRuntimes(config), previous);
    for (const t of args.tiers) console.log(`${t}: ${[...new Set([...res.own[t], ...args.models])].join(', ')}`);
    console.log(`\n${args.count} prompt(s) per model and tier would be sent. Run without --dry-run to measure.`);
    return;
  }

  const apiKey = requireNanoGptKey();
  const rt = await startLlm({ apiKey, config, logger, bench: previous, background: false });
  try {
    const q = rt.quota.view;
    const count = args.count;
    const plan = args.tiers.map((t) => ({ tier: t, models: [...new Set([...rt.router.resolution.own[t], ...args.models])] }));
    const calls = plan.reduce((a, p) => a + p.models.length * count, 0);
    const estimate = calls * 400;
    console.log(`Benchmarking ${calls} calls (≈${estimate} input tokens; weekly quota left: ${q?.remaining ?? 'unknown'}).`);
    const samples: BenchSample[] = [];
    for (const { tier, models } of plan) {
      for (const model of models) {
        if (!rt.router.allowlist.has(model)) {
          console.log(`  skip ${model}: not in the subscription list`);
          continue;
        }
        for (let i = 0; i < count; i++) {
          const p = prompt(tier, i);
          const t0 = Date.now();
          let ttft: number | undefined;
          if (p.kind === 'talk') {
            const r = await rt.client.call<string>({
              tier,
              module: 'bench',
              agent: 'bench',
              model,
              messages: p.messages,
              fallback: () => '',
              onText: () => (ttft ??= Date.now() - t0),
            });
            samples.push({ model, tier, ms: Date.now() - t0, ok: r.ok, ttftMs: ttft });
            continue;
          }
          const schema = p.kind === 'decision' ? Decision : p.kind === 'summary' ? Summary : PlanOutputSchema;
          const r = await rt.client.call<unknown>({
            tier,
            module: 'bench',
            agent: 'bench',
            model,
            messages: p.messages,
            schema,
            ...(p.kind === 'plan' ? { schemaName: 'plan', formatInPrompt: true, prepare: tidyPlan } : {}),
            fallback: () => null,
          });
          const toolOk =
            p.kind === 'decision' && r.ok
              ? (() => {
                  const d = r.value as z.infer<typeof Decision>;
                  return d.option !== 'work' || (d.task !== undefined && SKILLS.includes(d.task.skill));
                })()
              : undefined;
          samples.push({ model, tier, ms: Date.now() - t0, ok: r.ok, json: r.ok, ...(toolOk !== undefined ? { toolOk } : {}) });
        }
        const mine = summarizeBench(samples.filter((s) => s.model === model && s.tier === tier))[0];
        console.log(`  ${tier} ${model}: ok ${mine?.okRate} json ${mine?.jsonOkRate} p50 ${mine?.p50Ms} ms p90 ${mine?.p90Ms} ms`);
      }
    }
    const file = mergeBench(previous, summarizeBench(samples), new Date().toISOString());
    writeFileAtomic(BENCH_FILE, `${JSON.stringify(file, null, 2)}\n`);
    const res = resolveTiers(rt.router.allowlist, tierRuntimes(config), file);
    console.log(`\nWrote ${path.relative(repoRoot(), BENCH_FILE)}. Tier chains with these results:`);
    for (const t of TIERS) console.log(`  ${t}: ${res.chains[t].join(', ')}`);
  } finally {
    rt.stop();
  }
}

main().catch((err: unknown) => {
  console.error(`[bench-models] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
