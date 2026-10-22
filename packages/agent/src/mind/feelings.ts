// Feelings (§18.2): the emotion engine, all code. Appraisal turns what happens into emotion deltas: being hit,
// insulted, threatened, praised or turned down; a gift; a death; a goal reached; failing over and over; a rival's
// success. The tone of speech nearby spreads (contagion, scaled by conformity × extraversion). Everything decays
// toward the mood baseline, and mood follows slowly. Anger is also kept per person ("heat"), which the impulse
// path, the mob check and the conflict core read. An apology from someone we're angry at may cool it.

import { type AgentName, type EmotionName, type EmotionState, type Logger, type Utterance, mentionsName } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { type AppraisalEvent, appraise, contagion, decayEmotions, updateMood } from './emotions';

export interface FeelingsOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** Inside a mob, anger spreads half again as fast (§18.4.2). */
  contagionScale?: () => number;
  tickMs?: number;
  rng?: () => number;
  now?: () => number;
}

export const INSULT_RE =
  /\b(idiot|stupid|dumb|moron|shut up|liar|thief|useless|go away|get lost|loser|jerk|ugly|lazy|coward|pathetic|weakling|freak|creep|you suck|hate you|nobody likes you)\b/i;
export const PRAISE_RE = /\b(thanks|thank you|good job|great job|well done|nice one|you'?re (?:great|awesome|the best|amazing|a star|a hero|so kind)|i like you|appreciate (?:it|you))\b/i;
export const THREAT_RE = /\b(i'?ll (?:kill|hurt|get|end|smash|beat) you|you'?re dead|watch your back|or else|you'?ll regret|i'?m coming for you|back off)\b/i;
export const APOLOGY_RE = /\b(sorry|my bad|apologi[sz]e|forgive me|didn'?t mean (?:it|that))\b/i;
const REFUSAL_RE = /^\W*(no\b|nah\b|nope\b|sorry\b|not now\b|can'?t\b|won'?t\b|no thanks|not happening)/i;

/** The feel of a line heard nearby (§18.2 contagion): code, cheap. */
const TONE: readonly { re: RegExp; feel: Partial<Record<EmotionName, number>> }[] = [
  { re: /!!|\b(damn|furious|angry|get (?:him|her|them)|attack|kill)\b/i, feel: { anger: 0.6 } },
  { re: /\b(help|run|watch out|look out|creeper|scared|danger)\b/i, feel: { fear: 0.6 } },
  { re: /\b(yay|wo+hoo+|haha+|lol|so happy|hooray)\b|:\)/i, feel: { joy: 0.5 } },
  { re: /\b(sad|crying|so sorry|miss (?:him|her|them))\b|:\(/i, feel: { sadness: 0.4 } },
];

const HEAT_HALF_LIFE_MS = 90_000;
/** A blow this recent means we're in a fight (§21.3 arousal cap). */
const FIGHT_MS = 10_000;
const STOP_WORDS = new Set(['being', 'called', 'getting', 'seen', 'as', 'the', 'and', 'that', 'with', 'from', 'about']);

/** Words of a known insecurity ("being called lazy" → lazy) that an insult can hit. */
export function insecurityWords(insecurities: readonly string[]): string[] {
  return insecurities.flatMap((s) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w)));
}

