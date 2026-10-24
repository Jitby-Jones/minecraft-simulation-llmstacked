// M6a (§18.1–18.5): emotions from events, gossip read in code, first impressions, gut against facts, and the
// impulse path, against fakes. The live scenarios (Q impulse, M halo, N mob) are in tests/live/m6a-minds.test.ts.

import { describe, expect, it } from 'vitest';
import { type DecisionOutput, PersonaSchema, type Utterance, nullLogger } from '@agora/shared';
import { AgentBus } from '@agora/agent/bus';
import { BiasWatch, causeOf } from '@agora/agent/mind/biasWatch';
import { Crowd } from '@agora/agent/mind/crowd';
import { Feelings, insecurityWords } from '@agora/agent/mind/feelings';
import { Impulses, pickImpulse } from '@agora/agent/mind/impulses';
import { Mind } from '@agora/agent/mind/mind';
import { zeroEmotions } from '@agora/agent/mind/emotions';
import { SocialAwareness } from '@agora/agent/social/awareness';
import { readOpinions } from '@agora/agent/social/opinions';
import { firstImpression, styleImpression } from '@agora/agent/social/impressions';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';

const hothead = PersonaSchema.parse({
  name: 'Kai',
  sex: 'male',
  traits: ['hot-tempered'],
  big5: { neuroticism: 0.9, agreeableness: 0.15, extraversion: 0.7 },
  temperament: { aggression: 0.8, vengefulness: 0.7 },
  mind: { impulsivity: 0.9, rationality: 0.2, vanity: 0.8, biasProfile: { halo: 0.9 } },
  insecurities: ['being called lazy'],
});
const stoic = PersonaSchema.parse({
  name: 'Sol',
  sex: 'female',
  traits: ['calm'],
  big5: { neuroticism: 0.1, agreeableness: 0.8 },
  temperament: { aggression: 0.1 },
  mind: { impulsivity: 0.1, rationality: 0.9, vanity: 0.1, biasProfile: { halo: 0.1 } },
});

function line(from: string, text: string): Utterance {
  return { id: `u${Math.random()}`, convId: 'c1', from, to: 'nearby', text, ts: Date.now(), pos: null, volume: 'normal', outOfSight: false, addressedToMe: true, heardAs: 'me' };
}

function feelingsFor(persona = hothead) {
  const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: 0 }));
  const bus = new AgentBus();
  const t = { now: 1_000_000 };
  const f = new Feelings({ store: s, bus, logger: nullLogger(), me: persona.name, tickMs: 60_000, rng: () => 0, now: () => t.now });
  f.start();
  return { s, bus, f, t };
}

describe('gossip read in code (§18.4.1 heard opinions)', () => {
  it('finds who is spoken of and how, clause by clause', () => {
    const known = ['Bram', 'Mira', 'Tobin'];
    expect(readOpinions('Bram is nice but Mira is a thief', 'Tobin', known, 5)).toEqual([
      { speaker: 'Tobin', target: 'Bram', valence: 0.6, ts: 5 },
      { speaker: 'Tobin', target: 'Mira', valence: -0.7, ts: 5 },
    ]);
    expect(readOpinions("never trust Bram", 'Mira', known, 5)[0]?.valence).toBe(-0.7);
    expect(readOpinions("Bram isn't a thief, you know", 'Mira', known, 5)[0]?.valence).toBe(0.3);
    expect(readOpinions('I am great', 'Bram', known, 5)).toEqual([]);
    expect(readOpinions('Mira went mining', 'Bram', known, 5)).toEqual([]);
  });
});

