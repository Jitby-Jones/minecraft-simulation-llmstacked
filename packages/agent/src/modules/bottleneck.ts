// The bottleneck packet (§4.3): the CC never sees the whole state, only this deliberately narrow summary. Its size
// follows the agent's intelligence (§21.1: memories, tasks, people). People nearby are always included (Sid's
// forced social inclusion). A pure function of the state, so it is easy to test and to show on the dashboard.

import type { AgentState, Utterance } from '@agora/shared';
import type { MindLevers } from './levers';

export interface PacketInput {
  state: AgentState;
  levers: MindLevers;
  /** Why the CC is deciding now (option ended, someone asked something, …). */
  reason: string;
  /** Retrieved memories, most relevant first (M4); empty until then. */
  memories?: readonly string[];
  /** Skill+args the agent is stuck on (Action Awareness). */
  stuck?: readonly string[];
  now: number;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function line(u: Utterance, me: string): string {
  const who = u.from === me ? 'you' : u.from;
  return `${who}${u.volume === 'shout' ? ' (shouting)' : u.volume === 'whisper' ? ' (whispering)' : ''}: ${u.text}`;
}

export function buildPacket(i: PacketInput): string {
  const { state: s, levers: L, now } = i;
  const me = s.self.username;
  const out: string[] = [];
  out.push(`About you: ${s.selfSummary || 'nothing notable yet.'}`);

  const g = s.goals.current;
  out.push(`Current goal: ${g ? g.text : 'none set'}${g?.parent ? ` (part of: ${s.goals.history.find((h) => h.id === g.parent)?.text ?? g.parent})` : ''}`);
  if (s.taskQueue.length > 0) {
    out.push(`Planned tasks: ${s.taskQueue.slice(0, L.tasks).map((t) => `${t.skill} ${JSON.stringify(t.args)}${t.note ? ` (${t.note})` : ''}`).join('; ')}`);
  }
  const due = s.commitments.filter((c) => c.status === 'accepted').slice(0, 3);
  if (due.length > 0) {
    out.push(`Promises: ${due.map((c) => `${c.debtor === me ? 'you owe' : `${c.debtor} owes you`} ${c.what.text}${c.dueBy ? ` (due in ${Math.max(0, Math.round((c.dueBy - now) / 60000))} min)` : ''}`).join('; ')}`);
  }

  const self = s.self;
  out.push(
    `You: health ${Math.round(self.health)}/20, food ${self.food}/20, ${self.isDay ? 'daytime' : 'night'}, at ${Math.round(self.pos.x)},${Math.round(self.pos.y)},${Math.round(self.pos.z)}${s.flags.inDanger ? ', IN DANGER' : ''}.`,
  );
  const inv = self.inventory.map((st) => `${st.qty} ${st.item}`).join(', ');
  out.push(`Carrying: ${inv || 'nothing'}${self.equipped ? ` (holding ${self.equipped})` : ''}.`);

  const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player').slice(0, L.people);
  if (people.length > 0) {
    out.push(
      `People near you: ${people
        .map((p) => {
          const prof = s.social[p.name];
          const want = prof?.perceivedGoals[0];
          return `${p.name} (${Math.round(p.distance)} m, ${prof ? `you feel ${Math.round(prof.sentiment)}/10` : 'new face'}${want ? `, seems to want ${want}` : ''}${p.heldItem ? `, holding ${p.heldItem}` : ''})`;
        })
        .join('; ')}`,
    );
  } else out.push('Nobody is near you.');
  const threats = s.perception.nearbyEntities.filter((e) => e.kind === 'hostile' && e.distance <= 16);
  if (threats.length > 0) out.push(`Hostile mobs: ${threats.map((t) => `${t.name} ${Math.round(t.distance)} m`).join(', ')}.`);
  const blocks = s.perception.nearbyBlocksOfInterest.slice(0, 6);
  if (blocks.length > 0) out.push(`You can see: ${blocks.map((b) => `${b.name} ${b.distance} m`).join(', ')}.`);

  const convIds = new Set(Object.values(s.conversations).filter((c) => c.status !== 'ended').map((c) => c.convId));
  const heard = s.perception.heardSpeech.filter((u) => u.addressedToMe || convIds.has(u.convId)).slice(-6);
  if (heard.length > 0) out.push(`Recent talk:\n${heard.map((u) => `  ${line(u, me)} (${ago(now - u.ts)})`).join('\n')}`);

  const outcomes = [...s.actionLog].slice(-6).sort((a, b) => Number(a.ok) - Number(b.ok)).slice(0, 3);
  if (outcomes.length > 0) {
    out.push(`Recent actions:\n${outcomes.map((a) => `  ${a.skill} ${JSON.stringify(a.args)}: ${a.ok ? 'ok' : 'FAILED'} — ${a.observed}${a.error ? ` (${a.error})` : ''}`).join('\n')}`);
  }
  if (i.stuck && i.stuck.length > 0) out.push(`You are stuck on: ${i.stuck.join('; ')}. Do something else.`);

  const notes = [...(i.memories ?? []), ...[...s.workmem].sort((a, b) => b.salience - a.salience).map((w) => w.text)].slice(0, L.memories);
  if (notes.length > 0) out.push(`On your mind:\n${notes.map((n) => `  - ${n}`).join('\n')}`);

  out.push(`Why you are deciding now: ${i.reason}.`);
  out.push(`Weigh ${L.candidates} different options before you choose.`);
  return out.join('\n');
}
