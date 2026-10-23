// The agent's own plan (§4.2 module 10, Goal Gen): a few steps toward what it means to get done over the next half
// hour or so, made by the agent itself (the model, or the code default without one) and changed as it goes and
// after talking things over with others. The step being worked on is the current goal.

import type { AgentState, Plan, PlanStep } from '@agora/shared';

/** The step being worked on, or else the next one to do. */
export function currentStep(plan: Plan | null | undefined): PlanStep | null {
  if (!plan) return null;
  return plan.steps.find((s) => s.status === 'doing') ?? plan.steps.find((s) => s.status === 'todo') ?? null;
}

/** Every step done or dropped. */
export function planFinished(plan: Plan | null | undefined): boolean {
  return !plan || plan.steps.every((s) => s.status === 'done' || s.status === 'dropped');
}

/** The plan with the next step to do begun (status doing). */
export function beginNext(plan: Plan, now: number): Plan {
  if (plan.steps.some((s) => s.status === 'doing')) return plan;
  const i = plan.steps.findIndex((s) => s.status === 'todo');
  if (i < 0) return plan;
  return { ...plan, steps: plan.steps.map((s, j) => (j === i ? { ...s, status: 'doing' as const } : s)), updatedAt: now };
}

/** The plan with its current step done (or dropped) and the next one begun. */
export function advancePlan(plan: Plan, status: 'done' | 'dropped', now: number): Plan {
  const i = plan.steps.findIndex((s) => s.status === 'doing');
  const steps = i < 0 ? plan.steps : plan.steps.map((s, j) => (j === i ? { ...s, status } : s));
  return beginNext({ ...plan, steps, updatedAt: now }, now);
}

/** "build a hut by the river: 1. get 16 logs (done) 2. make planks (doing now) 3. build the hut" */
export function describePlan(plan: Plan): string {
  const mark: Readonly<Record<PlanStep['status'], string>> = { todo: '', doing: ' (doing now)', done: ' (done)', dropped: ' (dropped)' };
  return `${plan.aim.replace(/[\s.!?;:,]+$/, '')}: ${plan.steps.map((s, i) => `${i + 1}. ${s.text.replace(/[\s;,]+$/, '')}${mark[s.status]}`).join(' ')}`;
}

/** The plan as the prompts put it, or '' when there is none. */
export function planText(s: AgentState): string {
  const p = s.goals.plan;
  return p ? describePlan(p) : '';
}
