// Expectations (owner request, 2026-10-24: "a normal player would realize things like this, not from express direction
// but because it doesn't fit what was learned to be possible"). What the agent expects of how things move and behave is
// what a long-time player knows of the game (people walk, run and jump; they fall when nothing holds them up; nobody
// steps from one place to another in an instant; mobs come in the dark, never right beside you) widened by what it has
// seen itself. What falls outside that is a surprise: noticed, put into words without explaining it (making sense of it
// is the mind's), and the stronger the further outside. Seeing the same thing again surprises less each time, and after
// a few times it is known ("Kelby can fly"): a belief about that one, learned. No rule says what to do about any of it.

import type { AgentState, Belief, EntityKind, Envelope, Notice } from '@agora/shared';
import type { Motion } from '../perception/motion';

/** How a long-time player expects people and creatures to move, before seeing anything in this world. */
const PRIOR: Readonly<Record<string, Envelope>> = {
  // Sprinting is 5.6 m/s, a sprint-jump 7.1; a jump is 1.25 m high and off the ground about 0.6 s.
  player: { ground: 5.8, air: 7.6, hover: 0.9, height: 1.7, n: 0 },
  default: { ground: 6, air: 8, hover: 1, height: 1.7, n: 0 },
};
/** Creatures that fly, glide or float by nature: off the ground is where they are. */
const FLIERS = new Set(['bat', 'parrot', 'bee', 'phantom', 'ghast', 'happy_ghast', 'ghastling', 'blaze', 'allay', 'vex', 'ender_dragon', 'wither', 'breeze', 'shulker_bullet']);
/** They flap their way down slowly. */
const SLOW_FALLERS = new Set(['chicken']);
/** They climb walls. */
const CLIMBERS = new Set(['spider', 'cave_spider']);
/** They live in the water. */
const SWIMMERS = new Set(['cod', 'salmon', 'tropical_fish', 'pufferfish', 'squid', 'glow_squid', 'dolphin', 'axolotl', 'turtle', 'drowned', 'guardian', 'elder_guardian', 'tadpole', 'nautilus', 'zombie_nautilus']);
/** They blink from place to place by nature. */
const BLINKERS = new Set(['enderman', 'shulker', 'endermite']);
/** They jump high or far by nature. */
const JUMPERS = new Set(['slime', 'magma_cube', 'rabbit', 'horse', 'donkey', 'mule', 'camel', 'goat', 'frog', 'skeleton_horse', 'zombie_horse', 'llama', 'trader_llama', 'cat', 'ocelot', 'fox', 'wolf']);

/** Once seen this often, it is known: no longer a surprise, but a belief about that one. */
export const KNOWN_AFTER = 3;
/** One creature, one kind of surprise: put into words again at most this often while it goes on. */
const AGAIN_MS = 20_000;
/** How long a notice stays in the scene. */
export const NOTICE_MS = 3 * 60_000;
/** A surprise this strong stops what the agent is doing to think about it. */
export const URGENT_STRENGTH = 0.6;

/** What expectations judge of one creature at one moment. */
export interface Observed {
  id: number;
  /** Username or mob type. */
  name: string;
  kind: EntityKind;
  /** Mob type ("player" for people). */
  type: string;
  motion: Motion;
  distance: number;
  visible: boolean;
}

/** The beliefs learned from what kept surprising: what it says of the one it's about. */
const BELIEF: Readonly<Record<string, string>> = {
  hover: 'can stay up in the air without falling',
  rise: 'can rise straight up into the air',
  speed: 'can move far faster than anyone can run',
  blink: 'can get from one place to another in an instant',
  inside: 'can be inside solid blocks',
  appear: 'can turn up out of nowhere',
  vanish: 'can vanish into thin air',
};

const ONE_DP = (x: number) => Math.round(x * 10) / 10;

function them(kind: EntityKind): string {
  return kind === 'player' ? 'them' : 'it';
}

function label(o: { name: string; kind: EntityKind }): string {
  return o.kind === 'player' ? o.name : `a ${o.name.replace(/_/g, ' ')}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** How many times this agent saw the same before, said plainly. */
export function seenBeforeWords(seenBefore: number, kind: EntityKind): string {
  if (seenBefore === 0) return kind === 'player' ? "You've never seen anyone do that." : "You've never seen one do that.";
  if (seenBefore === 1) return 'You saw this once before.';
  return `You've seen this ${seenBefore} times now.`;
}

let seq = 0;

export class Expectations {
  /** creature id + key → when it was last put into words. */
  private readonly said = new Map<string, number>();

  constructor(
    private readonly o: {
      state: () => AgentState;
      /** Saves what was learned (knowledge.surprised, beliefs, envelopes). */
      learn: (f: (k: AgentState['knowledge']) => AgentState['knowledge']) => void;
      now: () => number;
    },
  ) {}

