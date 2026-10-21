// M6 / M6a / M6b arithmetic (§6.3, §17.2–17.7, §18.2–18.5): the social model, emotions, biases and the conflict
// evaluator as pure functions.

import { describe, expect, it } from 'vitest';
import { PersonaSchema, type SocialProfile } from '@agora/shared';
import { complies, fearOf, gateFight, opportunity, powerOf, rungFor, sparesYielder, witnessCost, yieldHealth } from '@agora/agent/conflict/pressure';
import { conformityPull, confirmationScaled, effectiveJudgment, heardConsensus, isMob, overrideFactor } from '@agora/agent/mind/biases';
import { appraise, arousalOf, contagion, decayEmotions, topEmotion, updateMood, zeroEmotions } from '@agora/agent/mind/emotions';
import { GAME_DAY_MS, driftSentiment, effectiveDelta, grievanceWeightNow, resentment, withGrievance, withSentiment } from '@agora/agent/social/math';
import { newSocialProfile } from '@agora/agent/state/social';

const persona = (o: Record<string, unknown> = {}) => PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['calm'], ...o });
const profile = (p = persona(), patch: Partial<SocialProfile> = {}): SocialProfile => ({ ...newSocialProfile('Bram', p, 0), ...patch });

describe('social model math (§6.3, §17.2, §18.3)', () => {
  it('amplifies bad news by negativity and grudges, anchors on the first two meetings, clamps to ±2', () => {
    const forgiving = persona({ social: { grudge: 0 }, mind: { biasProfile: { negativity: 0 } } });
    const grudging = persona({ social: { grudge: 1 }, mind: { biasProfile: { negativity: 1 } } });
    const settled = { anchorCount: 2 };
    expect(effectiveDelta(-0.5, profile(forgiving, settled), forgiving)).toBeCloseTo(-0.5);
    expect(effectiveDelta(-0.5, profile(grudging, settled), grudging)).toBeCloseTo(-1.5);
    expect(effectiveDelta(0.5, profile(forgiving, { anchorCount: 0 }), forgiving)).toBeCloseTo(1);
    expect(effectiveDelta(-3, profile(grudging, settled), grudging)).toBe(-2);
    const p1 = withSentiment(profile(forgiving, { sentiment: 5 }), 1, forgiving, 10);
    expect(p1.sentiment).toBe(7);
    expect(p1.anchorCount).toBe(1);
    expect(withSentiment({ ...p1, sentiment: 9.5, anchorCount: 2 }, 2, forgiving, 20).sentiment).toBe(10);
  });

  it('drifts back to the persona baseline without contact, more slowly for grudge-holders', () => {
    const p = persona({ social: { baselineSentiment: 6, grudge: 0 } });
    const g = persona({ social: { baselineSentiment: 6, grudge: 1 } });
    expect(driftSentiment(profile(p, { sentiment: 3, lastSeen: 0 }), p, 5 * GAME_DAY_MS)).toBeCloseTo(3.5);
    expect(driftSentiment(profile(g, { sentiment: 3, lastSeen: 0 }), g, 5 * GAME_DAY_MS)).toBeCloseTo(3.25);
    expect(driftSentiment(profile(p, { sentiment: 8, lastSeen: 0 }), p, 100 * GAME_DAY_MS)).toBeCloseTo(6);
  });

  it('lets grievances fade unless vengeful, killings barely fade, and turns it all into resentment', () => {
    const g = { kind: 'attack' as const, weight: 0.5, ts: 0, witnessed: true, source: 'self_observed' as const };
    expect(grievanceWeightNow(g, 0, 2 * GAME_DAY_MS)).toBeCloseTo(0.25);
    expect(grievanceWeightNow(g, 1, 10 * GAME_DAY_MS)).toBeCloseTo(0.5);
    expect(grievanceWeightNow({ ...g, kind: 'killed_friend' }, 0, 2 * GAME_DAY_MS)).toBeGreaterThan(0.45);
    const p = persona({ temperament: { vengefulness: 0.5 } });
    expect(resentment(profile(p, { sentiment: 2 }), p, 0)).toBeCloseTo(0.3);
    const wronged = withGrievance(profile(p, { sentiment: 2 }), 'attack', p, { now: 0, witnessed: true, source: 'self_observed' });
    expect(resentment(wronged, p, 0)).toBeCloseTo(0.3 + 0.5 * 0.5);
    // Heard, not seen: weaker. An idol's wrongs are discounted by the halo effect.
    expect(withGrievance(profile(p), 'theft', p, { now: 0, witnessed: false, source: 'told_by:Cass' }).grievances[0]?.weight).toBeCloseTo(0.24);
    const fan = persona({ mind: { biasProfile: { halo: 1 } } });
    expect(withGrievance(profile(fan, { admiration: 0.9 }), 'theft', fan, { now: 0, witnessed: true, source: 'self_observed' }).grievances[0]?.weight).toBeCloseTo(0.12);
  });
});

