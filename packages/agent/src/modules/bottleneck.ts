// The bottleneck packet (§4.3): the CC never sees the whole state, only this deliberately narrow summary. Its size
// follows the agent's intelligence (§21.1: memories, tasks, people). People nearby are always included (Sid's
// forced social inclusion). A pure function of the state, so it is easy to test and to show on the dashboard.

import type { ActionRecord, AgentState, Lesson, Place, Utterance } from '@agora/shared';
import type { MindLevers } from './levers';
import { describePlan } from './plan';
import { describeChange, recentChanges } from '../perception/surroundings';
import { bearingOf, describeScene } from '../perception/sceneWords';
import { EDIBLE } from './villageMove';
import { ISOLATED_RANGE } from './hiding';
import { WORN } from '../body/inventory';

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
  /** What it knows of the game that bears on now (mind/knowledge.ts): ways to get what matters, what its tasks are about. */
  knowledge?: readonly string[];
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
  // The train of thought (owner request, 2026-10-24): what went through the agent's head the last few times.
  const thoughts = (s.mind?.thoughts ?? []).slice(-3);
  if (thoughts.length > 0) out.push(`Your recent thoughts (oldest first):\n${thoughts.map((t) => `  - ${t.text} (${ago(now - t.ts)})`).join('\n')}`);
  // What it reached for lately and could not do now (the checks would not have it), and why.
  const ruled = (s.mind?.ruledOut ?? []).filter((x) => now - x.ts < 10 * 60_000);
  if (ruled.length > 0) out.push(`Lately you reached for what you can't do now:\n${ruled.map((x) => `  - ${x.what}: ${x.why} (${x.n === 1 ? 'once' : `${x.n} times`}, ${ago(now - x.ts)})`).join('\n')}`);
  const tasks = (s.goals.tasks ?? []).filter((t) => t.status === 'open');
  if (tasks.length > 0) out.push(`Tasks you have taken on:\n${tasks.map((t, i) => `  ${i + 1}. ${t.text} (from ${t.from === me ? 'yourself' : t.from}, ${ago(now - t.at)})${t.note ? ` [${t.note}]` : ''}`).join('\n')}`);
  const finished = (s.goals.tasks ?? []).filter((t) => t.status !== 'open').slice(-3);
  if (finished.length > 0) out.push(`Tasks behind you: ${finished.map((t) => `${t.text} (${t.status}${t.note ? `: ${t.note}` : ''})`).join('; ')}.`);

  const g = s.goals.current;
  const plan = s.goals.plan;
  if (plan) {
    const talked = plan.discussedWith.length > 0 ? ` (talked over with ${plan.discussedWith.join(', ')})` : ' (not talked over with anyone yet)';
    out.push(`Your plan: ${describePlan(plan)}${talked}`);
  }
  out.push(`Current goal: ${g ? g.text : 'none set'}${g?.parent ? ` (part of: ${s.goals.history.find((h) => h.id === g.parent)?.text ?? g.parent})` : ''}`);
  const meant = s.mind?.intention;
  if (meant && meant.steps.length > 0) out.push(`You meant to do next: ${meant.steps.map((x) => `${x.skill ?? x.option ?? 'something'} ${JSON.stringify(x.args ?? {})}`).join('; then ')}`);
  const later = s.mind?.later ?? [];
  if (later.length > 0) out.push(`You put off: ${later.map((x) => `${x.what} (until ${x.cue})`).join('; ')}.`);
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
  // Another world (owner request, 2026-10-24): where we are, and the way back.
  const world = String(self.dimension ?? 'overworld').replace(/^minecraft:/, '');
  if (world !== 'overworld') {
    const back = (s.village.portals ?? []).filter((p) => p.dimension === world && p.leadsTo === 'overworld').sort((a, b) => Math.hypot(a.pos.x - self.pos.x, a.pos.z - self.pos.z) - Math.hypot(b.pos.x - self.pos.x, b.pos.z - self.pos.z))[0];
    const backText = back ? `The portal home is at ${back.pos.x},${back.pos.y},${back.pos.z}, ${Math.round(Math.hypot(back.pos.x - self.pos.x, back.pos.z - self.pos.z))} m away (travel {to: overworld}).` : 'You know of no portal back.';
    out.push(`You are in ${world === 'the_nether' ? 'the Nether' : 'the End'}. ${backText}`);
  }
  const inv = self.inventory.map((st) => `${st.qty} ${st.item}${st.left !== undefined && st.left < WORN ? ` (nearly worn out: ${Math.round(st.left * 100)}% left)` : ''}`).join(', ');
  out.push(`Carrying: ${inv || 'nothing'}${self.equipped ? ` (holding ${self.equipped})` : ''}${self.armor.length > 0 ? `; wearing ${self.armor.join(', ')}` : '; wearing no armor'}.`);
  const hungerLine = hunger(s);
  if (hungerLine) out.push(hungerLine);
  const healingLine = healing(s);
  if (healingLine) out.push(healingLine);
  // Where home is: without it a model's "head home" went to a made-up 0,64,0, hundreds of blocks off.
  const home = s.village.home;
  if (home && world === 'overworld') {
    const far = Math.round(Math.hypot(home.x - self.pos.x, home.z - self.pos.z));
    const chest = s.village.chest?.pos;
    const huts = s.village.huts.slice(0, 3).map((d) => `${d.x},${d.y},${d.z}`);
    // What is there: an agent went "home to a safe base" for its first night, to the empty field it started in.
    const builtThere = (s.village.projects ?? []).some((p) => Math.hypot(p.origin.x - home.x, p.origin.z - home.z) <= ISOLATED_RANGE);
    const bare = huts.length === 0 && !builtThere ? '; nothing built there yet' : '';
    out.push(
      `Home: ${Math.round(home.x)},${Math.round(home.y)},${Math.round(home.z)}, ${far} m away${chest ? `; the village chest at ${chest.x},${chest.y},${chest.z}` : ''}${huts.length > 0 ? `; huts with doors at ${huts.join(' and ')}` : ''}${bare}.`,
    );
  }
  // A building begun and not finished: where, how far along, what it still lacks (build again to carry on).
  const begun = (s.village.projects ?? []).filter((p) => p.doneAt === null).slice(-2);
  const built = (s.village.projects ?? []).filter((p) => p.doneAt !== null).slice(-3);
  if (built.length > 0) out.push(`Built: ${built.map((p) => `the ${p.name} at ${p.origin.x},${p.origin.y},${p.origin.z}`).join('; ')}.`);
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

  const person = (name: string): string => {
    const prof = s.social[name];
    const want = prof?.perceivedGoals[0];
    const trust = prof && prof.trust < 0.35 ? ', you don\u2019t trust them' : prof && prof.trust > 0.75 ? ', you trust them' : '';
    const record = prof && prof.promisesKept + prof.promisesBroken > 0 ? `, kept ${prof.promisesKept}/${prof.promisesKept + prof.promisesBroken} promises` : '';
    const known = (s.knowledge.beliefs ?? []).filter((b) => b.about === name).map((b) => `you know ${name} ${b.text}`);
    return [prof ? `you feel ${Math.round(prof.sentiment)}/10 about them` : 'a new face', ...(trust ? [trust.slice(2)] : []), ...(record ? [record.slice(2)] : []), ...(want ? [`seems to want ${want}`] : []), ...known].join(', ');
  };
  if (s.scene && s.scene.at > 0) {
    out.push(...describeScene(s.scene, now, { people: person }));
  } else {
    const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player').slice(0, L.people);
    if (people.length > 0) out.push(`People near you: ${people.map((p) => `${p.name} (${Math.round(p.distance)} m, ${person(p.name)}${p.heldItem ? `, holding ${p.heldItem}` : ''})`).join('; ')}`);
    else out.push('Nobody is near you.');
    const threats = s.perception.nearbyEntities.filter((e) => e.kind === 'hostile' && e.distance <= 16);
    if (threats.length > 0) out.push(`Hostile mobs: ${threats.map((t) => `${t.name} ${Math.round(t.distance)} m`).join(', ')}.`);
    const animals = s.perception.nearbyEntities.filter((e) => e.kind === 'passive').slice(0, 6);
    if (animals.length > 0) out.push(`Animals: ${animals.map((t) => `${t.name} ${Math.round(t.distance)} m`).join(', ')}.`);
    const blocks = s.perception.nearbyBlocksOfInterest.slice(0, 6);
    if (blocks.length > 0) out.push(`You can see: ${blocks.map((b) => `${b.name} ${b.distance} m`).join(', ')}.`);
  }
  // What changed around us lately (a wall of our shelter broken, a door, a block set down): ours first.
  const changes = recentChanges(s.perception.blockChanges, now);
  if (changes.length > 0) out.push(`Changes around you:\n${changes.map((c) => `  ${describeChange(c)}, at ${c.pos.x},${c.pos.y},${c.pos.z} (${ago(now - c.ts)})`).join('\n')}`);

  const convIds = new Set(Object.values(s.conversations).filter((c) => c.status !== 'ended').map((c) => c.convId));
  const heard = s.perception.heardSpeech.filter((u) => u.addressedToMe || convIds.has(u.convId)).slice(-6);
  if (heard.length > 0) out.push(`Recent talk:\n${heard.map((u) => `  ${line(u, me)} (${ago(now - u.ts)})`).join('\n')}`);

  const lately = s.actionLog.slice(-4);
  if (lately.length > 0) {
    out.push(`What happened lately (oldest first):\n${lately.map((a) => `  ${a.skill} ${JSON.stringify(a.args)}: ${a.ok ? 'done' : 'FAILED'}: ${a.observed}${a.error ? ` (${a.error})` : ''} (${ago(now - (a.ts + a.durationMs))})`).join('\n')}`);
  }
  const attempts = triedLately(s.actionLog, now);
  if (attempts.length > 0) out.push(`What you have been trying (last 20 min):\n${attempts.map((x) => `  ${x}`).join('\n')}`);
  if (i.stuck && i.stuck.length > 0) out.push(`Not working lately: ${i.stuck.join('; ')}.`);
  const places = placesFor(s, now);
  if (places.length > 0) out.push(`Places you remember, out of sight now:\n${places.map((p) => `  ${p}`).join('\n')}`);
  if (i.knowledge && i.knowledge.length > 0) out.push(`What you know of the game that bears on this:\n${i.knowledge.map((k) => `  - ${k}`).join('\n')}`);
  const lessons = lessonsFor(s, now);
  if (lessons.length > 0) out.push(`What you have learned:\n${lessons.map((l) => `  - ${l.text}`).join('\n')}`);

  const notes = [...(i.memories ?? []), ...[...s.workmem].sort((a, b) => b.salience - a.salience).map((w) => w.text)].slice(0, L.memories);
  if (notes.length > 0) out.push(`On your mind:\n${notes.map((n) => `  - ${n}`).join('\n')}`);

  if (i.mind && i.mind.length > 0) out.push(i.mind.join('\n'));
  out.push(`Why you are thinking now: ${i.reason}.`);
  out.push(`Weigh at least ${L.candidates} different ways before you choose.`);
  return out.join('\n');
}

