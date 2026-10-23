// Debug controls, the agent's side: what an operator's request does to one agent — inspect it, read and edit its
// memories, set its goal or plan, make it do something (checked like the model's own decisions), set a feeling.

import { describe, expect, it } from 'vitest';
import { PersonaSchema, nullLogger } from '@agora/shared';
import { HashEmbedder } from '@agora/llm';
import type { Agent } from '@agora/agent/agent';
import type { Body } from '@agora/agent/body/body';
import { AgentBus } from '@agora/agent/bus';
import { debugOp } from '@agora/agent/hub/debug';
import { MemoryDB } from '@agora/agent/memory/db';
import { Memory } from '@agora/agent/memory/memory';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { CognitiveController } from '@agora/agent/modules/cc';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { GoalGen } from '@agora/agent/modules/goalGen';
import { leversFor } from '@agora/agent/modules/levers';
import { createInitialState } from '@agora/agent/state/initial';
import { AgentStateStore } from '@agora/agent/state/store';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['curious'], lifeGoals: ['map the valley'] });

function agent() {
  const store = new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
  const bus = new AgentBus();
  const said: string[] = [];
  const body = { say: (t: string) => Promise.resolve(said.push(t) > 0), skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
  const executor = new SkillExecutor({ store, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
  executor.start();
  const awareness = new ActionAwareness({ store, bus, logger: nullLogger() });
  const memory = new Memory({ store, bus, logger: nullLogger(), db: new MemoryDB(':memory:'), embedder: new HashEmbedder(), llm: null, me: 'Pip' });
  const cc = new CognitiveController({ store, bus, logger: nullLogger(), llm: null, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => false, memories: (k) => memory.forPacket(k) });
  const goalGen = new GoalGen({ store, bus, logger: nullLogger(), llm: null, me: 'Pip', setGoal: (t, d) => cc.setGoal(t, d), rng: () => 0 });
  const a = { name: 'Pip', store, cc, goalGen, memory, executor, awareness, llm: null, bodyOf: body } as unknown as Agent;
  return { a, store, said, executor };
}

describe('an operator’s debug requests to one agent', () => {
  it('memories: add (kept as the operator’s), list, search, edit, delete; a thought on its mind now', async () => {
    const { a, store } = agent();
    const added = await debugOp(a, 'memory.add', { text: 'Mira hid iron in the old well', importance: 0.9 });
    expect(added.ok).toBe(true);
    const id = (added.data as { id: string }).id;
    const listed = await debugOp(a, 'memory.list', {});
    const rows = (listed.data as { memories: { id: string; text: string; source: string; importance: number }[] }).memories;
    expect(rows).toEqual([expect.objectContaining({ id, text: 'Mira hid iron in the old well', source: 'operator', importance: 0.9 }) as unknown]);
    expect(JSON.stringify(listed.data)).not.toContain('embedding');
    const found = await debugOp(a, 'memory.list', { q: 'where is the iron' });
    expect((found.data as { id: string }[])[0]?.id).toBe(id);
    expect((await debugOp(a, 'memory.edit', { id, text: 'Mira hid iron in the new well', importance: '0.4' })).ok).toBe(true);
    expect((await debugOp(a, 'memory.list', {})).data).toMatchObject({ memories: [{ text: 'Mira hid iron in the new well', importance: 0.4 }] });
    expect(await debugOp(a, 'memory.edit', { id: 'nope', text: 'x' })).toMatchObject({ ok: false });
    expect((await debugOp(a, 'memory.delete', { id })).ok).toBe(true);
    expect((await debugOp(a, 'memory.list', {})).data).toMatchObject({ memories: [] });
    expect((await debugOp(a, 'memory.add', { text: 'something is off about Rex', mind: true })).ok).toBe(true);
    expect(store.state.workmem.at(-1)).toMatchObject({ text: 'something is off about Rex', source: 'operator' });
    expect(await debugOp(a, 'memory.add', {})).toMatchObject({ ok: false });
  });

  it('a goal, a plan (its steps made checkable), a new plan, and clearing it', async () => {
    const { a, store } = agent();
    expect((await debugOp(a, 'goal', { text: 'dig a moat', doneWhen: 'inventoryHas:dirt>=32' })).ok).toBe(true);
    expect(store.state.goals.current).toMatchObject({ text: 'dig a moat', doneWhen: 'inventoryHas:dirt>=32' });
    const set = await debugOp(a, 'plan', { aim: 'a lookout tower', steps: 'gather 16 logs; build it tall' });
    expect(set.ok).toBe(true);
    expect(store.state.goals.plan).toMatchObject({ aim: 'a lookout tower', source: 'operator', steps: [{ text: 'gather 16 logs', status: 'doing' }, { text: 'build it tall', doneWhen: 'spent:6', status: 'todo' }] });
    expect(store.state.goals.current?.text).toBe('gather 16 logs');
    const fresh = await debugOp(a, 'replan', {});
    expect(fresh.ok).toBe(true);
    expect(store.state.goals.plan?.source).toBe('default');
    expect((await debugOp(a, 'plan.clear', {})).ok).toBe(true);
    expect(store.state.goals.plan).toBeNull();
    expect(await debugOp(a, 'plan', { aim: 'x' })).toMatchObject({ ok: false });
  });

  it('do: tidied and checked like the model’s own decisions, then carried out (source operator); a bad one is refused', async () => {
    const { a, store } = agent();
    const done = await debugOp(a, 'do', { decision: '{"option": "explore", "terminate": {"maxSeconds": 0}}' });
    expect(done).toMatchObject({ ok: true });
    expect(store.state.decision).toMatchObject({ option: 'explore', source: 'operator', terminate: { maxSeconds: 120 } });
    expect(await debugOp(a, 'do', { decision: { option: 'work', task: { skill: 'teleport', args: {} } } })).toMatchObject({ ok: false, message: expect.stringContaining('no skill "teleport"') as string });
    expect(await debugOp(a, 'do', { decision: 'not json' })).toMatchObject({ ok: false });
  });

  it('inspect shows its plan, the packet its mind would see now, its modules and models; say and set; unknown is refused', async () => {
    const { a, store, said } = agent();
    await debugOp(a, 'plan', { aim: 'explore', steps: ['look around the hills'] });
    store.update('flags', (f) => ({ ...f, off: ['romance'] }), 'switch');
    const r = await debugOp(a, 'inspect', {});
    expect(r.ok).toBe(true);
    const d = r.data as { packet: string; goals: { planText: string }; modules: { name: string; on: boolean }[]; chains: unknown; lastExchange: unknown };
    expect(d.packet).toContain('Your plan: explore: 1. look around the hills (doing now) (not talked over with anyone yet)');
    expect(d.goals.planText).toBe('explore: 1. look around the hills (doing now)');
    expect(d.modules.find((m) => m.name === 'romance')).toEqual({ name: 'romance', on: false });
    expect(d.chains).toBeNull();
    expect(d.lastExchange).toBeNull();
    expect((await debugOp(a, 'say', { text: 'testing, testing' })).ok).toBe(true);
    expect(said).toEqual(['testing, testing']);
    expect((await debugOp(a, 'set', { what: 'fear', value: 0.8 })).ok).toBe(true);
    expect(store.state.emotions.fear).toBe(0.8);
    expect((await debugOp(a, 'set', { what: 'caution', value: '2' })).ok).toBe(true);
    expect(store.state.drives.caution).toBe(1);
    expect(await debugOp(a, 'set', { what: 'luck', value: 1 })).toMatchObject({ ok: false });
    expect(await debugOp(a, 'teleport', {})).toMatchObject({ ok: false, message: 'unknown debug request teleport' });
  });
});
