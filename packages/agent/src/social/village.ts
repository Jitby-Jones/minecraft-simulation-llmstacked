// The village as this agent sees it (§6.8): what it needs, what this persona likes doing, and who is already seen
// doing what. Division of labor comes from perception alone (§13 rule 4): need × liking ÷ (1 + others on it), the
// code default of Social Goal Gen, which is how roles diverge (Sid's emergent roles) without a model.

import { type AgentName, type AgentState, type Persona, shannonEntropy } from '@agora/shared';

export const VILLAGE_KINDS = ['wood', 'stone', 'food', 'build', 'guard', 'tools', 'scout'] as const;
export type VillageKind = (typeof VILLAGE_KINDS)[number];

export const isVillageKind = (k: unknown): k is VillageKind => typeof k === 'string' && (VILLAGE_KINDS as readonly string[]).includes(k);

export const ROLE_OF: Readonly<Record<VillageKind, string>> = {
  wood: 'woodcutter',
  stone: 'miner',
  food: 'hunter',
  build: 'builder',
  guard: 'guard',
  tools: 'toolmaker',
  scout: 'scout',
};

export const KIND_OF_ROLE: Readonly<Record<string, VillageKind>> = Object.fromEntries(Object.entries(ROLE_OF).map(([k, r]) => [r, k as VillageKind]));

/** Words in life goals, values and traits that point at a kind of work. */
const LEANINGS: readonly [RegExp, VillageKind][] = [
  [/\b(wood|tree|lumber|forest|log)/i, 'wood'],
  [/\b(min(e|er|ing)|stone|ore|iron|diamond|dig|cave)/i, 'stone'],
  [/\b(food|cook|farm|hunt|feed|bread|meat)/i, 'food'],
  [/\b(build|house|home|architect|craft(y|sman)?)/i, 'build'],
  [/\b(protect|guard|brave|fight|warrior|safe)/i, 'guard'],
  [/\b(tool|smith|invent|tinker)/i, 'tools'],
  [/\b(explor|map|wander|curious|adventur|travel)/i, 'scout'],
];

/** 0..1: how much this persona likes each kind of work. */
export function preferences(p: Persona): Record<VillageKind, number> {
  const b = p.big5;
  const t = p.temperament;
  const a = p.abilities;
  const caution = p.drives.caution;
  const pref: Record<VillageKind, number> = {
    wood: 0.25 + 0.4 * b.conscientiousness + 0.15 * (1 - b.openness),
    stone: 0.15 + 0.35 * b.conscientiousness + 0.3 * (1 - caution),
    food: 0.15 + 0.35 * b.agreeableness + 0.3 * a.combat,
    build: 0.1 + 0.35 * b.openness + 0.3 * b.conscientiousness,
    guard: 0.05 + 0.45 * a.combat + 0.25 * t.aggression + 0.2 * (1 - caution) + 0.15 * t.loyalty,
    tools: 0.1 + 0.5 * a.intelligence + 0.2 * b.conscientiousness,
    scout: 0.05 + 0.45 * b.openness + 0.3 * (1 - caution),
  };
  const words = [...p.lifeGoals, ...p.values, ...p.traits].join(' ');
  for (const [re, kind] of LEANINGS) if (re.test(words)) pref[kind] += 0.3;
  for (const k of VILLAGE_KINDS) pref[k] = Math.min(1, pref[k]);
  return pref;
}

export interface VillageView {
  /** What the village chest held when this agent last looked (item → count); null: it hasn't looked in one. */
  chest: Readonly<Record<string, number>> | null;
  /** A village chest is known to stand (seen, by home). */
  chestKnown?: boolean;
  /** Hostile mobs seen near home in the last 10 minutes, plus deaths to mobs heard of lately. */
  threats: number;
  /** Huts seen near home. */
  huts: number;
  /** Dusk or night. */
  night: boolean;
  /** Ore seen, or read about on a sign. */
  oreKnown: boolean;
  /** People who asked for food lately. */
  hungry: number;
  /** Others' work, from what they were seen doing (kind → people). */
  others: Readonly<Partial<Record<VillageKind, number>>>;
}

const count = (c: Readonly<Record<string, number>> | null, re: RegExp) => (c ? Object.entries(c).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0) : 0);

export const FOOD_ITEM = /^(bread|cooked_\w+|baked_potato|apple|carrot|golden_carrot|pumpkin_pie|mushroom_stew|beetroot_soup)$/;
export const TOOL_ITEM = /_(pickaxe|axe|sword|shovel|hoe)$/;
const FOOD_ASK = /\b(hungry|starving|food|bread|meat|eat)\b/i;
const MOB_CAUSE = /zombie|skeleton|spider|creeper|witch|husk|drowned|stray|phantom|slime|enderman|pillager|mob/i;

