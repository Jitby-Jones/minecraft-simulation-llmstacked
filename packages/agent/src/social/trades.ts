// Trades and help (§6.6, §6.7; v0.2: chat plus physical delivery, nothing over the Hub). An offer is made in
// conversation ("3 bread for 8 logs?") and answered with accept, counter or decline, each a CC decision; the code
// default prices by liking (§6.3: friends get a better deal). An accepted deal is two commitments, one each way,
// carried out by tossing the items over and checked like any other promise: whoever doesn't deliver by the deadline
// broke it. A request for help ("can you help me gather wood?") becomes the help option: work near them, then hand
// over what was gathered.

import type { AgentName, ItemStack, Logger, Quirk, Utterance } from '@agora/shared';
import type { AgentBus } from '../bus';
import { normalizeItemName } from '../body/items';
import { tradeMultiplier } from '../body/quirks';
import type { AgentStateStore } from '../state/store';
import { pushWorkmem } from '../state/workmem';

export interface Offer {
  /** What the speaker gives. */
  give: ItemStack[];
  /** What the speaker wants in return. */
  want: ItemStack[];
}

const TWO_WORDS =
  /\b(iron|gold|copper|oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove|cooked|raw|stone|wooden|diamond|golden)\s+(ingots?|logs?|planks?|beef|porkchops?|chicken|mutton|cod|salmon|iron|gold|copper|pickaxes?|swords?|axes?|shovels?|hoes?|nuggets?)\b/gi;
const N = '(\\d{1,3})';
const ITEM = '([a-z][a-z_]{1,30})';
const OFFER_FORMS: readonly { re: RegExp; giveFirst: boolean }[] = [
  // "I'll give you 3 bread for 8 logs", "trade you my 3 bread for your 8 logs", "swap 3 bread for 8 logs"
  { re: new RegExp(`\\b(?:give|trade|swap|exchange|pay)\\s+(?:you\\s+)?(?:my\\s+)?${N}\\s+${ITEM}\\s+(?:for|if you give me)\\s+(?:your\\s+)?${N}\\s+${ITEM}`, 'i'), giveFirst: true },
  // "give me 8 logs and I'll give you 3 bread", "give me 8 logs for 3 bread"
  { re: new RegExp(`\\bgive\\s+me\\s+${N}\\s+${ITEM}\\s+(?:and\\s+i'?ll\\s+give\\s+you|for)\\s+(?:my\\s+)?${N}\\s+${ITEM}`, 'i'), giveFirst: false },
  // "3 bread for 8 logs?" said as an offer
  { re: new RegExp(`(?:^|[,.!?:]\\s*|\\btrade\\??\\s+)${N}\\s+${ITEM}\\s+for\\s+${N}\\s+${ITEM}`, 'i'), giveFirst: true },
];

/** "3 bread for 8 logs?" → the speaker gives 3 bread and wants 8 logs. Needs numbers; vaguer offers are for the model. */
export function parseTradeOffer(text: string): Offer | null {
  const t = text.replace(TWO_WORDS, (_m, a: string, b: string) => `${a}_${b}`);
  for (const { re, giveFirst } of OFFER_FORMS) {
    const m = re.exec(t);
    if (!m?.[1] || !m[2] || !m[3] || !m[4]) continue;
    const a: ItemStack = { item: normalizeItemName(m[2]), qty: Number(m[1]) };
    const b: ItemStack = { item: normalizeItemName(m[4]), qty: Number(m[3]) };
    if (a.qty < 1 || b.qty < 1 || a.item === b.item) continue;
    return giveFirst ? { give: [a], want: [b] } : { give: [b], want: [a] };
  }
  return null;
}

const HELP_WORDS: Readonly<Record<string, string>> = {
  wood: 'log',
  tree: 'log',
  trees: 'log',
  log: 'log',
  logs: 'log',
  stone: 'cobblestone',
  rock: 'cobblestone',
  rocks: 'cobblestone',
  cobble: 'cobblestone',
  iron: 'raw_iron',
  coal: 'coal',
  dirt: 'dirt',
  sand: 'sand',
};

