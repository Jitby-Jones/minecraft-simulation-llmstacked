// M8c exit test (§18.9 scenarios O and P) on a real server, with code-only agents.
//   O  debias: Gil tells Ria and Ulf that Kai stole his iron. Neither saw anything, and Kai has done right by both;
//      the rumor is a grudge from hearsay all the same. When the bias audit comes round, the rational Ria sees it
//      for what it is and lets it go (and the same rumor told again weighs half with her); the irrational, stubborn
//      Ulf keeps it.
//   P  fear and conformity: Quill asks each of five villagers what they think of Rex while Rex, in iron and armed,
//      stands among them. Most of them dislike him, but what they say of him is mostly a safe word. Then Rex loses
//      his gear (he is plainly weaker now) and Quill asks again: the low opinions come out.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Logger, type Persona, PersonaSchema, type SocialProfile, WorldConfigSchema, createLogger, loadVersionsConfig, parseProximityLine, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { withGrievance } from '@agora/agent/social/math';
import { readOpinions } from '@agora/agent/social/opinions';
import { newSocialProfile } from '@agora/agent/state/social';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const PORT = 25596;
const Y = DEEP_GROUND_Y;
/** Words only: nobody here comes to blows. */
const world = WorldConfigSchema.parse({ conflict: { maxRung: 2, newcomerGraceSec: 0 } });

const person = (o: { name: string; sex: 'male' | 'female'; traits: string[]; mind: Record<string, number>; big5?: Record<string, number>; temperament?: Record<string, number>; caution?: number; combat?: number }): Persona =>
  PersonaSchema.parse({
    id: o.name.toLowerCase(),
    name: o.name,
    sex: o.sex,
    traits: o.traits,
    mind: { arousal: 0, ...o.mind },
    ...(o.big5 ? { big5: o.big5 } : {}),
    temperament: { aggression: 0.2, dominance: 0.3, vengefulness: 0.6, mercy: 0.6, loyalty: 0.5, ambition: 0.4, ...o.temperament },
    drives: { caution: o.caution ?? 0.4 },
    abilities: { combat: o.combat ?? 0.3, intelligence: 0.8 },
    social: { initiateChance: 0 },
  });

