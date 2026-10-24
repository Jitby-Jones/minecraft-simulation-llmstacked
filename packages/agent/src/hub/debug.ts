// The operator's debug requests to one agent (the Hub's `debug` message, from the dashboard or `pnpm ctl agent`):
// look inside (its state, plan, the packet its CC would see now, the CC's last exchange with the model, the models
// it uses), read and change its memories, set its goal or plan, have it think again or do something, stop what it is
// doing, say a line, or set a feeling or its caution. These are the operator's hands, outside the simulation: every
// one is logged, and a memory written this way keeps the source `operator`.

import { TUNABLE_MODULES, type DecisionOutput, type EmotionName, type Plan } from '@agora/shared';
import { TIERS } from '@agora/llm';
import type { Agent } from '../agent';
import { describePlan } from '../modules/plan';
import { isOff } from '../state/switches';
import { pushWorkmem } from '../state/workmem';

export interface DebugResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

const EMOTIONS: readonly EmotionName[] = ['anger', 'fear', 'joy', 'sadness', 'disgust', 'shame', 'envy', 'affection'];

const str = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** A plan's steps as the operator gave them: lines of text, or {text, doneWhen} objects. */
function stepsOf(v: unknown): { text: string; doneWhen?: string }[] {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n|;/) : [];
  const step = (x: unknown): { text: string; doneWhen?: string } => {
    if (typeof x === 'string') return { text: x.trim() };
    if (typeof x !== 'object' || x === null) return { text: '' };
    const o = x as { text?: unknown; doneWhen?: unknown };
    const doneWhen = str(o.doneWhen, 80);
    return { text: str(o.text, 140) ?? '', ...(doneWhen ? { doneWhen } : {}) };
  };
  return raw
    .map(step)
    .filter((x) => x.text.length >= 2)
    .slice(0, 8);
}

