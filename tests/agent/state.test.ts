// M2: the Agent State blackboard with versioning and abort-on-stale guards (§4.1, §4.2).

import { describe, expect, it } from 'vitest';
import { Vec3 } from '@agora/agent/body/bot';
import { PersonaSchema } from '@agora/shared';
import { createInitialState } from '@agora/agent/state/initial';
import { CC_POLICY, SUMMARY_POLICY, talkPolicy } from '@agora/agent/state/policies';
import { AgentStateStore, type StateChange, deepFreeze } from '@agora/agent/state/store';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['careful'], lifeGoals: ['build a house'], drives: { caution: 0.7 } });
const fresh = () => new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 1000 }));

describe('AgentStateStore', () => {
  it('starts from the persona', () => {
    const s = fresh().state;
    expect(s.version).toBe(0);
    expect(s.goals.life).toEqual(['build a house']);
    expect(s.drives).toMatchObject({ caution: 0.7, cautionBaseline: 0.7 });
    expect(s.life).toMatchObject({ born: false, startedAt: 1000 });
  });

  it('bumps the global and facet versions on every real change, not on no-ops', () => {
    const store = fresh();
    const events: StateChange[] = [];
    store.on('change', (c) => events.push(c));
    store.update('flags', (f) => ({ ...f, stuck: true }), 'stuck');
    store.update('flags', (f) => f);
    store.set('selfSummary', 'chopping wood');
    expect(store.version).toBe(2);
    expect(store.facetVersion('flags')).toBe(1);
    expect(store.facetVersion('selfSummary')).toBe(1);
    expect(events.map((e) => [e.facet, e.version, e.reason])).toEqual([
      ['flags', 1, 'stuck'],
      ['selfSummary', 2, 'selfSummary'],
    ]);
    expect(events[0]?.prev.flags.stuck).toBe(false);
  });

  it('hands out immutable snapshots that later writes do not touch', () => {
    const store = fresh();
    const before = store.state;
    store.update('workmem', (w) => [...w, { id: 'w1', text: 'saw a creeper', ts: 1, salience: 0.8, source: 'self_observed' }]);
    expect(before.workmem).toHaveLength(0);
    expect(store.state.workmem).toHaveLength(1);
    expect(() => (store.state.workmem as unknown[]).push({})).toThrow(TypeError);
    expect(() => {
      (store.state.flags as { stuck: boolean }).stuck = true;
    }).toThrow(TypeError);
  });

  it('freezes plain data but leaves library objects (live Vec3s) alone', () => {
    const live = new Vec3(1, 2, 3);
    const frozen = deepFreeze({ a: { b: [1, 2] }, live });
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
    live.x = 5;
    expect(frozen.live.x).toBe(5);
  });

  it('counts changes since a stamp', () => {
    const store = fresh();
    const stamp = store.stamp();
    store.set('selfSummary', 'a');
    store.set('selfSummary', 'b');
    store.update('flags', (f) => ({ ...f, stuck: true }));
    expect(store.changesSince(stamp, ['selfSummary'])).toBe(2);
    expect(store.changesSince(stamp, ['selfSummary', 'flags', 'goals'])).toBe(3);
  });
});

describe('call guards (abort-on-stale)', () => {
  it('aborts a CC call when danger starts', () => {
    const store = fresh();
    const g = store.guard(CC_POLICY);
    store.update('flags', (f) => ({ ...f, busyLevel: 'working' }));
    expect(g.signal.aborted).toBe(false);
    store.update('flags', (f) => ({ ...f, inDanger: true }));
    expect(g.signal.aborted).toBe(true);
    expect(g.isStale()).toBe(true);
    expect(g.reason()).toBe('danger');
    g.dispose();
    expect(store.listenerCount('change')).toBe(0);
  });

  it('aborts a Talking call when its conversation ends, not when another one does', () => {
    const store = fresh();
    const conv = (id: string, status: 'active' | 'ended') => ({
      convId: id,
      participants: ['Pip', 'Bram'],
      startedAt: 0,
      lastActivity: 0,
      turns: 1,
      myTurns: 0,
      lastEmbeds: [],
      status,
      transcript: [],
      initiatedByMe: false,
    });
    store.set('conversations', { c1: conv('c1', 'active'), c2: conv('c2', 'active') });
    const g = store.guard(talkPolicy('c1'));
    store.set('conversations', { ...store.state.conversations, c2: conv('c2', 'ended') });
    expect(g.signal.aborted).toBe(false);
    store.set('conversations', { ...store.state.conversations, c1: conv('c1', 'ended') });
    expect(g.reason()).toBe('conversation ended');
  });

  it('goes stale at reply time when too much changed, without aborting', () => {
    const store = fresh();
    const g = store.guard(SUMMARY_POLICY);
    for (let i = 0; i < 24; i++) store.set('workmem', []);
    store.set('workmem', [{ id: 'x', text: 'x', ts: 0, salience: 0.1, source: 'inferred' }]);
    expect(g.isStale()).toBe(false);
    for (let i = 0; i < 30; i++) store.update('workmem', (w) => [...w]);
    expect(g.signal.aborted).toBe(false);
    expect(g.isStale()).toBe(true);
    expect(g.reason()).toMatch(/changes to workmem/);
  });

  it('follows a parent (shutdown) signal', () => {
    const store = fresh();
    const parent = new AbortController();
    const g = store.guard(CC_POLICY, parent.signal);
    parent.abort();
    expect(g.signal.aborted).toBe(true);
    expect(g.reason()).toBe('shut down');
  });
});
