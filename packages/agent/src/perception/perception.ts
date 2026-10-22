// Perception (§4.2 module 1, §6.1): the only way the world reaches the Agent State. Everything comes from this
// bot's own Minecraft client, filtered to what a player could perceive: entities in line of sight (or close enough
// to hear), speech the proximity-chat plugin delivered, global system news, and actions seen in view. Writes are
// change-gated so the state version only moves when something meaningful changed.

import { type AgentName, type BlockNote, type Logger, type ObservedAction, type SeenEntity, type Utterance, type Vec3, parseProximityLine, stripColorCodes } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { AgentBus } from '../bus';
import { SwingTracker } from '../body/attribution';
import { inventoryDigest, inventoryStacks } from '../body/inventory';
import { Sightings } from '../body/sightings';
import { canSee, canSeeBlock, isHostile, isNight } from '../body/world';
import { detectAddressee } from '../modules/conversations';
import { newSocialProfile } from '../state/social';
import type { AgentStateStore } from '../state/store';
import { parseSystemLine } from './system';
import { VillageEyes } from './village';

export interface PerceptionOptions {
  bot: Bot;
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  /** Normal proximity-chat range: people inside it count as "in conversation range". */
  speechRange?: number;
  now?: () => number;
  tickMs?: number;
  /** Where this body arrived (the village, §6.8): turns on what it sees of the village. */
  home?: () => { x: number; y: number; z: number } | null;
}

const ENTITY_RADIUS = 32;
/** Close enough to hear footsteps: perceived even without line of sight. */
const HEAR_RADIUS = 4;
const MAX_ENTITIES = 24;
const RING_ACTIONS = 20;
/** How long a drop counts as someone else's (then it's anyone's). */
const THEIRS_MS = 60_000;
const RING_SYSTEM = 20;
// Blocks worth noting: rare ones (also remembered as sightings, which is what lets skills target them) and a few
// landmarks.
const RARE_BLOCK = /_ore$|^ancient_debris$|_bed$|^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|anvil|enchanting_table|brewing_stand)$/;
const LANDMARK_BLOCK = /_log$|^(water|lava)$/;

let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

function v(p: { x: number; y: number; z: number }): Vec3 {
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
}

const isAirName = (n: string) => n === 'air' || n === 'cave_air' || n === 'void_air';

function kindOf(e: Entity): SeenEntity['kind'] | null {
  if (e.type === 'player') return 'player';
  if (e.name === 'item') return 'item';
  if (isHostile(e)) return 'hostile';
  // minecraft-data categories are wider than prismarine-entity's type union.
  const t = e.type as string;
  if (t === 'animal' || t === 'passive' || t === 'water_creature' || t === 'ambient' || t === 'mob') return 'passive';
  return null;
}

function nameOf(e: Entity, kind: SeenEntity['kind']): string {
  if (kind === 'player') return e.username ?? 'someone';
  if (kind === 'item') {
    const it = (e as unknown as { getDroppedItem?: () => { name: string } | null }).getDroppedItem?.();
    return it?.name ?? 'item';
  }
  return e.name ?? 'mob';
}

export class Perception {
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private readonly now: () => number;
  private readonly hurtAt = new Map<number, number>();
  private readonly digSeen = new Map<string, number>();
  private readonly recentSpeakers = new Map<AgentName, number>();
  private lastSelfKey = '';
  private readonly swings: SwingTracker;
  /** Item entity → who it appeared next to (the likely thrower). */
  private readonly droppedBy = new Map<number, { by: AgentName; at: number }>();
  /** Item entity → whose it is: tossed or dug out by someone else, not toward us (pickup courtesy). */
  private readonly theirs = new Map<number, { by: AgentName; at: number }>();
  private lastEntitiesKey = '';
  private lastBlocksKey = '';
  private readonly socialSeenAt = new Map<AgentName, number>();
  private readonly offs: (() => void)[] = [];
  /** What it sees of the village (§6.8); null without a home. */
  readonly village: VillageEyes | null;
  /** Work seen (blows at mobs, blocks set down): one note per person, kind and thing every few seconds. */
  private readonly workSeen = new Map<string, number>();

  constructor(private readonly o: PerceptionOptions) {
    this.now = o.now ?? Date.now;
    this.swings = new SwingTracker(o.bot, this.now);
    this.village = o.home ? new VillageEyes({ bot: o.bot, store: o.store, bus: o.bus, home: o.home, now: this.now }) : null;
  }

