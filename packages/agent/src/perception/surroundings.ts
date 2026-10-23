// What changed around us (owner request, 2026-10-23: agents didn't react to their shelter being broken). Perception
// keeps the blocks that change where the agent could tell: one touching it (a wall it stands against, the roof over
// its head, noticed in the dark too), or one in sight a few steps off. Code says what changed, where (in words, from
// where it stands), who was at it (a person who dug or swung there, a mob beside it, an explosion) and whether it was
// ours (the shelter we are in, a hut of ours, the village chest, a block we set down). The packet shows it, and a
// change to what is ours, or right beside us, wakes the CC: at once if it opens the shelter we are in, or comes at
// night. What to do about it (patch the hole, see to whoever did it, get away) is the mind's call (§13: code finds
// it, the model decides).

import type { AgentName, BlockChange, Logger, Vec3 as Pos } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Vec3 } from 'vec3';
import type { AgentBus } from '../bus';
import { canSeeBlock, isEnclosed, isShelterCell, whereFrom } from '../body/world';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';

export interface SurroundingsOptions {
  bot: Bot;
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** Blocks this body set down ("x,y,z"). */
  placed: ReadonlySet<string>;
  /** The shelter skill is holding us (dug in, or digging in). */
  inShelter?: () => boolean;
  now?: () => number;
}

/** A change in sight within this is noticed. */
const SIGHT = 10;
/** A block this near (touching us) is noticed in sight or not. */
const TOUCH = 2.2;
const RING = 12;
/** Changes that come together (a blast, a wall coming down) are told as one, after this. */
const SETTLE_MS = 400;
/** A change is on the mind this long. */
export const CHANGE_MS = 5 * 60_000;
/** Walled in this lately: still our shelter when a wall of it goes (the check comes just after). */
const ENCLOSED_MS = 3000;
/** A block we dug is ours to forget for this long. */
const OWN_DIG_MS = 3000;
/** Blocks that come and go by themselves, or don't matter: plants, liquids, fire, snow. */
const NOISE =
  /^(air|cave_air|void_air|water|lava|bubble_column|fire|soul_fire|snow|light|moving_piston|short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|seagrass|tall_seagrass|kelp|kelp_plant|sugar_cane|wheat|carrots|potatoes|beetroots|sweet_berry_bush|cocoa|melon_stem|pumpkin_stem|cave_vines|cave_vines_plant|hanging_roots|moss_carpet|frogspawn|pink_petals|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|wither_rose|brown_mushroom|red_mushroom)$|_(leaves|sapling|tulip)$/;
const OPENABLE = /_(door|trapdoor|fence_gate)$/;
interface BlockState {
  name: string;
  open?: boolean;
}

/** What kind of change it was, if one worth telling: something gone, something set down, a door opened or shut. */
export function classify(was: BlockState, now: BlockState): BlockChange['kind'] | null {
  if (was.name === now.name) {
    if (OPENABLE.test(now.name) && was.open !== undefined && now.open !== undefined && was.open !== now.open) return now.open ? 'opened' : 'closed';
    return null;
  }
  const before = !NOISE.test(was.name);
  const after = !NOISE.test(now.name);
  if (before && !after) return 'broken';
  if (!before && after) return 'placed';
  return null;
}

/** A change as one would put it: "the dirt of your shelter beside you to the north, at head height, was broken by a zombie". */
export function describeChange(c: BlockChange): string {
  const thing = (c.kind === 'placed' ? c.now : c.was).replace(/_/g, ' ');
  const whose = c.ours === 'shelter' ? `the ${thing} of your shelter` : c.ours === 'hut' ? `the ${thing} of the hut` : c.ours === 'chest' ? 'the village chest' : c.ours === 'placed' ? `the ${thing} you set down` : `a ${thing}`;
  const by = c.by ? ` by ${c.by}` : '';
  if (c.kind === 'placed') return `${c.by ? `${c.by} set down` : 'someone set down'} ${thing} ${c.where}`;
  return `${whose} ${c.where} was ${c.kind}${by}`;
}

