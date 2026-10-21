// M6 (§6.3, §6.4): Social Awareness and commitment tracking against fakes and the mocked NanoGPT. Live scenarios
// are in tests/live/m6-social.test.ts.

import { describe, expect, it } from 'vitest';
import { type Commitment, type ConversationState, ModelsConfigSchema, PersonaSchema, type Utterance, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { AgentBus } from '@agora/agent/bus';
import { codeDecision, parseItemRequest } from '@agora/agent/modules/cc';
import { SocialAwareness, codePromises, codeSocialUpdate } from '@agora/agent/social/awareness';
import { parseClaim } from '@agora/agent/social/claims';
import { CommitmentTracker } from '@agora/agent/social/commitments';
import { DeathWatch, reactToDeath } from '@agora/agent/social/deaths';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['generous'], social: { baselineSentiment: 5, grudge: 0 }, mind: { biasProfile: { negativity: 0 } } });
const store = () => new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newProfile = (name: string) => newSocialProfile(name, persona, 0);

function utter(from: string, text: string, ts: number): Utterance {
  return { id: `u${ts}`, convId: 'c1', from, to: 'nearby', text, ts, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true };
}

function conversation(lines: [string, string][]): ConversationState {
  return {
    convId: 'c1',
    participants: ['Pip', 'Bram'],
    startedAt: 0,
    lastActivity: 10,
    turns: lines.length,
    myTurns: lines.filter(([w]) => w === 'Pip').length,
    lastEmbeds: [],
    status: 'ended',
    transcript: lines.map(([from, text], i) => utter(from, text, i)),
    initiatedByMe: false,
    nudged: false,
    endedReason: 'turn cap',
  };
}

describe('Social Awareness without a model (§6.3 code defaults)', () => {
  it('reads tone words and promise phrasing', () => {
    expect(codeSocialUpdate(['thanks, that is great']).sentimentDelta).toBeGreaterThan(0);
    const rude = codeSocialUpdate(['shut up, you idiot']);
    expect(rude.sentimentDelta).toBeLessThan(0);
    expect(rude.insultedMe).toBe(true);
    const p = codePromises(["sure, I'll bring you 8 logs later", 'nice weather']);
    expect(p.promises).toEqual([{ what: { kind: 'give', item: 'log', qty: 8, text: "sure, I'll bring you 8 logs later" } }]);
  });

  it('applies deeds and resolved promises with code-only deltas', () => {
    const s = store();
    const bus = new AgentBus();
    const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip', now: () => 1000 });
    sa.deed('Bram', 'gaveMeItems', 'Bram gave me bread');
    // First meetings count double (anchoring): +1 → +2.
    expect(s.state.social.Bram?.sentiment).toBe(7);
    expect(s.state.workmem.at(-1)?.text).toBe('Bram gave me bread');
    const k: Commitment = { id: 'k', debtor: 'Bram', creditor: 'Pip', what: { kind: 'give', text: '8 logs' }, status: 'fulfilled', createdFromConv: 'c', createdAt: 0 };
    sa.promiseResolved(k, true);
    expect(s.state.social.Bram?.trust).toBeCloseTo(0.6);
    expect(s.state.social.Bram?.promisesKept).toBe(1);
    sa.promiseResolved(k, false);
    expect(s.state.social.Bram?.trust).toBeCloseTo(0.4);
    expect(s.state.social.Bram?.promisesBroken).toBe(1);
  });
});

