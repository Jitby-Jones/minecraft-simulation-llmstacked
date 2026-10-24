// The architect (owner request, 2026-10-24): the agents' own buildings, not only the repertoire's. Called only when
// a building is to be designed (the `design` skill), a strong model (models.yaml `architect`: tried first, with time
// to think) draws one in the building language (design.ts), the repertoire's designs nearest to what is asked shown
// to it as a framework: the same kinds of parts, roofs and materials, made its own. The compiler checks what it
// drew; what doesn't work (a door in no outside wall, a roof of no such material, too much for a home) goes back to
// it once to put right. Then code makes it buildable: blocks too hard to get here swapped for lookalikes, a bill of
// materials, the crafting from gathered to placed (the doors, fences, glass, stairs it needs), and who could bring
// what (a woodcutter the logs, a miner the stone). Without a model, or when nothing it draws will do, the
// repertoire's nearest design is the answer. The design is kept for the whole village (Repertoire.save).

import type { AgentName, Logger } from '@agora/shared';
import type { LlmClient } from '@agora/llm';
import { z } from 'zod';
import { type Blueprint, ROOF_MATERIALS, compileDesign } from './compile';
import { type Design, DesignSchema, KINDS } from './design';
import { type MaterialsPlan, type Need, type Substitution, billOf, planMaterials, substitute, unknownBlocks } from './materials';
import { type Building, type Repertoire } from './repertoire';

export interface DesignRequest {
  /** What it is for, in the agent's words: "a house for me and Wren", "a smithy for the village". */
  purpose: string;
  /** A kind if the agent named one (house, smithy, tower, ...). */
  kind?: string;
  by: AgentName;
  /** Who the designer is, in a line or two (their taste). */
  persona: string;
  /** Where: the biome at home ("plains", "taiga", ...). */
  biome: string;
  /** What one of each raw material takes here, in minutes (materials.ts): dear where nobody has seen any. */
  raw?: Record<string, number>;
  /** What there is to build with, in a line: "about 60 spruce logs and 40 cobblestone; sand by the river". */
  materials: string;
  /** What the village has built already (names), to fit in with. */
  village: string[];
  /** The most work it should take, in minutes of one player's time. */
  maxEffort?: number;
  /** Who could bring materials, and what they do ("woodcutter", "miner", ...). */
  helpers: { name: string; does: string }[];
  /** What the designer holds now (counted off the materials it needs). */
  have?: Map<string, number>;
}

export interface Ask {
  who: AgentName;
  item: string;
  count: number;
}

export interface DesignResult {
  /** Kept in the repertoire for everyone. */
  building: Building;
  blueprint: Blueprint;
  swaps: Substitution[];
  materials: MaterialsPlan;
  /** Who to ask for what. */
  asks: Ask[];
  /** Drawn by the model (first time, or put right), or the repertoire's. */
  how: 'designed' | 'repaired' | 'repertoire';
  /** The designer's own words about it. */
  note: string;
  /** What the compiler said about drafts that didn't work. */
  problems: string[];
}

const DRAFT = z.object({ design: z.unknown(), note: z.string().max(400).default('') });
type Draft = z.infer<typeof DRAFT>;

/** The building language, for the model: the fields, what they take, and what makes a design work. */
export const LANGUAGE = `A building is one JSON object:
{"name": "a short name", "kind": "${KINDS.filter((k) => !['farm', 'pen', 'well', 'lamp'].includes(k)).join('|')}",
 "description": "one sentence: what it is and what it is made of", "style": ["a few words"],
 "wallHeight": 3 (2-6, the height of each storey's walls),
 "parts": [one to three rectangles, the main one first:
   {"at": [x, z] (its north-west corner; the main one at [0, 0]), "size": [east-west, north-south] (3-15 each, walls included),
    "floors": 1-3, "foundation": "cobblestone" (the block under the walls),
    "walls": "oak_planks" or one block per storey from the ground up, e.g. ["cobblestone", "spruce_planks"],
    "posts": a block for the corners, e.g. "oak_log" or "stripped_spruce_log" (optional), "beams": a block for the band between storeys (optional),
    "floor": the floors, e.g. "spruce_planks",
    "roof": {"style": "gable"|"hip"|"flat"|"shed", "material": one of ${ROOF_MATERIALS.join(', ')}, "axis": "x"|"z" (a gable's ridge runs this way; by default the long way), "overhang": 0|1, "rim": true|false (a flat roof's edge)},
    "windows": {"block": "glass_pane", "every": 2-8 (blocks apart), "sides": ["north", "east", "south", "west"] (by default all)}}],
 "door": {"part": 0, "side": "north"|"east"|"south"|"west", "offset": blocks from its west or north end (by default the middle), "double": true|false, "material": a wood},
 "interior": things set along the inside walls, the ground floor first: bed, chest, crafting_table, furnace, barrel, bookshelf, table, chair, lantern, plant, anvil, smithing_table, lectern, loom, smoker, cauldron, composter... "bed@1" puts it upstairs,
 "lights": "torches"|"lanterns"|"none",
 "features": [{"type": "chimney"|"porch"|"fence"|"path"|"lamp", "side": optional, "material": optional}],
 "details": [{"block": "oak_trapdoor[facing=north,half=top]", "at": [x, y, z]}] (anything else, by position: y 0 is the ground layer, the walls start at y 1)}
A farm, a pen, a well or a lamp post has "plot" instead of parts: {"type": "farm"|"pen"|"well"|"lamp", "size": [w, d], "material": a wood}.
What makes one work: blocks of the game by their ids without "minecraft:"; walls 5-9 across for a home, 9-15 for a hall; one or two storeys; the door in an outside wall; windows; a bed in a home. A wing joins best from the middle of the part it joins, where that roof's ridge runs: a main part at [0, 0] of 11×5 (its ridge along x at z 2) takes a wing at [0, 3] or [6, 3]. Parts of one height share one roof, so their gables meet in a valley.`;

