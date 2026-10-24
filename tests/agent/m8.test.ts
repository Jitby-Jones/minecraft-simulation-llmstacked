// M8 (§6.8, §16.3, §11 F): social goals, the community goal, roles and the notice board, without Minecraft. The
// division of labor comes from what each agent perceives (need × liking ÷ others on it); roles are read off deeds
// and off the last five social goals; the code default turns village work into skills that end in a checkable act;
// signs are read and written the way a player would. Live behavior is in tests/live/m8-village.test.ts.

import { describe, expect, it } from 'vitest';
import { type ActionRecord, type AgentState, ModelsConfigSchema, type ObservedAction, PersonaSchema, SeededRandom, loadPersonaPool, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { AgentBus } from '@agora/agent/bus';
import type { Body } from '@agora/agent/body/body';
import { readSign, wrapForSign, plainText } from '@agora/agent/body/signs';
import { Vec3 } from '@agora/agent/body/bot';
import { HUT_BLOCKS, HUT_HOLES, findHutSite, hutBlocks, hutDoor, hutPlan, hutSiteHoles, isHutMaterial } from '@agora/agent/body/skills/village';
import { getSkill } from '@agora/agent/body/skills/registry';
import { buildPacket } from '@agora/agent/modules/bottleneck';
import { codeDecision } from '@agora/agent/modules/cc';
import { evalCondition } from '@agora/agent/modules/conditions';
import { Conversations } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { codePlan, villageFirst } from '@agora/agent/modules/goalGen';
import { leversFor } from '@agora/agent/modules/levers';
import { SocialGoalGen } from '@agora/agent/modules/socialGoalGen';
import { Talking } from '@agora/agent/modules/talking';
import { deathNoticeMove, unpostedDeath, unpostedFind, villageMove } from '@agora/agent/modules/villageMove';
import { RoleWatch, WORK_SAYS, statedWork, weightOf, workOf } from '@agora/agent/social/roles';
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
    // Dirt is what huts are made of: digging it is gathering for one, counted half.
    expect(workOf(deed('Bo', 'dig', 'dirt'))).toBe('build');
    expect(weightOf(deed('Bo', 'dig', 'grass_block'))).toBe(0.5);
    expect(weightOf(deed('Bo', 'dig', 'oak_log'))).toBe(1);
  });

  it('someone digging dirt for a while is seen as a builder; a shelter dug for the night is not', () => {
    const store = new AgentStateStore(base());
    store.update('social', (all) => ({ ...all, Bo: newSocialProfile('Bo', pip, 0), Cy: newSocialProfile('Cy', pip, 0) }));
    const bus = new AgentBus();
    const w = new RoleWatch({ store, bus, me: 'Pip', now: () => 1000 });
    w.start();
    for (let i = 0; i < 3; i++) bus.emit({ type: 'observedAction', action: deed('Cy', 'dig', 'dirt', i) });
    expect(w.roleOf('Cy')).toBeNull();
    for (let i = 0; i < 6; i++) bus.emit({ type: 'observedAction', action: deed('Bo', 'dig', i % 2 ? 'dirt' : 'grass_block', i) });
    expect(store.state.social.Bo?.perceivedRole).toBe('builder');
    expect(w.others()).toEqual({ build: 1 });
    w.stop();
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

  it('what someone says they do for the village is their role at once, for whoever hears it', () => {
    expect(statedWork("I'm building a hut for the village.")).toBe('build');
    expect(statedWork("I'm cutting wood for the village.")).toBe('wood');
    expect(statedWork('I am tired')).toBeNull();
    for (const [k, line] of Object.entries(WORK_SAYS)) expect(statedWork(line)).toBe(k);
    const store = new AgentStateStore(base());
    store.update('social', (all) => ({ ...all, Bo: newSocialProfile('Bo', pip, 0) }));
    const bus = new AgentBus();
    const w = new RoleWatch({ store, bus, me: 'Pip', now: () => 1000 });
    w.start();
    // Seen chopping a while: a woodcutter. Then Bo says he's building now (out of our sight).
    for (let i = 0; i < 5; i++) bus.emit({ type: 'observedAction', action: deed('Bo', 'dig', 'oak_log', i) });
    expect(w.roleOf('Bo')).toBe('woodcutter');
    bus.emit({ type: 'heard', utterance: { id: 'u1', convId: '', from: 'Bo', to: 'nearby', text: "I'm building a hut for the village.", ts: 1000, pos: null, volume: 'normal', outOfSight: true, addressedToMe: false } });
    expect(store.state.social.Bo?.perceivedRole).toBe('builder');
    expect(w.others()).toEqual({ build: 1 });
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
    const said: string[] = [];
    const view = { ...VIEW };
    const sg = new SocialGoalGen({ store, bus, logger: nullLogger(), llm: o.llm?.client ?? null, me: 'Wren', community: 'build a thriving village', view: () => view, onRole: (r, b) => roles.push([r, b]), announce: (x) => said.push(x), rng: () => 0.5, now: () => t });
    return { store, bus, sg, roles, said, view, tick: (ms: number) => (t += ms) };
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
    // Taking the work up, it said so to those around; keeping at it, it doesn't say it again.
    expect(r.said).toEqual(["I'm keeping watch over the village."]);
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

  it('once it has stone tools, the village work comes up in its plans more often: more for the loyal, less for the ambitious', () => {
    const social = [{ id: 'sg', text: 'bring logs to the village chest', kind: 'social' as const, createdAt: 0, status: 'active' as const, work: 'wood' }];
    const draws = (s: AgentState, seed: number) => {
      const rng = new SeededRandom(seed);
      return Array.from({ length: 300 }, () => codePlan(s, () => rng.next()));
    };
    const withVillage = (s: AgentState) => ({ ...s, goals: { ...s.goals, social } });
    const share = (s: AgentState) => draws(s, 7).filter((d) => d?.aim === 'bring logs to the village chest').length / 300;
    const wren = withVillage(withInv(base(persona('wren')), { stone_pickaxe: 1 }));
    const mira = withVillage(withInv(base(persona('mira')), { stone_pickaxe: 1 }));
    expect(share(wren)).toBeGreaterThan(share(mira));
    // Its step is the village work, checked by its doneWhen.
    expect(draws(wren, 7).find((d) => d?.aim === 'bring logs to the village chest')?.steps[0]).toEqual({ text: 'bring logs to the village chest', doneWhen: 'villageWork:wood' });
    // Without stone tools, its own first steps come first more often.
    expect(share(withVillage(base(persona('wren'))))).toBeLessThan(share(wren));
    expect(villageFirst(base(persona('wren')))).toBeGreaterThan(villageFirst(base(persona('mira'))));
  });

  it('the code default works at it: gather, then hand in at the village chest (making and setting down one first)', () => {
    let s = atHome(base());
    const v = { isStuck: never };
    expect(villageMove(s, 'wood', v)?.task).toEqual({ skill: 'obtain', args: { item: 'log', qty: 16 } });
    // No trees left nearby (getting logs is stuck): go and look for more.
    expect(villageMove(s, 'wood', { isStuck: (k) => k === 'obtain' })).toMatchObject({ option: 'explore', rationale: 'code default: looking for trees' });
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
    // Hurt, a guard is off duty until healed (neither the fight nor the round).
    expect(villageMove({ ...mob, self: { ...mob.self, health: 6 } }, 'guard', v)).toBeNull();
  });

  it('build: blocks for a hut first, a door if there are planks for it, then the hut', () => {
    let s = atHome(base());
    const v = { isStuck: never };
    expect(villageMove(s, 'build', v)?.task).toEqual({ skill: 'obtain', args: { item: 'dirt', qty: HUT_BLOCKS } });
    // Part of it in hand (dirt and stone): the dirt to aim for is what we hold plus what is missing.
    expect(villageMove(withInv(s, { dirt: 59, cobblestone: 7 }), 'build', v)?.task).toEqual({ skill: 'obtain', args: { item: 'dirt', qty: 59 + HUT_BLOCKS - 66 } });
    s = withInv(s, { dirt: HUT_BLOCKS, oak_planks: 6 });
    expect(villageMove(s, 'build', v)?.task).toEqual({ skill: 'obtain', args: { item: 'oak_door', qty: 1 } });
    expect(villageMove(withInv(s, { dirt: HUT_BLOCKS, oak_door: 1 }), 'build', v)?.task).toEqual({ skill: 'build', args: { structure: 'hut' } });
    expect(villageMove(withInv(s, { dirt: HUT_BLOCKS }), 'build', v)?.task).toEqual({ skill: 'build', args: { structure: 'hut' } });
    // Planks of any wood build a hut (a savanna's acacia didn't count before).
    expect(isHutMaterial('acacia_planks')).toBe(true);
    expect(isHutMaterial('cherry_planks')).toBe(true);
    expect(isHutMaterial('acacia_log')).toBe(false);
    expect(villageMove(withInv(atHome(base()), { acacia_planks: HUT_BLOCKS }), 'build', v)?.task).toEqual({ skill: 'obtain', args: { item: 'acacia_door', qty: 1 } });
    expect(villageMove(withInv(atHome(base()), { acacia_planks: HUT_BLOCKS, acacia_door: 1 }), 'build', v)?.task).toEqual({ skill: 'build', args: { structure: 'hut' } });
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

  it('a guard on duty stays out at night, and nobody else digs in just because it is dark', () => {
    let s = atHome(base(persona('wren'), 'Wren'));
    s = { ...s, self: { ...s.self, isDay: false }, goals: { ...s.goals, current: { id: 'g', text: 'keep the village safe from mobs', kind: 'current', createdAt: 0, status: 'active', doneWhen: 'villageWork:guard' } } };
    expect(codeDecision(s, {}, false, never)?.task?.skill).toBe('patrol');
    const other = { ...s, goals: { ...s.goals, current: { ...s.goals.current!, doneWhen: 'villageWork:wood' } } };
    expect(codeDecision(other, {}, false, never)?.task?.skill).toBe('obtain');
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
    expect(plan).toHaveLength(16 * 3 - 2 + 25);
    // A builder carries enough over for the holes in the ground it may have to fill.
    expect(HUT_BLOCKS).toBe(plan.length + HUT_HOLES);
    expect(plan.some((c) => c.x === 2 && c.z === 0 && c.y < 2)).toBe(false);
    const roof = plan.filter((c) => c.y === 3);
    expect(Math.max(Math.abs((roof[0]?.x ?? 2) - 2), Math.abs((roof[0]?.z ?? 2) - 2))).toBe(2);
    expect(roof.at(-1)).toMatchObject({ x: 2, z: 2 });
  });

  it("a night's hut round a smaller room: 1 across for one, 2 for two, walls two high", () => {
    const one = hutPlan(1);
    expect(one).toHaveLength(8 * 2 - 2 + 9);
    expect(hutBlocks(1)).toBe(one.length + HUT_HOLES);
    expect(hutDoor(1)).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(one.some((c) => c.x === 1 && c.z === 0 && c.y < 2)).toBe(false);
    expect(one.filter((c) => c.y === 2)).toHaveLength(9);
    const two = hutPlan(2);
    expect(two).toHaveLength(12 * 2 - 2 + 16);
    expect(two.some((c) => c.x === 2 && c.z === 0 && c.y < 2)).toBe(false);
    // The roof's rim first, the middle last.
    expect(Math.min(...two.filter((c) => c.y === 2).slice(-4).map((c) => Math.min(c.x, c.z)))).toBe(1);
    expect(hutPlan(3)).toEqual(hutPlan());
    // A small one fits where the big one doesn't: a level patch 4 across over a drop.
    const blockAt = (p: { x: number; y: number; z: number }) =>
      p.y <= 40 && p.x >= -2 && p.x <= 1 && p.z >= -2 && p.z <= 1 ? { name: 'dirt', boundingBox: 'block' } : p.y <= 30 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    expect(findHutSite({ blockAt } as never, new Vec3(0, 41, 0), 6, 0)).toBeNull();
    expect(findHutSite({ blockAt } as never, new Vec3(0, 41, 0), 6, 0, 1)).not.toBeNull();
  });
});

describe('where a hut goes (dug-up ground by home)', () => {
  it('a site may have a few holes one deep, filled first; a deeper pit or too many holes rule it out', () => {
    const holes = new Set<string>();
    const pits = new Set<string>();
    const air = { name: 'air', boundingBox: 'empty' };
    const dirt = { name: 'dirt', boundingBox: 'block' };
    const blockAt = (p: { x: number; y: number; z: number }) => {
      const k = `${p.x},${p.z}`;
      if (p.y >= 41) return air;
      if (p.y === 40 && (holes.has(k) || pits.has(k))) return air;
      if (p.y === 39 && pits.has(k)) return air;
      return dirt;
    };
    const bot = { blockAt } as never;
    const corner = new Vec3(4, 41, 4);
    expect(hutSiteHoles(bot, corner)).toEqual([]);
    holes.add('5,5');
    holes.add('8,8');
    // A hole in the free ring round the hut doesn't matter; one under it is filled.
    holes.add('3,3');
    expect(hutSiteHoles(bot, corner)?.map((h) => [h.x, h.y, h.z])).toEqual([
      [5, 40, 5],
      [8, 40, 8],
    ]);
    pits.add('6,6');
    expect(hutSiteHoles(bot, corner)).toBeNull();
    pits.clear();
    for (const k of ['4,6', '5,6', '6,6', '7,6']) holes.add(k);
    expect(hutSiteHoles(bot, corner)).toBeNull();
    // Around home, the nearest site with the fewest holes.
    holes.clear();
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) if ((x * 7 + z * 3) % 5 === 0) holes.add(`${x},${z}`);
    const site = findHutSite(bot, new Vec3(0, 41, 0));
    expect(site).not.toBeNull();
    expect(hutSiteHoles(bot, site as Vec3)?.length).toBeLessThanOrEqual(HUT_HOLES);
  });

  it('on a hillside, finds the level patch above or below home\'s own height', () => {
    // Ground rising a block every 2 east of home, levelling off at a terrace 5 up from x = 10 on.
    const ground = (x: number) => (x < 0 ? 40 : x >= 10 ? 45 : 40 + Math.floor(x / 2));
    const blockAt = (p: { x: number; y: number; z: number }) => (p.y <= ground(p.x) ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
    const bot = { blockAt } as never;
    // Home on the slope: nowhere level at its own height within reach west (the lowland is far), the terrace is.
    const site = findHutSite(bot, new Vec3(6, 44, 0), 20, 4);
    expect(site).not.toBeNull();
    expect(hutSiteHoles(bot, site as Vec3)).toEqual([]);
    expect([41, 46]).toContain(site?.y);
  });

  it('under trees, the ground is the ground, not the canopy', () => {
    // Flat ground at 40 under a solid canopy of leaves at 46 (a dark forest): no hut on top of the trees.
    const blockAt = (p: { x: number; y: number; z: number }) =>
      p.y <= 40 ? { name: 'dirt', boundingBox: 'block' } : p.y === 46 ? { name: 'dark_oak_leaves', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    const site = findHutSite({ blockAt } as never, new Vec3(0, 41, 0));
    expect(site?.y).toBe(41);
  });
});

describe('the ground by home is left whole for huts', () => {
  it('dirt is dug out past it', async () => {
    const { HOME_GROUND, awayFromHome } = await import('@agora/agent/body/skills/gathering');
    const at = (x: number, z: number) => ({ position: { x, z } });
    expect(awayFromHome([at(3, 4), at(HOME_GROUND, 1), at(-HOME_GROUND - 1, 0), at(12, 12)], { x: 0, z: 0 })).toEqual([at(HOME_GROUND, 1), at(-HOME_GROUND - 1, 0), at(12, 12)]);
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

  it('a furnace is cleared of what was left in it and given fuel enough for the batch', async () => {
    const { readyFurnace } = await import('@agora/agent/body/skills/crafting');
    const done: string[] = [];
    const furnace = (slots: { input?: [string, number]; output?: [string, number]; fuel?: [string, number] }) => ({
      inputItem: () => (slots.input ? { name: slots.input[0], count: slots.input[1] } : null),
      outputItem: () => (slots.output ? { name: slots.output[0], count: slots.output[1] } : null),
      fuelItem: () => (slots.fuel ? { name: slots.fuel[0], count: slots.fuel[1] } : null),
      takeInput: () => Promise.resolve(done.push('take input')),
      takeOutput: () => Promise.resolve(done.push('take output')),
      takeFuel: () => Promise.resolve(done.push('take fuel')),
      putFuel: async (_t: number, _m: number | null, n: number) => {
        done.push(`fuel ${n}`);
      },
      putInput: async () => {
        done.push('input');
      },
      close: () => undefined,
    });
    const bot = (inv: [string, number][]) => ({ inventory: { items: () => inv.map(([name, count]) => ({ name, count })), slots: [] }, registry: { itemsByName: { oak_log: { id: 5 }, coal: { id: 9 }, stick: { id: 10 } } } }) as never;
    // Raw beef left in it when the fuel ran out, and a cooked one: both out, and logs for three chickens.
    expect(await readyFurnace(bot([['chicken', 3], ['oak_log', 4]]), furnace({ input: ['beef', 2], output: ['cooked_beef', 1] }), 'chicken', 3)).toBeNull();
    expect(done.splice(0)).toEqual(['take output', 'take input', 'fuel 2']);
    // A stick in it isn't enough: the same fuel is topped up if we carry it, else ours goes in its place.
    expect(await readyFurnace(bot([['chicken', 3], ['stick', 8]]), furnace({ fuel: ['stick', 1] }), 'chicken', 3)).toBeNull();
    expect(done.splice(0)).toEqual(['fuel 5']);
    expect(await readyFurnace(bot([['chicken', 3], ['coal', 2]]), furnace({ fuel: ['stick', 1] }), 'chicken', 3)).toBeNull();
    expect(done.splice(0)).toEqual(['take fuel', 'fuel 1']);
    // Enough already; and none anywhere.
    expect(await readyFurnace(bot([['chicken', 3]]), furnace({ fuel: ['coal', 1] }), 'chicken', 3)).toBeNull();
    expect(done.splice(0)).toEqual([]);
    expect(await readyFurnace(bot([['chicken', 3]]), furnace({}), 'chicken', 3)).toMatch(/need fuel/);
    // Charcoal from logs: the logs being cooked are never the fuel; planks are, before other logs.
    const { pickFuel } = await import('@agora/agent/body/skills/crafting');
    expect(pickFuel(bot([['oak_log', 6]]), undefined, 'oak_log')).toBeNull();
    expect(await readyFurnace(bot([['oak_log', 6]]), furnace({}), 'oak_log', 6)).toMatch(/other than the oak log being cooked/);
    expect(pickFuel(bot([['oak_log', 6], ['birch_log', 2], ['oak_planks', 4]]), undefined, 'oak_log')?.name).toBe('oak_planks');
    expect(pickFuel(bot([['oak_log', 6], ['birch_log', 2]]), undefined, 'oak_log')?.name).toBe('birch_log');
    // Enough for the batch: one plank won't cook three raw iron, two logs will; failing that, what goes furthest.
    expect(pickFuel(bot([['oak_planks', 1], ['birch_log', 2]]), undefined, 'raw_iron', 3)?.name).toBe('birch_log');
    expect(pickFuel(bot([['oak_planks', 3], ['birch_log', 2]]), undefined, 'raw_iron', 3)?.name).toBe('oak_planks');
    expect(pickFuel(bot([['oak_planks', 1], ['stick', 4]]), undefined, 'raw_iron', 8)?.name).toBe('stick');
  });

  it('iron is mined and smelted, not made out of an iron block nobody has seen', async () => {
    const { planObtain } = await import('@agora/agent/body/skills/planner');
    const items = [
      { name: 'stone_pickaxe', count: 1, type: 6 },
      { name: 'oak_log', count: 4, type: 5 },
      { name: 'crafting_table', count: 1, type: 8 },
    ];
    const names = ['', 'iron_ingot', 'raw_iron', 'iron_block', 'furnace', 'oak_log', 'stone_pickaxe', 'cobblestone', 'crafting_table'];
    const blocks = [
      { id: 10, name: 'iron_ore', drops: [2], harvestTools: { 6: true } },
      { id: 11, name: 'iron_block', drops: [3], harvestTools: { 6: true } },
      { id: 12, name: 'stone', drops: [7], harvestTools: { 6: true } },
      { id: 13, name: 'furnace', drops: [4] },
    ];
    const recipes: Record<number, unknown[]> = {
      1: [{ result: { id: 1, count: 9 }, delta: [{ id: 3, count: -1 }, { id: 1, count: 9 }], requiresTable: false }],
      4: [{ result: { id: 4, count: 1 }, delta: [{ id: 7, count: -8 }, { id: 4, count: 1 }], requiresTable: true }],
    };
    const bot = {
      registry: {
        itemsByName: Object.fromEntries(names.map((n, id): [string, { id: number }] => [n, { id }]).slice(1)),
        items: Object.fromEntries(names.map((name, id): [number, { name: string }] => [id, { name }]).slice(1)),
        blocksArray: blocks,
        blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
        blocksByName: Object.fromEntries(blocks.map((b) => [b.name, b])),
        foodsByName: {},
      },
      inventory: { items: () => items, slots: [] },
      entity: { position: new Vec3(0, 64, 0) },
      on: () => undefined,
      findBlocks: () => [],
      blockAt: () => null,
      recipesAll: (id: number) => recipes[id] ?? [],
    } as never;
    // A furnace still to make (out of stone) costs more than an iron block found: but none has been seen.
    expect((await planObtain(bot, 'iron_ingot')).kind).toBe('smelt');
  });

  it("one ingot short, iron is still mined and smelted: not made of nuggets cut from the ingots we're after", async () => {
    const { planObtain } = await import('@agora/agent/body/skills/planner');
    const items = [
      { name: 'stone_pickaxe', count: 1, type: 6 },
      { name: 'oak_log', count: 4, type: 5 },
      { name: 'furnace', count: 1, type: 4 },
      { name: 'crafting_table', count: 1, type: 8 },
      { name: 'iron_ingot', count: 2, type: 1 },
    ];
    const names = ['', 'iron_ingot', 'raw_iron', 'iron_block', 'furnace', 'oak_log', 'stone_pickaxe', 'cobblestone', 'crafting_table', 'iron_nugget'];
    const blocks = [{ id: 10, name: 'iron_ore', drops: [2], harvestTools: { 6: true } }];
    const recipes: Record<number, unknown[]> = {
      1: [{ result: { id: 1, count: 1 }, delta: [{ id: 9, count: -9 }, { id: 1, count: 1 }], requiresTable: true }],
      9: [{ result: { id: 9, count: 9 }, delta: [{ id: 1, count: -1 }, { id: 9, count: 9 }], requiresTable: false }],
    };
    const bot = {
      registry: {
        itemsByName: Object.fromEntries(names.map((n, id): [string, { id: number }] => [n, { id }]).slice(1)),
        items: Object.fromEntries(names.map((name, id): [number, { name: string }] => [id, { name }]).slice(1)),
        blocksArray: blocks,
        blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
        blocksByName: Object.fromEntries(blocks.map((b) => [b.name, b])),
        foodsByName: {},
      },
      inventory: { items: () => items, slots: [] },
      entity: { position: new Vec3(0, 64, 0) },
      on: () => undefined,
      findBlocks: () => [],
      blockAt: () => null,
      recipesAll: (id: number) => recipes[id] ?? [],
    } as never;
    // Nine nuggets make an ingot, and an ingot we hold makes nine nuggets: a way round, not a way to more iron.
    expect((await planObtain(bot, 'iron_ingot')).kind).toBe('smelt');
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
    expect(codeDecision(hurt, {}, false, never)).toMatchObject({ option: 'rest', rationale: 'code default: badly hurt, resting until I heal' });
  });

  it('badly hurt: food until it can heal, then lie low (in a sealed hole with a mob about); a hurt guard is off duty', async () => {
    const { hurtMove } = await import('@agora/agent/modules/villageMove');
    const v = { isStuck: never };
    const slime = { id: 2, kind: 'hostile' as const, name: 'slime', pos: { x: 9, y: -60, z: 0 }, distance: 9, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false };
    let s = atHome(base());
    // Food 15 is no hunger for the healthy; for the badly hurt it is, since health comes back only from 18.
    s = { ...s, self: { ...s.self, food: 15, health: 1, isDay: true } };
    expect(hurtMove({ ...s, self: { ...s.self, health: 15 } }, v)).toBeNull();
    expect(hurtMove(s, v)?.option).toBe('explore');
    // Something to eat: the eat reflex eats it, and meanwhile we rest.
    expect(hurtMove(withInv(s, { porkchop: 2 }), v)?.option).toBe('rest');
    const fed = { ...s, self: { ...s.self, food: 19 }, perception: { ...s.perception, nearbyEntities: [slime] } };
    // At home: resting there with an eye out. In a sealed hole only when hiding is allowed (alone, scared, far off).
    expect(hurtMove(fed, v)?.option).toBe('rest');
    expect(hurtMove(fed, { ...v, mayHide: true })?.task).toEqual({ skill: 'shelter', args: { untilMorning: false, untilHealed: true } });
    // Far from home: back home to recover.
    expect(hurtMove({ ...fed, self: { ...fed.self, pos: { x: 80, y: -60, z: 0 } } }, v)?.task).toEqual({ skill: 'goTo', args: { x: 0, y: -60, z: 0, range: 3 } });
    // A guard at one heart doesn't walk the edge of the village among the slimes.
    const guard = { ...fed, goals: { ...fed.goals, current: { id: 'g', text: 'keep the village safe', kind: 'current' as const, createdAt: 0, status: 'active' as const, doneWhen: 'villageWork:guard' } } };
    expect(codeDecision(guard, {}, false, never)?.option).toBe('rest');
    const { villageMove } = await import('@agora/agent/modules/villageMove');
    expect(villageMove({ ...guard, self: { ...guard.self, health: 9 } }, 'guard', v)).toBeNull();
    expect(villageMove({ ...guard, self: { ...guard.self, health: 14 } }, 'guard', v)?.task?.skill).toBe('attack');
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

describe('saying what one does for the village, at a lull (§6.8, §6.2 floor control)', () => {
  const LULL = 40;
  function talker() {
    const s = new AgentStateStore(createInitialState({ persona: pip, username: 'Pip', now: 0 }));
    s.update('perception', (p) => ({ ...p, nearbyEntities: [{ id: 1, kind: 'player', name: 'Bram', pos: { x: 3, y: 0, z: 0 }, distance: 3, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }] }));
    const bus = new AgentBus();
    const said: { text: string; at: number }[] = [];
    const body = { say: (text: string) => Promise.resolve(said.push({ text, at: Date.now() }) > 0), skill: () => ({ talkOverable: true }), run: () => new Promise(() => undefined) } as unknown as Body;
    const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Pip', inRange: () => ['Bram'], rng: () => 0 });
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Pip', rng: () => 0.5, lullMs: LULL });
    conversations.start();
    talking.start();
    let lastHeard = 0;
    const hear = (from: string, text: string) => {
      lastHeard = Date.now();
      s.update('perception', (p) => ({ ...p, heardSpeech: [...p.heardSpeech, { id: `u${p.heardSpeech.length}`, convId: '', from, to: [], text, ts: lastHeard, pos: null, volume: 'normal' as const, outOfSight: false, addressedToMe: false }] }));
    };
    return { said, talking, conversations, hear, lastHeard: () => lastHeard };
  }
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('waits for a quiet moment: not over a question to everyone, nor the answer to it', async () => {
    const t = talker();
    t.hear('Dara', 'anyone got some wood?');
    const done = t.talking.announce(WORK_SAYS.wood);
    await sleepMs(25);
    t.hear('Opal', 'I have a few logs to spare');
    expect(await done).toBe(true);
    expect(t.said.map((x) => x.text)).toEqual([WORK_SAYS.wood]);
    expect((t.said[0]?.at ?? 0) - t.lastHeard()).toBeGreaterThanOrEqual(LULL);
    // Said to all around, it opens no conversation (one of two would take whatever either says next for the other).
    expect(t.conversations.active()).toEqual([]);
  });

  it('goes in the conversation already going with them', async () => {
    const t = talker();
    const conv = t.conversations.open('Bram', true);
    expect(await t.talking.announce(WORK_SAYS.build)).toBe(true);
    expect(t.said.map((x) => x.text)).toEqual([WORK_SAYS.build]);
    expect(t.conversations.get(conv.convId)?.transcript.map((u) => u.text)).toEqual([WORK_SAYS.build]);
  });

  it('goes unsaid if the talk never lets up, or once it stops', async () => {
    const t = talker();
    const busy = setInterval(() => t.hear('Dara', 'and another thing'), 10);
    try {
      expect(await t.talking.announce(WORK_SAYS.stone)).toBe(false);
    } finally {
      clearInterval(busy);
    }
    const later = t.talking.announce(WORK_SAYS.food);
    t.talking.stop();
    expect(await later).toBe(false);
    expect(t.said).toEqual([]);
  });
});

describe('dyeing: any wool, carpet or bed takes any dye (the game data has each from black alone)', () => {
  it('puts each other colour back, and only once', async () => {
    const { completeDyeing } = await import('@agora/agent/body/recipes');
    const names = ['white_wool', 'red_wool', 'black_wool', 'red_dye', 'white_dye', 'black_dye'];
    const itemsByName = Object.fromEntries(names.map((n, i) => [n, { id: i + 1 }]));
    const recipes: Record<number, { ingredients?: number[]; result: { id: number; count: number } }[]> = { 2: [{ ingredients: [4, 3], result: { id: 2, count: 1 } }] };
    const registry = { recipes, itemsByName };
    // Red from white (red from black is there); white from red and black; black from white and red.
    expect(completeDyeing(registry)).toBe(5);
    expect(recipes[2]?.some((r) => r.ingredients?.includes(4) && r.ingredients.includes(1))).toBe(true);
    expect(recipes[1]?.map((r) => r.ingredients)).toEqual([
      [5, 2],
      [5, 3],
    ]);
    expect(completeDyeing(registry)).toBe(0);
  });
});
