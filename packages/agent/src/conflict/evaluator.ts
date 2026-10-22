// The conflict evaluator (§17.4, §17.5; M6b): code, event-driven, no LLM. For each person at hand it keeps
// perceived power and fear current from what can be seen (gear, kills announced in chat, fights seen won, visible
// hurt), turns wrongs into grievances, and weighs motive against deterrence. The escalation rung toward each person
// follows that pressure with hysteresis: 0 keep your distance, 1 hostile talk, 2 threats and demands, 3 a brawl until
// someone yields, 4 a fight to the death (M8b; `maxRung` 3 keeps it off). A fight happens only through the code
// gate: the CC proposes it and `mayFight` confirms it. Code never starts one itself, except the reflexes'
// self-defense and defense of a friend. Those sworn to take someone on together (§17.8) are each other's strength.

import type { AgentName, GrievanceKind, Logger, SocialProfile, WorldConfig } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { newSocialProfile } from '../state/social';
import { pushWorkmem } from '../state/workmem';
import { GRIEVANCE_WEIGHT, resentment, withGrievance } from '../social/math';
import { mobModifiers } from '../mind/biases';
import { CALL_OFF_RE, SURRENDER_RE } from '../body/skills/duel';
import { type FightIntent, deterrence, fearOf, gateFight, motive, opportunity, powerOf, rungFor, witnessCost } from './pressure';
import { COERCION_GRIEVANCE, parseDemand } from './coercion';

export interface ConflictOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  config: WorldConfig['conflict'];
  mode: WorldConfig['mode'];
  /** Our own visible gear, 0..1. */
  myGear: () => number;
  /** A crowd is turning on them (§18.4.2): thresholds drop, fear shrinks, witnesses don't count. */
  inMob?: (target: AgentName) => boolean;
  /** The world-wide concurrent fight cap is reached (Hub fight tokens); free without a Hub. */
  fightCapReached?: () => boolean;
  /** When this agent was born (newcomer grace). */
  bornAt: number;
  rng?: () => number;
  now?: () => number;
}

export interface Pressure {
  pressure: number;
  motive: number;
  deterrence: number;
  resentment: number;
  fear: number;
  rung: number;
}

const PROVOCATION_MS = 30_000;
/** A rung rises at most one step this often: words come before blows (falls are free, past the hysteresis). */
const ESCALATE_EVERY_MS = 15_000;
/** A rung toward someone is kept this long without seeing them before it relaxes. */
const RUNG_MEMORY_MS = 10 * 60_000;
/** Within this, someone we're at odds with is "near" (the CC's conflict moves look this far). */
const NEAR_BLOCKS = 12;
/** "They're here" is said at most this often per person, unless things got worse since. */
const NEAR_EVERY_MS = 60_000;
/** Blows this recent, when the danger passes, were a fight (one we fought back in, or ran from). */
const FIGHT_WINDOW_MS = 30_000;
/** A blow this soon after a fight was settled is still that fight (§17.6), not the start of a new one. */
const SETTLED_GRACE_MS = 8000;
/** A sworn ally's fight with someone this recent is one to join (§17.6 groupAttack). */
const JOIN_MS = 8000;
/** After someone gives up, no new brawl with them starts for this long (§17.6: the yield is let stand). */
const YIELD_STANDS_MS = 30_000;
/** A blow this long after someone gave up ignores the yield (the first moments are the winner's reaction time). */
const YIELD_HEARD_MS = 1000;
const YIELD_IGNORED_MS = 20_000;
/** Those who swore to take someone on with us count when within this (§17.6 groupAttack). */
const ALLIES_NEAR = 10;

