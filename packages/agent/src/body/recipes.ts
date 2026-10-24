// What the game data leaves out of the game's own recipes. Since 1.21.2 a wool, a carpet or a bed of any colour takes
// any dye (a white wool and a red dye make a red wool), but the data has each dyeing from black alone, or for beds not
// at all: a tag of every other colour came out as its first. An agent with white wool and the red dye it had made was
// told its red wool wanted a black one.

const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'] as const;
const DYED = ['wool', 'carpet', 'bed'] as const;

interface RawRecipe {
  ingredients?: number[];
  inShape?: unknown[][];
  result: { id: number; count: number };
}

interface RecipeRegistry {
  recipes: Record<number, RawRecipe[]>;
  itemsByName: Record<string, { id: number } | undefined>;
}

/** Puts each dyeing back into the registry's recipes (they are the version's, shared by every body): once, so twice adds nothing. How many were added. */
export function completeDyeing(registry: RecipeRegistry): number {
  let added = 0;
  for (const kind of DYED) {
    for (const colour of COLOURS) {
      const out = registry.itemsByName[`${colour}_${kind}`];
      const dye = registry.itemsByName[`${colour}_dye`];
      if (!out || !dye) continue;
      const list = registry.recipes[out.id] ?? [];
      for (const other of COLOURS) {
        if (other === colour) continue;
        const from = registry.itemsByName[`${other}_${kind}`];
        if (!from) continue;
        if (list.some((r) => r.ingredients?.length === 2 && r.ingredients.includes(dye.id) && r.ingredients.includes(from.id))) continue;
        list.push({ ingredients: [dye.id, from.id], result: { id: out.id, count: 1 } });
        added++;
      }
      registry.recipes[out.id] = list;
    }
  }
  return added;
}
