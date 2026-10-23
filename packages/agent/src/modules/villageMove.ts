// The code default's moves for village work (§6.8): what an agent does when its current goal is its part in the
// village (doneWhen villageWork:<kind>). Each kind of work ends in a finishing act that `villageWork` checks:
// goods handed in at the village chest, a hut built, a patrol round, a notice posted. Only what the agent itself
// has seen is used (§13 rule 4): its home, the chest it saw, the mobs and animals in sight, the ore it found.

import type { AgentState, DecisionOutput, Vec3 } from '@agora/shared';
import { HUT_BLOCKS, HUT_MATERIALS } from '../body/skills/village';
import { FOOD_ITEM, type VillageKind } from '../social/village';

export interface VillageMoveCtx {
  isStuck: (skill: string, args: Record<string, unknown>) => boolean;
  /** Digging in to hide may be chosen (the code-only brain, badly scared, alone and far from anyone: hiding.ts). */
  mayHide?: boolean;
}

const held = (s: AgentState, re: RegExp) => s.self.inventory.filter((i) => re.test(i.item)).reduce((a, i) => a + i.qty, 0);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const ANIMAL = /^(cow|pig|sheep|chicken)$/;
const RAW_MEAT = /^(beef|porkchop|mutton|chicken)$/;
const COOKED: Readonly<Record<string, string>> = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken' };
const BUILDING = new RegExp(`^(${HUT_MATERIALS.join('|')})$`);

const work = (skill: string, args: Record<string, unknown>, maxSeconds: number, rationale: string): DecisionOutput => ({
  option: 'work',
  task: { skill, args },
  terminate: { maxSeconds },
  rationale: `code default: ${rationale}`,
});

/** An ore this agent found away from home that no sign it has read mentions yet (newest first). */
export function unpostedFind(s: AgentState): { what: string; pos: Vec3 } | null {
  const posted = s.village.signs.map((x) => x.text.toLowerCase());
  return [...s.village.finds].reverse().find((f) => !posted.some((t) => t.includes(f.what))) ?? null;
}

