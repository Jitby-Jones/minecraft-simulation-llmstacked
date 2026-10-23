// The operator's debug settings (debug controls), kept in DATA_DIR/agents/tuning.json across restarts: one set for
// everyone, and per agent on top of it. A change for everyone is a change for each of them (it clears their own
// setting of that same thing); a change for one agent is theirs alone. Each agent is sent its settings as it starts
// and whenever they change. Never anything about the world.

import fs from 'node:fs';
import { type TierName, type TunableModule, type Tuning, TuningSchema, type LlmModule, writeFileAtomic } from '@agora/shared';
import { z } from 'zod';

const PartialTuningSchema = z.object({
  off: z.array(z.string()).optional(),
  models: z.record(z.string(), z.string()).optional(),
  tiers: z.record(z.string(), z.string()).optional(),
  paused: z.boolean().optional(),
});
type PartialTuning = z.infer<typeof PartialTuningSchema>;

const FileSchema = z.object({ all: PartialTuningSchema.default({}), agents: z.record(z.string(), PartialTuningSchema).default({}) });

/** "all", or one agent's name. */
export type Scope = string;

export class TuningStore {
  private all: PartialTuning = {};
  private agents: Record<string, PartialTuning> = {};

  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        const f = FileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
        this.all = f.all;
        this.agents = f.agents;
      }
    } catch {
      // A broken file is started over.
    }
  }

  /** What an agent runs with: its own settings over everyone's. */
  for(username: string): Tuning {
    const a = this.agents[username] ?? {};
    return TuningSchema.parse({
      off: a.off ?? this.all.off ?? [],
      models: { ...this.all.models, ...a.models },
      tiers: { ...this.all.tiers, ...a.tiers },
      paused: a.paused ?? this.all.paused ?? false,
    });
  }

  /** Everyone's settings, and each agent's own on top (for the dashboard). */
  snapshot(): { all: Tuning; agents: Record<string, PartialTuning> } {
    return { all: TuningSchema.parse({ off: this.all.off ?? [], models: this.all.models ?? {}, tiers: this.all.tiers ?? {}, paused: this.all.paused ?? false }), agents: structuredClone(this.agents) };
  }

  /** Switches a module on or off, for everyone (each agent's own switches with it) or for one agent. */
  setModule(scope: Scope, module: TunableModule, on: boolean): void {
    const flip = (off: readonly string[]) => (on ? off.filter((m) => m !== module) : [...new Set([...off, module])]);
    if (scope === 'all') {
      this.all.off = flip(this.all.off ?? []);
      for (const n of Object.keys(this.agents)) {
        const own = this.agents[n];
        if (own?.off) own.off = flip(own.off);
      }
    } else {
      const own = (this.agents[scope] ??= {});
      own.off = flip(own.off ?? this.for(scope).off);
    }
    this.save();
  }

  /** The model a tier tries first (null: back to the automatic choice), for everyone or for one agent. */
  setModel(scope: Scope, tier: TierName, model: string | null): void {
    for (const n of scope === 'all' ? Object.keys(this.agents) : []) delete this.agents[n]?.models?.[tier];
    const target = scope === 'all' ? this.all : (this.agents[scope] ??= {});
    target.models = { ...target.models };
    if (model) target.models[tier] = model;
    else delete target.models[tier];
    this.save();
  }

  /** The tier a module uses (null: its own choice), for everyone or for one agent. */
  setTier(scope: Scope, module: LlmModule, tier: TierName | null): void {
    for (const n of scope === 'all' ? Object.keys(this.agents) : []) delete this.agents[n]?.tiers?.[module];
    const target = scope === 'all' ? this.all : (this.agents[scope] ??= {});
    target.tiers = { ...target.tiers };
    if (tier) target.tiers[module] = tier;
    else delete target.tiers[module];
    this.save();
  }

  /** Pauses or lets go on, everyone or one agent. */
  setPaused(scope: Scope, paused: boolean): void {
    if (scope === 'all') {
      this.all.paused = paused;
      for (const n of Object.keys(this.agents)) delete this.agents[n]?.paused;
    } else (this.agents[scope] ??= {}).paused = paused;
    this.save();
  }

  /** Forgets one agent's own settings (it runs with everyone's again), or everything. */
  reset(scope: Scope): void {
    if (scope === 'all') {
      this.all = {};
      this.agents = {};
    } else delete this.agents[scope];
    this.save();
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify({ all: this.all, agents: this.agents }, null, 2));
  }
}
