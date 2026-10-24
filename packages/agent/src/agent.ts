// One agent (§4): a body plus concurrent modules sharing the Agent State blackboard. Perception and reflexes are
// code; the Cognitive Controller decides; the executor and Talking carry the decision out, so what the agent says
// matches what it does. Works with an LLM client or without one (code-only, §22.4).

import { type AgentName, type BirthFacts, type Logger, type Persona, type Sex, type Tuning, type Vec3, type WorldConfig, WorldConfigSchema, isPrivateHost, parseProximityLine } from '@agora/shared';
import type { Embedder, LlmCallOptions, LlmClient, LlmResult, QuotaGovernor } from '@agora/llm';
import { AgentBus } from './bus';
import type { MemoryDB } from './memory/db';
import { Memory } from './memory/memory';
import { GoalGen } from './modules/goalGen';
import { SocialGoalGen } from './modules/socialGoalGen';
import { Reflection } from './modules/reflection';
import { RoleWatch } from './social/roles';
import { villageView } from './social/village';
import { EDIBLE } from './modules/villageMove';
import { QuirkRunner } from './modules/quirkRunner';
import type { Body } from './body/body';
import { cannedBusyLine } from './body/reflexes';
import { ActionAwareness } from './modules/awareness';
import { CognitiveController } from './modules/cc';
import { Consensus } from './modules/consensus';
import { Conversations } from './modules/conversations';
import { SkillExecutor } from './modules/executor';
import { type MindLevers, leversFor } from './modules/levers';
import { NOW_RE, swornWith } from './modules/powerMove';
import { SelfMonitor } from './modules/selfMonitor';
import { SkillWriter } from './modules/skillWriter';
import { SkillLibrary } from './skills/learned';
import { Talking } from './modules/talking';
import { Perception } from './perception/perception';
import { SocialAwareness } from './social/awareness';
import { ClaimChecker } from './social/claims';
import { CommitmentTracker } from './social/commitments';
import { DeathWatch } from './social/deaths';
import { DeedWatch } from './social/deeds';
import { SurroundingsWatch } from './perception/surroundings';
import { TradeTracker } from './social/trades';
import { CATEGORIES, gearScore, normalizeItemName } from './body/items';
import { BiasWatch } from './mind/biasWatch';
import { ConflictEvaluator } from './conflict/evaluator';
import { PowerWatch } from './conflict/power';
import { authorityShift, defendsAlly } from './conflict/coercion';
import { conformityOf, conformityPull, susceptibilityToward } from './mind/biases';
import { SURRENDER_RE } from './body/skills/duel';
import { Crowd } from './mind/crowd';
import { Feelings } from './mind/feelings';
import { Impulses } from './mind/impulses';
import { Mind } from './mind/mind';
import { feelingText } from './modules/talking';
import { Impressions } from './social/impressions';
import { RomanceWatch } from './social/romanceWatch';
import { FamilyWatch } from './social/familyWatch';
import { applyBirthFacts } from './state/birth';
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
  /** Born in-world (§19.4): what it starts out knowing, and when its youth ends. */
  birth?: { facts: BirthFacts; youthUntil: number };
  /** The tier Talking writes lines with (models.yaml speech.tier). */
  speechTier?: 'L1' | 'L2' | 'L3';
  /** Models tried first for a line, and their per-try timeout (models.yaml speech.models, speech.timeoutMs). */
  speechModels?: readonly string[];
  speechTimeoutMs?: number;
  /** §19.3: the bed ritual done beside our partner: the Hub is told (conception), with what we believe of them. */
  onConception?: (c: { partner: AgentName; bedPos: Vec3; partnerModel: Record<string, number>; partnerSex: Sex | 'unknown' }) => void;
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
  /** Ends a talk once it has settled what to do (owner request, 2026-10-24). */
  readonly consensus: Consensus;
  readonly selfMonitor: SelfMonitor;
  readonly cc: CognitiveController;
  readonly memory: Memory | null;
  readonly goalGen: GoalGen | null;
  readonly socialGoals: SocialGoalGen | null;
  readonly reflection: Reflection;
  readonly roles: RoleWatch;
  readonly quirks: QuirkRunner;
  readonly social: SocialAwareness;
  readonly commitments: CommitmentTracker;
  readonly deaths: DeathWatch;
  readonly claims: ClaimChecker;
  readonly deeds: DeedWatch;
  /** What changed around us (a broken shelter wall, a door, a block set down). */
  readonly surroundings: SurroundingsWatch;
  readonly trades: TradeTracker;
  readonly feelings: Feelings;
  readonly mind: Mind;
  readonly impressions: Impressions;
  readonly impulses: Impulses;
  readonly crowd: Crowd;
  readonly biases: BiasWatch;
  readonly conflict: ConflictEvaluator;
  readonly power: PowerWatch;
  readonly romance: RomanceWatch;
  readonly family: FamilyWatch;
  /** M10: the skills the agent wrote for itself, and the writer. */
  readonly skills: SkillLibrary;
  readonly skillWriter: SkillWriter;
  /** The current goal's embedding, for picking the learned skills most to do with it. */
  private goalVec: { text: string; v: Float32Array } | null = null;
  private dangerSource = '';
  /** The danger was a person (by name, or "someone"): no article. */
  private dangerIsPerson = false;
  private yieldSaidAt = -Infinity;
  private yieldPending = false;
  /** When we last called a fight off on each person (the reflexes, once they've taken a beating). */
  private readonly calledOffAt = new Map<AgentName, number>();
  private readonly fightCapReached: () => boolean;
  private readonly offs: (() => void)[] = [];
  /** Aborted at death: every model call of this agent, under way or to come, ends there. */
  private readonly halting = new AbortController();
  private dead = false;
  private modulesHalted = false;

  constructor(private readonly o: AgentOptions) {
    const { body, persona, username, logger } = o;
    const llm = o.llm ? haltable(o.llm, this.halting.signal) : null;
    const now = o.now ?? Date.now;
    const world = o.world ?? WorldConfigSchema.parse({});
    const sw = world.skillWriter;
    this.skills = new SkillLibrary(o.memory?.db ?? null, { memoryMb: sw.memoryMb, cpuMs: sw.cpuMs, wallMs: sw.wallSec * 1000, maxCalls: sw.maxCalls });
    this.store = new AgentStateStore(createInitialState({ persona, username, now: now(), ...(o.birth ? { born: true, youthUntil: o.birth.youthUntil } : {}) }));
    if (o.birth) applyBirthFacts(this.store, o.birth.facts, persona, now());
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
      extraSkills: () => this.skills.skills(this.skillWriter.onTrial()),
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
      ...(o.speechTier ? { tier: o.speechTier } : {}),
      ...(o.speechModels && o.speechModels.length > 0 ? { models: o.speechModels } : {}),
      ...(o.speechTimeoutMs ? { timeoutMs: o.speechTimeoutMs } : {}),
      now,
    });
    this.consensus = new Consensus({ store: this.store, bus: this.bus, logger, llm, conversations: this.conversations, me: username, now });
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
        resentmentOf: (n) => this.conflict.resentmentOf(n),
        // §18.4 authority: a demand from the leader we follow, someone seen leading, or an idol, is easier to give in to.
        authorityOf: (n) => {
          const p = this.store.state.social[n];
          return authorityShift({
            leader: this.power.leader() === n || p?.perceivedRole === 'leader',
            admiration: p?.admiration ?? 0,
            susceptibility: persona.mind.biasProfile.authority,
            override: this.mind.override(),
          });
        },
        fearWith: (n, allies) => this.conflict.fearWith(n, allies),
        // §18.4.1: most of those they asked paid them; paying comes easier.
        bandwagon: (n) => {
          const share = this.power.tributeShare(n);
          return share !== null && share >= 0.6 ? this.pull(n) * 0.3 : 0;
        },
        mayFight: (t, intent, opts) => this.conflict.mayFight(t, intent, opts),
      },
      power: {
        leader: () => this.power.leader(),
        coalition: (t) => this.power.coalition(t),
        knownResenters: (t) => this.power.knownResenters(t),
        quiet: (x) => this.pull(x),
      },
      romance: {
        partner: () => this.romance.partner(),
        relationshipWith: (n) => this.romance.relationshipWith(n),
        courtship: () => this.romance.courtship(),
        reactionTo: (n) => this.romance.reactionTo(n),
        wouldAccept: (n) => this.romance.wouldAccept(n),
        mayCourt: (n) => this.romance.mayCourt(n),
      },
      family: {
        step: () => this.family.step(),
        whyNotFamily: (n) => this.family.whyNotFamily(n),
        young: () => this.family.young(),
      },
      learned: {
        find: (n) => this.skills.find(n, this.skillWriter.onTrial()),
        offered: () => this.skills.offered(sw.offered, this.goalQuery()),
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
        lines.push(...this.powerLines(people));
        lines.push(...this.romance.mindLines());
        lines.push(...this.family.mindLines());
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
        : new GoalGen({
            store: this.store,
            bus: this.bus,
            logger,
            llm,
            me: username,
            setGoal: (t, d) => this.cc.setGoal(t, d),
            ...(memories ? { memories } : {}),
            hints: () => {
              const h = this.family.hint();
              return h ? [h] : [];
            },
            now,
          });
    const rng = o.rng ? { rng: o.rng } : {};
    const embedder = o.memory?.embedder;
    this.skillWriter = new SkillWriter({
      store: this.store,
      bus: this.bus,
      logger,
      llm,
      me: username,
      config: sw,
      privateServer: isPrivateHost(world.server.host) || sw.privateServerAck,
      intelligence: persona.abilities.intelligence,
      library: this.skills,
      // The trial is the agent's next option, like a quirk's or a feeling's: the plan resumes after it.
      tryOut: (skill, args, why) =>
        this.cc.impulse({
          option: 'work',
          task: { skill, args },
          terminate: { maxSeconds: Math.min(900, sw.wallSec + 30) },
          rationale: `trying out a skill I wrote${why ? `, for: ${why}` : ''}`.slice(0, 400),
        }),
      ...(embedder ? { embed: async (t: string) => (await embedder.embed([t]))[0] ?? null } : {}),
      now,
    });
    if (embedder) {
      // Only worth an embedding once there are more learned skills than are offered at a time.
      this.offs.push(
        this.bus.on('newGoal', (e) => {
          if (this.skills.verified().length <= sw.offered) return;
          const text = e.goal.text;
          void embedder
            .embed([text])
            .then(([v]) => {
              if (v) this.goalVec = { text, v };
            })
            .catch(() => undefined);
        }),
      );
    }
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
            announce: (text) => void this.talking.announce(text),
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
        fearLevel: () => this.fearLevel(),
        authorityOf: (n) => {
          const s = this.store.state;
          return this.power.leader() === n || s.social[n]?.perceivedRole === 'leader' ? persona.mind.biasProfile.authority : 0;
        },
        ingroup: (n) => this.ingroup(n),
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
      grievanceScale: (n) => this.grievanceScale(n),
      young: () => this.family.young(),
      bornAt: now(),
      ...rng,
      now,
    });
    this.romance = new RomanceWatch({
      store: this.store,
      bus: this.bus,
      logger,
      me: username,
      enabled: world.romance.enabled,
      liking: (n) => this.mind.liking(n),
      powerOf: (n) => this.conflict.powerOfName(n),
      resentmentOf: (n) => this.conflict.resentmentOf(n),
      grieve: (n, kind, note, weight) => this.conflict.grieve(n, kind, true, note, weight),
      feel: (ev, who) => this.feelings.appraise(ev, who),
      say: (to, text) => void this.talking.blurt(to, text),
      impulse: (out) => this.cc.impulse(out),
      override: () => this.mind.override(),
      combat: () => Math.min(1, persona.abilities.combat + this.store.state.growth.combatGrowth),
      ...rng,
      now,
    });
    this.family = new FamilyWatch({
      store: this.store,
      bus: this.bus,
      logger,
      me: username,
      enabled: world.reproduction.enabled,
      config: {
        partnerMinDays: world.romance.partnerMinDays,
        coupleCooldownSec: world.reproduction.coupleCooldownSec,
        minFoodItems: world.reproduction.minFoodItems,
        youthSec: world.reproduction.youthSec,
      },
      liking: (n) => this.mind.liking(n),
      resentmentOf: (n) => this.conflict.resentmentOf(n),
      conceived: (partner, bedPos) => o.onConception?.({ partner, bedPos, partnerModel: this.partnerModel(partner), partnerSex: this.store.state.social[partner]?.perceivedSex ?? 'unknown' }),
      feel: (ev, who) => this.feelings.appraise(ev, who),
      say: (text, to, volume) => void body.say(text, volume, to).catch(() => undefined),
      now,
    });
    this.power = new PowerWatch({
      store: this.store,
      bus: this.bus,
      logger,
      me: username,
      mode: world.mode,
      powerOf: (n) => this.conflict.powerOfName(n),
      myPower: () => this.conflict.myPower(),
      fearOf: (n) => this.store.state.social[n]?.fearOf ?? 0,
      resentmentOf: (n) => this.conflict.resentmentOf(n),
      sunkCost: () => persona.mind.biasProfile.sunkCost * (1 - this.mind.override()),
      now,
    });
    this.biases = new BiasWatch({
      store: this.store,
      bus: this.bus,
      logger,
      me: username,
      override: () => this.mind.override(),
      nudge: (n, d, note) => this.social.nudge(n, d, note),
      blame: (n, note) => this.conflict.grieve(n, 'scapegoat', false, note),
      ...rng,
      now,
    });
    this.reflection = new Reflection({ store: this.store, bus: this.bus, logger, llm, me: username, levers, ...rng, now });
    this.trades = new TradeTracker({ store: this.store, bus: this.bus, logger, me: username, onDeal: (w, ours, theirs) => this.cc.recordDeal(w, ours, theirs), now });
    // Our own yield, as the chat echoes it back (a duel's, or the reflex's below): said once is enough.
    const ownYield = (m: string) => {
      const p = parseProximityLine(m);
      if (p.kind !== 'speech' || p.speaker !== username) return;
      // Our own answer to a demand (§18.4.1 defiance that works).
      this.power.ownLine(p.text);
      if (SURRENDER_RE.test(p.text)) {
        this.yieldSaidAt = now();
        this.conflict.ownYield();
      }
    };
    body.bot.on('messagestr', ownYield);
    this.offs.push(() => body.bot.off('messagestr', ownYield));
    // Notable deeds move sentiment by code (§6.3 rule 2).
    this.deeds = new DeedWatch({ bot: body.bot, store: this.store, social: this.social, me: username, placed: body.placed, now });
    this.surroundings = new SurroundingsWatch({ bot: body.bot, store: this.store, bus: this.bus, logger, me: username, placed: body.placed, inShelter: () => this.store.state.option?.skill === 'shelter', now });
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
    // §17.6 groupAttack, coordinated by chat and by watching each other: one sworn with us against X crying "now!",
    // or seen hitting X, is the moment for us too (once every few seconds is enough).
    const cuedAt = new Map<string, number>();
    const strikeWith = (ally: AgentName, x: AgentName): void => {
      const t = now();
      if (x === username || !swornWith(this.store.state.commitments, username, ally, x) || t - (cuedAt.get(`${ally}>${x}`) ?? -Infinity) < 3000) return;
      cuedAt.set(`${ally}>${x}`, t);
      this.cc.trigger(`${ally} is taking on ${x} now`, { urgent: true, atOdds: x });
    };
    this.offs.push(
      this.bus.on('heard', (e) => {
        const x = NOW_RE.exec(e.utterance.text)?.[1];
        if (x && e.utterance.from !== username) strikeWith(e.utterance.from, x);
      }),
    );
    this.offs.push(
      this.bus.on('observedAction', (e) => {
        const a = e.action;
        if (a.kind !== 'attack' || !a.target || a.actor === username) return;
        // An ally sworn with us striking X, or X striking an ally sworn with us.
        strikeWith(a.actor, a.target);
        if (a.target !== username) strikeWith(a.target, a.actor);
      }),
    );
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
      // Friends, and the leader we follow unless a group sets upon them and we walk away (§17.7, §17.8).
      // §19.2, §19.5: family (a partner, parents, children, siblings), always: the strong defend reflex; anyone else
      // as §4.5 has it. The young don't fight at all.
      shouldDefend: (name, attacker) =>
        !this.family.young() &&
        (this.kin(name) ||
          defendsAlly({
            leader: this.power.standsBy(name),
            liking: this.store.state.social[name] ? this.mind.liking(name) : 0,
            fearOfAttacker: attacker ? (this.store.state.social[attacker]?.fearOf ?? 0) : 0,
          })),
      // Self-defense is allowed, except in youth (§19.5: no fighting, only fleeing); deliberate fights are code-gated
      // in the conflict core (M6b).
      mayFightBack: () => !this.family.young(),
      deliberateFight: () => ['attack', 'duel'].includes(this.store.state.option?.skill ?? ''),
      // In a duel the duel yields first; the reflexes flee only below that (§17.6).
      fightFloor: () => {
        const opt = this.store.state.option;
        return opt?.skill === 'duel' ? Math.max(1, Number(opt.args?.stopAtHealth ?? 8) - 1) : null;
      },
      onYield: (to) => this.sayYield(to),
      onCallOff: (to) => {
        const t = now();
        if (t - (this.calledOffAt.get(to) ?? -Infinity) < 20_000) return;
        this.calledOffAt.set(to, t);
        void this.talking.blurt(to, "that's enough. stay out of my way.", 'normal', true);
      },
      settled: (name, since) => this.conflict.settled(name, since),
      isIdle: () => this.executor.idleBody,
      between: () => !this.executor.busy,
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

  /** The body and the model client, for the operator's debug requests (hub/debug.ts). */
  get bodyOf(): Body {
    return this.o.body;
  }

  get llm(): LlmClient | null {
    return this.o.llm;
  }

  /**
   * The operator's debug settings (the Hub's tuning message): modules switched off, the agent paused or let go on,
   * and which models it uses. Pausing stops what it is doing; the reflexes still keep it alive.
   */
  applyTuning(t: Tuning): void {
    const was = this.store.state.flags.paused === true;
    this.store.update('flags', (f) => ({ ...f, off: [...t.off], paused: t.paused }), 'tuning');
    this.o.llm?.setRouting({ off: t.off.includes('llm'), tierModel: t.models, moduleTier: t.tiers });
    if (t.paused && !was) this.executor.abort('paused by the operator');
    if (!t.paused && was) this.cc.trigger('you can go on now', { urgent: true });
    this.o.logger.info({ module: 'agent', off: t.off, paused: t.paused, models: t.models, tiers: t.tiers }, 'tuning');
  }

  /** §18.4.1 fearLevel = max(fear, caution above its baseline, fear of the leader we follow). */
  /** What the learned skills offered are picked by: the current goal (its embedding when there is one). */
  private goalQuery(): Float32Array | string | null {
    const g = this.store.state.goals.current?.text;
    if (!g) return null;
    return this.goalVec?.text === g ? this.goalVec.v : g;
  }

  private fearLevel(): number {
    const s = this.store.state;
    const leader = this.power.leader();
    return Math.max(s.emotions.fear, s.drives.caution - s.drives.cautionBaseline, leader ? (s.social[leader]?.fearOf ?? 0) : 0);
  }

  /** §18.4.1 social pull, and so the pull to keep quiet about `about`: fear of them counts as well. */
  private pull(about: AgentName): number {
    const s = this.store.state;
    return conformityPull(conformityOf(s), Math.max(this.fearLevel(), s.social[about]?.fearOf ?? 0), this.mind.override());
  }

  /** §19.5: a partner, or family: in-group, with the strongest in-group bias. */
  /** What we believe of someone's traits (§19.3: a partner's perceived model, sent with a conception). */
  private partnerModel(name: AgentName): Record<string, number> {
    const p = this.store.state.social[name];
    if (!p) return {};
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    return Object.fromEntries(Object.entries({ ...p.estTraits, combat: p.estCombat, intelligence: p.estIntelligence }).map(([k, v]) => [k, clamp01(v)]));
  }

  private kin(name: AgentName): boolean {
    const s = this.store.state;
    return s.family.partner === name || Boolean(s.social[name]?.kin);
  }

  /** §18.4 in-group: family, the leader we follow and those seen going about with them, those sworn with us, neighbors. */
  private ingroup(name: AgentName): boolean {
    const s = this.store.state;
    if (this.kin(name)) return true;
    const leader = this.power.leader();
    if (leader && (name === leader || this.power.companions(leader).includes(name))) return true;
    if (s.commitments.some((c) => c.what.kind === 'fight' && c.status === 'accepted' && (c.debtor === name || c.creditor === name))) return true;
    const home = s.village.home;
    const p = s.social[name];
    return Boolean(home && p?.lastSeenPos && p.interactions >= 3 && Math.hypot(p.lastSeenPos.x - home.x, p.lastSeenPos.z - home.z) <= 24);
  }

  /** §18.4: a wrong by one of our own weighs less ("circumstances"); one by someone disliked, more ("they're bad"). */
  private grievanceScale(name: AgentName): number {
    const s = this.store.state;
    const ov = this.mind.override();
    if (this.ingroup(name)) return 1 - (this.kin(name) ? 0.8 : 0.5) * susceptibilityToward(s, 'ingroup', name) * (1 - ov);
    if (this.mind.liking(name) < 4) return 1 + 0.5 * susceptibilityToward(s, 'attribution', name) * (1 - ov);
    return 1;
  }

  /**
   * §17.7, §17.8 in the CC packet: whom we follow, who leads whom among those around, a grudge we share with someone
   * here ("you and Y share a grudge against X"), and who else we believe resents those we resent.
   */
  private powerLines(people: readonly AgentName[]): string[] {
    const s = this.store.state;
    const lines: string[] = [];
    const leader = this.power.leader();
    if (leader) lines.push(`You follow ${leader}.`);
    for (const n of people) {
      const f = s.social[n]?.followersSeen ?? 0;
      if (n !== leader && f >= 2) lines.push(`${n} leads ${f} followers.`);
    }
    const resented = Object.keys(s.social).filter((n) => this.conflict.resentmentOf(n) >= 0.4);
    for (const x of resented.slice(0, 3)) {
      const others = this.power.knownResenters(x);
      const shared = people.filter((y) => y !== x && others.includes(y) && this.mind.liking(y) >= 6);
      for (const y of shared) lines.push(`You and ${y} share a grudge against ${x}.`);
      const rest = others.filter((o) => !shared.includes(o));
      if (rest.length > 0) lines.push(`Others who resent ${x}: ${rest.slice(0, 4).join(', ')}.`);
      // §18.4.1: under a feared leader, grievances go unvoiced.
      if (this.pull(x) >= 0.5) lines.push(`You keep your grudge against ${x} to yourself; speaking up feels dangerous.`);
    }
    return lines;
  }

  /** Died (owner request, 2026-10-24). */
  get isDead(): boolean {
    return this.dead;
  }

  start(): void {
    const onDeath = (): void => this.die();
    this.o.body.bot.on('death', onDeath);
    this.offs.push(() => this.o.body.bot.off('death', onDeath));
    this.o.body.reflexes.start();
    this.perception.start();
    // Before the deed watch: it forgets a block we set down once someone breaks it.
    this.surroundings.start();
    this.conversations.start();
    this.awareness.start();
    this.executor.start();
    this.talking.start();
    this.consensus.start();
    this.selfMonitor.start();
    this.memory?.start();
    this.cc.start();
    this.goalGen?.start();
    this.roles.start();
    this.socialGoals?.start();
    this.reflection.start();
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
    this.power.start();
    this.romance.start();
    this.family.start();
    this.skillWriter.start();
    this.o.logger.info({ module: 'agent', persona: this.o.persona.name, llm: this.o.llm ? 'on' : 'code-only', memory: this.memory ? 'on' : 'off' }, 'agent started');
  }

  /**
   * A death ends every activity at once (owner request, 2026-10-24; §16.3): the body stops and says nothing more,
   * every module stops and every model call is cut off. Perception still hears the death's cause for the report, and
   * memory is written when the process ends (stop()).
   */
  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.halting.abort(new Error('died'));
    this.o.body.halt();
    this.haltModules();
    this.o.logger.info({ module: 'agent' }, 'died: every activity stopped');
  }

  /** Stops every module; what is still on the agent's mind is written to memory first (§23.4). */
  async stop(): Promise<void> {
    this.haltModules();
    this.memory?.stop();
    await this.memory?.flush();
    this.perception.stop();
    for (const off of this.offs.splice(0)) off();
  }

  /** Every module but memory (written last) and perception (it hears a death's cause): once only. */
  private haltModules(): void {
    if (this.modulesHalted) return;
    this.modulesHalted = true;
    this.skillWriter.stop();
    this.family.stop();
    this.romance.stop();
    this.power.stop();
    this.conflict.stop();
    this.biases.stop();
    this.crowd.stop();
    this.impulses.stop();
    this.impressions.stop();
    this.feelings.stop();
    this.trades.stop();
    this.deeds.stop();
    this.surroundings.stop();
    this.claims.stop();
    this.deaths.stop();
    this.commitments.stop();
    this.social.stop();
    this.quirks.stop();
    this.socialGoals?.stop();
    this.reflection.stop();
    this.roles.stop();
    this.goalGen?.stop();
    this.cc.stop();
    this.selfMonitor.stop();
    this.consensus.stop();
    this.talking.stop();
    this.executor.stop();
    this.awareness.stop();
    this.conversations.stop();
    this.o.body.reflexes.stop();
  }

  /**
   * §17.6: running from a person, say we give up so they stop. A duel that is giving up says so itself, so wait a
   * moment to hear it first; and say it only once.
   */
  /** §17.10 extinction brake: our own caution baseline is raised for a while (a mood), never what we perceive. */
  brake(shift: number, until: number): void {
    this.store.update('drives', (d) => ({ ...d, brakeShift: shift, brakeUntil: until, caution: Math.max(d.caution, Math.min(1, d.cautionBaseline + shift)) }), 'extinction brake');
    this.o.logger.info({ module: 'agent', shift, until }, 'extinction brake: more careful for a while');
  }

  /**
   * §17.6: running from a person, say we give up so they stop, at once: blows land while one waits. A duel that is
   * giving up says so itself, so then wait a moment to hear it first; and say it only once.
   */
  private sayYield(to: AgentName): void {
    const now = this.o.now ?? Date.now;
    if (now() - this.yieldSaidAt < 20_000 || this.yieldPending) return;
    const say = (): void => {
      this.yieldPending = false;
      if (now() - this.yieldSaidAt < 20_000) return;
      this.yieldSaidAt = now();
      void this.talking.blurt(to, 'ok ok, I give up!', 'normal', true);
    };
    if (this.store.state.option?.skill !== 'duel') return say();
    this.yieldPending = true;
    setTimeout(say, 600).unref();
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

/**
 * The agent's model client, cut off at `halt`: a call made after it, or under way when it comes, ends there as an
 * aborted call (its fallback), as a call's own signal would end it.
 */
export function haltable(llm: LlmClient, halt: AbortSignal): LlmClient {
  return new Proxy(llm, {
    get(target, prop) {
      if (prop === 'call') return <T>(opts: LlmCallOptions<T>): Promise<LlmResult<T>> => target.call({ ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, halt]) : halt });
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