/** How alike a repertoire design is to what is asked: its kind, its biome, words in common. */
function likeness(b: Building, req: DesignRequest): number {
  const words = new Set(`${req.purpose} ${req.kind ?? ''}`.toLowerCase().split(/[^a-z]+/));
  let s = 0;
  if (req.kind && b.kind === req.kind) s += 4;
  if (words.has(b.kind)) s += 3;
  if (b.style.includes(req.biome)) s += 2;
  for (const w of `${b.name} ${b.description}`.toLowerCase().split(/[^a-z]+/)) if (w.length > 3 && words.has(w)) s += 0.5;
  return s;
}

/** The repertoire's designs to show as a framework: the nearest few, and one of another shape for range. */
export function examplesFor(rep: Repertoire, req: DesignRequest, n = 3): Building[] {
  const drawn = rep.list({ vanilla: false }).filter((b) => b.design && !b.design.plot);
  const ranked = [...drawn].sort((a, b) => likeness(b, req) - likeness(a, req) || a.id.localeCompare(b.id));
  const out = ranked.slice(0, n - 1);
  const other = ranked.find((b) => !out.includes(b) && (b.design?.parts.length ?? 0) !== (out[0]?.design?.parts.length ?? 0));
  if (other) out.push(other);
  return out.slice(0, n);
}

/** A design written compactly for a prompt (its defaults left out). */
export function compactDesign(d: Design): string {
  const { id: _id, source: _source, ...rest } = d;
  return JSON.stringify(rest, (_k, v: unknown) => (Array.isArray(v) && v.length === 0 ? undefined : v));
}

/** What a role brings to a building. */
const BRINGS: readonly [RegExp, RegExp][] = [
  [/(wood|lumber|log|tree)/i, /_(log|planks)$|^log$|^stick$/],
  [/(stone|mine|miner|quarry|dig)/i, /^(cobblestone|stone|cobbled_deepslate|andesite|diorite|granite|raw_iron|coal|sandstone)$/],
  [/(farm|food|hunt|shepherd)/i, /^(white_wool|.*_wool|leather|wheat|sugar_cane|string|feather)$/],
  [/(scout|explor|gather)/i, /^(sand|red_sand|clay_ball|gravel|flower|poppy|dandelion)$/],
];

/** Who could bring which raw materials: the one whose work it is, up to two asks; the rest the designer gets. */
export function asksFor(raw: Need[], helpers: readonly { name: string; does: string }[], by: string): Ask[] {
  const asks: Ask[] = [];
  const asked = new Set<string>();
  for (const need of [...raw].sort((a, b) => b.count - a.count)) {
    if (asks.length >= 2) break;
    const fit = helpers.find((h) => h.name !== by && !asked.has(h.name) && BRINGS.some(([role, items]) => role.test(h.does) && items.test(need.item)));
    if (!fit) continue;
    asked.add(fit.name);
    asks.push({ who: fit.name, item: need.item, count: need.count });
  }
  return asks;
}

