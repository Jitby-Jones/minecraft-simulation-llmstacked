// M6 trades and help (§6.6, §6.7): offers read from chat, prices by liking, the code default's answers, both
// halves of a deal recorded as promises, and help that ends when the other side says it's enough.

import { describe, expect, it } from 'vitest';
import { type Commitment, PersonaSchema, type Utterance, nullLogger } from '@agora/shared';
import type { Body } from '@agora/agent/body/body';
import { AgentBus } from '@agora/agent/bus';
import { ActionAwareness } from '@agora/agent/modules/awareness';
import { CognitiveController, codeDecision } from '@agora/agent/modules/cc';
import { HELP_DONE_RE, SkillExecutor } from '@agora/agent/modules/executor';
import { leversFor } from '@agora/agent/modules/levers';
import { needsDecision } from '@agora/agent/modules/talking';
import { SocialAwareness } from '@agora/agent/social/awareness';
import { CommitmentTracker } from '@agora/agent/social/commitments';
import { TradeTracker, judgeOffer, parseHelpRequest, parseTradeOffer, priceFactor, valueOf } from '@agora/agent/social/trades';
import { createInitialState } from '@agora/agent/state/initial';
import { newSocialProfile } from '@agora/agent/state/social';
import { AgentStateStore } from '@agora/agent/state/store';

const persona = PersonaSchema.parse({ name: 'Pip', sex: 'female', traits: ['generous'], social: { baselineSentiment: 5, grudge: 0 }, quirks: [{ hook: 'tradeBias', item: 'iron_ingot', multiplier: 1.5 }] });
const store = () => new AgentStateStore(createInitialState({ persona, username: 'Pip', now: 0 }));
const never = () => false;

function heard(from: string, text: string, ts = 1): Utterance {
  return { id: `u${ts}`, convId: 'c1', from, to: 'nearby', text, ts, pos: null, volume: 'normal', outOfSight: false, addressedToMe: true };
}

function withState(s: AgentStateStore, o: { liking?: number; trust?: number; inventory?: { item: string; qty: number }[]; lines?: Utterance[] }): void {
  s.update('social', (all) => ({ ...all, Bram: { ...newSocialProfile('Bram', persona, 0), sentiment: o.liking ?? 7, trust: o.trust ?? 0.5 } }));
  if (o.inventory) s.update('self', (x) => ({ ...x, inventory: o.inventory ?? [] }));
  if (o.lines) s.update('perception', (p) => ({ ...p, heardSpeech: o.lines ?? [] }));
}

describe('reading offers and requests for help', () => {
  it('reads both sides of an offer, whichever way round it is said', () => {
    expect(parseTradeOffer("Pip, I'll give you 3 bread for 8 logs")).toEqual({ give: [{ item: 'bread', qty: 3 }], want: [{ item: 'log', qty: 8 }] });
    expect(parseTradeOffer('trade you my 2 iron ingots for your 16 cobblestone?')).toEqual({ give: [{ item: 'iron_ingot', qty: 2 }], want: [{ item: 'cobblestone', qty: 16 }] });
    expect(parseTradeOffer('give me 8 logs and I will give you 3 bread')).toBeNull();
    expect(parseTradeOffer("give me 8 logs and I'll give you 3 bread")).toEqual({ give: [{ item: 'bread', qty: 3 }], want: [{ item: 'log', qty: 8 }] });
    expect(parseTradeOffer('can you give me 8 logs for 3 bread?')).toEqual({ give: [{ item: 'bread', qty: 3 }], want: [{ item: 'log', qty: 8 }] });
    expect(parseTradeOffer('want to trade? 4 apples for 2 coal')).toEqual({ give: [{ item: 'apple', qty: 4 }], want: [{ item: 'coal', qty: 2 }] });
    expect(parseTradeOffer('I need 8 logs for 2 doors')).toBeNull();
    expect(parseTradeOffer('nice weather today')).toBeNull();
    // An offer always wants an answer from the CC.
    expect(needsDecision('3 bread for 8 logs?')).toBe(true);
  });

  it('reads what someone wants help gathering', () => {
    expect(parseHelpRequest('Pip, can you help me gather wood?')).toEqual({ item: 'log', qty: 8 });
    expect(parseHelpRequest('help me mine 16 stone')).toEqual({ item: 'cobblestone', qty: 16 });
    expect(parseHelpRequest('could you help me chopping some trees')).toEqual({ item: 'log', qty: 8 });
    expect(parseHelpRequest('help me out here')).toBeNull();
    expect(HELP_DONE_RE.test("thanks, that's enough")).toBe(true);
    expect(HELP_DONE_RE.test('keep going')).toBe(false);
  });
});

