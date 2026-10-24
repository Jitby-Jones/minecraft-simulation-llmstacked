// Urges (owner request, 2026-10-24): what the controller pushes, taken by the agent as its own. A talk going round in
// circles is left with a goodbye and a walk away from those in it, who are let be a while; what keeps failing is given
// up whatever its other arguments; a paused agent or one in danger is not pushed. The thought is on its mind as its own.

import { describe, expect, it } from 'vitest';
import { type ActionRecord, type DecisionOutput, PersonaSchema, type Utterance, type Volume, nullLogger } from '@agora/shared';
import type { Body } from '@agora/agent/body/body';
import type { Bot } from '@agora/agent/body/bot';
import { ChatOut } from '@agora/agent/body/chatOut';
import { AgentBus } from '@agora/agent/bus';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { Conversations } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { Talking } from '@agora/agent/modules/talking';
import { GIVE_UP_MS, HOLD_OFF_MS, applyUrge } from '@agora/agent/modules/urges';
import { createInitialState } from '@agora/agent/state/initial';
import { AgentStateStore } from '@agora/agent/state/store';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'male', traits: ['curious'] });

function heard(bus: AgentBus, store: AgentStateStore, from: string, text: string): void {
  const u: Utterance = { id: `u${Math.random()}`, convId: '', from, to: ['Pip'], text, ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: true, heardAs: 'me' };
  store.update('perception', (p) => ({ ...p, heardSpeech: [...p.heardSpeech, u] }), 'test');
  bus.emit({ type: 'heard', utterance: u });
}