describe('feelings from what happens (§18.2)', () => {
  it('an insult makes a hothead furious at the one who said it, and a stoic barely notices', () => {
    const hot = feelingsFor(hothead);
    hot.bus.emit({ type: 'addressed', utterance: line('Bram', 'Kai, you are so lazy') });
    expect(hot.s.state.emotions.anger).toBeGreaterThan(0.7);
    expect(hot.s.state.emotions.shame).toBeGreaterThan(0.3);
    expect(hot.f.angerToward('Bram')).toBeGreaterThan(0.5);
    const calm = feelingsFor(stoic);
    calm.bus.emit({ type: 'addressed', utterance: line('Bram', 'Sol, you are so lazy') });
    expect(calm.s.state.emotions.anger).toBeLessThan(0.2);
    expect(insecurityWords(['being called lazy', 'getting lost'])).toEqual(['lazy', 'lost']);
  });

  it('gossip is not an insult, praise cools anger, and feelings fade', () => {
    const { s, bus, f, t } = feelingsFor(hothead);
    s.update('social', (all) => ({ ...all, Mira: newSocialProfile('Mira', hothead, 0) }));
    bus.emit({ type: 'addressed', utterance: line('Bram', 'Kai, Mira is a thief') });
    expect(s.state.emotions.anger).toBe(0);
    bus.emit({ type: 'attacked', by: 'zombie', damage: 4 });
    expect(s.state.emotions.fear).toBeGreaterThan(0.3);
    t.now += 10 * 60_000;
    (f as unknown as { tick(): void }).tick();
    expect(s.state.emotions.fear).toBeLessThan(0.05);
  });

  it('the tone of nearby speech rubs off (contagion)', () => {
    const { s, bus } = feelingsFor(hothead);
    bus.emit({ type: 'overheard', utterance: { ...line('Mira', 'run!! a creeper!'), addressedToMe: false, heardAs: 'other' } });
    expect(s.state.emotions.fear).toBeGreaterThan(0);
  });
});

describe('acting on impulse (§18.5)', () => {
  it('picks a reaction from the strongest feeling, only when arousal runs high', () => {
    const angry = { ...zeroEmotions(), anger: 0.9, arousal: 0.9 };
    expect(pickImpulse(angry, hothead, 'insulted', 0, false)).toBe('outburst');
    expect(pickImpulse(angry, hothead, 'insulted', 0, true)).toBe('punch');
    expect(pickImpulse(angry, hothead, 'insulted', 0.95, false)).toBeNull();
    expect(pickImpulse({ ...zeroEmotions(), fear: 0.9, arousal: 0.9 }, hothead, 'attacked', 0, false)).toBe('flee');
    expect(pickImpulse({ ...zeroEmotions(), anger: 0.5, arousal: 0.5 }, hothead, 'insulted', 0, false)).toBeNull();
    expect(pickImpulse(angry, stoic, 'insulted', 0.2, false)).toBeNull();
  });

  it('an insulted hothead snaps back at once; later, calm again, he goes to say sorry to someone he likes', async () => {
    const { s, bus, t } = feelingsFor(hothead);
    const said: string[] = [];
    const impulses: DecisionOutput[] = [];
    const imp = new Impulses({
      store: s,
      bus,
      logger: nullLogger(),
      me: 'Kai',
      cc: { impulse: (d) => (impulses.push(d), true) },
      talking: { blurt: async (to, text) => (said.push(`${to}: ${text}`), true), refuse: () => undefined },
      conversations: { withPartner: () => undefined, end: () => undefined },
      rng: () => 0,
      now: () => t.now,
    });
    imp.start();
    s.update('social', (all) => ({ ...all, Bram: { ...newSocialProfile('Bram', hothead, 0), sentiment: 7 } }));
    bus.emit({ type: 'addressed', utterance: line('Bram', 'Kai, you are useless') });
    await Promise.resolve();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Bram: /);
    // A minute later, calm again.
    t.now += 60_000;
    s.update('emotions', () => zeroEmotions());
    (imp as unknown as { checkRegrets(): void }).checkRegrets();
    expect(impulses.at(-1)).toMatchObject({ option: 'talk', target: { agent: 'Bram' }, speechIntent: { stance: 'apologize' } });
    imp.stop();
  });
});

