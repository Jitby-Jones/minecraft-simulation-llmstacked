import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DecisionOutputSchema,
  HubToBotSchema,
  ModelsConfigSchema,
  PersonaSchema,
  WorldConfigSchema,
  dataDir,
  dataPaths,
  getTrait,
  loadAllConfig,
  loadPersonaPool,
  maxTurnsFor,
  parseBotToHub,
  parseHubToBot,
  setTrait,
  NUMERIC_TRAIT_KEYS,
  loadWorldConfig,
} from '@agora/shared';

describe('config files', () => {
  it('every config/*.yaml parses with the design defaults', () => {
    const cfg = loadAllConfig();
    expect(cfg.models.tiers.L1.timeoutMs).toBe(7000);
    expect(cfg.models.tiers.L2.timeoutMs).toBe(8000);
    expect(cfg.models.tiers.L2.need).toContain('tool_calling');
    expect(cfg.models.llm.baseUrl).toBe('subscription');
    expect(cfg.models.llm.allowPaidKey).toBe(false);
    expect(cfg.models.embeddings.provider).toBe('local');
    expect(cfg.world.mode).toBe('live');
    expect(cfg.world.population.maxAlive).toBeGreaterThanOrEqual(cfg.world.population.minAlive);
    expect(cfg.world.chat.normalRange).toBe(15);
    expect(cfg.world.chat.whisperRange).toBe(5);
    expect(cfg.world.chat.shoutRange).toBe(48);
    expect(cfg.world.server.host).toBe('127.0.0.1');
    expect(cfg.hub.rateLimit.rps * 60 + cfg.hub.rateLimit.burst).toBeLessThanOrEqual(60);
    expect(cfg.hub.hub.host).toBe('127.0.0.1');
    expect(cfg.versions.minecraft.protocol).toBe(775);
    expect(cfg.versions.java.minMajor).toBe(25);
    expect(cfg.sexDifferences.d.neuroticism).toBe(0.4);
    expect(cfg.sexDifferences.d.aggression).toBe(-0.5);
  });

  it('applies nested defaults from an empty file', () => {
    const w = WorldConfigSchema.parse({});
    expect(w.population.initial).toBe(6);
    expect(w.conflict.extinctionBrake.deathsPerHourMax).toBe(4);
    expect(w.abilities.combat.growthCap).toBe(0.25);
    const m = ModelsConfigSchema.parse({});
    expect(m.tiers.L3.timeoutMs).toBe(45000);
    expect(m.tiers.L1.primary).toBe('auto');
  });

  it("rejects baseUrl 'paid' without allowPaidKey (§22.2)", () => {
    expect(ModelsConfigSchema.safeParse({ llm: { baseUrl: 'paid' } }).success).toBe(false);
    expect(ModelsConfigSchema.safeParse({ llm: { baseUrl: 'paid', allowPaidKey: true } }).success).toBe(true);
  });

  it('rejects inconsistent population and chat ranges', () => {
    expect(WorldConfigSchema.safeParse({ population: { minAlive: 5, maxAlive: 3 } }).success).toBe(false);
    expect(WorldConfigSchema.safeParse({ chat: { whisperRange: 20 } }).success).toBe(false);
  });

  it('reports the file name on invalid YAML values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-cfg-'));
    fs.writeFileSync(path.join(dir, 'world.yaml'), 'mode: sometimes\n');
    expect(() => loadWorldConfig(dir)).toThrow(ConfigError);
    expect(() => loadWorldConfig(dir)).toThrow(/world\.yaml/);
  });
});

