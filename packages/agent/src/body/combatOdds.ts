// Fight-or-flight arithmetic for the L0 reflex (§4.5, §21.3): a rough damage race, all code. Stats are vanilla
// Java values at normal difficulty, rounded; the reflex only needs to tell "one zombie" from "two zombies at once".

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

interface MobStats {
  hp: number;
  /** Damage per hit at normal difficulty. */
  dmg: number;
  /** Attacks per second when free to hit. */
  rate: number;
  /** Ranged attackers keep shooting while we close in; melee ones are mostly knocked back while we hit them. */
  ranged?: boolean;
  /**
   * Out from under our blows (an enderman teleports when hit, and comes back hitting): this share of our swings finds
   * nothing, and it isn't kept back by them. A stone-sword agent swung once in 23 s at one and died.
   */
  elusive?: number;
}

const MOBS: Readonly<Record<string, MobStats>> = {
  zombie: { hp: 20, dmg: 3, rate: 1 },
  husk: { hp: 20, dmg: 3, rate: 1 },
  drowned: { hp: 20, dmg: 3, rate: 1 },
  zombie_villager: { hp: 20, dmg: 3, rate: 1 },
  skeleton: { hp: 20, dmg: 3, rate: 0.4, ranged: true },
  stray: { hp: 20, dmg: 3, rate: 0.4, ranged: true },
  bogged: { hp: 16, dmg: 3, rate: 0.3, ranged: true },
  spider: { hp: 16, dmg: 2, rate: 1 },
  cave_spider: { hp: 12, dmg: 3, rate: 1 },
  slime: { hp: 16, dmg: 4, rate: 1 },
  magma_cube: { hp: 16, dmg: 6, rate: 1 },
  enderman: { hp: 40, dmg: 7, rate: 1, elusive: 0.6 },
  witch: { hp: 26, dmg: 6, rate: 0.3, ranged: true },
  pillager: { hp: 24, dmg: 4, rate: 0.4, ranged: true },
  vindicator: { hp: 24, dmg: 13, rate: 1 },
  evoker: { hp: 24, dmg: 6, rate: 0.3, ranged: true },
  vex: { hp: 14, dmg: 9, rate: 1 },
  ravager: { hp: 100, dmg: 12, rate: 0.5 },
  piglin: { hp: 16, dmg: 5, rate: 1 },
  piglin_brute: { hp: 50, dmg: 13, rate: 1 },
  zombified_piglin: { hp: 20, dmg: 8, rate: 1 },
  hoglin: { hp: 40, dmg: 6, rate: 1 },
  zoglin: { hp: 40, dmg: 6, rate: 1 },
  blaze: { hp: 20, dmg: 5, rate: 0.3, ranged: true },
  ghast: { hp: 10, dmg: 6, rate: 0.3, ranged: true },
  wither_skeleton: { hp: 20, dmg: 8, rate: 1 },
  phantom: { hp: 20, dmg: 2, rate: 0.4 },
  silverfish: { hp: 8, dmg: 1, rate: 1 },
  endermite: { hp: 8, dmg: 2, rate: 1 },
  guardian: { hp: 30, dmg: 6, rate: 0.3, ranged: true },
  breeze: { hp: 30, dmg: 1, rate: 0.5, ranged: true },
  creeper: { hp: 20, dmg: 30, rate: 0.3 },
  warden: { hp: 500, dmg: 30, rate: 0.5 },
  player: { hp: 20, dmg: 1, rate: 1.6 },
};

const DEFAULT_MOB: MobStats = { hp: 20, dmg: 4, rate: 1 };