/** What a model leaves out or overdoes in a draft, set right before it is read: a name, too many things inside. */
export function tidyDraft(raw: unknown, req: Pick<DesignRequest, 'by' | 'purpose' | 'kind'>): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const d = { ...(raw as Record<string, unknown>) };
  if (typeof d.name !== 'string' || d.name.trim().length === 0) d.name = `${req.by}'s ${req.kind ?? (/\b(house|home|cottage|cabin|hut)\b/i.exec(req.purpose)?.[1] ?? 'building')}`.toLowerCase();
  if (typeof d.name === 'string') d.name = d.name.slice(0, 60);
  if (typeof d.description === 'string') d.description = d.description.slice(0, 400);
  if (Array.isArray(d.interior)) d.interior = d.interior.slice(0, 24);
  if (Array.isArray(d.details)) d.details = d.details.slice(0, 80);
  if (Array.isArray(d.style)) d.style = d.style.slice(0, 8).map((x) => String(x).slice(0, 30));
  return d;
}

/** The repertoire's design nearest to what is asked (the code default, and the answer when no draft will do). */
export function nearestDesign(rep: Repertoire, req: DesignRequest): Building | null {
  const drawn = rep.list({ vanilla: false }).filter((b) => b.design);
  const wantPlot = /\b(farm|field|crops?|pen|well|lamp)\b/i.test(`${req.purpose} ${req.kind ?? ''}`);
  const pool = drawn.filter((b) => Boolean(b.design?.plot) === wantPlot);
  return [...(pool.length > 0 ? pool : drawn)].sort((a, b) => likeness(b, req) - likeness(a, req) || a.id.localeCompare(b.id))[0] ?? null;
}

export interface ArchitectOptions {
  llm: LlmClient | null;
  repertoire: Repertoire;
  logger: Logger;
  /** Models tried first (models.yaml architect.models) and the time each may take. */
  models?: readonly string[];
  timeoutMs?: number;
  /** One model only (a bench, a test). */
  model?: string;
  signal?: AbortSignal;
}