/** Runs one debug request against the agent. */
export async function debugOp(agent: Agent, op: string, args: Record<string, unknown>): Promise<DebugResult> {
  const s = () => agent.store.state;
  const now = Date.now();
  switch (op) {
    case 'inspect': {
      const st = s();
      const llm = agent.llm;
      return {
        ok: true,
        message: `${agent.name}: ${st.option ? `${st.option.option}${st.option.skill ? ` ${st.option.skill}` : ''} (${st.option.status})` : 'idle'}`,
        data: {
          username: agent.name,
          persona: {
            name: st.self.persona.name,
            sex: st.self.persona.sex,
            source: st.self.persona.source,
            traits: st.self.persona.traits,
            description: st.self.persona.description ?? '',
            values: st.self.persona.values,
            lifeGoals: st.self.persona.lifeGoals,
            insecurities: st.self.persona.insecurities,
            speech: st.self.persona.speech,
            intelligence: st.self.persona.abilities.intelligence,
          },
          self: { pos: st.self.pos, health: st.self.health, food: st.self.food, isDay: st.self.isDay, time: st.self.time, inventory: st.self.inventory },
          flags: st.flags,
          drives: st.drives,
          emotions: st.emotions,
          mood: st.mood,
          goals: { current: st.goals.current, plan: st.goals.plan ?? null, planText: st.goals.plan ? describePlan(st.goals.plan) : null, social: st.goals.social, community: st.goals.community ?? null, history: st.goals.history.slice(-6) },
          option: st.option,
          decision: st.decision,
          taskQueue: st.taskQueue,
          commitments: st.commitments.filter((c) => c.status === 'accepted' || c.status === 'proposed'),
          conversations: Object.values(st.conversations)
            .filter((c) => c.status !== 'ended')
            .map((c) => ({ convId: c.convId, with: c.participants.filter((p) => p !== agent.name), turns: c.turns, lines: c.transcript.slice(-6).map((u) => `${u.from}: ${u.text}`) })),
          workmem: st.workmem,
          actions: st.actionLog.slice(-10),
          stuck: agent.awareness.stuckList(),
          packet: await agent.cc.packetNow(),
          lastExchange: agent.cc.lastExchange,
          modules: TUNABLE_MODULES.map((m) => ({ name: m, on: !isOff(st, m) })),
          routing: llm?.routing ?? null,
          chains: llm ? Object.fromEntries(TIERS.map((t) => [t, llm.chainFor(t).slice(0, 4)])) : null,
        },
      };
    }
    case 'memory.list': {
      const mem = agent.memory;
      if (!mem) return { ok: false, message: 'this agent keeps no long-term memory' };
      const q = str(args.q);
      const limit = Math.min(500, Math.max(1, num(args.limit) ?? 100));
      if (q) {
        const found = await mem.recall(q, limit);
        return { ok: true, message: `${found.length} memories about "${q}"`, data: found.map((r) => ({ id: r.id, text: r.text, source: r.source, score: Number(r.score.toFixed(3)) })) };
      }
      const tier = args.tier === 'recent' || args.tier === 'long' ? args.tier : undefined;
      const rows = mem.rows(tier, limit);
      return { ok: true, message: `${rows.length} memories${tier ? ` (${tier})` : ''}; on its mind: ${s().workmem.length}`, data: { memories: rows, workmem: s().workmem } };
    }
    case 'memory.add': {
      const text = str(args.text);
      if (!text) return { ok: false, message: 'memory.add needs text' };
      if (args.mind === true || args.mind === 'true') {
        pushWorkmem(agent.store, text, Math.min(1, Math.max(0, num(args.importance) ?? 0.7)), 'operator', { now });
        return { ok: true, message: `put on ${agent.name}'s mind: ${text}` };
      }
      const id = await agent.memory?.add(text, num(args.importance) ?? 0.6, args.tier === 'recent' ? 'recent' : 'long');
      return id ? { ok: true, message: `remembered (${id}): ${text}`, data: { id } } : { ok: false, message: 'could not add the memory (no memory, or it closed)' };
    }
    case 'memory.edit': {
      const id = str(args.id);
      if (!id) return { ok: false, message: 'memory.edit needs id' };
      const text = str(args.text);
      const importance = num(args.importance);
      const isFalse = args.isFalse === true || args.isFalse === 'true' ? true : args.isFalse === false || args.isFalse === 'false' ? false : undefined;
      const done = await agent.memory?.edit(id, { ...(text ? { text } : {}), ...(importance !== null ? { importance } : {}), ...(isFalse !== undefined ? { isFalse } : {}) });
      return done ? { ok: true, message: `memory ${id} changed` } : { ok: false, message: `no memory ${id}` };
    }
    case 'memory.delete': {
      const id = str(args.id);
      if (!id) return { ok: false, message: 'memory.delete needs id' };
      if (args.mind === true || args.mind === 'true') {
        const before = s().workmem.length;
        agent.store.update('workmem', (w) => w.filter((x) => x.id !== id), 'operator cleared a thought');
        return s().workmem.length < before ? { ok: true, message: `thought ${id} gone` } : { ok: false, message: `no thought ${id}` };
      }
      return agent.memory?.remove(id) ? { ok: true, message: `memory ${id} deleted` } : { ok: false, message: `no memory ${id}` };
    }
    case 'goal': {
      const text = str(args.text, 120);
      if (!text) return { ok: false, message: 'goal needs text' };
      const doneWhen = str(args.doneWhen, 80);
      agent.cc.setGoal(text, doneWhen ?? undefined);
      return { ok: true, message: `goal set: ${text}${doneWhen ? ` (done when ${doneWhen})` : ''}` };
    }
    // Owner request, 2026-10-24: a task given in words; how to do it is the agent's to work out.
    case 'task': {
      const text = str(args.text, 300);
      if (!text) return { ok: false, message: 'task needs text' };
      const t = agent.giveTask(text, str(args.from, 32) ?? 'the operator');
      return { ok: true, message: `task given: ${t.text}` };
    }
    case 'plan': {
      const aim = str(args.aim, 160);
      const steps = stepsOf(args.steps);
      if (!aim || steps.length === 0) return { ok: false, message: 'plan needs an aim and at least one step' };
      if (!agent.goalGen) return { ok: false, message: 'this agent has no planner' };
      const plan: Plan = { id: `p${now.toString(36)}op`, aim, steps: steps.map((x) => ({ text: x.text, ...(x.doneWhen ? { doneWhen: x.doneWhen } : {}), status: 'todo' as const })), createdAt: now, updatedAt: now, why: 'set by the operator', discussedWith: [], source: 'operator' };
      // The steps' doneWhens are checked as the planner's are (one code can't check gets time on it).
      agent.goalGen.install(agent.goalGen.checked(plan), 'set by the operator');
      return { ok: true, message: `plan set: ${describePlan(s().goals.plan ?? plan)}` };
    }
    case 'replan': {
      if (!agent.goalGen) return { ok: false, message: 'this agent has no planner' };
      agent.store.update('goals', (g) => ({ ...g, plan: null, current: null }), 'operator asked for a new plan');
      // L3 can take most of a minute: the plan shows up in inspect (and on the dashboard) once it is made.
      if (args.wait !== true && args.wait !== 'true') {
        agent.goalGen.soon('the operator asked for a new plan', 0);
        return { ok: true, message: 'making a new plan (inspect shows it once it is made)' };
      }
      await agent.goalGen.run('the operator asked for a new plan');
      const p = s().goals.plan;
      return p ? { ok: true, message: `new plan: ${describePlan(p)}` } : { ok: false, message: 'no plan came of it' };
    }
    case 'plan.clear':
      agent.store.update('goals', (g) => ({ ...g, plan: null, current: null }), 'operator cleared the plan');
      return { ok: true, message: 'plan and goal cleared' };
    case 'decide':
      agent.cc.trigger(str(args.reason, 200) ?? 'think again about what to do now', { urgent: true });
      return { ok: true, message: 'deciding now' };
    case 'do': {
      let raw: unknown = args.decision ?? args;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw) as unknown;
        } catch {
          return { ok: false, message: 'do needs a decision as JSON' };
        }
      }
      const why = agent.cc.force({ rationale: 'the operator said so', terminate: { maxSeconds: 120 }, ...(raw as Partial<DecisionOutput>) });
      return why ? { ok: false, message: `not done: ${why}` } : { ok: true, message: `doing it: ${s().option?.option ?? ''}${s().option?.skill ? ` ${s().option?.skill}` : ''}` };
    }
    case 'abort':
      agent.executor.abort('stopped by the operator');
      return { ok: true, message: 'stopped what it was doing' };
    case 'say': {
      const text = str(args.text, 240);
      if (!text) return { ok: false, message: 'say needs text' };
      const volume = args.volume === 'shout' || args.volume === 'whisper' ? args.volume : 'normal';
      const sent = await agent.bodyOf.say(text, volume);
      return sent ? { ok: true, message: `${agent.name} said: ${text}` } : { ok: false, message: 'the line did not go out' };
    }
    case 'set': {
      const what = str(args.what, 20);
      const value = num(args.value);
      if (!what || value === null) return { ok: false, message: 'set needs what (caution or a feeling) and a value 0..1' };
      const v = Math.min(1, Math.max(0, value));
      if (what === 'caution') {
        agent.store.update('drives', (d) => ({ ...d, caution: v }), 'operator set caution');
        return { ok: true, message: `caution ${v}` };
      }
      if ((EMOTIONS as readonly string[]).includes(what)) {
        agent.store.update('emotions', (e) => ({ ...e, [what]: v }), `operator set ${what}`);
        return { ok: true, message: `${what} ${v}` };
      }
      return { ok: false, message: `can set caution or ${EMOTIONS.join(', ')}` };
    }
    default:
      return { ok: false, message: `unknown debug request ${op}` };
  }
}
