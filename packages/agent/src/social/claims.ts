// Rumor control (§6.5, hallucination guard #2): what someone says about where things are is a claim to check, not
// a fact. When the claimed place comes into view the agent looks for itself. If the thing is there, the teller's
// trust rises a little. If it isn't, the memory is marked false and the teller's trust drops, which limits how far
// a false belief spreads.

import type { AgentName, Logger, Utterance, Vec3 } from '@agora/shared';
import type { Bot } from 'mineflayer';
import { Vec3 as V3 } from 'vec3';
import type { AgentBus } from '../bus';
import { itemMatcher } from '../body/items';
import { blockIdsDropping, canSeeBlock } from '../body/world';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import type { SocialAwareness } from './awareness';

export interface Claim {
  id: string;
  by: AgentName;
  item: string;
  pos: Vec3;
  text: string;
  ts: number;
  status: 'open' | 'true' | 'false';
}

const COORDS = /(-?\d{1,7})\s*[,\s]\s*(-?\d{1,4})\s*[,\s]\s*(-?\d{1,7})/;
const THING = /\b(diamonds?|emeralds?|gold|iron|coal|copper|redstone|lapis|ancient debris|[a-z_]+_ore|chests?|beds?)\b/i;

/** "diamonds at 120, 12, -40" → { item: 'diamond', pos }. Only claims with a place and a thing count. */
export function parseClaim(text: string): { item: string; pos: Vec3 } | null {
  const c = COORDS.exec(text);
  const t = THING.exec(text);
  if (!c || !t?.[1]) return null;
  const word = t[1].toLowerCase().replace(/\s+/g, '_');
  const item = word === 'ancient_debris' ? word : word.replace(/s$/, '');
  return { item, pos: { x: Number(c[1]), y: Number(c[2]), z: Number(c[3]) } };
}

export interface ClaimCheckerOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  bot: Bot;
  social: SocialAwareness;
  /** Marks memories containing this text as false (Memory.markFalseMatching). */
  markFalse?: (text: string) => void;
  now?: () => number;
}

let seq = 0;

export class ClaimChecker {
  readonly claims: Claim[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: ClaimCheckerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.o.bus.on('addressed', (e) => this.onHeard(e.utterance)));
    this.timer = setInterval(() => this.check(), 2000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** Open claims, nearest first (the code default may go and look when it has nothing to do). */
  open(): Claim[] {
    const me = this.o.store.state.self.pos;
    return this.claims.filter((c) => c.status === 'open').sort((a, b) => dist(a.pos, me) - dist(b.pos, me));
  }

  private onHeard(u: Utterance): void {
    const c = parseClaim(u.text);
    if (!c) return;
    this.claims.push({ id: `cl${(seq++).toString(36)}`, by: u.from, item: c.item, pos: c.pos, text: u.text, ts: this.now(), status: 'open' });
    if (this.claims.length > 20) this.claims.shift();
  }

  private check(): void {
    const bot = this.o.bot;
    const me = bot.entity.position;
    for (const c of this.claims) {
      if (c.status !== 'open') continue;
      const at = new V3(c.pos.x, c.pos.y, c.pos.z);
      if (me.distanceTo(at) > 12 || !bot.blockAt(at)) continue;
      const ids = new Set(blockIdsDropping(bot, itemMatcher(c.item)));
      let found = false;
      let looked = false;
      for (let dx = -2; dx <= 2 && !found; dx++) {
        for (let dy = -2; dy <= 2 && !found; dy++) {
          for (let dz = -2; dz <= 2 && !found; dz++) {
            const p = at.offset(dx, dy, dz);
            const b = bot.blockAt(p);
            if (!b || !canSeeBlock(bot, p, 16)) continue;
            looked = true;
            if (ids.has(b.type)) found = true;
          }
        }
      }
      if (found) this.settle(c, true);
      // Only a look at the place itself settles it: hidden ore may still be there.
      else if (looked && canSeeBlock(bot, at, 16)) this.settle(c, false);
    }
  }

  private settle(c: Claim, isTrue: boolean): void {
    c.status = isTrue ? 'true' : 'false';
    const where = `${c.pos.x}, ${c.pos.y}, ${c.pos.z}`;
    if (isTrue) {
      pushWorkmem(this.o.store, `${c.by} was right: there is ${c.item} at ${where}`, 0.5, 'self_observed', { aboutAgent: c.by, now: this.now() });
      this.o.store.update(
        'social',
        (all) => {
          const p = all[c.by];
          return p ? { ...all, [c.by]: { ...p, trust: Math.min(1, p.trust + 0.05) } } : all;
        },
        'claim held up',
      );
    } else {
      this.o.social.claimFailed(c.by);
      this.o.markFalse?.(c.text);
      pushWorkmem(this.o.store, `${c.by} said there was ${c.item} at ${where}, but there isn't`, 0.7, 'self_observed', { aboutAgent: c.by, now: this.now() });
    }
    this.o.logger.info({ module: 'claims', by: c.by, item: c.item, pos: c.pos, held: isTrue }, 'claim checked');
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
