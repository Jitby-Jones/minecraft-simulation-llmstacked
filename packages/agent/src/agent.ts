// One agent (§4): a body plus concurrent modules sharing the Agent State blackboard. Perception and reflexes are
// code; the Cognitive Controller decides; the executor and Talking carry the decision out, so what the agent says
// matches what it does. Works with an LLM client or without one (code-only, §22.4).

import { type AgentName, type Logger, type Persona, type WorldConfig, WorldConfigSchema, parseProximityLine } from '@agora/shared';
import type { Embedder, LlmClient, QuotaGovernor } from '@agora/llm';
import { AgentBus } from './bus';
import type { MemoryDB } from './memory/db';
import { Memory } from './memory/memory';
import { GoalGen } from './modules/goalGen';
import { SocialGoalGen } from './modules/socialGoalGen';
import { RoleWatch } from './social/roles';
import { villageView } from './social/village';
import { EDIBLE } from './modules/villageMove';
import { QuirkRunner } from './modules/quirkRunner';
import type { Body } from './body/body';
import { cannedBusyLine } from './body/reflexes';
import { ActionAwareness } from './modules/awareness';
import { CognitiveController } from './modules/cc';
import { Conversations } from './modules/conversations';
import { SkillExecutor } from './modules/executor';
import { type MindLevers, leversFor } from './modules/levers';
import { SelfMonitor } from './modules/selfMonitor';
import { Talking } from './modules/talking';
import { Perception } from './perception/perception';
import { SocialAwareness } from './social/awareness';
import { ClaimChecker } from './social/claims';
import { CommitmentTracker } from './social/commitments';
import { DeathWatch } from './social/deaths';
import { DeedWatch } from './social/deeds';
import { TradeTracker } from './social/trades';
import { CATEGORIES, gearScore, normalizeItemName } from './body/items';
import { BiasWatch } from './mind/biasWatch';
import { ConflictEvaluator } from './conflict/evaluator';
import { SURRENDER_RE } from './body/skills/duel';
import { Crowd } from './mind/crowd';
import { Feelings } from './mind/feelings';
import { Impulses } from './mind/impulses';
import { Mind } from './mind/mind';
import { feelingText } from './modules/talking';
import { Impressions } from './social/impressions';
import { createInitialState } from './state/initial';
import { AgentStateStore } from './state/store';
import { pushWorkmem } from './state/workmem';

export interface AgentOptions {
  body: Body;
  persona: Persona;
  username: AgentName;
  llm: LlmClient | null;
  logger: Logger;
  world?: WorldConfig;
  /** Quota mode for flags.degrade / codeOnly (the Hub's budget messages take over in M5). */
  governor?: QuotaGovernor;
  /** Long-term memory (M4): the bot's SQLite file and the shared embedder. Without it the agent only has workmem. */
  memory?: { db: MemoryDB; embedder: Embedder };
  /** Goal Generation picks goals (M4). Off when a test or the runner drives goals by hand. */
  goalGen?: boolean;
  /** Social Goal Gen (§6.8): on with Goal Gen unless the world config turns it off. */
  socialGoals?: boolean;
  /** Dice for impulses and first impressions (tests pin them). */
  rng?: () => number;
  /** A world-wide fight slot (§17.10, the Hub's fight tokens); without it every fight the gate allows may start. */
  fightSlot?: { acquire(): Promise<boolean>; release(): void };
  now?: () => number;
}