describe('prices (§6.3: willingness to trade at 6, friends get a better deal)', () => {
  const have = (n: number) => () => n;
  it('accepts a fair offer, counters a close one and declines the rest', () => {
    const offer = (bread: number) => ({ give: [{ item: 'bread', qty: bread }], want: [{ item: 'log', qty: 8 }] });
    expect(judgeOffer(offer(6), { sentiment: 7, trust: 0.5, have: have(8) })).toEqual({ kind: 'accept' });
    expect(judgeOffer(offer(3), { sentiment: 7, trust: 0.5, have: have(8) })).toEqual({ kind: 'counter', offer: { give: [{ item: 'bread', qty: 3 }], want: [{ item: 'log', qty: 4 }] } });
    expect(judgeOffer(offer(1), { sentiment: 7, trust: 0.5, have: have(8) }).kind).toBe('decline');
    expect(judgeOffer(offer(6), { sentiment: 5, trust: 0.5, have: have(8) }).kind).toBe('decline');
    expect(judgeOffer(offer(6), { sentiment: 7, trust: 0.2, have: have(8) }).kind).toBe('decline');
    expect(judgeOffer(offer(6), { sentiment: 7, trust: 0.5, have: have(3) })).toEqual({ kind: 'decline', why: "you don't have 8 log" });
  });

  it('gives friends a discount and charges more for what a quirk holds dear', () => {
    expect(priceFactor(10)).toBeLessThan(priceFactor(8));
    expect(priceFactor(6)).toBe(1);
    expect(valueOf({ item: 'iron_ingot', qty: 2 }, persona.quirks)).toBeCloseTo(12);
    expect(valueOf({ item: 'oak_log', qty: 3 })).toBe(3);
  });
});

