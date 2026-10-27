// The quick checks for `pnpm bench-thoughts --kind check` (docs/plan-thinking-models.md §5): each case is asked as the
// agents ask it (the modules' own prompts and schemas) and scored on the answer a person would give: meant for me or
// not, settled or not, a hand-over promised or not, kept or not; a summary or a merged memory only on being usable.

import { z } from 'zod';
import { type LlmModule, PersonaSchema } from '@agora/shared';
import type { ChatMessage } from '@agora/llm';
import { AddressedSchema, addressedMessages } from '@agora/agent/modules/talking';
import { SettledSchema, settledMessages } from '@agora/agent/modules/consensus';
import { PromisesSchema, promiseMessages } from '@agora/agent/social/awareness';
import { JudgmentSchema, judgmentMessages } from '@agora/agent/social/commitments';
import { SummarySchema, summaryMessages } from '@agora/agent/modules/selfMonitor';
import { MergedSchema, mergeMessages } from '@agora/agent/memory/memory';
import type { Verdict } from './thought-bench';

export const CHECKS = ['addressed', 'settled', 'promises', 'judgment', 'summary', 'merge'] as const;

export const CheckCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('check'),
  check: z.enum(CHECKS),
  input: z.record(z.string(), z.unknown()),
  /** The answer a person would give (addressedToMe, settled, give, empty, kept); none for a summary or a merge. */
  expect: z.record(z.string(), z.unknown()).default({}),
  note: z.string(),
});
export type CheckCase = z.infer<typeof CheckCaseSchema>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export interface CheckRequest {
  module: LlmModule;
  messages: ChatMessage[];
  schema: z.ZodType;
  schemaName: string;
}

/** The request as the agent's module makes it. */
export function checkRequest(c: CheckCase): CheckRequest {
  const i = c.input;
  switch (c.check) {
    case 'addressed':
      return { module: 'talking', schema: AddressedSchema, schemaName: 'addressed', messages: addressedMessages(str(i.me), str(i.from), str(i.text), strs(i.around)) };
    case 'settled': {
      const lines = Array.isArray(i.lines) ? (i.lines as { who?: unknown; text?: unknown }[]).map((l) => ({ who: str(l.who), text: str(l.text) })) : [];
      return { module: 'talking', schema: SettledSchema, schemaName: 'settled', messages: settledMessages(str(i.me), lines) };
    }
    case 'promises':
      return { module: 'social', schema: PromisesSchema, schemaName: 'promises', messages: promiseMessages(str(i.partner), str(i.transcript)) };
    case 'judgment':
      return { module: 'social', schema: JudgmentSchema, schemaName: 'judgment', messages: judgmentMessages(str(i.debtor), str(i.promised), strs(i.seen)) };
    case 'summary': {
      const persona = PersonaSchema.parse({ name: str(i.name), sex: str(i.sex) || 'female', traits: strs(i.traits) });
      return { module: 'selfMonitor', schema: SummarySchema, schemaName: 'summary', messages: summaryMessages(persona, [], { previous: str(i.previous), goal: str(i.goal), recent: strs(i.recent), onMind: strs(i.onMind) }) };
    }
    case 'merge':
      return { module: 'memory', schema: MergedSchema, schemaName: 'memory', messages: mergeMessages(strs(i.texts)) };
  }
}

/** Right (good), wrong (bad), or usable but off (neutral); no reply is 'invalid'. */
export function checkVerdict(c: CheckCase, value: unknown): Verdict {
  if (!value || typeof value !== 'object') return 'invalid';
  const v = value as Record<string, unknown>;
  const e = c.expect;
  switch (c.check) {
    case 'addressed':
      return v.addressedToMe === e.addressedToMe ? 'good' : 'bad';
    case 'settled':
      return v.settled === e.settled ? 'good' : 'bad';
    case 'judgment':
      return v.kept === e.kept ? 'good' : 'bad';
    case 'promises': {
      const kinds = (Array.isArray(v.promises) ? (v.promises as { what?: { kind?: unknown } }[]) : []).map((p) => p.what?.kind);
      if (e.empty === true && kinds.length > 0) return 'bad';
      if (e.give === true && !kinds.includes('give')) return 'bad';
      if (e.give === false && kinds.includes('give')) return 'bad';
      return 'good';
    }
    case 'summary':
      return words(str(v.summary)) <= 120 ? 'good' : 'neutral';
    case 'merge':
      return words(str(v.text)) <= 40 ? 'good' : 'neutral';
  }
}