describe('emotions (§18.2)', () => {
  it('appraises events by temperament and neuroticism, then decays and lifts the mood slowly', () => {
    const hothead = persona({ temperament: { aggression: 0.9 }, big5: { neuroticism: 0.9 }, drives: { caution: 0.2 } });
    const stoic = persona({ temperament: { aggression: 0.1 }, big5: { neuroticism: 0.1 }, drives: { caution: 0.2 } });
    const hit = { kind: 'attacked' as const, damage: 4 };
    const h = appraise(zeroEmotions(), hit, hothead);
    const s = appraise(zeroEmotions(), hit, stoic);
    expect(h.anger).toBeGreaterThan(s.anger * 2);
    expect(h.anger).toBeGreaterThan(h.fear);
    expect(h.arousal).toBeCloseTo(arousalOf(h));
    const later = decayEmotions(s, 90_000 * 1.1, stoic);
    expect(later.anger).toBeCloseTo(s.anger / 2, 2);
    expect(decayEmotions(h, 90_000 * 1.1, hothead).anger).toBeGreaterThan(h.anger / 2);
    expect(topEmotion(h)?.name).toBe('anger');
    expect(topEmotion(zeroEmotions())).toBeNull();
    const happy = appraise(zeroEmotions(), { kind: 'gift' }, stoic);
    const m = updateMood({ valence: 0, baselineShift: 0 }, happy, 60_000);
    expect(m.valence).toBeGreaterThan(0);
    expect(m.valence).toBeLessThan(0.01);
  });

  it('catches the crowd’s feeling in proportion to conformity × extraversion', () => {
    const follower = persona({ mind: { conformity: 0.9 }, big5: { extraversion: 0.9 } });
    const loner = persona({ mind: { conformity: 0.1 }, big5: { extraversion: 0.2 } });
    const crowd = { anger: 0.8 };
    expect(contagion(zeroEmotions(), crowd, follower).anger).toBeGreaterThan(contagion(zeroEmotions(), crowd, loner).anger * 5);
  });
});

describe('biases and the override (§18.4, §18.5)', () => {
  it('reasons best when rational, calm, given time and alone', () => {
    expect(overrideFactor(0.9, 0, 300, false)).toBeCloseTo(0.9);
    expect(overrideFactor(0.9, 1, 0, false)).toBeLessThan(0.15);
    expect(overrideFactor(0.9, 0, 300, true)).toBeCloseTo(0.63);
    expect(confirmationScaled(-1, 8, 1, 0)).toBeCloseTo(-0.5);
    expect(confirmationScaled(1, 8, 1, 0)).toBeCloseTo(1.5);
    expect(confirmationScaled(1, 8, 1, 1)).toBeCloseTo(1);
    expect(effectiveJudgment(2, 8, 0.5, 1)).toBeCloseTo(5.15);
  });

  it('conforms more under fear and weights heard opinions by admiration', () => {
    expect(conformityPull(0.3, 1, 0)).toBeCloseTo(0.75);
    expect(conformityPull(0.3, 0, 0)).toBeCloseTo(0.3);
    expect(conformityPull(0.5, 1, 1)).toBe(0);
    const ops = [
      { speaker: 'Cass', target: 'Bram', valence: -1, ts: 0 },
      { speaker: 'Dee', target: 'Bram', valence: 1, ts: 0 },
    ];
    expect(heardConsensus(ops, 'Bram', (s) => (s === 'Cass' ? 3 : 1), 10)).toBeCloseTo(2.5);
    expect(heardConsensus(ops, 'Nobody', () => 1, 10)).toBeNull();
    expect(isMob([{ name: 'a', anger: 0.6, distance: 3 }, { name: 'b', anger: 0.5, distance: 8 }, { name: 'c', anger: 0.5, distance: 12 }])).toBe(true);
    expect(isMob([{ name: 'a', anger: 0.9, distance: 3 }, { name: 'b', anger: 0.9, distance: 30 }, { name: 'c', anger: 0.9, distance: 12 }])).toBe(false);
  });
});