export class Feelings {
  private readonly heat = new Map<AgentName, { v: number; ts: number }>();
  private readonly insultedAt = new Map<AgentName, number>();
  private readonly askedAt = new Map<AgentName, number>();
  private lastFightSeen = 0;
  private hitAt = -Infinity;
  private lastTick = 0;
  private triggerAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: FeelingsOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const b = this.o.bus;
    this.lastTick = this.now();
    this.offs.push(b.on('attacked', (e) => e.damage > 0 && this.feel({ kind: 'attacked', damage: e.damage }, e.by && this.isPerson(e.by) ? e.by : null, 0.5)));
    this.offs.push(b.on('addressed', (e) => this.onLine(e.utterance, true)));
    this.offs.push(b.on('overheard', (e) => this.onLine(e.utterance, false)));
    // The L2 read of a whole conversation can find an insult the line check missed.
    this.offs.push(
      b.on('insulted', (e) => {
        if (this.now() - (this.insultedAt.get(e.by) ?? -Infinity) > 60_000) this.feel({ kind: 'insulted', hitsInsecurity: false }, e.by, 0.4);
      }),
    );
    this.offs.push(
      b.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind === 'gave' && a.target === this.o.me) {
          this.feel({ kind: 'gift' }, null, 0);
          this.cool(a.actor, 0.3);
        }
        // Someone else getting hurt nearby: a fight is going on.
        if (a.kind === 'hurt' && a.actor !== this.o.me && this.now() - this.lastFightSeen > 30_000) {
          this.lastFightSeen = this.now();
          this.feel({ kind: 'witnessedFight' }, null, 0);
        }
      }),
    );
    this.offs.push(b.on('peerDied', (e) => this.feel({ kind: 'peerDied', sentiment: this.o.store.state.social[e.name]?.sentiment ?? 5, nearby: e.witnessed }, null, 0)));
    this.offs.push(b.on('goalDone', () => this.feel({ kind: 'goalAchieved' }, null, 0)));
    this.offs.push(b.on('stuck', () => this.feel({ kind: 'repeatedFailure' }, null, 0)));
    this.offs.push(
      b.on('decision', (e) => {
        const d = e.decision;
        if (d.speechIntent?.stance === 'ask' && d.target?.agent) this.askedAt.set(d.target.agent, this.now());
      }),
    );
    // A rival's success stings (envy), by how little we like them.
    this.offs.push(
      b.on('systemEvent', (e) => {
        const ev = e.event;
        if (ev.kind !== 'advancement' || !ev.subject || ev.subject === this.o.me) return;
        if ((this.o.store.state.social[ev.subject]?.sentiment ?? 5) < 4) this.feel({ kind: 'rivalSucceeded' }, null, 0);
      }),
    );
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? 2000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** Anger toward one person, 0..1, cooling with time (the neurotic stay angry longer). */
  angerToward(name: AgentName): number {
    const h = this.heat.get(name);
    if (!h) return 0;
    const linger = 1 + this.o.store.state.self.persona.big5.neuroticism;
    return h.v * 0.5 ** ((this.now() - h.ts) / (HEAT_HALF_LIFE_MS * linger));
  }

  /** People we're angry at right now, angriest first. */
  grudges(min = 0.2): { name: AgentName; anger: number }[] {
    return [...this.heat.keys()]
      .map((name) => ({ name, anger: this.angerToward(name) }))
      .filter((g) => g.anger >= min)
      .sort((a, b) => b.anger - a.anger);
  }

  /** Seconds since the last strong feeling (the override's timeFactor, §18.5). */
  secondsSinceTrigger(): number {
    return this.triggerAt === 0 ? 3600 : (this.now() - this.triggerAt) / 1000;
  }

  private isPerson(name: AgentName): boolean {
    const s = this.o.store.state;
    return Boolean(s.social[name]) || s.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === name);
  }

  private onLine(u: Utterance, addressed: boolean): void {
    const s = this.o.store.state;
    if (u.from === this.o.me) return;
    const t = this.now();
    if (addressed) {
      // "Bram is a thief", said to us, is gossip about Bram; the same word without another name is aimed at us.
      const aboutSomeoneElse = Object.keys(s.social).some((n) => n !== this.o.me && n !== u.from && mentionsName(u.text, n));
      if (INSULT_RE.test(u.text) && !aboutSomeoneElse) {
        this.insultedAt.set(u.from, t);
        const sore = insecurityWords(s.self.persona.insecurities).some((w) => u.text.toLowerCase().includes(w));
        this.feel({ kind: 'insulted', hitsInsecurity: sore }, u.from, 0.45);
      } else if (THREAT_RE.test(u.text)) {
        this.feel({ kind: 'threatened' }, u.from, 0.4);
      } else if (PRAISE_RE.test(u.text)) {
        this.feel({ kind: 'praised' }, null, 0);
        this.cool(u.from, 0.2);
      }
      if (APOLOGY_RE.test(u.text)) this.onApology(u.from);
      const asked = this.askedAt.get(u.from);
      if (asked !== undefined && t - asked < 60_000 && REFUSAL_RE.test(u.text)) {
        this.askedAt.delete(u.from);
        this.feel({ kind: 'rejected' }, u.from, 0);
      }
    }
    // §18.2 contagion: the feel of what's said nearby rubs off.
    const crowd: Partial<Record<EmotionName, number>> = {};
    for (const { re, feel } of TONE) if (re.test(u.text)) Object.assign(crowd, feel);
    if (Object.keys(crowd).length > 0) this.write(this.capped(contagion(s.emotions, crowd, s.self.persona, this.o.contagionScale?.() ?? 1)), 'mood of the room');
  }

  /** An apology may cool our anger at them, less so for the vengeful (§18.5 regret and repair). */
  private onApology(from: AgentName): void {
    if (this.angerToward(from) < 0.05) return;
    const p = this.o.store.state.self.persona;
    const roll = this.o.rng?.() ?? Math.random();
    if (roll < 1 - p.temperament.vengefulness * 0.8) this.cool(from, 1);
  }

  private feel(ev: AppraisalEvent, who: AgentName | null, heat: number): void {
    const s = this.o.store.state;
    if (ev.kind === 'attacked') this.hitAt = this.now();
    const next = this.capped(appraise(s.emotions, ev, s.self.persona, this.combat()));
    this.write(next, `felt: ${ev.kind}`);
    if (who && heat > 0) this.heatUp(who, heat * (0.5 + s.self.persona.big5.neuroticism));
    if (next.arousal >= 0.5) this.triggerAt = this.now();
    this.o.bus.emit({ type: 'felt', cause: ev.kind, ...(who ? { by: who } : {}), arousal: next.arousal });
  }

  private heatUp(name: AgentName, d: number): void {
    this.heat.set(name, { v: Math.min(1, this.angerToward(name) + d), ts: this.now() });
  }

  private cool(name: AgentName, d: number): void {
    const v = this.angerToward(name);
    if (v > 0) this.heat.set(name, { v: Math.max(0, v - d), ts: this.now() });
  }

  /** Fighting ability with growth (§21.3). */
  private combat(): number {
    const s = this.o.store.state;
    return Math.min(1, s.self.persona.abilities.combat + s.growth.combatGrowth);
  }

  /** §21.3: in a fight, arousal stays under 1 − 0.5·combat, so a skilled fighter keeps thinking instead of panicking. */
  private capped(e: EmotionState): EmotionState {
    const fighting = this.o.store.state.option?.option === 'fight' || this.now() - this.hitAt < FIGHT_MS;
    const cap = 1 - 0.5 * this.combat();
    return fighting && e.arousal > cap ? { ...e, arousal: cap } : e;
  }

  private write(e: EmotionState, reason: string): void {
    this.o.store.update('emotions', () => e, reason);
  }

  private tick(): void {
    const t = this.now();
    const dt = t - this.lastTick;
    this.lastTick = t;
    const s = this.o.store.state;
    const e = this.capped(decayEmotions(s.emotions, dt, s.self.persona, s.mood));
    // Only write when something visibly moved: the state version stays meaningful.
    const moved = (Object.keys(e) as (keyof EmotionState)[]).some((k) => Math.abs(e[k] - s.emotions[k]) >= 0.005);
    if (moved) this.write(e, 'feelings fade');
    const mood = updateMood(s.mood, e, dt);
    if (Math.abs(mood.valence - s.mood.valence) >= 0.002) this.o.store.update('mood', () => mood, 'mood');
    for (const [name] of this.heat) if (this.angerToward(name) < 0.01) this.heat.delete(name);
  }
}
