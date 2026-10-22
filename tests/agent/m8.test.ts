// M8 (§6.8, §16.3, §11 F): social goals, the community goal, roles and the notice board, without Minecraft. The
// division of labor comes from what each agent perceives (need × liking ÷ others on it); roles are read off deeds
// and off the last five social goals; the code default turns village work into skills that end in a checkable act;
// signs are read and written the way a player would. Live behavior is in tests/live/m8-village.test.ts.

import { describe, expect, it } from 'vitest';
import { type ActionRecord, type AgentState, ModelsConfigSchema, type ObservedAction, PersonaSchema, loadPersonaPool, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { AgentBus } from '@agora/agent/bus';
import { readSign, wrapForSign, plainText } from '@agora/agent/body/signs';
import { HUT_BLOCKS, hutPlan } from '@agora/agent/body/skills/village';
import { getSkill } from '@agora/agent/body/skills/registry';
import { buildPacket } from '@agora/agent/modules/bottleneck';
import { codeDecision } from '@agora/agent/modules/cc';
import { evalCondition } from '@agora/agent/modules/conditions';
import { codeGoal, villageFirst } from '@agora/agent/modules/goalGen';
import { leversFor } from '@agora/agent/modules/levers';
import { SocialGoalGen } from '@agora/agent/modules/socialGoalGen';
import { deathNoticeMove, unpostedDeath, unpostedFind, villageMove } from '@agora/agent/modules/villageMove';
import { RoleWatch, workOf } from '@agora/agent/social/roles';
import { type VillageView, chooseWork, describeVillage, needs, preferences, roleEntropy, roleFrom, villageView, villageWorkDone, villageWorkOf } from '@agora/agent/social/village';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const pool = loadPersonaPool();
const persona = (id: string) => {
  const p = pool.find((x) => x.id === id);
  if (!p) throw new Error(`no persona ${id}`);
  return p;
};
const pip = persona('pip');
const never = () => false;
const base = (p = pip, name = p.name): AgentState => createInitialState({ persona: p, username: name, now: 0 });
const VIEW: VillageView = { chest: null, threats: 0, huts: 0, night: false, oreKnown: false, hungry: 0, others: {} };
const deed = (actor: string, kind: ObservedAction['kind'], item?: string, ts = 0): ObservedAction => ({ id: `${actor}${kind}${ts}${item ?? ''}`, actor, kind, ts, ...(item ? { item } : {}) });
const act = (skill: string, args: Record<string, unknown>, ok: boolean, ts: number): ActionRecord => ({ id: `${skill}${ts}`, skill, args, expected: '', observed: '', ok, ts, durationMs: 1 });
const withInv = (s: AgentState, items: Record<string, number>): AgentState => ({ ...s, self: { ...s.self, inventory: Object.entries(items).map(([item, qty]) => ({ item, qty })) } });
const atHome = (s: AgentState): AgentState => ({ ...s, self: { ...s.self, pos: { x: 0, y: -60, z: 0 } }, village: { ...s.village, home: { x: 0, y: -60, z: 0 } } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the division of labor (§6.8, code default of Social Goal Gen)', () => {
  it('reads likings from the persona: the protector likes guarding, the scatterbrained explorer scouting', () => {
    expect(preferences(persona('wren')).guard).toBeGreaterThan(0.9);
    expect(preferences(pip).scout).toBeGreaterThan(0.85);
    expect(preferences(persona('oswin')).tools).toBeGreaterThan(preferences(pip).tools);
  });

  it('weighs what the village needs: an empty chest needs everything, a full one less; night calls for guards', () => {
    const empty = needs(VIEW);
    expect(empty.wood).toBe(1);
    const stocked = needs({ ...VIEW, chest: { oak_log: 64, cobblestone: 128, bread: 30 } });
    expect(stocked.wood).toBeLessThan(0.3);
    expect(stocked.food).toBeLessThan(0.2);
    expect(needs({ ...VIEW, night: true, threats: 2 }).guard).toBeGreaterThan(empty.guard + 0.5);
    expect(needs({ ...VIEW, oreKnown: true }).scout).toBeLessThan(empty.scout);
  });

  it('five different people who see each other at work end up doing different things', () => {
    const five = ['pip', 'bram', 'mira', 'wren', 'oswin'].map(persona);
    const cur: (string | null)[] = five.map(() => null);
    let r = 0.37;
    const noise = () => (r = (r * 9301 + 49297) % 233280 / 233280);
    for (let round = 0; round < 4; round++) {
      for (const [i, p] of five.entries()) {
        const others: Record<string, number> = {};
        cur.forEach((k, j) => {
          if (j !== i && k) others[k] = (others[k] ?? 0) + 1;
        });
        cur[i] = chooseWork(p, { ...VIEW, others }, (cur[i] as never) ?? null, noise)[0]?.kind ?? null;
      }
    }
    expect(new Set(cur).size).toBeGreaterThanOrEqual(4);
    // With nothing known of each other, they still don't all pick the same.
    const first = five.map((p) => chooseWork(p, VIEW, null, () => 0.5)[0]?.kind);
    expect(new Set(first).size).toBeGreaterThanOrEqual(3);
  });

  it('the current work sticks unless something else is clearly better', () => {
    const top = chooseWork(pip, VIEW, null, () => 0.5)[0]?.kind;
    const second = chooseWork(pip, VIEW, null, () => 0.5)[1]?.kind;
    expect(chooseWork(pip, VIEW, second ?? null, () => 0.5)[0]?.kind).toBe(second);
    expect(top).not.toBe(second);
  });

  it('names a role from the last five social goals, and measures how varied the roles are', () => {
    expect(roleFrom([])).toBeNull();
    expect(roleFrom(['wood', 'wood', 'stone'])).toBe('woodcutter');
    expect(roleFrom(['wood', 'wood', 'guard', 'guard', 'guard', 'stone'])).toBe('guard');
    // A tie goes to the latest.
    expect(roleFrom(['wood', 'stone'])).toBe('miner');
    expect(roleEntropy(['guard', 'guard', 'guard'])).toBe(0);
    expect(roleEntropy(['guard', 'miner'])).toBe(1);
    expect(roleEntropy(['guard', 'miner', 'woodcutter', 'builder', null])).toBe(2);
  });

  it('builds the view from what the agent itself perceived, and says it in a sentence', () => {
    let s = base();
    const T = 20 * 60_000;
    s = { ...s, village: { ...s.village, chest: { pos: { x: 1, y: -60, z: 1 }, contents: { oak_log: 20, bread: 2 }, seenAt: 0 }, huts: [{ x: 5, y: -60, z: 5 }], threats: [T - 50_000, 10] } };
    s = { ...s, perception: { ...s.perception, systemEvents: [{ kind: 'death', ts: T - 1000, text: 'Bo was slain by Zombie', subject: 'Bo', cause: 'was slain by Zombie', killer: 'Zombie' }] } };
    s = { ...s, perception: { ...s.perception, heardSpeech: [{ id: 'u', convId: '', from: 'Cy', to: 'nearby', text: "I'm starving, anyone have food?", ts: T - 500, pos: null, volume: 'normal', outOfSight: false, addressedToMe: false, heardAs: 'other' }] } };
    const v = villageView(s, { wood: 1 }, T);
    expect(v).toMatchObject({ chest: { oak_log: 20, bread: 2 }, huts: 1, hungry: 1, others: { wood: 1 } });
    // One mob came near in the last 10 minutes, one death to a mob was heard of.
    expect(v.threats).toBe(2);
    expect(describeVillage(v)).toMatch(/the village chest holds 20 oak_log, 2 bread; 1 hut; hostile mobs came near 2 times lately; 1 person has asked for food; no ore found yet; others are already at wood \(1\)/);
  });
});

describe('roles from what people are seen doing (§6.3 perceivedRole)', () => {
  it('reads the work in a deed; a fight with a person is not village work', () => {
    expect(workOf(deed('Bo', 'dig', 'oak_log'))).toBe('wood');
    expect(workOf(deed('Bo', 'dig', 'iron_ore'))).toBe('stone');
    expect(workOf(deed('Bo', 'attack', 'zombie'))).toBe('guard');
    expect(workOf(deed('Bo', 'attack', 'cow'))).toBe('food');
    expect(workOf(deed('Bo', 'place', 'cobblestone'))).toBe('build');
    expect(workOf(deed('Bo', 'place', 'torch'))).toBeNull();
    expect(workOf(deed('Bo', 'dig', 'short_grass'))).toBeNull();
    expect(workOf({ ...deed('Bo', 'attack'), target: 'Rex' })).toBeNull();
  });

  it('three logs chopped make a woodcutter; the tally fades, so a role can change', () => {
    let t = 0;
    const store = new AgentStateStore(base());
    store.update('social', (all) => ({ ...all, Bo: newSocialProfile('Bo', pip, 0) }));
    const bus = new AgentBus();
    const w = new RoleWatch({ store, bus, me: 'Pip', now: () => t });
    w.start();
    for (let i = 0; i < 2; i++) bus.emit({ type: 'observedAction', action: deed('Bo', 'dig', 'oak_log', i) });
    expect(store.state.social.Bo?.perceivedRole).toBeUndefined();
    bus.emit({ type: 'observedAction', action: deed('Bo', 'dig', 'birch_log', 3) });
    expect(store.state.social.Bo?.perceivedRole).toBe('woodcutter');
    expect(w.others(t)).toEqual({ wood: 1 });
    // Our own deeds are not someone else's role.
    bus.emit({ type: 'observedAction', action: deed('Pip', 'dig', 'oak_log', 4) });
    expect(w.roleOf('Pip', t)).toBeNull();
    t = 60 * 60_000;
    for (let i = 0; i < 3; i++) bus.emit({ type: 'observedAction', action: deed('Bo', 'attack', 'zombie', t + i) });
    expect(store.state.social.Bo?.perceivedRole).toBe('guard');
    w.stop();
  });

  it('counts a role someone told us about, while they are around', () => {
    const store = new AgentStateStore(base());
    store.update('social', (all) => ({ ...all, Cy: { ...newSocialProfile('Cy', pip, 0), perceivedRole: 'miner', lastSeen: 1000 } }));
    const w = new RoleWatch({ store, bus: new AgentBus(), me: 'Pip', now: () => 2000 });
    expect(w.others()).toEqual({ stone: 1 });
    expect(w.others(1000 + 31 * 60_000)).toEqual({});
  });
});

describe('Social Goal Gen (§4.2 module 11)', () => {
  function rig(o: { llm?: Awaited<ReturnType<typeof startLlm>> | null; company?: boolean; degrade?: 0 | 1 | 2 | 3 } = {}) {
    let t = 10_000;
    const store = new AgentStateStore(base(persona('wren'), 'Wren'));
    if (o.company !== false) store.update('social', (all) => ({ ...all, Bo: { ...newSocialProfile('Bo', pip, 0), lastSeen: t } }));
    if (o.degrade) store.update('flags', (f) => ({ ...f, degrade: o.degrade ?? 0 }));
    const bus = new AgentBus();
    const roles: [string, string | null][] = [];
    const view = { ...VIEW };
    const sg = new SocialGoalGen({ store, bus, logger: nullLogger(), llm: o.llm?.client ?? null, me: 'Wren', community: 'build a thriving village', view: () => view, onRole: (r, b) => roles.push([r, b]), rng: () => 0.5, now: () => t });
    return { store, bus, sg, roles, view, tick: (ms: number) => (t += ms) };
  }

  it('code default: takes up the work the village needs and the persona likes; five in a row make the role', async () => {
    const r = rig();
    r.sg.start();
    expect(r.store.state.goals.community).toBe('build a thriving village');
    r.view.night = true;
    r.view.threats = 3;
    await r.sg.run('dusk');
    expect(r.store.state.goals.social).toMatchObject([{ kind: 'social', work: 'guard', text: 'keep the village safe from mobs', status: 'active' }]);
    expect(r.store.state.goals.role).toBe('guard');
    expect(r.roles).toEqual([['guard', null]]);
    // The same work again: the goal stays (same id), the role holds.
    const id = r.store.state.goals.social[0]?.id;
    await r.sg.run('periodic');
    expect(r.store.state.goals.social[0]?.id).toBe(id);
    expect(r.store.state.goals.socialKinds).toEqual(['guard', 'guard']);
    r.sg.stop();
  });

  it('runs only in company, not in danger, and not after stop', async () => {
    const alone = rig({ company: false });
    await alone.sg.run('periodic');
    expect(alone.store.state.goals.social).toEqual([]);
    const r = rig();
    r.store.update('flags', (f) => ({ ...f, inDanger: true }));
    await r.sg.run('periodic');
    expect(r.store.state.goals.social).toEqual([]);
    r.store.update('flags', (f) => ({ ...f, inDanger: false }));
    r.sg.stop();
    await r.sg.run('late');
    expect(r.store.state.goals.social).toEqual([]);
  });

  it('a death nearby brings it round soon, with a hint about keeping each other safe (L2 prompt)', async () => {
    const fake = new FakeNanoGpt(standardModels());
    const prompts: string[] = [];
    fake.chat = (c) => {
      prompts.push(JSON.stringify(c.body.messages));
      return { text: JSON.stringify({ goals: [{ text: 'walk the edge of the village at night', kind: 'guard' }, { text: 'help Bo build a wall', kind: 'build', with: 'Bo' }], why: 'Ann died to a zombie' }) };
    };
    const rt = await startLlm({ apiKey: 'test', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 50 }) });
    try {
      const r = rig({ llm: rt });
      r.store.update('perception', (p) => ({ ...p, systemEvents: [{ kind: 'death', ts: 9000, text: 'Ann was slain by Zombie', subject: 'Ann', cause: 'was slain by Zombie' }] }));
      r.sg.start();
      r.bus.emit({ type: 'peerDied', name: 'Ann', cause: 'was slain by Zombie', witnessed: false });
      for (let i = 0; i < 80 && r.store.state.goals.social.length === 0; i++) await wait(50);
      expect(r.store.state.goals.social.map((g) => [g.work, g.with])).toEqual([
        ['guard', undefined],
        ['build', 'Bo'],
      ]);
      expect(prompts[0]).toContain('everyone hopes to build a thriving village');
      expect(prompts[0]).toContain('Ann died (was slain by Zombie)');
      expect(prompts[0]).toContain('Think about keeping each other safe');
      expect(fake.chatRequests()).toHaveLength(1);
      r.sg.stop();
    } finally {
      rt.stop();
    }
  }, 15_000);

  it('the quota ladder turns the model off from 85 % (§22.4): the code default still works', async () => {
    const fake = new FakeNanoGpt(standardModels());
    let calls = 0;
    fake.chat = () => {
      calls++;
      return { text: '{"goals": []}' };
    };
    const rt = await startLlm({ apiKey: 'test', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 50 }) });
    try {
      const r = rig({ llm: rt, degrade: 2 });
      await r.sg.run('periodic');
      expect(calls).toBe(0);
      expect(r.store.state.goals.social).toHaveLength(1);
    } finally {
      rt.stop();
    }
  });
});

