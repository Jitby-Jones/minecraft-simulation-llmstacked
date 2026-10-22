// MineSkin (§16.5). A Minecraft client shows only a skin that Mojang hosts, with the textures signed by Mojang,
// and in offline mode no player has one: MineSkin makes that signed copy of an image on one of its accounts.
// Requests go one at a time, as MineSkin paces them (its `next` delay, and Retry-After on a 429). With an API key
// its limits are higher; without one, its anonymous ones apply. The key is only ever sent in the header, never
// logged or put in an error.

import { z } from 'zod';

const GENERATE_URL = 'https://api.mineskin.org/v2/generate';
const TEXTURE_URL = /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** 429s in a row before giving up on this one. */
const MAX_RETRIES = 3;

const GenerateResponseSchema = z.object({
  skin: z
    .object({
      variant: z.enum(['classic', 'slim', 'unknown']).catch('unknown'),
      texture: z.object({
        data: z.object({ value: z.string().regex(BASE64), signature: z.string().regex(BASE64) }),
        url: z.object({ skin: z.string().regex(TEXTURE_URL) }),
      }),
    })
    .optional(),
  rateLimit: z.object({ next: z.object({ relative: z.number() }).optional() }).optional(),
  errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() })).optional(),
});

/** A skin as Minecraft clients take it: the signed textures property, and where Mojang hosts the image. */
export interface SignedTexture {
  value: string;
  signature: string;
  url: string;
  variant: 'classic' | 'slim';
}

export class MineSkinError extends Error {
  constructor(
    message: string,
    /** This image will never do (MineSkin rejected it), as opposed to a refusal or an outage. */
    readonly badImage: boolean,
  ) {
    super(message);
    this.name = 'MineSkinError';
  }
}

export interface MineSkinOptions {
  key?: string | null;
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class MineSkinClient {
  private nextAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: MineSkinOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A signed copy of this skin PNG. One request at a time, each when MineSkin said the next may come. */
  sign(png: Buffer, opts: { name: string; visibility: 'public' | 'unlisted' | 'private' }): Promise<SignedTexture> {
    const run = this.queue.then(() => this.generate(png, opts, 0));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async generate(png: Buffer, opts: { name: string; visibility: string }, retries: number): Promise<SignedTexture> {
    const wait = this.nextAt - this.now();
    if (wait > 0) await this.sleep(wait);
    const res = await (this.o.fetchImpl ?? fetch)(GENERATE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': this.o.userAgent,
        ...(this.o.key ? { authorization: `Bearer ${this.o.key}` } : {}),
      },
      body: JSON.stringify({ url: `data:image/png;base64,${png.toString('base64')}`, name: opts.name.slice(0, 48), visibility: opts.visibility }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // Not JSON: an outage page; handled below by status.
    }
    const parsed = GenerateResponseSchema.safeParse(json);
    const next = parsed.success ? parsed.data.rateLimit?.next?.relative : undefined;
    this.nextAt = this.now() + Math.max(0, next ?? 0);
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      this.nextAt = Math.max(this.nextAt, this.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : 10_000));
      if (retries < MAX_RETRIES) return this.generate(png, opts, retries + 1);
      throw new MineSkinError('MineSkin: rate limited, try again later', false);
    }
    if (res.status === 401 || res.status === 403) throw new MineSkinError(`MineSkin refused the request (${res.status}): check MINESKIN_API_KEY in .env`, false);
    const skin = parsed.success ? parsed.data.skin : undefined;
    if (!res.ok || !skin) {
      const why = parsed.success ? (parsed.data.errors ?? []).map((e) => e.message ?? e.code ?? '').filter(Boolean).join('; ') : 'unexpected reply';
      throw new MineSkinError(`MineSkin: ${res.status}${why ? ` ${why}` : ''}`, res.status === 400);
    }
    return { value: skin.texture.data.value, signature: skin.texture.data.signature, url: skin.texture.url.skin, variant: skin.variant === 'slim' ? 'slim' : 'classic' };
  }
}