/** Box–Muller N(0, 1). */
function gauss(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export class ConflictEvaluator {
  private readonly provoked = new Map<AgentName, { at: number; how: number }>();
  private readonly allyCall = new Map<AgentName, number>();
  private readonly seenAt = new Map<AgentName, number>();
  private near = new Set<AgentName>();
  private readonly nearSaid = new Map<AgentName, { at: number; rung: number }>();
  /** When each person last hit us, when each last gave up (in words), when our fights with each ended. */
  private readonly hitBy = new Map<AgentName, number>();
  private readonly surrenderedAt = new Map<AgentName, number>();
  private readonly foughtAt = new Map<AgentName, number>();
  private yieldedAt = -Infinity;
  private readonly escalatedAt = new Map<AgentName, number>();
  /** When a fight with each person was last settled: they gave up or called it off, or our duel with them ended. */
  private readonly settledAt = new Map<AgentName, number>();
  /** Their blows since then: one is a parting blow; another is a new fight (§17.6). */
  private readonly blowsSince = new Map<AgentName, number>();
  /** §21.3 self-assessment: the less intelligent misjudge their own fighting, once per life. */
  private readonly misjudge: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: ConflictOptions) {
    this.now = o.now ?? Date.now;
    const i = o.store.state.self.persona.abilities.intelligence;
    this.misjudge = gauss(o.rng ?? Math.random) * 0.2 * (1 - i);
  }

  start(): void {
    const b = this.o.bus;
    this.offs.push(
      b.on('attacked', (e) => {
        if (!e.by || !this.isPerson(e.by)) return;
        this.hitBy.set(e.by, this.now());
        if (this.settledAt.has(e.by)) this.blowsSince.set(e.by, (this.blowsSince.get(e.by) ?? 0) + 1);
        this.grieve(e.by, 'attack', true, `${e.by} hit me`, 0.3 + Math.min(0.4, e.damage / 10));
        this.provoke(e.by, 0.5);
      }),
    );
    this.offs.push(
      b.on('felt', (e) => {
        if (!e.by) return;
        if (e.cause === 'insulted') {
          this.grieve(e.by, 'insult', true, `${e.by} insulted me`);
          this.provoke(e.by, 0.3);
        } else if (e.cause === 'threatened') this.provoke(e.by, 0.4);
      }),
    );
    this.offs.push(
      b.on('commitmentResolved', (e) => {
        const c = this.o.store.state.commitments.find((x) => x.id === e.commitmentId);
        if (!c) return;
        if (e.status === 'broken' && c.debtor !== this.o.me && c.creditor === this.o.me) this.grieve(c.debtor, 'broken_promise', true, `${c.debtor} broke a promise to me`);
        // §17.7: every coerced payment is a small grievance against the demander; tribute breeds resentment.
        if (e.status === 'fulfilled' && c.coerced && c.debtor === this.o.me) this.grieve(c.creditor, 'coercion', true, `${c.creditor} made me pay ${c.what.text}`, COERCION_GRIEVANCE);
        // A coerced promise broken by them: defiance, which provokes the demander.
        if (e.status === 'broken' && c.coerced && c.creditor === this.o.me) this.provoke(c.debtor, 0.4);
      }),
    );
    // Kills are public (death messages), and killing a friend is the heaviest wrong there is.
    this.offs.push(
      b.on('systemEvent', (e) => {
        const ev = e.event;
        if (ev.kind !== 'death' || !ev.killer || !ev.subject || ev.killer === this.o.me || !this.isPerson(ev.killer)) return;
        this.update(ev.killer, (p) => ({ ...p, killsSeen: p.killsSeen + 1 }), 'a kill announced');
        if ((this.o.store.state.social[ev.subject]?.sentiment ?? 5) >= 7) this.grieve(ev.killer, 'killed_friend', true, `${ev.killer} killed ${ev.subject}`);
      }),
    );
    // A friend attacked in front of us calls for help against the attacker.
    this.offs.push(
      b.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind !== 'attack' || !a.target || a.actor === this.o.me) return;
        this.yieldIgnored(a.actor, a.target);
        if (a.target === this.o.me) return;
        const friend = (this.o.store.state.social[a.target]?.sentiment ?? 5) >= 7;
        if (friend) {
          this.grieve(a.actor, 'attack', true, `${a.actor} attacked ${a.target}`, 0.3);
          this.allyCall.set(a.actor, this.now());
        }
      }),
    );
    // How our own fights end (§17.6), and what we learn from the fights of others.
    this.offs.push(
      b.on('actionRecorded', (e) => {
        const r = e.record;
        if (r.skill !== 'duel' || typeof r.args.target !== 'string') return;
        this.fought(r.args.target, typeof r.data?.outcome === 'string' ? r.data.outcome : 'interrupted');
        // Whoever else struck us meanwhile was in that fight too, and it is over with them as well.
        this.foughtTheRest();
      }),
    );
    this.offs.push(b.on('heard', (e) => this.onSurrender(e.utterance.from, e.utterance.text)));
    // §17.7: a demand made of us with a threat is coercion, a small wrong whether or not we give in.
    this.offs.push(
      b.on('heard', (e) => {
        const u = e.utterance;
        if (u.addressedToMe && u.from !== this.o.me && this.isPerson(u.from) && parseDemand(u.text)) this.grieve(u.from, 'coercion', true, `${u.from} threatened me`, COERCION_GRIEVANCE);
      }),
    );
    // A fight fought by the reflexes (we hit back, or ran) is a fight too: when the danger passes, it is recorded
    // like a duel, with its pair cooldown, so neither side starts another right away (§17.10).
    this.offs.push(b.on('dangerCleared', () => this.foughtTheRest()));
    // §17.3 code friction: working the same spot we are, or turning us down.
    this.offs.push(
      b.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind !== 'dig' || !a.pos || a.actor === this.o.me) return;
        const s = this.o.store.state;
        const working = ['gather', 'mine', 'obtain'].includes(s.option?.skill ?? '');
        if (working && Math.hypot(a.pos.x - s.self.pos.x, a.pos.y - s.self.pos.y, a.pos.z - s.self.pos.z) <= 5) this.chafe(a.actor, 0.03, 'working my spot');
      }),
    );
    this.offs.push(
      b.on('felt', (e) => {
        if (e.cause === 'rejected' && e.by) this.chafe(e.by, 0.05, 'turned me down');
      }),
    );
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }

  private readonly chafed = new Map<AgentName, number>();

  /** A little friction (§17.3), at most every 20 s per person. */
  private chafe(name: AgentName, d: number, why: string): void {
    const t = this.now();
    if (t - (this.chafed.get(name) ?? -Infinity) < 20_000) return;
    this.chafed.set(name, t);
    this.update(name, (p) => ({ ...p, friction: Math.min(1, p.friction + d) }), `friction: ${why}`);
  }

  /** Everyone who struck us lately and whose fight with us isn't on record yet: a fight that ended (§17.10). */
  private foughtTheRest(): void {
    const t = this.now();
    for (const [name, at] of this.hitBy) {
      if (t - at > FIGHT_WINDOW_MS) {
        this.hitBy.delete(name);
        continue;
      }
      if (t - (this.foughtAt.get(name) ?? -Infinity) < FIGHT_WINDOW_MS) continue;
      const outcome = t - this.yieldedAt < FIGHT_WINDOW_MS ? 'yielded' : t - (this.surrenderedAt.get(name) ?? -Infinity) < FIGHT_WINDOW_MS ? 'won' : 'interrupted';
      this.fought(name, outcome);
    }
  }

  private settle(name: AgentName, t: number): void {
    this.settledAt.set(name, t);
    this.blowsSince.set(name, 0);
  }

  /** One of our fights ended: the record, a pair cooldown, and what we learned (§17.6, §21.3 growth). */
  private fought(target: AgentName, outcome: string): void {
    const t = this.now();
    this.foughtAt.set(target, t);
    this.hitBy.delete(target);
    const s = this.o.store.state;
    const won = outcome === 'won' || outcome === 'gone';
    const gaveUp = outcome === 'yielded';
    const stronger = this.powerOfProfile(s.social[target] ?? newSocialProfile(target, s.self.persona, t)) > this.myPower();
    this.update(
      target,
      (p) => ({
        ...p,
        lastFight: { ts: t, outcome: won ? 'won' : gaveUp ? 'yielded' : 'interrupted' },
        estCombat: Math.min(1, Math.max(0, p.estCombat + (won ? -0.05 : gaveUp ? 0.05 : 0))),
        fightsWonSeen: p.fightsWonSeen + (gaveUp ? 1 : 0),
      }),
      'a fight',
    );
    this.settle(target, t);
    this.o.store.update('conflict', (c) => ({ ...c, pairCooldownUntil: { ...c.pairCooldownUntil, [target]: t + this.o.config.pairCooldownSec * 1000 } }), 'fight over');
    // §21.3 growth: every fight survived teaches a little, a win against someone stronger more (capped at +0.25).
    const g = 0.01 + (won && stronger ? 0.01 : 0);
    this.o.store.update('growth', (x) => ({ ...x, combatGrowth: Math.min(0.25, x.combatGrowth + g) }), 'learned from a fight');
    if (won || gaveUp) pushWorkmem(this.o.store, won ? `I beat ${target} in a fight` : `I gave up a fight with ${target}`, 0.7, 'self_observed', { aboutAgent: target, now: t });
    this.o.logger.info({ module: 'conflict', with: target, outcome }, 'fight over');
  }

  /** A fight with them was settled after `since` (their last blow), in the last half minute: they gave up or called
   *  it off, or our duel with them ended. The reflexes leave such a person be until they strike again (§17.6); a
   *  blow just after (a parting blow, a last swing before they knew it was over) is still that fight, not a new one,
   *  but a second is. */
  settled(name: AgentName, since = -Infinity): boolean {
    const at = this.settledAt.get(name);
    return at !== undefined && this.now() - at < 30_000 && since - at < SETTLED_GRACE_MS && (this.blowsSince.get(name) ?? 0) <= 1;
  }

  /** Someone gave up a fight in front of us: the other one won (§17.4 fights won, §21.4 perceived combat). */
  private onSurrender(loser: AgentName, text: string): void {
    if (loser === this.o.me) return;
    const t = this.now();
    if (CALL_OFF_RE.test(text)) this.settle(loser, t);
    if (!SURRENDER_RE.test(text)) return;
    this.settle(loser, t);
    this.surrenderedAt.set(loser, t);
    const fight = [...this.o.store.state.perception.observedActions]
      .reverse()
      .find((a) => a.kind === 'attack' && a.target && t - a.ts < 15_000 && (a.actor === loser || a.target === loser));
    const winner = fight ? (fight.actor === loser ? fight.target : fight.actor) : undefined;
    if (!winner || winner === this.o.me) return;
    this.update(winner, (p) => ({ ...p, fightsWonSeen: p.fightsWonSeen + 1, estCombat: Math.min(1, p.estCombat + 0.05) }), `${winner} won a fight`);
    this.update(loser, (p) => ({ ...p, estCombat: Math.max(0, p.estCombat - 0.05) }), `${loser} lost a fight`);
  }

  private readonly betrayalNoted = new Set<string>();

  /**
   * §17.6: blows on someone who has given up ignore the yield, a wrong that everyone who saw it holds heavily against
   * the attacker (betrayal, at twice its weight), the one beaten most of all.
   */
  private yieldIgnored(attacker: AgentName, victim: AgentName): void {
    const t = this.now();
    const gaveUp = victim === this.o.me ? this.yieldedAt : (this.surrenderedAt.get(victim) ?? -Infinity);
    const since = t - gaveUp;
    if (since < YIELD_HEARD_MS || since > YIELD_IGNORED_MS) return;
    const key = `${attacker}>${victim}@${gaveUp}`;
    if (this.betrayalNoted.has(key)) return;
    this.betrayalNoted.add(key);
    if (this.betrayalNoted.size > 200) this.betrayalNoted.delete(this.betrayalNoted.values().next().value ?? key);
    this.grieve(attacker, 'betrayal', true, victim === this.o.me ? `${attacker} kept hitting me after I gave up` : `${attacker} kept hitting ${victim} after they gave up`, 2 * GRIEVANCE_WEIGHT.betrayal);
    this.o.logger.info({ module: 'conflict', attacker, victim }, 'a yield ignored');
  }

  /** We gave up a fight (our own yield, as heard back from the chat). */
  ownYield(): void {
    this.yieldedAt = this.now();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  private isPerson(name: AgentName): boolean {
    const s = this.o.store.state;
    return Boolean(s.social[name]) || s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === name);
  }

  private update(name: AgentName, f: (p: SocialProfile) => SocialProfile, reason: string): void {
    const s = this.o.store.state;
    const p = s.social[name] ?? newSocialProfile(name, s.self.persona, this.now());
    this.o.store.update('social', (all) => ({ ...all, [name]: f(p) }), reason);
  }

  /** A wrong done to us (§17.2), at its kind's weight unless told otherwise. */
  grieve(name: AgentName, kind: GrievanceKind, witnessed: boolean, note: string, weight?: number): void {
    if (name === this.o.me) return;
    const persona = this.o.store.state.self.persona;
    this.update(name, (p) => withGrievance(p, kind, persona, { now: this.now(), witnessed, source: 'self_observed', note, ...(weight !== undefined ? { weight } : {}) }), `grievance: ${kind}`);
  }

  private provoke(name: AgentName, how: number): void {
    this.provoked.set(name, { at: this.now(), how });
    this.evaluate(name);
  }

  /** §21.3: our own power, with the misjudgment of the less intelligent (overconfident or timid). */
  myPower(): number {
    const s = this.o.store.state;
    const combat = Math.min(1, Math.max(0, s.self.persona.abilities.combat + s.growth.combatGrowth + this.misjudge));
    return powerOf({ gear: this.o.myGear(), killsSeen: 0, fightsWonSeen: 0, followersSeen: 0, healthFrac: s.self.health / 20, combat });
  }

  /** §17.4/§17.5 for one person: power, fear, motive against deterrence, and the rung it comes to. */
  pressureOf(name: AgentName): Pressure {
    const s = this.o.store.state;
    const t = this.now();
    const persona = s.self.persona;
    const temp = persona.temperament;
    const p = s.social[name] ?? newSocialProfile(name, persona, t);
    const them = s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === name);
    const mob = this.o.inMob?.(name) ?? false;
    const mods = mob ? mobModifiers(3) : null;
    const theirPower = powerOf({ gear: p.gearScore, killsSeen: p.killsSeen, fightsWonSeen: p.fightsWonSeen, followersSeen: p.followersSeen, healthFrac: them?.hurtRecently ? 0.6 : 1, combat: p.estCombat });
    // §17.8: those sworn to take them on with us, here now, are our side's strength (and the moment to act).
    const sworn = this.swornAgainst(name);
    const allies = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && sworn.includes(e.name) && e.distance <= ALLIES_NEAR).map((e) => e.name);
    const allyPower = allies.reduce((a, n) => a + this.powerOfName(n), 0);
    const friendsNear = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.name !== name && !allies.includes(e.name) && e.distance <= 10 && (s.social[e.name]?.sentiment ?? 5) >= 7).length;
    const fear = fearOf(theirPower, this.myPower(), 0.1 * friendsNear + allyPower, s.drives.caution) * (mods?.fear ?? 1);
    const alone = them ? !s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name !== name && Math.hypot(e.pos.x - them.pos.x, e.pos.z - them.pos.z) <= 8) : false;
    const prov = this.provoked.get(name);
    const provocationNow = prov && t - prov.at < PROVOCATION_MS ? prov.how * (1 - (t - prov.at) / PROVOCATION_MS) : 0;
    const res = resentment(p, persona, t);
    const m = motive({
      resentment: res,
      aggression: temp.aggression,
      dominance: temp.dominance,
      opportunity: opportunity({ alone, hurt: Boolean(them?.hurtRecently), carryingWanted: false }),
      provocationNow,
      allyCall: allies.length > 0 || t - (this.allyCall.get(name) ?? -Infinity) < PROVOCATION_MS ? 0.3 : 0,
    });
    // Onlookers' liking of them (what we believe it to be) makes going after them costly; those with us are complicit.
    const onlookers = s.perception.nearbyEntities
      .filter((e) => e.kind === 'player' && e.name !== name && !allies.includes(e.name) && e.visible && e.distance <= 16)
      .map((e) => {
        const said = [...s.heardOpinions].reverse().find((o) => o.speaker === e.name && o.target === name);
        return said ? 5 + 5 * said.valence : 5;
      });
    const d = deterrence({ fearOf: fear, caution: s.drives.caution, deathIsPermanent: 1, witnessCost: witnessCost(onlookers) * (mods?.witnessCost ?? 1) });
    const pressure = m - d;
    const current = s.conflict.rungs[name] ?? 0;
    const target = this.o.config.enabled ? rungFor(pressure, current, this.limits(mob)) : 0;
    const paced = target > current && t - (this.escalatedAt.get(name) ?? -Infinity) < ESCALATE_EVERY_MS;
    const rung = target > current ? (paced ? current : current + 1) : target;
    return { pressure, motive: m, deterrence: d, resentment: res, fear, rung };
  }

  private limits(mob: boolean) {
    const t = this.o.store.state.self.persona.temperament;
    return {
      maxRung: this.o.config.maxRung,
      lethalAllowed: this.o.mode !== 'live' || t.vengefulness >= 0.6 || t.dominance >= 0.6,
      ...(mob ? { thresholdShift: mobModifiers(3).rungThreshold } : {}),
    };
  }

  /** How strong someone looks to us (0..1, §17.4), from what we've seen of them. */
  powerOfName(name: AgentName): number {
    const s = this.o.store.state;
    return this.powerOfProfile(s.social[name] ?? newSocialProfile(name, s.self.persona, this.now()));
  }

  /** §17.8: fear of someone faced together with `allies` (their strength on our side), as an uprising would face them. */
  fearWith(name: AgentName, allies: readonly AgentName[]): number {
    const s = this.o.store.state;
    const p = s.social[name] ?? newSocialProfile(name, s.self.persona, this.now());
    const them = s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === name);
    const theirPower = powerOf({ gear: p.gearScore, killsSeen: p.killsSeen, fightsWonSeen: p.fightsWonSeen, followersSeen: p.followersSeen, healthFrac: them?.hurtRecently ? 0.6 : 1, combat: p.estCombat });
    const allyPower = allies.filter((n) => n !== name && n !== this.o.me).reduce((a, n) => a + this.powerOfName(n), 0);
    return fearOf(theirPower, this.myPower(), allyPower, s.drives.caution);
  }

  /** Those who swore to take `name` on with us (§17.8: an open commitment of kind fight, either way round). */
  swornAgainst(name: AgentName): AgentName[] {
    const me = this.o.me;
    return this.o.store.state.commitments
      .filter((c) => c.what.kind === 'fight' && c.what.target === name && c.status === 'accepted' && (c.debtor === me || c.creditor === me))
      .map((c) => (c.debtor === me ? c.creditor : c.debtor))
      .filter((n) => n !== name);
  }

  /** How much we resent someone now (0..1, §17.2). */
  resentmentOf(name: AgentName): number {
    const s = this.o.store.state;
    const p = s.social[name];
    return p ? resentment(p, s.self.persona, this.now()) : 0;
  }

  /** The rung toward someone now (0 when none). */
  rungOf(name: AgentName): number {
    return this.o.store.state.conflict.rungs[name] ?? 0;
  }

  /** Recomputes one person and stores what changed. */
  evaluate(name: AgentName): Pressure {
    const r = this.pressureOf(name);
    const s = this.o.store.state;
    const before = s.conflict.rungs[name] ?? 0;
    this.o.store.update(
      'conflict',
      (c) => ({ ...c, rungs: { ...c.rungs, [name]: r.rung }, lastPressure: { ...c.lastPressure, [name]: Math.round(r.pressure * 100) / 100 } }),
      `pressure on ${name}`,
    );
    const p = s.social[name];
    if (p && (Math.abs(p.fearOf - r.fear) >= 0.05 || Math.abs(p.perceivedPower - this.powerOfProfile(p)) >= 0.05)) {
      this.update(name, (x) => ({ ...x, fearOf: r.fear, perceivedPower: this.powerOfProfile(x) }), 'power and fear');
    }
    if (r.rung > before) this.escalatedAt.set(name, this.now());
    if (r.rung !== before) {
      this.o.logger.info({ module: 'conflict', who: name, rung: r.rung, from: before, pressure: Number(r.pressure.toFixed(2)), motive: Number(r.motive.toFixed(2)), deterrence: Number(r.deterrence.toFixed(2)) }, 'rung changed');
      if (r.rung > before && r.rung >= 1) {
        const what = r.rung >= 3 ? `I've had enough of ${name}` : r.rung === 2 ? `${name} needs to back off` : `I can't stand ${name}`;
        pushWorkmem(this.o.store, what, 0.6, 'self_observed', { aboutAgent: name, now: this.now() });
      }
      this.o.bus.emit({ type: 'rungChanged', name, from: before, to: r.rung });
    }
    return r;
  }

  private powerOfProfile(p: SocialProfile): number {
    return powerOf({ gear: p.gearScore, killsSeen: p.killsSeen, fightsWonSeen: p.fightsWonSeen, followersSeen: p.followersSeen, combat: p.estCombat });
  }

  /** §17.5 code gate for a fight we'd start: null when allowed, else why not. */
  mayFight(target: AgentName, intent: FightIntent, opts: { joining?: boolean } = {}): string | null {
    const s = this.o.store.state;
    const t = this.now();
    // Joining a fight a sworn ally is in with them just now isn't starting one: the pair cooldown doesn't hold it back.
    const joining = opts.joining === true && this.allyInFightWith(target);
    if (!this.o.config.enabled) return 'fighting is off here';
    // Words come before blows: a deliberate fight needs the threats rung first (an impulse doesn't wait).
    if (intent !== 'impulse' && (s.conflict.rungs[target] ?? 0) < 2) return 'it has not come to that yet';
    const r = this.pressureOf(target);
    return gateFight({
      intent,
      pressure: r.pressure,
      lim: this.limits(this.o.inMob?.(target) ?? false),
      cooldownUntil: joining ? 0 : (s.conflict.pairCooldownUntil[target] ?? 0),
      graceUntil: this.o.bornAt + this.o.config.newcomerGraceSec * 1000,
      fightCapReached: this.o.fightCapReached?.() ?? false,
      justYielded: t - (this.surrenderedAt.get(target) ?? -Infinity) < YIELD_STANDS_MS,
      now: t,
    });
  }

  /** One sworn with us against them (§17.8) struck them, or was struck by them, just now (§17.6 groupAttack). */
  allyInFightWith(target: AgentName): boolean {
    const t = this.now();
    const sworn = this.swornAgainst(target);
    return this.o.store.state.perception.observedActions.some(
      (a) => a.kind === 'attack' && t - a.ts < JOIN_MS && ((sworn.includes(a.actor) && a.target === target) || (a.actor === target && a.target !== undefined && sworn.includes(a.target))),
    );
  }

  /** A single impulsive punch (§18.5): the gate at a lower bar. */
  mayPunch(target: AgentName): boolean {
    return this.mayFight(target, 'impulse') === null;
  }

  private tick(): void {
    const s = this.o.store.state;
    const t = this.now();
    const visible = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.distance <= 24).map((e) => e.name);
    for (const n of visible) this.seenAt.set(n, t);
    // People in view, and anyone we hold a rung against who was seen lately (out of sight, it relaxes).
    const names = new Set([...visible, ...Object.keys(s.conflict.rungs).filter((n) => (s.conflict.rungs[n] ?? 0) > 0)]);
    for (const n of names) {
      if (!visible.includes(n) && t - (this.seenAt.get(n) ?? 0) > RUNG_MEMORY_MS) {
        if ((s.conflict.rungs[n] ?? 0) > 0) this.o.store.update('conflict', (c) => ({ ...c, rungs: { ...c.rungs, [n]: 0 } }), `${n} out of sight`);
        continue;
      }
      this.evaluate(n);
    }
    // §17.5 "X comes into sight": someone we're at odds with has just come near (a rung that went up while they were
    // out of reach is acted on now).
    const near = new Set(this.o.store.state.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.distance <= NEAR_BLOCKS).map((e) => e.name));
    for (const n of near) {
      const rung = this.o.store.state.conflict.rungs[n] ?? 0;
      const said = this.nearSaid.get(n);
      if (rung < 1 || this.near.has(n) || (said && rung <= said.rung && t - said.at < NEAR_EVERY_MS)) continue;
      this.nearSaid.set(n, { at: t, rung });
      this.o.bus.emit({ type: 'atOddsNearby', name: n, rung });
    }
    this.near = near;
  }
}