/** Draws a building for the request; keeps it in the repertoire. */
export async function designBuilding(req: DesignRequest, o: ArchitectOptions): Promise<DesignResult> {
  const examples = examplesFor(o.repertoire, req);
  const maxEffort = req.maxEffort ?? 150;
  const problems: string[] = [];
  let note = '';
  let design: Design | null = null;
  let how: DesignResult['how'] = 'designed';
  if (o.llm) {
    const system = [
      `You are the architect in ${req.by}'s head: ${req.persona}`,
      'You draw one building for Minecraft, to be built block by block by players with what they can gather. Use the designs below as a framework (the same kinds of parts, roofs and materials) and make this one your own: its own proportions, wings, porch, chimney, materials, inside. It should fit the place and the people, and be no more work than asked.',
      LANGUAGE,
      `Designs of ours you can learn from:\n${examples.map((b) => (b.design ? compactDesign(b.design) : '')).join('\n')}`,
      'Reply with JSON: {"design": {...the building...}, "note": "a line on what you drew and why"}',
    ].join('\n\n');
    const user = [
      `Draw: ${req.purpose}${req.kind ? ` (a ${req.kind})` : ''}.`,
      `Where: ${req.biome} land.`,
      `What we have to build with: ${req.materials}`,
      req.village.length > 0 ? `Already built here: ${req.village.join(', ')}.` : 'Nothing is built here yet.',
      `At most about ${maxEffort} minutes of one player's work (a cottage is about 50, a two-storey farmhouse about 140).`,
    ].join('\n');
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    for (let attempt = 0; attempt < 2 && !design; attempt++) {
      const r = await o.llm.call<Draft>({
        tier: 'L3',
        module: 'architect',
        agent: req.by,
        messages,
        schema: DRAFT,
        schemaName: 'design',
        formatInPrompt: true,
        fallback: () => ({ design: null, note: '' }),
        ...(o.model ? { model: o.model } : o.models && o.models.length > 0 ? { prefer: o.models } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        maxTokens: 3000,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      if (r.value.design === null || r.value.design === undefined) break;
      const parsed = DesignSchema.safeParse(tidyDraft(r.value.design, req));
      let wrong: string[];
      if (!parsed.success) wrong = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'design'}: ${i.message}`);
      else {
        const bp = compileDesign(parsed.data);
        wrong = [...bp.problems.slice(0, 8), ...unknownBlocks(bp).map((n) => `there is no block called "${n}": name a real one (a wood's blocks are like birch_planks, birch_log, birch_fence)`)];
        // The work it takes once what is hard to get here is swapped for what is easier, as it will be built.
        const effort = planMaterials(billOf(substitute(bp, { ...(req.raw ? { raw: req.raw } : {}) }).blueprint), { ...(req.raw ? { raw: req.raw } : {}) }).effort;
        if (effort > maxEffort * 1.6) wrong.push(`it is about ${effort} minutes of work: make it smaller (at most about ${maxEffort})`);
        if (wrong.length === 0) {
          design = parsed.data;
          note = r.value.note;
          if (attempt > 0) how = 'repaired';
        }
      }
      if (wrong.length > 0) {
        problems.push(...wrong);
        o.logger.info({ module: 'architect', agent: req.by, attempt, problems: wrong }, 'a draft did not work');
        messages.push({ role: 'assistant', content: JSON.stringify(r.value) });
        messages.push({ role: 'user', content: `That doesn't work yet:\n- ${wrong.join('\n- ')}\nPut it right and reply with the whole JSON again.` });
      }
    }
  }
  let building: Building;
  if (design) {
    const named = { ...design, kind: design.kind, source: `designed by ${req.by}` };
    building = o.repertoire.save(named, { by: req.by });
  } else {
    const near = nearestDesign(o.repertoire, req);
    if (!near) throw new Error('the repertoire has no designs');
    building = near;
    how = 'repertoire';
  }
  const base = await o.repertoire.blueprint(building);
  const sub = substitute(base, { ...(req.raw ? { raw: req.raw } : {}) });
  const bill = billOf(sub.blueprint);
  const materials = planMaterials(bill, { ...(req.have ? { have: req.have } : {}), ...(req.raw ? { raw: req.raw } : {}) });
  const asks = asksFor(materials.raw, req.helpers, req.by);
  o.logger.info({ module: 'architect', agent: req.by, building: building.id, how, effort: materials.effort, swaps: sub.swaps.length, asks }, 'a building designed');
  return { building, blueprint: sub.blueprint, swaps: sub.swaps, materials, asks, how, note, problems };
}

/** The design's plan for the one who drew it: get what it takes, ask for some of it, make the parts, build it. */
export function buildingPlan(r: DesignResult, purpose: string): { aim: string; steps: { text: string; doneWhen?: string }[]; why: string } {
  const asked = new Set(r.asks.map((a) => a.item));
  const own = r.materials.raw.filter((n) => !asked.has(n.item)).sort((a, b) => b.count - a.count);
  const steps: { text: string; doneWhen?: string }[] = [];
  for (const n of own.slice(0, 2)) steps.push({ text: `get ${n.count} ${n.item.replace(/_/g, ' ')} for the ${r.building.name}`, doneWhen: `inventoryHas:${n.item}>=${n.count}` });
  for (const a of r.asks) steps.push({ text: `ask ${a.who} to bring ${a.count} ${a.item.replace(/_/g, ' ')} for the ${r.building.name}`, doneWhen: `talkedWith:${a.who}` });
  const made = r.materials.steps.filter((s) => s.how !== 'gather' && r.materials.bill.some((b) => b.item === s.item)).sort((a, b) => b.count - a.count);
  const top = made[0];
  if (top) steps.push({ text: `make the ${made.slice(0, 3).map((s) => s.item.replace(/_/g, ' ')).join(', ')} it needs`, doneWhen: `inventoryHas:${top.item}>=${top.count}` });
  steps.push({ text: `build the ${r.building.name}`, doneWhen: `built:${r.building.id}` });
  return { aim: `build the ${r.building.name}: ${purpose}`.slice(0, 160), steps: steps.slice(-6), why: r.note || `drawn for ${purpose}` };
}

/** What the designer is told: what it drew, what it takes, how the parts are made, whom to ask. */
export function describeDesign(r: DesignResult): string {
  const raw = r.materials.raw
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((n) => `${n.count} ${n.item.replace(/_/g, ' ')}`)
    .join(', ');
  const made = r.materials.steps
    .filter((s) => s.how !== 'gather')
    .slice(-5)
    .map((s) => `${s.how} ${s.count} ${s.item.replace(/_/g, ' ')} from ${s.from.map((f) => `${f.count} ${f.item.replace(/_/g, ' ')}`).join(' + ')}${s.table ? ' (at a crafting table)' : ''}`)
    .join('; ');
  const asks = r.asks.map((a) => `${a.who} could bring ${a.count} ${a.item.replace(/_/g, ' ')}`).join('; ');
  const swaps = r.swaps.map((s) => `${s.to.replace(/_/g, ' ')} for ${s.from.replace(/_/g, ' ')}`).join(', ');
  return [
    `${r.how === 'repertoire' ? 'chose' : 'designed'} the ${r.building.name}: ${r.building.description}`,
    `it takes about ${raw} (about ${r.materials.effort} min of work)`,
    made ? `making the parts: ${made}` : '',
    swaps ? `using ${swaps} (easier to get)` : '',
    asks,
  ]
    .filter(Boolean)
    .join('. ');
}
