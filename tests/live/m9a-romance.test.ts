// M9a exit test (§19.8 scenarios R, S and V) on a real server, with code-only agents.
//   R  courtship: Ned and Ivy, neighbors who get on, each drawn to the other's sex, go from a first hello (where
//      each says who they are) through a crush and courting (compliments returned) to a proposal, said yes to:
//      partners. Every line said is PG.
//   S  rejection: Max courts Zoe, who isn't drawn to men. She turns him down each time; he tries again within the
//      soft cap, sadder each time, until code leaves her be for the week (the harassment lock); having no attempts
//      left, the disagreeable Max turns it into resentment.
//   V  jealousy: Ned and Ivy are partners. Max, who has a crush on Ivy, courts her in Ned's hearing and stays by her:
//      Ned's envy and anger rise, and he holds it against Max.
// The rolls are fixed per agent (each agent's rng), so each scenario takes the same branch of the §19.10 tables.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Logger, type Persona, PersonaSchema, type SocialProfile, WorldConfigSchema, createLogger, loadVersionsConfig, parseProximityLine, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { NOT_PG_RE, persistenceCap } from '@agora/agent/social/romance';
import { isAdvance } from '@agora/agent/social/romanceWatch';
import { newSocialProfile } from '@agora/agent/state/social';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const PORT = 25598;
const Y = DEEP_GROUND_Y;
/** Words only (§19.6 PG, and no fights here); no children yet (M9b). */
const world = WorldConfigSchema.parse({ conflict: { maxRung: 2, newcomerGraceSec: 0 }, reproduction: { enabled: false } });

const person = (o: {
  name: string;
  sex: 'male' | 'female';
  orientation?: 'hetero' | 'homo' | 'bi';
  traits: string[];
  big5?: Record<string, number>;
  mind?: Record<string, number>;
  bias?: Record<string, number>;
  temperament?: Record<string, number>;
  values?: string[];
  intelligence?: number;
  initiate?: number;
}): Persona =>
  PersonaSchema.parse({
    id: o.name.toLowerCase(),
    name: o.name,
    sex: o.sex,
    orientation: o.orientation ?? 'hetero',
    traits: o.traits,
    values: o.values ?? ['friendship'],
    big5: { extraversion: 0.6, agreeableness: 0.8, neuroticism: 0.4, ...o.big5 },
    mind: { vanity: 0.3, ...o.mind, ...(o.bias ? { biasProfile: o.bias } : {}) },
    temperament: { aggression: 0.1, dominance: 0.2, vengefulness: 0.3, mercy: 0.7, loyalty: 0.7, ambition: 0.3, ...o.temperament },
    drives: { caution: 0.4 },
    abilities: { combat: 0.3, intelligence: o.intelligence ?? 0.8 },
    social: { initiateChance: o.initiate ?? 0.3 },
  });

