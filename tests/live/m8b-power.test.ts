// M8b exit test (§17.12 scenarios J, K and L, and the lethal rung) on a real server, with code-only agents.
//   J  tyrant: Rex, in iron and with an iron sword, looks down on the five others (seeded: low sentiment, an old
//      insult, logs he says they took; the timid two paid him once before). He demands; the timid two give in out of
//      fear again (coerced commitments) and, having paid him twice, follow him; the proud three refuse and get beaten.
//   K  overthrow (continues J): Rex goes out alone, hurt. Those who resent him and know the others do rally each
//      other, agree, and set upon him together; his followers, back as it starts, pick a side, and some walk away.
//   L  fear wins: the same resentment, but the tyrant (Vex) always has his two followers with him and isn't hurt.
//      The rebels grumble to each other about him; nobody proposes an uprising, and nobody fights him.
//   D  the lethal rung: Gorm, who can't forgive Pell for a friend's death, fights Pell to the death (maxRung 4 in a
//      test world allows it); Pell's "I yield" goes unheeded, and the onlooker Wit holds it heavily against Gorm.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Commitment, type Logger, type Persona, PersonaSchema, type SocialProfile, WorldConfigSchema, createLogger, loadVersionsConfig, parseProximityLine, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { withGrievance } from '@agora/agent/social/math';
import { newSocialProfile } from '@agora/agent/state/social';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const PORT = 25594;
const Y = DEEP_GROUND_Y;
/** Brawls only for the power scenarios (no deaths); the lethal rung has its own scenario. */
const world = WorldConfigSchema.parse({ conflict: { maxRung: 3, newcomerGraceSec: 0, pairCooldownSec: 120 } });
/** The lethal rung on, and no pause between a beating and what comes after it (D). */
const lethalWorld = WorldConfigSchema.parse({ conflict: { maxRung: 4, newcomerGraceSec: 0, pairCooldownSec: 0 } });

const RALLY_RE = /let'?s deal with (\w+) together/i;
const JOIN_RE = /i'?ll fight (\w+) with you/i;
const GRUMBLE_RE = /is a bully|can'?t stand/i;
const DEMAND_RE = /^(\w+, )?give me .*, or else$/i;

const person = (o: { name: string; sex: 'male' | 'female'; traits: string[]; temperament: Record<string, number>; caution: number; combat: number }): Persona =>
  PersonaSchema.parse({
    id: o.name.toLowerCase(),
    name: o.name,
    sex: o.sex,
    traits: o.traits,
    temperament: o.temperament,
    drives: { caution: o.caution },
    abilities: { combat: o.combat, intelligence: 0.8 },
    social: { initiateChance: 0 },
  });
const tyrant = (name: string) =>
  person({ name, sex: 'male', traits: ['domineering', 'cruel'], temperament: { aggression: 0.8, dominance: 0.95, vengefulness: 0.7, mercy: 0.2, loyalty: 0.3, ambition: 0.9 }, caution: 0.1, combat: 0.8 });
const meek = (name: string, sex: 'male' | 'female', loyalty: number) =>
  person({ name, sex, traits: ['timid', 'obliging'], temperament: { aggression: 0.1, dominance: 0.1, vengefulness: 0.3, mercy: 0.8, loyalty, ambition: 0.2 }, caution: 0.6, combat: 0.2 });
const proud = (name: string, sex: 'male' | 'female') =>
  person({ name, sex, traits: ['proud', 'stubborn'], temperament: { aggression: 0.7, dominance: 0.4, vengefulness: 0.85, mercy: 0.5, loyalty: 0.6, ambition: 0.5 }, caution: 0.15, combat: 0.45 });

