// Expeditions to the Nether and the End (owner request, 2026-10-24: possible, not easy, a few deaths to be expected;
// chosen by the agents themselves for riches and glory, and their friends talked into coming). What it takes is the
// game's own: ten obsidian (a diamond pickaxe and lava) and flint and steel for a portal; blaze powder and ender
// pearls for eyes of ender, a stronghold found by throwing them, and twelve of them for the End portal. These are the
// steps no other skill does: building and lighting the portal, going through one and remembering the way back,
// throwing an eye to see where it flies, and filling the End portal's frames. Mining, fighting and finding things
// there are the skills of home, in a harder place.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { blueprintOf, cellKey } from '../../building/compile';
import { countItem } from '../inventory';
import { itemMatcher } from '../items';
import { findKnownBlocks } from '../sightings';
import { isAirLike, isSolid } from '../world';
import { construct, findBuildSite } from './construct';
import { runOther } from './tools';
import { defineSkill, type SkillContext } from './types';
import { abortable, errMsg, goals, gotoNear, stopMotion, throwIfAborted, waitMs, withTimeout } from './util';

/** The world we are in: overworld, the_nether or the_end. */
export function dimensionOf(bot: Bot): string {
  return String(bot.game.dimension ?? 'overworld').replace(/^minecraft:/, '');
}

const WORLD_NAME: Readonly<Record<string, string>> = { overworld: 'the Overworld', the_nether: 'the Nether', the_end: 'the End' };
const WANT: Readonly<Record<string, string>> = { nether: 'the_nether', overworld: 'overworld', end: 'the_end' };

/** A nether portal's frame, four wide and five high, in the x-y plane: ten obsidian, its corners any block. */
export function portalBlueprint(corner = 'cobblestone') {
  const states = new Map<string, string>();
  const air = new Set<string>();
  for (let x = 0; x <= 3; x++) {
    for (let y = 1; y <= 5; y++) {
      const edgeX = x === 0 || x === 3;
      const edgeY = y === 1 || y === 5;
      if (edgeX && edgeY) states.set(cellKey(x, y, 0), corner);
      else if (edgeX || edgeY) states.set(cellKey(x, y, 0), 'obsidian');
      else air.add(cellKey(x, y, 0));
    }
  }
  return blueprintOf('nether portal', states, air, null);
}

const CORNERS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'netherrack', 'andesite', 'diorite', 'granite', 'obsidian'];

export const portal = defineSkill({
  name: 'portal',
  description: 'portal {} — build a nether portal near you from 10 obsidian (and 4 cobblestone for its corners) and light it with flint and steel: the way into the Nether, where people die',
  argsSchema: z.object({}),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx) {
    const { bot } = ctx;
    const obsidian = countItem(bot, itemMatcher('obsidian'));
    if (obsidian < 10) return { ok: false, observed: `have ${obsidian} obsidian`, error: `a portal takes 10 obsidian (mined with a diamond pickaxe where lava has met water); I have ${obsidian}` };
    if (countItem(bot, itemMatcher('flint_and_steel')) === 0) {
      const r = await runOther(ctx, 'obtain', { item: 'flint_and_steel', qty: 1 });
      if (!r?.ok) return { ok: false, observed: 'no flint and steel', error: `lighting a portal takes flint and steel (an iron ingot and flint, from gravel): ${r?.error ?? 'could not make one'}` };
    }
    const corner = CORNERS.find((c) => countItem(bot, itemMatcher(c)) >= (c === 'obsidian' ? 14 : 4)) ?? 'cobblestone';
    if (corner !== 'obsidian' && countItem(bot, itemMatcher(corner)) < 4) return { ok: false, observed: 'nothing for the corners', error: 'a portal frame needs 4 blocks of stone or dirt for its corners' };
    const bp = portalBlueprint(corner);
    const site = findBuildSite(bot, { x: 4, z: 1 }, bot.entity.position, { radius: 8, minDist: 2 });
    if (!site) return { ok: false, observed: 'no room', error: 'no level ground near here for a portal' };
    const report = await construct(ctx, bp, { origin: site.origin, turn: 0 });
    if (report.placed + report.already < report.total) return { ok: false, observed: `put up ${report.placed + report.already} of the ${report.total} blocks of the frame`, error: 'the portal frame is not finished' };
    // Fire on the bottom of the frame, inside it.
    const base = bot.blockAt(site.origin.offset(1, 1, 0));
    if (!base || base.name !== 'obsidian') return { ok: false, observed: 'no obsidian at the bottom of the frame', error: 'the frame came out wrong' };
    const flint = bot.inventory.items().find((i) => i.name === 'flint_and_steel');
    if (!flint) return { ok: false, observed: 'no flint and steel', error: 'lost the flint and steel' };
    await gotoNear(ctx, base.position, 3);
    await bot.equip(flint, 'hand');
    await bot.lookAt(base.position.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(base, new Vec3(0, 1, 0));
    let lit: Block | null = null;
    for (let t = 0; t < 30 && !lit; t++) {
      await waitMs(ctx, 100);
      const b = bot.blockAt(site.origin.offset(1, 2, 0));
      if (b?.name === 'nether_portal') lit = b;
    }
    if (!lit) return { ok: false, observed: 'the portal did not light', error: 'the frame is wrong or the flint missed' };
    ctx.portals?.note({ dimension: dimensionOf(bot), pos: { x: lit.position.x, y: lit.position.y, z: lit.position.z }, leadsTo: 'the_nether', at: Date.now() });
    return { ok: true, observed: `built and lit a nether portal at ${lit.position.x},${lit.position.y},${lit.position.z}`, data: { portal: { x: lit.position.x, y: lit.position.y, z: lit.position.z } } };
  },
});

