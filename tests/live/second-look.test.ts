// The second look before a task is ticked off, asked of the real check model (§13: it is the model's to judge). The
// claims are the runs' own: progress said as done ("on track toward diamonds", "ready for planks"), a bed-less shelter
// for a bed, a task put off as given up, and the true ones beside them. Spends real subscription quota, so it only
// runs with NANOGPT_API_KEY set AND AGORA_LIVE_LLM=1.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, loadEnv, loadModelsConfigForRuns, repoRoot } from '@agora/shared';
import { startLlm } from '@agora/llm';
import { SecondLookSchema, secondLookMessages } from '@agora/agent/mind/learning';

loadEnv();
const key = process.env.NANOGPT_API_KEY?.trim();

describe.skipIf(!key || process.env.AGORA_LIVE_LLM !== '1')('live: the second look at a task said to be done', () => {
  it('tells done from on the way, and given up from put off, as a player would', async () => {
    const logger = createLogger({ name: 'second-look', logDir: path.join(repoRoot(), 'data', 'live-test', 'second-look'), console: false });
    const rt = await startLlm({ apiKey: key ?? '', config: loadModelsConfigForRuns(), logger, background: false, pollUsage: false });
    const carry = (inv: string, ...more: string[]) => [`They carry: ${inv}; wearing no armor.`, 'They are in overworld.', ...more];
    const cases: [string, string, 'done' | 'dropped', string[], boolean][] = [
      ['Obtain 12 diamonds.', '#1: I have the logs needed for tools, on track toward diamonds.', 'done', carry('16 oak_log, 1 wooden_pickaxe'), false],
      ['Obtain 12 diamonds.', '#1: I hold 12 diamonds now', 'done', carry('12 diamond, 1 iron_pickaxe'), true],
      ['Make a bed and sleep in it.', '#6: my sealed tunnel shelter is gone, but a new hole in the cliff serves as a bed-less shelter for this night', 'done', carry('3 white_wool, 4 oak_planks'), false],
      ['Make a house.', '#1: I have at least 20 logs mixed between oak and spruce, ready for planks and the village chest.', 'done', carry('20 oak_log'), false],
      ['Make a house.', '#1: the house stands: walls, a roof and the door I put in', 'done', carry('2 oak_planks', 'Huts of their own with a room inside: 1.'), true],
      ['Catch a fish.', '#1: caught a fish, a cod, and I have it now', 'done', carry('1 cod, 1 fishing_rod'), true],
      ['Form a romantic relationship.', '#2: Bram said yes, we are partners now', 'done', carry('nothing', 'Their partner: Bram.'), true],
      ['Go to the Nether.', '#2: What? Go to the Nether? I am in no state for that, still need iron tools and armor first.', 'dropped', carry('1 stone_pickaxe'), false],
      ['Make a cow farm.', '#4: no cows anywhere in this desert for hundreds of blocks; I give it up', 'dropped', carry('nothing'), true],
    ];
    let right = 0;
    try {
      for (const [task, said, status, facts, want] of cases) {
        const r = await rt.client.call<{ holds: boolean; why: string }>({
          tier: 'L1',
          module: 'cc',
          thought: 'check',
          agent: 'Ada',
          schema: SecondLookSchema,
          schemaName: 'secondLook',
          fallback: () => ({ holds: false, why: 'no answer' }),
          messages: secondLookMessages(task, said, status, facts),
        });
        const got = r.ok ? r.value.holds : null;
        if (got === want) right++;
        process.stdout.write(`SECOND LOOK ${got === want ? 'right' : 'WRONG'}: ${status} "${task}" / "${said}" -> ${String(got)} (${r.ok ? r.value.why : r.reason})\n`);
      }
    } finally {
      rt.stop();
    }
    expect(right).toBeGreaterThanOrEqual(cases.length - 1);
  }, 300_000);
});
