// Runs one skill and checks its declared postcondition against the observed inventory/world diff (§4.6).
// A skill that claims success while the postcondition fails is reported as a mismatch.

import { type Logger, type Random, type Volume, randomId } from '@agora/shared';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { countIn, describeDiff, diffInventory, snapshotInventory } from '../inventory';
import { blockMatcher, itemMatcher } from '../items';
import { findEntity, isNight } from '../world';
import { isFoodName } from './gathering';
import { type AnySkill, type BodySnapshot, type Expectation, type SkillContext, type SlipKind, SkillAbortedError } from './types';

export interface SkillRunRecord {
  id: string;
  skill: string;
  args: Record<string, unknown>;
  expected: string;
  observed: string;
  ok: boolean;
  /** The skill said ok but the world disagrees (hallucination guard #1). */
  mismatch: boolean;
  aborted: boolean;
  error?: string;
  slip: SlipKind | null;
  startedAt: number;
  durationMs: number;
  /** Something was gained on the way, even if the whole task didn't finish. */
  progressed?: boolean;
}

export function snapshotBody(bot: Bot): BodySnapshot {
  return {
    inventory: snapshotInventory(bot),
    pos: bot.entity.position.clone(),
    food: bot.food,
    health: bot.health,
    ts: Date.now(),
  };
}

export function describeExpectation(e: Expectation): string {
  switch (e.kind) {
    case 'inventoryGain':
      return `+${e.atLeast} ${e.item}`;
    case 'inventoryLoss':
      return `-${e.atLeast} ${e.item}`;
    case 'inventoryHas':
      return `holding ${e.atLeast} ${e.item}`;
    case 'near':
      return `within ${e.within} of ${Math.round(e.pos.x)},${Math.round(e.pos.y)},${Math.round(e.pos.z)}`;
    case 'nearAgent':
      return `within ${e.within} of ${e.agent}`;
    case 'blockAt':
      return `${e.block} at ${e.pos.x},${e.pos.y},${e.pos.z}`;
    case 'entityGone':
      return `${e.target} gone`;
    case 'foodAbove':
      return `food > ${e.value}`;
    case 'equipped':
      return `${e.item} equipped`;
    case 'awakeAfterNight':
      return 'alive and it is day';
    case 'none':
      return 'no specific outcome';
  }
}

export function checkExpectation(bot: Bot, e: Expectation, before: BodySnapshot, after: BodySnapshot): { ok: boolean; observed: string } {
  switch (e.kind) {
    case 'inventoryGain': {
      const m = itemMatcher(e.item, isFoodName(bot));
      const d = countIn(after.inventory, m) - countIn(before.inventory, m);
      return { ok: d >= e.atLeast, observed: `${d >= 0 ? '+' : ''}${d} ${e.item}` };
    }
    case 'inventoryLoss': {
      const m = itemMatcher(e.item, isFoodName(bot));
      const d = countIn(before.inventory, m) - countIn(after.inventory, m);
      return { ok: d >= e.atLeast, observed: `-${d} ${e.item}` };
    }
    case 'inventoryHas': {
      const n = countIn(after.inventory, itemMatcher(e.item, isFoodName(bot)));
      return { ok: n >= e.atLeast, observed: `holding ${n} ${e.item}` };
    }
    case 'near': {
      const d = after.pos.distanceTo(e.pos);
      return { ok: d <= e.within, observed: `${d.toFixed(1)} blocks away` };
    }
    case 'nearAgent': {
      const ent = findEntity(bot, e.agent, 128);
      if (!ent) return { ok: false, observed: `${e.agent} not in sight` };
      const d = ent.position.distanceTo(after.pos);
      return { ok: d <= e.within, observed: `${d.toFixed(1)} blocks from ${e.agent}` };
    }
    case 'blockAt': {
      const b = bot.blockAt(new Vec3(e.pos.x, e.pos.y, e.pos.z));
      const m = blockMatcher(e.block);
      return { ok: Boolean(b && m.matches(b.name)), observed: `${b?.name ?? 'unloaded'} at target` };
    }
    case 'entityGone': {
      const ent = e.entityId !== undefined ? bot.entities[e.entityId] : findEntity(bot, e.target, 24);
      const here = Boolean(ent && (ent as unknown as { isValid?: boolean }).isValid !== false);
      return { ok: !here, observed: here ? `${e.target} still here` : `${e.target} gone` };
    }
    case 'foodAbove':
      return { ok: after.food > e.value, observed: `food ${after.food}` };
    case 'equipped': {
      const m = itemMatcher(e.item);
      const held = bot.heldItem?.name;
      const worn = [5, 6, 7, 8, 45].map((s) => bot.inventory.slots[s]?.name).filter((n): n is string => Boolean(n));
      const ok = Boolean((held && m.matches(held)) || worn.some((n) => m.matches(n)));
      return { ok, observed: ok ? `${e.item} equipped` : `holding ${held ?? 'nothing'}` };
    }
    case 'awakeAfterNight':
      return { ok: bot.health > 0 && !isNight(bot), observed: isNight(bot) ? 'still night' : `day, health ${bot.health}` };
    case 'none':
      return { ok: true, observed: describeDiff(diffInventory(before.inventory, after.inventory)) };
  }
}