/** "can you help me gather wood?", "help me mine 16 stone" → what to gather and how much (default 8). */
export function parseHelpRequest(text: string): { item: string; qty: number } | null {
  const m =
    /\bhelp\s+(?:me\s+)?(?:to\s+)?(?:gather(?:ing)?|get(?:ting)?|chop(?:ping)?|cut(?:ting)?|min(?:e|ing)|collect(?:ing)?|dig(?:ging)?|find(?:ing)?)\s+(?:some\s+|a\s+few\s+|a\s+bit\s+of\s+)?(\d{1,3})?\s*([a-z_]{2,24})/i.exec(text);
  if (!m?.[2]) return null;
  const word = m[2].toLowerCase();
  const item = HELP_WORDS[word] ?? normalizeItemName(word);
  return { item, qty: m[1] ? Math.min(64, Number(m[1])) : 8 };
}

/** Rough worth in logs, for the code default's prices. Unknown things count as one log each. */
export const ITEM_VALUE: Readonly<Record<string, number>> = {
  log: 1, planks: 0.25, stick: 0.12, crafting_table: 1, chest: 2, cobblestone: 0.25, stone: 0.3, dirt: 0.05, sand: 0.1,
  gravel: 0.1, glass: 0.5, coal: 1, charcoal: 1, torch: 0.3, raw_iron: 3, iron_ingot: 4, raw_gold: 4, gold_ingot: 5,
  raw_copper: 1, copper_ingot: 1.5, redstone: 1, lapis_lazuli: 1.5, diamond: 25, emerald: 10, bread: 1.5, apple: 1,
  wheat: 0.5, carrot: 0.5, potato: 0.5, beef: 1, cooked_beef: 2, porkchop: 1, cooked_porkchop: 2, chicken: 0.8,
  cooked_chicken: 1.6, mutton: 0.8, cooked_mutton: 1.6, cod: 0.6, cooked_cod: 1.2, salmon: 0.7, cooked_salmon: 1.4,
  wool: 1, string: 0.5, leather: 1, feather: 0.3, flint: 0.3, bone: 0.3, gunpowder: 1, egg: 0.3, wooden_pickaxe: 1.5,
  stone_pickaxe: 2, iron_pickaxe: 13, diamond_pickaxe: 76, wooden_sword: 1, stone_sword: 1.5, iron_sword: 9, bucket: 12,
  furnace: 2.5, bed: 4, shield: 6, bow: 2, arrow: 0.3,
};

function unitValue(item: string): number {
  const n = normalizeItemName(item);
  const v = ITEM_VALUE[n];
  if (v !== undefined) return v;
  if (/_(log|stem|wood)$/.test(n)) return ITEM_VALUE.log ?? 1;
  if (n.endsWith('_planks')) return ITEM_VALUE.planks ?? 0.25;
  if (n.endsWith('_wool')) return ITEM_VALUE.wool ?? 1;
  if (n.endsWith('_bed')) return ITEM_VALUE.bed ?? 4;
  return 1;
}

/** What a stack is worth to us; `quirks` (tradeBias) make some things dearer to part with. */
export function valueOf(stack: ItemStack, quirks: readonly Quirk[] = []): number {
  return unitValue(stack.item) * stack.qty * tradeMultiplier(quirks, normalizeItemName(stack.item));
}

/** §6.3 prices in trades: at the willing-to-trade line (6) a fair price; friends pay up to 30 % less. */
export function priceFactor(sentiment: number): number {
  return Math.min(1.4, Math.max(0.7, 1 + (6 - sentiment) * 0.08));
}

/** §6.3: willingness to trade starts at this liking. */
export const TRADE_SENTIMENT = 6;

export type Verdict = { kind: 'accept' } | { kind: 'counter'; offer: Offer } | { kind: 'decline'; why: string };

export interface JudgeContext {
  sentiment: number;
  trust: number;
  have: (item: string) => number;
  quirks?: readonly Quirk[];
}

/**
 * The code default's answer to an offer made to us (`offer` is from their side). Accept when we have what they want
 * and what they give is worth at least our price; counter with less of ours when it's close; decline otherwise.
 */
