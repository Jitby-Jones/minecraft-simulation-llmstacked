// Telemetry for the dashboard (§8 `telemetry`, M7): what this agent decided and why, what it did and said, how it
// feels and where it stands with each person it knows. Dashboard only: the Hub keeps it for the operator and never
// fans any of it out to another bot. It reads this agent's own state and sends; nothing comes back this way.

import { type TelemetryKind, parseProximityLine } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Agent } from '../agent';
import { resentment } from '../social/math';

export type TelemetrySend = (kind: TelemetryKind, data: Record<string, unknown>) => void;

export interface TelemetryOptions {
  agent: Agent;
  bot: Bot;
  send: TelemetrySend;
  /** How often the state snapshot goes out. */
  stateEveryMs?: number;
  /** How often the view of people goes out. */
  socialEveryMs?: number;
  now?: () => number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Long argument values are trimmed: this is a view for the operator, not a replay log. */
function brief(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {}).slice(0, 8)) out[k] = typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : v;
  return out;
}

/** Starts sending; returns the function that stops it. */
export function startTelemetry(o: TelemetryOptions): () => void {
  const { agent, send } = o;
  const now = o.now ?? Date.now;
  const store = agent.store;
  const me = agent.name;
  const offs: (() => void)[] = [];
  const on = agent.bus.on.bind(agent.bus);

  offs.push(
    on('decision', (e) => {
      const d = e.decision;
      send('decision', {
        id: d.id,
        source: d.source,
        option: d.option,
        ...(d.task ? { task: { skill: d.task.skill, args: brief(d.task.args) } } : {}),
        ...(d.target?.agent ? { target: d.target.agent } : {}),
        ...(d.speechIntent ? { stance: d.speechIntent.stance, gist: d.speechIntent.gist, mayCommit: d.speechIntent.mayCommit } : {}),
        ...(d.fight ? { fight: { target: d.fight.target, intent: d.fight.intent } } : {}),
        ...(d.romance ? { romance: { with: d.romance.with, phase: d.romance.phase, ...(d.romance.reaction ? { reaction: d.romance.reaction } : {}) } } : {}),
        rationale: d.rationale,
        stateVersion: d.stateVersion,
      });
    }),
  );
  offs.push(on('optionTerminated', (e) => send('option', { option: e.option ?? null, reason: e.reason, ok: e.ok, ...(e.targetAgent ? { target: e.targetAgent } : {}) })));
  offs.push(
    on('actionRecorded', (e) => {
      const r = e.record;
      send('skill', { skill: r.skill, args: brief(r.args), ok: r.ok, observed: r.observed, ...(r.error ? { error: r.error } : {}), ms: r.durationMs, ...(r.data ? { data: r.data } : {}) });
      if (r.skill === 'duel') send('fight', { kind: 'duel', with: r.args.target ?? null, outcome: r.data?.outcome ?? 'interrupted', lethal: r.args.lethal === true });
    }),
  );
  offs.push(on('rungChanged', (e) => send('fight', { kind: 'rung', with: e.name, from: e.from, to: e.to })));
  // §17.7, §17.8: whom we follow, and walking away from a leader set upon by a group.
  offs.push(on('leaderChanged', (e) => send('fight', { kind: 'follow', leader: e.leader, before: e.before })));
  offs.push(on('defected', (e) => send('fight', { kind: 'defect', from: e.from, attackers: e.attackers })));
  offs.push(
    on('conversationEnded', (e) => {
      const c = store.state.conversations[e.convId];
      // Whom we talked with: the others (a conversation's participants include ourselves).
      send('conversation', { convId: e.convId, with: (c?.participants ?? []).filter((p) => p !== me), reason: e.reason, turns: c?.turns ?? 0, startedAt: c?.startedAt ?? null });
    }),
  );
  offs.push(on('newGoal', (e) => send('goal', { event: 'new', text: e.goal.text, kind: e.goal.kind, ...(e.goal.doneWhen ? { doneWhen: e.goal.doneWhen } : {}) })));
  offs.push(on('goalDone', (e) => send('goal', { event: 'done', text: e.goal.text })));
  offs.push(
    on('commitmentResolved', (e) => {
      const c = store.state.commitments.find((x) => x.id === e.commitmentId);
      if (c) send('commitment', { debtor: c.debtor, creditor: c.creditor, text: c.what.text, kind: c.what.kind, status: e.status, ...(c.coerced ? { coerced: true } : {}) });
    }),
  );

  // What we said, as the chat echoed it back (every line that really went out, the reflexes' and skills' too).
  const onChat = (m: string) => {
    const p = parseProximityLine(m);
    if (p.kind === 'speech' && p.speaker === me) send('utterance', { text: p.text, volume: p.volume });
  };
  o.bot.on('messagestr', onChat);
  offs.push(() => o.bot.off('messagestr', onChat));

  // New commitments show up in state; report each once.
  const seenCommitments = new Set(store.state.commitments.map((c) => c.id));
  const onChange = () => {
    for (const c of store.state.commitments) {
      if (seenCommitments.has(c.id)) continue;
      seenCommitments.add(c.id);
      send('commitment', { debtor: c.debtor, creditor: c.creditor, text: c.what.text, kind: c.what.kind, status: c.status, ...(c.coerced ? { coerced: true } : {}), ...(c.dueBy ? { dueBy: c.dueBy } : {}) });
    }
  };
  store.on('change', onChange);
  offs.push(() => store.off('change', onChange));

  const state = () => {
    const s = store.state;
    const e = s.emotions;
    const opt = s.option;
    send('state', {
      pos: { x: Math.round(s.self.pos.x), y: Math.round(s.self.pos.y), z: Math.round(s.self.pos.z) },
      health: r2(s.self.health),
      food: s.self.food,
      isDay: s.self.isDay,
      goal: s.goals.current?.text ?? null,
      role: s.goals.role ?? null,
      leader: Object.values(s.social).find((p) => p.allegiance === 'leader')?.name ?? null,
      partner: s.family.partner ?? null,
      village: s.goals.social.filter((g) => g.status === 'active').map((g) => g.text),
      option: opt ? { option: opt.option, status: opt.status, startedAt: opt.startedAt, ...(opt.skill ? { skill: opt.skill, args: brief(opt.args) } : {}), ...(opt.progress ? { progress: opt.progress } : {}), ...(opt.targetAgent ? { target: opt.targetAgent } : {}) } : null,
      emotions: { anger: r2(e.anger), fear: r2(e.fear), joy: r2(e.joy), sadness: r2(e.sadness), shame: r2(e.shame), envy: r2(e.envy), affection: r2(e.affection), arousal: r2(e.arousal) },
      mood: r2(s.mood.valence),
      caution: r2(s.drives.caution),
      flags: { inDanger: s.flags.inDanger, codeOnly: s.flags.codeOnly, degrade: s.flags.degrade, busy: s.flags.busyLevel },
      rungs: Object.fromEntries(Object.entries(s.conflict.rungs).filter(([, v]) => v > 0)),
      inventory: s.self.inventory.slice(0, 10).map((i) => `${i.qty} ${i.item}`),
      queue: s.taskQueue.slice(0, 5).map((t) => t.note ?? t.skill),
      combat: r2(Math.min(1, s.self.persona.abilities.combat + s.growth.combatGrowth)),
    });
  };
  const social = () => {
    const s = store.state;
    const t = now();
    const people = Object.values(s.social)
      .filter((p) => p.name !== me)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 16)
      .map((p) => ({
        name: p.name,
        sentiment: r2(p.sentiment),
        evidence: r2(p.evidence),
        trust: r2(p.trust),
        admiration: r2(p.admiration),
        fear: r2(p.fearOf),
        friction: r2(p.friction),
        resentment: r2(resentment(p, s.self.persona, t)),
        rung: s.conflict.rungs[p.name] ?? 0,
        lastSeen: p.lastSeen,
        ...(p.lastFight ? { lastFight: p.lastFight.outcome } : {}),
        // §19.2: how far it has gone with them, as this agent sees it.
        ...(p.relationship !== 'none' ? { relationship: p.relationship } : {}),
        ...(p.romanticInterest >= 0.05 ? { romanticInterest: r2(p.romanticInterest) } : {}),
        grievances: p.grievances.length,
      }));
    send('social', { people });
  };
  state();
  social();
  const st = setInterval(state, o.stateEveryMs ?? 5000);
  const so = setInterval(social, o.socialEveryMs ?? 15_000);
  st.unref();
  so.unref();
  offs.push(() => {
    clearInterval(st);
    clearInterval(so);
  });
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
