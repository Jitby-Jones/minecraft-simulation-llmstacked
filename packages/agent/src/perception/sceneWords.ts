// The scene in words, for the mind's packet (owner request, 2026-10-24): where the agent is, what it can see, what
// moves around it and how, and what stood out. Pure, so the packet stays a function of the state.

import type { Scene, SceneCreature } from '@agora/shared';
import { NOTICE_MS } from '../mind/expectations';

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'] as const;

/** Which way `to` lies from `from`, as a compass point (+x east, +z south); "here" within a block. */
export function bearingOf(from: { x: number; z: number }, to: { x: number; z: number }): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1) return 'here';
  return COMPASS[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8] ?? 'east';
}

function nice(name: string): string {
  return name.replace(/^minecraft:/, '').replace(/_/g, ' ');
}

const SAME_PLURAL = /^(sheep|cod|salmon|tropical_fish|pufferfish|fish|squid|glow_squid|axolotl_|deer|moose)$/;

/** "a sheep", "3 sheep", "2 wolves", "4 cows". */
export function countOf(n: number, name: string): string {
  const one = nice(name);
  if (n === 1) return `${/^[aeiou]/.test(one) ? 'an' : 'a'} ${one}`;
  const many = SAME_PLURAL.test(name) || /s$/.test(name) ? one : /wolf$/.test(name) ? one.replace(/wolf$/, 'wolves') : /(ch|sh|x)$/.test(name) ? `${one}es` : `${one}s`;
  return `${n} ${many}`;
}

function updown(dy: number): string {
  return dy >= 2 ? `, ${dy} m up` : dy <= -2 ? `, ${-dy} m down` : '';
}

function motionWords(c: SceneCreature): string {
  if (c.motion === 'still') return 'standing still';
  if (c.motion === 'flying') return c.aboveGround !== undefined ? `in the air ${c.aboveGround} m above the ground` : 'in the air';
  if (c.motion === 'running' || c.motion === 'walking') return `${c.motion} (${c.speed} m/s)`;
  return c.motion;
}

/** Creatures of one kind doing the same, side by side, read as one line ("3 sheep, 10-16 m north: ..."). */
function grouped(cs: readonly SceneCreature[]): SceneCreature[][] {
  const out: SceneCreature[][] = [];
  const by = new Map<string, SceneCreature[]>();
  for (const c of cs) {
    if (c.kind === 'player') {
      out.push([c]);
      continue;
    }
    const k = `${c.kind}|${c.name}|${c.kind === 'item' ? '' : `${c.motion === 'walking' || c.motion === 'still' ? 'about' : c.motion}|${c.details.join(',')}|${c.relations.filter((r) => !r.startsWith('next to')).join(',')}`}`;
    const g = by.get(k);
    if (g) g.push(c);
    else {
      const fresh = [c];
      by.set(k, fresh);
      out.push(fresh);
    }
  }
  return out;
}

/** How the scene reads to the mind, as lines for its packet. */
export function describeScene(s: Scene, now: number, o: { people?: (name: string) => string; maxFeatures?: number; maxCreatures?: number } = {}): string[] {
  const out: string[] = [];
  if (s.where) out.push(`Where you are: ${s.where}.`);
  if (s.ways) out.push(`Ways from here on foot: ${s.ways}.`);
  const feats = s.features.slice(0, o.maxFeatures ?? 10);
  if (feats.length > 0) {
    out.push(
      `What you can see:\n${feats
        .map((f) => `  ${f.what}${f.first ? ' (the first you have ever seen)' : ''}: ${f.distance <= 1 ? 'right here' : `${f.distance} m ${f.bearing}`}${updown(f.dy)} (${f.nearest.x},${f.nearest.y},${f.nearest.z})`)
        .join('\n')}`,
    );
  }
  const cs = s.creatures.slice(0, o.maxCreatures ?? 20);
  if (cs.length > 0) {
    const lines: string[] = [];
    for (const g of grouped(cs)) {
      const c = g[0] as SceneCreature;
      const near = Math.round(Math.min(...g.map((x) => x.distance)));
      const far = Math.round(Math.max(...g.map((x) => x.distance)));
      const ways = [...new Set(g.map((x) => x.bearing))].slice(0, 2).join('/');
      const where = `${near === far ? near : `${near}-${far}`} m ${ways}${updown(c.dy)}`;
      if (c.kind === 'item') {
        const n = g.reduce((a, x) => a + (x.count ?? 1), 0);
        lines.push(`  ${n} ${c.name} on the ground, ${where}`);
        continue;
      }
      const name = c.kind === 'player' ? `${c.name}${o.people ? ` (${o.people(c.name)})` : ''}` : countOf(g.length, c.name);
      const tag = c.kind === 'hostile' ? ' (hostile)' : c.kind === 'other' ? '' : '';
      const heading = g.length === 1 && c.heading && c.heading !== 'across' ? [c.heading] : [];
      const relations = g.length === 1 ? c.relations : c.relations.filter((r) => !r.startsWith('next to'));
      const bits = [motionWords(c), ...heading, ...relations, ...c.details];
      lines.push(`  ${name}${tag}, ${where}: ${bits.join(', ')}${c.visible ? '' : ' (heard, not seen)'}`);
    }
    out.push(`Creatures and things around you:\n${lines.join('\n')}`);
  } else out.push('Nothing moving around you.');
  const ns = s.notices.filter((n) => now - n.ts < NOTICE_MS);
  if (ns.length > 0) out.push(`What stood out:\n${ns.map((n) => `  ${n.text} (${Math.max(0, Math.round((now - n.ts) / 1000))}s ago)`).join('\n')}`);
  return out;
}
