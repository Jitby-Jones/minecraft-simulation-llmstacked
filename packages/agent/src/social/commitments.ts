// Commitment tracking (§6.4): what was promised against what happens, checked in code. A `give` to us is kept when
// they hand the items over (seen tossed to us and collected); a `give` from us when our give action to them
// succeeds; `meet` when both are within 5 blocks of the place in time; `help` when they work or fight near us for
// a while. Anything still open at its deadline is broken, except `custom` promises, which an L1 judgment settles
// from what was observed. Resolutions feed Social Awareness (trust and sentiment) and working memory.

import type { AgentName, Commitment, CommitmentStatus, Logger } from '@agora/shared';
import type { LlmClient } from '@agora/llm';
import { z } from 'zod';
import type { AgentBus } from '../bus';
import { itemMatcher } from '../body/items';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';
import type { SocialAwareness } from './awareness';

const JudgmentSchema = z.object({ kept: z.boolean(), why: z.string().max(160).default('') });

export interface CommitmentTrackerOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  llm: LlmClient | null;
  me: AgentName;
  social: SocialAwareness;
  /** Seconds of nearby work that count as help. */
  helpSeconds?: number;
  now?: () => number;
}

/** How long items we tossed to someone stay theirs to pick up. */
const TOSSED_MS = 60_000;

function matches(item: string | undefined, got: string | undefined): boolean {
  if (!item || !got) return Boolean(!item && got);
  return itemMatcher(item).matches(got) || got.includes(item.replace(/s$/, ''));
}

