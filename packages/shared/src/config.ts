// Loads and validates config/*.yaml and personas/*.yaml. Errors name the file and the offending path.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { configDir, personasDir } from './paths';
import {
  HubConfigSchema,
  ModelsConfigSchema,
  PersonaSchema,
  SexDifferencesSchema,
  VersionsConfigSchema,
  WorldConfigSchema,
  type HubConfig,
  type ModelsConfig,
  type Persona,
  type SexDifferences,
  type VersionsConfig,
  type WorldConfig,
} from './schemas';

export class ConfigError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid config ${file}:\n${detail}`);
    this.name = 'ConfigError';
  }
}

export function parseWithSchema<S extends z.ZodType>(schema: S, data: unknown, label: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ConfigError(label, z.prettifyError(r.error));
  return r.data;
}

export function readYamlFile(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return YAML.parse(text) as unknown;
  } catch (err) {
    throw new ConfigError(file, (err as Error).message);
  }
}

/**
 * Hand-edited YAML often leaves a section empty or with only comments (`owner:`), which parses as null.
 * Treat null as "not set" so defaults apply.
 */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(dropNulls);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = dropNulls(v);
    return out;
  }
  return value;
}

function loadYaml<S extends z.ZodType>(schema: S, file: string, optional: boolean): z.infer<S> {
  if (!fs.existsSync(file)) {
    if (optional) return parseWithSchema(schema, {}, file);
    throw new ConfigError(file, 'file not found');
  }
  return parseWithSchema(schema, dropNulls(readYamlFile(file) ?? {}), file);
}

export interface AllConfig {
  models: ModelsConfig;
  world: WorldConfig;
  hub: HubConfig;
  versions: VersionsConfig;
  sexDifferences: SexDifferences;
}

export function loadModelsConfig(dir = configDir()): ModelsConfig {
  return loadYaml(ModelsConfigSchema, path.join(dir, 'models.yaml'), true);
}
export function loadWorldConfig(dir = configDir()): WorldConfig {
  return loadYaml(WorldConfigSchema, path.join(dir, 'world.yaml'), true);
}
export function loadHubConfig(dir = configDir()): HubConfig {
  return loadYaml(HubConfigSchema, path.join(dir, 'hub.yaml'), true);
}
export function loadVersionsConfig(dir = configDir()): VersionsConfig {
  return loadYaml(VersionsConfigSchema, path.join(dir, 'versions.yaml'), false);
}
export function loadSexDifferences(dir = configDir()): SexDifferences {
  return loadYaml(SexDifferencesSchema, path.join(dir, 'sex-differences.yaml'), true);
}

export function loadAllConfig(dir = configDir()): AllConfig {
  return {
    models: loadModelsConfig(dir),
    world: loadWorldConfig(dir),
    hub: loadHubConfig(dir),
    versions: loadVersionsConfig(dir),
    sexDifferences: loadSexDifferences(dir),
  };
}

/** Loads every personas/*.yaml (sorted). The file stem becomes the persona id when none is given. */
export function loadPersonaPool(dir = personasDir()): Persona[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  return files.map((f) => {
    const file = path.join(dir, f);
    const raw = dropNulls(readYamlFile(file));
    const persona = parseWithSchema(PersonaSchema, raw, file);
    return { ...persona, id: persona.id ?? path.basename(f, path.extname(f)), source: 'pool' as const };
  });
}

export function personaToYaml(p: Persona): string {
  return YAML.stringify(p, { lineWidth: 120 });
}