/** Melee damage and swings per second for a held item (bare hand when unknown). */
export function weaponStats(item: string | null | undefined): { dmg: number; speed: number } {
  if (!item) return { dmg: 1, speed: 4 };
  const mat = item.split('_')[0] ?? '';
  if (item.endsWith('_sword')) {
    const dmg = { wooden: 4, golden: 4, stone: 5, copper: 5, iron: 6, diamond: 7, netherite: 8 }[mat] ?? 4;
    return { dmg, speed: 1.6 };
  }
  if (item.endsWith('_axe')) {
    const dmg = { wooden: 7, golden: 7, stone: 9, copper: 9, iron: 9, diamond: 9, netherite: 10 }[mat] ?? 7;
    const speed = { wooden: 0.8, golden: 1, stone: 0.8, copper: 0.8, iron: 0.9, diamond: 1, netherite: 1 }[mat] ?? 0.8;
    return { dmg, speed };
  }
  if (item === 'trident') return { dmg: 9, speed: 1.1 };
  if (item === 'mace') return { dmg: 6, speed: 0.6 };
  if (/_(pickaxe|shovel|hoe)$/.test(item)) return { dmg: 3, speed: 1.2 };
  return { dmg: 1, speed: 4 };
}

const ARMOR_POINTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  // helmet, chestplate, leggings, boots
  leather: [1, 3, 2, 1],
  golden: [2, 5, 3, 1],
  copper: [2, 4, 3, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
};

export function armorPoints(worn: readonly string[]): number {
  let total = 0;
  for (const name of worn) {
    if (name === 'turtle_helmet') {
      total += 2;
      continue;
    }
    const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name);
    const row = m?.[1] ? ARMOR_POINTS[m[1]] : undefined;
    if (!row || !m?.[2]) continue;
    total += row[['helmet', 'chestplate', 'leggings', 'boots'].indexOf(m[2])] ?? 0;
  }
  return Math.min(20, total);
}

function mobDamage(base: number, difficulty: Difficulty): number {
  switch (difficulty) {
    case 'peaceful':
      return 0;
    case 'easy':
      return Math.min(base / 2 + 1, base);
    case 'normal':
      return base;
    case 'hard':
      return base * 1.5;
  }
}

/** One blow from a mob of this kind, at this difficulty, through this much armor (a creeper's blast up close). */
export function mobBlow(name: string, difficulty: Difficulty, armor = 0): number {
  if (name === 'creeper') return mobDamage(CREEPER_BLAST, difficulty) * (1 - Math.min(20, armor) * 0.04);
  return mobDamage((MOBS[name] ?? DEFAULT_MOB).dmg, difficulty) * (1 - Math.min(20, armor) * 0.04);
}
/** A creeper going off beside one (normal difficulty): most of a full health bar. */
const CREEPER_BLAST = 22;

export interface FightInput {
  /** hp: what is left of the threat's health, when known. */
  threats: readonly { name: string; heldItem?: string | null; hp?: number }[];
  weapon: string | null;
  armor: number;
  combat: number;
  difficulty: Difficulty;
}

/** The server's difficulty as mineflayer reports it; anything unexpected reads as normal. */
export function asDifficulty(raw: unknown): Difficulty {
  return raw === 'peaceful' || raw === 'easy' || raw === 'normal' || raw === 'hard' ? raw : 'normal';
}

/**
 * Expected damage taken while killing the threats one after another. Calibrated on Paper 26.1 fights (M1): our
 * hits knock the current target back, so it lands few blows; the others queue up and hit at about a third of their
 * rate. Accuracy, swing timing and knockback control grow with combat ability (§21.3).
 */
export function expectedFightDamage(input: FightInput): number {
  const w = weaponStats(input.weapon);
  const ourDps = w.dmg * Math.min(w.speed, 1.6) * 0.6 * (0.55 + 0.45 * input.combat);
  const engaged = 0.05 + 0.2 * (1 - input.combat);
  const waiting = 0.3;
  const keep = 1 - Math.min(20, input.armor) * 0.04;
  let elapsed = 0;
  let taken = 0;
  for (const t of input.threats) {
    const s = MOBS[t.name] ?? DEFAULT_MOB;
    const dmg = t.name === 'player' ? weaponStats(t.heldItem).dmg : mobDamage(s.dmg, input.difficulty);
    const own = Math.max(0, t.hp ?? s.hp) / (ourDps * (1 - (s.elusive ?? 0)));
    const pressed = s.elusive ? Math.max(engaged, s.elusive) : engaged;
    const hits = s.ranged ? s.rate * (elapsed + own) : s.rate * (waiting * elapsed + pressed * own);
    taken += dmg * keep * hits;
    elapsed += own;
  }
  return taken;
}