export class CommitmentTracker {
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];
  /** Items we tossed to someone that they hadn't picked up when the give ended (theirs if they do soon, §6.6). */
  private readonly tossed: { to: AgentName; item: string; qty: number; at: number }[] = [];
  private readonly helpSeen = new Map<string, number>();
  private readonly judging = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly o: CommitmentTrackerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(
      this.o.bus.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind === 'gave' && a.target === this.o.me) this.received(a.actor, a.item, a.qty ?? 1);
        if (a.kind === 'collect' && a.item) this.pickedUp(a.actor, a.item, a.qty ?? 1);
        if ((a.kind === 'dig' || a.kind === 'swing') && a.pos) this.workedNearby(a.actor, a.pos);
      }),
    );
    this.offs.push(
      this.o.bus.on('actionRecorded', (e) => {
        const r = e.record;
        if (r.skill === 'give' && r.ok && typeof r.args.to === 'string') this.gave(r.args.to, typeof r.args.item === 'string' ? r.args.item : undefined, Number(r.args.qty ?? 1));
        const left = Number(r.data?.tossed ?? 0);
        if (r.skill === 'give' && !r.ok && left > 0 && typeof r.args.to === 'string' && typeof r.args.item === 'string') {
          this.tossed.push({ to: r.args.to, item: r.args.item, qty: left, at: this.now() });
          this.tossed.splice(0, Math.max(0, this.tossed.length - 8));
        }
      }),
    );
    this.offs.push(
      this.o.bus.on('optionTerminated', (e) => {
        if (e.reason === 'they said done' && e.option === 'help' && e.targetAgent) this.helpCalledOff(e.targetAgent);
      }),
    );
    this.timer = setInterval(() => void this.check(), 2000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  private open(): Commitment[] {
    return this.o.store.state.commitments.filter((c) => c.status === 'accepted' || c.status === 'proposed');
  }

  private resolve(c: Commitment, status: Extract<CommitmentStatus, 'fulfilled' | 'broken' | 'cancelled'>, verifiedBy?: Commitment['verifiedBy']): void {
    const now = this.now();
    this.o.store.update('commitments', (all) => all.map((x) => (x.id === c.id ? { ...x, status, resolvedAt: now, ...(verifiedBy ? { verifiedBy } : {}) } : x)), `commitment ${status}`);
    if (status === 'cancelled') return;
    const kept = status === 'fulfilled';
    if (c.debtor === this.o.me) {
      pushWorkmem(this.o.store, kept ? `I kept my promise to ${c.creditor}: ${c.what.text}` : `I broke my promise to ${c.creditor}: ${c.what.text}`, kept ? 0.5 : 0.8, 'self_observed', { aboutAgent: c.creditor, now });
    } else this.o.social.promiseResolved(c, kept);
    this.o.bus.emit({ type: 'commitmentResolved', commitmentId: c.id, status });
    this.o.logger.info({ module: 'commitments', debtor: c.debtor, creditor: c.creditor, what: c.what.text, status }, 'commitment resolved');
  }

  /** They handed us items: progress on their `give` promises. */
  private received(from: AgentName, item: string | undefined, qty: number): void {
    for (const c of this.open()) {
      if (c.debtor !== from || c.creditor !== this.o.me || (c.what.kind !== 'give' && c.what.kind !== 'gather')) continue;
      if (!matches(c.what.item, item)) continue;
      const progress = (c.progress ?? 0) + qty;
      if (progress >= (c.what.qty ?? 1)) this.resolve({ ...c, progress }, 'fulfilled', 'inventory');
      else this.o.store.update('commitments', (all) => all.map((x) => (x.id === c.id ? { ...x, progress } : x)), 'partly delivered');
      return;
    }
  }

  /** §6.6: what we tossed to someone and they picked up a little later (seen) was handed over after all. */
  private pickedUp(who: AgentName, item: string, qty: number): void {
    const t = this.now();
    const i = this.tossed.findIndex((x) => x.to === who && t - x.at <= TOSSED_MS && matches(x.item, item));
    const x = this.tossed[i];
    if (!x) return;
    this.tossed.splice(i, 1);
    this.gave(who, x.item, Math.min(x.qty, qty));
  }

  /** We handed items over: progress on our own `give` promises (and on help, whose gatherings are handed over). */
  private gave(to: AgentName, item: string | undefined, qty: number): void {
    for (const c of this.open()) {
      if (c.debtor !== this.o.me || c.creditor !== to || (c.what.kind !== 'give' && c.what.kind !== 'gather' && c.what.kind !== 'help')) continue;
      if (!matches(c.what.item, item)) continue;
      const progress = (c.progress ?? 0) + qty;
      if (progress >= (c.what.qty ?? 1)) this.resolve({ ...c, progress }, 'fulfilled', 'inventory');
      else this.o.store.update('commitments', (all) => all.map((x) => (x.id === c.id ? { ...x, progress } : x)), 'partly delivered');
      return;
    }
  }

  /**
   * §6.7: the one we were helping said it's enough. Whatever we gathered so far is still theirs (the queued
   * hand-over shrinks to it); with nothing gathered the help is simply done.
   */
  private helpCalledOff(who: AgentName): void {
    const c = this.open().find((x) => x.debtor === this.o.me && x.creditor === who && x.what.kind === 'help');
    if (!c) return;
    const item = c.what.item;
    const m = item ? itemMatcher(item) : null;
    const have = m ? this.o.store.state.self.inventory.filter((x) => m.matches(x.item)).reduce((a, x) => a + x.qty, 0) : 0;
    const qty = Math.min(c.what.qty ?? 1, have);
    if (qty <= 0) {
      this.resolve(c, 'fulfilled', 'observation');
      return;
    }
    this.o.store.update('commitments', (all) => all.map((x) => (x.id === c.id ? { ...x, what: { ...x.what, qty } } : x)), 'help called off');
    this.o.store.update('taskQueue', (q) => q.map((t) => (t.commitmentId === c.id && t.skill === 'give' ? { ...t, args: { ...t.args, qty } } : t)), 'hand over what was gathered');
  }

  private workedNearby(actor: AgentName, pos: { x: number; y: number; z: number }): void {
    const me = this.o.store.state.self.pos;
    if (Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z) > 8) return;
    for (const c of this.open()) {
      if (c.debtor !== actor || c.creditor !== this.o.me || c.what.kind !== 'help') continue;
      const seen = (this.helpSeen.get(c.id) ?? 0) + 1;
      this.helpSeen.set(c.id, seen);
      // Swings and digs come about once a second while someone works.
      if (seen >= (this.o.helpSeconds ?? 30)) this.resolve(c, 'fulfilled', 'observation');
    }
  }

  private async check(): Promise<void> {
    const now = this.now();
    const s = this.o.store.state;
    for (const c of this.open()) {
      if (c.what.kind === 'meet' && c.what.pos) {
        const p = c.what.pos;
        const meNear = Math.hypot(s.self.pos.x - p.x, s.self.pos.y - p.y, s.self.pos.z - p.z) <= 5;
        const other = c.debtor === this.o.me ? c.creditor : c.debtor;
        const them = s.perception.nearbyEntities.find((e) => e.kind === 'player' && e.name === other);
        if (meNear && them && Math.hypot(them.pos.x - p.x, them.pos.y - p.y, them.pos.z - p.z) <= 5) {
          this.resolve(c, 'fulfilled', 'observation');
          continue;
        }
      }
      if (c.dueBy === undefined || now < c.dueBy) continue;
      if (c.what.kind === 'custom' && c.debtor !== this.o.me) {
        if (!this.judging.has(c.id)) {
          this.judging.add(c.id);
          void this.judge(c).finally(() => this.judging.delete(c.id));
        }
        continue;
      }
      this.resolve(c, 'broken');
    }
  }

  /** §6.4 custom promises: an L1 judgment at the deadline from what was seen (no model: let it lapse unjudged). */
  private async judge(c: Commitment): Promise<void> {
    if (!this.o.llm || this.o.store.state.flags.codeOnly) {
      this.resolve(c, 'cancelled');
      return;
    }
    const seen = this.o.store.state.perception.observedActions.filter((a) => a.actor === c.debtor && a.ts >= c.createdAt).slice(-12);
    const r = await this.o.llm.call<{ kept: boolean; why: string }>({
      tier: 'L1',
      module: 'social',
      agent: this.o.me,
      schema: JudgmentSchema,
      schemaName: 'judgment',
      fallback: () => ({ kept: false, why: 'could not tell' }),
      messages: [
        { role: 'system', content: 'Judge from the observations only whether the promise was kept. JSON: {"kept": true|false, "why": "..."}' },
        {
          role: 'user',
          content: `${c.debtor} promised: ${c.what.text}\nWhat you saw them do since: ${seen.map((a) => `${a.kind}${a.item ? ` ${a.item}` : ''}${a.target ? ` → ${a.target}` : ''}`).join('; ') || 'nothing'}`,
        },
      ],
    });
    this.resolve(c, r.ok && r.value.kept ? 'fulfilled' : 'broken', 'judgment');
  }
}