  /** What this agent now expects of a kind of creature: what it knew of the game, widened by what it has seen. */
  envelope(type: string): Envelope {
    const prior = PRIOR[type] ?? PRIOR.default;
    const seen = this.o.state().knowledge.envelopes?.[type];
    if (!seen || !prior) return prior ?? { ground: 6, air: 8, hover: 1, height: 1.7, n: 0 };
    return { ground: Math.max(prior.ground, seen.ground), air: Math.max(prior.air, seen.air), hover: Math.max(prior.hover, seen.hover), height: Math.max(prior.height, seen.height), n: seen.n };
  }

  /** Beliefs about someone or some kind of thing ("Kelby": "can fly"). */
  beliefsAbout(about: string): Belief[] {
    return (this.o.state().knowledge.beliefs ?? []).filter((b) => b.about === about);
  }

  /** Judges how one creature moves now; a surprise if it doesn't fit, or null. Learns from what fits. */
  observe(c: Observed): Notice | null {
    if (c.kind === 'item' || c.kind === 'other') return null;
    const m = c.motion;
    const env = this.envelope(c.type);
    const free = m.medium === 'air' && !m.supported;
    const who = label(c);
    let found: { key: string; text: string; strength: number } | null = null;
    if (m.jumpedM !== undefined && !BLINKERS.has(c.type) && m.medium !== 'riding') {
      found = { key: 'blink', text: `${cap(who)} just went ${m.jumpedM} m in an instant, from ${m.jumpedFrom ? `${m.jumpedFrom.x},${m.jumpedFrom.y},${m.jumpedFrom.z}` : 'where they were'} to where they are now`, strength: Math.min(1, 0.55 + m.jumpedM / 60) };
    } else if (m.insideBlock && c.distance <= 16) {
      found = { key: 'inside', text: `${cap(who)} is inside solid ${m.insideBlock.replace(/_/g, ' ')}, right in the block`, strength: 0.75 };
    } else if (free && !FLIERS.has(c.type) && !CLIMBERS.has(c.type) && !SWIMMERS.has(c.type)) {
      const hoverLimit = Math.max(1.5, env.hover * 1.5);
      const slow = SLOW_FALLERS.has(c.type) && m.vy < -0.2;
      // Rising for a second and a half: a pillar or a climb up a tree is a burst of jumps, each landed on (one up a tree
      // after its logs was taken for "rising straight up into the air", and asked how it floated).
      if (!slow && m.vy > 2 && m.airborneSec > 1.5 && !JUMPERS.has(c.type)) {
        found = { key: 'rise', text: `${cap(who)} is rising straight up into the air, ${ONE_DP(m.aboveGround)} m off the ground now`, strength: 0.75 };
      } else if (!slow && Math.abs(m.vy) < 1.2 && m.airborneSec > hoverLimit && m.aboveGround >= 0.6) {
        const high = m.aboveGround >= 2 ? `${ONE_DP(m.aboveGround)} m up in the air` : 'up off the ground';
        found = { key: 'hover', text: `${cap(who)} is ${high} with nothing under ${them(c.kind)}, not falling (${ONE_DP(m.airborneSec)} s now)`, strength: Math.min(1, 0.45 + (m.airborneSec - hoverLimit) / 6 + m.aboveGround / 12) };
      }
    }
    if (!found && m.medium !== 'riding' && m.medium !== 'gliding' && m.medium !== 'water') {
      // Kept up, not a burst: a sprint's jump, a knock back or a lagging player catching up surprises nobody.
      const limit = Math.max(env.ground, env.air) * 1.35;
      const fast = m.sustained ?? 0;
      if (fast > limit && fast > 8) {
        found = { key: 'speed', text: `${cap(who)} has been moving at ${Math.round(fast)} m/s${m.supported ? '' : ' through the air'}, far faster than anyone can run`, strength: Math.min(1, 0.5 + (fast - limit) / 15) };
      }
    }
    if (!found) {
      this.widen(c.type, m);
      return null;
    }
    return this.surprise(c.id, c.name, c.kind, found.key, found.text, found.strength);
  }

  /** Something came into being close by and in sight: things that spawn do so out of sight, never beside you. */
  appeared(c: { id: number; name: string; kind: EntityKind; type: string; distance: number; visible: boolean; baby: boolean }): Notice | null {
    if (c.kind === 'item' || c.kind === 'other' || !c.visible || c.distance > 12 || c.baby) return null;
    return this.surprise(c.id, c.name, c.kind, 'appear', `${cap(label(c))} appeared out of nowhere, ${Math.round(c.distance)} m from you`, c.kind === 'player' ? 0.7 : 0.55);
  }

