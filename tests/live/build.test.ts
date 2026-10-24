// Buildings live (owner request, 2026-10-24): a builder puts up designs from the repertoire on a real Paper server.
// The plains cottage on flat ground, block for block as its blueprint has it (doors facing in, stairs up the roof),
// scaffolding taken down after; a hut on a site with a mound and a tree in the way, cleared and levelled first; one
// of the game's own village houses; and with materials short, a building half done that says what it lacks, and a
// second go that finishes it in the same place. The site finder keeps out of water.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BuildProject, createLogger, loadEnv, loadModelsConfig, loadVersionsConfig, sleep } from '@agora/shared';
import { startLlm } from '@agora/llm';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { findBuildSite, inWorld, sameBlock, type Site } from '@agora/agent/body/skills/construct';
import type { ProjectBook } from '@agora/agent/body/skills/types';
import type { Blueprint } from '@agora/agent/building/compile';
import { billOf } from '@agora/agent/building/materials';
import { describeDesign, designBuilding } from '@agora/agent/building/architect';
import { Repertoire, setSharedRepertoire } from '@agora/agent/building/repertoire';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
loadEnv();
const key = process.env.NANOGPT_API_KEY?.trim();
/** The architect's own design needs the real models (and spends subscription quota): AGORA_LIVE_LLM=1. */
const realModels = Boolean(key) && process.env.AGORA_LIVE_LLM === '1';
/** The ground's top layer: grass at DEEP_GROUND_Y - 1. */
const G = DEEP_GROUND_Y - 1;

