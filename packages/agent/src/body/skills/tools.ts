// A tool for the job (owner request, 2026-10-24: agents were confused and didn't make their own tools). Making the
// common tools is easy in Minecraft, so a skill that needs one makes it when it can, as a player would: a pickaxe for
// stone and ore (without one they drop nothing), a weapon to hunt with, and an axe or a shovel when there is a lot of
// wood or earth to dig. It goes through `obtain` (planner.ts), which gets the wood, the sticks, the cobblestone and the
// crafting table it takes. A tool being made makes no tool of its own (`toolDepth`), so it never goes in circles.

import type { Bot } from 'mineflayer';
import { countItem } from '../inventory';
import { itemMatcher } from '../items';
import type { SkillContext, SkillResult } from './types';

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword';

/** Best first. */
const MATERIALS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'] as const;
/** Cobblestone a stone tool takes (the rest is sticks). */
const STONE_FOR: Readonly<Record<ToolKind, number>> = { pickaxe: 3, axe: 3, shovel: 1, sword: 2 };

/** The best tool of this kind we carry, or null. */
export function toolOf(bot: Bot, kind: ToolKind): string | null {
  const have = new Set(bot.inventory.items().map((i) => i.name));
  for (const m of MATERIALS) if (have.has(`${m}_${kind}`)) return `${m}_${kind}`;
  return null;
}

/** The one to make now: stone when we carry the cobblestone for it, otherwise wood. */
export function toolToMake(bot: Bot, kind: ToolKind): string {
  return countItem(bot, itemMatcher('cobblestone')) >= STONE_FOR[kind] ? `stone_${kind}` : `wooden_${kind}`;
}

/** Another skill run from within one (the registry imports every skill: looked up when needed, not at load). */
export async function runOther(ctx: SkillContext, name: string, args: Record<string, unknown>): Promise<SkillResult | null> {
  const { getSkill } = await import('./registry');
  const skill = getSkill(name);
  return skill ? skill.run(ctx, args) : null;
}

/** Makes it, with whatever that takes (obtain). True when we hold it after. */
export async function makeTool(ctx: SkillContext, item: string): Promise<boolean> {
  if ((ctx.toolDepth ?? 0) > 0) return false;
  // The registry imports every skill, this one's callers among them: looked up when needed, not at load.
  const { getSkill } = await import('./registry');
  const obtain = getSkill('obtain');
  if (!obtain) return false;
  ctx.progress(`making a ${item.replace(/_/g, ' ')} first`);
  ctx.logger.info({ module: 'skill', tool: item }, 'making a tool for the job');
  const r = await obtain.run({ ...ctx, toolDepth: (ctx.toolDepth ?? 0) + 1 }, { item, qty: 1 });
  return r.ok;
}

/** A tool of this kind in hand, or made if we lack one and can make it (false if we have none after). */
export async function ensureTool(ctx: SkillContext, kind: ToolKind): Promise<boolean> {
  if (toolOf(ctx.bot, kind)) return true;
  return makeTool(ctx, toolToMake(ctx.bot, kind));
}
