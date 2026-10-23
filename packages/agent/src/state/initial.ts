// A fresh Agent State for a persona (§4.1). Perception fills `self` within the first tick after spawn.

import type { AgentState, Persona } from '@agora/shared';

export interface InitialStateOptions {
  persona: Persona;
  username: string;
  now?: number;
  /** Born in-world (§19.5) rather than spawned as a founder. */
  born?: boolean;
  youthUntil?: number;
}

export function createInitialState(o: InitialStateOptions): AgentState {
  const now = o.now ?? Date.now();
  const p = o.persona;
  return {
    version: 0,
    self: {
      name: p.name,
      username: o.username,
      persona: p,
      pos: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      oxygen: 20,
      inventory: [],
      equipped: null,
      armor: [],
      dimension: 'overworld',
      time: 0,
      isDay: true,
      lightLevel: 15,
      isSleeping: false,
      spawnPos: null,
    },
    perception: { nearbyEntities: [], nearbyBlocksOfInterest: [], heardSpeech: [], observedActions: [], systemEvents: [] },
    workmem: [],
    selfSummary: '',
    goals: { life: [...p.lifeGoals], current: null, plan: null, social: [], history: [] },
    village: { home: null, chest: null, huts: [], board: null, signs: [], threats: [], finds: [] },
    decision: null,
    option: null,
    taskQueue: [],
    commitments: [],
    social: {},
    conversations: {},
    actionLog: [],
    flags: { inDanger: false, stuck: false, busyLevel: 'idle', busySpeech: null, codeOnly: false, degrade: 0, inCrowd: false },
    drives: { caution: p.drives.caution, cautionBaseline: p.drives.caution, brakeShift: 0, brakeUntil: 0 },
    emotions: { anger: 0, fear: 0, joy: 0, sadness: 0, disgust: 0, shame: 0, envy: 0, affection: 0, arousal: 0 },
    mood: { valence: 0, baselineShift: 0 },
    heardOpinions: [],
    knowledge: { recipes: [], seenItems: [] },
    conflict: { rungs: {}, lastPressure: {}, pairCooldownUntil: {}, activeFight: null },
    family: { parents: [], children: [], siblings: [], familyName: p.familyName, advances: {} },
    life: { born: o.born ?? false, startedAt: now, youthUntil: o.youthUntil ?? 0, deaths: 0 },
    growth: { rationalityBonus: 0, conformityBonus: 0, combatGrowth: 0, selfCorrections: 0, mobParticipations: 0 },
    traitAnnotations: [],
    inoculation: {},
  };
}
