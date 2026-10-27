// The long runs (owner request, 2026-10-24): agents on the real models in an ordinary world from a seed, given their
// tasks in words and nothing else; how to do them is theirs to work out. Code outside them (goals.ts) watches the
// world for each task's end. Variations by seed, difficulty and who is playing.
//   AGORA_LONGRUN=solo  one agent: 12 diamonds, the Nether, a full set of iron armor, a cow farm, a house, an
//                       enchanting table, a renewable source of food.
//   AGORA_LONGRUN=duo   a woman and a man: a house, a romantic relationship, a renewable source of food, two sets of
//                       iron armor and iron tools.
//   AGORA_LONGRUN_SEED (world seed), AGORA_LONGRUN_MIN (time limit, minutes), AGORA_LONGRUN_DIFFICULTY (easy|normal),
//   AGORA_LONGRUN_PORT (the server's port, RCON on the next; for more than one run of a variant at once).
// Progress goes to data/live-test/longrun-<variant>-<seed>.json as it happens. Spends real subscription quota: only with
// NANOGPT_API_KEY set and AGORA_LIVE_LLM=1.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Logger, PersonaSchema, WorldConfigSchema, createLogger, loadEnv, loadModelsConfig, loadVersionsConfig, repoRoot, sleep } from '@agora/shared';
import { type LlmRuntime, loadBenchFile, startLlm } from '@agora/llm';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { Vec3 } from '@agora/agent/body/bot';
import { type LiveServer, liveJavaPath, startLiveServer } from './harness';
import { CROPS, IRON_ARMOR, IRON_TOOLS, blockPositions, cowFarm, doorPositions, hasAll, house, isBabyAnimal, owned, placedNear } from './goals';

loadEnv();
const key = process.env.NANOGPT_API_KEY?.trim();
const withModel = Boolean(key) && process.env.AGORA_LIVE_LLM === '1';
const variant = process.env.AGORA_LONGRUN === 'solo' || process.env.AGORA_LONGRUN === 'duo' ? process.env.AGORA_LONGRUN : null;
const seed = process.env.AGORA_LONGRUN_SEED ?? 'agora-longrun-1';
const minutes = Number(process.env.AGORA_LONGRUN_MIN ?? 240);
const difficulty = process.env.AGORA_LONGRUN_DIFFICULTY ?? 'easy';
const versions = loadVersionsConfig();

const SOLO_TASKS = ['Obtain 12 diamonds.', 'Go to the Nether.', 'Make a full set of iron armor.', 'Make a cow farm.', 'Make a house.', 'Make an enchanting table.', 'Secure a renewable source of food.'];
const DUO_TASKS = ['Make a house.', 'Form a romantic relationship.', 'Secure a renewable source of food.', 'Make 2 sets of iron armor and iron tools (one for each of you).'];

interface Met {
  at: number;
  how: string;
}

