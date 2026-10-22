// Agents' skins (§16.5). A new agent gets a NameMC skin from the tag for its sex (by default "boy" and "girl"),
// signed through MineSkin, before it first logs in. The supervisor keeps it with the agent in roster.json, and the
// agora-skins plugin puts it on the player as it logs in, from skins.tsv in its folder. Everything is cached: a
// tag's listing for a day, every image and every signed copy for good, so each skin is fetched and signed once.
// Living agents wear different skins while the tag has enough of them.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type Logger, type Random, type Sex, type WorldConfig, shuffle, writeFileAtomic } from '@agora/shared';
import { MineSkinClient, MineSkinError } from './mineskin';
import { NAMEMC_USER_AGENT, NameMcBlockedError, SkinImageError, fetchSkinImage, fetchTagPage, ownerSkinIds, tagUrl } from './namemc';

export const AgentSkinSchema = z.object({
  source: z.literal('namemc'),
  /** The NameMC skin id (namemc.com/skin/<id>). */
  id: z.string().regex(/^[0-9a-f]{16}$/),
  tag: z.string(),
  variant: z.enum(['classic', 'slim']),
  /** Where Mojang hosts the image. */
  url: z.string(),
  /** The signed textures property. */
  value: z.string(),
  signature: z.string(),
});
export type AgentSkin = z.infer<typeof AgentSkinSchema>;

const SignedSchema = AgentSkinSchema.pick({ variant: true, url: true, value: true, signature: true });

const LibrarySchema = z.object({
  version: z.literal(1),
  /** Each tag's listing, as last read from NameMC. */
  listings: z.record(z.string(), z.object({ ids: z.array(z.string()), at: z.number() })).default({}),
  /** Signed copies, by NameMC skin id. */
  signed: z.record(z.string(), SignedSchema).default({}),
  /** Skins that will never do (not a skin image, or MineSkin rejected it). */
  bad: z.record(z.string(), z.object({ why: z.string(), at: z.number() })).default({}),
});
type Library = z.infer<typeof LibrarySchema>;

/** A listing read this long ago is read again. */
const LISTING_TTL_MS = 24 * 60 * 60_000;
/** Turned away by NameMC, try it again after this. */
const BLOCKED_RETRY_MS = 6 * 60 * 60_000;
/** A new agent's skin is one of the first this many of the listing (the most liked), at random. */
const TOP = 24;
/** Skins tried for one agent before giving up for now. */
const TRIES = 3;

export interface SkinServiceOptions {
  config: WorldConfig['skins'];
  /** DATA_DIR/skins: what the owner saved (namemc/<tag>/*.html pages, *.txt lists of skin links). */
  ownerDir: string;
  /** Listings, images and signed copies are kept here. */
  cacheDir: string;
  /** The agora-skins plugin's folder on the server: skins.tsv goes there. */
  pluginDir: string;
  logger: Logger;
  rng: Random;
  /** Optional (MINESKIN_API_KEY). */
  mineskinKey?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One line of skins.tsv: who wears which signed textures. */
export function skinsTsv(entries: readonly { username: string; skin?: AgentSkin | undefined }[]): string {
  const lines = entries
    .filter((e): e is { username: string; skin: AgentSkin } => Boolean(e.skin) && /^[A-Za-z0-9_]{1,16}$/.test(e.username))
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((e) => `${e.username}\t${e.skin.value}\t${e.skin.signature}`);
  return `# agora-skins (DESIGN.md §16.5), written by the Hub: username, textures value, signature\n${lines.map((l) => `${l}\n`).join('')}`;
}

export class SkinService {
  private lib: Library;
  private readonly mineskin: MineSkinClient;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly blockedUntil = new Map<string, number>();
  private readonly told = new Set<string>();
  /** Skins being got for an agent right now: not for another one at the same time. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly o: SkinServiceOptions) {
    this.now = o.now ?? Date.now;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.lib = this.load();
    this.mineskin = new MineSkinClient({
      key: o.mineskinKey ?? null,
      userAgent: NAMEMC_USER_AGENT,
      fetchImpl: this.fetchImpl,
      now: this.now,
      ...(o.sleep ? { sleep: o.sleep } : {}),
    });
  }

  private get libraryFile(): string {
    return path.join(this.o.cacheDir, 'library.json');
  }

  private load(): Library {
    try {
      if (fs.existsSync(this.libraryFile)) return LibrarySchema.parse(JSON.parse(fs.readFileSync(this.libraryFile, 'utf8')));
    } catch (err) {
      this.o.logger.warn({ module: 'skins', err: String(err) }, 'skin cache unreadable; starting it afresh');
    }
    return LibrarySchema.parse({ version: 1 });
  }

  private save(): void {
    writeFileAtomic(this.libraryFile, `${JSON.stringify(this.lib, null, 2)}\n`);
  }

  /**
   * A skin for a new agent of this sex: one of the tag's most liked, not one a living agent wears (`taken`, by
   * NameMC id) while there are others. Null when there is none to be had now (nothing listed, or every try failed).
   */
  async skinFor(sex: Sex, taken: ReadonlySet<string>): Promise<AgentSkin | null> {
    const tag = this.o.config.tags[sex];
    const usable = (await this.listing(tag)).filter((id) => !this.o.config.exclude.includes(id) && !this.lib.bad[id]);
    const free = usable.filter((id) => !taken.has(id) && !this.inFlight.has(id));
    const pool = (free.length > 0 ? free : usable).slice(0, TOP);
    // Those already signed first: no request at all.
    const order = [...shuffle(this.o.rng, pool.filter((id) => this.lib.signed[id])), ...shuffle(this.o.rng, pool.filter((id) => !this.lib.signed[id]))];
    for (const id of order.slice(0, TRIES)) {
      this.inFlight.add(id);
      try {
        const signed = await this.signed(id, tag);
        if (signed) return { source: 'namemc', id, tag, ...signed };
      } finally {
        this.inFlight.delete(id);
      }
    }
    if (order.length === 0) this.tellOnce(`empty:${tag}`, { tag }, `no NameMC skins for tag "${tag}" yet: agents of that sex log in without a skin`);
    return null;
  }

