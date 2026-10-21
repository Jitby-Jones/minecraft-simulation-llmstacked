// A first-meeting social profile (§6.3). Nothing here says whether the person is a bot or a human (§16.1).

import type { AgentName, Persona, SocialProfile, Vec3 } from '@agora/shared';

export function newSocialProfile(name: AgentName, persona: Persona, now: number, pos?: Vec3): SocialProfile {
  return {
    name,
    firstMet: now,
    lastSeen: now,
    lastSeenPos: pos,
    sentiment: persona.social.baselineSentiment,
    trust: 0.5,
    perceivedGoals: [],
    facts: [],
    summary: '',
    promisesKept: 0,
    promisesBroken: 0,
    interactions: 0,
    friction: 0,
    grievances: [],
    perceivedPower: 0.5,
    fearOf: 0,
    admiration: 0,
    anchorCount: 0,
    perceivedSex: 'unknown',
    romanticInterest: 0,
    relationship: 'none',
    kin: null,
    estCombat: 0.4,
    estIntelligence: 0.5,
    estTraits: {},
    gearScore: 0,
    killsSeen: 0,
    fightsWonSeen: 0,
    followersSeen: 0,
    companions: [],
  };
}