/** 0..1: how badly the village needs each kind of work, as this agent sees it. */
export function needs(v: VillageView): Record<VillageKind, number> {
  const logs = count(v.chest, /_(log|planks)$/);
  const stone = count(v.chest, /^(cobblestone|cobbled_deepslate|stone)$/);
  const food = count(v.chest, FOOD_ITEM);
  const tools = count(v.chest, TOOL_ITEM);
  return {
    wood: Math.max(0.2, 1 - logs / 64),
    stone: Math.max(0.15, 1 - stone / 128),
    food: Math.max(0.15, Math.min(1, 1 - food / 24 + 0.2 * v.hungry)),
    build: v.huts === 0 ? 0.8 : Math.max(0.2, 0.6 - 0.15 * v.huts),
    guard: Math.min(1, 0.15 + 0.15 * v.threats + (v.night ? 0.35 : 0)),
    tools: Math.max(0.1, 0.5 - tools / 8),
    scout: v.oreKnown ? 0.15 : 0.45,
  };
}

export interface Choice {
  kind: VillageKind;
  score: number;
}

/**
 * The work this agent takes up: need × liking ÷ (1 + others already on it), plus a little noise. The current choice
 * gets `stickiness` on top, so roles last (Sid saw them hold) unless the village's needs change.
 */
export function chooseWork(p: Persona, v: VillageView, current: VillageKind | null, noise: () => number, stickiness = 0.15): Choice[] {
  const pref = preferences(p);
  const need = needs(v);
  return VILLAGE_KINDS.map((kind) => ({
    kind,
    score: (need[kind] * (0.4 + pref[kind])) / (1 + (v.others[kind] ?? 0)) + 0.08 * noise() + (kind === current ? stickiness : 0),
  })).sort((a, b) => b.score - a.score);
}

/** The role shown on the dashboard: the kind of most of the last five social goals, ties to the latest. */
export function roleFrom(kinds: readonly VillageKind[]): string | null {
  const last = kinds.slice(-5);
  if (last.length === 0) return null;
  const tally = new Map<VillageKind, number>();
  for (const k of last) tally.set(k, (tally.get(k) ?? 0) + 1);
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1] || last.lastIndexOf(b[0]) - last.lastIndexOf(a[0]));
  return best ? ROLE_OF[best[0]] : null;
}

/** Shannon entropy (bits) of the roles across agents (§11 F): 0 when everyone does the same thing. */
export function roleEntropy(roles: readonly (string | null | undefined)[]): number {
  return shannonEntropy(roles.filter((r): r is string => Boolean(r)));
}

/** The village as the agent's own state has it (§13 rule 4: nothing it didn't perceive). */
export function villageView(s: AgentState, others: Partial<Record<VillageKind, number>>, now: number): VillageView {
  const v = s.village;
  const mobDeaths = s.perception.systemEvents.filter((e) => e.kind === 'death' && now - e.ts < 30 * 60_000 && MOB_CAUSE.test(e.cause ?? '')).length;
  const askers = new Set(s.perception.heardSpeech.filter((u) => now - u.ts < 10 * 60_000 && FOOD_ASK.test(u.text) && /\?|need|hungry|starving/i.test(u.text)).map((u) => u.from));
  const t = s.self.time;
  return {
    chest: v.chest?.contents ?? null,
    chestKnown: Boolean(v.chest),
    threats: v.threats.filter((x) => now - x < 10 * 60_000).length + mobDeaths,
    huts: v.huts.length,
    night: !s.self.isDay || (t >= 11_500 && t < 13_000),
    oreKnown: s.perception.nearbyBlocksOfInterest.some((b) => /_ore$/.test(b.name)) || v.signs.some((x) => /\b(ore|iron|coal|diamond|gold)\b/i.test(x.text)),
    hungry: askers.size,
    others,
  };
}