/** What the thing an action was for is: its item, block, animal, design or person. */
function aimOf(a: ActionRecord): string {
  const x = a.args;
  const v = x.item ?? x.block ?? x.animal ?? x.design ?? x.structure ?? x.target ?? x.agent ?? x.to ?? x.for ?? '';
  return typeof v === 'string' ? v : '';
}

/**
 * What the agent has been trying lately, by what it was after: how often, how it went, and the last reason it failed
 * (owner request, 2026-10-24: a person remembers what they already tried, and doesn't go round in circles).
 */
export function triedLately(log: readonly ActionRecord[], now: number, windowMs = 20 * 60_000): string[] {
  const groups = new Map<string, { n: number; ok: number; fail: number; last: ActionRecord; first: number }>();
  for (const a of log) {
    if (now - a.ts > windowMs || ['wait', 'lookAround', 'look', 'say', 'wander'].includes(a.skill) || a.error?.startsWith('aborted')) continue;
    const k = `${a.skill} ${aimOf(a)}`.trim();
    const g = groups.get(k) ?? { n: 0, ok: 0, fail: 0, last: a, first: a.ts };
    g.n++;
    if (a.ok) g.ok++;
    else g.fail++;
    g.last = a;
    groups.set(k, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.fail > 0 || g.n >= 2)
    .sort((a, b) => b[1].last.ts - a[1].last.ts)
    .slice(0, 6)
    .map(([k, g]) => `${k}: ${g.n === 1 ? 'once' : `${g.n} times`} over ${Math.max(1, Math.round((now - g.first) / 60_000))} min, ${g.ok} worked, ${g.fail} failed${!g.last.ok && g.last.error ? ` (last: ${g.last.error})` : ''}`);
}

const WORD = /[a-z][a-z_]{2,}/g;

/**
 * Where it saw things worth coming back to that are out of sight now: what bears on its goal, tasks and failures
 * first, then the nearest (owner request, 2026-10-24: a player remembers where the sheep were).
 */
export function placesFor(s: AgentState, now: number, k = 6): string[] {
  const me = s.self.pos;
  const world = String(s.self.dimension ?? 'overworld');
  const all = (s.knowledge.places ?? []).filter((p) => p.world === world && Math.hypot(p.pos.x - me.x, p.pos.z - me.z) > 24);
  if (all.length === 0) return [];
  const context = [s.goals.current?.text ?? '', s.goals.current?.doneWhen ?? '', ...(s.goals.tasks ?? []).filter((t) => t.status === 'open').map((t) => t.text), ...s.mind.later.map((l) => `${l.what} ${l.cue}`), ...s.actionLog.slice(-6).filter((a) => !a.ok).map((a) => `${aimOf(a)} ${a.error ?? ''}`)]
    .join(' ')
    .toLowerCase();
  const words = new Set((context.match(WORD) ?? []).map((w) => w.replace(/s$/, '')));
  const bears = (p: Place) => p.names.some((n) => n.split('_').some((part) => part.length > 2 && words.has(part.replace(/s$/, ''))));
  const dist = (p: Place) => Math.hypot(p.pos.x - me.x, p.pos.z - me.z);
  return all
    .sort((a, b) => Number(bears(b)) - Number(bears(a)) || dist(a) - dist(b))
    .slice(0, k)
    .map((p) => {
      const dy = Math.round(p.pos.y - me.y);
      return `${p.what}: ${Math.round(dist(p))} m ${bearingOf(me, p.pos)}${dy >= 3 ? `, ${dy} m up` : dy <= -3 ? `, ${-dy} m down` : ''} (${p.pos.x},${p.pos.y},${p.pos.z}), seen ${ago(now - p.seenAt)}`;
    });
}

/** The lessons that bear on what is going on now (by the words they share with it), and the newest. */
export function lessonsFor(s: AgentState, now: number, k = 5): Lesson[] {
  const all = s.knowledge.lessons ?? [];
  if (all.length <= k) return all;
  const context = [
    s.goals.current?.text ?? '',
    ...(s.goals.tasks ?? []).filter((t) => t.status === 'open').map((t) => t.text),
    s.option?.skill ?? '',
    JSON.stringify(s.option?.args ?? {}),
    ...s.actionLog.slice(-5).map((a) => `${a.skill} ${aimOf(a)} ${a.error ?? ''}`),
    ...(s.scene?.features ?? []).map((f) => f.what),
    ...(s.scene?.creatures ?? []).map((c) => c.name),
  ]
    .join(' ')
    .toLowerCase();
  const words = new Set(context.match(WORD) ?? []);
  const scored = all.map((l, idx) => {
    const lw = l.text.toLowerCase().match(WORD) ?? [];
    const shared = lw.filter((w) => words.has(w)).length;
    return { l, score: shared / Math.sqrt(1 + lw.length) + idx / (all.length * 10) + (now - l.ts < 30 * 60_000 ? 0.3 : 0) };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.l);
}

/** Hurt enough to think about healing at this much health or less; the body heals by itself from this much food up. */
const HURT_AT = 16;
const HEALS_FROM = 18;

/**
 * How the body heals, once hurt enough to matter: by itself only with food at 18 of 20 or more. A model at 1 health
 * and food 10 waited for health that "regenerates on its own" (null: whole, barely hurt, or fed enough to heal).
 */
export function healing(s: AgentState): string | null {
  const { health, food } = s.self;
  if (!(health > 0) || health > HURT_AT || food >= HEALS_FROM) return null;
  const now = food > 0 ? `at food ${food} it stays where it is` : 'with no food at all, hunger itself does harm';
  return `Health comes back by itself only with food at ${HEALS_FROM} of 20 or more; ${now}.`;
}

/** A line about hunger once it matters: hungry with nothing to eat, or starving (null: fed, or food at hand). */
export function hunger(s: AgentState): string | null {
  const food = s.self.food;
  if (food > 8) return null;
  const meal = s.self.inventory.find((i) => EDIBLE.test(i.item));
  if (meal) return food <= 4 ? `You are starving; you carry ${meal.item}.` : null;
  return food <= 4 ? 'You are starving and carry nothing to eat: without food you will soon die.' : 'You are getting hungry, and you carry nothing to eat.';
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
