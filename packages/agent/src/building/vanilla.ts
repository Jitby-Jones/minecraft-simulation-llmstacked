// Buildings from the game itself (owner request, 2026-10-24: buildings researched and their block data generated,
// from several angles if possible). The server jar the owner already has holds every village building as a structure
// file: each block of it, inside and out, every side. Read from the owner's own jar when it is there, never copied
// into this repository. A village house reads as a blueprint (compile.ts): its ground is the floor its door stands
// on, the air it clears around itself above the ground and not below, its markers (jigsaw blocks) what they become.
// Needs no unzip: a jar is a zip, and its directory and entries are read here (stored or deflated).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';
import { blueprintOf, cellKey, type Blueprint, type Entrance } from './compile';
import { type Facing, formatState, opposite, parseState } from './state';

interface Source {
  size: number;
  read(len: number, at: number): Buffer;
}

interface ZipEntry {
  method: number;
  compressed: number;
  offset: number;
}

/** A zip (a jar) read in place: its directory, and an entry when asked for. */
export class Zip {
  private constructor(
    private readonly src: Source,
    readonly entries: ReadonlyMap<string, ZipEntry>,
    private readonly onClose: () => void,
  ) {}

  static open(file: string): Zip {
    const fd = fs.openSync(file, 'r');
    const src: Source = {
      size: fs.fstatSync(fd).size,
      read: (len, at) => {
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, at);
        return b;
      },
    };
    try {
      return new Zip(src, Zip.directory(src), () => fs.closeSync(fd));
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  static of(buf: Buffer): Zip {
    const src: Source = { size: buf.length, read: (len, at) => buf.subarray(at, at + len) };
    return new Zip(src, Zip.directory(src), () => undefined);
  }

  private static directory(src: Source): Map<string, ZipEntry> {
    const tailLen = Math.min(src.size, 65_557);
    const tail = src.read(tailLen, src.size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip file');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    const locator = eocd - 20;
    if ((count === 0xffff || cdOffset === 0xffffffff) && locator >= 0 && tail.readUInt32LE(locator) === 0x07064b50) {
      const z = src.read(56, Number(tail.readBigUInt64LE(locator + 8)));
      if (z.readUInt32LE(0) === 0x06064b50) {
        count = Number(z.readBigUInt64LE(32));
        cdSize = Number(z.readBigUInt64LE(40));
        cdOffset = Number(z.readBigUInt64LE(48));
      }
    }
    const cd = src.read(cdSize, cdOffset);
    const entries = new Map<string, ZipEntry>();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; i++) {
      const method = cd.readUInt16LE(p + 10);
      let compressed = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      // Zip64: the sizes and offset that don't fit are in an extra field, in this order.
      for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen; ) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) q += 8;
          if (compressed === 0xffffffff) {
            compressed = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      entries.set(name, { method, compressed, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  read(name: string): Buffer | null {
    const e = this.entries.get(name);
    if (!e) return null;
    const head = this.src.read(30, e.offset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad zip entry ${name}`);
    const data = this.src.read(e.compressed, e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28));
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`zip entry ${name}: compression ${e.method} not read`);
  }

  close(): void {
    this.onClose();
  }
}

/**
 * The jar with the game's data in it: Paper's own (versions/<v>/paper-<v>.jar), else the game's server jar it was
 * made from (cache/mojang_<v>.jar, which holds the real one inside it). Null when neither is there.
 */
export function openGameJar(serverDir: string): Zip | null {
  const newest = (dir: string, re: RegExp) => {
    try {
      return fs
        .readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((f) => re.test(path.basename(f)))
        .map((f) => path.join(dir, f))
        .sort()
        .at(-1);
    } catch {
      return undefined;
    }
  };
  const paper = newest(path.join(serverDir, 'versions'), /^paper-.*\.jar$/);
  if (paper) {
    const z = Zip.open(paper);
    if ([...z.entries.keys()].some((n) => n.startsWith(VILLAGE_DIR))) return z;
    z.close();
  }
  const mojang = newest(path.join(serverDir, 'cache'), /^mojang_.*\.jar$/);
  if (!mojang) return null;
  const outer = Zip.open(mojang);
  try {
    const inner = [...outer.entries.keys()].find((n) => /^META-INF\/versions\/[^/]+\/server-[^/]+\.jar$/.test(n));
    const buf = inner ? outer.read(inner) : null;
    if (buf) return Zip.of(buf);
    return [...outer.entries.keys()].some((n) => n.startsWith(VILLAGE_DIR)) ? outer : null;
  } finally {
    outer.close();
  }
}

const VILLAGE_DIR = 'data/minecraft/structure/village/';
const HOUSE_RE = /^data\/minecraft\/structure\/village\/(plains|desert|savanna|taiga|snowy)\/houses\/([a-z0-9_]+)\.nbt$/;

export interface VanillaEntry {
  /** "vanilla:plains_small_house_1" */
  id: string;
  biome: string;
  /** The file's own name: "plains_small_house_1". */
  file: string;
  name: string;
  kind: string;
}

/** What a village building is, by its file's name. */
export function vanillaKind(file: string): string {
  if (/_house_|_cottage/.test(file) && !/(armorer|butcher|fletcher|masons|shepherds|weaponsmith|tool_smith|cartographer)/.test(file)) return 'house';
  if (/farm/.test(file)) return 'farm';
  if (/animal_pen|stable/.test(file)) return /stable/.test(file) ? 'barn' : 'pen';
  if (/library/.test(file)) return 'library';
  if (/temple/.test(file)) return 'shrine';
  if (/meeting_point/.test(file)) return 'well';
  if (/(armorer|weaponsmith|tool_smith)/.test(file)) return 'smithy';
  if (/(butcher|fletcher|masons|shepherds|cartographer|tannery|fisher)/.test(file)) return 'workshop';
  return 'other';
}

/** The village buildings in the jar, of every biome (the ruined, zombie villages' are not). */
export function listVanilla(jar: Zip): VanillaEntry[] {
  const out: VanillaEntry[] = [];
  for (const n of jar.entries.keys()) {
    const m = HOUSE_RE.exec(n);
    if (!m?.[1] || !m[2]) continue;
    out.push({ id: `vanilla:${m[2]}`, biome: m[1], file: m[2], name: m[2].replace(/_/g, ' '), kind: vanillaKind(m[2]) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** What a placed block keeps of its state: what the one placing it decides (the game works out the rest). */
const KEEP = new Set(['facing', 'half', 'hinge', 'part', 'axis', 'type', 'hanging', 'rotation', 'face', 'attachment', 'layers']);
/** The ground itself: kept as the site has it, not dug out and put back. */
const GROUND = /^(grass_block|dirt|coarse_dirt|podzol|sand|red_sand|snow_block|gravel|stone)$/;

interface Palette {
  Name: string;
  Properties?: Record<string, string>;
}

function stateOf(p: Palette): string {
  const name = p.Name.replace(/^minecraft:/, '');
  const props: Record<string, string> = {};
  for (const [key, v] of Object.entries(p.Properties ?? {})) if (KEEP.has(key) || (key === 'shape' && name.endsWith('rail'))) props[key] = v;
  // A chest is placed single; the game joins two side by side.
  if (/chest$/.test(name)) delete props.type;
  return formatState({ name, props });
}

/** A structure file (gzipped NBT) as a blueprint. */
export async function blueprintFromStructure(name: string, file: Buffer): Promise<Blueprint> {
  const { parsed } = await nbt.parse(file);
  const s = nbt.simplify(parsed) as { size: number[]; palette?: Palette[]; palettes?: Palette[][]; blocks: { pos: number[]; state: number; nbt?: { final_state?: string } }[] };
  const palette = s.palette ?? s.palettes?.[0] ?? [];
  const cells: { x: number; y: number; z: number; state: string }[] = [];
  const air: { x: number; y: number; z: number }[] = [];
  for (const blk of s.blocks) {
    const [x = 0, y = 0, z = 0] = blk.pos;
    const p = palette[blk.state];
    if (!p) continue;
    let state = stateOf(p);
    // A marker for joining pieces becomes what it says it ends as.
    if (p.Name === 'minecraft:jigsaw') state = blk.nbt?.final_state ? stateOf({ Name: parseState(blk.nbt.final_state).name, Properties: parseState(blk.nbt.final_state).props }) : 'air';
    const n = parseState(state).name;
    if (n === 'structure_void' || n === 'structure_block') continue;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') air.push({ x, y, z });
    else cells.push({ x, y, z, state });
  }
  // The ground is what the door stands on.
  const doors = cells.filter((c) => /_door\[/.test(c.state) && c.state.includes('half=lower'));
  const ground = doors.length > 0 ? Math.min(...doors.map((c) => c.y)) - 1 : 0;
  const states = new Map<string, string>();
  for (const c of cells) {
    const y = c.y - ground;
    if (y <= 0 && GROUND.test(parseState(c.state).name)) continue;
    states.set(cellKey(c.x, y, c.z), c.state);
  }
  const clear = new Set<string>();
  for (const a of air) if (a.y - ground > 0) clear.add(cellKey(a.x, a.y - ground, a.z));
  // The way out of the door: the side from which a line at its height leaves the building without meeting a block
  // (the other runs into the room's far wall).
  let entrance: Entrance | null = null;
  const reach = Math.max(...s.size, 1);
  for (const d of doors.sort((a, b) => a.y - b.y)) {
    const f = parseState(d.state).props.facing as Facing | undefined;
    if (!f) continue;
    const out = [opposite(f), f].find((dir) => {
      const v = dir === 'north' ? [0, -1] : dir === 'south' ? [0, 1] : dir === 'east' ? [1, 0] : [-1, 0];
      for (let i = 1; i <= reach; i++) {
        for (const dy of [0, 1]) if (states.has(cellKey(d.x + i * (v[0] ?? 0), d.y - ground + dy, d.z + i * (v[1] ?? 0)))) return false;
      }
      return true;
    });
    if (out) {
      entrance = { x: d.x, y: d.y - ground, z: d.z, out };
      break;
    }
  }
  return blueprintOf(name, states, clear, entrance);
}

/** One village building from the jar. */
export async function loadVanilla(jar: Zip, entry: VanillaEntry): Promise<Blueprint> {
  const file = jar.read(`${VILLAGE_DIR}${entry.biome}/houses/${entry.file}.nbt`);
  if (!file) throw new Error(`${entry.id} is not in the game's jar`);
  return blueprintFromStructure(entry.name, file);
}
