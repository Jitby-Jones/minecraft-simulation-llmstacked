// One agent (§4): a body plus concurrent modules sharing the Agent State blackboard. Perception and reflexes are
// code; the Cognitive Controller decides; the executor and Talking carry the decision out, so what the agent says
// matches what it does. Works with an LLM client or without one (code-only, §22.4).

import type { AgentName, Logger, Persona, WorldConfig } from '@agora/shared';
import type { Embedder, LlmClient, QuotaGovernor } from '@agora/llm';
import { AgentBus } from './bus';
import type { MemoryDB } from './memory/db';
import { Memory } from './memory/memory';
import { GoalGen } from './modules/goalGen';
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
  readonly quirks: QuirkRunner;
  private dangerSource = '';
  private readonly offs: (() => void)[] = [];

  constructor(private readonly o: AgentOptions) {
    const { body, persona, username, llm, logger } = o;
    const now = o.now ?? Date.now;
    this.store = new AgentStateStore(createInitialState({ persona, username, now: now() }));
    const levers = (): MindLevers => leversFor(persona.abilities.intelligence, o.world?.abilities.intelligenceRoutesCCTier ?? true);
    const speechRange = o.world?.chat.normalRange ?? 15;
    this.perception = new Perception({ bot: body.bot, store: this.store, bus: this.bus, logger, speechRange, now });
    this.conversations = new Conversations({ store: this.store, bus: this.bus, logger, me: username, inRange: () => this.perception.peopleInRange(), now });
    this.executor = new SkillExecutor({ store: this.store, bus: this.bus, body, logger, levers, now });
    this.awareness = new ActionAwareness({ store: this.store, bus: this.bus, logger, now });
    this.talking = new Talking({ store: this.store, bus: this.bus, body, logger, llm, conversations: this.conversations, executor: this.executor, me: username, now });
    this.selfMonitor = new SelfMonitor({ store: this.store, bus: this.bus, logger, llm, me: username, now });
    this.memory = o.memory ? new Memory({ store: this.store, bus: this.bus, logger, db: o.memory.db, embedder: o.memory.embedder, llm, me: username, now }) : null;
    const memories = this.memory ? (k: number) => (this.memory as Memory).forPacket(k) : undefined;
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
      now,
    });
    this.goalGen =
      o.goalGen === false
        ? null
        : new GoalGen({ store: this.store, bus: this.bus, logger, llm, me: username, setGoal: (t, d) => this.cc.setGoal(t, d), ...(memories ? { memories } : {}), now });
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
      shouldDefend: (name) => (this.store.state.social[name]?.sentiment ?? 0) >= 7,
      // Self-defense is always allowed; deliberate fights are code-gated in the conflict core (M6b).
      mayFightBack: () => true,
      deliberateFight: () => this.store.state.option?.skill === 'attack',
      isIdle: () => !this.executor.busy,
      onDanger: (info) => {
        this.dangerSource = info.source;
        this.store.update('flags', (f) => ({ ...f, inDanger: true, busyLevel: 'critical', busySpeech: cannedBusyLine(info.source) }), `danger: ${info.kind} ${info.source}`);
        this.bus.emit({ type: 'danger', source: info.source, level: info.level });
      },
      onDangerCleared: (summary) => {
        this.store.update('flags', (f) => ({ ...f, inDanger: false, busySpeech: null, busyLevel: this.executor.busy ? 'working' : 'idle' }), 'danger cleared');
        const what = summary === 'fight over' ? `fought off a ${this.dangerSource}` : summary === 'got away' ? `got away from a ${this.dangerSource}` : `escaped ${this.dangerSource}`;
        pushWorkmem(this.store, `I ${what}`, 0.6, 'self_observed', { now: now() });
        this.bus.emit({ type: 'dangerCleared' });
      },
      onAttacked: (by, damage) => {
        this.bus.emit({ type: 'attacked', by, damage });
        if (by && this.store.state.social[by]) pushWorkmem(this.store, `${by} hit me`, 0.85, 'self_observed', { aboutAgent: by, now: now() });
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
    this.quirks.start();
    this.o.logger.info({ module: 'agent', persona: this.o.persona.name, llm: this.o.llm ? 'on' : 'code-only', memory: this.memory ? 'on' : 'off' }, 'agent started');
  }

  /** Stops every module; what is still on the agent's mind is written to memory first (§23.4). */
  async stop(): Promise<void> {
    this.quirks.stop();
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

  setGoal(text: string, doneWhen?: string): void {
    this.cc.setGoal(text, doneWhen);
  }
}