describe('Social Awareness with a model (§6.3, §6.4)', () => {
  it('turns a finished conversation into a profile update, heard opinions and recorded promises', async () => {
    const fake = new FakeNanoGpt(standardModels());
    fake.chat = ({ body }) => {
      const name = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
      if (name === 'social') {
        return {
          text: JSON.stringify({
            sentimentDelta: 1,
            frictionDelta: 0.1,
            perceivedGoals: ['build a house'],
            perceivedRole: 'builder',
            facts: ['Bram is building a house by the lake'],
            summary: 'Bram is friendly and busy building.',
            opinions: [{ target: 'Cass', valence: -0.8 }],
          }),
        };
      }
      return { text: JSON.stringify({ promises: [{ what: { kind: 'give', item: 'oak_log', qty: 8, text: '8 oak logs' }, dueInSec: 300 }] }) };
    };
    const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
    const s = store();
    const bus = new AgentBus();
    const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: rt.client, me: 'Pip', now: () => 5000 });
    sa.start();
    const conv = conversation([
      ['Bram', 'hey Pip, I am building a house by the lake'],
      ['Pip', 'ooh nice'],
      ['Bram', "Cass stole my iron. Anyway, I'll bring you 8 logs for the help"],
    ]);
    s.update('conversations', (cs) => ({ ...cs, c1: conv }));
    bus.emit({ type: 'conversationEnded', convId: 'c1', reason: 'turn cap' });
    for (let i = 0; i < 50 && s.state.commitments.length === 0; i++) await wait(20);
    const p = s.state.social.Bram;
    expect(p?.sentiment).toBe(7);
    expect(p?.perceivedRole).toBe('builder');
    expect(p?.facts[0]?.text).toMatch(/house by the lake/);
    expect(p?.friction).toBeCloseTo(0.1);
    expect(s.state.heardOpinions).toEqual([{ speaker: 'Bram', target: 'Cass', valence: -0.8, ts: 5000 }]);
    expect(s.state.commitments[0]).toMatchObject({ debtor: 'Bram', creditor: 'Pip', status: 'accepted', what: { kind: 'give', item: 'oak_log', qty: 8 }, dueBy: 5000 + 300_000 });
    sa.stop();
    rt.stop();
  });
});