  get me(): string {
    return this.o.bot.username;
  }

  start(): void {
    if (this.timer) return;
    const bot = this.o.bot;
    const on = <A extends unknown[]>(ev: string, fn: (...a: A) => void) => {
      (bot as unknown as { on(e: string, f: (...a: A) => void): void }).on(ev, fn);
      this.offs.push(() => (bot as unknown as { off(e: string, f: (...a: A) => void): void }).off(ev, fn));
    };
    on('messagestr', (msg: string, position: string) => this.onMessage(msg, position));
    on('entitySwingArm', (e: Entity) => this.observe(e, 'swing'));
    on('entityHurt', (e: Entity) => {
      this.hurtAt.set(e.id, this.now());
      // §17.6: the attacker is the nearest person who swung at them just now.
      const victim = e.username;
      if (e.type === 'player' && e !== bot.entity && victim) {
        this.swings.attribute(e, ({ attacker: att }) => {
          if (this.timer && att && att !== bot.entity && att.type === 'player' && att.username) this.observe(att, 'attack', { target: victim });
        });
      }
      if (e.type === 'player' && e !== bot.entity) this.observe(e, 'hurt');
      // A blow at a mob or an animal: what people are seen doing for the village (§6.8 roles from deeds).
      if (e.type !== 'player' && e.name !== 'item') {
        this.swings.attribute(e, ({ attacker: att }) => {
          if (this.timer && att && att !== bot.entity && att.type === 'player' && att.username && this.firstInAWhile(`${att.username}:attack:${e.id}`, 3000)) this.observe(att, 'attack', { item: e.name ?? 'mob' });
        });
      }
    });
    // Someone setting blocks down (building): a block appears in reach of a person who just swung.
    on('blockUpdate', (old: { name: string } | null, now: { name: string; position: Vec3 } | null) => {
      if (!now || isAirName(now.name) || (old && !isAirName(old.name))) return;
      const t = this.now();
      const p = now.position;
      const by = Object.values(bot.entities).find(
        (x) => x.type === 'player' && x !== bot.entity && x.username && t - this.swings.lastSwing(x.id) < 600 && Math.hypot(x.position.x - p.x - 0.5, x.position.y - p.y, x.position.z - p.z - 0.5) <= 5.5,
      );
      if (by?.username && this.firstInAWhile(`${by.username}:place`, 2000)) this.observe(by, 'place', { item: now.name, pos: { x: p.x, y: p.y, z: p.z } });
    });
    on('entityDead', (e: Entity) => {
      if (e.type === 'player') this.observe(e, 'death');
    });
    on('entityEquip', (e: Entity) => {
      const held = (e as unknown as { heldItem?: { name: string } | null }).heldItem?.name;
      if (e.type === 'player' && held) this.observe(e, 'equip', { item: held });
    });
    on('entitySleep', (e: Entity) => this.observe(e, 'sleep'));
    // §6.6: a gift is items someone tossed that we then picked up. Item entities don't say who dropped them, so the
    // thrower is the player the item appeared next to (within 2 blocks of their hands, while we could see them).
    on('entitySpawn', (e: Entity) => {
      if (e.name !== 'item') return;
      const t = this.now();
      for (const [id, d] of this.droppedBy) if (t - d.at > 60_000) this.droppedBy.delete(id);
      for (const [id, d] of this.theirs) if (t - d.at > THEIRS_MS) this.theirs.delete(id);
      const thrower = Object.values(bot.entities).find(
        (p) => p.type === 'player' && p !== bot.entity && p.username && p.position.offset(0, 1.2, 0).distanceTo(e.position) <= 2 && canSee(bot, p, ENTITY_RADIUS + 1),
      );
      if (thrower?.username) this.droppedBy.set(e.id, { by: thrower.username, at: t });
      // Tossed toward us (a hand-over happens within 2 blocks) is ours to take; anything else someone tossed, or
      // the drop of a block we saw them dig, is theirs for a while.
      const forUs = e.position.distanceTo(bot.entity.position) <= 3.5;
      const digger = this.o.store.state.perception.observedActions.find(
        (a) => a.kind === 'dig' && a.pos && t - a.ts < 15_000 && Math.hypot(a.pos.x + 0.5 - e.position.x, a.pos.y + 0.5 - e.position.y, a.pos.z + 0.5 - e.position.z) <= 1.5,
      );
      const owner = thrower?.username && !forUs ? thrower.username : digger?.actor;
      if (owner && owner !== this.me) this.theirs.set(e.id, { by: owner, at: t });
    });
    on('playerCollect', (collector: Entity, collected: Entity) => {
      const it = (collected as unknown as { getDroppedItem?: () => { name: string; count: number } | null }).getDroppedItem?.();
      const drop = this.droppedBy.get(collected.id);
      this.droppedBy.delete(collected.id);
      if (collector === bot.entity) {
        if (drop && it && this.now() - drop.at < 30_000) {
          const action: ObservedAction = { id: nextId('o'), actor: drop.by, kind: 'gave', target: this.me, item: it.name, qty: it.count, ts: this.now() };
          this.o.store.update('perception', (p) => ({ ...p, observedActions: [...p.observedActions, action].slice(-RING_ACTIONS) }), 'observed:gave');
          this.o.bus.emit({ type: 'observedAction', action });
        }
        return;
      }
      this.observe(collector, 'collect', it ? { item: it.name, qty: it.count } : {});
    });
    on('blockBreakProgressObserved', (block: { position: Vec3; name: string }, _stage: number, e?: Entity) => {
      if (!e || e === bot.entity) return;
      const key = `${e.id}:${block.position.x},${block.position.y},${block.position.z}`;
      if (this.digSeen.has(key)) return;
      this.digSeen.set(key, this.now());
      this.observe(e, 'dig', { item: block.name, pos: v(block.position) });
    });
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.o.logger.warn({ module: 'perception', err: String(err) }, 'perception tick failed');
      }
    }, this.o.tickMs ?? 250);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** True at most once per `ms` for a key (repeated work is noted, not every blow or block). */
  private firstInAWhile(key: string, ms: number): boolean {
    const t = this.now();
    if (t - (this.workSeen.get(key) ?? -Infinity) < ms) return false;
    this.workSeen.set(key, t);
    if (this.workSeen.size > 200) for (const [k, at] of this.workSeen) if (t - at > 60_000) this.workSeen.delete(k);
    return true;
  }

  /** Pickup courtesy: an item someone else just dug out or dropped (not toward us) is theirs to collect. */
  mayPickUp(entityId: number): boolean {
    const d = this.theirs.get(entityId);
    return !d || this.now() - d.at > THEIRS_MS;
  }

  /** Whether we saw `name` do `kind` (e.g. die) within the last `withinMs`. */
  saw(name: AgentName, kind: ObservedAction['kind'], withinMs: number): boolean {
    const t = this.now();
    return this.o.store.state.perception.observedActions.some((a) => a.actor === name && a.kind === kind && t - a.ts <= withinMs);
  }

  /** People this bot perceives within speech range (seen, or heard recently). */
  peopleInRange(): AgentName[] {
    const range = this.o.speechRange ?? 15;
    const now = this.now();
    const seen = this.o.store.state.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.distance <= range).map((e) => e.name);
    const heard = [...this.recentSpeakers.entries()].filter(([, t]) => now - t < 30_000).map(([n]) => n);
    return [...new Set([...seen, ...heard])].filter((n) => n !== this.me);
  }

  private tick(): void {
    const bot = this.o.bot;
    if (!bot.entity) return;
    this.ticks++;
    this.updateSelf();
    this.updateEntities();
    if (this.ticks % 8 === 1) this.updateBlocks();
    if (this.ticks % 8 === 5) this.village?.scan();
    const cutoff = this.now() - 3000;
    for (const [id, t] of this.hurtAt) if (t < cutoff) this.hurtAt.delete(id);
    for (const [k, t] of this.digSeen) if (t < this.now() - 30_000) this.digSeen.delete(k);
  }

  /** Re-reads the bot's own state now (a decision right after an action must see what it produced). */
  refreshSelf(): void {
    try {
      this.updateSelf();
    } catch (err) {
      this.o.logger.debug({ module: 'perception', err: String(err) }, 'self refresh failed');
    }
  }

  private updateSelf(): void {
    const bot = this.o.bot;
    const inv = inventoryStacks(bot);
    const armor = [5, 6, 7, 8].map((s) => bot.inventory.slots[s]?.name).filter((n): n is string => Boolean(n));
    const pos = v(bot.entity.position);
    const time = bot.time.timeOfDay;
    const isDay = !isNight(bot);
    const light = (bot.blockAt(bot.entity.position) as unknown as { skyLight?: number; light?: number } | null) ?? null;
    const lightLevel = Math.max(light?.light ?? 0, isDay ? (light?.skyLight ?? 15) : Math.max(0, (light?.skyLight ?? 15) - 11));
    const key = [
      Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), bot.health.toFixed(0), bot.food, bot.oxygenLevel, inventoryDigest(inv, 40),
      bot.heldItem?.name ?? '', armor.join(','), bot.game.dimension, isDay, bot.isSleeping, Math.floor(time / 600), lightLevel,
    ].join('|');
    if (key === this.lastSelfKey) return;
    this.lastSelfKey = key;
    const spawn = (bot as unknown as { spawnPoint?: { x: number; y: number; z: number } }).spawnPoint;
    this.o.store.update(
      'self',
      (s) => ({
        ...s,
        pos,
        health: bot.health,
        food: bot.food,
        oxygen: bot.oxygenLevel,
        inventory: inv,
        equipped: bot.heldItem?.name ?? null,
        armor,
        dimension: String(bot.game.dimension),
        time,
        isDay,
        lightLevel,
        isSleeping: bot.isSleeping,
        spawnPos: spawn ? v(spawn) : s.spawnPos,
      }),
      'perception:self',
    );
  }

  private updateEntities(): void {
    const bot = this.o.bot;
    const me = bot.entity.position;
    const now = this.now();
    const out: SeenEntity[] = [];
    const candidates = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= ENTITY_RADIUS)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
      .slice(0, MAX_ENTITIES * 2);
    for (const e of candidates) {
      const kind = kindOf(e);
      if (!kind) continue;
      const distance = e.position.distanceTo(me);
      const visible = canSee(bot, e, ENTITY_RADIUS + 1);
      if (!visible && distance > HEAR_RADIUS) continue;
      const eq = (e as unknown as { equipment?: ({ name: string } | null | undefined)[] }).equipment ?? [];
      out.push({
        id: e.id,
        kind,
        name: nameOf(e, kind),
        pos: v(e.position),
        distance: Math.round(distance * 10) / 10,
        visible,
        heldItem: eq[0]?.name ?? null,
        armor: eq.slice(2).filter((x): x is { name: string } => Boolean(x)).map((x) => x.name),
        lastSeen: now,
        hurtRecently: this.hurtAt.has(e.id),
      });
      if (out.length >= MAX_ENTITIES) break;
    }
    const key = out.map((e) => `${e.id}:${e.kind}:${Math.floor(e.pos.x)},${Math.floor(e.pos.y)},${Math.floor(e.pos.z)}:${e.visible ? 1 : 0}:${e.heldItem ?? ''}:${e.hurtRecently ? 1 : 0}`).join(';');
    if (key !== this.lastEntitiesKey) {
      this.lastEntitiesKey = key;
      this.o.store.update('perception', (p) => ({ ...p, nearbyEntities: out }), 'perception:entities');
    }
    this.meetPeople(out.filter((e) => e.kind === 'player' && e.visible), now);
  }

  /** First sight creates a social profile; lastSeen is refreshed every 15 s while in view. */
  private meetPeople(people: SeenEntity[], now: number): void {
    const due = people.filter((p) => !this.o.store.state.social[p.name] || now - (this.socialSeenAt.get(p.name) ?? 0) > 15_000);
    if (due.length === 0) return;
    for (const p of due) this.socialSeenAt.set(p.name, now);
    const persona = this.o.store.state.self.persona;
    this.o.store.update(
      'social',
      (social) => {
        const next = { ...social };
        for (const p of due) {
          const prev = next[p.name];
          next[p.name] = prev ? { ...prev, lastSeen: now, lastSeenPos: p.pos } : newSocialProfile(p.name, persona, now, p.pos);
        }
        return next;
      },
      'perception:people',
    );
  }

  private blockIds: { rare: number[]; landmark: number[] } | null = null;

  private updateBlocks(): void {
    const bot = this.o.bot;
    this.blockIds ??= {
      rare: bot.registry.blocksArray.filter((b) => RARE_BLOCK.test(b.name)).map((b) => b.id),
      landmark: bot.registry.blocksArray.filter((b) => LANDMARK_BLOCK.test(b.name)).map((b) => b.id),
    };
    const now = this.now();
    const sightings = Sightings.for(bot);
    const notes: BlockNote[] = [];
    const per = new Map<string, number>();
    const scan = (ids: number[], count: number, remember: boolean) => {
      for (const p of bot.findBlocks({ matching: ids, maxDistance: 16, count })) {
        const b = bot.blockAt(p);
        if (!b || !canSeeBlock(bot, p, 17)) continue;
        if (remember) sightings.record(b);
        if ((per.get(b.name) ?? 0) >= 3 || notes.length >= 24) continue;
        per.set(b.name, (per.get(b.name) ?? 0) + 1);
        notes.push({ name: b.name, pos: { x: p.x, y: p.y, z: p.z }, distance: Math.round(p.distanceTo(bot.entity.position)), seenAt: now });
      }
    };
    scan(this.blockIds.rare, 64, true);
    scan(this.blockIds.landmark, 24, false);
    notes.sort((a, b) => a.distance - b.distance);
    const key = notes.map((n) => `${n.name}@${n.pos.x},${n.pos.y},${n.pos.z}`).join(';');
    if (key === this.lastBlocksKey) return;
    this.lastBlocksKey = key;
    this.o.store.update('perception', (p) => ({ ...p, nearbyBlocksOfInterest: notes }), 'perception:blocks');
  }

  private observe(e: Entity, kind: ObservedAction['kind'], extra: Partial<ObservedAction> = {}): void {
    const bot = this.o.bot;
    if (e === bot.entity || e.type !== 'player' || !e.username) return;
    if (!canSee(bot, e, ENTITY_RADIUS + 1)) return;
    const action: ObservedAction = { id: nextId('o'), actor: e.username, kind, ts: this.now(), pos: v(e.position), ...extra };
    this.o.store.update('perception', (p) => ({ ...p, observedActions: [...p.observedActions, action].slice(-RING_ACTIONS) }), `observed:${kind}`);
    this.o.bus.emit({ type: 'observedAction', action });
  }

  private onMessage(raw: string, position: string): void {
    if (position === 'game_info') return; // action bar
    const now = this.now();
    const parsed = parseProximityLine(raw);
    if (parsed.kind === 'spy') return; // never ours to hear (§13 rule 10)
    if (parsed.kind === 'noOneHeard') {
      this.o.bus.emit({ type: 'stateChanged', reason: 'noOneHeard' });
      return;
    }
    if (parsed.kind === 'speech') {
      if (parsed.speaker === this.me) return; // our own echo
      this.recentSpeakers.set(parsed.speaker, now);
      const ent = Object.values(this.o.bot.entities).find((x) => x.type === 'player' && x.username === parsed.speaker);
      const visible = ent ? canSee(this.o.bot, ent, 64) : false;
      const addressee = detectAddressee({
        text: parsed.text,
        me: this.me,
        speaker: parsed.speaker,
        inRange: this.peopleInRange(),
        inConversationWith: Object.values(this.o.store.state.conversations).some(
          (c) => c.status === 'active' && c.participants.includes(parsed.speaker) && c.participants.length === 2,
        ),
      });
      const u: Utterance = {
        id: nextId('u'),
        convId: '',
        from: parsed.speaker,
        to: addressee === 'me' ? [this.me] : 'nearby',
        text: parsed.text,
        ts: now,
        pos: ent && visible ? v(ent.position) : null,
        volume: parsed.volume,
        outOfSight: !visible,
        addressedToMe: addressee === 'me',
        heardAs: addressee,
      };
      this.o.bus.emit({ type: 'heard', utterance: u });
      return;
    }
    const text = stripColorCodes(parsed.text).trim();
    const ev = parseSystemLine(text, now, (n) => Boolean(this.o.bot.players[n]) || n === this.me);
    if (!ev) return;
    this.o.store.update('perception', (p) => ({ ...p, systemEvents: [...p.systemEvents, ev].slice(-RING_SYSTEM) }), `system:${ev.kind}`);
    this.o.bus.emit({ type: 'systemEvent', event: ev });
  }
}