function rig() {
  const store = new AgentStateStore(createInitialState({ persona, username: 'Pip', now: Date.now() }));
  const bus = new AgentBus();
  const said: string[] = [];
  const bot = { chat: (t: string) => void said.push(t), _client: { ended: false } } as unknown as Bot;
  const chat = new ChatOut(bot, { minIntervalMs: 0, msPerChar: 0 });
  const body = {
    chat,
    say: async (t: string, v?: Volume, l?: readonly string[], sw?: () => boolean, urgent?: boolean) => (await chat.say(t, v, l, sw, urgent)).sent,
    skill: () => null,
    run: () => Promise.reject(new Error('unused')),
  } as unknown as Body;
  const conversations = new Conversations({ store, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Mira'], rng: () => 0 });
  const executor = new SkillExecutor({ store, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
  const talking = new Talking({ store, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Pip', rng: () => 0.5 });
  const awareness = new ActionAwareness({ store, bus, logger: nullLogger() });
  const impulses: DecisionOutput[] = [];
  const triggers: { reason: string; urgent: boolean }[] = [];
  const aborted: string[] = [];
  let busy = false;
  const cc = {
    impulse: (d: DecisionOutput) => {
      impulses.push(d);
      return true;
    },
    trigger: (reason: string, ctx: { urgent?: boolean } = {}) => void triggers.push({ reason, urgent: ctx.urgent === true }),
  };
  const exec = {
    get busy() {
      return busy;
    },
    abort: (why: string) => void aborted.push(why),
  };
  conversations.start();
  talking.start();
  awareness.start();
  const deps = { store, talking, awareness, cc, executor: exec, logger: nullLogger() };
  const stop = () => {
    talking.stop();
    conversations.stop();
    awareness.stop();
  };
  return { store, bus, said, conversations, awareness, impulses, triggers, aborted, deps, setBusy: (b: boolean) => (busy = b), stop };
}

describe('urges, taken as its own', () => {
  it('moving on from a talk: a goodbye, the talk ended, its people let be a while, the thought on its mind, a walk away from them', async () => {
    const x = rig();
    heard(x.bus, x.store, 'Mira', 'Pip, so we build a house right?');
    expect(x.conversations.active()).toHaveLength(1);
    const done = await applyUrge(x.deps, { act: 'move_on', thought: "We've agreed on the house twice over; time I went and got the wood", say: 'aight gonna go get wood', avoid: [] });
    x.stop();
    expect(done).toBe('moved on from Mira, walking off');
    expect(x.said.some((l) => /aight gonna go get wood/.test(l))).toBe(true);
    expect(x.conversations.active()).toEqual([]);
    expect(Object.values(x.store.state.conversations)[0]?.endedReason).toBe('moved on');
    expect(x.conversations.mayInitiate('Mira')).toBe(false);
    expect(HOLD_OFF_MS).toBeGreaterThanOrEqual(3 * 60_000);
    expect(x.store.state.workmem.at(-1)).toMatchObject({ text: "We've agreed on the house twice over; time I went and got the wood", source: 'self_observed' });
    expect(x.impulses).toEqual([{ option: 'work', task: { skill: 'wander', args: { radius: 20, seconds: 40, avoid: ['Mira'] } }, terminate: { maxSeconds: 55 }, rationale: "We've agreed on the house twice over; time I went and got the wood" }]);
  });

  it('giving up what keeps failing: that skill for that thing, whatever its other arguments, until it works again', async () => {
    const x = rig();
    x.setBusy(true);
    const done = await applyUrge(x.deps, { act: 'drop_task', thought: "Crafting an iron pickaxe isn't working; I'll do something else for now", avoid: [], task: { skill: 'craft', item: 'iron_pickaxe' } });
    expect(done).toBe('gave up on craft iron_pickaxe');
    expect(x.aborted).toEqual(['giving up on it']);
    expect(x.triggers).toEqual([{ reason: "Crafting an iron pickaxe isn't working; I'll do something else for now", urgent: true }]);
    expect(x.awareness.isStuckOn('craft', { item: 'iron_pickaxe', qty: 3 })).toBe(true);
    expect(x.awareness.isStuckOn('craft', { item: 'stone_pickaxe' })).toBe(false);
    expect(x.awareness.stuckList().some((l) => /craft iron_pickaxe \(any way\)/.test(l))).toBe(true);
    expect(GIVE_UP_MS).toBeGreaterThanOrEqual(10 * 60_000);
    // It works after all (the iron came): given up no more.
    const rec: ActionRecord = { id: 'a1', skill: 'craft', args: { item: 'iron_pickaxe', qty: 1 }, startedAt: Date.now(), durationMs: 2000, ok: true, expected: '+1 iron_pickaxe', observed: '+1 iron_pickaxe', progressed: true } as unknown as ActionRecord;
    x.bus.emit({ type: 'actionRecorded', record: rec });
    expect(x.awareness.isStuckOn('craft', { item: 'iron_pickaxe', qty: 3 })).toBe(false);
    x.stop();
  });

  it('walking out of a spot, thinking again; and nothing while paused or in danger', async () => {
    const x = rig();
    x.setBusy(true);
    expect(await applyUrge(x.deps, { act: 'wander', thought: "I've been stuck here too long; I should move", avoid: [] })).toBe('walking a little way');
    expect(x.aborted).toEqual(['had enough of it']);
    expect(x.impulses[0]?.task).toEqual({ skill: 'wander', args: { radius: 12, seconds: 30 } });
    expect(await applyUrge(x.deps, { act: 'rethink', thought: 'I keep changing my mind; I should pick one thing', avoid: [] })).toBe('thinking again');
    expect(x.triggers.at(-1)).toEqual({ reason: 'I keep changing my mind; I should pick one thing', urgent: true });
    x.store.update('flags', (f) => ({ ...f, paused: true }), 'test');
    expect(await applyUrge(x.deps, { act: 'rethink', thought: 'hmm', avoid: [] })).toBe('not now: paused');
    x.store.update('flags', (f) => ({ ...f, paused: false, inDanger: true }), 'test');
    expect(await applyUrge(x.deps, { act: 'rethink', thought: 'hmm', avoid: [] })).toBe('not now: in danger');
    expect(x.triggers).toHaveLength(1);
    x.stop();
  });
});
