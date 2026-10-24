// Urges (owner request, 2026-10-24): something that went wrong ended by a push the agent takes as its own: a talk
// going round in circles left with a goodbye and a walk, standing stuck walked out of, a task that keeps failing
// given up, a mind that won't settle made up again. The thought goes on its mind as its own; nothing it doesn't
// perceive comes with it. Like a quirk's impulse, it takes over briefly and the CC goes on with the plan after.

import type { AgentName, Logger, Urge } from '@agora/shared';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import type { ActionAwareness } from './awareness';
import type { CognitiveController } from './cc';
import type { SkillExecutor } from './executor';
import type { Talking } from './talking';

export interface UrgeDeps {
  store: AgentStateStore;
  talking: Pick<Talking, 'moveOn'>;
  awareness: Pick<ActionAwareness, 'giveUp'>;
  cc: Pick<CognitiveController, 'impulse' | 'trigger'>;
  executor: Pick<SkillExecutor, 'abort' | 'busy'>;
  logger: Logger;
  now?: () => number;
}

/** How long the people of a talk that went round in circles are let be. */
export const HOLD_OFF_MS = 4 * 60_000;
/** How long a task given up on stays given up. */
export const GIVE_UP_MS = 15 * 60_000;

/** Acts on an urge; says what came of it (for the log). */
export async function applyUrge(d: UrgeDeps, u: Urge): Promise<string> {
  const s = d.store.state;
  // Paused by the operator, or the reflexes have the body: not now.
  if (s.flags.paused) return 'not now: paused';
  if (s.flags.inDanger) return 'not now: in danger';
  const now = d.now?.() ?? Date.now();
  let done: string;
  switch (u.act) {
    case 'move_on': {
      const left: AgentName[] = await d.talking.moveOn({ thought: u.thought, ...(u.say ? { say: u.say } : {}), avoid: u.avoid, holdMs: HOLD_OFF_MS });
      // A walk away from them, then on with whatever comes next.
      const avoid = [...new Set([...u.avoid, ...left])].slice(0, 8);
      const walked = d.cc.impulse({ option: 'work', task: { skill: 'wander', args: { radius: 20, seconds: 40, ...(avoid.length > 0 ? { avoid } : {}) } }, terminate: { maxSeconds: 55 }, rationale: u.thought });
      if (!walked) d.cc.trigger(u.thought, { urgent: true });
      done = `moved on from ${left.join(', ') || 'nobody'}${walked ? ', walking off' : ''}`;
      break;
    }
    case 'wander': {
      pushWorkmem(d.store, u.thought, 0.6, 'self_observed', { now });
      if (d.executor.busy) d.executor.abort('had enough of it');
      const walked = d.cc.impulse({ option: 'work', task: { skill: 'wander', args: { radius: 12, seconds: 30 } }, terminate: { maxSeconds: 45 }, rationale: u.thought });
      if (!walked) d.cc.trigger(u.thought, { urgent: true });
      done = walked ? 'walking a little way' : 'thinking again';
      break;
    }
    case 'drop_task': {
      if (u.task) d.awareness.giveUp(u.task.skill, u.task.item ?? null, u.thought, GIVE_UP_MS);
      pushWorkmem(d.store, u.thought, 0.8, 'self_observed', { now });
      if (d.executor.busy) d.executor.abort('giving up on it');
      d.cc.trigger(u.thought, { urgent: true });
      done = `gave up on ${u.task ? `${u.task.skill}${u.task.item ? ` ${u.task.item}` : ''}` : 'it'}`;
      break;
    }
    case 'rethink':
      pushWorkmem(d.store, u.thought, 0.7, 'self_observed', { now });
      d.cc.trigger(u.thought, { urgent: true });
      done = 'thinking again';
      break;
  }
  d.logger.info({ module: 'urge', act: u.act, thought: u.thought, done }, 'an urge of its own');
  return done;
}
