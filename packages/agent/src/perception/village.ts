// What the agent sees of its village (§6.8), from its own eyes only (§13 rule 4): the chest nearest home, the huts
// (by their doors), the signs it reads (the notice board is where they stand near home) and hostile mobs coming near.
// Runs with the perception block scan; writes `village` and emits `signRead` for a sign that is new or changed.

import type { SignSeen, Vec3 as V3, VillageState } from '@agora/shared';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import type { AgentBus } from '../bus';
import { isSignBlock, readSign } from '../body/signs';
import { canSeeBlock, isHostile } from '../body/world';
import type { AgentStateStore } from '../state/store';

/** How far from home the village reaches. */
export const VILLAGE_RADIUS = 32;
/**
 * Signs this close to home are the notice board. Everyone's home is where they arrived, a few blocks apart around the
 * world spawn, so the board has to be found from each of them.
 */
export const BOARD_RADIUS = 16;
const CHEST_RADIUS = 20;
const RING_SIGNS = 20;
const RING_THREATS = 20;
const RING_FINDS = 10;
/** Ore this far from home is a find worth posting. */
const FIND_DIST = 20;
const THREAT_FORGET_MS = 10 * 60_000;

const at = (p: { x: number; y: number; z: number }): V3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const same = (a: V3 | null | undefined, b: V3 | null | undefined) => Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);

export class VillageEyes {
  private ids: { chest: number[]; door: number[]; sign: number[] } | null = null;
  /** Hostile mobs already counted as having come near (entity id → when). */
  private readonly counted = new Map<number, number>();

  constructor(
    private readonly o: { bot: Bot; store: AgentStateStore; bus: AgentBus; home: () => { x: number; y: number; z: number } | null; now: () => number },
  ) {}

  scan(): void {
    const { bot, store } = this.o;
    const h = this.o.home();
    if (!h || !bot.entity) return;
    const home = at(h);
    this.ids ??= {
      chest: ['chest', 'trapped_chest', 'barrel'].map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined),
      door: bot.registry.blocksArray.filter((b) => /_door$/.test(b.name) && !/trapdoor/.test(b.name)).map((b) => b.id),
      sign: bot.registry.blocksArray.filter((b) => isSignBlock(b.name)).map((b) => b.id),
    };
    const v = store.state.village;
    const next: VillageState = { ...v, home: same(v.home, home) ? v.home : home };
    const me = bot.entity.position;
    const visible = (p: Vec3) => canSeeBlock(bot, p, 17);
    // The village chest: the one nearest home we have seen. One we can see is gone is forgotten.
    const chests = bot.findBlocks({ matching: this.ids.chest, maxDistance: 16, count: 8 }).filter((p) => dist(at(p), home) <= CHEST_RADIUS && visible(p));
    const nearest = chests.sort((a, b) => dist(at(a), home) - dist(at(b), home))[0];
    if (nearest && (!v.chest || dist(at(nearest), home) < dist(v.chest.pos, home) - 0.5)) {
      next.chest = { pos: at(nearest), contents: null, seenAt: this.o.now() };
    } else if (v.chest && me.distanceTo(new Vec3(v.chest.pos.x, v.chest.pos.y, v.chest.pos.z)) <= 8 && visible(new Vec3(v.chest.pos.x, v.chest.pos.y, v.chest.pos.z))) {
      const b = bot.blockAt(new Vec3(v.chest.pos.x, v.chest.pos.y, v.chest.pos.z));
      if (b && !this.ids.chest.includes(b.type)) next.chest = null;
    }
    // Huts: doors near home (one per doorway, by its lower half).
    const doors = bot
      .findBlocks({ matching: this.ids.door, maxDistance: 16, count: 16 })
      .filter((p) => dist(at(p), home) <= VILLAGE_RADIUS && visible(p))
      .map((p) => at(p))
      .filter((p) => !this.ids?.door.includes(bot.blockAt(new Vec3(p.x, p.y - 1, p.z))?.type ?? -1));
    const huts = [...v.huts];
    for (const d of doors) if (!huts.some((x) => x.x === d.x && x.z === d.z && Math.abs(x.y - d.y) <= 1)) huts.push(d);
    // A known door we can see is gone: that hut no longer counts.
    next.huts = huts.filter((x) => {
      const p = new Vec3(x.x, x.y, x.z);
      if (me.distanceTo(p) > 12 || !visible(p)) return true;
      return this.ids?.door.includes(bot.blockAt(p)?.type ?? -1) ?? true;
    });
    // Signs in sight: read them; the first one near home marks the board.
    const read: SignSeen[] = [];
    for (const p of bot.findBlocks({ matching: this.ids.sign, maxDistance: 16, count: 16 })) {
      if (!visible(p)) continue;
      const text = readSign(bot.blockAt(p));
      if (!text) continue;
      const pos = at(p);
      const known = v.signs.find((x) => same(x.pos, pos));
      if (known?.text === text) continue;
      read.push({ pos, text, readAt: this.o.now() });
    }
    if (read.length > 0) next.signs = [...v.signs.filter((x) => !read.some((r) => same(r.pos, x.pos))), ...read].slice(-RING_SIGNS);
    const nearBoard = read.find((r) => dist(r.pos, home) <= BOARD_RADIUS);
    if (!v.board && nearBoard) next.board = nearBoard.pos;
    // Hostile mobs coming near home, each counted once.
    const t = this.o.now();
    for (const [id, when] of this.counted) if (t - when > THREAT_FORGET_MS) this.counted.delete(id);
    let threats = v.threats;
    for (const e of Object.values(bot.entities)) {
      if (!isHostile(e) || this.counted.has(e.id)) continue;
      if (dist(at(e.position), home) > 24 || e.position.distanceTo(me) > 24) continue;
      this.counted.set(e.id, t);
      threats = [...threats, t].slice(-RING_THREATS);
    }
    next.threats = threats.filter((x) => t - x <= THREAT_FORGET_MS);
    // Ore found away from home (a scout's news for the board).
    let finds = v.finds;
    for (const b of store.state.perception.nearbyBlocksOfInterest) {
      if (!/_ore$/.test(b.name) || dist(b.pos, home) < FIND_DIST) continue;
      const what = b.name.replace(/^deepslate_/, '').replace(/_/g, ' ');
      if (finds.some((f) => f.what === what && dist(f.pos, b.pos) <= 12)) continue;
      finds = [...finds, { what, pos: { ...b.pos }, at: t }].slice(-RING_FINDS);
    }
    next.finds = finds;
    const changed =
      next.home !== v.home ||
      next.chest !== v.chest ||
      next.huts.length !== v.huts.length ||
      next.signs !== v.signs ||
      next.board !== v.board ||
      next.threats.length !== v.threats.length ||
      next.threats[next.threats.length - 1] !== v.threats[v.threats.length - 1] ||
      next.finds !== v.finds;
    if (changed) store.update('village', () => next, 'perception:village');
    for (const r of read) this.o.bus.emit({ type: 'signRead', sign: r, board: dist(r.pos, home) <= BOARD_RADIUS });
  }

  /** What we saw inside a chest when we opened it (deposit, withdraw): the village chest's contents, if it's that one. */
  sawInside(pos: V3, contents: Record<string, number>): void {
    const v = this.o.store.state.village;
    const h = this.o.home();
    if (!h) return;
    const isVillageChest = v.chest ? same(v.chest.pos, pos) : dist(pos, at(h)) <= CHEST_RADIUS;
    if (!isVillageChest) return;
    this.o.store.update('village', (x) => ({ ...x, chest: { pos, contents, seenAt: this.o.now() } }), 'village chest seen inside');
  }
}