export interface RunSkillDeps {
  bot: Bot;
  logger: Logger;
  rng: Random;
  signal: AbortSignal;
  movements: () => Movements;
  knowsRecipe: (item: string) => boolean;
  say: (text: string, volume?: Volume) => Promise<void>;
  /** Probability of an execution slip for this run (§21.1: ~8 % at low intelligence, ~1 % at high). */
  slipChance: number;
  progress?: (note: string) => void;
  planDepth?: number;
  home?: Vec3 | null;
  /** How long to wait for trailing server updates before judging the postcondition (default 2000 ms). */
  settleMs?: number;
}

export async function runSkill(skill: AnySkill, rawArgs: unknown, deps: RunSkillDeps): Promise<SkillRunRecord> {
  const startedAt = Date.now();
  const id = randomId(deps.rng, 8);
  const argsObj = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const parsed = skill.parseArgs(rawArgs);
  if (!parsed.ok) {
    return {
      id,
      skill: skill.name,
      args: argsObj,
      expected: 'valid arguments',
      observed: 'did not start',
      ok: false,
      mismatch: false,
      aborted: false,
      error: `bad arguments: ${parsed.error}`,
      slip: null,
      startedAt,
      durationMs: 0,
    };
  }
  const slip: SlipKind | null =
    skill.slipKinds.length > 0 && deps.rng.next() < deps.slipChance
      ? (skill.slipKinds[Math.floor(deps.rng.next() * skill.slipKinds.length)] ?? null)
      : null;
  const before = snapshotBody(deps.bot);
  const expectation = skill.expect(parsed.args, before, deps.bot);
  const ctx: SkillContext = {
    bot: deps.bot,
    signal: deps.signal,
    logger: deps.logger,
    rng: deps.rng,
    movements: deps.movements,
    knowsRecipe: deps.knowsRecipe,
    say: deps.say,
    slip,
    progress: deps.progress ?? (() => undefined),
    planDepth: deps.planDepth ?? 6,
    home: deps.home ?? null,
  };
  let ok = false;
  let observed: string;
  let error: string | undefined;
  let aborted = false;
  try {
    const r = await skill.run(ctx, parsed.args);
    ok = r.ok;
    observed = r.observed;
    error = r.error;
  } catch (err) {
    if (err instanceof SkillAbortedError) {
      aborted = true;
      error = err.message;
      observed = 'interrupted';
    } else {
      error = err instanceof Error ? err.message : String(err);
      observed = 'crashed';
    }
  }
  // Server updates (inventory, block changes) can trail the client's view by a few hundred ms: give the
  // world time to settle before calling a result a mismatch.
  let after = snapshotBody(deps.bot);
  let check = checkExpectation(deps.bot, expectation, before, after);
  const settleUntil = Date.now() + (deps.settleMs ?? 2000);
  while (!check.ok && !aborted && expectation.kind !== 'none' && Date.now() < settleUntil) {
    await new Promise((r) => setTimeout(r, 100));
    after = snapshotBody(deps.bot);
    check = checkExpectation(deps.bot, expectation, before, after);
  }
  const mismatch = ok && !check.ok && expectation.kind !== 'none';
  const record: SkillRunRecord = {
    id,
    skill: skill.name,
    args: argsObj,
    expected: describeExpectation(expectation),
    observed: observed === check.observed ? observed : `${observed}; ${check.observed}`,
    ok: ok && check.ok,
    mismatch,
    aborted,
    error: mismatch ? (error ?? `expected ${describeExpectation(expectation)} but saw ${check.observed}`) : error,
    slip,
    startedAt,
    durationMs: Date.now() - startedAt,
    progressed: [...diffInventory(before.inventory, after.inventory).values()].some((n) => n > 0),
  };
  deps.logger.debug({ module: 'skill', ...record }, `skill ${skill.name} ${record.ok ? 'ok' : 'failed'}`);
  return record;
}