describe('the code default answers offers and requests for help', () => {
  it('accepts a fair trade: hands over its half and both halves are promises', () => {
    const s = store();
    withState(s, { inventory: [{ item: 'oak_log', qty: 8 }], lines: [heard('Bram', "Pip, I'll give you 6 bread for 8 logs")] });
    const bus = new AgentBus();
    const body = { skill: () => null, run: () => new Promise(() => undefined) } as unknown as Body;
    const executor = new SkillExecutor({ store: s, bus, body, logger: nullLogger(), levers: () => leversFor(0.5) });
    const awareness = new ActionAwareness({ store: s, bus, logger: nullLogger() });
    const cc = new CognitiveController({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip', levers: () => leversFor(0.5), awareness, executor, canPerceive: () => true });
    cc.start();
    bus.emit({ type: 'needsDecision', reason: 'request', convId: 'c1', from: 'Bram' });
    expect(s.state.decision?.trade).toMatchObject({ with: 'Bram', phase: 'accept', give: [{ item: 'log', qty: 8 }], want: [{ item: 'bread', qty: 6 }] });
    expect(s.state.decision?.speechIntent).toMatchObject({ stance: 'agree', mayCommit: true, gist: "I'll give you 8 logs for your 6 bread" });
    expect(s.state.commitments.map((c) => `${c.debtor}>${c.creditor} ${c.what.text}`)).toEqual(['Pip>Bram 8 logs', 'Bram>Pip 6 bread']);
    expect(s.state.taskQueue.map((t) => `${t.skill} ${JSON.stringify(t.args)}`)).toEqual(['give {"to":"Bram","item":"log","qty":8}']);
    cc.stop();
  });

  it('counters a stingy offer with what it is worth to it, and turns down strangers', () => {
    const s = store();
    withState(s, { inventory: [{ item: 'oak_log', qty: 8 }], lines: [heard('Bram', '3 bread for 8 logs?')] });
    const counter = codeDecision(s.state, { from: 'Bram', convId: 'c1' }, false, never);
    expect(counter?.trade).toMatchObject({ phase: 'counter', give: [{ item: 'log', qty: 4 }], want: [{ item: 'bread', qty: 3 }] });
    expect(counter?.speechIntent).toMatchObject({ stance: 'negotiate', gist: 'how about 4 logs for your 3 bread?', mayCommit: false });
    withState(s, { liking: 5 });
    expect(codeDecision(s.state, { from: 'Bram', convId: 'c1' }, false, never)?.speechIntent?.stance).toBe('decline');
  });

  it('helps a friend gather, promising to hand over what it gathers', () => {
    const s = store();
    withState(s, { lines: [heard('Bram', 'Pip, can you help me gather wood?')] });
    const d = codeDecision(s.state, { from: 'Bram', convId: 'c1' }, false, never);
    expect(d).toMatchObject({ option: 'help', target: { agent: 'Bram' }, task: { skill: 'gather', args: { item: 'log', qty: 8 } } });
    expect(d?.commitmentsToCreate?.[0]?.what).toMatchObject({ kind: 'help', item: 'log', qty: 8 });
  });
});

describe('a deal we offered, and help called off', () => {
  it('records the deal when they say yes, and notes it when they say no', () => {
    const s = store();
    const bus = new AgentBus();
    const deals: string[] = [];
    const tt = new TradeTracker({ store: s, bus, logger: nullLogger(), me: 'Pip', onDeal: (w, ours, theirs) => deals.push(`${w}: ${ours[0]?.qty} ${ours[0]?.item} for ${theirs[0]?.qty} ${theirs[0]?.item}`) });
    tt.start();
    const asked: string[] = [];
    bus.on('needsDecision', (e) => asked.push(e.reason));
    const offer = (w: string) =>
      bus.emit({ type: 'decision', decision: { id: 'd', createdAt: 0, stateVersion: 0, source: 'llm', option: 'trade', trade: { with: w, phase: 'offer', give: [{ item: 'bread', qty: 3 }], want: [{ item: 'log', qty: 4 }] }, terminate: { maxSeconds: 60 }, rationale: '' } });
    offer('Bram');
    expect(tt.waitingOn('Bram')).toBe(true);
    bus.emit({ type: 'addressed', utterance: heard('Bram', 'deal!') });
    expect(deals).toEqual(['Bram: 3 bread for 4 log']);
    expect(asked).toEqual(['deal']);
    offer('Tobin');
    bus.emit({ type: 'addressed', utterance: heard('Tobin', 'nah, no thanks') });
    expect(tt.waitingOn('Tobin')).toBe(false);
    expect(s.state.workmem.at(-1)?.text).toBe('Tobin turned down my offer');
    tt.stop();
  });

  it('hands over what was gathered when the help is called off, or is simply done with nothing gathered', () => {
    const s = store();
    const bus = new AgentBus();
    const social = new SocialAwareness({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip' });
    const ct = new CommitmentTracker({ store: s, bus, logger: nullLogger(), llm: null, me: 'Pip', social });
    ct.start();
    const help: Commitment = { id: 'k1', debtor: 'Pip', creditor: 'Bram', what: { kind: 'help', item: 'log', qty: 8, text: 'help gather 8 logs' }, status: 'accepted', createdFromConv: 'c1', createdAt: 0, dueBy: Date.now() + 600_000 };
    s.update('commitments', () => [help]);
    s.update('taskQueue', () => [{ id: 't1', skill: 'give', args: { to: 'Bram', item: 'log', qty: 8 }, source: 'commitment', commitmentId: 'k1', createdAt: 0, priority: 1 }]);
    s.update('self', (x) => ({ ...x, inventory: [{ item: 'oak_log', qty: 3 }] }));
    bus.emit({ type: 'optionTerminated', reason: 'they said done', ok: true, option: 'help', targetAgent: 'Bram' });
    expect(s.state.commitments[0]?.what.qty).toBe(3);
    expect(s.state.taskQueue[0]?.args.qty).toBe(3);
    // Handing over those three keeps the promise.
    bus.emit({ type: 'actionRecorded', record: { id: 'r', skill: 'give', args: { to: 'Bram', item: 'log', qty: 3 }, expected: '', observed: '', ok: true, ts: 0, durationMs: 1 } });
    expect(s.state.commitments[0]?.status).toBe('fulfilled');
    // Called off before anything was gathered: nothing to hand over, and the help counts as given.
    s.update('commitments', () => [{ ...help, id: 'k2' }]);
    s.update('self', (x) => ({ ...x, inventory: [] }));
    bus.emit({ type: 'optionTerminated', reason: 'they said done', ok: true, option: 'help', targetAgent: 'Bram' });
    expect(s.state.commitments[0]?.status).toBe('fulfilled');
    ct.stop();
  });
});
