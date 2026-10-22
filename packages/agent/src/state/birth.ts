// §19.4 starting knowledge of an agent born in-world: what a human child would have. Its parents and siblings, by
// name, held dear (sentiment 9 and 7, admiration for its parents 0.8), its home, and its family as its in-group (kin).
// No memories are inherited: the family's grudges and history come only from what it is told.

import type { BirthFacts, Persona } from '@agora/shared';
import { newSocialProfile } from './social';
import type { AgentStateStore } from './store';
import { pushWorkmem } from './workmem';

const PARENT_SENTIMENT = 9;
const SIBLING_SENTIMENT = 7;
const PARENT_ADMIRATION = 0.8;

export function applyBirthFacts(store: AgentStateStore, facts: BirthFacts, persona: Persona, now: number): void {
  store.update(
    'family',
    (f) => ({ ...f, parents: facts.parents.map((p) => p.username), siblings: [...facts.siblings], ...(facts.familyName ? { familyName: facts.familyName } : {}) }),
    'born',
  );
  store.update(
    'social',
    (all) => {
      const next = { ...all };
      for (const p of facts.parents) {
        next[p.username] = { ...newSocialProfile(p.username, persona, now), sentiment: PARENT_SENTIMENT, evidence: PARENT_SENTIMENT, trust: 0.9, admiration: PARENT_ADMIRATION, kin: 'parent', perceivedSex: p.sex };
      }
      for (const n of facts.siblings) next[n] = { ...newSocialProfile(n, persona, now), sentiment: SIBLING_SENTIMENT, evidence: SIBLING_SENTIMENT, trust: 0.7, kin: 'sibling' };
      return next;
    },
    'my family',
  );
  const [a, b] = facts.parents;
  if (a && b) pushWorkmem(store, `my parents are ${a.username} and ${b.username}${facts.siblings.length > 0 ? `; my siblings: ${facts.siblings.join(', ')}` : ''}`, 0.9, 'self_observed', { now });
  const h = facts.home;
  if (h) pushWorkmem(store, `home is where my parents' beds are, at ${Math.round(h.x)}, ${Math.round(h.y)}, ${Math.round(h.z)}`, 0.7, 'self_observed', { now });
}