describe.skipIf(!liveJavaPath())('M8b live: power structures', () => {
  let server: LiveServer;
  let logger: Logger;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'm8b', port: PORT, rconPort: 25595, deepGround: true });
    logger = createLogger({ name: 'm8b-live', logDir: path.join(server.dir, '..', 'agent-logs'), console: false });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'time set 1000', 'difficulty normal', 'gamerule spawn_radius 0']) await server.cmd(c);
  });

  afterAll(async () => {
    await server?.stop();
  });

  const connect = (username: string) => Body.connect({ host: server.host, port: server.port, username, version: versions.minecraft.version, logger });

  /** Everyone's lines as heard by anyone (each line once), and a timeline. */
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

  /** A profile of `other` as `p` sees them, with some history. */
  function history(p: Persona, other: string, o: { sentiment?: number; trust?: number; wrongs?: { kind: 'insult' | 'theft' | 'attack' | 'coercion' | 'killed_friend'; note: string; agoMin: number }[] } = {}): SocialProfile {
    const now = Date.now();
    let x: SocialProfile = { ...newSocialProfile(other, p, now), ...(o.sentiment !== undefined ? { sentiment: o.sentiment, evidence: o.sentiment } : {}), ...(o.trust !== undefined ? { trust: o.trust } : {}) };
    for (const w of o.wrongs ?? []) x = withGrievance(x, w.kind, p, { now: now - w.agoMin * 60_000, witnessed: true, source: 'self_observed', note: w.note });
    return x;
  }

  it('J then K: a tyrant rules by fear until those he wronged rise against him when he goes out alone and hurt', async () => {
    const x = 300;
    await server.cmd(`forceload add ${x - 48} -48 ${x + 48} 48`);
    // Two rings of oaks, so there is wood to work at by Rex the whole time.
    for (let i = 0; i < 20; i++) {
      const a = (i / 10) * Math.PI * 2 + (i >= 10 ? Math.PI / 10 : 0);
      const r = i < 10 ? 11 : 16;
      await server.cmd(`place feature minecraft:oak ${Math.round(x + Math.cos(a) * r)} ${Y} ${Math.round(Math.sin(a) * r)}`);
    }
    const names = ['Rex', 'Tib', 'Pia', 'Ann', 'Bo', 'Cyd'] as const;
    const personas: Record<(typeof names)[number], Persona> = {
      Rex: tyrant('Rex'),
      // Loyal enough to give in (pride 1 − 0.5·loyalty is 0.75), not so loyal as to stand by Rex when he is set upon.
      Tib: meek('Tib', 'male', 0.5),
      Pia: meek('Pia', 'female', 0.9),
      Ann: proud('Ann', 'female'),
      Bo: proud('Bo', 'male'),
      Cyd: proud('Cyd', 'male'),
    };
    const bodies = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await connect(n)] as const))) as Record<(typeof names)[number], Body>;
    for (const [i, n] of names.entries()) {
      await server.cmd(`clear ${n}`);
      await server.cmd(`tp ${n} ${x + Math.round(Math.cos(i) * 5)} ${Y} ${Math.round(Math.sin(i) * 5)}`);
    }
    for (const it of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword']) await server.cmd(`give Rex minecraft:${it}`);
    for (const n of names.slice(1)) await server.cmd(`give ${n} minecraft:bread 8`);
    for (const n of ['Ann', 'Bo', 'Cyd']) await server.cmd(`give ${n} minecraft:stone_sword`);
    await sleep(2000);
    const t0 = Date.now();
    const heard = listen(Object.values(bodies), t0);
    const deaths: string[] = [];
    const agents = {} as Record<(typeof names)[number], Agent>;
    for (const n of names) {
      const body = bodies[n];
      body.bot.on('death', () => void deaths.push(n));
      const p = personas[n];
      const a = new Agent({ body, persona: p, username: n, llm: null, logger: logger.child({ agent: n }), world, goalGen: false, socialGoals: false, rng: () => 0.99 });
      const others = names.filter((o) => o !== n);
      a.store.update(
        'social',
        (all) => ({
          ...all,
          ...Object.fromEntries(
            others.map((o) => [
              o,
              n === 'Rex'
                ? // Rex looks down on them all: they laughed at him, and took his logs, he says.
                  history(p, o, { sentiment: 1.5, wrongs: [{ kind: 'insult', note: `${o} laughed at me`, agoMin: 30 }, { kind: 'theft', note: `${o} took my logs`, agoMin: 20 }] })
                : o !== 'Rex'
                  ? // The others get on: neighbors who trust each other.
                    history(p, o, { sentiment: 6.5, trust: 0.6 })
                  : // The proud have had words with Rex before.
                    history(p, o, ['Ann', 'Bo', 'Cyd'].includes(n) ? { sentiment: 3.5, wrongs: [{ kind: 'insult', note: 'Rex called me weak', agoMin: 30 }] } : {}),
            ]),
          ),
        }),
        'history',
      );
      // The timid two paid Rex once before, out of fear: once more, and they go about with him.
      const paidBefore = (debtor: string): Commitment => ({
        id: `paid-before-${debtor}`,
        debtor,
        creditor: 'Rex',
        what: { kind: 'give', item: 'bread', qty: 3, text: '3 bread' },
        status: 'fulfilled',
        createdFromConv: '',
        createdAt: Date.now() - 20 * 60_000,
        resolvedAt: Date.now() - 15 * 60_000,
        verifiedBy: 'inventory',
        coerced: true,
      });
      const before = n === 'Rex' ? [paidBefore('Tib'), paidBefore('Pia')] : n === 'Tib' || n === 'Pia' ? [paidBefore(n)] : [];
      if (before.length > 0) a.store.update('commitments', (cs) => [...cs, ...before], 'paid Rex before');
      a.bus.on('rungChanged', (e) => void heard.timeline.push(`${heard.at()} ${n} → ${e.name}: rung ${e.from} → ${e.to}`));
      a.bus.on('leaderChanged', (e) => void heard.timeline.push(`${heard.at()} ${n} ${e.leader ? `follows ${e.leader}` : `stops following ${e.before ?? ''}`}`));
      a.bus.on('defected', (e) => void heard.timeline.push(`${heard.at()} ${n} walks away from ${e.from} (${e.attackers.join(', ')} set upon them)`));
      a.bus.on('actionRecorded', (e) => {
        if (['duel', 'give'].includes(e.record.skill)) heard.timeline.push(`${heard.at()} ${n} ${e.record.skill}: ${e.record.observed}`);
      });
      agents[n] = a;
    }
    let reported = false;
    const report = (tag: string) => {
      if (reported) return;
      reported = true;
      console.log(`[m8b ${tag}] timeline:\n  ${heard.timeline.join('\n  ')}`);
      for (const n of names) {
        const s = agents[n].store.state;
        const rex = s.social.Rex;
        console.log(
          `[m8b ${tag}] ${n}: health ${s.self.health}, follows ${agents[n].power.leader() ?? '-'}, on Rex: sentiment ${rex?.sentiment.toFixed(1) ?? '-'}, fear ${rex?.fearOf.toFixed(2) ?? '-'}, resentment ${n === 'Rex' ? '-' : agents[n].conflict.resentmentOf('Rex').toFixed(2)}, Rex seen with ${rex?.followersSeen ?? 0} (${rex?.perceivedRole ?? 'no role'}); commitments ${s.commitments.map((c) => `${c.debtor}→${c.creditor} ${c.what.text} ${c.status}${c.coerced ? ' (coerced)' : ''}`).join('; ') || 'none'}`,
        );
      }
    };
    for (const n of names) agents[n].start();
    // The others work; Rex lives off them.
    for (const n of names.slice(1)) agents[n].setGoal('gather wood', 'inventoryHas:oak_log>=32');
    try {
      // J: demands, giving in out of fear, coerced promises, followers.
      await waitFor(() => heard.lines.some((l) => l.who === 'Rex' && DEMAND_RE.test(l.text)), 180_000, 'a demand from Rex', 500);
      // Paid again, here and now (the seeded payment was the first).
      const paidAgain = () => (['Tib', 'Pia'] as const).filter((n) => agents[n].store.state.commitments.some((c) => c.coerced && c.debtor === n && c.creditor === 'Rex' && c.status === 'fulfilled' && c.createdAt >= t0));
      await waitFor(() => paidAgain().length >= 1, 900_000, 'a timid one paying Rex again', 1000);
      await waitFor(() => (['Tib', 'Pia'] as const).some((n) => agents[n].power.leader() === 'Rex'), 60_000, 'a follower of Rex', 1000);
      // The other timid one, given the time to pay twice as well.
      await waitFor(() => (['Tib', 'Pia'] as const).every((n) => agents[n].power.leader() === 'Rex'), 360_000, 'both timid ones following Rex', 1000).catch(() => undefined);
      const followers = (['Tib', 'Pia'] as const).filter((n) => agents[n].power.leader() === 'Rex');
      // Those who saw it know Rex leads (two followers), or at least that he collects tribute from one.
      const refused = (['Ann', 'Bo', 'Cyd'] as const).filter((n) => heard.lines.some((l) => l.who === n && /leave me alone|get lost|back off|no way|not giving|or we fight|keep your distance|don't push me/i.test(l.text)) || agents[n].store.state.social.Rex?.lastFight);
      console.log(`[m8b J] followers ${followers.join(', ')}; the proud who stood up to Rex: ${refused.join(', ') || 'none'}`);
      expect(followers.length).toBeGreaterThanOrEqual(1);
      expect(agents.Rex.store.state.commitments.filter((c) => c.coerced && c.creditor === 'Rex' && c.createdAt >= t0).length).toBeGreaterThanOrEqual(1);
      expect(deaths).toEqual([]);

      // K: Rex goes out alone, hurt: the followers are off somewhere far.
      for (const n of followers) await server.cmd(`tp ${n} ${x + 80} ${Y} 60`);
      await server.cmd(`tp Rex ${x} ${Y} 0`);
      for (const n of ['Ann', 'Bo', 'Cyd']) await server.cmd(`tp ${n} ${x + (n === 'Ann' ? 6 : n === 'Bo' ? 7 : 5)} ${Y} ${n === 'Cyd' ? -4 : 3}`);
      await server.cmd('effect give Rex minecraft:instant_damage 1 0');
      const kAt = Date.now();
      heard.timeline.push(`${heard.at()} -- Rex alone and hurt (followers away) --`);
      // §17.11 K: proposed, agreed and carried out within about 20 minutes of the opening; those who swore just
      // before it, when he went about with his followers, wait for it (and strike after it, below).
      const since = kAt - 20 * 60_000;
      await waitFor(() => heard.lines.some((l) => l.at >= since && RALLY_RE.test(l.text)), 300_000, 'a call to rise against Rex', 500);
      await waitFor(() => heard.lines.some((l) => l.at >= since && JOIN_RE.test(l.text)), 120_000, 'someone joining', 500);
      // The followers come running as it starts. Who rose against Rex, as seen at any moment since the opening: a
      // fight with him under way, or one fought.
      const rose = new Set<string>();
      const struck = () => {
        for (const n of ['Ann', 'Bo', 'Cyd'] as const) {
          const o = agents[n].store.state.option;
          if ((o?.option === 'fight' && o.targetAgent === 'Rex') || agents[n].store.state.actionLog.some((r) => r.skill === 'duel' && r.args.target === 'Rex' && r.ts >= kAt)) rose.add(n);
        }
        return [...rose];
      };
      // The followers come back as it starts: as the rebels close in on him, or strike.
      const closingIn = () =>
        (['Ann', 'Bo', 'Cyd'] as const).some((n) => {
          const o = agents[n].store.state.option;
          return o?.status === 'running' && o.targetAgent === 'Rex' && (o.option === 'follow' || o.option === 'fight');
        }) || struck().length >= 1;
      await waitFor(closingIn, 300_000, 'the rebels closing in on Rex', 250);
      for (const n of followers) await server.cmd(`execute at Rex run tp ${n} ~ ~ ~`);
      heard.timeline.push(`${heard.at()} -- ${followers.join(' and ')} back at Rex's side --`);
      await waitFor(() => struck().length >= 1, 300_000, 'the uprising', 500);
      await waitFor(() => struck().length >= 2, 120_000, 'a second rebel at Rex', 500);
      await waitFor(() => (['Ann', 'Bo', 'Cyd'] as const).some((n) => agents[n].store.state.actionLog.some((r) => r.skill === 'duel' && r.args.target === 'Rex' && r.ts >= kAt)), 180_000, 'a fight with Rex over', 1000);
      await sleep(20_000);
      report('K');
      const sworn = (['Ann', 'Bo', 'Cyd'] as const).filter((n) => agents[n].store.state.commitments.some((c) => c.what.kind === 'fight' && c.what.target === 'Rex'));
      expect(sworn.length).toBeGreaterThanOrEqual(2);
      expect(struck().length).toBeGreaterThanOrEqual(2);
      // Some followers walk away: right there as their leader is set upon, or as their fear of him falls.
      const left = followers.filter((n) => agents[n].power.leader() !== 'Rex');
      console.log(`[m8b K] rose against Rex: ${struck().join(', ')}; followers who left him: ${left.join(', ') || 'none'}; deaths: ${deaths.join(', ') || 'none'}`);
      expect(left.length).toBeGreaterThanOrEqual(1);
    } finally {
      report('J/K');
      for (const n of names) await agents[n].stop();
      for (const b of Object.values(bodies)) await b.disconnect();
    }
  }, 2_400_000);

  it('L (fear wins): with his two followers always at his side, the tyrant is grumbled about, never risen against', async () => {
    const x = 900;
    await server.cmd(`forceload add ${x - 32} -32 ${x + 32} 32`);
    const names = ['Vex', 'Lin', 'Moe', 'Dag', 'Eli', 'Fen'] as const;
    const personas: Record<(typeof names)[number], Persona> = {
      Vex: tyrant('Vex'),
      Lin: meek('Lin', 'female', 0.7),
      Moe: meek('Moe', 'male', 0.7),
      Dag: proud('Dag', 'male'),
      Eli: proud('Eli', 'female'),
      Fen: proud('Fen', 'male'),
    };
    const bodies = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await connect(n)] as const))) as Record<(typeof names)[number], Body>;
    // Vex with Lin and Moe at one end; the three who resent him out of his earshot, but in sight.
    const spots: Record<(typeof names)[number], [number, number]> = { Vex: [0, 0], Lin: [2, 1], Moe: [-1, 2], Dag: [27, 6], Eli: [29, 4], Fen: [28, 8] };
    for (const n of names) {
      await server.cmd(`clear ${n}`);
      await server.cmd(`tp ${n} ${x + spots[n][0]} ${Y} ${spots[n][1]}`);
    }
    for (const it of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword']) await server.cmd(`give Vex minecraft:${it}`);
    for (const n of names.slice(1)) await server.cmd(`give ${n} minecraft:bread 8`);
    for (const n of ['Dag', 'Eli', 'Fen']) await server.cmd(`give ${n} minecraft:stone_sword`);
    await sleep(2000);
    const t0 = Date.now();
    const heard = listen(Object.values(bodies), t0);
    const agents = {} as Record<(typeof names)[number], Agent>;
    for (const n of names) {
      const p = personas[n];
      const a = new Agent({ body: bodies[n], persona: p, username: n, llm: null, logger: logger.child({ agent: n }), world, goalGen: false, socialGoals: false, rng: () => 0.2 });
      const now = Date.now();
      // The same resentment as in K: the three were beaten and made to pay; they told each other so. Lin and Moe
      // have paid Vex twice this hour, out of fear.
      a.store.update(
        'social',
        (all) => ({
          ...all,
          ...Object.fromEntries(
            names
              .filter((o) => o !== n)
              .map((o) => [
                o,
                ['Dag', 'Eli', 'Fen'].includes(n) && o === 'Vex'
                  ? history(p, o, { sentiment: 2, wrongs: [{ kind: 'attack', note: 'Vex beat me', agoMin: 15 }, { kind: 'coercion', note: 'Vex made me pay', agoMin: 10 }] })
                  : ['Dag', 'Eli', 'Fen'].includes(n) && ['Dag', 'Eli', 'Fen'].includes(o)
                    ? history(p, o, { sentiment: 7, trust: 0.7 })
                    : history(p, o),
              ]),
          ),
        }),
        'history',
      );
      if (['Dag', 'Eli', 'Fen'].includes(n)) {
        a.store.update('heardOpinions', () => ['Dag', 'Eli', 'Fen'].filter((o) => o !== n).map((o) => ({ speaker: o, target: 'Vex', valence: -0.7, ts: now - 5 * 60_000 })), 'they told each other');
      }
      if (n === 'Lin' || n === 'Moe') {
        a.store.update(
          'commitments',
          () => [1, 2].map((i) => ({ id: `t${n}${i}`, debtor: n, creditor: 'Vex', what: { kind: 'give' as const, item: 'bread', qty: 3, text: '3 bread' }, status: 'fulfilled' as const, coerced: true, createdFromConv: 'c0', createdAt: now - i * 10 * 60_000, resolvedAt: now - i * 9 * 60_000 })),
          'tribute paid',
        );
      }
      a.bus.on('leaderChanged', (e) => void heard.timeline.push(`${heard.at()} ${n} ${e.leader ? `follows ${e.leader}` : `stops following ${e.before ?? ''}`}`));
      agents[n] = a;
    }
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      console.log(`[m8b L] timeline:\n  ${heard.timeline.join('\n  ')}`);
      for (const n of ['Dag', 'Eli', 'Fen'] as const) {
        const c = agents[n].power.coalition('Vex');
        console.log(`[m8b L] ${n}: resentment ${agents[n].conflict.resentmentOf('Vex').toFixed(2)}, coalition ${c.members.join('+') || '-'} power ${c.power.toFixed(2)} against ${c.against.toFixed(2)}, opening ${c.opening}, Vex followers seen ${agents[n].store.state.social.Vex?.followersSeen ?? 0}`);
      }
    };
    for (const n of names) agents[n].start();
    try {
      await waitFor(() => agents.Lin.power.leader() === 'Vex' && agents.Moe.power.leader() === 'Vex', 60_000, 'Lin and Moe following Vex', 1000);
      // Four minutes of the rebels living near the tyrant and his followers.
      await waitFor(() => heard.lines.filter((l) => ['Dag', 'Eli', 'Fen'].includes(l.who) && GRUMBLE_RE.test(l.text)).length >= 1, 240_000, 'grumbling about Vex', 1000);
      await sleep(120_000);
      report();
      expect(heard.lines.some((l) => RALLY_RE.test(l.text) || JOIN_RE.test(l.text))).toBe(false);
      for (const n of ['Dag', 'Eli', 'Fen'] as const) {
        expect(agents[n].store.state.commitments.some((c) => c.what.kind === 'fight')).toBe(false);
        expect(agents[n].store.state.actionLog.some((r) => r.skill === 'duel' && r.args.target === 'Vex')).toBe(false);
      }
      // Fear held them: Vex is seen leading two.
      expect(agents.Dag.store.state.social.Vex?.followersSeen ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      report();
      for (const n of names) await agents[n].stop();
      for (const b of Object.values(bodies)) await b.disconnect();
    }
  }, 900_000);

  it('D (the lethal rung): a fight to the death ignores the yield, and the onlooker holds it heavily against the killer', async () => {
    const x = 1300;
    await server.cmd(`forceload add ${x - 16} -16 ${x + 16} 16`);
    const gorm = await connect('Gorm');
    const pell = await connect('Pell');
    const wit = await connect('Wit');
    await server.cmd(`tp Gorm ${x} ${Y} 0`);
    await server.cmd(`tp Pell ${x + 4} ${Y} 0`);
    await server.cmd(`tp Wit ${x + 2} ${Y} 6`);
    for (const n of ['Gorm', 'Pell', 'Wit']) await server.cmd(`clear ${n}`);
    await server.cmd('give Gorm minecraft:stone_sword');
    // Pell in iron: he lasts a few blows after giving up, as anyone in armor would.
    for (const [slot, it] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']] as const) await server.cmd(`item replace entity Pell armor.${slot} with minecraft:iron_${it}`);
    await sleep(1500);
    const avenger = person({ name: 'Gorm', sex: 'male', traits: ['vengeful', 'grim'], temperament: { aggression: 0.9, dominance: 0.7, vengefulness: 0.95, mercy: 0.05, loyalty: 0.8, ambition: 0.3 }, caution: 0.05, combat: 0.7 });
    const onlooker = person({ name: 'Wit', sex: 'female', traits: ['calm'], temperament: { aggression: 0.2, dominance: 0.2, vengefulness: 0.4, mercy: 0.7, loyalty: 0.5, ambition: 0.3 }, caution: 0.5, combat: 0.3 });
    const g = new Agent({ body: gorm, persona: avenger, username: 'Gorm', llm: null, logger: logger.child({ agent: 'Gorm' }), world: lethalWorld, goalGen: false, socialGoals: false, rng: () => 0.99 });
    g.store.update('social', (all) => ({ ...all, Pell: history(avenger, 'Pell', { sentiment: 0, wrongs: [{ kind: 'killed_friend', note: 'Pell killed my brother', agoMin: 30 }, { kind: 'insult', note: 'Pell laughed about it', agoMin: 5 }] }) }), 'history');
    const w = new Agent({ body: wit, persona: onlooker, username: 'Wit', llm: null, logger: logger.child({ agent: 'Wit' }), world: lethalWorld, goalGen: false, socialGoals: false, rng: () => 0.99 });
    const t0 = Date.now();
    const heard = listen([gorm, wit], t0);
    let pellDied = false;
    pell.bot.on('death', () => void (pellDied = true));
    // Pell gives up whenever he is hurt (a plain client, as a person would).
    let yielded = false;
    let lastYield = 0;
    let lastHealth = 20;
    pell.bot.on('health', () => {
      const h = pell.bot.health;
      if (h < lastHealth && h > 0 && Date.now() - lastYield > 3000) {
        yielded = true;
        lastYield = Date.now();
        void pell.say('ok ok, I yield!');
      }
      lastHealth = h;
    });
    g.start();
    w.start();
    try {
      await waitFor(() => g.conflict.rungOf('Pell') >= 4, 180_000, 'the lethal rung', 500);
      await waitFor(() => pellDied, 120_000, 'Pell dead', 500);
      const lethal = () => g.store.state.actionLog.find((r) => r.skill === 'duel' && r.args.lethal === true);
      await waitFor(lethal, 30_000, 'the fight to the death recorded', 500);
      await sleep(2000);
      const duel = lethal();
      // A beating first, given up and let stand; the fight to the death came after.
      const brawls = g.store.state.actionLog.filter((r) => r.skill === 'duel' && r.args.lethal !== true);
      const b = w.store.state.social.Gorm?.grievances.find((x) => x.kind === 'betrayal');
      console.log(`[m8b D] ${heard.timeline.join(' | ')}; Gorm's brawls: ${brawls.map((r) => r.observed).join(', ') || 'none'}; the fight to the death: ${duel?.observed} ${JSON.stringify(duel?.args)}; Wit holds against Gorm: ${b?.note ?? 'nothing'} (${b?.weight.toFixed(2) ?? '-'})`);
      expect(duel?.data?.outcome).toBe('gone');
      expect(yielded).toBe(true);
      expect(b?.weight ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      await g.stop();
      await w.stop();
      for (const b of [gorm, pell, wit]) await b.disconnect();
    }
  }, 400_000);
});