/** A free cell to stand on a few blocks from `from`, out of any portal. */
function freeCellNear(bot: Bot, from: Vec3): Vec3 | null {
  for (let r = 2; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const p = from.offset(dx, dy, dz);
          const feet = bot.blockAt(p);
          const head = bot.blockAt(p.offset(0, 1, 0));
          const ground = bot.blockAt(p.offset(0, -1, 0));
          if (isAirLike(feet) && isAirLike(head) && isSolid(ground) && feet?.name !== 'nether_portal' && ground?.name !== 'lava') return p;
        }
      }
    }
  }
  return null;
}

/** Whether we stand in a portal block of `id` (feet or head). */
function inPortal(bot: Bot, id: number): boolean {
  const feet = bot.entity.position.floored();
  return bot.blockAt(feet)?.type === id || bot.blockAt(feet.offset(0, 1, 0))?.type === id;
}

/**
 * Out of the portal we stand in. The game won't take anyone back through a portal they haven't stepped out of (each
 * moment in it starts its wait over), so arriving, or a trip that doesn't happen, means a step out first: to a free
 * cell nearby, else straight out of the portal's face.
 */
async function stepOut(ctx: SkillContext, id: number): Promise<void> {
  const { bot } = ctx;
  if (!inPortal(bot, id)) return;
  const from = bot.entity.position.floored();
  const cell = freeCellNear(bot, from);
  if (cell) {
    await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalBlock(cell.x, cell.y, cell.z)), 15_000), () => stopMotion(bot)).catch((err: unknown) => {
      if (ctx.signal.aborted) throw err;
    });
  }
  // The portal is flat across one axis: walk out of its face, one way and then the other.
  const axis = String(bot.blockAt(from)?.getProperties().axis ?? bot.blockAt(from.offset(0, 1, 0))?.getProperties().axis ?? 'x');
  for (const dir of [1, -1]) {
    if (!inPortal(bot, id)) break;
    const to = axis === 'x' ? from.offset(0.5, 0, 0.5 + dir * 2) : from.offset(0.5 + dir * 2, 0, 0.5);
    await bot.lookAt(to.offset(0, 1.6, 0), true);
    bot.setControlState('forward', true);
    await waitMs(ctx, 700);
    bot.setControlState('forward', false);
  }
  stopMotion(bot);
}

/** Into the portal block at `at` (of `id`), with steps toward it if the pathfinder stops short. */
async function stepInto(ctx: SkillContext, at: Vec3, id: number): Promise<void> {
  const { bot } = ctx;
  try {
    await abortable(ctx.signal, withTimeout(bot.pathfinder.goto(new goals.GoalBlock(at.x, at.y, at.z)), 60_000), () => stopMotion(bot));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.logger.debug({ module: 'skill', err: errMsg(err) }, 'no path into the portal');
  }
  for (let t = 0; t < 15 && !inPortal(bot, id); t++) {
    await bot.lookAt(at.offset(0.5, 1.6, 0.5), true);
    bot.setControlState('forward', true);
    await waitMs(ctx, 100);
  }
  bot.setControlState('forward', false);
  stopMotion(bot);
}

