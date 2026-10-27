// The model says what to get; code works out how (§13 rule 2). A task that names a way of getting an item ("craft a
// crafting table", "mine iron ore", "gather sticks") goes to obtain, which plans the steps (wood first, the tools, a
// table) and runs them: in live runs most failed tasks were a craft without the ingredients, a mine without the
// pickaxe or of a block that isn't there (cobblestone), and a gather of something no block drops. Kinds of wood are
// one kind here (a "gather oak_log" with only birch around cuts the birch), and a crafting table or a chest set down
// "at" a spot a model guessed (in a lake, as often as not) goes wherever there is room nearby.

type Task = { skill: string; args: Record<string, unknown> };

const WOOD = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_(log|stem|planks)$/;
const ORE = /^(?:deepslate_)?(coal|iron|copper|gold|diamond|emerald|lapis|redstone)_ore$/;
const ORE_DROP: Readonly<Record<string, string>> = {
  coal: 'coal',
  iron: 'raw_iron',
  copper: 'raw_copper',
  gold: 'raw_gold',
  diamond: 'diamond',
  emerald: 'emerald',
  lapis: 'lapis_lazuli',
  redstone: 'redstone',
};
/** Things that are made, not dug: no block drops them. */
const MADE =
  /^(stick|crafting_table|furnace|chest|barrel|torch|bread|ladder|bowl|bucket|shears|campfire|smoker|lantern|.+_(planks|pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots|door|trapdoor|slab|stairs|fence|bed|boat|button|pressure_plate|sign))$/;
/** Blocks that serve wherever they stand: set down where there is room, not at a guessed spot. */
const PUT_ANYWHERE = /^(crafting_table|furnace|chest|barrel|campfire|torch|lantern|smoker|blast_furnace)$/;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_') : null);

/** Any wood for a named kind of wood ("oak_log" → "log", "birch_planks" → "planks"); other items as they are. */
export function anyWood(item: string): string {
  const m = WOOD.exec(item);
  if (!m) return item;
  return m[2] === 'planks' ? 'planks' : 'log';
}

/**
 * The task as it is best run: an item asked for by the wrong way of getting it goes to obtain. `canonical` gives a
 * skill's own name for one of its aliases ("chop" → "gather"), or null for no such skill; `held`, how many of an item
 * the agent has (craft, mine and gather get that many *more*; obtain is having that many).
 */
export function routeItemTask(task: Task, canonical: (skill: string) => string | null, held: (item: string) => number = () => 0): Task {
  const skill = canonical(task.skill) ?? task.skill;
  const a = task.args;
  const n = Number(a.qty ?? a.count ?? a.amount);
  const more = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  // obtain holds up to a stack at a time.
  const withQty = (item: string): Record<string, unknown> => ({ item, qty: Math.min(64, held(item) + more) });
  if (skill === 'craft') {
    const item = str(a.item);
    return item ? { skill: 'obtain', args: withQty(anyWood(item)) } : task;
  }
  // A dig with a kind of block and no spot is a mine.
  if (skill === 'mine' || (skill === 'dig' && a.x === undefined && (str(a.block) ?? str(a.item)))) {
    const block = str(a.block) ?? str(a.item);
    if (!block) return task;
    const ore = ORE.exec(block)?.[1];
    if (ore) return { skill: 'obtain', args: withQty(ORE_DROP[ore] ?? block) };
    if (block === 'stone' || block === 'cobblestone') return { skill: 'obtain', args: withQty('cobblestone') };
    if (WOOD.test(block)) return { skill: 'obtain', args: withQty(anyWood(block)) };
    return task;
  }
  if (skill === 'gather') {
    const item = str(a.item);
    if (!item) return task;
    if (MADE.test(item)) return { skill: 'obtain', args: withQty(anyWood(item)) };
    if (WOOD.test(item)) return { skill: 'gather', args: { ...a, item: anyWood(item) } };
    return task;
  }
  if (skill === 'obtain') {
    const item = str(a.item);
    return item && WOOD.test(item) ? { skill: 'obtain', args: { ...a, item: anyWood(item) } } : task;
  }
  if (skill === 'place') {
    const block = str(a.block);
    if (block && PUT_ANYWHERE.test(block) && (a.x !== undefined || a.y !== undefined || a.z !== undefined)) return { skill: 'place', args: { block } };
    return task;
  }
  return task;
}
