// Working memory (§4.7): about five items, newest on mind. Overflow goes to the memory module (M4) through the
// `workmemOverflow` hook; until then the oldest item simply drops.

import type { AgentName, MemorySource, WorkItem } from '@agora/shared';
import type { AgentStateStore } from './store';

export const WORKMEM_SIZE = 5;

let seq = 0;

export function pushWorkmem(
  store: AgentStateStore,
  text: string,
  salience: number,
  source: MemorySource = 'self_observed',
  opts: { aboutAgent?: AgentName; now?: number; onOverflow?: (dropped: WorkItem[]) => void } = {},
): WorkItem {
  const item: WorkItem = {
    id: `w${(opts.now ?? Date.now()).toString(36)}${(seq++).toString(36)}`,
    text: text.slice(0, 240),
    ts: opts.now ?? Date.now(),
    salience: Math.min(1, Math.max(0, salience)),
    source,
    ...(opts.aboutAgent ? { aboutAgent: opts.aboutAgent } : {}),
  };
  let dropped: WorkItem[] = [];
  store.update(
    'workmem',
    (w) => {
      // The same note twice in a row just refreshes it.
      const rest = w.filter((x) => x.text !== item.text);
      const all = [...rest, item];
      dropped = all.slice(0, Math.max(0, all.length - WORKMEM_SIZE));
      return all.slice(-WORKMEM_SIZE);
    },
    'workmem',
  );
  if (dropped.length > 0) opts.onOverflow?.(dropped);
  return item;
}