describe('commitment tracking (§6.4)', () => {
  function tracker(commitments: Commitment[], now: { t: number }) {
    const s = store();
    s.update('commitments', () => commitments);
    const bus = new AgentBus();
    const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip', now: () => now.t });
    const ct = new CommitmentTracker({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip', social: sa, now: () => now.t });
    ct.start();
    return { s, bus, ct };
  }
  const k = (o: Partial<Commitment>): Commitment => ({ id: 'k1', debtor: 'Bram', creditor: 'Pip', what: { kind: 'give', item: 'oak_log', qty: 8, text: '8 logs' }, status: 'accepted', createdFromConv: 'c', createdAt: 0, dueBy: 600_000, ...o });

  it('keeps a give promise when the items arrive, in parts', () => {
    const now = { t: 1000 };
    const { s, bus, ct } = tracker([k({})], now);
    bus.emit({ type: 'observedAction', action: { id: 'a', actor: 'Bram', kind: 'gave', target: 'Pip', item: 'oak_log', qty: 5, ts: 1000 } });
    expect(s.state.commitments[0]?.status).toBe('accepted');
    expect(s.state.commitments[0]?.progress).toBe(5);
    bus.emit({ type: 'observedAction', action: { id: 'b', actor: 'Bram', kind: 'gave', target: 'Pip', item: 'oak_log', qty: 3, ts: 1100 } });
    expect(s.state.commitments[0]?.status).toBe('fulfilled');
    expect(s.state.social.Bram?.trust).toBeCloseTo(0.6);
    ct.stop();
  });

  it('keeps our own promise when our give action succeeds, and breaks what is overdue', async () => {
    const now = { t: 1000 };
    const mine = k({ id: 'k2', debtor: 'Pip', creditor: 'Bram' });
    const theirs = k({ id: 'k3', what: { kind: 'give', item: 'bread', qty: 1, text: 'a loaf' }, dueBy: 2000 });
    const { s, bus, ct } = tracker([mine, theirs], now);
    bus.emit({ type: 'actionRecorded', record: { id: 'r', skill: 'give', args: { agent: 'Bram', item: 'oak_log', qty: 8 }, expected: '', observed: '', ok: true, ts: 1000, durationMs: 1 } });
    expect(s.state.commitments.find((c) => c.id === 'k2')?.status).toBe('fulfilled');
    expect(s.state.workmem.at(-1)?.text).toMatch(/I kept my promise to Bram/);
    now.t = 3000;
    for (let i = 0; i < 40 && s.state.commitments.find((c) => c.id === 'k3')?.status === 'accepted'; i++) await wait(100);
    expect(s.state.commitments.find((c) => c.id === 'k3')?.status).toBe('broken');
    expect(s.state.social.Bram?.trust).toBeCloseTo(0.3);
    ct.stop();
  }, 10_000);
});

describe('the code default answers a favor (§6.3 share policy, scenario A without a model)', () => {
  it('parses simple item requests', () => {
    expect(parseItemRequest('Pip, can you give me 8 logs?')).toEqual({ item: 'log', qty: 8 });
    expect(parseItemRequest('could you bring me some bread please')).toEqual({ item: 'bread', qty: 1 });
    expect(parseItemRequest('I need some berries')).toEqual({ item: 'berry', qty: 1 });
    expect(parseItemRequest('give me a hand here')).toBeNull();
    expect(parseItemRequest('nice weather today')).toBeNull();
  });

  it('agrees and promises when it likes the asker and is generous; declines otherwise', () => {
    const base = createInitialState({ persona, username: 'Pip', now: 0 });
    const asked = { ...base, perception: { ...base.perception, heardSpeech: [{ ...utter('Bram', 'Pip, can you give me 8 logs?', 1), addressedToMe: true }] } };
    const never = () => false;
    const liked = { ...asked, social: { Bram: { ...newProfile('Bram'), sentiment: 7 } } };
    const yes = codeDecision(liked, { from: 'Bram', convId: 'c1' }, false, never);
    expect(yes?.speechIntent).toMatchObject({ stance: 'agree', mayCommit: true, gist: "I'll bring you 8 logs" });
    expect(yes?.task).toEqual({ skill: 'obtain', args: { item: 'log', qty: 8 } });
    expect(yes?.commitmentsToCreate?.[0]).toMatchObject({ debtor: 'Pip', creditor: 'Bram', what: { kind: 'give', item: 'log', qty: 8 } });
    const disliked = { ...asked, social: { Bram: { ...newProfile('Bram'), sentiment: 3 } } };
    expect(codeDecision(disliked, { from: 'Bram', convId: 'c1' }, false, never)?.speechIntent).toMatchObject({ stance: 'decline', mayCommit: false });
  });
});

describe('death matters to the living (§16.3)', () => {
  const ev = (subject: string, killer?: string) => ({ kind: 'death' as const, ts: 0, text: `${subject} was slain by ${killer ?? 'Zombie'}`, subject, killer: killer ?? 'Zombie' });

  it('raises caution, more when seen, and grieves friends but not enemies', () => {
    const friend = { ...newProfile('Bram'), sentiment: 9 };
    const enemy = { ...newProfile('Bram'), sentiment: 1 };
    const heard = reactToDeath(ev('Bram'), 'Pip', friend, persona, false);
    const seen = reactToDeath(ev('Bram'), 'Pip', friend, persona, true);
    expect(seen?.cautionDelta ?? 0).toBeGreaterThan(heard?.cautionDelta ?? 0);
    expect(heard?.grief).toBeGreaterThan(0.5);
    expect(heard?.note).toMatch(/Bram died \(killed by Zombie\).*Death is permanent.*miss them/);
    expect(reactToDeath(ev('Bram'), 'Pip', enemy, persona, false)?.grief).toBeLessThan(-0.5);
    expect(reactToDeath(ev('Pip'), 'Pip', friend, persona, false)).toBeNull();
  });

  it('turns a death notice into caution, a note on the mind and a peerDied event; caution recovers slowly', () => {
    const s = store();
    const bus = new AgentBus();
    const t = { now: 0 };
    const dw = new DeathWatch({ store: s, bus, logger: nullLogger(), me: 'Pip', sawDeath: () => true, now: () => t.now });
    const died: string[] = [];
    bus.on('peerDied', (e) => died.push(`${e.name}:${String(e.witnessed)}`));
    dw.start();
    const before = s.state.drives.caution;
    bus.emit({ type: 'systemEvent', event: ev('Bram') });
    expect(s.state.drives.caution).toBeGreaterThan(before + 0.1);
    expect(s.state.workmem.at(-1)?.text).toMatch(/Bram died/);
    expect(died).toEqual(['Bram:true']);
    dw.stop();
  });
});

describe('rumor control (§6.5)', () => {
  it('reads place-and-thing claims from speech', () => {
    expect(parseClaim('there are diamonds at 120, 12, -40!')).toEqual({ item: 'diamond', pos: { x: 120, y: 12, z: -40 } });
    expect(parseClaim('found iron_ore at 10 64 -3 by the river')).toEqual({ item: 'iron_ore', pos: { x: 10, y: 64, z: -3 } });
    expect(parseClaim('diamonds are great')).toBeNull();
    expect(parseClaim('meet me at 10, 64, 20')).toBeNull();
  });
});
