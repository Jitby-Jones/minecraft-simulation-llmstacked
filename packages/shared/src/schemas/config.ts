// Config file schemas with the design's defaults. Nested objects use .prefault({}) so inner defaults apply.

import { z } from 'zod';
import { TierNameSchema, Unit } from './common';

// ---------------------------------------------------------------------------------------------------------------
// config/models.yaml (§5, §22.3, §22.7)

export const CapabilitySchema = z.enum(['structured_output', 'tool_calling', 'reasoning']);
export type Capability = z.infer<typeof CapabilitySchema>;

export const TierConfigSchema = z.object({
  primary: z.string().min(1).default('auto'),
  fallbacks: z.array(z.string().min(1)).default(['auto']),
  timeoutMs: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  need: z.array(CapabilitySchema).default([]),
});
export type TierConfig = z.infer<typeof TierConfigSchema>;

export const ModelsConfigSchema = z
  .object({
    tiers: z
      .object({
        L1: TierConfigSchema.prefault({ timeoutMs: 7000, maxTokens: 200, need: ['structured_output'] }),
        L2: TierConfigSchema.prefault({ timeoutMs: 8000, maxTokens: 500, need: ['structured_output', 'tool_calling'] }),
        L3: TierConfigSchema.prefault({ timeoutMs: 45000, maxTokens: 2000, need: ['structured_output'] }),
      })
      .prefault({}),
    /** What agents speak with: the tier lines are written with (a small model's lines come late and short). */
    // The tier lines are written with, and models tried first for them (each must be on the subscription list) with
    // a timeout of their own: talk drives the agents' dealings with each other, so a line is worth a better model and
    // a few seconds (owner request, 2026-10-24).
    speech: z
      .object({
        tier: TierNameSchema.default('L2'),
        models: z.array(z.string().min(1)).default([]),
        timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      })
      .prefault({}),
    // The mind (owner request, 2026-10-24): each decision is thought through (what is going on, what surprised, the ways
    // there, the choice), a longer reply than a bare choice, so models tried first for it and a timeout of its own.
    mind: z
      .object({
        models: z.array(z.string().min(1)).default([]),
        timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      })
      .prefault({}),
    // The architect (owner request, 2026-10-24): called only when a building is designed, with the strongest models
    // tried first and time to think.
    architect: z
      .object({
        models: z.array(z.string().min(1)).default([]),
        timeoutMs: z.number().int().min(5000).max(300_000).default(90_000),
      })
      .prefault({}),
    // The controller (owner request, 2026-10-24): a master model over all the agents that steps in only on something
    // odd (a talk going round in circles, standing stuck, the same failure over and over). Code finds those; the model
    // judges each and words the urge that ends it.
    controller: z
      .object({
        enabled: z.boolean().default(true),
        models: z.array(z.string().min(1)).default([]),
        timeoutMs: z.number().int().min(5000).max(300_000).default(45_000),
        /** How often the agents are looked over. */
        everySec: z.number().int().min(5).max(600).default(20),
        /** At most this many urges an hour, everyone together. */
        maxPerHour: z.number().int().min(0).max(240).default(20),
      })
      .prefault({}),
    embeddings: z
      .object({
        provider: z.enum(['local', 'nanogpt']).default('local'),
        model: z.string().optional(),
      })
      .prefault({}),
    llm: z
      .object({
        baseUrl: z.enum(['subscription', 'paid']).default('subscription'),
        allowPaidKey: z.boolean().default(false),
        allowlistRefreshHours: z.number().positive().default(6),
        /** How often the quota is read for the operator to see (it rations nothing). */
        usagePollSec: z.number().int().min(30).default(300),
        /** How structured replies are asked for: a JSON object with the schema in the prompt, or the API's json_schema
         *  format (subscription models fill every optional field of one with empty strings). */
        structuredOutput: z.enum(['object', 'schema']).default('object'),
      })
      .prefault({}),
  })
  .refine((c) => c.llm.baseUrl === 'subscription' || c.llm.allowPaidKey, {
    message: "llm.baseUrl 'paid' requires llm.allowPaidKey: true (§22.2)",
    path: ['llm', 'baseUrl'],
  });
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// config/world.yaml (§16.2, §16.3, §16.5, §17.10, §19.7, §20, §21.5, §6.8, §15)

