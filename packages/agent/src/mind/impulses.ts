// Acting on emotion (§18.5 impulse path): when arousal runs high, a quick canned reaction comes before the CC has
// thought it over: an outburst, storming off, refusing to talk, fleeing, or an impulsive gift. A single punch goes
// through the §17 code gate (the conflict core decides whether it may happen). At most one impulse a minute.
// Regret and repair: once calm again, snapping at someone we actually like brings shame, and the agent goes to say
// sorry.

import type { AgentName, ConversationState, DecisionOutput, EmotionState, Logger, Persona, Vec3, Volume } from '@agora/shared';
import type { AgentBus } from '../bus';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import { appraise, topEmotion } from './emotions';
import { isOff } from '../state/switches';

export type Impulse = 'outburst' | 'stormOff' | 'refuseTalk' | 'flee' | 'gift' | 'punch';

/** §18.5: arousal > 0.7 and a roll under impulsivity × arousal; what it becomes follows the strongest feeling. */
export function pickImpulse(e: EmotionState, p: Persona, cause: string, roll: number, canPunch: boolean): Impulse | null {
  if (e.arousal <= 0.7 || roll >= p.mind.impulsivity * e.arousal) return null;
  const top = topEmotion(e)?.name;
  if (top === 'fear') return 'flee';
  if (top === 'anger') {
    if (canPunch && p.temperament.aggression >= 0.5) return 'punch';
    return p.big5.extraversion >= 0.4 || cause === 'insulted' ? 'outburst' : 'stormOff';
  }
  if (top === 'shame' || top === 'sadness') return 'refuseTalk';
  if ((top === 'joy' || top === 'affection') && (cause === 'gift' || cause === 'praised')) return 'gift';
  return null;
}

export interface ImpulsesOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  cc: { impulse(out: DecisionOutput): boolean };
  talking: { blurt(to: AgentName, text: string, volume?: Volume): Promise<boolean>; refuse(name: AgentName, ms: number): void };
  conversations: { withPartner(name: AgentName): ConversationState | undefined; end(convId: string, reason: string): void };
  /** The §17 code gate for a single punch at them (the conflict core); without it, no punches. */
  mayPunch?: (target: AgentName) => boolean;
  rng?: () => number;
  now?: () => number;
}

const LINES: Readonly<Record<'outburst' | 'stormOff' | 'refuseTalk' | 'sorry', readonly string[]>> = {
  outburst: ['excuse me?!', 'say that again, I dare you!', 'watch your mouth!', 'who do you think you are?!', 'how dare you!'],
  stormOff: ["whatever. I'm out of here.", 'forget it.', "ugh, I'm leaving."],
  refuseTalk: ['leave me alone.', 'not now.', "I don't want to talk."],
  sorry: ['hey, sorry about earlier. I lost my temper.', 'sorry for snapping at you before.'],
};

/** Things one hands over on a happy whim. */
const GIFTABLE = /^(bread|apple|cooked_[a-z]+|carrot|poppy|dandelion|[a-z_]+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid)$/;

const COOLDOWN_MS = 60_000;

interface Regret {
  target: AgentName;
  at: number;
  what: Impulse;
}