  /** Something vanished in plain sight, close by, without dying or leaving. */
  vanished(c: { id: number; name: string; kind: EntityKind; type: string; distance: number; visible: boolean }): Notice | null {
    if (c.kind === 'item' || c.kind === 'other' || !c.visible || c.distance > 12) return null;
    return this.surprise(c.id, c.name, c.kind, 'vanish', `${cap(label(c))} vanished into thin air, ${Math.round(c.distance)} m from you`, c.kind === 'player' ? 0.7 : 0.5);
  }

  /** What happened to the agent itself that doesn't fit (moved in an instant, things in its pockets from nowhere, ...). */
  aboutSelf(key: string, text: string, strength: number): Notice | null {
    return this.surprise(-1, 'you', 'player', key, text, strength);
  }

  /** The world itself (the sky changing in an instant, ...). */
  aboutWorld(key: string, text: string, strength: number): Notice | null {
    return this.surprise(-2, 'the world', 'other', key, text, strength);
  }

  private surprise(id: number, about: string, kind: EntityKind, key: string, text: string, strength: number): Notice | null {
    const now = this.o.now();
    const tag = `${id}:${key}`;
    if (now - (this.said.get(tag) ?? -Infinity) < AGAIN_MS) return null;
    this.said.set(tag, now);
    if (this.said.size > 400) for (const [k, t] of this.said) if (now - t > 10 * AGAIN_MS) this.said.delete(k);
    const counted = `${about}:${key}`;
    const seenBefore = this.o.state().knowledge.surprised?.[counted] ?? 0;
    // Each time the same is seen again it surprises less; once known, it no longer does at all.
    const known = seenBefore >= KNOWN_AFTER;
    const felt = known ? 0 : strength / (1 + seenBefore);
    this.o.learn((k) => {
      const surprised = { ...(k.surprised ?? {}), [counted]: seenBefore + 1 };
      let beliefs = k.beliefs ?? [];
      const what = BELIEF[key];
      if (what && seenBefore + 1 >= KNOWN_AFTER && about !== 'you' && about !== 'the world') {
        const had = beliefs.find((b) => b.about === about && b.key === key);
        beliefs = had ? beliefs.map((b) => (b === had ? { ...b, seen: seenBefore + 1, lastSeen: now } : b)) : [...beliefs, { about, key, text: what, since: now, seen: seenBefore + 1, lastSeen: now }].slice(-40);
      }
      return { ...k, surprised, beliefs };
    });
    const said = known ? `${text}. ${kind === 'player' && about !== 'you' ? `You know ${about} ${BELIEF[key] ?? 'does this'}.` : "You've seen it often."}` : `${text}. ${seenBeforeWords(seenBefore, kind)}`;
    return { id: `n${now.toString(36)}${(seq++).toString(36)}`, ts: now, kind: 'surprise', about, key, text: said, strength: Math.round(felt * 100) / 100, seenBefore };
  }

  /** What fits is learned too: the fastest, longest and highest seen of a kind widen what is expected of it. */
  private widen(type: string, m: Motion): void {
    const prior = PRIOR[type] ?? PRIOR.default;
    if (!prior) return;
    const cur = this.o.state().knowledge.envelopes?.[type];
    // A hover is learned only within what is already known: learned from one still going on, each look stretched the
    // limit half as far again past it, and someone hanging in the air for minutes was never surprising (seen once the
    // rise that used to be noticed first came to be taken more slowly).
    const hovering = !m.supported && m.medium === 'air' && Math.abs(m.vy) < 1.2 && m.airborneSec <= Math.max(prior.hover, cur?.hover ?? 0);
    // Speed kept up is what a kind can do; a burst says nothing of it.
    const kept = m.sustained ?? 0;
    const next: Envelope = {
      ground: m.supported ? Math.max(cur?.ground ?? 0, kept) : (cur?.ground ?? 0),
      air: m.supported ? (cur?.air ?? 0) : Math.max(cur?.air ?? 0, kept),
      hover: hovering ? Math.max(cur?.hover ?? 0, m.airborneSec) : (cur?.hover ?? 0),
      height: hovering ? Math.max(cur?.height ?? 0, m.aboveGround) : (cur?.height ?? 0),
      n: (cur?.n ?? 0) + 1,
    };
    // Only what is new is worth a write: a wider envelope, or every 50th look.
    const wider = !cur || next.ground > cur.ground + 0.2 || next.air > cur.air + 0.2 || next.hover > cur.hover + 0.1 || next.height > cur.height + 0.2;
    if (!wider && next.n % 50 !== 0) return;
    this.o.learn((k) => ({ ...k, envelopes: { ...(k.envelopes ?? {}), [type]: next } }));
  }
}