/** A NameMC skin tag as it appears in the listing's URL (namemc.com/minecraft-skins/tag/<tag>). */
const NameMcTag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const WorldConfigSchema = z
  .object({
    mode: z.enum(['test', 'live']).default('test'),
    population: z
      .object({
        initial: z.number().int().min(0).default(6),
        minAlive: z.number().int().min(0).default(4),
        maxAlive: z.number().int().min(0).default(12),
        spawnStaggerSec: z.number().min(0).default(20),
        respawnDelaySec: z.number().min(0).default(60),
        spawnRadius: z.number().min(0).default(24),
        /** Starting kit from the persona; live mode defaults to none (§16.3). */
        starterKit: z.enum(['persona', 'none', 'auto']).default('auto'),
      })
      .prefault({}),
    /** 'generated': every new person drawn by code and written by the master model; 'auto': the personas/ pool first; or the pool ids to use first. */
    personas: z.union([z.literal('auto'), z.literal('generated'), z.array(z.string().min(1))]).default('auto'),
    namePolicy: z.literal('generated').default('generated'),
    community: z
      .object({
        goal: z.string().default('build a thriving village'),
        /** Social Goal Gen and village work (§6.8); off, agents only follow their own goals. */
        socialGoals: z.boolean().default(true),
      })
      .prefault({}),
    romance: z
      .object({
        enabled: z.boolean().default(true),
        orientationDist: z
          .object({ hetero: Unit.default(0.85), homo: Unit.default(0.07), bi: Unit.default(0.08) })
          .prefault({}),
        partnerMinDays: z.number().min(0).default(2),
      })
      .prefault({}),
    reproduction: z
      .object({
        enabled: z.boolean().default(true),
        gestationSec: z.number().min(0).default(600),
        coupleCooldownSec: z.number().min(0).default(7200),
        youthSec: z.number().min(0).default(1800),
        minFoodItems: z.number().int().min(0).default(20),
      })
      .prefault({}),
    conflict: z
      .object({
        enabled: z.boolean().default(true),
        maxRung: z.number().int().min(0).max(4).default(4),
        pairCooldownSec: z.number().min(0).default(300),
        maxConcurrentFights: z.number().int().min(0).default(2),
        newcomerGraceSec: z.number().min(0).default(600),
        extinctionBrake: z
          .object({
            deathsPerHourMax: z.number().min(0).default(4),
            cautionShift: z.number().min(0).max(1).default(0.2),
            durationSec: z.number().min(0).default(3600),
          })
          .prefault({}),
        griefing: z.boolean().default(false),
        lethalVsAll: z.boolean().default(true),
      })
      .prefault({}),
    abilities: z
      .object({
        intelligence: z
          .object({ mean: Unit.default(0.5), sd: z.number().min(0).default(0.17), heritability: Unit.default(0.5) })
          .prefault({}),
        combat: z
          .object({
            mean: Unit.default(0.4),
            sd: z.number().min(0).default(0.2),
            heritability: Unit.default(0.3),
            growthCap: Unit.default(0.25),
          })
          .prefault({}),
        intelligenceRoutesCCTier: z.boolean().default(true),
        knowledgeGating: z.boolean().default(true),
      })
      .prefault({}),
    sexDifferences: z.object({ scale: z.number().min(0).max(3).default(1) }).prefault({}),
    server: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(25565),
        rconPort: z.number().int().min(1).max(65535).default(25575),
        levelName: z.string().regex(/^[A-Za-z0-9_\-.]+$/).default('world'),
        heapMb: z.number().int().min(512).default(3072),
        viewDistance: z.number().int().min(2).max(32).default(8),
        simulationDistance: z.number().int().min(2).max(32).default(6),
        motd: z.string().default('A quiet valley'),
        seed: z.string().default(''),
        extraPlayerSlots: z.number().int().min(0).default(4),
        javaPath: z.string().optional(),
      })
      .prefault({}),
    chat: z
      .object({
        normalRange: z.number().positive().default(15),
        whisperRange: z.number().positive().default(5),
        shoutRange: z.number().positive().default(48),
        fadeStart: Unit.default(0.6),
        cooldownSec: z.number().min(0).default(1),
        allowPrivateMessages: z.boolean().default(false),
      })
      .prefault({}),
    owner: z
      .object({
        /** Owner's username: op + spy on the server. Agents never learn this (§16.1). */
        username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/).optional(),
      })
      .prefault({}),
    /** Agents' skins (§16.5): a NameMC skin by the agent's sex, given when the agent is created. */
    skins: z
      .object({
        enabled: z.boolean().default(true),
        source: z.literal('namemc').default('namemc'),
        /** The NameMC skin tag each sex's skins are picked from. */
        tags: z.object({ male: NameMcTag.default('boy'), female: NameMcTag.default('girl') }).prefault({}),
        /** Pages of each tag's listing to read (the most liked come first); 24 skins a page. */
        pages: z.number().int().min(1).max(10).default(2),
        /** How MineSkin lists the signed copy it makes of each skin. */
        visibility: z.enum(['public', 'unlisted', 'private']).default('unlisted'),
        /** How long a new agent waits for its skin before it logs in without one (it gets it on the way). */
        waitSec: z.number().min(0).max(600).default(60),
        /** NameMC skin ids never to use. */
        exclude: z.array(z.string().regex(/^[0-9a-f]{16}$/)).default([]),
      })
      .prefault({}),
    /**
     * §1.4, §9, §21.1: new skills written at L3 and run sandboxed (isolated-vm). Off by default, and only ever on a
     * private server: server.host on loopback or a private network, or the owner's word that it is one.
     */
    skillWriter: z
      .object({
        enabled: z.boolean().default(false),
        /** The owner says the server is private though its host doesn't show it (e.g. 0.0.0.0 in a container). */
        privateServerAck: z.boolean().default(false),
        /** Who may write one (§21.1: intelligence 0.7 and up). */
        minIntelligence: Unit.default(0.7),
        /** New skills one agent may try to write in an hour. */
        perHour: z.number().int().min(0).max(20).default(2),
        /** Tries per skill, each told what went wrong the last time. */
        attempts: z.number().int().min(1).max(5).default(3),
        /** The sandbox: memory (MB), the code's own CPU time (ms), a run's wall time (s), skill calls per run. */
        memoryMb: z.number().int().min(8).max(256).default(32),
        cpuMs: z.number().int().min(50).max(10_000).default(1000),
        wallSec: z.number().min(5).max(3600).default(600),
        maxCalls: z.number().int().min(1).max(500).default(60),
        /** Learned skills offered to the CC at a time, the most relevant first. */
        offered: z.number().int().min(0).max(20).default(5),
      })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    if (c.population.minAlive > c.population.maxAlive) {
      ctx.addIssue({ code: 'custom', message: 'population.minAlive must be <= maxAlive', path: ['population'] });
    }
    if (c.population.initial > c.population.maxAlive) {
      ctx.addIssue({ code: 'custom', message: 'population.initial must be <= maxAlive', path: ['population'] });
    }
    if (c.chat.whisperRange > c.chat.normalRange || c.chat.normalRange > c.chat.shoutRange) {
      ctx.addIssue({ code: 'custom', message: 'chat ranges must satisfy whisper <= normal <= shout', path: ['chat'] });
    }
    const o = c.romance.orientationDist;
    if (o.hetero + o.homo + o.bi <= 0) {
      ctx.addIssue({ code: 'custom', message: 'romance.orientationDist must have a positive weight', path: ['romance'] });
    }
  });