export function villageMove(s: AgentState, kind: VillageKind, v: VillageMoveCtx): DecisionOutput | null {
  const home = s.village.home;
  const chest = s.village.chest?.pos ?? null;
  const me = s.self.pos;
  const obtain = (item: string, qty: number, why: string, secs = 600) => (v.isStuck('obtain', { item, qty }) ? null : work('obtain', { item, qty }, secs, why));
  /** Goods into the village chest; with no chest there yet, make one and set it down by home first. */
  const handIn = (item: string, qty: number, label: string): DecisionOutput | null => {
    if (chest) return work('deposit', { item, qty, x: chest.x, y: chest.y, z: chest.z }, 120, `${label} into the village chest`);
    if (held(s, /^chest$/) === 0) return obtain('chest', 1, 'the village needs a chest', 300);
    if (home && dist(me, home) > 4) return work('goTo', { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z), range: 2 }, 90, 'back to the village to set a chest down');
    return work('place', { block: 'chest' }, 60, 'a chest for the village');
  };
  switch (kind) {
    case 'wood': {
      if (held(s, /_(log|stem)$/) >= 16) return handIn('log', 16, 'logs');
      // The trees near the village are gone: look for more farther out.
      const logs = obtain('log', 16, 'logs for the village');
      return logs ?? (v.isStuck('explore', { distance: 32 }) ? null : { option: 'explore', terminate: { maxSeconds: 90 }, rationale: 'code default: looking for trees' });
    }
    case 'stone':
      return held(s, /^cobblestone$/) >= 16 ? handIn('cobblestone', 16, 'stone') : obtain('cobblestone', 16, 'stone for the village');
    case 'food': {
      const cooked = s.self.inventory.filter((i) => FOOD_ITEM.test(i.item) && i.item.startsWith('cooked_')).sort((a, b) => b.qty - a.qty)[0];
      if (cooked && cooked.qty >= 3) return handIn(cooked.item, cooked.qty, 'cooked food');
      const raw = s.self.inventory.filter((i) => RAW_MEAT.test(i.item)).sort((a, b) => b.qty - a.qty)[0];
      if (raw && raw.qty >= 3) return obtain(COOKED[raw.item] ?? 'cooked_beef', raw.qty, `cooking ${raw.item}`, 300);
      const prey = s.perception.nearbyEntities.find((e) => e.kind === 'passive' && ANIMAL.test(e.name) && e.visible && e.distance <= 24);
      if (prey && !v.isStuck('hunt', { qty: 3 })) return work('hunt', { qty: 3 }, 150, `hunting ${prey.name} for the village`);
      return v.isStuck('explore', { distance: 32 }) ? null : { option: 'explore', terminate: { maxSeconds: 90 }, rationale: 'code default: looking for animals to hunt' };
    }
    case 'build': {
      const blocks = held(s, BUILDING);
      if (blocks >= HUT_BLOCKS) {
        if (held(s, /_door$/) === 0 && held(s, /_planks$/) + 4 * held(s, /_(log|stem)$/) >= 6 && !v.isStuck('obtain', { item: 'oak_door', qty: 1 })) return obtain('oak_door', 1, 'a door for the hut', 240);
        return v.isStuck('build', { structure: 'hut' }) ? null : work('build', { structure: 'hut' }, 900, 'building a hut for the village');
      }
      // Obtain counts what is held: the dirt we have plus what's still missing.
      return obtain('dirt', held(s, /^dirt$/) + HUT_BLOCKS - blocks, 'blocks for a hut');
    }
    case 'guard': {
      // A guard who can't take a hit stays off duty until healed.
      if (s.self.health < 10) return null;
      const mob = s.perception.nearbyEntities.find((e) => e.kind === 'hostile' && e.visible && e.distance <= 16 && (!home || dist(e.pos, home) <= 40));
      if (mob && !v.isStuck('attack', { target: mob.name })) return work('attack', { target: mob.name, seconds: 30 }, 45, `a ${mob.name} near the village`);
      return v.isStuck('patrol', { radius: 10 }) ? null : work('patrol', { radius: 10 }, 180, 'walking the edge of the village');
    }
    case 'tools': {
      const picks = held(s, /^stone_pickaxe$/);
      if (picks >= 2) return handIn('stone_pickaxe', picks - 1, 'a spare pickaxe');
      return obtain('stone_pickaxe', picks + 1, 'a pickaxe to spare for the village', 300);
    }
    case 'scout': {
      const find = unpostedFind(s);
      if (find) {
        if (held(s, /_sign$/) === 0) return obtain('oak_sign', 1, 'a sign to post what I found', 240);
        if (home && dist(me, home) > 8) return work('goTo', { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z), range: 3 }, 120, `back to the board with news of ${find.what}`);
        return work('sign', { text: `${find.what} at ${Math.round(find.pos.x)}, ${Math.round(find.pos.z)}` }, 60, `posting where the ${find.what} is`);
      }
      return v.isStuck('explore', { distance: 32 }) ? null : { option: 'explore', terminate: { maxSeconds: 120 }, rationale: 'code default: scouting the land' };
    }
  }
}

/** At or below this health an agent is badly hurt: food and safety before any work. */
export const HURT = 8;

/**
 * Badly hurt (§16.3: death is permanent): food first, since no health comes back below 18 food; then lie low until
 * healed: back home if it is far, else resting where we are, with an eye out. In a sealed hole only when hiding is
 * allowed (alone, badly scared and far from anyone, hiding.ts) and a hostile mob is about. The eat reflex eats.
 */
export function hurtMove(s: AgentState, v: VillageMoveCtx): DecisionOutput | null {
  if (s.self.health > HURT) return null;
  const food = hungerMove(s, v);
  if (food) return food;
  const mob = s.perception.nearbyEntities.some((e) => e.kind === 'hostile' && e.distance <= 24);
  const hide = { untilMorning: false, untilHealed: true };
  if (v.mayHide && mob && s.self.food >= 18 && !v.isStuck('shelter', hide)) return work('shelter', hide, 200, 'badly hurt and alone, lying low until I heal');
  const home = s.village.home;
  if (home && dist(s.self.pos, home) > 24) {
    const args = { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z), range: 3 };
    if (!v.isStuck('goTo', args)) return work('goTo', args, 120, 'badly hurt, going home to recover');
  }
  return { option: 'rest', terminate: { maxSeconds: 30 }, rationale: 'code default: badly hurt, resting until I heal' };
}

