// When an in-flight LLM result is no longer worth using (§4.2 "abort-on-stale"). Danger always aborts: the reflex
// owns the body and the decision would be about a world that is gone. Each module adds its own triggers.

import type { ConvId } from '@agora/shared';
import type { StalePolicy, StateChange } from './store';

/** The bot just got into danger. */
export function dangerStarted(c: StateChange): string | null {
  return c.facet === 'flags' && c.next.flags.inDanger && !c.prev.flags.inDanger ? 'danger' : null;
}

/** Something of ours just broken or opened around us (a wall of our shelter, a hut's door): what was being decided is moot. */
export function oursChanged(c: StateChange): string | null {
  if (c.facet !== 'perception') return null;
  const before = new Set(c.prev.perception.blockChanges);
  const added = c.next.perception.blockChanges.filter((x) => !before.has(x));
  return added.some((x) => x.ours !== undefined && (x.kind === 'broken' || x.kind === 'opened')) ? 'something of yours just changed' : null;
}

/** CC: a new decision from elsewhere (or danger) makes this one moot; lots of perception churn makes it stale. */
export const CC_POLICY: StalePolicy = {
  name: 'cc',
  watch: ['perception', 'conversations', 'option', 'self'],
  maxChanges: 60,
  abortOn: (c) => {
    const d = dangerStarted(c);
    if (d) return d;
    const ours = oursChanged(c);
    if (ours) return ours;
    if (c.facet === 'decision' && c.next.decision?.id !== c.prev.decision?.id) return 'another decision was made';
    return null;
  },
};

/**
 * CC thinking in danger: only the danger being over or another decision makes it moot. A fight churns perception
 * many times a second; counted, it dropped every thought had under fire.
 */
export const CC_UNDER_FIRE_POLICY: StalePolicy = {
  name: 'cc-under-fire',
  watch: [],
  abortOn: (c) => {
    if (c.facet === 'flags' && c.prev.flags.inDanger && !c.next.flags.inDanger) return 'the danger is over';
    if (c.facet === 'decision' && c.next.decision?.id !== c.prev.decision?.id) return 'another decision was made';
    return null;
  },
};

/** Talking: the conversation ended or someone else answered for us. */
export function talkPolicy(convId: ConvId): StalePolicy {
  return {
    name: `talk:${convId}`,
    watch: ['conversations'],
    abortOn: (c) => {
      const d = dangerStarted(c);
      if (d) return d;
      if (c.facet !== 'conversations') return null;
      const conv = c.next.conversations[convId];
      if (!conv || conv.status === 'ended') return 'conversation ended';
      return null;
    },
  };
}

/** Self-Monitor and Social Awareness: summaries tolerate change, but not a flood of it. */
export const SUMMARY_POLICY: StalePolicy = { name: 'summary', watch: ['workmem', 'social'], maxChanges: 25, abortOn: dangerStarted };

/** Goal Gen and Reflection: slow thinking; only danger interrupts. */
export const SLOW_POLICY: StalePolicy = { name: 'slow', watch: [], abortOn: dangerStarted };