describe('the conflict evaluator (§17.4–17.7)', () => {
  it('derives power from what is visible and fear from the gap', () => {
    const geared = powerOf({ gear: 0.9, killsSeen: 2, fightsWonSeen: 1, followersSeen: 2 });
    const plain = powerOf({ gear: 0.1, killsSeen: 0, fightsWonSeen: 0, followersSeen: 0 });
    expect(geared).toBeGreaterThan(plain + 0.4);
    expect(powerOf({ gear: 0.9, killsSeen: 2, fightsWonSeen: 1, followersSeen: 2, healthFrac: 0.2 })).toBeLessThan(geared * 0.7);
    expect(fearOf(geared, plain, 0, 0.5)).toBeGreaterThan(0.9);
    expect(fearOf(plain, geared, 0, 0.5)).toBeLessThan(0.1);
    expect(fearOf(geared, plain, 0.6, 0.5)).toBeLessThan(fearOf(geared, plain, 0, 0.5));
    expect(opportunity({ alone: true, hurt: true, carryingWanted: false })).toBeCloseTo(0.6);
    expect(witnessCost([10, 5])).toBeCloseTo(0.3);
  });

  it('climbs the ladder past thresholds and steps down only 0.15 below them', () => {
    const lim = { maxRung: 4, lethalAllowed: false };
    expect(rungFor(0.1, 0, lim)).toBe(0);
    expect(rungFor(0.4, 0, lim)).toBe(2);
    expect(rungFor(0.3, 2, lim)).toBe(2);
    expect(rungFor(0.15, 2, lim)).toBe(1);
    expect(rungFor(0.9, 0, lim)).toBe(3);
    expect(rungFor(0.9, 0, { maxRung: 4, lethalAllowed: true })).toBe(4);
    expect(rungFor(0.9, 0, { maxRung: 2, lethalAllowed: true })).toBe(2);
    // Inside a mob every threshold drops by 0.1 (§18.4.2).
    expect(rungFor(0.45, 0, lim)).toBe(2);
    expect(rungFor(0.45, 0, { ...lim, thresholdShift: -0.1 })).toBe(3);
  });

  it('gates every fight in code', () => {
    const base = { intent: 'brawl' as const, pressure: 0.6, lim: { maxRung: 4, lethalAllowed: false }, cooldownUntil: 0, graceUntil: 0, fightCapReached: false, now: 1000 };
    expect(gateFight(base)).toBeNull();
    expect(gateFight({ ...base, pressure: 0.4 })).toMatch(/not angry enough/);
    expect(gateFight({ ...base, pressure: 0.4, intent: 'impulse' })).toBeNull();
    expect(gateFight({ ...base, intent: 'lethal', pressure: 0.9 })).toMatch(/to the death/);
    expect(gateFight({ ...base, lim: { maxRung: 2, lethalAllowed: false } })).toMatch(/limited to rung 2/);
    expect(gateFight({ ...base, cooldownUntil: 5000 })).toMatch(/too recently/);
    expect(gateFight({ ...base, graceUntil: 5000 })).toMatch(/too new/);
    expect(gateFight({ ...base, fightCapReached: true })).toMatch(/too many fights/);
  });

  it('yields sooner when cautious, spares by mercy, complies when fear outweighs resentment and pride', () => {
    expect(yieldHealth(0)).toBe(4);
    expect(yieldHealth(1)).toBe(10);
    expect(sparesYielder(0.9, 0, 3, 0.5)).toBe(true);
    expect(sparesYielder(0.9, 1, 4, 0.5)).toBe(false);
    expect(complies(0.9, 0.1, 1)).toBe(true);
    expect(complies(0.5, 0.4, 0)).toBe(false);
  });
});