describe('village work as goals (§6.8)', () => {
  it('villageWork:<kind> is done by the work’s finishing act since the goal was set', () => {
    let s = base();
    s = { ...s, goals: { ...s.goals, current: { id: 'g', text: 'logs for the village', kind: 'current', createdAt: 100, status: 'active', doneWhen: 'villageWork:wood' } } };
    expect(evalCondition('villageWork:wood', s)).toBe(false);
    expect(evalCondition('villageWork:dancing', s)).toBeNull();
    s = { ...s, actionLog: [act('deposit', { item: 'log', qty: 16 }, true, 50)] };
    expect(evalCondition('villageWork:wood', s)).toBe(false); // before the goal
    s = { ...s, actionLog: [...s.actionLog, act('deposit', { item: 'oak_log', qty: 16 }, false, 150)] };
    expect(evalCondition('villageWork:wood', s)).toBe(false); // failed
    s = { ...s, actionLog: [...s.actionLog, act('give', { to: 'Bo', item: 'oak_log', qty: 16 }, true, 160)] };
    expect(evalCondition('villageWork:wood', s)).toBe(true);
    expect(villageWorkDone(s, 'build', 100)).toBe(false);
    expect(villageWorkDone({ ...s, actionLog: [act('build', { structure: 'hut' }, true, 200)] }, 'build', 100)).toBe(true);
    expect(villageWorkDone({ ...s, actionLog: [act('attack', { target: 'zombie' }, true, 200)] }, 'guard', 100)).toBe(true);
    expect(villageWorkDone({ ...s, actionLog: [act('attack', { target: 'cow' }, true, 200)] }, 'guard', 100)).toBe(false);
    expect(villageWorkDone({ ...s, actionLog: [act('sign', { text: 'iron ore at 1, 2' }, true, 200)] }, 'scout', 100)).toBe(true);
    expect(villageWorkOf('villageWork:guard')).toBe('guard');
    expect(villageWorkOf('inventoryHas:log>=1')).toBeNull();
  });

  it('once it has stone tools, the village comes first now and then: more for the loyal, less for the ambitious', () => {
    let s = withInv(base(), { stone_pickaxe: 1 });
    expect(codeGoal(s, 0)?.doneWhen).toBe('inventoryHas:furnace>=1');
    s = { ...s, goals: { ...s.goals, social: [{ id: 'sg', text: 'bring logs to the village chest', kind: 'social', createdAt: 0, status: 'active', work: 'wood' }] } };
    expect(codeGoal(s, 0)).toEqual({ text: 'bring logs to the village chest', doneWhen: 'villageWork:wood' });
    expect(codeGoal(s, 0.99)?.doneWhen).toBe('inventoryHas:furnace>=1');
    // Without stone tools, its own first steps still come first.
    expect(codeGoal(withInv(s, {}), 0)?.doneWhen).toBe('inventoryHas:wooden_pickaxe>=1');
    expect(villageFirst(base(persona('wren')))).toBeGreaterThan(villageFirst(base(persona('mira'))));
  });

  it('the code default works at it: gather, then hand in at the village chest (making and setting down one first)', () => {
    let s = atHome(base());
    const v = { isStuck: never };
    expect(villageMove(s, 'wood', v)?.task).toEqual({ skill: 'obtain', args: { item: 'log', qty: 16 } });
    s = withInv(s, { oak_log: 16 });
    expect(villageMove(s, 'wood', v)?.task).toEqual({ skill: 'obtain', args: { item: 'chest', qty: 1 } });
    s = withInv(s, { oak_log: 16, chest: 1 });
    expect(villageMove(s, 'wood', v)?.task).toEqual({ skill: 'place', args: { block: 'chest' } });
    s = { ...s, self: { ...s.self, pos: { x: 30, y: -60, z: 0 } } };
    expect(villageMove(s, 'wood', v)?.task?.skill).toBe('goTo');
    s = { ...s, village: { ...s.village, chest: { pos: { x: 2, y: -60, z: 1 }, contents: null, seenAt: 0 } } };
    expect(villageMove(s, 'wood', v)?.task).toEqual({ skill: 'deposit', args: { item: 'log', qty: 16, x: 2, y: -60, z: 1 } });
    expect(villageMove(withInv(s, { cobblestone: 20 }), 'stone', v)?.task).toEqual({ skill: 'deposit', args: { item: 'cobblestone', qty: 16, x: 2, y: -60, z: 1 } });
  });

  it('food: hunt what is in sight, cook it, hand it in; guard: fight what comes near, else walk the edge', () => {
    let s = atHome(base());
    const v = { isStuck: never };
    expect(villageMove(s, 'food', v)?.option).toBe('explore');
    s = { ...s, perception: { ...s.perception, nearbyEntities: [{ id: 1, kind: 'passive', name: 'cow', pos: { x: 6, y: -60, z: 0 }, distance: 6, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }] } };
    expect(villageMove(s, 'food', v)?.task).toEqual({ skill: 'hunt', args: { qty: 3 } });
    expect(villageMove(withInv(s, { beef: 4 }), 'food', v)?.task).toEqual({ skill: 'obtain', args: { item: 'cooked_beef', qty: 4 } });
    expect(villageMove(withInv(s, { cooked_beef: 4 }), 'food', v)?.task?.skill).toBe('obtain'); // no chest yet: make one
    expect(villageMove(s, 'guard', v)?.task).toEqual({ skill: 'patrol', args: { radius: 10 } });
    const mob = { ...s, perception: { ...s.perception, nearbyEntities: [{ id: 2, kind: 'hostile' as const, name: 'zombie', pos: { x: 8, y: -60, z: 0 }, distance: 8, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }] } };
    expect(villageMove(mob, 'guard', v)?.task).toEqual({ skill: 'attack', args: { target: 'zombie', seconds: 30 } });
    // Hurt, a guard walks the round instead of picking a fight.
    expect(villageMove({ ...mob, self: { ...mob.self, health: 6 } }, 'guard', v)?.task?.skill).toBe('patrol');
  });

  it('build: blocks for a hut first, a door if there are planks for it, then the hut', () => {
    let s = atHome(base());
    const v = { isStuck: never };
    expect(villageMove(s, 'build', v)?.task).toEqual({ skill: 'obtain', args: { item: 'dirt', qty: HUT_BLOCKS } });
    s = withInv(s, { dirt: HUT_BLOCKS, oak_planks: 6 });
    expect(villageMove(s, 'build', v)?.task).toEqual({ skill: 'obtain', args: { item: 'oak_door', qty: 1 } });
    expect(villageMove(withInv(s, { dirt: HUT_BLOCKS, oak_door: 1 }), 'build', v)?.task).toEqual({ skill: 'build', args: { structure: 'hut' } });
    expect(villageMove(withInv(s, { dirt: HUT_BLOCKS }), 'build', v)?.task).toEqual({ skill: 'build', args: { structure: 'hut' } });
  });

  it('scout: out exploring until it finds ore, then a sign at the board saying where', () => {
    let s = atHome(base());
    const v = { isStuck: never };
    expect(villageMove(s, 'scout', v)?.option).toBe('explore');
    s = { ...s, village: { ...s.village, finds: [{ what: 'iron ore', pos: { x: 60, y: -61, z: -20 }, at: 0 }] } };
    expect(unpostedFind(s)).toMatchObject({ what: 'iron ore' });
    expect(villageMove(s, 'scout', v)?.task).toEqual({ skill: 'obtain', args: { item: 'oak_sign', qty: 1 } });
    s = withInv(s, { oak_sign: 1 });
    expect(villageMove(s, 'scout', v)?.task).toEqual({ skill: 'sign', args: { text: 'iron ore at 60, -20' } });
    expect(villageMove({ ...s, self: { ...s.self, pos: { x: 50, y: -60, z: 0 } } }, 'scout', v)?.task?.skill).toBe('goTo');
    // Once a sign says it, it's posted.
    s = { ...s, village: { ...s.village, signs: [{ pos: { x: 2, y: -60, z: 2 }, text: 'iron ore at 60, -20', readAt: 1 }] } };
    expect(unpostedFind(s)).toBeNull();
  });

  it('a death no sign mentions yet goes on the board (§16.3), before the agent’s own work', () => {
    let s = withInv(atHome(base()), { oak_sign: 1, stone_pickaxe: 1 });
    s = { ...s, perception: { ...s.perception, systemEvents: [{ kind: 'death', ts: 0, text: 'Bo tried to swim in lava', subject: 'Bo', cause: 'tried to swim in lava' }], observedActions: [{ id: 'd', actor: 'Bo', kind: 'death', ts: 0, pos: { x: 40.4, y: -61, z: 12.6 } }] } };
    expect(unpostedDeath(s)).toEqual({ name: 'Bo', text: 'Bo tried to swim in lava near 40, 13' });
    expect(deathNoticeMove(s, { isStuck: never })?.task).toEqual({ skill: 'sign', args: { text: 'Bo tried to swim in lava near 40, 13' } });
    expect(codeDecision(s, {}, false, never)?.task?.skill).toBe('sign');
    // Far from home, or with no sign and nothing to make one: not now.
    expect(deathNoticeMove({ ...s, self: { ...s.self, pos: { x: 90, y: -60, z: 0 } } }, { isStuck: never })).toBeNull();
    expect(deathNoticeMove(withInv(s, {}), { isStuck: never })).toBeNull();
    expect(deathNoticeMove(withInv(s, { oak_planks: 8 }), { isStuck: never })?.task).toEqual({ skill: 'obtain', args: { item: 'oak_sign', qty: 1 } });
    // Already on the board.
    const posted = { ...s, village: { ...s.village, signs: [{ pos: { x: 2, y: -60, z: 2 }, text: 'Bo tried to swim in lava near 40, 13', readAt: 1 }] } };
    expect(unpostedDeath(posted)).toBeNull();
  });

  it('a guard on duty stays out at night; everyone else digs in', () => {
    let s = atHome(base(persona('wren'), 'Wren'));
    s = { ...s, self: { ...s.self, isDay: false }, goals: { ...s.goals, current: { id: 'g', text: 'keep the village safe from mobs', kind: 'current', createdAt: 0, status: 'active', doneWhen: 'villageWork:guard' } } };
    expect(codeDecision(s, {}, false, never)?.task?.skill).toBe('patrol');
    const other = { ...s, goals: { ...s.goals, current: { ...s.goals.current!, doneWhen: 'villageWork:wood' } } };
    expect(codeDecision(other, {}, false, never)?.task?.skill).toBe('shelter');
  });

  it('the CC packet says the agent’s part in the village and the community goal', () => {
    let s = base();
    s = { ...s, goals: { ...s.goals, community: 'build a thriving village', social: [{ id: 'sg', text: 'mine stone for the village', kind: 'social', createdAt: 0, status: 'active', work: 'stone', with: 'Bo' }] } };
    const packet = buildPacket({ state: s, levers: leversFor(0.5, true), reason: 'test', now: 0 });
    expect(packet).toContain('Your part in the village: mine stone for the village (with Bo); everyone hopes to build a thriving village.');
  });

  it('the new skills are in the catalog with their arguments checked', () => {
    expect(getSkill('sign')?.parseArgs({ text: 'iron ore at 4, 5' }).ok).toBe(true);
    expect(getSkill('post')?.name).toBe('sign');
    expect(getSkill('build')?.parseArgs({}).ok).toBe(true);
    expect(getSkill('hunt')?.parseArgs({ animal: 'cow', qty: 2 }).ok).toBe(true);
    expect(getSkill('hunt')?.parseArgs({ animal: 'villager' }).ok).toBe(false);
    expect(getSkill('patrol')?.parseArgs({ radius: 12 }).ok).toBe(true);
  });
});

