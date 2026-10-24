// The bottleneck packet (§4.3): the CC never sees the whole state, only this deliberately narrow summary. Its size
// follows the agent's intelligence (§21.1: memories, tasks, people). People nearby are always included (Sid's
// forced social inclusion). A pure function of the state, so it is easy to test and to show on the dashboard.

import type { AgentState, Utterance } from '@agora/shared';
import type { MindLevers } from './levers';
import { describePlan } from './plan';
import { describeChange, recentChanges } from '../perception/surroundings';
import { EDIBLE } from './villageMove';

export interface PacketInput {
  state: AgentState;
  levers: MindLevers;
  /** Why the CC is deciding now (option ended, someone asked something, …). */
  reason: string;
  /** Retrieved memories, most relevant first (M4); empty until then. */
  memories?: readonly string[];
  /** Skill+args the agent is stuck on (Action Awareness). */
  stuck?: readonly string[];
  /** How the agent feels and how it sees the people at hand, gut and facts (§18.2, §18.5). */
  mind?: readonly string[];
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
  const plan = s.goals.plan;
  if (plan) {
    const talked = plan.discussedWith.length > 0 ? ` (talked over with ${plan.discussedWith.join(', ')})` : ' (not talked over with anyone yet)';
    out.push(`Your plan: ${describePlan(plan)}${talked}`);
  }
  out.push(`Current goal: ${g ? g.text : 'none set'}${g?.parent ? ` (part of: ${s.goals.history.find((h) => h.id === g.parent)?.text ?? g.parent})` : ''}`);
  const village = s.goals.social.filter((x) => x.status === 'active');
  if (village.length > 0 || s.goals.community) {
    out.push(`Your part in the village: ${village.map((x) => `${x.text}${x.with ? ` (with ${x.with})` : ''}`).join('; ') || 'not decided yet'}${s.goals.community ? `; everyone hopes to ${s.goals.community}` : ''}.`);
  }
  const opt = s.option;
  if (opt?.status === 'running') {
    out.push(`Doing now: ${opt.option}${opt.skill ? ` ${opt.skill} ${JSON.stringify(opt.args ?? {})}` : ''}${opt.targetAgent ? ` with ${opt.targetAgent}` : ''}${opt.progress ? ` (${opt.progress})` : ''}`);
  }
  if (s.taskQueue.length > 0) {
    out.push(`Planned tasks: ${s.taskQueue.slice(0, L.tasks).map((t) => `${t.skill} ${JSON.stringify(t.args)}${t.note ? ` (${t.note})` : ''}`).join('; ')}`);
  }
  const due = s.commitments.filter((c) => c.status === 'accepted').slice(0, 3);
  if (due.length > 0) {
    out.push(`Promises: ${due.map((c) => `${c.debtor === me ? 'you owe' : `${c.debtor} owes you`} ${c.what.text}${c.dueBy ? ` (due in ${Math.max(0, Math.round((c.dueBy - now) / 60000))} min)` : ''}`).join('; ')}`);
  }

  const self = s.self;
  out.push(
    `You: health ${Math.round(self.health)}/20, food ${self.food}/20, ${dayPart(self.time, self.isDay)}, at ${Math.round(self.pos.x)},${Math.round(self.pos.y)},${Math.round(self.pos.z)}${s.flags.inDanger ? ', IN DANGER' : ''}.`,
  );
  // Another world (owner request, 2026-10-24): where we are, its dangers, and the way back.
  const world = String(self.dimension ?? 'overworld').replace(/^minecraft:/, '');
  if (world !== 'overworld') {
    const back = (s.village.portals ?? []).filter((p) => p.dimension === world && p.leadsTo === 'overworld').sort((a, b) => Math.hypot(a.pos.x - self.pos.x, a.pos.z - self.pos.z) - Math.hypot(b.pos.x - self.pos.x, b.pos.z - self.pos.z))[0];
    const backText = back ? `The portal home is at ${back.pos.x},${back.pos.y},${back.pos.z}, ${Math.round(Math.hypot(back.pos.x - self.pos.x, back.pos.z - self.pos.z))} m away (travel {to: overworld}).` : '';
    out.push(
      world === 'the_nether'
        ? `You are in the Nether: lava everywhere, ghasts that shoot fire, piglins that attack anyone without gold armor, blazes and wither skeletons in the fortresses. Gold, quartz, glowstone and blaze rods are here for the taking. ${backText}`.trim()
        : `You are in the End: endermen (don't look them in the eye), the dragon overhead, and no way out until it is dead. ${backText}`.trim(),
    );
  }
  const inv = self.inventory.map((st) => `${st.qty} ${st.item}`).join(', ');
  out.push(`Carrying: ${inv || 'nothing'}${self.equipped ? ` (holding ${self.equipped})` : ''}.`);
  // Hunger said plainly: a number alone was let slide until an agent starved.
  const hungerLine = hunger(s);
  if (hungerLine) out.push(hungerLine);
  // Where home is: without it a model's "head home" went to a made-up 0,64,0, hundreds of blocks off.
  const home = s.village.home;
  if (home && world === 'overworld') {
    const far = Math.round(Math.hypot(home.x - self.pos.x, home.z - self.pos.z));
    const chest = s.village.chest?.pos;
    // Huts, by their doors: where to be at night.
    const huts = s.village.huts.slice(0, 3).map((d) => `${d.x},${d.y},${d.z}`);
    out.push(
      `Home (the village): ${Math.round(home.x)},${Math.round(home.y)},${Math.round(home.z)}, ${far} m away; ${chest ? `the village chest at ${chest.x},${chest.y},${chest.z}` : 'no village chest yet (a chest is 8 planks; a builder makes it, or anyone if there is no builder)'}; ${huts.length > 0 ? `huts with doors at ${huts.join(' and ')}` : 'no huts yet'}.`,
    );
  }
  // A building begun and not finished: where, how far along, what it still lacks (build again to carry on).
  const begun = (s.village.projects ?? []).filter((p) => p.doneAt === null).slice(-2);
  if (begun.length > 0) {
    out.push(
      `Building: ${begun
        .map((p) => {
          const lacks = Object.entries(p.missing)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([item, n]) => `${n} ${item.replace(/_/g, ' ')}`)
            .join(', ');
          return `the ${p.name} (build {design: "${p.design}"}) at ${p.origin.x},${p.origin.y},${p.origin.z}, ${p.placed}/${p.total} blocks in${lacks ? `, still lacking ${lacks}` : ''}`;
        })
        .join('; ')}.`,
    );
  }

