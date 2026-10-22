// Notable deeds seen in the world (§6.3 rule 2): someone broke blocks we placed, attacked someone we care about, or
// helped us fight. Each moves sentiment by a code-only delta, at most once a minute per person and deed, so a
// long fight or a demolished wall counts as one deed, not dozens.

import type { AgentName } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { AgentStateStore } from '../state/store';
import type { SocialAwareness } from './awareness';
import type { Deed } from './math';

export interface DeedWatchOptions {
  bot: Bot;
  store: AgentStateStore;
  social: SocialAwareness;
  me: AgentName;
  /** Positions ("x,y,z") of blocks this body placed. */
  placed: Set<string>;
  now?: () => number;
}

const ONCE_PER_MS = 60_000;
const AIR = new Set(['air', 'cave_air', 'void_air']);

export class DeedWatch {
  private readonly last = new Map<string, number>();
  private readonly now: () => number;
  private off: (() => void) | null = null;

  constructor(private readonly o: DeedWatchOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const onUpdate = (old: Block | null, cur: Block | null) => {
      if (!old || !cur) return;
      const k = `${old.position.x},${old.position.y},${old.position.z}`;
      if (!this.o.placed.has(k) || !AIR.has(cur.name)) return;
      this.o.placed.delete(k);
      // Our own dig (the dig plugin clears its target only after this generic event).
      if (this.o.bot.targetDigBlock?.position.equals(old.position)) return;
      const by = this.breaker(old);
      if (by) this.deed(by, 'brokeMyBlocks', `${by} broke the ${old.name.replace(/_/g, ' ')} I placed`);
    };
    this.o.bot.on('blockUpdate', onUpdate);
    this.off = () => this.o.bot.off('blockUpdate', onUpdate);
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  /** The reflexes saw someone hit a person we would defend. */
  allyAttacked(ally: AgentName, by: string | null): void {
    if (!by || by === this.o.me || by === ally || !this.o.bot.players[by]) return;
    this.deed(by, 'attackedAlly', `${by} attacked ${ally}`);
  }

  /** Someone else hit the mob that was after us. */
  helpedFight(helper: AgentName): void {
    if (helper === this.o.me) return;
    this.deed(helper, 'helpedMeFight', `${helper} helped me fight`);
  }

  private deed(name: AgentName, deed: Deed, note: string): void {
    const k = `${deed}:${name}`;
    const t = this.now();
    if (t - (this.last.get(k) ?? -Infinity) < ONCE_PER_MS) return;
    this.last.set(k, t);
    this.o.social.deed(name, deed, note);
  }

  /** Who broke it: someone we saw digging there, else someone right next to it who just swung. */
  private breaker(b: Block): AgentName | null {
    const t = this.now();
    const p = b.position;
    const seen = this.o.store.state.perception.observedActions;
    const dug = [...seen].reverse().find((a) => a.kind === 'dig' && a.pos && a.pos.x === p.x && a.pos.y === p.y && a.pos.z === p.z && t - a.ts < 15_000);
    if (dug) return dug.actor === this.o.me ? null : dug.actor;
    const swung = [...seen]
      .reverse()
      .find((a) => a.kind === 'swing' && a.actor !== this.o.me && a.pos && t - a.ts < 1500 && Math.hypot(a.pos.x - p.x - 0.5, a.pos.y - p.y, a.pos.z - p.z - 0.5) <= 4.5);
    return swung?.actor ?? null;
  }
}
