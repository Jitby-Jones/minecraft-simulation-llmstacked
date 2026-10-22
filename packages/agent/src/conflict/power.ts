// Power structures (§17.7, §17.8), all code. What this agent sees of who goes about with whom (followers make a
// leader stronger), whom it follows itself (after giving in twice, or for protection), who it believes resents
// whom (from what people say and from the wrongs it sees done), and when those who resent someone together could
// take them on: the coalition, weighed against the target's power and followers. A follower whose leader is set
// upon by a group picks a side then and there: it stands by the leader, or walks away.

import { type AgentName, type Logger, type SocialProfile, openingName } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { companionsOf, defects, follows, looksLikeLeader, parseDemand } from './coercion';
import { fearOf } from './pressure';

/** Within this, two people are together. */
const TOGETHER = 6;
/** Sightings older than this say nothing about who goes about with whom now. */
const SIGHTING_MS = 5 * 60_000;
/** What people say about someone, and the wrongs seen done, count this long. */
const GRUDGE_MS = 60 * 60_000;
/** Giving in to someone counts toward following them this long. */
const COMPLIED_MS = 60 * 60_000;
/**
 * Blows on the leader by two or more people within this make a group setting upon them (§17.8 side-taking): an
 * uprising's blows come over tens of seconds, one rebel after another, not all at once.
 */