  const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player').slice(0, L.people);
  if (people.length > 0) {
    out.push(
      `People near you: ${people
        .map((p) => {
          const prof = s.social[p.name];
          const want = prof?.perceivedGoals[0];
          const trust = prof && prof.trust < 0.35 ? ', you don\u2019t trust them' : prof && prof.trust > 0.75 ? ', you trust them' : '';
          const record = prof && prof.promisesKept + prof.promisesBroken > 0 ? `, kept ${prof.promisesKept}/${prof.promisesKept + prof.promisesBroken} promises` : '';
          return `${p.name} (${Math.round(p.distance)} m, ${prof ? `you feel ${Math.round(prof.sentiment)}/10` : 'new face'}${trust}${record}${want ? `, seems to want ${want}` : ''}${p.heldItem ? `, holding ${p.heldItem}` : ''})`;
        })
        .join('; ')}`,
    );
  } else out.push('Nobody is near you.');
  const threats = s.perception.nearbyEntities.filter((e) => e.kind === 'hostile' && e.distance <= 16);
  if (threats.length > 0) out.push(`Hostile mobs: ${threats.map((t) => `${t.name} ${Math.round(t.distance)} m`).join(', ')}.`);
  const blocks = s.perception.nearbyBlocksOfInterest.slice(0, 6);
  if (blocks.length > 0) out.push(`You can see: ${blocks.map((b) => `${b.name} ${b.distance} m`).join(', ')}.`);
  // What changed around us lately (a wall of our shelter broken, a door, a block set down): ours first.
  const changes = recentChanges(s.perception.blockChanges, now);
  if (changes.length > 0) out.push(`Changes around you:\n${changes.map((c) => `  ${describeChange(c)}, at ${c.pos.x},${c.pos.y},${c.pos.z} (${ago(now - c.ts)})`).join('\n')}`);

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

  if (i.mind && i.mind.length > 0) out.push(i.mind.join('\n'));
  out.push(`Why you are deciding now: ${i.reason}.`);
  out.push(`Weigh ${L.candidates} different options before you choose.`);
  return out.join('\n');
}

/** A line about hunger once it matters: hungry with nothing to eat, or starving (null: fed, or food at hand). */
export function hunger(s: AgentState): string | null {
  const food = s.self.food;
  if (food > 8) return null;
  const meal = s.self.inventory.find((i) => EDIBLE.test(i.item));
  if (meal) return food <= 4 ? `You are starving: eat the ${meal.item} you carry.` : null;
  return food <= 4
    ? 'You are starving and carry nothing to eat: without food soon you will die. Food comes before anything else now.'
    : 'You are getting hungry and carry nothing to eat: find food soon (an animal, apples from oak leaves, berries, or ask someone).';
}

/**
 * The time of day as one plans by it: daytime; evening, with how long until dark (night is 13000–23000 of the day's
 * 24000 ticks, a minute being 1200); night, with how long until it gets light.
 */
export function dayPart(time: number, isDay: boolean): string {
  const t = ((time % 24000) + 24000) % 24000;
  const min = (ticks: number) => Math.max(1, Math.round(ticks / 1200));
  if (isDay) return t >= 9600 && t < 13000 ? `evening, dark in about ${min(13000 - t)} min` : 'daytime';
  return t >= 13000 && t < 23000 ? `night, light in about ${min(23000 - t)} min` : 'night';
}