export class Agent {
  readonly store: AgentStateStore;
  readonly bus = new AgentBus();
  readonly perception: Perception;
  readonly conversations: Conversations;
  readonly executor: SkillExecutor;
  readonly awareness: ActionAwareness;
  readonly talking: Talking;
  readonly selfMonitor: SelfMonitor;
  readonly cc: CognitiveController;
  readonly memory: Memory | null;
  readonly goalGen: GoalGen | null;
  readonly socialGoals: SocialGoalGen | null;
  readonly roles: RoleWatch;
  readonly quirks: QuirkRunner;
  readonly social: SocialAwareness;
  readonly commitments: CommitmentTracker;
  readonly deaths: DeathWatch;
  readonly claims: ClaimChecker;
  readonly deeds: DeedWatch;
  readonly trades: TradeTracker;
  readonly feelings: Feelings;
  readonly mind: Mind;
  readonly impressions: Impressions;
  readonly impulses: Impulses;
  readonly crowd: Crowd;
  readonly biases: BiasWatch;
  readonly conflict: ConflictEvaluator;
  private dangerSource = '';
  /** The danger was a person (by name, or "someone"): no article. */
  private dangerIsPerson = false;
  private yieldSaidAt = -Infinity;
  private yieldPending = false;
  private readonly fightCapReached: () => boolean;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly o: AgentOptions) {
    const { body, persona, username, llm, logger } = o;
    const now = o.now ?? Date.now;
    this.store = new AgentStateStore(createInitialState({ persona, username, now: now() }));
    const levers = (): MindLevers => leversFor(persona.abilities.intelligence, o.world?.abilities.intelligenceRoutesCCTier ?? true);
    const speechRange = o.world?.chat.normalRange ?? 15;
    this.perception = new Perception({ bot: body.bot, store: this.store, bus: this.bus, logger, speechRange, home: () => body.home, now });
    this.conversations = new Conversations({ store: this.store, bus: this.bus, logger, me: username, inRange: () => this.perception.peopleInRange(), now });
    const fightSlot = o.fightSlot;
    // A refused fight slot is remembered for a while: the gate then says so instead of the CC retrying every 2 s.
    let slotDeniedAt = -Infinity;
    this.fightCapReached = () => now() - slotDeniedAt < 30_000;
    this.executor = new SkillExecutor({
      store: this.store,
      bus: this.bus,
      body,
      logger,
      levers,
      combat: () => Math.min(1, persona.abilities.combat + this.store.state.growth.combatGrowth),
      ...(fightSlot
        ? {
            acquireFight: async () => {
              const ok = await fightSlot.acquire();
              if (!ok) slotDeniedAt = now();
              return ok;
            },
            releaseFight: () => fightSlot.release(),
          }
        : {}),
      now,
    });
    this.awareness = new ActionAwareness({ store: this.store, bus: this.bus, logger, now });
    this.memory = o.memory ? new Memory({ store: this.store, bus: this.bus, logger, db: o.memory.db, embedder: o.memory.embedder, llm, me: username, now }) : null;
    const mem = this.memory;
    const memories = mem ? (k: number) => mem.forPacket(k) : undefined;
    this.talking = new Talking({
      store: this.store,
      bus: this.bus,
      body,
      logger,
      llm,
      conversations: this.conversations,
      executor: this.executor,
      me: username,
      ...(mem ? { recall: (text: string, k: number) => mem.relevantTo(text, k) } : {}),
      rungOf: (name) => this.conflict.rungOf(name),
      now,
    });
    this.selfMonitor = new SelfMonitor({ store: this.store, bus: this.bus, logger, llm, me: username, now });
    this.cc = new CognitiveController({
      store: this.store,
      bus: this.bus,
      logger,
      llm,
      me: username,
      levers,
      awareness: this.awareness,
      executor: this.executor,
      canPerceive: (name) =>
        this.perception.peopleInRange().includes(name) || this.store.state.perception.nearbyEntities.some((e) => e.kind === 'player' && e.name === name),
      ...(memories ? { memories } : {}),
      refreshSelf: () => this.perception.refreshSelf(),
      socialCandidates: () => this.perception.peopleInRange().filter((n) => this.conversations.mayInitiate(n)),
      isItem: (word) => {
        const n = normalizeItemName(word);
        return n in CATEGORIES || n === 'food' || Boolean(body.bot.registry.itemsByName[n]);
      },
      liking: (name) => this.mind.liking(name),
      conflict: {
        rungOf: (n) => this.conflict.rungOf(n),
        fearOf: (n) => this.store.state.social[n]?.fearOf ?? 0,
        mayFight: (t, intent) => this.conflict.mayFight(t, intent),
      },
      isPerson: (n) => Boolean(body.bot.players[n]) || Boolean(this.store.state.social[n]),
      mindLines: () => {
        const s = this.store.state;
        const lines: string[] = [];
        const f = feelingText(s.emotions);
        const g = this.feelings.grudges()[0];
        if (f) lines.push(`You feel ${f}${g ? ` (angry at ${g.name})` : ''}.`);
        const people = s.perception.nearbyEntities.filter((e) => e.kind === 'player').map((e) => e.name).slice(0, 3);
        lines.push(...this.mind.packetLines(people));
        // §17.11: where things stand with each of them.
        for (const n of people) {
          const r = this.conflict.pressureOf(n);
          const rung = this.conflict.rungOf(n);
          if (rung === 0 && r.resentment < 0.3) continue;
          const g = [...(s.social[n]?.grievances ?? [])].sort((a, b) => b.weight - a.weight)[0];
          lines.push(`${n}: resentment ${r.resentment.toFixed(1)}, fear ${r.fear.toFixed(1)}, ${['keep away', 'hostile talk', 'threats', 'ready to fight', 'deadly'][rung] ?? 'calm'}${g ? `; worst: ${g.note ?? g.kind}` : ''}`);
        }
        return lines;
      },
      claimToCheck: () => {
        const c = this.claims.open()[0];
        const me = this.store.state.self.pos;
        return c && Math.hypot(c.pos.x - me.x, c.pos.z - me.z) <= 64 ? { pos: c.pos, by: c.by, item: c.item } : undefined;
      },
      now,
    });
    this.goalGen =
      o.goalGen === false
        ? null
        : new GoalGen({ store: this.store, bus: this.bus, logger, llm, me: username, setGoal: (t, d) => this.cc.setGoal(t, d), ...(memories ? { memories } : {}), now });
    const rng = o.rng ? { rng: o.rng } : {};
    const world = o.world ?? WorldConfigSchema.parse({});
    this.roles = new RoleWatch({ store: this.store, bus: this.bus, me: username, now });
    this.socialGoals =
      (o.socialGoals ?? (o.goalGen !== false && world.community.socialGoals))
        ? new SocialGoalGen({
            store: this.store,
            bus: this.bus,
            logger,
            llm,
            me: username,
            community: world.community.goal,
            view: () => villageView(this.store.state, this.roles.others(), now()),
            ...rng,
            now,
          })
        : null;
    this.feelings = new Feelings({ store: this.store, bus: this.bus, logger, me: username, contagionScale: () => (this.crowd.inMob() ? 1.5 : 1), ...rng, now });
    const myGear = () => {
      const inv = body.bot.inventory;
      const armor = [5, 6, 7, 8].map((i) => inv.slots[i]?.name).filter((n): n is string => Boolean(n));
      return gearScore(armor, body.bot.heldItem?.name ?? null);
    };
    this.mind = new Mind(() => this.store.state, {
      secondsSinceTrigger: () => this.feelings.secondsSinceTrigger(),
      angerToward: (n) => this.feelings.angerToward(n),
      inCrowd: () => this.crowd.inMob(),
      myGear,
      now,
    });
    this.social = new SocialAwareness({
      store: this.store,
      bus: this.bus,
      logger,
      llm,
      me: username,
      mind: {
        override: () => this.mind.override(),
        // §18.4.1 fearLevel = max(fear, caution above its baseline); a feared leader joins in with M8b.
        fearLevel: () => Math.max(this.store.state.emotions.fear, this.store.state.drives.caution - this.store.state.drives.cautionBaseline),
      },
      now,
    });
    this.commitments = new CommitmentTracker({ store: this.store, bus: this.bus, logger, llm, me: username, social: this.social, now });
    this.deaths = new DeathWatch({ store: this.store, bus: this.bus, logger, me: username, sawDeath: (name, ms) => this.perception.saw(name, 'death', ms), now });
    this.claims = new ClaimChecker({ store: this.store, bus: this.bus, logger, bot: body.bot, social: this.social, ...(mem ? { markFalse: (t: string) => void mem.markFalseMatching(t) } : {}), now });
    this.impressions = new Impressions({ store: this.store, bus: this.bus, logger, me: username, myGear, ...rng, now });
    this.impulses = new Impulses({
      store: this.store,
      bus: this.bus,
      logger,
      me: username,
      cc: this.cc,
      talking: this.talking,
      conversations: this.conversations,
      mayPunch: (t) => this.conflict.mayPunch(t),
      ...rng,
      now,
    });
    this.crowd = new Crowd({
      store: this.store,
      bus: this.bus,
      logger,
      me: username,
      angerToward: (n) => this.feelings.angerToward(n),
      override: () => this.mind.override(),
      liking: (n) => this.mind.liking(n),
      say: (to, text) => this.talking.blurt(to, text),
      now,
    });
    this.conflict = new ConflictEvaluator({
      store: this.store,
      bus: this.bus,
      logger,
      me: username,
      config: world.conflict,
      mode: world.mode,
      myGear,
      inMob: (t) => this.crowd.isMob(t),
      fightCapReached: this.fightCapReached,
      bornAt: now(),
      ...rng,
      now,
    });
    this.biases = new BiasWatch({ store: this.store, bus: this.bus, logger, me: username, override: () => this.mind.override(), nudge: (n, d, note) => this.social.nudge(n, d, note), ...rng, now });
    this.trades = new TradeTracker({ store: this.store, bus: this.bus, logger, me: username, onDeal: (w, ours, theirs) => this.cc.recordDeal(w, ours, theirs), now });
    // Our own yield, as the chat echoes it back (a duel's, or the reflex's below): said once is enough.
    const ownYield = (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind === 'speech' && p.speaker === username && SURRENDER_RE.test(p.text)) {
        this.yieldSaidAt = now();
        this.conflict.ownYield();
      }
    };
    body.bot.on('messagestr', ownYield);
    this.offs.push(() => body.bot.off('messagestr', ownYield));
    // Notable deeds move sentiment by code (§6.3 rule 2).
    this.deeds = new DeedWatch({ bot: body.bot, store: this.store, social: this.social, me: username, placed: body.placed, now });
    this.offs.push(
      this.bus.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind === 'gave' && a.target === username) this.social.deed(a.actor, 'gaveMeItems', `${a.actor} gave me ${a.qty ?? 1} ${a.item ?? 'things'}`);
        if (a.kind === 'attack' && a.target) this.deeds.sawAttack(a.actor, a.target);
      }),
    );
    // Starving with nothing to eat (§16.3): food comes before whatever the agent is doing, so wake the CC at once.
    let starvingAt = -Infinity;
    const onSelf = (c: { facet: string }) => {
      if (c.facet !== 'self') return;
      const me = this.store.state.self;
      if (me.food > 6 || now() - starvingAt < 60_000 || me.inventory.some((i) => EDIBLE.test(i.item))) return;
      starvingAt = now();
      this.cc.trigger('starving, with nothing to eat', { urgent: true });
    };
    this.store.on('change', onSelf);
    this.offs.push(() => this.store.off('change', onSelf));
    // §6.8: what we saw inside a chest we opened (the village chest's contents), and what signs say.
    this.offs.push(
      this.bus.on('actionRecorded', (e) => {
        const d = e.record.data as { chest?: { x: number; y: number; z: number }; contents?: Record<string, number> } | undefined;
        if ((e.record.skill === 'deposit' || e.record.skill === 'withdraw') && d?.chest && d.contents) this.perception.village?.sawInside(d.chest, d.contents);
      }),
    );
    this.offs.push(this.bus.on('signRead', (e) => this.readSign(e.sign.text, e.sign.pos, e.board)));
    this.quirks = new QuirkRunner({
      store: this.store,
      bus: this.bus,
      body,
      cc: this.cc,
      executor: this.executor,
      logger,
      quirks: persona.quirks,
      peopleInRange: () => this.perception.peopleInRange(),
      now,
    });
    body.setQuirks(persona.quirks);
    body.reflexes.setHooks({
      caution: () => this.store.state.drives.caution,
      combat: () => Math.min(1, persona.abilities.combat + this.store.state.growth.combatGrowth),
      shouldDefend: (name) => Boolean(this.store.state.social[name]) && this.mind.liking(name) >= 7,
      // Self-defense is always allowed; deliberate fights are code-gated in the conflict core (M6b).
      mayFightBack: () => true,
      deliberateFight: () => ['attack', 'duel'].includes(this.store.state.option?.skill ?? ''),
      // In a duel the duel yields first; the reflexes flee only below that (§17.6).
      fightFloor: () => {
        const opt = this.store.state.option;
        return opt?.skill === 'duel' ? Math.max(1, Number(opt.args?.stopAtHealth ?? 8) - 1) : null;
      },
      onYield: (to) => this.sayYield(to),
      settled: (name, since) => this.conflict.settled(name, since),
      isIdle: () => this.executor.idleBody,
      mayPickUp: (item) => this.perception.mayPickUp(item.id),
      fearBoost: (source) => this.biases.fearBoost(source),
      onAllyAttacked: (ally, by) => {
        this.deeds.allyAttacked(ally, by);
        if (by && body.bot.players[by]) this.impressions.wronged(by, `they attacked ${ally}`);
      },
      onHelpedFight: (helper) => this.deeds.helpedFight(helper),
      onDanger: (info) => {
        // A person is someone by name (their nametag), a mob "a zombie".
        const person = info.attacker && body.bot.players[info.attacker] ? info.attacker : info.source === 'attacker' ? 'someone' : null;
        this.dangerSource = person ?? info.source;
        this.dangerIsPerson = person !== null;
        this.store.update('flags', (f) => ({ ...f, inDanger: true, busyLevel: 'critical', busySpeech: person ? 'not now!' : cannedBusyLine(info.source) }), `danger: ${info.kind} ${this.dangerSource}`);
        logger.info({ module: 'reflex', kind: info.kind, source: info.source, ...(info.attacker ? { attacker: info.attacker } : {}), health: body.bot.health }, 'danger');
        this.bus.emit({ type: 'danger', source: info.source, level: info.level });
      },
      onDangerCleared: (summary) => {
        this.store.update('flags', (f) => ({ ...f, inDanger: false, busySpeech: null, busyLevel: this.executor.busy ? 'working' : 'idle' }), 'danger cleared');
        const who = this.dangerIsPerson ? this.dangerSource : `${/^[aeiou]/i.test(this.dangerSource) ? 'an' : 'a'} ${this.dangerSource}`;
        const what = summary === 'fight over' ? `fought off ${who}` : summary === 'got away' ? `got away from ${who}` : `escaped ${this.dangerSource}`;
        pushWorkmem(this.store, `I ${what}`, 0.6, 'self_observed', { now: now() });
        this.bus.emit({ type: 'dangerCleared' });
      },
      onAttacked: (by, damage) => {
        this.bus.emit({ type: 'attacked', by, damage });
        // Players are people: being hit by one counts against them (§6.3); mobs are just danger.
        if (by && body.bot.players[by]) {
          this.social.deed(by, 'attackedMe', `${by} hit me`);
          this.impressions.wronged(by, 'they hit me');
        }
      },
    });
    if (o.governor) {
      const apply = () => {
        const q = o.governor?.status;
        if (!q) return;
        this.store.update('flags', (f) => (f.degrade === q.level && f.codeOnly === q.codeOnly ? f : { ...f, degrade: q.level, codeOnly: q.codeOnly }), 'quota mode');
      };
      apply();
      o.governor.on('change', apply);
      this.offs.push(() => o.governor?.off('change', apply));
    }
  }

  get name(): AgentName {
    return this.o.username;
  }

  start(): void {
    this.o.body.reflexes.start();
    this.perception.start();
    this.conversations.start();
    this.awareness.start();
    this.executor.start();
    this.talking.start();
    this.selfMonitor.start();
    this.memory?.start();
    this.cc.start();
    this.goalGen?.start();
    this.roles.start();
    this.socialGoals?.start();
    this.quirks.start();
    this.social.start();
    this.commitments.start();
    this.deaths.start();
    this.claims.start();
    this.deeds.start();
    this.trades.start();
    this.feelings.start();
    this.impressions.start();
    this.impulses.start();
    this.crowd.start();
    this.biases.start();
    this.conflict.start();
    this.o.logger.info({ module: 'agent', persona: this.o.persona.name, llm: this.o.llm ? 'on' : 'code-only', memory: this.memory ? 'on' : 'off' }, 'agent started');
  }

  /** Stops every module; what is still on the agent's mind is written to memory first (§23.4). */
  async stop(): Promise<void> {
    this.conflict.stop();
    this.biases.stop();
    this.crowd.stop();
    this.impulses.stop();
    this.impressions.stop();
    this.feelings.stop();
    this.trades.stop();
    this.deeds.stop();
    this.claims.stop();
    this.deaths.stop();
    this.commitments.stop();
    this.social.stop();
    this.quirks.stop();
    this.socialGoals?.stop();
    this.roles.stop();
    this.goalGen?.stop();
    this.cc.stop();
    this.memory?.stop();
    await this.memory?.flush();
    this.selfMonitor.stop();
    this.talking.stop();
    this.executor.stop();
    this.awareness.stop();
    this.conversations.stop();
    this.perception.stop();
    this.o.body.reflexes.stop();
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * §17.6: running from a person, say we give up so they stop. A duel that is giving up says so itself, so wait a
   * moment to hear it first; and say it only once.
   */
  private sayYield(to: AgentName): void {
    const now = this.o.now ?? Date.now;
    if (now() - this.yieldSaidAt < 20_000 || this.yieldPending) return;
    this.yieldPending = true;
    setTimeout(() => {
      this.yieldPending = false;
      if (now() - this.yieldSaidAt < 20_000) return;
      this.yieldSaidAt = now();
      void this.talking.blurt(to, 'ok ok, I give up!');
    }, 1500).unref();
  }

  /**
   * A sign read (§6.8, §16.3): what it says goes on our mind as something seen ourselves; news of a death on it
   * makes us a little more careful, as hearing of one does, less than seeing it.
   */
  private readSign(text: string, pos: { x: number; z: number }, board: boolean): void {
    const now = this.o.now ?? Date.now;
    const death = /\b(died|dead|killed|slain|drowned|burned|fell|blew up|lava|RIP)\b/i.test(text);
    pushWorkmem(this.store, `a sign ${board ? 'at the village board' : `at ${Math.round(pos.x)}, ${Math.round(pos.z)}`} says "${text}"`, death ? 0.7 : 0.5, 'self_observed', { now: now() });
    if (death) this.store.update('drives', (d) => ({ ...d, caution: Math.min(1, Math.round((d.caution + 0.05) * 1000) / 1000) }), 'death news on a sign');
    this.o.logger.info({ module: 'perception', text, board, death }, 'read a sign');
  }

  setGoal(text: string, doneWhen?: string): void {
    this.cc.setGoal(text, doneWhen);
  }
}
