// The buildings agents know how to build (owner request, 2026-10-24): the repertoire drawn from photographs of real
// builds and the game's villages (buildings/*.json, in the building language of design.ts), every village building
// in the owner's own server jar (vanilla.ts), and the ones the agents' architect has designed since (saved under
// DATA_DIR/buildings, so the whole village knows them and the next design can build on them). Each is a blueprint
// when asked for (compiled, or read from the jar), described in a line for a model: what it is, its size, what it
// takes.

import fs from 'node:fs';
import path from 'node:path';
import { type Logger, dataPaths, repoRoot, writeFileAtomic } from '@agora/shared';
import { compileDesign, type Blueprint } from './compile';
import { type Design, DesignSchema } from './design';
import { billOf, planMaterials } from './materials';
import { listVanilla, loadVanilla, openGameJar, type VanillaEntry, type Zip } from './vanilla';

export interface Building {
  id: string;
  name: string;
  kind: string;
  description: string;
  style: string[];
  /** Where it came from: photographs, the game's own villages, an agent. */
  source: string;
  /** In the building language: the repertoire's and the architect's. */
  design?: Design;
  /** One of the game's own village buildings. */
  vanilla?: VanillaEntry;
}

/** The repertoire drawn for this project. */
export function buildingsDir(): string {
  return path.join(repoRoot(), 'buildings');
}

/** The designs the agents have made. */
export function madeBuildingsDir(root = dataPaths().root): string {
  return path.join(root, 'buildings');
}

const idOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'building';

export class Repertoire {
  private readonly byId = new Map<string, Building>();
  private vanillaLoaded = false;
  private jar: Zip | null = null;
  private readonly blueprints = new Map<string, Blueprint>();

  constructor(private readonly o: { dirs?: string[]; madeDir?: string; serverDir?: string; logger?: Logger } = {}) {}

  /** Reads the designs from disk (the drawn ones, then those made since); a bad file is skipped and said so. */
  load(): this {
    for (const dir of [...(this.o.dirs ?? [buildingsDir()]), this.o.madeDir ?? madeBuildingsDir()]) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files.sort()) {
        try {
          const design = DesignSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
          this.put(design);
        } catch (err) {
          this.o.logger?.warn({ module: 'building', file: f, err: String(err).slice(0, 300) }, 'a building design could not be read');
        }
      }
    }
    return this;
  }

  private put(design: Design): Building {
    const id = design.id ?? idOf(design.name);
    const b: Building = { id, name: design.name, kind: design.kind, description: design.description, style: design.style, source: design.source, design: { ...design, id } };
    this.byId.set(id, b);
    this.blueprints.delete(id);
    return b;
  }

  /** The game's own village buildings, when its jar is there (read once). */
  private vanilla(): void {
    if (this.vanillaLoaded) return;
    this.vanillaLoaded = true;
    try {
      this.jar = openGameJar(this.o.serverDir ?? dataPaths().server);
    } catch (err) {
      this.o.logger?.info({ module: 'building', err: String(err) }, "the game's jar could not be read; its village buildings are left out");
      this.jar = null;
    }
    if (!this.jar) return;
    for (const v of listVanilla(this.jar)) {
      this.byId.set(v.id, { id: v.id, name: v.name, kind: v.kind, description: `the ${v.name} of the game's ${v.biome} villages`, style: [v.biome, 'village'], source: "the game's own village buildings", vanilla: v });
    }
  }

  /** All of them; the game's villages' too unless asked not to. */
  list(opts: { vanilla?: boolean } = {}): Building[] {
    if (opts.vanilla !== false) this.vanilla();
    return [...this.byId.values()].filter((b) => opts.vanilla !== false || !b.vanilla);
  }

  /** By id, or by name ("plains cottage"), or loosely by a name in it ("cottage"). */
  find(query: string): Building | undefined {
    const q = query.trim().toLowerCase();
    if (!q) return undefined;
    // The game's own are named like "plains_small_house_1".
    const game = q.startsWith('vanilla:') || /\d$/.test(q);
    if (game) this.vanilla();
    const exact = this.byId.get(q) ?? this.byId.get(idOf(q)) ?? this.byId.get(`vanilla:${q.replace(/^vanilla:/, '').replace(/[\s-]+/g, '_')}`);
    if (exact) return exact;
    const all = this.list({ vanilla: game });
    return all.find((b) => b.name.toLowerCase() === q) ?? all.find((b) => b.kind === q) ?? all.find((b) => b.name.toLowerCase().includes(q) || q.includes(b.name.toLowerCase()));
  }

  /** Its blocks (compiled from its design, or read from the jar). */
  async blueprint(b: Building): Promise<Blueprint> {
    const hit = this.blueprints.get(b.id);
    if (hit) return hit;
    let bp: Blueprint;
    if (b.design) bp = compileDesign(b.design);
    else if (b.vanilla) {
      this.vanilla();
      if (!this.jar) throw new Error(`${b.name}: the game's jar is not there to read it from`);
      bp = await loadVanilla(this.jar, b.vanilla);
    } else throw new Error(`${b.name} has no design`);
    this.blueprints.set(b.id, bp);
    return bp;
  }

  /** A design one of us made, kept for everyone (saved under DATA_DIR/buildings). A name already taken gets a number. */
  save(design: Design, opts: { by?: string } = {}): Building {
    let id = design.id ?? idOf(design.name);
    for (let n = 2; this.byId.has(id) && this.byId.get(id)?.design?.source !== design.source; n++) id = `${idOf(design.name)}-${n}`;
    const d: Design = { ...design, id, source: design.source || (opts.by ? `designed by ${opts.by}` : 'designed by an agent') };
    const dir = this.o.madeDir ?? madeBuildingsDir();
    writeFileAtomic(path.join(dir, `${id}.json`), `${JSON.stringify(d, null, 2)}\n`);
    return this.put(d);
  }

  close(): void {
    this.jar?.close();
    this.jar = null;
  }
}

/** One line for a model: what it is, how big, what it is mostly made of, how much work. */
export function describeBuilding(b: Building, bp: Blueprint): string {
  const bill = [...billOf(bp)].sort((x, y) => y[1] - x[1]);
  const top = bill
    .slice(0, 4)
    .map(([item, n]) => `${n} ${item.replace(/_/g, ' ')}`)
    .join(', ');
  const effort = planMaterials(bill.map(([item, count]) => ({ item, count }))).effort;
  return `${b.id}: ${b.description || b.name} (${bp.size.x}×${bp.size.z}, ${bp.size.y} high; ${bp.blocks.length} blocks, mostly ${top}; about ${effort} min of work)`;
}