describe.skipIf(!liveJavaPath())('Buildings live', () => {
  let server: LiveServer;
  let pip: Body;
  let rep: Repertoire;
  let zoneIndex = 0;
  const projects: BuildProject[] = [];
  const book: ProjectBook = {
    get: (d) => projects.find((p) => p.design === d && p.doneAt === null) ?? null,
    set: (p) => {
      const i = projects.findIndex((x) => x.design === p.design && x.startedAt === p.startedAt);
      if (i >= 0) projects[i] = p;
      else projects.push(p);
    },
    taken: () => projects.map((p) => ({ x0: p.origin.x, z0: p.origin.z, x1: p.origin.x + p.size.x - 1, z1: p.origin.z + p.size.z - 1 })),
  };

  async function zone(): Promise<{ x: number; z: number }> {
    zoneIndex++;
    const x = zoneIndex * 300;
    const z = 0;
    await server.cmd(`forceload add ${x - 32} ${z - 32} ${x + 32} ${z + 32}`);
    await server.cmd(`tp Pip ${x} ${DEEP_GROUND_Y} ${z}`);
    await waitFor(() => pip.bot.entity.position.distanceTo(new Vec3(x, DEEP_GROUND_Y, z)) < 2 && pip.bot.blockAt(new Vec3(x, G, z)) !== null, 15000, 'zone loaded');
    await sleep(1000);
    await server.cmd('clear Pip');
    return { x, z };
  }

  /** Everything the blueprint takes, and dirt to stand on, and tools to dig with. */
  async function give(bp: Blueprint, share = 1): Promise<void> {
    for (const [item, n] of billOf(bp)) {
      const k = Math.ceil(n * share);
      if (k > 0) await server.cmd(`give Pip minecraft:${item} ${k}`);
    }
    await server.cmd('give Pip minecraft:dirt 48');
    for (const t of ['stone_pickaxe', 'stone_shovel', 'stone_axe']) await server.cmd(`give Pip minecraft:${t} 1`);
    await sleep(800);
  }

  /** How much of the blueprint stands in the world as it should. */
  function standing(bp: Blueprint, site: Site): { ok: number; total: number; wrong: string[] } {
    const plan = inWorld(bp, site);
    const blocks = plan.blocks.filter((b) => !b.second);
    const wrong = blocks.filter((b) => !sameBlock(pip.bot.blockAt(b.pos), b.state)).map((b) => `${b.state.name}@${b.pos.toString()}=${pip.bot.blockAt(b.pos)?.name ?? '?'}`);
    return { ok: blocks.length - wrong.length, total: blocks.length, wrong };
  }

  const note = (line: string) => fs.appendFileSync(path.join(server.dir, '..', 'logs', 'progress.txt'), `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  const build = async (args: Record<string, unknown>, timeoutMs = 12 * 60_000) => {
    note(`build ${JSON.stringify(args)}`);
    // Where the bot stands as it and the server see it, and what it is doing with its hands (a dig the server
    // refuses all the same shows here).
    const me = pip.bot.entity.position;
    note(`  at ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)}; server: ${await server.cmd('data get entity Pip Pos')}; holding ${pip.bot.heldItem?.name ?? 'nothing'}; using ${String(pip.bot.usingHeldItem)}; sneaking ${String(pip.bot.getControlState('sneak'))}; digging ${pip.bot.targetDigBlock?.name ?? 'nothing'}`);
    const r = await pip.run('build', args, { signal: AbortSignal.timeout(timeoutMs), projects: book, progress: (p) => note(`  ${p}`) });
    note(`  -> ${JSON.stringify({ ok: r.ok, observed: r.observed, error: r.error })}`);
    console.log(`[build] ${JSON.stringify({ ok: r.ok, observed: r.observed, error: r.error })}`);
    return r;
  };

  beforeAll(async () => {
    server = await startLiveServer({ name: 'build', deepGround: true });
    await server.cmd('gamerule advance_time false');
    await server.cmd('gamerule advance_weather false');
    await server.cmd('weather clear');
    await server.cmd('time set 1000');
    rep = new Repertoire({ serverDir: server.dir, madeDir: path.join(server.dir, '..', 'made') }).load();
    setSharedRepertoire(rep);
    const logger = createLogger({ name: 'build-live', console: false, level: 'debug', logDir: path.join(server.dir, '..', 'logs') });
    pip = await Body.connect({ host: server.host, port: server.port, username: 'Pip', version: versions.minecraft.version, logger, chat: { minIntervalMs: 300 } }, { caution: () => 0.3 });
    await sleep(1000);
  }, 300_000);

  afterAll(async () => {
    setSharedRepertoire(null);
    await pip?.disconnect();
    await server?.stop();
  });

  it('builds the plains cottage on flat ground block for block, and takes its scaffolding down', async () => {
    const o = await zone();
    const b = rep.find('plains-cottage');
    if (!b) throw new Error('no plains cottage');
    const bp = await rep.blueprint(b);
    await give(bp);
    const origin = { x: o.x + 4, y: G, z: o.z + 4 };
    const r = await build({ design: 'plains cottage', ...origin, facing: 'west' });
    expect(r.ok).toBe(true);
    const site: Site = { origin: new Vec3(origin.x, origin.y, origin.z), turn: (4 + ['north', 'east', 'south', 'west'].indexOf('west') - ['north', 'east', 'south', 'west'].indexOf(bp.entrance?.out ?? 'south')) % 4 };
    const s = standing(bp, site);
    console.log(`[cottage] ${s.ok}/${s.total} as designed; wrong: ${s.wrong.slice(0, 12).join(' ')}`);
    expect(s.ok / s.total).toBeGreaterThan(0.97);
    // The door faces into the house from the west; nothing of ours left standing about outside it.
    const plan = inWorld(bp, site);
    expect(plan.entrance?.out).toBe('west');
    const door = plan.entrance ? pip.bot.blockAt(plan.entrance.pos) : null;
    expect(door?.name).toBe('oak_door');
    let leftovers = 0;
    for (let x = origin.x - 4; x <= origin.x + bp.size.x + 4; x++) {
      for (let z = origin.z - 4; z <= origin.z + bp.size.z + 4; z++) {
        for (let y = G + 1; y <= G + 10; y++) if (pip.bot.blockAt(new Vec3(x, y, z))?.name === 'dirt') leftovers++;
      }
    }
    expect(leftovers).toBe(0);
  }, 15 * 60_000);

  it('clears a mound and fells a tree to build a hut where it was asked, then finds itself a flat site away from water', async () => {
    const o = await zone();
    const b = rep.find('starter-hut');
    if (!b) throw new Error('no starter hut');
    const bp = await rep.blueprint(b);
    const at = { x: o.x + 6, z: o.z + 6 };
    // A mound of earth and stone over half the site, and an oak in the middle of it.
    await server.cmd(`fill ${at.x} ${G + 1} ${at.z} ${at.x + 3} ${G + 2} ${at.z + 4} minecraft:dirt`);
    await server.cmd(`fill ${at.x + 1} ${G + 1} ${at.z + 1} ${at.x + 2} ${G + 1} ${at.z + 2} minecraft:stone`);
    await server.cmd(`place feature minecraft:oak ${at.x + 3} ${G + 3} ${at.z + 2}`);
    // A dip on the other side.
    await server.cmd(`fill ${at.x + 4} ${G} ${at.z + 4} ${at.x + 4} ${G - 1} ${at.z + 5} minecraft:air`);
    await sleep(1000);
    await give(bp);
    const r = await build({ design: 'starter-hut', x: at.x, y: G, z: at.z, facing: 'south' });
    expect(r.ok).toBe(true);
    const s = standing(bp, { origin: new Vec3(at.x, G, at.z), turn: 0 });
    console.log(`[hut] ${s.ok}/${s.total} as designed; wrong: ${s.wrong.slice(0, 12).join(' ')}`);
    expect(s.ok / s.total).toBeGreaterThan(0.97);
    // Nothing of the mound or the tree left inside it.
    for (let x = at.x + 1; x < at.x + 4; x++) for (let z = at.z + 1; z < at.z + 4; z++) expect(pip.bot.blockAt(new Vec3(x, G + 1, z))?.name).toMatch(/air|bed|chest|crafting_table|torch/);
    // A pond next to home: a site for the farmhouse is found clear of it.
    await server.cmd(`fill ${o.x - 14} ${G} ${o.z - 6} ${o.x - 4} ${G} ${o.z + 6} minecraft:water`);
    await sleep(800);
    const site = findBuildSite(pip.bot, { x: 13, z: 13 }, new Vec3(o.x - 8, G + 1, o.z), { avoid: book.taken() });
    expect(site).not.toBeNull();
    if (site) {
      for (let x = site.origin.x; x < site.origin.x + 13; x++) for (let z = site.origin.z; z < site.origin.z + 13; z++) expect(pip.bot.blockAt(new Vec3(x, G, z))?.name).not.toBe('water');
      // Clear of the hut.
      const hut = book.taken()[0];
      if (hut) expect(site.origin.x > hut.x1 + 3 || site.origin.x + 12 < hut.x0 - 3 || site.origin.z > hut.z1 + 3 || site.origin.z + 12 < hut.z0 - 3).toBe(true);
    }
  }, 15 * 60_000);

  it("builds one of the game's own village houses from the server's jar", async () => {
    const o = await zone();
    const b = rep.find('vanilla:plains_small_house_1');
    if (!b) throw new Error('no vanilla house');
    const bp = await rep.blueprint(b);
    await give(bp);
    const origin = { x: o.x + 4, y: G, z: o.z + 4 };
    const r = await build({ design: 'vanilla:plains_small_house_1', ...origin, facing: 'south' });
    expect(r.ok).toBe(true);
    const turn = (4 + 2 - ['north', 'east', 'south', 'west'].indexOf(bp.entrance?.out ?? 'south')) % 4;
    const s = standing(bp, { origin: new Vec3(origin.x, origin.y, origin.z), turn });
    console.log(`[vanilla] ${s.ok}/${s.total} as designed; wrong: ${s.wrong.slice(0, 12).join(' ')}`);
    expect(s.ok / s.total).toBeGreaterThan(0.95);
  }, 15 * 60_000);

  it.skipIf(!realModels)("builds the architect's own design, drawn by the real model with the repertoire as its framework", async () => {
    const o = await zone();
    const cfg = loadModelsConfig();
    const logger = createLogger({ name: 'build-live-architect', console: false, level: 'debug', logDir: path.join(server.dir, '..', 'logs') });
    const rt = await startLlm({ apiKey: key ?? '', config: cfg, logger, background: false, pollUsage: false });
    try {
      const r = await designBuilding(
        {
          purpose: 'a cosy house for me and Wren, with room for a child later',
          by: 'Mira',
          persona: 'Mira: curious, warm, a little stubborn; values family, beauty',
          biome: 'plains',
          raw: { sand: 0.4, raw_iron: 12, white_wool: 1.5, leather: 2 },
          materials: 'trees about: oak, birch; stone underfoot (cobblestone with a pickaxe); sand near; carrying 20 logs, 30 cobblestone',
          village: ['plains cottage', 'storehouse'],
          maxEffort: 120,
          helpers: [{ name: 'Bram', does: 'miner' }],
        },
        { llm: rt.client, repertoire: rep, logger, models: cfg.architect.models, timeoutMs: cfg.architect.timeoutMs },
      );
      note(`[architect] ${r.how} ${r.building.id}: ${describeDesign(r)}`);
      console.log(`[architect] ${r.how} ${r.building.id}: ${describeDesign(r)}`);
      expect(r.how).not.toBe('repertoire');
      // Built as drawn: what it takes is given, the builder puts it up.
      const bp = await rep.blueprint(r.building);
      await give(bp);
      const origin = { x: o.x + 4, y: G, z: o.z + 4 };
      const b = await build({ design: r.building.id, ...origin, facing: 'south' }, 20 * 60_000);
      expect(b.ok).toBe(true);
      const turn = (4 + 2 - ['north', 'east', 'south', 'west'].indexOf(bp.entrance?.out ?? 'south')) % 4;
      const st = standing(bp, { origin: new Vec3(origin.x, origin.y, origin.z), turn });
      note(`[architect] ${st.ok}/${st.total} as designed; wrong: ${st.wrong.slice(0, 12).join(' ')}`);
      console.log(`[architect] ${st.ok}/${st.total} as designed; wrong: ${st.wrong.slice(0, 12).join(' ')}`);
      expect(st.ok / st.total).toBeGreaterThan(0.95);
    } finally {
      rt.stop();
    }
  }, 30 * 60_000);

  it('half the materials: half a building and what it lacks; the rest: finished where it was begun', async () => {
    const o = await zone();
    const b = rep.find('snowy-cottage');
    if (!b) throw new Error('no snowy cottage');
    const bp = await rep.blueprint(b);
    await give(bp, 0.5);
    const r1 = await build({ design: 'snowy cottage' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/still need/);
    const p = projects.find((x) => x.design === 'snowy-cottage');
    expect(p?.doneAt).toBeNull();
    expect(Object.keys(p?.missing ?? {}).length).toBeGreaterThan(0);
    const firstOrigin = p ? { ...p.origin } : null;
    await give(bp, 0.6);
    const r2 = await build({ design: 'snowy cottage' });
    expect(r2.ok).toBe(true);
    const done = projects.find((x) => x.design === 'snowy-cottage' && x.doneAt !== null);
    expect(done?.origin).toEqual(firstOrigin);
    void o;
  }, 25 * 60_000);
});
