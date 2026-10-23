// The operator's switches (debug controls): which of an agent's modules are off. Every module that can be switched
// off asks here before it acts, so a switch takes effect at once and comes back on just as quickly.

import type { AgentState } from '@agora/shared';

/** The module is switched off for this agent (by name, or with all model calls when it is a model call). */
export function isOff(s: AgentState, module: string): boolean {
  const off = s.flags.off;
  if (!off || off.length === 0) return false;
  return off.includes(module) || (module.endsWith('.llm') && off.includes('llm'));
}
