// M8b (§17.7, §17.8, §17.5 rung 4): power structures, without Minecraft. Demands and coerced commitments, compliance
// out of fear, followers and leaders, shared grudges and coalitions, the lethal rung behind the gate. Live behavior
// is in tests/live/m8b-power.test.ts (scenarios J, K and L).

import { describe, expect, it } from 'vitest';
import { companionsOf, complies, follows, looksLikeLeader, parseDemand } from '@agora/agent/conflict/coercion';

describe('demands and compliance (§17.7)', () => {
  it('a request with a threat on it is a demand; a polite one is not', () => {
    expect(parseDemand('give me 5 iron or else')).toEqual({ item: 'iron', qty: 5, recurring: false });
    expect(parseDemand("bring me bread every day or you'll regret it")).toEqual({ item: 'bread', qty: 1, recurring: true });
    expect(parseDemand('hand over your logs if you know what’s good for you'.replace('’', "'"))).toEqual({ item: 'log', qty: 1, recurring: false });
    expect(parseDemand('give me 3 bread, please?')).toBeNull();
    expect(parseDemand('or else what?')).toBeNull();
  });

  it('complies when fear outweighs resentment and pride; the loyal bend more easily', () => {
    expect(complies(0.9, 0.1, 0.5)).toBe(true); // 0.9 > 0.1 + 0.75
    expect(complies(0.7, 0.1, 0.5)).toBe(false);
    expect(complies(0.7, 0.1, 1)).toBe(true); // pride 0.5
    expect(complies(0.95, 0.4, 0.5)).toBe(false); // too resentful
  });

  it('follows after complying twice, or for protection; a leader has followers or tribute', () => {
    expect(follows({ complied: 2, fearOfOthers: 0, sentiment: 3, power: 0.2 })).toBe(true);
    expect(follows({ complied: 0, fearOfOthers: 0.7, sentiment: 7, power: 0.7 })).toBe(true);
    expect(follows({ complied: 1, fearOfOthers: 0.7, sentiment: 4, power: 0.9 })).toBe(false);
    expect(looksLikeLeader(2, 0)).toBe(true);
    expect(looksLikeLeader(1, 1)).toBe(false);
    expect(companionsOf([{ with: ['Rex'] }, { with: ['Rex', 'Ann'] }, { with: ['Rex'] }, { with: ['Ann'] }])).toEqual(['Rex']);
  });
});