/** The changes worth telling now: ours first, then the nearest in time; at most `max`. */
export function recentChanges(changes: readonly BlockChange[], now: number, max = 5): BlockChange[] {
  return changes
    .filter((c) => now - c.ts < CHANGE_MS)
    .sort((a, b) => Number(Boolean(b.ours)) - Number(Boolean(a.ours)) || b.ts - a.ts)
    .slice(0, max);
}

const keyOf = (p: Pos) => `${p.x},${p.y},${p.z}`;
const openOf = (b: Block): boolean | undefined => {
  const v = (b as unknown as { getProperties?: () => Record<string, unknown> }).getProperties?.().open;
  return v === undefined ? undefined : v === true || v === 'true';
};

interface Pending {
  change: BlockChange;
  /** Set down by this body (checked again when told: our own placement is noted just after the update). */
  key: string;
}

export class SurroundingsWatch {
  private readonly now: () => number;
  private readonly pending: Pending[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;
  private enclosedAt = -Infinity;
  private watch: ReturnType<typeof setInterval> | null = null;
  /** Blocks we dug ourselves, lately (the dig target is cleared before the update comes, so it is kept here). */
  private readonly dug = new Map<string, number>();

  constructor(private readonly o: SurroundingsOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const onUpdate = (old: Block | null, cur: Block | null) => {
      if (old && cur) this.onUpdate(old, cur);
    };
    const onDug = (b: Block | null) => {
      if (b) this.dug.set(keyOf(b.position), this.now());
    };
    this.o.bot.on('blockUpdate', onUpdate);
    this.o.bot.on('diggingCompleted', onDug);
    this.off = () => {
      this.o.bot.off('blockUpdate', onUpdate);
      this.o.bot.off('diggingCompleted', onDug);
    };
    // Walled in, as of a moment ago (when a wall goes, the shelter it was is still ours).
    this.watch = setInterval(() => {
      if (this.o.bot.entity && isEnclosed(this.o.bot)) this.enclosedAt = this.now();
    }, 1000);
    this.watch.unref();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  /** Dug in or walled up just now: the shelter skill holding us, or walls all round a moment ago. */
  private sheltered(): boolean {
    return (this.o.inShelter?.() ?? false) || this.now() - this.enclosedAt < ENCLOSED_MS;
  }

  private onUpdate(old: Block, cur: Block): void {
    const bot = this.o.bot;
    const pos = cur.position;
    const key = keyOf(pos);
    // Something changed again where a change is kept (a hole patched, by us or anyone): that one is over.
    const kept = this.o.store.state.perception.blockChanges;
    if (kept.some((c) => keyOf(c.pos) === key)) {
      this.o.store.update('perception', (p) => ({ ...p, blockChanges: p.blockChanges.filter((c) => keyOf(c.pos) !== key) }), 'block changed again');
    }
    const kind = classify({ name: old.name, open: openOf(old) }, { name: cur.name, open: openOf(cur) });
    if (!kind) return;
    // Our own doing: what we dig (checked again when told), and what we set down (checked when told).
    if (kind === 'broken' && bot.targetDigBlock?.position.equals(pos)) this.dug.set(key, this.now());
    const me = bot.entity.position;
    const feet = me.floored();
    const centre = pos.offset(0.5, 0.5, 0.5);
    const d = centre.distanceTo(me.offset(0, 1.62, 0));
    if (d > SIGHT) return;
    const sheltered = this.sheltered();
    const touching = d <= TOUCH || (sheltered && isShelterCell(feet, pos));
    if (!touching && !canSeeBlock(bot, pos, SIGHT)) return;
    const t = this.now();
    const ours = this.oursOf(pos, key, feet, sheltered, kind);
    const by = this.byWhom(pos, t);
    const change: BlockChange = { pos: { x: pos.x, y: pos.y, z: pos.z }, kind, was: old.name, now: cur.name, ...(by ? { by } : {}), ...(ours ? { ours } : {}), where: whereFrom(feet, pos), ts: t };
    this.pending.push({ change, key });
    this.flushTimer ??= setTimeout(() => this.flush(), SETTLE_MS);
  }

  private oursOf(pos: Vec3, key: string, feet: Vec3, sheltered: boolean, kind: BlockChange['kind']): BlockChange['ours'] {
    const s = this.o.store.state;
    if (kind !== 'placed' && sheltered && isShelterCell(feet, pos)) return 'shelter';
    const chest = s.village.chest?.pos;
    if (chest && keyOf(chest) === key) return 'chest';
    if (s.village.huts.some((h) => Math.max(Math.abs(h.x - pos.x), Math.abs(h.z - pos.z)) <= 4 && Math.abs(h.y - pos.y) <= 4)) return 'hut';
    if (kind !== 'placed' && this.o.placed.has(key)) return 'placed';
    return undefined;
  }

  /** Who was at it: a person who dug or swung there just now, else a person or a mob right beside it. */
  private byWhom(pos: Vec3, t: number): string | undefined {
    const seen = this.o.store.state.perception.observedActions;
    const dug = [...seen].reverse().find((a) => a.kind === 'dig' && a.pos && keyOf(a.pos) === keyOf(pos) && t - a.ts < 15_000);
    if (dug) return dug.actor === this.o.me ? undefined : dug.actor;
    const c = pos.offset(0.5, 0.5, 0.5);
    const swung = [...seen]
      .reverse()
      .find((a) => (a.kind === 'swing' || a.kind === 'place') && a.actor !== this.o.me && a.pos && t - a.ts < 1500 && Math.hypot(a.pos.x - c.x, a.pos.y - c.y, a.pos.z - c.z) <= 4.5);
    if (swung) return swung.actor;
    const bot = this.o.bot;
    const e = bot.nearestEntity((x) => x !== bot.entity && ['player', 'hostile', 'mob'].includes(x.type) && x.position.offset(0, (x.height ?? 1.8) / 2, 0).distanceTo(c) <= 2.5);
    if (!e) return undefined;
    return e.type === 'player' ? (e.username ?? 'someone') : e.name ? `a ${e.name.replace(/_/g, ' ')}` : 'something';
  }

  private flush(): void {
    this.flushTimer = null;
    // What we set down or dug ourselves is no news (noted just after the block changes).
    const t = this.now();
    for (const [k, at] of this.dug) if (t - at > OWN_DIG_MS) this.dug.delete(k);
    const batch = this.pending.splice(0).filter((p) => !(p.change.kind === 'placed' ? this.o.placed.has(p.key) : this.dug.has(p.key)));
    if (batch.length === 0) return;
    const changes = batch.map((p) => p.change);
    // Several blocks gone at once, nobody at them: a blast.
    const gone = changes.filter((c) => c.kind === 'broken');
    if (gone.length >= 3 && gone.every((c) => !c.by || c.by === 'a creeper')) for (const c of gone) c.by = 'an explosion';
    // A door is two blocks: told once.
    const told: BlockChange[] = [];
    for (const c of changes) {
      if (told.some((x) => x.kind === c.kind && x.was === c.was && x.pos.x === c.pos.x && x.pos.z === c.pos.z && Math.abs(x.pos.y - c.pos.y) <= 1 && OPENABLE.test(c.was))) continue;
      told.push(c);
    }
    this.o.store.update('perception', (p) => ({ ...p, blockChanges: [...p.blockChanges, ...told].slice(-RING) }), 'block changed');
    const rank = (c: BlockChange) => (c.ours === 'shelter' ? 4 : c.ours === 'hut' ? 3 : c.ours === 'chest' ? 2 : c.ours ? 1 : 0);
    const top = [...told].sort((a, b) => rank(b) - rank(a))[0];
    if (!top) return;
    if (top.ours) pushWorkmem(this.o.store, `I noticed ${describeChange(top)}.`, top.ours === 'shelter' ? 0.85 : 0.7, 'self_observed', { now: top.ts });
    this.o.logger.info({ module: 'perception', change: top.kind, block: top.was === 'air' ? top.now : top.was, at: top.pos, by: top.by, ours: top.ours, more: told.length - 1 }, 'block changed');
    this.o.bus.emit({ type: 'surroundingsChanged', change: top });
  }
}