describe.skipIf(!liveJavaPath() || !withModel || !variant)('live: the long run', () => {
  let server: LiveServer | null = null;
  const name = `longrun-${variant ?? 'none'}-${seed}`;
  const outFile = path.join(repoRoot(), 'data', 'live-test', `${name}.json`);
  const packetFile = path.join(repoRoot(), 'data', 'live-test', `${name}-packets.jsonl`);
  const logger: Logger = createLogger({ name, logDir: path.join(repoRoot(), 'data', 'live-test', `${name}-agents`), console: process.env.AGORA_DEBUG === '1' });

  afterAll(async () => {
    await server?.stop();
  });

  it(
    `${variant ?? ''}: seed ${seed}, ${difficulty}, up to ${minutes} min`,
    async () => {
      // Ports by variant, so the two can run side by side (AGORA_LONGRUN_PORT for more at once).
      const port = Number(process.env.AGORA_LONGRUN_PORT ?? (variant === 'duo' ? 25652 : 25650));
      server = await startLiveServer({ name, port, rconPort: port + 1, flat: false, monsters: true, props: { 'level-seed': seed, 'spawn-protection': '0', 'view-distance': '10', 'simulation-distance': '10' } });
      const srv = server;
      await srv.cmd(`difficulty ${difficulty}`);
      const rt: LlmRuntime = await startLlm({ apiKey: key ?? '', config: loadModelsConfig(), logger, bench: loadBenchFile(path.join(repoRoot(), 'config', 'model-bench.json'), logger), background: false, pollUsage: false });
      let calls = 0;
      const call = rt.client.call.bind(rt.client);
      rt.client.call = ((o: Parameters<typeof call>[0]) => {
        calls++;
        return call(o);
      }) as typeof rt.client.call;
      const people =
        variant === 'solo'
          ? [{ name: 'Ada', sex: 'female' as const, traits: ['practical', 'determined', 'curious'] }]
          : [
              { name: 'Ada', sex: 'female' as const, traits: ['warm', 'practical', 'curious'] },
              { name: 'Bram', sex: 'male' as const, traits: ['easygoing', 'hardworking', 'friendly'] },
            ];
      const bodies: Body[] = [];
      const agents: Agent[] = [];
      fs.rmSync(packetFile, { force: true });
      // Each one's lines carry its name (two in one log could not be told apart).
      const logOf = (name: string) => logger.child({ persona: name });
      for (const p of people) {
        const body = await Body.connect({ host: srv.host, port: srv.port, username: p.name, version: versions.minecraft.version, logger: logOf(p.name) });
        bodies.push(body);
      }
      await sleep(4000);
      const first = bodies[0] as Body;
      // What was there before anyone did anything (a village's doors and fields don't count).
      const before = { doors: doorPositions(first.bot), tables: blockPositions(first.bot, 'enchanting_table') };
      for (const [i, p] of people.entries()) {
        const body = bodies[i] as Body;
        const agent = new Agent({
          body,
          persona: PersonaSchema.parse({ name: p.name, sex: p.sex, traits: p.traits, abilities: { intelligence: 0.75 }, ...(variant === 'solo' ? { social: { initiateChance: 0 } } : {}) }),
          username: p.name,
          llm: rt.client,
          logger: logOf(p.name),
          world: WorldConfigSchema.parse({}),
          goalGen: true,
          socialGoals: variant === 'duo',
        });
        agents.push(agent);
        // What the mind saw at each of its own decisions, to read a fatal choice from the inside: the packet and the
        // reply, one line each (beside the report; data/ is not kept in git).
        agent.bus.on('decision', (e) => {
          const ex = agent.cc.lastExchange;
          if (e.decision.source !== 'llm' || !ex) return;
          const line = { at: ex.at, who: p.name, reason: ex.reason, packet: ex.packet, reply: ex.replies.at(-1)?.text ?? '' };
          fs.appendFile(packetFile, `${JSON.stringify(line)}\n`, () => undefined);
        });
      }
      for (const a of agents) a.start();
      const tasks = variant === 'solo' ? SOLO_TASKS : DUO_TASKS;
      for (const a of agents) for (const t of tasks) a.giveTask(t, 'the operator');

      const t0 = Date.now();
      const met: Record<string, Met> = {};
      const mark = (k: string, how: string) => {
        if (met[k]) return;
        met[k] = { at: Math.round((Date.now() - t0) / 1000), how };
        logger.info({ test: name, met: k, how, afterMin: Math.round((Date.now() - t0) / 60_000) }, 'task end seen');
      };
      const diamonds = new Map<string, { last: number; gained: number }>();
      const babies = new Set<number>();
      for (const b of bodies) {
        b.bot.on('entitySpawn', (e) => {
          if (isBabyAnimal(b.bot, e) && e.position.distanceTo(b.bot.entity.position) <= 24) babies.add(e.id);
        });
      }
      // Crops sown by the agents themselves: a crop come up beside one of them while its hands were at a sowing or a
      // harvest. Crops it only walked past (a village's fields, found after the start) were counted as sown before:
      // a duo "met" renewable food at 8 minutes having sown nothing.
      const sown = new Set<string>();
      for (const [i, b] of bodies.entries()) {
        b.bot.on('blockUpdate', (old, now) => {
          if (!now || !CROPS.has(now.name) || (old && CROPS.has(old.name))) return;
          const skill = agents[i]?.store.state.option?.skill;
          if ((skill !== 'use' && skill !== 'harvest') || now.position.distanceTo(b.bot.entity.position) > 6) return;
          sown.add(now.position.toString());
        });
      }
      const goalsFor = variant === 'solo' ? ['diamonds', 'nether', 'ironArmor', 'cowFarm', 'house', 'enchantingTable', 'renewableFood'] : ['house', 'romance', 'renewableFood', 'ironSets'];
      const check = () => {
        for (const [i, b] of bodies.entries()) {
          const who = people[i]?.name ?? '?';
          const bot = b.bot;
          if (!bot.entity) continue;
          const d = owned(bot).get('diamond') ?? 0;
          const was = diamonds.get(who) ?? { last: 0, gained: 0 };
          diamonds.set(who, { last: d, gained: was.gained + Math.max(0, d - was.last) });
          if ((diamonds.get(who)?.gained ?? 0) >= 12) mark('diamonds', `${who} came by 12 diamonds`);
          if (/nether/.test(String(bot.game.dimension))) mark('nether', `${who} is in the Nether`);
          if (hasAll(bot, IRON_ARMOR)) mark('ironArmor', `${who} has a full set of iron armor`);
          const farm = cowFarm(bot);
          if (farm) mark('cowFarm', `${farm.cows} cows penned at ${farm.at.toString()}`);
          const h = house(bot, before.doors, (p) => bodies.some((x) => x.placed.has(`${p.x},${p.y},${p.z}`)));
          if (h) mark('house', `a roofed room of ${h.room} cells behind the door at ${h.door.toString()}`);
          const table = (owned(bot).get('enchanting_table') ?? 0) > 0 ? 'in hand' : placedNear(bot, 'enchanting_table', before.tables)?.toString();
          if (table) mark('enchantingTable', `${who}'s enchanting table, ${table}`);
          const crops = [...sown].filter((k) => {
            const [x, y, z] = k.replace(/[()]/g, '').split(',').map(Number) as [number, number, number];
            const at = bot.blockAt(new Vec3(x, y, z));
            return at !== null && CROPS.has(at.name);
          }).length;
          if (crops >= 6) mark('renewableFood', `${crops} crops sown by the agents, growing`);
          if (babies.size > 0) mark('renewableFood', `animals bred (${babies.size} young)`);
        }
        if (variant === 'duo') {
          const [a, b] = agents;
          if (a && b && (a.store.state.family.partner === b.name || b.store.state.family.partner === a.name)) mark('romance', `${a.name} and ${b.name} are partners`);
          const sets = bodies.filter((b2) => hasAll(b2.bot, [...IRON_ARMOR, ...IRON_TOOLS])).length;
          if (sets >= 2) mark('ironSets', 'both have full iron armor and iron tools');
        }
      };
      // The worker's heap, minute by minute: a duo's ran out of memory at 20 minutes (2 GB) where solos sat at 260 MB.
      const heap: string[] = [];
      const report = (final = false) => {
        const mb = Math.round(process.memoryUsage().heapUsed / 1e6);
        const at = Math.round((Date.now() - t0) / 60_000);
        if (heap.at(-1)?.split('m ')[0] !== String(at)) heap.push(`${at}m ${mb}MB`);
        const out = {
          name,
          seed,
          difficulty,
          final,
          elapsedMin: at,
          llmCalls: calls,
          heapMB: mb,
          heap: heap.slice(-240),
          met,
          missing: goalsFor.filter((g) => !met[g]),
          diamonds: Object.fromEntries(diamonds),
          agents: agents.map((a, i) => {
            const s = a.store.state;
            const bot = bodies[i]?.bot;
            return {
              name: a.name,
              dead: a.isDead,
              pos: s.self.pos,
              dimension: s.self.dimension,
              health: Math.round(s.self.health),
              food: s.self.food,
              carrying: s.self.inventory.map((x) => `${x.qty} ${x.item}`).join(', '),
              armor: s.self.armor,
              doing: s.option ? `${s.option.option} ${s.option.skill ?? ''} ${JSON.stringify(s.option.args ?? {})} ${s.option.status}` : null,
              plan: s.goals.plan ? `${s.goals.plan.aim}: ${s.goals.plan.steps.map((x) => `${x.text} [${x.status}]`).join('; ')}` : null,
              tasks: (s.goals.tasks ?? []).map((t) => `${t.text} [${t.status}${t.note ? `: ${t.note}` : ''}]`),
              thoughts: s.mind.thoughts.slice(-3).map((t) => t.text),
              lessons: (s.knowledge.lessons ?? []).map((l) => l.text),
              recent: s.actionLog.slice(-6).map((r) => `${r.skill} ${JSON.stringify(r.args)}: ${r.ok ? 'ok' : `FAILED ${r.error ?? ''}`}`),
              // How each sees the others: what a romance grows from (§19.2).
              others: Object.values(s.social).map((p) => `${p.name}: liking ${Math.round(p.sentiment)}, takes them for ${p.perceivedSex}, interest ${p.romanticInterest.toFixed(2)}, ${p.relationship}`),
              ...(bot ? { time: bot.time.timeOfDay } : {}),
            };
          }),
        };
        fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
        return out;
      };
      let lastReport = 0;
      // The heap past 1 GB: what each agent was doing then, once a minute (the spikes came between two minute readings).
      let heapLoggedAt = 0;
      const heapWatch = setInterval(() => {
        const mem = process.memoryUsage();
        if (mem.heapUsed < 1e9 || Date.now() - heapLoggedAt < 60_000) return;
        heapLoggedAt = Date.now();
        const doing = agents.map((a, i) => {
          const bot = bodies[i]?.bot;
          const o = a.store.state.option;
          const pf = bot?.pathfinder as unknown as { isMoving?: () => boolean; isMining?: () => boolean; goal?: object | null } | undefined;
          return {
            name: a.name,
            doing: o ? `${o.option} ${o.skill ?? ''} ${JSON.stringify(o.args ?? {})} ${o.status}` : null,
            moving: pf?.isMoving?.() ?? null,
            mining: pf?.isMining?.() ?? null,
            goal: pf?.goal ? pf.goal.constructor.name : null,
            entities: bot ? Object.keys(bot.entities).length : null,
            pos: a.store.state.self.pos,
          };
        });
        logger.warn({ test: name, heapMB: Math.round(mem.heapUsed / 1e6), rssMB: Math.round(mem.rss / 1e6), doing }, 'heap past 1 GB');
      }, 2000);
      heapWatch.unref();
      try {
        while (Date.now() - t0 < minutes * 60_000) {
          check();
          if (Date.now() - lastReport > 30_000) {
            report();
            lastReport = Date.now();
          }
          if (goalsFor.every((g) => met[g])) break;
          if (agents.every((a) => a.isDead)) break;
          await sleep(5000);
        }
      } finally {
        clearInterval(heapWatch);
        const r = report(true);
        logger.info({ test: name, met: r.met, missing: r.missing, calls }, 'the long run is over');
        for (const a of agents) await a.stop();
        for (const b of bodies) await b.disconnect();
      }
      expect(goalsFor.filter((g) => !met[g])).toEqual([]);
    },
    (minutes + 15) * 60_000,
  );
});