describe('persona schema', () => {
  const minimal = { name: 'Pip', sex: 'female', traits: ['curious'] };

  it('fills defaults for every trait group', () => {
    const p = PersonaSchema.parse(minimal);
    expect(p.big5.extraversion).toBe(0.5);
    expect(p.mind.biasProfile.halo).toBe(0.5);
    expect(p.temperament.mercy).toBe(0.6);
    expect(p.abilities.combat).toBe(0.4);
    expect(p.speech.maxWords).toBe(25);
    expect(p.orientation).toBe('hetero');
    for (const key of NUMERIC_TRAIT_KEYS) {
      const v = getTrait(p, key);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('derives maxTurns from extraversion (introvert 4 … extrovert 10)', () => {
    expect(maxTurnsFor(PersonaSchema.parse({ ...minimal, big5: { extraversion: 0 } }))).toBe(4);
    expect(maxTurnsFor(PersonaSchema.parse({ ...minimal, big5: { extraversion: 1 } }))).toBe(10);
    expect(maxTurnsFor(PersonaSchema.parse({ ...minimal, social: { maxTurns: 7 } }))).toBe(7);
  });

  it('get/set every numeric trait', () => {
    const p = PersonaSchema.parse(minimal);
    for (const key of NUMERIC_TRAIT_KEYS) {
      setTrait(p, key, 0.123);
      expect(getTrait(p, key)).toBe(0.123);
    }
  });

  it('validates quirk hooks and conditions', () => {
    const ok = PersonaSchema.safeParse({
      ...minimal,
      quirks: [
        { hook: 'pathCost', when: 'lightLevel<7', multiplier: 3 },
        { hook: 'autoCollect', items: ['poppy'] },
        { hook: 'idleEmote', everySec: 90, say: ['*hums*'] },
        { hook: 'distraction', chance: 0.05, onSee: ['sheep'], action: 'approach' },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = PersonaSchema.safeParse({ ...minimal, quirks: [{ hook: 'pathCost', when: 'rm -rf', multiplier: 3 }] });
    expect(bad.success).toBe(false);
  });

  it('has no human/AI field (§16.1)', () => {
    const keys = Object.keys(PersonaSchema.shape).map((k) => k.toLowerCase());
    expect(keys.some((k) => k.includes('human') || k === 'isai' || k === 'isbot')).toBe(false);
  });

  it('loads the persona pool when present', () => {
    for (const p of loadPersonaPool()) {
      expect(p.id).toBeTruthy();
      expect(p.source).toBe('pool');
    }
  });
});

describe('decision schema', () => {
  it('accepts a well-formed decision and coerces stringly numbers', () => {
    const r = DecisionOutputSchema.safeParse({
      option: 'work',
      task: { skill: 'gather', args: { item: 'oak_log', qty: 8 } },
      speechIntent: { stance: 'agree', gist: 'sure, 8 logs', mayCommit: true },
      commitmentsToCreate: [
        { debtor: 'Pip', creditor: 'Bram', what: { kind: 'give', item: 'oak_log', qty: '8', text: '8 logs' } },
      ],
      terminate: { maxSeconds: '120', until: 'inventoryHas:oak_log>=8' },
      rationale: 'Bram asked and I am generous',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.terminate.maxSeconds).toBe(120);
      expect(r.data.commitmentsToCreate?.[0]?.what.qty).toBe(8);
    }
  });

  it('rejects unknown options', () => {
    expect(
      DecisionOutputSchema.safeParse({ option: 'teleport', terminate: { maxSeconds: 10 }, rationale: '' }).success,
    ).toBe(false);
  });
});

describe('hub protocol', () => {
  it('round-trips messages and rejects junk', () => {
    expect(parseHubToBot(JSON.stringify({ t: 'llmGrant', reqId: 'r1' }))).toEqual({ t: 'llmGrant', reqId: 'r1' });
    expect(parseHubToBot('{"t":"relaySpeech","text":"hi"}')).toBeNull();
    expect(parseHubToBot('not json')).toBeNull();
    expect(parseBotToHub(JSON.stringify({ t: 'hello', pid: 1, slot: 's1' }))).toEqual({ t: 'hello', pid: 1, slot: 's1' });
  });

  it('never carries world or player information to bots (§8)', () => {
    // Grants are bare yes/no answers (a speech token, an LLM slot, a fight slot under maxConcurrentFights). The
    // operator's debug controls are the operator's own hands: settings (tuning: switches, models, pause) and requests
    // made by a person at the dashboard or `pnpm ctl` (debug), each one logged; the Hub never sends either by itself.
    const kinds = HubToBotSchema.options.map((o) => o.shape.t.value);
    expect(kinds.sort()).toEqual(
      ['assign', 'budget', 'cautionShift', 'debug', 'embedResult', 'fightGrant', 'llmDeny', 'llmGrant', 'retire', 'shutdown', 'snapshot', 'speechGrant', 'tuning'].sort(),
    );
    expect(parseHubToBot(JSON.stringify({ t: 'tuning', tuning: { off: ['romance'], models: { L2: 'm' }, paused: true } }))).toEqual({ t: 'tuning', tuning: { off: ['romance'], models: { L2: 'm' }, tiers: {}, paused: true } });
    expect(parseHubToBot(JSON.stringify({ t: 'tuning', tuning: { off: ['teleport'] } }))).toBeNull();
    expect(parseHubToBot(JSON.stringify({ t: 'fightGrant', reqId: 'r1', ok: false, who: 'Rex' }))).toEqual({ t: 'fightGrant', reqId: 'r1', ok: false });
  });
});

describe('paths', () => {
  it('honors DATA_DIR overrides', () => {
    expect(dataDir({ DATA_DIR: '/tmp/x' })).toBe('/tmp/x');
    const p = dataPaths('/tmp/root');
    expect(p.graveyard).toBe(path.join('/tmp/root', 'graveyard'));
    expect(p.roster).toBe(path.join('/tmp/root', 'agents', 'roster.json'));
  });
});

describe('yaml null handling', () => {
  it('treats empty YAML sections as unset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-cfg-'));
    fs.writeFileSync(path.join(dir, 'world.yaml'), 'owner:\n  # username: Me\nconflict:\n');
    const w = loadWorldConfig(dir);
    expect(w.owner.username).toBeUndefined();
    expect(w.conflict.maxRung).toBe(4);
  });
});