describe('the notice board: signs as a player reads and writes them (§6.8, §16.1)', () => {
  it('fits a message onto four lines of fifteen, whole words, and says when it had to cut', () => {
    expect(wrapForSign('Bo tried to swim in lava near 40, 13')).toEqual(['Bo tried to', 'swim in lava', 'near 40, 13']);
    expect(wrapForSign('iron ore at 60, -20')).toEqual(['iron ore at 60,', '-20']);
    const long = wrapForSign('a very long notice about the terrible night when the zombies came over the hill and ate all the bread');
    expect(long).toHaveLength(4);
    expect(long.every((l) => l.length <= 15)).toBe(true);
    expect(long[3]?.endsWith('…')).toBe(true);
    expect(wrapForSign('supercalifragilisticexpialidocious')[0]).toBe('supercalifragi…');
  });

  it('reads the front text in the shapes the server sends', () => {
    const sign = (messages: unknown[]) => ({ name: 'oak_sign', entity: { value: { front_text: { value: { messages: { value: { value: messages } } } } } } }) as never;
    expect(readSign(sign(['Bo died', 'in lava', '', '']))).toBe('Bo died in lava');
    expect(readSign(sign(['{"text":"iron ore"}', '"at 4, 5"', '', '']))).toBe('iron ore at 4, 5');
    expect(readSign(sign([{ type: 'string', value: 'hello' }, { text: 'there', extra: [{ text: '!' }] }]))).toBe('hello there!');
    expect(readSign(sign(['', '', '', '']))).toBeNull();
    expect(readSign({ name: 'oak_planks' } as never)).toBeNull();
    expect(readSign({ name: 'oak_wall_sign', getSignText: () => ['north gate\nis open', ''] } as never)).toBe('north gate is open');
    expect(plainText('["", {"text": "a"}, "b"]')).toBe('ab');
  });

  it('a hut is 5×5 walls three high with a doorway and a flat roof laid rim first', () => {
    const plan = hutPlan();
    expect(plan).toHaveLength(HUT_BLOCKS);
    expect(HUT_BLOCKS).toBe(16 * 3 - 2 + 25);
    expect(plan.some((c) => c.x === 2 && c.z === 0 && c.y < 2)).toBe(false);
    const roof = plan.filter((c) => c.y === 3);
    expect(Math.max(Math.abs((roof[0]?.x ?? 2) - 2), Math.abs((roof[0]?.z ?? 2) - 2))).toBe(2);
    expect(roof.at(-1)).toMatchObject({ x: 2, z: 2 });
  });
});