/** The village in a sentence for a prompt. */
export function describeVillage(v: VillageView): string {
  const parts: string[] = [];
  if (!v.chestKnown) parts.push('no village chest yet');
  else if (!v.chest) parts.push("you haven't looked inside the village chest");
  else {
    const top = Object.entries(v.chest)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([item, n]) => `${n} ${item}`);
    parts.push(top.length > 0 ? `the village chest holds ${top.join(', ')}` : 'the village chest is empty');
  }
  parts.push(v.huts === 0 ? 'no huts yet' : `${v.huts} hut${v.huts === 1 ? '' : 's'}`);
  if (v.threats > 0) parts.push(`hostile mobs came near ${v.threats} time${v.threats === 1 ? '' : 's'} lately`);
  if (v.night) parts.push('night is coming');
  if (v.hungry > 0) parts.push(`${v.hungry} ${v.hungry === 1 ? 'person has' : 'people have'} asked for food`);
  parts.push(v.oreKnown ? 'ore has been found' : 'no ore found yet');
  const busy = Object.entries(v.others).filter(([, n]) => (n ?? 0) > 0);
  if (busy.length > 0) parts.push(`others are already at ${busy.map(([k, n]) => `${k} (${n})`).join(', ')}`);
  return parts.join('; ');
}

/** The items each kind of work delivers (to the village chest, or to someone). */
const WORK_ITEMS: Partial<Readonly<Record<VillageKind, RegExp>>> = {
  wood: /^(log|logs|planks|\w+_(log|wood|stem|planks))$/,
  stone: /^(cobblestone|stone|cobbled_deepslate)$/,
  food: /^(food|meat|bread|cooked_\w+|baked_potato|apple|carrot|golden_carrot|pumpkin_pie)$/,
  tools: /_(pickaxe|axe|sword|shovel|hoe)$/,
};
const HOSTILE_MOB = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|spider|cave_spider|creeper|witch|enderman|slime|phantom|pillager|vindicator)$/;

/**
 * `villageWork:<kind>` (goal doneWhen): the work's finishing act happened since `since` — goods handed in or over,
 * a hut built, a patrol round walked (or a hostile mob killed), a notice posted (or three trips out).
 */
export function villageWorkDone(s: AgentState, kind: VillageKind, since: number): boolean {
  const after = s.actionLog.filter((a) => a.ts >= since && a.ok);
  const items = WORK_ITEMS[kind];
  if (items) return after.some((a) => (a.skill === 'deposit' || a.skill === 'give') && typeof a.args.item === 'string' && items.test(a.args.item.replace(/^minecraft:/, '')));
  if (kind === 'build') return after.some((a) => a.skill === 'build');
  if (kind === 'guard') return after.some((a) => a.skill === 'patrol' || (a.skill === 'attack' && typeof a.args.target === 'string' && HOSTILE_MOB.test(a.args.target)));
  return after.some((a) => a.skill === 'sign') || after.filter((a) => a.skill === 'explore').length >= 3;
}

/** The kind of village work a goal's doneWhen is about, if it is one. */
export function villageWorkOf(doneWhen: string | undefined): VillageKind | null {
  const k = doneWhen ? /^villageWork:([a-z]+)$/.exec(doneWhen.trim())?.[1] : undefined;
  return isVillageKind(k) ? k : null;
}

/** A builder seen this lately (and not seen to die) is about to make a chest. */
const BUILDER_SEEN_MS = 15 * 60_000;

/**
 * Who should make a chest when there is none (owner request, 2026-10-24): null when we should (we're the builder, or
 * nobody we've seen lately is), else the builder to ask.
 */
export function whoMakesChests(s: AgentState, now: number): AgentName | null {
  if (s.goals.role === 'builder') return null;
  const dead = new Set(s.perception.systemEvents.filter((e) => e.kind === 'death').map((e) => e.subject));
  const builder = Object.values(s.social)
    .filter((p) => p.perceivedRole === 'builder' && !dead.has(p.name) && now - p.lastSeen < BUILDER_SEEN_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)[0];
  return builder?.name ?? null;
}

/**
 * Null when a chest is known at `pos` (the village chest, or a chest seen there), else why not, said so the model can
 * act on it (owner request, 2026-10-24: agents put things in chests that weren't there). `seen`: what is at that spot
 * as far as we can tell now (null when it is out of sight).
 */
export function whyNoChest(s: AgentState, pos: { x: number; y: number; z: number }, seen: boolean | null): string | null {
  const v = s.village.chest?.pos;
  const at = (p: { x: number; y: number; z: number }) => Math.round(p.x) === Math.round(pos.x) && Math.round(p.y) === Math.round(pos.y) && Math.round(p.z) === Math.round(pos.z);
  if (seen === true || (seen === null && v && at(v))) return null;
  const where = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
  return v
    ? `there is no chest at ${where}; the village chest is at ${v.x},${v.y},${v.z}`
    : `there is no chest at ${where} that you know of, and no village chest yet: deposit with no position (one is made if none is about), or make one (obtain chest) and place it by home`;
}
