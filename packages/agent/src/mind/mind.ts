// System 1 and System 2 together (§18.4, §18.5). The gut is the sentiment as it stands, colored by the first
// impression, halo, envy, heat and what people say; the facts are what someone has actually done (the evidence
// track). How much reason wins is the override factor: rational, calm, given time, and not inside a mob. Code uses
// the mix for its own policies (sharing, trading, defending); the CC packet shows both sides in words.

import type { AgentName, AgentState, SocialProfile } from '@agora/shared';
import { effectiveJudgment, envyResentment, haloBonus, heardConsensus, overrideFactor, rationalityOf, susceptibilityToward } from './biases';

export interface MindInputs {
  /** Seconds since the last strong feeling (Feelings). */
  secondsSinceTrigger: () => number;
  /** Anger toward one person right now, 0..1 (Feelings). */
  angerToward: (name: AgentName) => number;
  /** Inside a mob (§18.4.2): reason is suppressed. */
  inCrowd?: () => boolean;
  /** Our own visible gear, 0..1 (for envy). */
  myGear?: () => number;
  now?: () => number;
}

export interface GutAndFacts {
  gut: number;
  facts: number;
  /** lerp(gut, facts, override): what the agent goes by. */
  judgment: number;
  gutWhy: string[];
  factsWhy: string[];
}

export class Mind {
  private readonly now: () => number;

  constructor(
    private readonly state: () => AgentState,
    private readonly i: MindInputs,
  ) {
    this.now = i.now ?? Date.now;
  }

  /** §18.5 override = rationality × (1 − arousal·0.7) × timeFactor × (1 − crowdSuppression). */
  override(): number {
    const s = this.state();
    return overrideFactor(rationalityOf(s), s.emotions.arousal, this.i.secondsSinceTrigger(), this.i.inCrowd?.() ?? false);
  }

  /** How we see someone, both ways, and the mix we act on (0..10). */
  about(name: AgentName): GutAndFacts | null {
    const s = this.state();
    const p = s.social[name];
    if (!p) return null;
    const persona = s.self.persona;
    const bias = persona.mind.biasProfile;
    const ov = this.override();
    const gutWhy: string[] = [];
    let gut = p.sentiment;
    const halo = haloBonus(p.admiration, p.gearScore, susceptibilityToward(s, 'halo', name), persona.mind.vanity, ov) * 10;
    if (halo >= 0.5) {
      gut += halo;
      gutWhy.push(p.admiration > 0.6 ? 'you look up to them' : 'their gear impressed you');
    }
    const envy = envyResentment(p.gearScore, this.i.myGear?.() ?? 0, bias.envy, persona.big5.agreeableness, ov) * 10;
    if (envy >= 0.5) {
      gut -= envy;
      gutWhy.push('you envy their gear');
    }
    const anger = this.i.angerToward(name);
    if (anger >= 0.2) {
      gut -= anger * 3;
      gutWhy.push(anger > 0.6 ? "you're furious with them" : "you're annoyed with them");
    }
    const heard = heardConsensus(s.heardOpinions, name, (spk) => s.social[spk]?.trust ?? 0.5, this.now());
    if (heard !== null && Math.abs(heard - p.sentiment) >= 1.5) gutWhy.push(heard < p.sentiment ? 'people speak badly of them' : 'people speak well of them');
    if (p.anchorCount <= 1 && p.interactions <= 1) gutWhy.push('a first impression');
    gut = clamp10(gut);
    const facts = clamp10(p.evidence);
    return { gut, facts, judgment: clamp10(effectiveJudgment(gut, facts, ov)), gutWhy, factsWhy: factsAbout(p, persona.social.baselineSentiment) };
  }

  /** The mix we act on for sharing, trading and defending (falls back to sentiment for strangers). */
  liking(name: AgentName): number {
    const a = this.about(name);
    return a ? a.judgment : this.state().self.persona.social.baselineSentiment;
  }

  /** GUT/FACTS lines for the CC packet when they disagree enough to matter (§18.5). */
  packetLines(names: readonly AgentName[]): string[] {
    const out: string[] = [];
    for (const n of names) {
      const a = this.about(n);
      if (!a || (Math.abs(a.gut - a.facts) < 1.5 && a.gutWhy.length === 0)) continue;
      out.push(`GUT about ${n}: ${feel(a.gut)}${a.gutWhy.length > 0 ? ` (${a.gutWhy.join('; ')})` : ''}`);
      out.push(`FACTS about ${n}: ${a.factsWhy.length > 0 ? a.factsWhy.join('; ') : 'nothing much has happened between you'}`);
    }
    return out;
  }
}

function clamp10(v: number): number {
  return Math.min(10, Math.max(0, v));
}

function feel(v: number): string {
  return v >= 8 ? 'you really like them' : v >= 6 ? 'you like them' : v > 4 ? 'you feel neutral' : v > 2 ? "you don't like them" : "you can't stand them";
}

function factsAbout(p: SocialProfile, baseline: number): string[] {
  const out: string[] = [];
  const promises = p.promisesKept + p.promisesBroken;
  if (promises > 0) out.push(`kept ${p.promisesKept}/${promises} promises to you`);
  if (p.trust < 0.35) out.push('what they told you has been wrong before');
  else if (p.trust > 0.7) out.push('what they told you has held up');
  const d = p.evidence - baseline;
  if (Math.abs(d) >= 1) out.push(d > 0 ? 'they have done right by you' : 'they have done you wrong');
  return out;
}