describe('first impressions and gut against facts (§18.3, §18.5)', () => {
  it('shiny gear impresses the vain, not the rest', () => {
    const diamond = firstImpression(0.85, hothead);
    const leather = firstImpression(0.1, hothead);
    expect(diamond.sentimentDelta).toBeGreaterThan(0.8);
    expect(leather.sentimentDelta).toBeLessThan(0.25);
    expect(firstImpression(0, hothead)).toEqual({ sentimentDelta: 0, admiration: 0 });
    expect(diamond.admiration).toBeGreaterThan(0.5);
    expect(Math.abs(firstImpression(0.85, stoic).sentimentDelta)).toBeLessThan(0.15);
    expect(styleImpression(['haha, nice one!'], hothead).sentimentDelta).toBeGreaterThan(0);
  });

  it('a rational, calm mind goes by the facts; a hothead by the gut', () => {
    const judge = (persona: typeof hothead) => {
      const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: 0 }));
      // A first impression and hearsay made them dislike Bram, who has only ever done right by them.
      s.update('social', (all) => ({ ...all, Bram: { ...newSocialProfile('Bram', persona, 0), sentiment: 2, evidence: 8, promisesKept: 3, anchorCount: 1, interactions: 1 } }));
      const mind = new Mind(() => s.state, { secondsSinceTrigger: () => 600, angerToward: () => 0 });
      return mind.about('Bram');
    };
    const rash = judge(hothead);
    const wise = judge(stoic);
    expect(wise?.judgment ?? 0).toBeGreaterThan(rash?.judgment ?? 10);
    expect(wise?.judgment ?? 0).toBeGreaterThan(6);
    expect(rash?.factsWhy).toContain('kept 3/3 promises to you');
  });
});

describe('biases in the social model (§18.4)', () => {
  function social(persona = hothead, override = 0) {
    const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: 0 }));
    const bus = new AgentBus();
    const sa = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: persona.name, settleMs: 0, mind: { override: () => override, fearLevel: () => 0 }, now: () => 1000 });
    sa.start();
    return { s, bus, sa };
  }

  it('conformity: what people say about someone pulls a conformist along, hardly a stoic', () => {
    const say = (bus: AgentBus, from: string, text: string) => bus.emit({ type: 'heard', utterance: { ...line(from, text), addressedToMe: false } });
    const follower = social(hothead, 0.05);
    const loner = social(stoic, 0.9);
    for (const { s, bus } of [follower, loner]) {
      s.update('social', (all) => ({ ...all, Rex: newSocialProfile('Rex', s.state.self.persona, 0) }));
      say(bus, 'Ann', 'Rex is a thief!');
      say(bus, 'Ben', 'yeah, Rex stole my iron');
      say(bus, 'Cid', 'never trust Rex');
    }
    expect(follower.s.state.social.Rex?.sentiment ?? 10).toBeLessThan(4);
    expect(loner.s.state.social.Rex?.sentiment ?? 0).toBeGreaterThan(4.7);
    expect(follower.s.state.heardOpinions.map((o) => o.speaker)).toEqual(['Ann', 'Ben', 'Cid']);
  });

  it('first impressions fade into the facts for the rational, over a few interactions', () => {
    const gapAfter = (persona: typeof hothead) => {
      const { s, sa } = social(persona, persona.mind.rationality);
      // Same deeds from both; only the first impression differed (diamond vs leather).
      s.update('social', (all) => ({
        ...all,
        Dia: { ...newSocialProfile('Dia', persona, 0), sentiment: 7, anchorCount: 2 },
        Lea: { ...newSocialProfile('Lea', persona, 0), sentiment: 3.5, anchorCount: 2 },
      }));
      for (let i = 0; i < 5; i++) for (const n of ['Dia', 'Lea']) sa.deed(n, 'keptPromise');
      return (s.state.social.Dia?.sentiment ?? 0) - (s.state.social.Lea?.sentiment ?? 0);
    };
    const rational = { ...stoic, mind: { ...stoic.mind, vanity: 0.9 } };
    // The gap started at 3.5: about halved for the rational after five, nearly all of it left for the rash.
    expect(gapAfter(rational)).toBeLessThan(2);
    expect(gapAfter(hothead)).toBeGreaterThan(3);
  });

  it('confirmation: a conversation that fits how we already feel counts more', () => {
    const { s, bus } = social(hothead, 0);
    s.update('social', (all) => ({ ...all, Bram: { ...newSocialProfile('Bram', hothead, 0), sentiment: 8, anchorCount: 2 } }));
    s.update('conversations', (cs) => ({
      ...cs,
      c1: { convId: 'c1', participants: ['Kai', 'Bram'], startedAt: 0, lastActivity: 1, turns: 1, myTurns: 0, lastEmbeds: [], status: 'ended', transcript: [line('Bram', 'thanks, great work')], initiatedByMe: false },
    }));
    bus.emit({ type: 'conversationEnded', convId: 'c1', reason: 'turn cap' });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        // Code default +0.4 for the kind words; confirmation makes it +0.5 (8.35 without it, after alignment).
        expect(s.state.social.Bram?.sentiment ?? 0).toBeGreaterThan(8.4);
        resolve();
      }, 50),
    );
  });
});

