// `design {purpose, kind?}` (owner request, 2026-10-24): an agent draws a building of its own, for what it wants (a
// home for itself and Wren, a smithy, a hall for the village), instead of only the repertoire's. What it sees of the
// land goes with the ask: the biome, the trees about, whether there is sand or clay near (the ground everyone can see
// from afar, §13 rule 4), and what it carries. The architect (building/architect.ts) draws it, keeps it for the
// village, and makes building it the agent's plan: what to get, whom to ask, what parts to make.

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Vec3 } from 'vec3';
import { defineSkill, type DesignAsk } from './types';

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];

/** The style of village a biome has. */
export function biomeStyle(biome: string): string {
  if (/desert|badlands/.test(biome)) return 'desert';
  if (/savanna/.test(biome)) return 'savanna';
  if (/snowy|frozen|ice|grove|jagged|peaks/.test(biome) && !/taiga/.test(biome)) return 'snowy';
  if (/taiga|old_growth/.test(biome)) return 'taiga';
  return 'plains';
}

function count(bot: Bot, name: RegExp): number {
  return bot.inventory
    .items()
    .filter((i) => name.test(i.name))
    .reduce((a, i) => a + i.count, 0);
}

/** What the land around home offers to build with, as anyone standing there could see. */
export function surveyLand(bot: Bot, home: Vec3 | null): Omit<DesignAsk, 'purpose' | 'kind'> {
  const at = (home ?? bot.entity.position).floored();
  const biome = (bot.blockAt(at) as unknown as { biome?: { name?: string } } | null)?.biome?.name ?? 'plains';
  const near = (names: readonly string[], max = 48) => {
    const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((v): v is number => v !== undefined);
    return ids.length === 0 ? 0 : bot.findBlocks({ point: at, matching: ids, maxDistance: 40, count: max }).length;
  };
  const woods = WOODS.map((w) => ({ w, n: near([`${w}_log`], 64) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.w);
  const sand = near(['sand']);
  const redSand = near(['red_sand']);
  const clay = near(['clay']);
  const sandstone = near(['sandstone']);
  const animals = (kind: string) => Object.values(bot.entities).some((e) => e.name === kind && e.position.distanceTo(at) < 48);
  const iron = count(bot, /^(raw_iron|iron_ingot|iron_block)$/) > 0;
  const raw: Record<string, number> = {
    sand: sand > 0 ? 0.4 : 25,
    red_sand: redSand > 0 ? 1 : 40,
    clay_ball: clay > 0 ? 0.6 : 25,
    sandstone: sandstone > 0 ? 0.5 : 30,
    raw_iron: iron ? 3 : 12,
    white_wool: animals('sheep') ? 1.5 : 6,
    leather: animals('cow') ? 2 : 6,
  };
  const carried = [
    [count(bot, /_log$/), 'logs'],
    [count(bot, /_planks$/), 'planks'],
    [count(bot, /^cobblestone$/), 'cobblestone'],
    [count(bot, /^(dirt|sand)$/), 'dirt and sand'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, what]) => `${n} ${what}`)
    .join(', ');
  const materials = [
    woods.length > 0 ? `trees about: ${woods.slice(0, 3).join(', ')}` : 'few trees about',
    'stone underfoot (cobblestone with a pickaxe)',
    sand > 0 ? 'sand near' : 'no sand seen near (no glass)',
    clay > 0 ? 'clay near' : '',
    sandstone > 0 ? 'sandstone in the ground' : '',
    carried ? `carrying ${carried}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return { biome: biomeStyle(biome), materials, woods, raw };
}

export const design = defineSkill({
  name: 'design',
  description:
    'design {purpose, kind?} — draw a building of your own for what you want (a home for you and Wren, a smithy, a lookout tower, a hall for the village): you get its design, what it takes, how to make its parts and who could help, and building it becomes your plan; then build {design: its name}',
  argsSchema: z.object({
    purpose: z.string().min(3).max(200),
    kind: z.string().min(2).max(20).optional(),
  }),
  talkOverable: true,
  slipKinds: [],
  expect: () => ({ kind: 'none' }),
  async run(ctx, args) {
    if (!ctx.architect) return { ok: false, observed: 'nobody to draw it', error: 'buildings cannot be designed here' };
    ctx.progress(`drawing ${args.purpose}`);
    const land = surveyLand(ctx.bot, ctx.home);
    return ctx.architect({ purpose: args.purpose, ...(args.kind ? { kind: args.kind } : {}), ...land });
  },
});
