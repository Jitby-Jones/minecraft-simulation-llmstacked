// Scoring for `pnpm bench-thoughts` (docs/plan-thinking-models.md §5): what a decision does, and whether that is a
// choice a sensible player might make in the case, a plainly wrong one, or neither. The rubric only picks models; no
// part of it ever reaches an agent's prompt.

import { z } from 'zod';

export const BenchCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['mind', 'underFire']),
  who: z.string().min(1),
  sex: z.enum(['male', 'female']),
  traits: z.array(z.string()),
  /** The packet the mind saw (a saved one), its "why now" at the end. */
  packet: z.string().min(1),
  /** What a sensible player might do here: a skill or option name, or `skill:arg` for one with that argument. */
  good: z.array(z.string()),
  /** What is plainly wrong here, in the same form. Anything in neither list scores half. */
  bad: z.array(z.string()),
  note: z.string(),
  /** Where it came from (run#line). */
  from: z.string().optional(),
});
export type BenchCase = z.infer<typeof BenchCaseSchema>;

export type Verdict = 'good' | 'bad' | 'neutral' | 'invalid';

/** What a decision does: its task's skill, or else its option; and the task's string arguments. */
export function actOf(decision: unknown): { act: string; args: string[] } | null {
  if (!decision || typeof decision !== 'object') return null;
  const d = decision as { option?: unknown; task?: { skill?: unknown; args?: unknown } };
  const skill = typeof d.task?.skill === 'string' ? d.task.skill : null;
  const option = typeof d.option === 'string' ? d.option : null;
  const act = skill ?? option;
  if (!act) return null;
  const args = d.task?.args && typeof d.task.args === 'object' ? Object.values(d.task.args as Record<string, unknown>).filter((v): v is string => typeof v === 'string') : [];
  return { act, args };
}

/** `mine` matches the act mine; `mine:iron_ore` only a mine with an argument naming iron_ore. */
export function matches(entry: string, act: string, args: readonly string[]): boolean {
  const [name, arg] = entry.split(':') as [string, string | undefined];
  if (name !== act) return false;
  return arg === undefined || args.some((a) => a.toLowerCase().includes(arg.toLowerCase()));
}

export function verdict(c: Pick<BenchCase, 'good' | 'bad'>, decision: unknown): Verdict {
  const a = actOf(decision);
  if (!a) return 'invalid';
  if (c.bad.some((e) => matches(e, a.act, a.args))) return 'bad';
  if (c.good.some((e) => matches(e, a.act, a.args))) return 'good';
  return 'neutral';
}

export const SCORE: Readonly<Record<Verdict, number>> = { good: 1, neutral: 0.5, bad: 0, invalid: 0 };

export interface BenchResult {
  setup: string;
  caseId: string;
  rep: number;
  ok: boolean;
  /** Why no decision came back (stale, failed: …). */
  reason?: string;
  truncated: boolean;
  ms: number;
  verdict: Verdict;
  act?: string;
  thought?: string;
}

const pct = (xs: number[], q: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length > 0 ? Math.round(a[Math.min(a.length - 1, Math.floor(q * a.length))] ?? 0) : null;
};

export interface SetupSummary {
  setup: string;
  n: number;
  valid: number;
  cutOff: number;
  msP50: number | null;
  msP90: number | null;
  /** Mean score over every try, an invalid one scoring 0. */
  score: number;
  good: number;
  bad: number;
}

export function summarize(results: readonly BenchResult[]): SetupSummary[] {
  const setups = [...new Set(results.map((r) => r.setup))];
  return setups.map((setup) => {
    const mine = results.filter((r) => r.setup === setup);
    const valid = mine.filter((r) => r.ok);
    return {
      setup,
      n: mine.length,
      valid: valid.length,
      cutOff: mine.filter((r) => r.truncated).length,
      msP50: pct(valid.map((r) => r.ms), 0.5),
      msP90: pct(valid.map((r) => r.ms), 0.9),
      score: mine.length > 0 ? Math.round((100 * mine.reduce((a, r) => a + SCORE[r.verdict], 0)) / mine.length) / 100 : 0,
      good: mine.filter((r) => r.verdict === 'good').length,
      bad: mine.filter((r) => r.verdict === 'bad').length,
    };
  });
}

/** `model@effort` → its parts; no effort means the thought's own. */
export function parseSetup(s: string): { model: string; effort?: string } {
  const [model, effort] = s.split('@') as [string, string | undefined];
  return effort ? { model, effort } : { model };
}