export const travel = defineSkill({
  name: 'travel',
  description: 'travel {to: nether|overworld|end} — go through a portal you know of (a lit nether portal into the Nether and back, an End portal into the End); the way back is remembered. The Nether and the End are deadly: lava, ghasts, piglins, the dragon',
  argsSchema: z.object({ to: z.enum(['nether', 'overworld', 'end']) }),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    const { bot } = ctx;
    const here = dimensionOf(bot);
    const want = WANT[args.to] ?? 'overworld';
    if (here === want) return { ok: true, observed: `already in ${WORLD_NAME[want] ?? want}` };
    if (here === 'the_nether' && want === 'the_end') return { ok: false, observed: 'no way from here', error: 'the End is reached from the Overworld, through a stronghold' };
    const kind = here === 'the_end' || want === 'the_end' ? 'end_portal' : 'nether_portal';
    const id = bot.registry.blocksByName[kind]?.id;
    if (id === undefined) return { ok: false, observed: 'no such portal', error: `no ${kind} in this game` };
    // A portal block at or next to a place we know one is (we built it, or came through it).
    const portalNear = (at: { x: number; y: number; z: number }): Block | null => {
      for (let dy = -1; dy <= 3; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            const b = bot.blockAt(new Vec3(at.x + dx, at.y + dy, at.z + dz));
            if (b?.type === id) return b;
          }
        }
      }
      return null;
    };
    const me = bot.entity.position;
    const notes = (ctx.portals?.list() ?? [])
      .filter((p) => p.dimension === here && (p.leadsTo === want || kind === 'nether_portal'))
      .sort((a, b) => Math.hypot(a.pos.x - me.x, a.pos.z - me.z) - Math.hypot(b.pos.x - me.x, b.pos.z - me.z));
    let found = findKnownBlocks(bot, [id], 64, 1)[0] ?? null;
    for (const note of notes) {
      if (found) break;
      found = portalNear(note.pos);
      if (!found && Math.hypot(note.pos.x - me.x, note.pos.z - me.z) > 8) {
        // Too far to see: walk back to it.
        ctx.progress(`walking to the portal at ${note.pos.x},${note.pos.y},${note.pos.z}`);
        await gotoNear(ctx, new Vec3(note.pos.x, note.pos.y, note.pos.z), 3, 180_000).catch((err: unknown) => {
          if (ctx.signal.aborted) throw err;
        });
        found = portalNear(note.pos);
      }
    }
    if (!found) {
      const why = here === 'the_end' ? 'the way out of the End opens only once the dragon is dead' : kind === 'end_portal' ? 'no open End portal known (a stronghold, its twelve frames filled with eyes of ender)' : 'no lit nether portal known here (build one: portal)';
      return { ok: false, observed: 'no portal', error: why };
    }
    const from = found.position.clone();
    // A nether portal takes four seconds of standing in it, the End's none. Already in it (just come through), or a
    // wait that comes to nothing: out and in again.
    const where = () => {
      const p = bot.entity.position;
      return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}${inPortal(bot, id) ? ' (in the portal)' : ''}`;
    };
    for (let attempt = 0; attempt < 2 && dimensionOf(bot) === here; attempt++) {
      const wasIn = inPortal(bot, id);
      await stepOut(ctx, id);
      if (wasIn) await waitMs(ctx, 1000);
      ctx.progress(`stepping into the portal at ${from.x},${from.y},${from.z}`);
      await stepInto(ctx, from, id);
      ctx.logger.debug({ module: 'skill', attempt, portal: `${from.x},${from.y},${from.z}`, axis: found.getProperties().axis, wasIn, at: where() }, 'in the portal, waiting');
      for (let t = 0; t < 80 && dimensionOf(bot) === here; t++) {
        throwIfAborted(ctx.signal);
        await waitMs(ctx, 100);
      }
    }
    if (dimensionOf(bot) === here) ctx.logger.debug({ module: 'skill', portal: `${from.x},${from.y},${from.z}`, at: where(), block: bot.blockAt(from)?.name }, 'the portal did not take us');
    if (dimensionOf(bot) === here) return { ok: false, observed: 'the portal did not take me', error: 'stood in the portal, nothing happened' };
    // There: let the world load, and remember both ends.
    await waitMs(ctx, 2500);
    const arrived = bot.entity.position.floored();
    const now = Date.now();
    ctx.portals?.note({ dimension: here, pos: { x: from.x, y: from.y, z: from.z }, leadsTo: want, at: now });
    if (kind === 'nether_portal') ctx.portals?.note({ dimension: want, pos: { x: arrived.x, y: arrived.y, z: arrived.z }, leadsTo: here, at: now });
    // Out of the portal: the way back is a step out and in again, and a portal is no place to stand.
    const there = bot.registry.blocksByName[kind]?.id;
    if (there !== undefined) await stepOut(ctx, there);
    const back = kind === 'nether_portal' ? `; the portal back is at ${arrived.x},${arrived.y},${arrived.z}` : '';
    return { ok: true, observed: `went through the portal into ${WORLD_NAME[want] ?? want}${back}`, data: { dimension: want, arrived: { x: arrived.x, y: arrived.y, z: arrived.z } } };
  },
});

const COMPASS = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east'];

export const eye = defineSkill({
  name: 'eye',
  description: 'eye {} — throw an eye of ender and watch where it flies: toward the stronghold that holds the End portal (if it sinks, the stronghold is under you); it may break',
  argsSchema: z.object({}),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx) {
    const { bot } = ctx;
    if (dimensionOf(bot) !== 'overworld') return { ok: false, observed: 'not in the Overworld', error: 'eyes of ender lead to strongholds in the Overworld' };
    const eyeItem = bot.inventory.items().find((i) => i.name === 'ender_eye');
    if (!eyeItem) return { ok: false, observed: 'no eye of ender', error: 'an eye of ender is blaze powder and an ender pearl' };
    await bot.equip(eyeItem, 'hand');
    const before = new Set(Object.keys(bot.entities));
    await bot.look(bot.entity.yaw, 0.3, true);
    bot.activateItem();
    let thrown: { position: Vec3 } | null = null;
    for (let t = 0; t < 30 && !thrown; t++) {
      await waitMs(ctx, 100);
      thrown = Object.entries(bot.entities).find(([idKey, e]) => !before.has(idKey) && /eye_of_ender|ender_eye/.test(e.name ?? ''))?.[1] ?? null;
    }
    bot.deactivateItem();
    if (!thrown) return { ok: false, observed: 'did not see the eye fly', error: 'threw nothing' };
    const p0 = thrown.position.clone();
    await waitMs(ctx, 1500);
    const p1 = thrown.position.clone();
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const me = bot.entity.position.floored();
    if (Math.hypot(dx, dz) < 0.4) return { ok: true, observed: 'the eye sank into the ground: the stronghold is right under here', data: { below: true, at: { x: me.x, z: me.z } } };
    // Compass words for the way it went (yaw-style angle: 0 south, going round west).
    const angle = (Math.atan2(-dx, dz) + 2 * Math.PI) % (2 * Math.PI);
    const way = COMPASS[Math.round(angle / (Math.PI / 4)) % 8] ?? 'away';
    const n = Math.hypot(dx, dz);
    const toward = { x: Math.round(me.x + (dx / n) * 200), z: Math.round(me.z + (dz / n) * 200) };
    return { ok: true, observed: `the eye flew ${way}: the stronghold lies that way (toward ${toward.x},${toward.z}); throw again farther on to see how far`, data: { way, toward } };
  },
});

export const fill = defineSkill({
  name: 'fill',
  description: 'fill {} — put eyes of ender into the frames of an End portal you can see (in a stronghold); when all twelve have one, it opens',
  argsSchema: z.object({}),
  talkOverable: false,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx) {
    const { bot } = ctx;
    const id = bot.registry.blocksByName.end_portal_frame?.id;
    if (id === undefined) return { ok: false, observed: 'no frames', error: 'no End portal frames in this game' };
    const frames = bot.findBlocks({ matching: id, maxDistance: 16, count: 12 }).map((p) => bot.blockAt(p)).filter((b): b is Block => b !== null);
    if (frames.length === 0) return { ok: false, observed: 'no End portal here', error: 'no End portal frames in sight (they are deep in a stronghold)' };
    const hasEye = (b: Block) => String(bot.blockAt(b.position)?.getProperties().eye) === 'true';
    const emptyAtFirst = frames.filter((b) => !hasEye(b)).length;
    // Each empty frame an eye, and a second go at any that didn't take.
    for (let pass = 0; pass < 2; pass++) {
      for (const f of frames.filter((b) => !hasEye(b))) {
        throwIfAborted(ctx.signal);
        const eyeItem = bot.inventory.items().find((i) => i.name === 'ender_eye');
        if (!eyeItem) break;
        try {
          await gotoNear(ctx, f.position, 3);
          await bot.equip(eyeItem, 'hand');
          await bot.lookAt(f.position.offset(0.5, 1, 0.5), true);
          await bot.activateBlock(f, new Vec3(0, 1, 0));
          for (let t = 0; t < 10 && !hasEye(f); t++) await waitMs(ctx, 100);
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          ctx.logger.debug({ module: 'skill', err: errMsg(err) }, 'eye not put in');
        }
      }
    }
    const portalId = bot.registry.blocksByName.end_portal?.id;
    const isOpen = () => portalId !== undefined && bot.findBlocks({ matching: portalId, maxDistance: 16, count: 1 }).length > 0;
    for (let t = 0; t < 20 && !isOpen() && frames.every(hasEye); t++) await waitMs(ctx, 100);
    const open = isOpen();
    const left = frames.filter((b) => !hasEye(b)).length;
    const put = emptyAtFirst - left;
    if (open) return { ok: true, observed: `put ${put} eyes in: the End portal is open (travel {to: end})`, data: { open: true } };
    return { ok: put > 0, observed: `put ${put} eyes in; ${left} frames still empty${countItem(bot, itemMatcher('ender_eye')) === 0 ? ' and no eyes left' : ''}`, ...(put > 0 ? {} : { error: 'no eyes went in' }), data: { open: false, left } };
  },
});