describe('what the village knows survives a restart (§23.4)', () => {
  it('the village facet is in the snapshot', async () => {
    const { SNAPSHOT_FACETS } = await import('@agora/agent/state/snapshot');
    expect(SNAPSHOT_FACETS).toContain('village');
    expect(PersonaSchema.parse({ name: 'X', sex: 'male', traits: ['quiet'] })).toBeTruthy();
  });
});

describe('what the new skills expect to see (§4.6)', () => {
  it('a sign is a category, so a posted oak sign counts; meat counts as food', async () => {
    const { itemMatcher } = await import('@agora/agent/body/items');
    expect(itemMatcher('sign').matches('oak_sign')).toBe(true);
    expect(itemMatcher('sign').matches('birch_sign')).toBe(true);
    expect(itemMatcher('sign').matches('oak_hanging_sign')).toBe(false);
    const raw = (n: string) => ['beef', 'porkchop'].includes(n);
    expect(itemMatcher('meat', raw).matches('porkchop')).toBe(true);
  });
});

describe('cooking what was hunted (the obtain planner)', () => {
  it('meat in hand needs no route: raw meat comes from no block, and is cooked all the same', async () => {
    const { planObtain } = await import('@agora/agent/body/skills/planner');
    const items = [
      { name: 'mutton', count: 4 },
      { name: 'furnace', count: 1 },
      { name: 'oak_log', count: 2 },
    ];
    const bot = {
      registry: { itemsByName: { cooked_mutton: { id: 1 }, mutton: { id: 2 }, furnace: { id: 3 }, oak_log: { id: 4 } }, items: {}, blocksArray: [], blocksByName: {}, foodsByName: { mutton: {}, cooked_mutton: {} } },
      inventory: { items: () => items, slots: [] },
      recipesAll: () => [],
    } as never;
    expect((await planObtain(bot, 'cooked_mutton')).kind).toBe('smelt');
    // No meat, and no block drops any: nothing to cook.
    items[0] = { name: 'stick', count: 1 };
    expect((await planObtain(bot, 'cooked_mutton')).kind).toBe('none');
  });
});

