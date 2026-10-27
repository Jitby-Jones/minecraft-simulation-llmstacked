// The thought benchmark's scoring (docs/plan-thinking-models.md §5) and its golden cases.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONS, repoRoot } from '@agora/shared';
import { skillNames } from '@agora/agent/body/skills/registry';
import { BenchCaseSchema, actOf, matches, parseSetup, summarize, verdict } from '../../scripts/lib/thought-bench';
import { CHECKS, CheckCaseSchema, checkRequest, checkVerdict } from '../../scripts/lib/check-bench';

describe('the thought benchmark', () => {
  it('reads what a decision does: its task, else its option, with the task’s words', () => {
    expect(actOf({ option: 'work', task: { skill: 'mine', args: { block: 'iron_ore', qty: 3 } } })).toEqual({ act: 'mine', args: ['iron_ore'] });
    expect(actOf({ option: 'rest' })).toEqual({ act: 'rest', args: [] });
    expect(actOf(null)).toBeNull();
    expect(matches('mine', 'mine', ['coal_ore'])).toBe(true);
    expect(matches('mine:iron_ore', 'mine', ['coal_ore'])).toBe(false);
    expect(matches('mine:coal', 'mine', ['coal_ore'])).toBe(true);
  });

  it('scores a plainly wrong choice below one it neither praises nor faults, and that below a good one', () => {
    const c = { good: ['wait', 'place'], bad: ['goTo', 'mine:iron_ore'] };
    expect(verdict(c, { option: 'work', task: { skill: 'place', args: { block: 'dirt' } } })).toBe('good');
    expect(verdict(c, { option: 'move', task: { skill: 'goTo', args: { x: 1, y: 2, z: 3 } } })).toBe('bad');
    expect(verdict(c, { option: 'work', task: { skill: 'mine', args: { block: 'iron_ore' } } })).toBe('bad');
    expect(verdict(c, { option: 'work', task: { skill: 'mine', args: { block: 'coal_ore' } } })).toBe('neutral');
    expect(verdict(c, {})).toBe('invalid');
    const rows = summarize([
      { setup: 'a', caseId: 'x', rep: 0, ok: true, truncated: false, ms: 1000, verdict: 'good' },
      { setup: 'a', caseId: 'y', rep: 0, ok: true, truncated: false, ms: 3000, verdict: 'neutral' },
      { setup: 'a', caseId: 'z', rep: 0, ok: false, truncated: false, ms: 9000, verdict: 'invalid' },
    ]);
    expect(rows[0]).toMatchObject({ setup: 'a', n: 3, valid: 2, score: 0.5, good: 1, bad: 0, msP50: 3000 });
    expect(parseSetup('z-ai/glm-5.3@none')).toEqual({ model: 'z-ai/glm-5.3', effort: 'none' });
    expect(parseSetup('moonshotai/kimi-k2.6')).toEqual({ model: 'moonshotai/kimi-k2.6' });
  });

  it('has golden cases that read, each rubric naming only skills and options there are', () => {
    const known = new Set<string>([...skillNames(), ...OPTIONS]);
    for (const kind of ['mind', 'underFire']) {
      const lines = fs.readFileSync(path.join(repoRoot(), 'bench', 'thoughts', `${kind}.jsonl`), 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(kind === 'mind' ? 24 : 10);
      for (const l of lines) {
        const c = BenchCaseSchema.parse(JSON.parse(l));
        expect(c.kind).toBe(kind);
        expect(c.packet).toContain('Why you are thinking now');
        for (const e of [...c.good, ...c.bad]) expect(known, `${c.id}: ${e}`).toContain(e.split(':')[0]);
        expect(c.good.filter((g) => c.bad.includes(g)), c.id).toEqual([]);
      }
    }
  });

  it('asks the quick checks as the agents do, and scores them on the answer a person would give', () => {
    const lines = fs.readFileSync(path.join(repoRoot(), 'bench', 'thoughts', 'check.jsonl'), 'utf8').split('\n').filter(Boolean);
    const cases = lines.map((l) => CheckCaseSchema.parse(JSON.parse(l)));
    expect(new Set(cases.map((c) => c.check))).toEqual(new Set(CHECKS));
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      const q = checkRequest(c);
      expect(q.messages[0]?.role, c.id).toBe('system');
      expect(q.messages[1]?.content.length, c.id).toBeGreaterThan(5);
    }
    const byId = (id: string) => cases.find((c) => c.id === id) ?? (() => { throw new Error(id); })();
    // The prompt the talking module sends, the line and who is about.
    expect(checkRequest(byId('c-addr-named-ask')).messages[1]?.content).toBe('Bram said: "ada can you grab some wood?". People around: Bram.');
    expect(checkVerdict(byId('c-addr-named-ask'), { addressedToMe: true })).toBe('good');
    expect(checkVerdict(byId('c-addr-anyone'), { addressedToMe: true })).toBe('bad');
    expect(checkVerdict(byId('c-set-house'), { settled: true, what: 'build the house', mine: '' })).toBe('good');
    expect(checkVerdict(byId('c-set-against'), { settled: true })).toBe('bad');
    expect(checkVerdict(byId('c-pro-give-iron'), { promises: [{ what: { kind: 'give', item: 'iron_ingot', qty: 3, text: '3 iron' } }] })).toBe('good');
    expect(checkVerdict(byId('c-pro-share-work'), { promises: [{ what: { kind: 'give', item: 'oak_log', text: 'wood' } }] })).toBe('bad');
    expect(checkVerdict(byId('c-pro-share-work'), { promises: [{ what: { kind: 'custom', text: 'get the wood' } }] })).toBe('good');
    expect(checkVerdict(byId('c-pro-nothing'), { promises: [{ what: { kind: 'custom', text: 'weather' } }] })).toBe('bad');
    expect(checkVerdict(byId('c-kept-wandered'), { kept: false, why: 'wandered' })).toBe('good');
    expect(checkVerdict(byId('c-sum-night'), { summary: 'word '.repeat(130) })).toBe('neutral');
    expect(checkVerdict(byId('c-merge-river'), null)).toBe('invalid');
  });
});