export function judgeOffer(offer: Offer, c: JudgeContext): Verdict {
  if (c.sentiment < TRADE_SENTIMENT) return { kind: 'decline', why: "you don't feel like trading with them" };
  if (c.trust < 0.3) return { kind: 'decline', why: "you don't trust them to hold up their end" };
  const missing = offer.want.find((w) => c.have(w.item) < w.qty);
  if (missing) return { kind: 'decline', why: `you don't have ${missing.qty} ${missing.item}` };
  const theirs = offer.give.reduce((a, g) => a + valueOf(g), 0);
  const ours = offer.want.reduce((a, w) => a + valueOf(w, c.quirks), 0) * priceFactor(c.sentiment);
  if (theirs >= ours) return { kind: 'accept' };
  const only = offer.want.length === 1 ? offer.want[0] : undefined;
  if (only && theirs >= ours * 0.5) {
    const qty = Math.floor((only.qty * theirs) / ours);
    if (qty >= 1) return { kind: 'counter', offer: { give: offer.give, want: [{ item: only.item, qty }] } };
  }
  return { kind: 'decline', why: "that's not a fair trade" };
}

export const ACCEPT_RE = /\b(deal|sure|ok|okay|yes|yeah|yep|alright|agreed|sounds good|you got it|fine by me|done)\b/i;
export const REFUSE_RE = /\b(no|nah|nope|not|don'?t|won'?t|can'?t|sorry|pass)\b/i;

/** Items nobody counts with a plural: "2 bread", "8 cobblestone". */
const MASS_NOUN = /^(bread|glass|sand|red_sand|gravel|dirt|cobblestone|stone|wheat|sugar|redstone|clay|snow|flint|leather|string|gunpowder|ice|obsidian|netherrack|wool|bone_meal|lapis_lazuli|sugar_cane|kelp|bamboo)$/;

/** "8 logs", "2 bread". */
export function amountOf(item: string, qty: number): string {
  return `${qty} ${item}${qty > 1 && !item.endsWith('s') && !MASS_NOUN.test(item) ? 's' : ''}`;
}

export const stacksText = (xs: readonly ItemStack[]): string => xs.map((x) => amountOf(x.item, x.qty)).join(' and ');

interface Pending {
  with: AgentName;
  /** Ours. */
  give: ItemStack[];
  /** Theirs. */
  want: ItemStack[];
  at: number;
}

export interface TradeTrackerOptions {
  store: AgentStateStore;
  bus: AgentBus;
  logger: Logger;
  me: AgentName;
  /** Records the deal: both halves become commitments (the CC's apply path). */
  onDeal: (withWhom: AgentName, ours: ItemStack[], theirs: ItemStack[]) => void;
  now?: () => number;
}

const PENDING_MS = 90_000;

/** Offers we made (or counters), waiting for an answer: a plain "deal!" from them closes it. */
export class TradeTracker {
  private readonly pending = new Map<AgentName, Pending>();
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: TradeTrackerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.offs.push(
      this.o.bus.on('decision', (e) => {
        const t = e.decision.trade;
        if (!t || (t.phase !== 'offer' && t.phase !== 'counter')) return;
        this.pending.set(t.with, { with: t.with, give: t.give, want: t.want, at: this.now() });
        pushWorkmem(this.o.store, `I offered ${t.with} ${stacksText(t.give)} for ${stacksText(t.want)}`, 0.5, 'self_observed', { aboutAgent: t.with, now: this.now() });
      }),
    );
    this.offs.push(this.o.bus.on('addressed', (e) => this.onReply(e.utterance)));
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  waitingOn(name: AgentName): boolean {
    const p = this.pending.get(name);
    return Boolean(p && this.now() - p.at < PENDING_MS);
  }

  private onReply(u: Utterance): void {
    const p = this.pending.get(u.from);
    if (!p) return;
    if (this.now() - p.at > PENDING_MS) {
      this.pending.delete(u.from);
      return;
    }
    // A counter is a new offer: the CC answers it.
    if (parseTradeOffer(u.text)) {
      this.pending.delete(u.from);
      return;
    }
    if (ACCEPT_RE.test(u.text) && !REFUSE_RE.test(u.text)) {
      this.pending.delete(u.from);
      this.o.onDeal(u.from, p.give, p.want);
      this.o.logger.info({ module: 'trades', with: u.from, ours: p.give, theirs: p.want }, 'deal');
      this.o.bus.emit({ type: 'needsDecision', reason: 'deal', from: u.from });
      return;
    }
    if (REFUSE_RE.test(u.text)) {
      this.pending.delete(u.from);
      pushWorkmem(this.o.store, `${u.from} turned down my offer`, 0.4, 'self_observed', { aboutAgent: u.from, now: this.now() });
    }
  }
}
