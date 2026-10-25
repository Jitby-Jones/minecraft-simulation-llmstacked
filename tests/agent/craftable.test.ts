// What the recipe book shows from what one carries, of what keeps one alive (owner request, 2026-10-24: a sense, never
// what to make). One agent carried 14 iron ingots and wore no armor; another held 9 in a cave at 8 health.

import { describe, expect, it } from 'vitest';
import { craftableNow } from '@agora/agent/modules/craftable';
import { createInitialState } from '@agora/agent/state/initial';
import { PersonaSchema } from '@agora/shared';

const base = createInitialState({ persona: PersonaSchema.parse({ name: 'Ada', sex: 'female', traits: ['practical'] }), username: 'Ada', now: 0 });
const carrying = (items: Record<string, number>, armor: string[] = []) => ({ ...base, self: { ...base.self, inventory: Object.entries(items).map(([item, qty]) => ({ item, qty })), armor } });

describe('what one could make from what one carries', () => {
  it('14 iron ingots and no armor: the iron armor; with sticks to be had, a sword and a shield too', () => {
    expect(craftableNow(carrying({ iron_ingot: 14, oak_planks: 1, wooden_axe: 1, cobblestone: 242 }))).toBe(
      'From what you carry you could make: iron armor from your 14 iron ingots (a chestplate takes 8, leggings 7, a helmet 5, boots 4).',
    );
    expect(craftableNow(carrying({ iron_ingot: 9, oak_log: 8, stone_sword: 1 }))).toBe(
      'From what you carry you could make: iron armor from your 9 iron ingots (a chestplate takes 8, leggings 7, a helmet 5, boots 4), an iron sword (2 iron ingots and a stick), a shield (6 planks and an iron ingot).',
    );
  });

  it('only what is better than what one has on or carries', () => {
    const line = craftableNow(carrying({ iron_ingot: 6, stick: 2, iron_sword: 1, shield: 1 }, ['iron_chestplate', 'iron_boots']));
    expect(line).toBe('From what you carry you could make: iron armor from your 6 iron ingots (a helmet takes 5).');
    // Diamonds: the pieces five or fewer take, over iron worn too.
    expect(craftableNow(carrying({ diamond: 5, stick: 1 }, ['iron_helmet']))).toBe('From what you carry you could make: diamond armor from your 5 diamonds (a helmet takes 5, boots 4), a diamond sword (2 diamonds and a stick).');
  });

  it('the first sword from cobblestone and logs; food cooked or baked', () => {
    expect(craftableNow(carrying({ cobblestone: 12, oak_log: 2, beef: 3, wheat: 7 }))).toBe(
      'From what you carry you could make: a stone sword (2 cobblestone and a stick), steak from your 3 beef (in a furnace), bread (3 wheat a loaf; you have 7).',
    );
  });

  it('nothing better to make: nothing said', () => {
    expect(craftableNow(carrying({ dirt: 30, oak_sapling: 2 }))).toBeNull();
    expect(craftableNow(carrying({}))).toBeNull();
  });
});
