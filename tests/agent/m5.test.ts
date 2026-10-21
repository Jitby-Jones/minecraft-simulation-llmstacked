// M5 (§10, §16.4): conversations between several agents without Minecraft: group floor control, code-only hellos,
// a talk option that ends with its conversation, and the state snapshot for resume. The Hub and supervisor are in
// tests/hub/hub.test.ts; the live exit test is tests/live/m5-population.test.ts.

import { describe, expect, it } from 'vitest';
import { PersonaSchema, type Utterance, nullLogger } from '@agora/shared';
import type { Body } from '@agora/agent/body/body';
import type { SkillRunRecord } from '@agora/agent/body/skills/runner';
import { AgentBus } from '@agora/agent/bus';
import { MemoryDB } from '@agora/agent/memory/db';
import { codeDecision } from '@agora/agent/modules/cc';
import { Conversations } from '@agora/agent/modules/conversations';
import { SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { Talking } from '@agora/agent/modules/talking';
import { createInitialState } from '@agora/agent/state/initial';
import { restoreSnapshot, saveSnapshot } from '@agora/agent/state/snapshot';
import { AgentStateStore } from '@agora/agent/state/store';

const persona = PersonaSchema.parse({ name: 'Cass', sex: 'female', traits: ['quiet'], social: { initiateChance: 0.4 } });
const store = () => new AgentStateStore(createInitialState({ persona, username: 'Cass', now: 0 }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function line(from: string, text: string, heardAs: Utterance['heardAs']): Utterance {
  return { id: `u${Math.random()}`, convId: '', from, to: 'nearby', text, ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: heardAs === 'me', heardAs };
}

/** A code-only Talking (canned lines) whose body records what it says; perception's speech ring is fed by hand. */
function speaker(rng: () => number) {
  const s = store();
  const bus = new AgentBus();
  const said: string[] = [];
  const body = {
    // Like ChatOut: the line is dropped if it is no longer wanted right before it would go out.
    say: (t: string, _v?: string, _l?: string[], stillWanted?: () => boolean) => Promise.resolve(stillWanted && !stillWanted() ? false : said.push(t) > 0),
    skill: () => ({ talkOverable: true }),
    run: () => Promise.reject(new Error('unused')),
  } as unknown as Body;
  const conversations = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Cass', inRange: () => ['Ada', 'Bram'], rng });
  const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
  const talking = new Talking({ store: s, bus, body, logger: nullLogger(), llm: null, conversations, executor, me: 'Cass', rng });
  conversations.start();
  talking.start();
  const hear = (u: Utterance) => bus.emit({ type: 'heard', utterance: u });
  return {
    s,
    said,
    hear,
    stop: () => {
      talking.stop();
      conversations.stop();
    },
  };
}

describe('group floor control (§6.2)', () => {
  it('chimes in on a question to everyone after a pause when nobody else answers', async () => {
    const c = speaker(() => 0); // shortest pause (1.5 s), quickest reply
    c.hear(line('Ada', 'anyone got some wood?', 'unsure'));
    await wait(1000);
    expect(c.said).toEqual([]);
    for (let i = 0; i < 60 && c.said.length === 0; i++) await wait(50);
    expect(c.said).toHaveLength(1);
    expect(Object.values(c.s.state.conversations).some((x) => x.participants.includes('Ada'))).toBe(true);
    c.stop();
  }, 10_000);

  it('yields the floor even after deciding to chime in, and forgets that conversation', async () => {
    const c = speaker(() => 0); // chimes in at 1.5 s, speaks about 0.3 s later
    c.hear(line('Ada', 'anyone got some wood?', 'unsure'));
    for (let i = 0; i < 100 && Object.keys(c.s.state.conversations).length === 0; i++) await wait(20);
    expect(Object.keys(c.s.state.conversations)).toHaveLength(1);
    c.hear(line('Bram', 'I have a few logs', 'other'));
    await wait(1500);
    expect(c.said).toEqual([]);
    expect(Object.keys(c.s.state.conversations)).toHaveLength(0);
    c.stop();
  }, 10_000);

  it('stays quiet when someone else answers first, and chimes in at most once per three turns', async () => {
    // rng 0.5: a 2.75 s pause, and lines aimed at someone else don't pull this (average) extravert in.
    const c = speaker(() => 0.5);
    c.hear(line('Ada', 'anyone got some wood?', 'unsure'));
    await wait(300);
    c.hear(line('Bram', 'I have a few logs', 'other'));
    await wait(3500);
    expect(c.said).toEqual([]);
    const c2 = speaker(() => 0.5);
    c2.hear(line('Ada', 'who wants to help with the farm?', 'unsure'));
    for (let i = 0; i < 100 && c2.said.length === 0; i++) await wait(50);
    expect(c2.said).toHaveLength(1);
    // The very next question comes within three turns of chiming in: let someone else take it.
    c2.hear(line('Bram', 'anyone seen my pickaxe?', 'unsure'));
    await wait(3500);
    expect(c2.said).toHaveLength(1);
    c.stop();
    c2.stop();
  }, 20_000);
});

describe('conversation tails (§6.2 pair cooldown)', () => {
  it('does not reopen a conversation on the partner\u2019s trailing line unless they call us by name', () => {
    const s = store();
    const bus = new AgentBus();
    const conv = new Conversations({ store: s, bus, logger: nullLogger(), me: 'Cass', inRange: () => ['Bram'], rng: () => 0 });
    conv.start();
    const addressed: string[] = [];
    bus.on('addressed', (e) => addressed.push(e.utterance.text));
    const c = conv.open('Bram', true);
    conv.end(c.convId, 'repetition');
    bus.emit({ type: 'heard', utterance: line('Bram', 'well, see you then', 'me') });
    expect(addressed).toEqual([]);
    expect(conv.withPartner('Bram')).toBeUndefined();
    bus.emit({ type: 'heard', utterance: line('Bram', 'Cass, one more thing', 'me') });
    expect(addressed).toEqual(['Cass, one more thing']);
    conv.stop();
  });
});

describe('code-only social defaults (§6.2, §22.4)', () => {
  it('says hello to someone nearby when there is nothing to do, by the persona’s initiate chance', () => {
    const s = createInitialState({ persona, username: 'Cass', now: 0 });
    const never = () => false;
    const hello = codeDecision(s, {}, false, never, { candidates: ['Bram'], roll: 0.1 });
    expect(hello).toMatchObject({ option: 'talk', target: { agent: 'Bram' }, speechIntent: { stance: 'chat', mayCommit: false } });
    expect(codeDecision(s, {}, false, never, { candidates: ['Bram'], roll: 0.9 })?.option).toBe('rest');
    expect(codeDecision(s, {}, false, never, { candidates: [], roll: 0 })?.option).toBe('rest');
  });

  it('ends a talk option when its conversation ends', async () => {
    const s = store();
    const bus = new AgentBus();
    const body = {
      skill: () => ({ talkOverable: true }),
      run: (skill: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
        new Promise<SkillRunRecord>((resolve) => {
          const rec = (ok: boolean, aborted: boolean): SkillRunRecord => ({ id: 'r', skill, args, expected: 'x', observed: 'x', ok, mismatch: false, aborted, slip: null, startedAt: 0, durationMs: 1 });
          if (skill === 'goTo') resolve(rec(true, false));
          opts.signal.addEventListener('abort', () => resolve({ ...rec(false, true), error: 'aborted: conversation over' }), { once: true });
        }),
    } as unknown as Body;
    s.update('perception', (p) => ({ ...p, nearbyEntities: [{ id: 1, kind: 'player', name: 'Bram', pos: { x: 1, y: 0, z: 1 }, distance: 2, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false }] }));
    const ends: string[] = [];
    bus.on('optionTerminated', (e) => ends.push(`${e.reason}|${String(e.ok)}`));
    const ex = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    ex.start();
    s.set('option', { decisionId: 'd', option: 'talk', startedAt: Date.now(), maxSeconds: 60, targetAgent: 'Bram', status: 'running' });
    await wait(50);
    s.update('conversations', (cs) => ({ ...cs, c1: { convId: 'c1', participants: ['Cass', 'Bram'], startedAt: 0, lastActivity: 0, turns: 4, myTurns: 2, lastEmbeds: [], status: 'ended', transcript: [], initiatedByMe: true, nudged: false } }));
    bus.emit({ type: 'conversationEnded', convId: 'c1', reason: 'turn cap' });
    for (let i = 0; i < 40 && ends.length === 0; i++) await wait(25);
    expect(ends).toEqual(['conversation over|true']);
    ex.stop();
  });
});

describe('state snapshot for resume (§23.4)', () => {
  it('keeps goals, the social model and commitments; time offline fades emotions and lapses overdue promises', () => {
    const db = new MemoryDB(':memory:');
    const a = store();
    a.update('goals', (g) => ({ ...g, current: { id: 'g1', text: 'build a hut', kind: 'current', createdAt: 0, status: 'active' } }));
    a.update('emotions', (e) => ({ ...e, anger: 0.8 }));
    a.update('selfSummary', () => 'I build things.');
    a.update('commitments', () => [
      { id: 'k1', debtor: 'Cass', creditor: 'Bram', what: { kind: 'give', text: '4 logs', item: 'oak_log', qty: 4 }, status: 'accepted', createdFromConv: 'c', createdAt: 0, dueBy: 1000 },
      { id: 'k2', debtor: 'Cass', creditor: 'Ada', what: { kind: 'give', text: 'a loaf', item: 'bread', qty: 1 }, status: 'accepted', createdFromConv: 'c', createdAt: 0, dueBy: 10_000_000 },
    ]);
    saveSnapshot(db, a.state, 0);
    const b = store();
    const offline = restoreSnapshot(db, b, 30 * 60_000);
    expect(offline).toBe(30 * 60_000);
    expect(b.state.goals.current?.text).toBe('build a hut');
    expect(b.state.selfSummary).toBe('I build things.');
    expect(b.state.emotions.anger).toBeCloseTo(0.4, 3);
    expect(b.state.commitments.map((c) => c.status)).toEqual(['broken', 'accepted']);
    expect(restoreSnapshot(new MemoryDB(':memory:'), store())).toBeNull();
    db.close();
  });
});