export type WorldConfig = z.infer<typeof WorldConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// config/hub.yaml (§3, §5, §6.2, §23.3)

export const HubConfigSchema = z.object({
  hub: z
    .object({ host: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8765) })
    .prefault({}),
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8080),
    })
    .prefault({}),
  rateLimit: z
    .object({
      /** NanoGPT's subscription takes 60 text requests a minute per key: 0.9/s with a burst of 5 stays under it (§5). */
      rps: z.number().positive().max(25).default(0.9),
      burst: z.number().positive().default(5),
      queueTimeoutMs: z.number().int().positive().default(15000),
    })
    .prefault({}),
  speech: z.object({ globalPerSec: z.number().positive().default(5) }).prefault({}),
  logs: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      rotateMb: z.number().positive().default(20),
      keep: z.number().int().min(1).default(5),
    })
    .prefault({}),
});
export type HubConfig = z.infer<typeof HubConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// config/versions.yaml (§15.1, §23.1)

export const VersionsConfigSchema = z.object({
  minecraft: z.object({ version: z.string(), protocol: z.number().int() }),
  paper: z.object({
    version: z.string(),
    build: z.number().int().positive(),
    channel: z.string().default('STABLE'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  proximityChat: z.object({
    projectId: z.string(),
    versionId: z.string(),
    filename: z.string(),
    sha512: z.string().regex(/^[0-9a-f]{128}$/),
  }),
  /** Our own plugin that disables private chat commands for non-ops (§15.3); built from server-plugin/. */
  guardPlugin: z.object({
    filename: z.string().regex(/^[A-Za-z0-9_.-]+\.jar$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  /** Our own plugin that puts each agent's skin on it as it logs in (§16.5); built from server-plugin/. */
  skinsPlugin: z.object({
    filename: z.string().regex(/^[A-Za-z0-9_.-]+\.jar$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  java: z.object({ minMajor: z.number().int().min(8) }),
  node: z.object({ min: z.string().regex(/^\d+\.\d+\.\d+$/) }),
  embeddingModel: z.object({
    id: z.string(),
    /** Hugging Face commit; files are fetched from /resolve/<revision>/ and hash-checked. */
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    dims: z.number().int().positive(),
    files: z
      .array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
      .min(1),
  }),
});
export type VersionsConfig = z.infer<typeof VersionsConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// config/sex-differences.yaml (§20)

export const SEX_DIFF_TRAITS = [
  'neuroticism',
  'agreeableness',
  'extraversion',
  'openness',
  'conscientiousness',
  'aggression',
  'dominance',
  'caution',
  'mercy',
  'impulsivity',
  'vanity',
] as const;
export type SexDiffTrait = (typeof SEX_DIFF_TRAITS)[number];

export const SexDifferencesSchema = z.object({
  sigma: z.number().positive().max(0.5).default(0.18),
  /** Cohen's d, positive = higher in women. Traits not listed are not shifted. */
  d: z.partialRecord(z.enum(SEX_DIFF_TRAITS), z.number().min(-2).max(2)).default({}),
});
export type SexDifferences = z.infer<typeof SexDifferencesSchema>;
