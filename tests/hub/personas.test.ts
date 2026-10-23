// The master model writing new people (owner request, 2026-10-23: agents weren't fully randomized; §16.2, §20):
// code's numbers kept, the model's words checked, code's words when they won't do; a child written from its parents.
// Against the mocked NanoGPT; the real models write people in tests/live/real-models.test.ts.

import { describe, expect, it } from 'vitest';
import { ModelsConfigSchema, NUMERIC_TRAIT_KEYS, type Persona, PersonaSchema, SeededRandom, SexDifferencesSchema, WorldConfigSchema, generatePersona, getTrait, inheritPersona, nullLogger } from '@agora/shared';
import { LocalRateLimiter, startLlm } from '@agora/llm';
import { PersonaWriter, describeNumbers } from '@agora/hub';
import { FakeNanoGpt, standardModels } from '../llm/fakeNanoGpt';

const world = WorldConfigSchema.parse({});
const sexDiffs = SexDifferencesSchema.parse({});

const written = {
  givenName: 'Talia',
  traits: ['wry', 'restless', 'generous'],
  description: 'Talia grew up on a windy coast mending nets, and left to see what lies inland. She laughs easily and shares what she has.',
  speechStyle: 'quick and teasing',
  catchphrases: ['well, look at that'],
  values: ['freedom', 'friendship'],
  lifeGoals: ['find the source of the river', 'build a boat of her own'],
  insecurities: ['worries she never finishes things'],
};

async function writer(reply: (n: number) => unknown) {
  const fake = new FakeNanoGpt(standardModels());
  let n = 0;
  const asked: { model: string; system: string; user: string }[] = [];
  fake.chat = ({ body }) => {
    const messages = body.messages as { role: string; content: string }[];
    asked.push({ model: String(body.model), system: messages[0]?.content ?? '', user: messages.at(-1)?.content ?? '' });
    n++;
    const r = reply(n);
    return { text: typeof r === 'string' ? r : JSON.stringify(r) };
  };
  const rt = await startLlm({ apiKey: 'k', config: ModelsConfigSchema.parse({}), logger: nullLogger(), fetch: fake.fetch, background: false, limiter: new LocalRateLimiter({ rps: 10_000 }) });
  return { w: new PersonaWriter({ llm: rt.client, logger: nullLogger(), rng: new SeededRandom(4) }), asked, stop: () => rt.stop() };
}

const draftOf = (seed = 1, sex: 'male' | 'female' = 'female') => generatePersona({ rng: new SeededRandom(seed), world, sexDiffs, takenNames: new Set(), sex });
const sameNumbers = (a: Persona, b: Persona) => NUMERIC_TRAIT_KEYS.every((k) => getTrait(a, k) === getTrait(b, k)) && a.abilities.intelligence === b.abilities.intelligence && a.abilities.combat === b.abilities.combat;

describe('the master model writes a new person (§16.2, §20)', () => {
  it("from code's numbers, never the sex label: its words, a name nobody has had, the numbers kept", async () => {
    const x = await writer(() => written);
    const draft = draftOf();
    const p = await x.w.write(draft, { takenNames: new Set(['Bram']), living: [PersonaSchema.parse({ name: 'Bram', sex: 'male', traits: ['steady'], description: 'Bram keeps to himself.' })] });
    x.stop();
    expect(p).toMatchObject({ name: 'Talia', id: 'gen-talia', source: 'generated', traits: ['wry', 'restless', 'generous'], values: ['freedom', 'friendship'], insecurities: ['worries she never finishes things'] });
    expect(p.speech).toMatchObject({ style: 'quick and teasing', catchphrases: ['well, look at that'] });
    expect(sameNumbers(p, draft)).toBe(true);
    expect(p.quirks).toEqual(draft.quirks);
    // L3, told the numbers, a spark, the names taken and who is here already.
    expect(x.asked[0]?.model).toBe('p1-big');
    expect(x.asked[0]?.system).toMatch(/never their character/);
    expect(x.asked[0]?.user).toContain(describeNumbers(draft));
    expect(x.asked[0]?.user).toMatch(/A new woman arrives/);
    expect(x.asked[0]?.user).toMatch(/A spark to start from/);
    expect(x.asked[0]?.user).toMatch(/Names already taken: Bram/);
    expect(x.asked[0]?.user).toMatch(/- Bram: steady; Bram keeps to himself/);
  });

  it('a name already had is made new, and the story names them by it', async () => {
    const x = await writer(() => written);
    const p = await x.w.write(draftOf(), { takenNames: new Set(['Talia']), living: [] });
    x.stop();
    expect(p.name).not.toBe('Talia');
    expect(p.name.toLowerCase()).toContain('talia');
    expect(p.description).toContain(p.name);
  });

  it("words that won't do (not PG, or of games and machines), or no answer: code's own words stand", async () => {
    const draft = draftOf(2);
    for (const bad of [
      { ...written, description: 'Talia is a friendly bot who helps the players of the server, and she is very kind.' },
      { ...written, catchphrases: ['you look sexy today'] },
      'not json at all',
    ]) {
      const x = await writer(() => bad);
      expect(await x.w.write(draft, { takenNames: new Set(), living: [] })).toEqual(draft);
      x.stop();
    }
  });

  it("the operator's name is kept", async () => {
    const x = await writer(() => written);
    const draft = { ...draftOf(3), name: 'Quill' };
    const p = await x.w.write(draft, { takenNames: new Set(), living: [], keepName: true });
    x.stop();
    expect(p.name).toBe('Quill');
    expect(x.asked[0]?.user).toMatch(/called Quill \(keep that name\)/);
  });

  it('a child: written from its parents, its family initial on its name, born and of the next generation', async () => {
    const ned = PersonaSchema.parse({ name: 'Ned', sex: 'male', familyName: 'Stark', traits: ['kind', 'easygoing'], description: 'Ned likes a quiet life.' });
    const ivy = PersonaSchema.parse({ name: 'Ivy', sex: 'female', traits: ['warm', 'cheerful'] });
    const draft = inheritPersona({ rng: new SeededRandom(9), world, a: ned, b: ivy, takenNames: new Set() });
    const x = await writer(() => ({ ...written, givenName: 'Rowan', description: 'Rowan has her father’s patience and her mother’s laugh.' }));
    const p = await x.w.write(draft, { takenNames: new Set(['Ned', 'Ivy']), living: [ned, ivy], parents: [ned, ivy] });
    x.stop();
    expect(p.name).toBe('Rowan_S');
    expect(p).toMatchObject({ source: 'born', familyName: 'Stark', generation: draft.generation });
    expect(sameNumbers(p, draft)).toBe(true);
    expect(x.asked[0]?.user).toMatch(new RegExp(`A (girl|boy) is born to Ned and Ivy \\(the Stark family\\)`));
    expect(x.asked[0]?.user).toMatch(/Ned: kind, easygoing; Ned likes a quiet life/);
  });
});