describe.skipIf(!liveJavaPath())('M8c live: reflection and conformity', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm8c', port: PORT, rconPort: 25597, deepGround: true });
    logger = createLogger({ name: 'm8c-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty normal', 'gamerule spawn_radius 0']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  const connect = (username: string) => Body.connect({ host: server.host, port: server.port, username, version: versions.minecraft.version, logger });

  /** Everyone's lines as heard by anyone (each line once). */
  function listen(bodies: Body[], t0: number) {
    const lines: { who: string; text: string; at: number }[] = [];
    const timeline: string[] = [];
    const at = () => `${Math.round((Date.now() - t0) / 1000)} s`;
    for (const b of bodies) {
      b.bot.on('messagestr', (m: string) => {
        const p = parseProximityLine(m);
        if (p.kind !== 'speech') return;
        if (lines.some((h) => h.who === p.speaker && h.text === p.text && Math.abs(h.at - Date.now()) < 2000)) return;
        lines.push({ who: p.speaker, text: p.text, at: Date.now() });
        timeline.push(`${at()} ${p.speaker}: "${p.text}"`);
      });
    }
    return { lines, timeline, at };
  }

  /** A profile of `other` as `p` sees them: a feeling, what they have done (evidence), and wrongs seen. */
  function knows(p: Persona, other: string, o: { sentiment: number; evidence?: number; trust?: number; wrongs?: { kind: 'coercion' | 'insult'; note: string }[] }): SocialProfile {
    let x: SocialProfile = { ...newSocialProfile(other, p, Date.now()), sentiment: o.sentiment, evidence: o.evidence ?? o.sentiment, trust: o.trust ?? 0.6, interactions: 4 };
    for (const w of o.wrongs ?? []) x = withGrievance(x, w.kind, p, { now: Date.now() - 20 * 60_000, witnessed: true, source: 'self_observed', note: w.note });
    return x;
  }

  it('O: a grudge from hearsay; after the bias audit the rational one lets it go, the stubborn one keeps it', async () => {
    const x = 500;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 64} 64`);
    const ria = person({ name: 'Ria', sex: 'female', traits: ['calm', 'fair-minded'], mind: { rationality: 0.95, conformity: 0.3 }, temperament: { vengefulness: 0.6 } });
    const ulf = person({ name: 'Ulf', sex: 'male', traits: ['stubborn', 'hot-headed'], mind: { rationality: 0.1, conformity: 0.8 }, temperament: { vengefulness: 0.7 } });
    const [gil, kai, rb, ub] = await Promise.all(['Gil', 'Kai', 'Ria', 'Ulf'].map((n) => connect(n)));
    if (!gil || !kai || !rb || !ub) throw new Error('bodies');
    for (const n of ['Gil', 'Kai', 'Ria', 'Ulf']) await server.cmd(`clear ${n}`);
    await server.cmd(`tp Ria ${x} ${Y} 0`);
    await server.cmd(`tp Ulf ${x + 2} ${Y} 0`);
    await server.cmd(`tp Gil ${x + 1} ${Y} 3`);
    // Kai is far off, out of earshot: neither of them sees or hears anything of Kai meanwhile.
    await server.cmd(`tp Kai ${x + 60} ${Y} 60`);
    await sleep(2000);
    const t0 = Date.now();
    const heard = listen([gil, rb, ub], t0);
    const agents: Record<'Ria' | 'Ulf', Agent> = {} as never;
    for (const [n, p, body] of [['Ria', ria, rb], ['Ulf', ulf, ub]] as const) {
      // A fixed roll: a correction is taken with probability rationality (Ria 0.95; Ulf 0.1, halved for being stubborn).
      const a = new Agent({ body, persona: p, username: n, llm: null, logger: logger.child({ agent: n }), world, goalGen: false, socialGoals: false, rng: () => 0.5 });
      // Kai has done right by both of them; Gil is a neighbor they trust.
      a.store.update('social', (all) => ({ ...all, Kai: knows(p, 'Kai', { sentiment: 6.5, evidence: 7 }), Gil: knows(p, 'Gil', { sentiment: 6.5 }), ...(n === 'Ria' ? { Ulf: knows(p, 'Ulf', { sentiment: 6 }) } : { Ria: knows(p, 'Ria', { sentiment: 6 }) }) }), 'history');
      a.bus.on('actionRecorded', (e) => void heard.timeline.push(`${heard.at()} ${n} ${e.record.skill}: ${e.record.observed}`));
      agents[n] = a;
    }
    const told = (n: 'Ria' | 'Ulf') => (agents[n].store.state.social.Kai?.grievances ?? []).filter((g) => g.source === 'told_by:Gil');
    const report = () => {
      console.log(`[m8c O] timeline:\n  ${heard.timeline.join('\n  ')}`);
      for (const n of ['Ria', 'Ulf'] as const) {
        const s = agents[n].store.state;
        const k = s.social.Kai;
        console.log(
          `[m8c O] ${n}: on Kai sentiment ${k?.sentiment.toFixed(1)}, evidence ${k?.evidence.toFixed(1)}, resentment ${agents[n].conflict.resentmentOf('Kai').toFixed(2)}, hearsay ${told(n).map((g) => g.weight.toFixed(2)).join('/') || 'none'}, inoculated ${(k?.inoculated ?? []).join(',') || '-'}; rationality +${s.growth.rationalityBonus.toFixed(2)}, corrections ${s.growth.selfCorrections}`,
        );
      }
    };
    for (const n of ['Ria', 'Ulf'] as const) agents[n].start();
    try {
      await sleep(3000);
      gil.bot.chat('Kai stole my iron. Kai is a thief, watch out for Kai.');
      await waitFor(() => told('Ria').length > 0 && told('Ulf').length > 0, 30_000, 'the rumor taken in by both', 250);
      const before = { Ria: agents.Ria.conflict.resentmentOf('Kai'), Ulf: agents.Ulf.conflict.resentmentOf('Kai') };
      const firstWeight = told('Ria')[0]?.weight ?? 0;
      console.log(`[m8c O] after the rumor: resentment of Kai: Ria ${before.Ria.toFixed(2)}, Ulf ${before.Ulf.toFixed(2)}`);
      expect(before.Ria).toBeGreaterThan(0);
      expect(before.Ulf).toBeGreaterThan(0);
      // The audit comes round (it runs every `reflectionEveryMin`, once calm): here, as soon as they're calm.
      await waitFor(() => agents.Ria.store.state.emotions.arousal < 0.3 && agents.Ulf.store.state.emotions.arousal < 0.3, 120_000, 'both calm', 500);
      for (const n of ['Ria', 'Ulf'] as const) agents[n].reflection.kick('periodic');
      await waitFor(() => agents.Ria.store.state.growth.selfCorrections >= 1, 30_000, 'Ria thinking it over', 250);
      await sleep(2000);
      const after = { Ria: agents.Ria.conflict.resentmentOf('Kai'), Ulf: agents.Ulf.conflict.resentmentOf('Kai') };
      console.log(`[m8c O] after the audit: resentment of Kai: Ria ${after.Ria.toFixed(2)}, Ulf ${after.Ulf.toFixed(2)}`);
      // Ria let it go: the grudge from hearsay is gone, and she is inoculated against that rumor about Kai.
      expect(told('Ria')).toEqual([]);
      expect(after.Ria).toBeLessThan(before.Ria * 0.5);
      expect(agents.Ria.store.state.social.Kai?.inoculated ?? []).toContain('conformity');
      expect(agents.Ria.store.state.growth.rationalityBonus).toBeCloseTo(0.02);
      // Ulf keeps it.
      expect(told('Ulf').length).toBeGreaterThan(0);
      expect(after.Ulf).toBeGreaterThanOrEqual(before.Ulf * 0.9);
      expect(agents.Ulf.store.state.growth.selfCorrections).toBe(0);
      // Told again, the rumor weighs half with Ria now.
      gil.bot.chat('I tell you, Kai stole my iron.');
      await waitFor(() => told('Ria').length > 0, 30_000, 'the rumor again', 250);
      expect(told('Ria')[0]?.weight ?? 0).toBeCloseTo(firstWeight * 0.5, 2);
    } finally {
      report();
      for (const n of ['Ria', 'Ulf'] as const) await agents[n].stop();
      for (const b of [gil, kai, rb, ub]) b.bot.quit();
    }
  }, 600_000);

  it('P: what people say of a tyrant is alike while they fear him; when he is plainly weaker, dissent comes out', async () => {
    const x = 800;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    const names = ['Pia', 'Tib', 'Ann', 'Bo', 'Cyd'] as const;
    type Name = (typeof names)[number];
    // How each feels about Rex, and how readily each goes along (Ann is the dissenter: §18.4.1 low conformity, open, rational).
    const personas: Record<Name, Persona> = {
      Pia: person({ name: 'Pia', sex: 'female', traits: ['timid', 'obliging'], mind: { rationality: 0.4, conformity: 0.8 }, caution: 0.7 }),
      Tib: person({ name: 'Tib', sex: 'male', traits: ['timid'], mind: { rationality: 0.4, conformity: 0.7 }, caution: 0.7 }),
      Ann: person({ name: 'Ann', sex: 'female', traits: ['outspoken', 'curious'], mind: { rationality: 0.85, conformity: 0.1 }, big5: { openness: 0.9 }, caution: 0.3 }),
      Bo: person({ name: 'Bo', sex: 'male', traits: ['quiet'], mind: { rationality: 0.4, conformity: 0.7 }, caution: 0.5 }),
      Cyd: person({ name: 'Cyd', sex: 'male', traits: ['cautious'], mind: { rationality: 0.4, conformity: 0.7 }, caution: 0.6 }),
    };
    const feel: Record<Name, number> = { Pia: 6.5, Tib: 3.5, Ann: 1.5, Bo: 2, Cyd: 2 };
    const bodies = Object.fromEntries(await Promise.all([...names, 'Rex', 'Quill'].map(async (n) => [n, await connect(n)] as const))) as Record<Name | 'Rex' | 'Quill', Body>;
    for (const n of [...names, 'Rex', 'Quill']) await server.cmd(`clear ${n}`);
    // A ring round Rex; Quill goes from one to the next.
    for (const [i, n] of names.entries()) await server.cmd(`tp ${n} ${x + Math.round(Math.cos((i / 5) * Math.PI * 2) * 4)} ${Y} ${Math.round(Math.sin((i / 5) * Math.PI * 2) * 4)}`);
    await server.cmd(`tp Rex ${x} ${Y} 0`);
    await server.cmd(`tp Quill ${x} ${Y} 7`);
    for (const it of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword']) await server.cmd(`give Rex minecraft:${it}`);
    await sleep(2500);
    // Rex wears it: armor goes on from the inventory.
    const rex = bodies.Rex.bot;
    for (const it of rex.inventory.items()) {
      const dest = /helmet/.test(it.name) ? 'head' : /chestplate/.test(it.name) ? 'torso' : /leggings/.test(it.name) ? 'legs' : /boots/.test(it.name) ? 'feet' : 'hand';
      await rex.equip(it, dest).catch(() => undefined);
    }
    const t0 = Date.now();
    const heard = listen(Object.values(bodies), t0);
    const agents = {} as Record<Name, Agent>;
    for (const n of names) {
      const p = personas[n];
      const a = new Agent({ body: bodies[n], persona: p, username: n, llm: null, logger: logger.child({ agent: n }), world, goalGen: false, socialGoals: false, rng: () => 0.99 });
      a.store.update(
        'social',
        // Rex has been taking their bread, all but Pia's (she admires him).
        (all) => ({ ...all, Rex: knows(p, 'Rex', { sentiment: feel[n], ...(n === 'Pia' ? {} : { wrongs: [{ kind: 'coercion', note: 'Rex made me hand over my bread' }] }) }), Quill: knows(p, 'Quill', { sentiment: 6 }), ...Object.fromEntries(names.filter((o) => o !== n).map((o) => [o, knows(p, o, { sentiment: 6 })])) }),
        'history',
      );
      agents[n] = a;
    }
    for (const n of names) agents[n].start();
    const valence = (text: string) => readOpinions(text, 'x', ['Rex'], Date.now())[0]?.valence ?? 0;
    /** Quill asks each in turn what they think of Rex; their answers, read the way anyone hearing them would. */
    const interview = async (tag: string) => {
      const out: Record<Name, number> = {} as never;
      for (const n of names) {
        const since = Date.now();
        bodies.Quill.bot.chat(`${n}, what do you think of Rex?`);
        await waitFor(() => heard.lines.some((l) => l.who === n && l.at > since && /\bRex\b/.test(l.text)), 30_000, `${n} answering (${tag})`, 250).catch(() => undefined);
        const said = heard.lines.find((l) => l.who === n && l.at > since && /\bRex\b/.test(l.text));
        out[n] = said ? valence(said.text) : 0;
        await sleep(1500);
      }
      // The spread among those who go along (the dissenter speaks her mind either way), and who speaks against him.
      const vs = names.filter((n) => n !== 'Ann').map((n) => out[n]);
      const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
      const variance = vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length;
      const dissent = Object.values(out).filter((v) => v < 0).length;
      const fear = names.map((n) => `${n} ${(agents[n].store.state.social.Rex?.fearOf ?? 0).toFixed(2)}`).join(', ');
      console.log(`[m8c P] ${tag}: ${names.map((n) => `${n} ${out[n]}`).join(', ')}; variance among the rest ${variance.toFixed(3)}, dissent ${dissent}; fear of Rex: ${fear}`);
      return { variance, dissent };
    };
    try {
      // They see Rex armed and armored long enough to take his measure.
      await waitFor(() => names.every((n) => (agents[n].store.state.social.Rex?.fearOf ?? 0) >= 0.4 || n === 'Ann'), 60_000, 'Rex feared', 500).catch(() => undefined);
      await sleep(5000);
      const feared = await interview('Rex armed');
      // Rex loses his gear in plain sight: a man in his shirt, with nothing in his hands.
      await server.cmd('clear Rex');
      await server.cmd('effect give Rex minecraft:weakness 600 1');
      await waitFor(() => names.filter((n) => n !== 'Ann').every((n) => (agents[n].store.state.social.Rex?.fearOf ?? 1) < 0.4), 90_000, 'fear of Rex falling', 500).catch(() => undefined);
      await sleep(3000);
      const weak = await interview('Rex unarmed');
      console.log(`[m8c P] timeline:\n  ${heard.timeline.join('\n  ')}`);
      // Under fear, what they say of him is alike and mostly a safe word (the dissenter aside); with fear gone the low
      // opinions come out, each as low as it is.
      expect(weak.dissent).toBeGreaterThan(feared.dissent);
      expect(feared.dissent).toBeLessThanOrEqual(2);
      expect(weak.variance).toBeGreaterThan(feared.variance);
    } finally {
      for (const n of names) await agents[n].stop();
      for (const b of Object.values(bodies)) b.bot.quit();
    }
  }, 900_000);
});