describe('staying alive in the village (§16.3: carry food)', () => {
  it('hungry with nothing to eat: food from the village chest, else an animal in sight, else a look around', async () => {
    const { hungerMove } = await import('@agora/agent/modules/villageMove');
    const v = { isStuck: never };
    let s = atHome(base());
    s = { ...s, self: { ...s.self, food: 10 } };
    expect(hungerMove(s, v)?.option).toBe('explore');
    expect(hungerMove(withInv(s, { bread: 1 }), v)).toBeNull();
    expect(hungerMove({ ...s, self: { ...s.self, food: 16 } }, v)).toBeNull();
    const cow = { id: 1, kind: 'passive' as const, name: 'cow', pos: { x: 5, y: -60, z: 0 }, distance: 5, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false };
    s = { ...s, perception: { ...s.perception, nearbyEntities: [cow] } };
    expect(hungerMove(s, v)?.task).toEqual({ skill: 'hunt', args: { qty: 2 } });
    s = { ...s, village: { ...s.village, chest: { pos: { x: 2, y: -60, z: 1 }, contents: { oak_log: 30, cooked_beef: 6 }, seenAt: 0 } } };
    expect(hungerMove(s, v)?.task).toEqual({ skill: 'withdraw', args: { item: 'cooked_beef', qty: 4, x: 2, y: -60, z: 1 } });
  });

  it('starving comes before the night and before the task at hand; badly hurt and well fed, it rests', () => {
    let s = atHome(base());
    s = { ...s, self: { ...s.self, food: 5, isDay: false } };
    expect(codeDecision(s, {}, false, never)?.option).toBe('explore');
    // Busy with something else: still food first.
    expect(codeDecision(s, {}, true, never)?.option).toBe('explore');
    expect(codeDecision({ ...s, self: { ...s.self, food: 9 } }, {}, true, never)).toBeNull();
    const hurt = { ...s, self: { ...s.self, food: 20, health: 6, isDay: true } };
    expect(codeDecision(hurt, {}, false, never)).toMatchObject({ option: 'rest', rationale: 'code default: hurt, resting until I heal' });
  });

  it('in a village, mines go outside it', () => {
    let s = withInv(atHome(base()), { stone_pickaxe: 1 });
    s = { ...s, goals: { ...s.goals, current: { id: 'g', text: 'make an iron pickaxe', kind: 'current', createdAt: 0, status: 'active', doneWhen: 'inventoryHas:iron_pickaxe>=1' } } };
    s = { ...s, actionLog: [{ ...act('obtain', { item: 'iron_pickaxe', qty: 1 }, false, 1), error: "haven't seen any raw_iron around here" }] };
    expect(codeDecision(s, {}, false, never)?.task).toEqual({ skill: 'prospect', args: { item: 'raw_iron' } });
    const village = { ...s, village: { ...s.village, chest: { pos: { x: 2, y: -60, z: 1 }, contents: null, seenAt: 0 } } };
    expect(codeDecision(village, {}, false, never)?.task).toEqual({ skill: 'prospect', args: { item: 'raw_iron', outside: 24 } });
  });
});