/** What can be eaten, raw or cooked. */
export const EDIBLE = /^(bread|apple|golden_apple|cooked_\w+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|carrot|golden_carrot|baked_potato|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|mushroom_stew|rabbit_stew|beetroot_soup|dried_kelp)$/;

/**
 * Hungry (food ≤ 12; badly hurt, below 18, since no health comes back under that) with nothing to eat (§16.3: always
 * carry food): food from the village chest if it had some when we last looked, else an animal in sight, else a look
 * around for one.
 */
export function hungerMove(s: AgentState, v: VillageMoveCtx): DecisionOutput | null {
  const hungry = s.self.health <= HURT ? 17 : 12;
  if (s.self.food > hungry || s.self.inventory.some((i) => EDIBLE.test(i.item))) return null;
  return foodMove(s, v, 'hungry');
}

/** Getting food (a plan's step, or hunger): from the village chest if it had some, else an animal in sight, else a look around. */
export function foodMove(s: AgentState, v: VillageMoveCtx, why = 'getting food'): DecisionOutput | null {
  const chest = s.village.chest;
  const stocked = chest?.contents ? Object.entries(chest.contents).filter(([k, n]) => EDIBLE.test(k) && n > 0).sort((a, b) => b[1] - a[1])[0] : undefined;
  if (chest && stocked) {
    const args = { item: stocked[0], qty: Math.min(4, stocked[1]), x: chest.pos.x, y: chest.pos.y, z: chest.pos.z };
    if (!v.isStuck('withdraw', args)) return work('withdraw', args, 120, `${why}: ${stocked[0]} from the village chest`);
  }
  const prey = s.perception.nearbyEntities.find((e) => e.kind === 'passive' && ANIMAL.test(e.name) && e.visible && e.distance <= 24);
  if (prey && !v.isStuck('hunt', { qty: 2 })) return work('hunt', { qty: 2 }, 120, `${why}: hunting a ${prey.name}`);
  return v.isStuck('explore', { distance: 32 }) ? null : { option: 'explore', terminate: { maxSeconds: 90 }, rationale: `code default: ${why}, looking for food` };
}

/**
 * A death this agent knows of that no sign it has read mentions yet (§16.3: newcomers learn history from signs):
 * the death message, and where if it saw the body fall.
 */
export function unpostedDeath(s: AgentState): { name: string; text: string } | null {
  if (!s.village.home) return null;
  const posted = s.village.signs.map((x) => x.text.toLowerCase());
  for (const d of [...s.perception.systemEvents].reverse()) {
    const name = d.subject;
    if (d.kind !== 'death' || !name || name === s.self.username || posted.some((t) => t.includes(name.toLowerCase()))) continue;
    const seen = s.perception.observedActions.find((a) => a.kind === 'death' && a.actor === name && a.pos);
    const where = seen?.pos ? ` near ${Math.round(seen.pos.x)}, ${Math.round(seen.pos.z)}` : '';
    return { name, text: `${d.text}${where}`.slice(0, 60) };
  }
  return null;
}

/** Posting a death at the board: with a sign in hand (or the planks for one), near home. */
export function deathNoticeMove(s: AgentState, v: VillageMoveCtx): DecisionOutput | null {
  const home = s.village.home;
  const news = unpostedDeath(s);
  if (!news || !home || dist(s.self.pos, home) > 24) return null;
  if (held(s, /_sign$/) === 0) {
    const canMake = held(s, /_planks$/) + 4 * held(s, /_(log|stem)$/) >= 7;
    return canMake && !v.isStuck('obtain', { item: 'oak_sign', qty: 1 }) ? work('obtain', { item: 'oak_sign', qty: 1 }, 240, `a sign to tell the village about ${news.name}`) : null;
  }
  return v.isStuck('sign', { text: news.text }) ? null : work('sign', { text: news.text }, 60, `telling the village that ${news.name} died`);
}