describe.skipIf(!liveJavaPath())('M9a live: romance', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm9a', port: PORT, rconPort: 25599, deepGround: true });
    logger = createLogger({ name: 'm9a-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false, level: process.env.AGORA_LIVE_DEBUG ? 'debug' : 'info' });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty peaceful', 'gamerule spawn_radius 0']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  const connect = (username: string) => Body.connect({ host: server.host, port: server.port, username, version: versions.minecraft.version, logger });

  /** Everyone's lines as heard by anyone (each line once), and a timeline for the report. */
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

  /** `p`'s view of someone: how they feel about them, and whatever else the scenario sets. */
  const knows = (p: Persona, other: string, o: Partial<SocialProfile> & { sentiment: number }): SocialProfile => ({ ...newSocialProfile(other, p, Date.now()), trust: 0.6, interactions: 6, evidence: o.sentiment, ...o });

  async function cast(names: readonly string[], spots: Record<string, [number, number]>, x: number) {
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    const bodies: Record<string, Body> = {};
    for (const n of names) bodies[n] = await connect(n);
    for (const n of names) {
      await server.cmd(`clear ${n}`);
      const [dx, dz] = spots[n] ?? [0, 0];
      await server.cmd(`tp ${n} ${x + dx} ${Y} ${dz}`);
    }
    await sleep(2000);
    return bodies;
  }

  function track(agents: Record<string, Agent>, timeline: string[], at: () => string) {
    for (const [n, a] of Object.entries(agents)) {
      let last: Record<string, string> = {};
      a.store.on('change', (c: { facet: string }) => {
        if (c.facet !== 'social' && c.facet !== 'family') return;
        const now: Record<string, string> = {};
        for (const p of Object.values(a.store.state.social)) now[p.name] = `${p.relationship}${p.perceivedSex !== 'unknown' ? `/${p.perceivedSex}` : ''}`;
        for (const [k, v] of Object.entries(now)) if (last[k] !== v) timeline.push(`${at()} ${n} → ${k}: ${v} (interest ${a.store.state.social[k]?.romanticInterest.toFixed(2)})`);
        last = now;
      });
    }
  }

  it('R: from a first hello to partners, each deciding for themselves; everything said is PG', async () => {
    const ned = person({ name: 'Ned', sex: 'male', traits: ['kind', 'easygoing'], values: ['exploration'] });
    const ivy = person({ name: 'Ivy', sex: 'female', traits: ['warm', 'cheerful'], values: ['friendship'] });
    const bodies = await cast(['Ned', 'Ivy'], { Ned: [0, 0], Ivy: [3, 1] }, 1100);
    const t0 = Date.now();
    const heard = listen(Object.values(bodies), t0);
    const agents: Record<string, Agent> = {};
    for (const [n, p, other] of [['Ned', ned, 'Ivy'], ['Ivy', ivy, 'Ned']] as const) {
      // A low roll: an advance from someone one is drawn to is returned (§19.10 A), and hellos are said.
      const a = new Agent({ body: bodies[n] as Body, persona: p, username: n, llm: null, logger: logger.child({ agent: n }), world, goalGen: false, socialGoals: false, rng: () => 0.1 });
      // Neighbors who get on well; neither knows yet what the other is.
      a.store.update('social', (all) => ({ ...all, [other]: knows(p, other, { sentiment: 8 }) }), 'history');
      agents[n] = a;
    }
    track(agents, heard.timeline, heard.at);
    for (const a of Object.values(agents)) a.start();
    const seen = (n: string, other: string, rel: string) => heard.timeline.some((l) => l.includes(`${n} → ${other}: ${rel}`));
    try {
      await waitFor(() => agents.Ned?.store.state.social.Ivy?.perceivedSex === 'female' && agents.Ivy?.store.state.social.Ned?.perceivedSex === 'male', 300_000, 'each knowing what the other is', 1000);
      await waitFor(() => seen('Ned', 'Ivy', 'crush') || seen('Ivy', 'Ned', 'crush'), 1_200_000, 'a crush', 1000);
      await waitFor(() => heard.lines.some((l) => /will you be my partner/i.test(l.text)), 2_400_000, 'a proposal', 1000);
      await waitFor(() => agents.Ned?.store.state.family.partner === 'Ivy' && agents.Ivy?.store.state.family.partner === 'Ned', 120_000, 'partners, both sides', 1000);
      console.log(`[m9a R] timeline:\n  ${heard.timeline.join('\n  ')}`);
      expect(seen('Ned', 'Ivy', 'courting') || seen('Ivy', 'Ned', 'courting')).toBe(true);
      expect(agents.Ned?.store.state.social.Ivy?.relationship).toBe('partner');
      expect(agents.Ivy?.store.state.social.Ned?.relationship).toBe('partner');
      // §19.6: every line said was PG.
      expect(heard.lines.filter((l) => NOT_PG_RE.test(l.text))).toEqual([]);
    } finally {
      for (const a of Object.values(agents)) await a.stop();
      for (const b of Object.values(bodies)) await b.disconnect();
    }
  }, 4_000_000);

  it('S: turned down again and again, the suitor is held back for the week, sadder each time, and resentful at the end', async () => {
    // Max misreads hints (§19.10 persistence comes of low intelligence, §21 social signal reading), so he keeps at it.
    const max = person({ name: 'Max', sex: 'male', traits: ['proud', 'vain'], big5: { agreeableness: 0, neuroticism: 0 }, mind: { vanity: 1, rationality: 0 }, temperament: { vengefulness: 1, aggression: 0 }, intelligence: 0, initiate: 0 });
    const zoe = person({ name: 'Zoe', sex: 'female', orientation: 'homo', traits: ['polite', 'calm'], initiate: 0 });
    const bodies = await cast(['Max', 'Zoe'], { Max: [0, 0], Zoe: [3, 0] }, 1200);
    // Zoe in diamond: what catches a vain eye (§19.2: with vanity 1, attraction is all looks), so he keeps at it.
    for (const [slot, item] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) await server.cmd(`item replace entity Zoe armor.${slot} with minecraft:diamond_${item}`);
    const t0 = Date.now();
    const heard = listen(Object.values(bodies), t0);
    const agents: Record<string, Agent> = {};
    // Max's roll: persisting while he may (§19.10 B), and resentment once no attempts are left. Zoe's: a kind no.
    // (0.52 falls in persistence across his interest and shame while attempts are left; with them gone, and the shame of
    // three no's, in resentment.)
    for (const [n, p, other, roll] of [['Max', max, 'Zoe', 0.52], ['Zoe', zoe, 'Max', 0.05]] as const) {
      const a = new Agent({ body: bodies[n] as Body, persona: p, username: n, llm: null, logger: logger.child({ agent: n }), world, goalGen: false, socialGoals: false, rng: () => roll });
      const view = n === 'Max' ? knows(p, other, { sentiment: 8, perceivedSex: 'female', romanticInterest: 0.9, relationship: 'crush' }) : knows(p, other, { sentiment: 6, perceivedSex: 'male' });
      a.store.update('social', (all) => ({ ...all, [other]: view }), 'history');
      agents[n] = a;
    }
    track(agents, heard.timeline, heard.at);
    let saddest = 0;
    const m = agents.Max as Agent;
    m.store.on('change', () => void (saddest = Math.max(saddest, m.store.state.emotions.sadness)));
    for (const a of Object.values(agents)) a.start();
    const cap = persistenceCap(0);
    try {
      await waitFor(() => (m.store.state.family.advances.Zoe?.rejections ?? 0) > cap, 1_800_000, 'the soft cap reached', 1000);
      await sleep(5000);
      console.log(`[m9a S] timeline:\n  ${heard.timeline.join('\n  ')}`);
      const z = m.store.state.social.Zoe;
      console.log(`[m9a S] Max on Zoe: rejections ${m.store.state.family.advances.Zoe?.rejections}, sentiment ${z?.sentiment.toFixed(1)}, interest ${z?.romanticInterest.toFixed(2)}, saddest ${saddest.toFixed(2)}, grievances ${(z?.grievances ?? []).map((g) => g.kind).join(',') || 'none'}`);
      // The harassment lock: no more advances to her this week.
      expect(m.romance.mayCourt('Zoe')).toMatch(/said no too often/);
      expect(m.romance.courtship()).toBeNull();
      const lockedAt = Date.now();
      await sleep(4 * 60_000);
      expect(heard.lines.filter((l) => l.who === 'Max' && l.at > lockedAt && isAdvance(l.text))).toEqual([]);
      expect(saddest).toBeGreaterThan(0.3);
      // Low agreeableness turned it into resentment: a grievance, and less fond of her.
      expect((z?.grievances ?? []).some((g) => g.kind === 'rejection')).toBe(true);
      expect(z?.sentiment ?? 10).toBeLessThan(8);
      expect(heard.lines.filter((l) => NOT_PG_RE.test(l.text))).toEqual([]);
    } finally {
      for (const a of Object.values(agents)) await a.stop();
      for (const b of Object.values(bodies)) await b.disconnect();
    }
  }, 2_400_000);

  it('V: one courting his partner in his hearing: envy and anger, and a grudge against the rival', async () => {
    const ned = person({ name: 'Ned', sex: 'male', traits: ['kind', 'devoted'], mind: { vanity: 0.5 }, bias: { envy: 0.6 }, initiate: 0 });
    const ivy = person({ name: 'Ivy', sex: 'female', traits: ['warm', 'cheerful'], initiate: 0 });
    const max = person({ name: 'Max', sex: 'male', traits: ['bold', 'charming'], initiate: 0 });
    const bodies = await cast(['Ned', 'Ivy', 'Max'], { Ned: [0, 0], Ivy: [2, 1], Max: [3, -1] }, 1300);
    const t0 = Date.now();
    const heard = listen(Object.values(bodies), t0);
    const agents: Record<string, Agent> = {};
    const views: Record<string, Record<string, Partial<SocialProfile> & { sentiment: number }>> = {
      Ned: { Ivy: { sentiment: 9, perceivedSex: 'female', relationship: 'partner', kin: 'partner', romanticInterest: 0.9 }, Max: { sentiment: 5, perceivedSex: 'male' } },
      Ivy: { Ned: { sentiment: 9, perceivedSex: 'male', relationship: 'partner', kin: 'partner', romanticInterest: 0.9 }, Max: { sentiment: 5, perceivedSex: 'male' } },
      Max: { Ivy: { sentiment: 8, perceivedSex: 'female', romanticInterest: 0.85, relationship: 'crush' }, Ned: { sentiment: 5, perceivedSex: 'male' } },
    };
    // Middling rolls: Ivy turns Max's advances down kindly, as most would.
    for (const [n, p, roll] of [['Ned', ned, 0.5], ['Ivy', ivy, 0.3], ['Max', max, 0.3]] as const) {
      const a = new Agent({ body: bodies[n] as Body, persona: p, username: n, llm: null, logger: logger.child({ agent: n }), world, goalGen: false, socialGoals: false, rng: () => roll });
      a.store.update('social', (all) => ({ ...all, ...Object.fromEntries(Object.entries(views[n] ?? {}).map(([o, v]) => [o, knows(p, o, v)])) }), 'history');
      if (n !== 'Max') a.store.update('family', (f) => ({ ...f, partner: n === 'Ned' ? 'Ivy' : 'Ned' }), 'partners');
      agents[n] = a;
    }
    const nedA = agents.Ned as Agent;
    const jealousy: string[] = [];
    nedA.bus.on('felt', (e) => void (e.cause === 'jealous' && jealousy.push(`${heard.at()} envy ${nedA.store.state.emotions.envy.toFixed(2)}, anger ${nedA.store.state.emotions.anger.toFixed(2)}`)));
    for (const a of Object.values(agents)) a.start();
    try {
      await waitFor(() => heard.lines.some((l) => l.who === 'Max' && /^Ivy, /.test(l.text)), 600_000, 'Max courting Ivy', 1000);
      await waitFor(() => jealousy.length > 0, 300_000, 'Ned jealous', 1000);
      await sleep(3000);
      console.log(`[m9a V] timeline:\n  ${heard.timeline.join('\n  ')}\n  ${jealousy.join('\n  ')}`);
      const onMax = nedA.store.state.social.Max;
      expect(onMax?.grievances.some((g) => g.kind === 'romantic_rival')).toBe(true);
      expect(nedA.romance.mindLines()).toContain('You suspect Max is after Ivy.');
      // Still partners: jealousy isn't a breakup.
      expect(nedA.store.state.family.partner).toBe('Ivy');
      expect(heard.lines.filter((l) => NOT_PG_RE.test(l.text))).toEqual([]);
    } finally {
      for (const a of Object.values(agents)) await a.stop();
      for (const b of Object.values(bodies)) await b.disconnect();
    }
  }, 1_200_000);
});
