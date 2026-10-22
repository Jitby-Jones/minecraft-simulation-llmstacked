// M7: an agent's telemetry for the dashboard (§8 `telemetry`, dashboard only). Decisions go out with their
// rationale, actions and fights as they happen, our own lines as the chat echoes them, new commitments once, and
// the state and the view of people on a timer. Nothing comes back.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PersonaSchema, type TelemetryKind } from '@agora/shared';
import type { Agent } from '@agora/agent';
import type { Bot } from '@agora/agent/body/bot';
import { AgentBus } from '@agora/agent/bus';
import { startTelemetry } from '@agora/agent/hub/telemetry';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['kind'] });

function rig() {
  const store = new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
  store.update('social', (all) => ({ ...all, Rex: { ...newSocialProfile('Rex', persona, 0), sentiment: 3 } }));
  store.update('conflict', (c) => ({ ...c, rungs: { Rex: 2 } }));
  const bus = new AgentBus();
  const agent = { name: 'Pip', bus, store } as unknown as Agent;
  const bot = new EventEmitter();
  const sent: { kind: TelemetryKind; data: Record<string, unknown> }[] = [];
  const stop = startTelemetry({ agent, bot: bot as unknown as Bot, send: (kind, data) => void sent.push({ kind, data }), stateEveryMs: 60_000, socialEveryMs: 60_000, now: () => 1000 });
  return { store, bus, bot, sent, stop, kinds: () => sent.map((s) => s.kind) };
}

describe('telemetry (M7)', () => {
  it('sends the state and the view of people at once, then on a timer', () => {
    const r = rig();
    expect(r.kinds()).toEqual(['state', 'social']);
    const people = r.sent[1]?.data.people as { name: string; sentiment: number; rung: number; resentment: number }[];
    expect(people[0]).toMatchObject({ name: 'Rex', sentiment: 3, rung: 2 });
    expect(people[0]?.resentment).toBeGreaterThan(0);
    expect(r.sent[0]?.data).toMatchObject({ rungs: { Rex: 2 }, goal: null, option: null, leader: null });
    r.stop();
  });

  it('reports decisions with why, actions, fights and our own lines, and commitments once', () => {
    const r = rig();
    r.sent.length = 0;
    r.bus.emit({ type: 'decision', decision: { id: 'd1', createdAt: 0, stateVersion: 3, source: 'llm', option: 'talk', target: { agent: 'Rex' }, speechIntent: { stance: 'threaten', gist: 'back off', mayCommit: false }, terminate: { maxSeconds: 30 }, rationale: 'Rex keeps taking my logs' } });
    r.bus.emit({ type: 'actionRecorded', record: { id: 'a', skill: 'duel', args: { target: 'Rex' }, expected: '', observed: 'Rex gave up', ok: true, ts: 0, durationMs: 9000, data: { outcome: 'won' } } });
    r.bus.emit({ type: 'rungChanged', name: 'Rex', from: 2, to: 3 });
    r.bus.emit({ type: 'optionTerminated', reason: 'done', ok: true, option: 'fight', targetAgent: 'Rex' });
    r.bot.emit('messagestr', 'Pip » back off, or else.');
    r.bot.emit('messagestr', 'Rex » make me');
    r.store.update('commitments', (cs) => [...cs, { id: 'c1', debtor: 'Pip', creditor: 'Ann', what: { kind: 'give', item: 'bread', qty: 2, text: '2 bread' }, status: 'accepted', createdFromConv: '', createdAt: 0 }]);
    r.store.update('self', (s) => ({ ...s, health: 19 }));
    expect(r.kinds()).toEqual(['decision', 'skill', 'fight', 'fight', 'option', 'utterance', 'commitment']);
    expect(r.sent[0]?.data).toMatchObject({ source: 'llm', option: 'talk', target: 'Rex', stance: 'threaten', rationale: 'Rex keeps taking my logs' });
    expect(r.sent[2]?.data).toEqual({ kind: 'duel', with: 'Rex', outcome: 'won', lethal: false });
    expect(r.sent[3]?.data).toEqual({ kind: 'rung', with: 'Rex', from: 2, to: 3 });
    expect(r.sent[5]?.data).toEqual({ text: 'back off, or else.', volume: 'normal' });
    expect(r.sent[6]?.data).toMatchObject({ debtor: 'Pip', creditor: 'Ann', text: '2 bread', kind: 'give', status: 'accepted' });
    // §17.7, §17.8: following someone, and walking away from them.
    r.bus.emit({ type: 'leaderChanged', leader: 'Rex', before: null });
    r.bus.emit({ type: 'defected', from: 'Rex', attackers: ['Ann', 'Bo'] });
    expect(r.sent.slice(7).map((x) => x.data)).toEqual([
      { kind: 'follow', leader: 'Rex', before: null },
      { kind: 'defect', from: 'Rex', attackers: ['Ann', 'Bo'] },
    ]);
    r.stop();
    r.bus.emit({ type: 'rungChanged', name: 'Rex', from: 3, to: 2 });
    r.bot.emit('messagestr', 'Pip » bye');
    expect(r.kinds()).toHaveLength(9);
  });
});