  /** The tag's skin ids: what the owner saved first, then NameMC's listing (read again once a day). */
  private async listing(tag: string): Promise<string[]> {
    const owner = ownerSkinIds(path.join(this.o.ownerDir, 'namemc'), tag);
    const cached = this.lib.listings[tag];
    const t = this.now();
    if ((!cached || t - cached.at >= LISTING_TTL_MS) && t >= (this.blockedUntil.get(tag) ?? 0)) {
      try {
        const ids: string[] = [];
        for (let page = 1; page <= this.o.config.pages; page++) {
          const got = await fetchTagPage(tag, page, this.fetchImpl, AbortSignal.timeout(20_000));
          for (const id of got) if (!ids.includes(id)) ids.push(id);
          if (got.length === 0) break;
        }
        if (ids.length > 0) {
          this.lib.listings[tag] = { ids, at: t };
          this.save();
          this.o.logger.info({ module: 'skins', tag, skins: ids.length }, 'NameMC listing read');
        }
      } catch (err) {
        if (err instanceof NameMcBlockedError) {
          this.blockedUntil.set(tag, t + BLOCKED_RETRY_MS);
          const dir = path.join(this.o.ownerDir, 'namemc', tag);
          this.tellOnce(
            `blocked:${tag}`,
            { tag, ownerSkins: owner.length },
            `NameMC turned away the request for its "${tag}" skins (a Cloudflare challenge, only a browser gets the page). ` +
              `Open ${tagUrl(tag)} in your browser and save the page (Ctrl+S, "HTML only") into ${dir}, or put NameMC skin links in a .txt file there, one per line`,
          );
        } else this.o.logger.warn({ module: 'skins', tag, err: String(err) }, 'NameMC listing could not be read');
      }
    }
    return [...new Set([...owner, ...(this.lib.listings[tag]?.ids ?? [])])];
  }

  /** The signed copy of a NameMC skin: from the cache, or fetched and signed now. Null if not to be had now. */
  private async signed(id: string, tag: string): Promise<z.infer<typeof SignedSchema> | null> {
    const have = this.lib.signed[id];
    if (have) return have;
    try {
      const png = await this.image(id);
      const t = await this.mineskin.sign(png, { name: `agora ${tag} ${id}`, visibility: this.o.config.visibility });
      this.lib.signed[id] = t;
      this.save();
      this.o.logger.info({ module: 'skins', tag, id, variant: t.variant }, 'skin signed');
      return t;
    } catch (err) {
      const bad = err instanceof SkinImageError || (err instanceof MineSkinError && err.badImage);
      if (bad) {
        this.lib.bad[id] = { why: String(err instanceof Error ? err.message : err), at: this.now() };
        this.save();
      }
      this.o.logger.warn({ module: 'skins', tag, id, err: String(err instanceof Error ? err.message : err) }, bad ? 'NameMC skin unusable; skipped from now on' : 'skin not signed (for now)');
      return null;
    }
  }

  private async image(id: string): Promise<Buffer> {
    const file = path.join(this.o.cacheDir, 'namemc', `${id}.png`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const png = await fetchSkinImage(id, this.fetchImpl, AbortSignal.timeout(20_000));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return png;
  }

  /** Tells the plugin who wears what: skins.tsv, read again by the plugin whenever it changes. */
  publish(entries: readonly { username: string; skin?: AgentSkin | undefined }[]): void {
    writeFileAtomic(path.join(this.o.pluginDir, 'skins.tsv'), skinsTsv(entries));
  }

  private tellOnce(key: string, fields: Record<string, unknown>, msg: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.o.logger.warn({ module: 'skins', ...fields }, msg);
  }
}