export class Impulses {
  private lastAt = -Infinity;
  private regrets: Regret[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(private readonly o: ImpulsesOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
  }

  start(): void {
    this.offs.push(this.o.bus.on('felt', (e) => this.onFelt(e.cause, e.by)));
    this.timer = setInterval(() => this.checkRegrets(), 5000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  private pick<T>(xs: readonly T[]): T | undefined {
    return xs[Math.floor(this.rng() * xs.length)];
  }

  private onFelt(cause: string, by?: AgentName): void {
    const s = this.o.store.state;
    if (s.flags.inDanger || isOff(s, 'impulses') || this.now() - this.lastAt < COOLDOWN_MS) return;
    const imp = pickImpulse(s.emotions, s.self.persona, cause, this.rng(), Boolean(by && this.o.mayPunch?.(by)));
    if (!imp) return;
    // Flight needs no target; the rest are aimed at whoever stirred it.
    if (imp !== 'flee' && !by) return;
    this.lastAt = this.now();
    this.o.logger.info({ module: 'impulse', impulse: imp, cause, at: by, arousal: Number(s.emotions.arousal.toFixed(2)) }, 'acted on impulse');
    void this.act(imp, by).catch((err: unknown) => this.o.logger.info({ module: 'impulse', err: String(err) }, 'impulse failed'));
  }

  private async act(imp: Impulse, who?: AgentName): Promise<void> {
    const t = this.now();
    const note = (text: string) => pushWorkmem(this.o.store, text, 0.6, 'self_observed', { ...(who ? { aboutAgent: who } : {}), now: t });
    switch (imp) {
      case 'outburst':
        if (!who) return;
        await this.o.talking.blurt(who, this.pick(LINES.outburst) ?? 'hey!', 'shout');
        this.regrets.push({ target: who, at: t, what: imp });
        note(`I snapped at ${who}`);
        return;
      case 'stormOff': {
        if (!who) return;
        await this.o.talking.blurt(who, this.pick(LINES.stormOff) ?? 'forget it.');
        this.endTalk(who, 'stormed off');
        const away = this.awayFrom(who, 10);
        if (away) this.o.cc.impulse({ option: 'move', target: { pos: away }, terminate: { maxSeconds: 30 }, rationale: `stormed off from ${who}` });
        this.regrets.push({ target: who, at: t, what: imp });
        note(`I stormed off from ${who}`);
        return;
      }
      case 'refuseTalk':
        if (!who) return;
        await this.o.talking.blurt(who, this.pick(LINES.refuseTalk) ?? 'not now.');
        this.o.talking.refuse(who, 60_000);
        this.endTalk(who, 'refused to talk');
        note(`I didn't want to talk to ${who}`);
        return;
      case 'flee':
        this.o.cc.impulse({ option: 'flee', ...(who ? { target: { agent: who } } : {}), terminate: { maxSeconds: 20 }, rationale: 'panicked and ran' });
        note(who ? `I panicked and ran from ${who}` : 'I panicked and ran');
        return;
      case 'gift': {
        if (!who) return;
        const it = this.o.store.state.self.inventory.find((x) => GIFTABLE.test(x.item) && x.qty >= 2);
        if (!it) return;
        this.o.cc.impulse({ option: 'work', target: { agent: who }, task: { skill: 'give', args: { to: who, item: it.item, qty: 1 } }, terminate: { maxSeconds: 60 }, rationale: `so happy I gave ${who} something` });
        note(`I gave ${who} a ${it.item.replace(/_/g, ' ')} on a whim`);
        return;
      }
      case 'punch':
        if (!who) return;
        this.o.cc.impulse({ option: 'fight', target: { agent: who }, task: { skill: 'attack', args: { target: who, seconds: 2 } }, terminate: { maxSeconds: 10 }, rationale: `lost my temper with ${who}` });
        this.regrets.push({ target: who, at: t, what: imp });
        note(`I hit ${who} in a rage`);
        return;
    }
  }

  private endTalk(who: AgentName, reason: string): void {
    const conv = this.o.conversations.withPartner(who);
    if (conv) this.o.conversations.end(conv.convId, reason);
  }

  /** A spot `dist` blocks further from them than we are. */
  private awayFrom(who: AgentName, dist: number): Vec3 | null {
    const s = this.o.store.state;
    const them = s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === who);
    if (!them) return null;
    const me = s.self.pos;
    const dx = me.x - them.pos.x;
    const dz = me.z - them.pos.z;
    const n = Math.hypot(dx, dz) || 1;
    return { x: Math.round(me.x + (dx / n) * dist), y: Math.round(me.y), z: Math.round(me.z + (dz / n) * dist) };
  }

  /** Calm again, and it was someone we like: shame, and a "sorry" (§18.5). Old regrets just fade. */
  private checkRegrets(): void {
    const t = this.now();
    const s = this.o.store.state;
    this.regrets = this.regrets.filter((r) => t - r.at < 30 * 60_000);
    if (s.flags.inDanger || s.emotions.arousal >= 0.3) return;
    const r = this.regrets.find((x) => t - x.at > 30_000 && (s.social[x.target]?.sentiment ?? 5) >= 5);
    if (!r) return;
    this.regrets = this.regrets.filter((x) => x !== r);
    this.o.store.update('emotions', (e) => appraise(e, { kind: 'rejected' }, s.self.persona), 'regret');
    const said = this.o.cc.impulse({
      option: 'talk',
      target: { agent: r.target },
      speechIntent: { stance: 'apologize', gist: `say sorry to ${r.target} for losing your temper earlier`, mayCommit: false },
      terminate: { maxSeconds: 60 },
      rationale: `I regret how I treated ${r.target}`,
    });
    if (said) pushWorkmem(this.o.store, `I felt bad about how I treated ${r.target}`, 0.55, 'self_observed', { aboutAgent: r.target, now: t });
  }
}

export const SORRY_LINES = LINES.sorry;