const SET_UPON_MS = 60_000;
/** Each follower adds this much to how strong someone is, against a coalition (§17.8 k). */
export const FOLLOWER_WEIGHT = 0.25;
/** In live mode an uprising needs a bigger margin: death is for real (§17.8). */
export const LIVE_MARGIN = 1.3;
/** A line from someone this soon after a demand of them is their answer to it (§17.7). */
const ANSWER_MS = 60_000;
/** Blows on someone this close together are one wrong (a beating), however many land. */
const WRONG_MERGE_MS = 10_000;
/** Seen alone or hurt: the moment to rise against them lasts this long (§17.8). */
const OPENING_MS = 2 * 60_000;
/** Resentment enough to rally others (§17.8, as mayRally): a moment against them is worth stopping work for. */
const OPENING_RESENTMENT = 0.5;
/** A blow of ours or an ally's this recent explains the target's hurt. */
const OUR_BLOW_MS = 5000;
/** Giving in to a demand ("Rex, fine. I'll give you 3 bread"). */
const GIVE_IN_RE = /\b(i'?ll give (it to )?you|here,? take (it|them)|you can have (it|them))\b/i;
/** Standing up to one ("get lost.", "no. get your own"). */
const REFUSE_RE =
  /\b(no|nope|not giving|get lost|leave me alone|keep your distance|back off|go away|forget it|make me|get your own|don'?t push me|or we fight|or else|what do you want)\b/i;

export interface PowerWatchOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  mode: 'test' | 'live';
  /** Perceived power of someone (0..1) and our own, from the conflict evaluator. */
  powerOf: (name: AgentName) => number;
  myPower: () => number;
  fearOf: (name: AgentName) => number;
  /** How much we resent someone (0..1): a moment against one we resent enough wakes the CC. */
  resentmentOf?: (name: AgentName) => number;
  now?: () => number;
}

function withoutAllegiance(p: SocialProfile): SocialProfile {
  const q = { ...p };
  delete q.allegiance;
  return q;
}

export interface Coalition {
  target: AgentName;
  members: AgentName[];
  power: number;
  /** How strong the target is with its followers (× the live margin). */
  against: number;
  /** The target was seen alone or hurt just now. */
  opening: boolean;
}

export class PowerWatch {
  private readonly sightings = new Map<AgentName, { with: AgentName[]; at: number }[]>();
  /** Who said what about whom, or was seen wronged by whom: resenter → target → when. */
  private readonly grudges = new Map<AgentName, Map<AgentName, number>>();
  /** How often each was seen wronged by whom ("resenter>target" → when, a beating counted once). */
  private readonly wrongs = new Map<string, number[]>();
  /** Who was seen hitting whom lately: target → attacker → when. */
  private readonly blows = new Map<AgentName, Map<AgentName, number>>();
  private following: AgentName | null = null;
  /** Whom we walked away from, and when: a defection sticks for the hour. */
  private readonly left = new Map<AgentName, number>();
  /** A demand made of someone, overheard: who made it, and when. */
  private readonly asked = new Map<AgentName, { by: AgentName; at: number }>();
  /** Who was seen giving in to whom, and who standing up to whom (refusing them, striking them): person → them → when. */
  private readonly gaveIn = new Map<AgentName, Map<AgentName, number>>();
  private readonly defied = new Map<AgentName, Map<AgentName, number>>();
  /** When someone was last seen alone or hurt. */
  private readonly openings = new Map<AgentName, number>();
  /** When we last woke the CC for a moment against each person. */
  private readonly toldOpening = new Map<AgentName, number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: PowerWatchOptions) {
    this.now = o.now ?? Date.now;
    // Whom we follow is kept on their profile (allegiance 'leader'), so it survives a restart.
    this.following = Object.values(o.store.state.social).find((p) => p.allegiance === 'leader')?.name ?? null;
  }

  start(): void {
    const b = this.o.bus;
    // Wrongs seen: an attack, a demand made of someone. The wronged resent the wrongdoer.
    this.offs.push(
      b.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind !== 'attack' || !a.target || a.target === a.actor) return;
        const per = this.blows.get(a.target) ?? new Map<AgentName, number>();
        per.set(a.actor, this.now());
        this.blows.set(a.target, per);
        if (a.target !== this.o.me) this.grudge(a.target, a.actor);
        if (a.actor !== this.o.me) this.mark(this.defied, a.actor, a.target);
      }),
    );
    this.offs.push(
      b.on('heard', (e) => {
        const u = e.utterance;
        if (u.from === this.o.me) return;
        // A demand made of someone else, overheard: they will resent it. It is made of whomever it names first
        // ("Ann, give me 3 bread, or else").
        const named = openingName(u.text);
        const target = Array.isArray(u.to) ? u.to[0] : named ? Object.keys(this.o.store.state.social).find((n) => n.toLowerCase() === named.toLowerCase()) : undefined;
        if (target && target !== this.o.me && parseDemand(u.text)) {
          this.grudge(target, u.from);
          this.asked.set(target, { by: u.from, at: this.now() });
        }
        // Their answer to a demand made of them: giving in, or standing up to the one who made it.
        const a = this.asked.get(u.from);
        if (a && this.now() - a.at < ANSWER_MS) {
          const how = GIVE_IN_RE.test(u.text) ? this.gaveIn : REFUSE_RE.test(u.text) ? this.defied : null;
          if (how) {
            this.mark(how, u.from, a.by);
            this.asked.delete(u.from);
          }
        }
      }),
    );
    this.timer = setInterval(() => this.tick(), 10_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  private mark(m: Map<AgentName, Map<AgentName, number>>, who: AgentName, them: AgentName): void {
    if (who === them) return;
    const per = m.get(who) ?? new Map<AgentName, number>();
    per.set(them, this.now());
    m.set(who, per);
  }

  /**
   * §17.8 "believe willing": one seen giving in to `target` since they last stood up to them (refused them, struck
   * them, spoke against them) is not counted on to rise against them.
   */
  believedWilling(name: AgentName, target: AgentName): boolean {
    const gave = this.gaveIn.get(name)?.get(target);
    if (gave === undefined) return true;
    const said = this.o.store.state.heardOpinions.filter((o) => o.speaker === name && o.target === target && o.valence <= -0.3).reduce((a, o) => Math.max(a, o.ts), -Infinity);
    return Math.max(this.defied.get(name)?.get(target) ?? -Infinity, said) > gave;
  }

  private grudge(resenter: AgentName, target: AgentName): void {
    if (resenter === target) return;
    const t = this.now();
    const per = this.grudges.get(resenter) ?? new Map<AgentName, number>();
    // Blows a few seconds apart are one beating.
    if (t - (per.get(target) ?? -Infinity) > WRONG_MERGE_MS) this.wrongs.set(`${resenter}>${target}`, [...(this.wrongs.get(`${resenter}>${target}`) ?? []), t].slice(-20));
    per.set(target, t);
    this.grudges.set(resenter, per);
  }

  /** How many wrongs we saw `target` do to `name` this past hour (§17.8: the most wronged are the likeliest to rise). */
  wrongsSeen(name: AgentName, target: AgentName): number {
    const t = this.now();
    return (this.wrongs.get(`${name}>${target}`) ?? []).filter((at) => t - at < GRUDGE_MS).length;
  }

  /** People we believe resent `target`: they said so (heard opinions), or we saw them wronged by `target`. */
  knownResenters(target: AgentName): AgentName[] {
    const t = this.now();
    const out = new Set<AgentName>();
    for (const o of this.o.store.state.heardOpinions) {
      if (o.target === target && o.valence <= -0.3 && t - o.ts < GRUDGE_MS && o.speaker !== target && o.speaker !== this.o.me) out.add(o.speaker);
    }
    for (const [who, per] of this.grudges) {
      const at = per.get(target);
      if (at !== undefined && t - at < GRUDGE_MS && who !== this.o.me && who !== target) out.add(who);
    }
    return [...out];
  }

  /** Someone we follow (§17.7), or null. */
  leader(): AgentName | null {
    return this.following;
  }

  /** Who a person was seen going about with lately. */
  companions(name: AgentName): AgentName[] {
    const t = this.now();
    return companionsOf((this.sightings.get(name) ?? []).filter((x) => t - x.at < SIGHTING_MS));
  }

  /**
   * §17.8 coalitionPower against `target`: us and the trusted who resent them too and are believed willing, against
   * their power and followers. The most wronged by the target come first, then those who stood up to them most
   * lately: they're the likeliest to rise.
   */
  coalition(target: AgentName): Coalition {
    const s = this.o.store.state;
    const t = this.now();
    const stoodUp = (n: AgentName) => this.defied.get(n)?.get(target) ?? -Infinity;
    const members = this.knownResenters(target)
      .filter((n) => {
        const p = s.social[n];
        return p && p.trust >= 0.5 && t - p.lastSeen < 30 * 60_000 && p.allegiance !== 'leader' && !this.companions(target).includes(n) && this.believedWilling(n, target);
      })
      .sort((a, b) => this.wrongsSeen(b, target) - this.wrongsSeen(a, target) || (stoodUp(a) === stoodUp(b) ? 0 : stoodUp(b) > stoodUp(a) ? 1 : -1));
    const power = this.o.myPower() + members.reduce((a, n) => a + this.o.powerOf(n), 0);
    const followers = s.social[target]?.followersSeen ?? 0;
    const against = (this.o.powerOf(target) + followers * FOLLOWER_WEIGHT) * (this.o.mode === 'live' ? LIVE_MARGIN : 1);
    const them = s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === target);
    const alone = them
      ? !s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name !== target && !members.includes(e.name) && Math.hypot(e.pos.x - them.pos.x, e.pos.z - them.pos.z) <= TOGETHER)
      : false;
    // Hurt by something other than us (one of us at them in a fight they're winning is no weakness of theirs).
    const ourBlow = [...(this.blows.get(target) ?? new Map<AgentName, number>())].some(([n, at]) => (n === this.o.me || members.includes(n)) && t - at < OUR_BLOW_MS);
    const hurt = Boolean(them?.hurtRecently) && !ourBlow;
    // Seen alone or hurt: the moment lasts a while (time to call on the others), not just while it's so.
    if (them && (alone || hurt)) this.openings.set(target, t);
    return { target, members, power, against, opening: t - (this.openings.get(target) ?? -Infinity) < OPENING_MS };
  }

  /**
   * The reflex asks before it defends our leader (§17.7 followers defend X). Set upon by a group, a follower picks a
   * side (§17.8): loyalty, fondness and fear of the leader against fear of the attackers. Walking away ends following.
   */
  standsBy(leader: AgentName): boolean {
    if (this.following !== leader) return false;
    const t = this.now();
    const attackers = [...(this.blows.get(leader) ?? new Map<AgentName, number>())].filter(([n, at]) => n !== this.o.me && t - at < SET_UPON_MS).map(([n]) => n);
    if (attackers.length < 2) return true;
    const s = this.o.store.state;
    const coalition = attackers.reduce((a, n) => a + this.o.powerOf(n), 0);
    const fearOfCoalition = fearOf(coalition, this.o.myPower(), 0, s.drives.caution);
    const go = defects({
      loyalty: s.self.persona.temperament.loyalty,
      sentiment: s.social[leader]?.sentiment ?? 5,
      fearOfLeader: this.o.fearOf(leader),
      fearOfCoalition,
    });
    if (!go) return true;
    this.leave(leader, `${attackers.join(' and ')} set upon ${leader}`);
    this.o.logger.info({ module: 'conflict', leader, attackers, fearOfCoalition: Number(fearOfCoalition.toFixed(2)) }, 'defected');
    this.o.bus.emit({ type: 'defected', from: leader, attackers });
    return false;
  }

  private tick(): void {
    const s = this.o.store.state;
    const t = this.now();
    // Who goes about with whom (§17.7): a person's companions are those near them in 3 of the last 4 sightings.
    const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player' && e.visible);
    for (const p of people) {
      const near = people.filter((q) => q.name !== p.name && Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y, q.pos.z - p.pos.z) <= TOGETHER).map((q) => q.name);
      if (Math.hypot(s.self.pos.x - p.pos.x, s.self.pos.z - p.pos.z) <= TOGETHER) near.push(this.o.me);
      const ring = [...(this.sightings.get(p.name) ?? []), { with: near, at: t }].slice(-4);
      this.sightings.set(p.name, ring);
    }
    // Followers of X: people who go about with X and are weaker than X (the stronger is the one followed).
    const followers = new Map<AgentName, number>();
    for (const [name] of this.sightings) {
      for (const c of this.companions(name)) {
        if (c === this.o.me || this.o.powerOf(c) <= this.o.powerOf(name)) continue;
        followers.set(c, (followers.get(c) ?? 0) + 1);
      }
    }
    for (const name of Object.keys(s.social)) {
      const n = followers.get(name) ?? 0;
      const p = s.social[name];
      if (!p || p.followersSeen === n) continue;
      this.o.store.update(
        'social',
        (all) => {
          const q = all[name];
          if (!q) return all;
          const next: SocialProfile = { ...q, followersSeen: n };
          if (looksLikeLeader(n, 0)) next.perceivedRole = 'leader';
          else if (q.perceivedRole === 'leader') delete next.perceivedRole;
          return { ...all, [name]: next };
        },
        `${name} has ${n} followers`,
      );
    }
    for (const [target, per] of this.blows) {
      for (const [n, at] of per) if (t - at > SET_UPON_MS * 4) per.delete(n);
      if (per.size === 0) this.blows.delete(target);
    }
    // §17.8: one we resent, seen alone or hurt, with others who resent them too: the moment is told once, even mid-task.
    const resentment = this.o.resentmentOf;
    if (resentment) {
      for (const p of people) {
        if (p.name === this.following || resentment(p.name) < OPENING_RESENTMENT || t - (this.toldOpening.get(p.name) ?? -Infinity) < OPENING_MS) continue;
        const c = this.coalition(p.name);
        if (!c.opening || c.members.length === 0) continue;
        this.toldOpening.set(p.name, t);
        this.o.bus.emit({ type: 'opening', name: p.name });
      }
    }
    this.chooseLeader(t);
  }

  /** §17.7: follow X after giving in to X twice in the last hour, or for protection; stop when it no longer holds. */
  private chooseLeader(t: number): void {
    const s = this.o.store.state;
    const others = Object.values(s.social).filter((p) => p.name !== this.o.me);
    let best: { name: AgentName; score: number } | null = null;
    for (const p of others) {
      const complied = s.commitments.filter((c) => c.coerced && c.debtor === this.o.me && c.creditor === p.name && c.status === 'fulfilled' && t - (c.resolvedAt ?? 0) < COMPLIED_MS).length;
      const fearOfOthers = Math.max(0, ...others.filter((q) => q.name !== p.name).map((q) => this.o.fearOf(q.name)));
      const power = this.o.powerOf(p.name);
      if (!follows({ complied, fear: this.o.fearOf(p.name), fearOfOthers, sentiment: p.sentiment, power })) continue;
      const score = complied + power;
      if (!best || score > best.score) best = { name: p.name, score };
    }
    const next = best?.name ?? null;
    if (next === this.following) return;
    // Having walked away from someone, we don't go back to them this hour (a defection sticks).
    if (next && t - (this.left.get(next) ?? -Infinity) < COMPLIED_MS) return;
    const before = this.following;
    if (before) this.leave(before, `no longer following ${before}`);
    if (!next) return;
    this.following = next;
    this.o.store.update('social', (all) => {
      const is = all[next];
      return is ? { ...all, [next]: { ...is, allegiance: 'leader' } } : all;
    }, `following ${next}`);
    this.o.logger.info({ module: 'conflict', leader: next, before }, 'following');
    this.o.bus.emit({ type: 'leaderChanged', leader: next, before });
  }

  private leave(leader: AgentName, why: string): void {
    this.following = null;
    this.left.set(leader, this.now());
    this.o.bus.emit({ type: 'leaderChanged', leader: null, before: leader });
    this.o.store.update(
      'social',
      (all) => {
        const was = all[leader];
        return was ? { ...all, [leader]: withoutAllegiance(was) } : all;
      },
      why,
    );
  }
}