describe('biases on events (§18.4)', () => {
  it('a creeper death makes creepers scarier for a while; a misfortune is pinned on a disliked person', () => {
    const s = new AgentStateStore(createInitialState({ persona: hothead, username: 'Kai', now: 0 }));
    const bus = new AgentBus();
    const t = { now: 0 };
    const nudged: string[] = [];
    const bw = new BiasWatch({ store: s, bus, logger: nullLogger(), me: 'Kai', override: () => 0, nudge: (n, d, note) => nudged.push(`${n} ${d}: ${note}`), rng: () => 0, now: () => t.now });
    bw.start();
    expect(causeOf('Bram was blown up by Creeper')).toBe('creeper');
    expect(causeOf('Mira tried to swim in lava')).toBe('lava');
    bus.emit({ type: 'peerDied', name: 'Bram', cause: 'blew up', witnessed: true });
    expect(bw.fearBoost('creeper')).toBeGreaterThan(1);
    expect(bw.fearBoost('zombie')).toBe(0);
    t.now += 31 * 60_000;
    expect(bw.fearBoost('creeper')).toBe(0);
    // No known killer, afraid, and Rex is already disliked: he gets the blame.
    s.update('emotions', (e) => ({ ...e, fear: 0.6 }));
    s.update('social', (all) => ({ ...all, Rex: { ...newSocialProfile('Rex', hothead, 0), sentiment: 2 } }));
    bus.emit({ type: 'peerDied', name: 'Mira', cause: 'died', witnessed: false });
    expect(nudged).toEqual(["Rex -0.5: I bet Rex had something to do with Mira's death"]);
    bw.stop();
  });
});

describe('mobs (§18.4.2)', () => {
  function onlooker(persona: typeof hothead, override: number, evidence: number) {
    const s = new AgentStateStore(createInitialState({ persona, username: persona.name, now: 0 }));
    const bus = new AgentBus();
    const said: string[] = [];
    s.update('perception', (p) => ({
      ...p,
      nearbyEntities: ['Ann', 'Ben', 'Cid', 'Rex'].map((name, i) => ({ id: i, kind: 'player' as const, name, pos: { x: i, y: 0, z: 0 }, distance: 3 + i, visible: true, heldItem: null, armor: [], lastSeen: 0, hurtRecently: false })),
    }));
    s.update('social', (all) => ({ ...all, Rex: { ...newSocialProfile('Rex', persona, 0), sentiment: evidence > 6 ? 7 : 3, evidence } }));
    const crowd = new Crowd({ store: s, bus, logger: nullLogger(), me: persona.name, angerToward: () => 0, override: () => override, liking: (n) => s.state.social[n]?.sentiment ?? 5, say: async (to, text) => (said.push(`${to}: ${text}`), true) });
    crowd.start();
    for (const [from, text] of [['Ann', 'Rex is a thief!'], ['Ben', 'yeah, Rex stole my iron'], ['Cid', 'Rex is a liar']] as const) {
      bus.emit({ type: 'heard', utterance: { ...line(from, text), addressedToMe: false } });
    }
    return { crowd, said };
  }

  it('a conformist joins in; a rational onlooker who knows better objects', async () => {
    const joiner = onlooker(hothead, 0.05, 5);
    const objector = onlooker(stoic, 0.9, 8);
    await Promise.resolve();
    expect(joiner.said).toEqual(['Ben: yeah, Rex is no good!']);
    expect(joiner.crowd.isMob('Rex')).toBe(true);
    expect(objector.said).toEqual(['Ben: hold on, Rex has always been fair with me.']);
  });
});
