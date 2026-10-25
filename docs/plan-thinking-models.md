# Plan: fixed minds, a token budget, and what still kills the agents

*Prepared 2026-10-25, with the week's quota at 96.1% (it resets 2026-10-26 00:00 UTC). Nothing here spent quota. It rests
on the saved logs of the long runs on 2026-10-25 (eleven of them: solo seed 1 runs 29–31, solo seed 2 runs 22–25, duo
runs 34–37), the subscription's model list and usage (both free reads), the code, and NanoGPT's documentation. The work
starts when the owner says "Continue". The owner's words: "I don't think models should vary. L1, L2, L3 should be chosen
by you. Try to find the most efficient one for each thought category." And: "Maybe using bigger models for the actual
thinking process?"*

---

## 0. In short

1. **The quota ladder shrank the mind, and that explains most of the day's broken replies.** The long runs read the
   quota once, at startup, and keep that level for the whole run. From 85% the ladder moves the mind (the CC) to L1,
   and L1 allows a reply of 200 tokens. A decision with its thought runs 250–450 tokens. Every run started after
   04:20 UTC began at 85% or more, and its mind was cut off mid-reply. The one run before that, `duo (34)`, had no
   broken replies at all (§1.1).
2. **Only 41% of the mind's requests produced a decision that was used.** At least 863 requests went out and 351
   decisions were acted on. A decision acted on cost about 14,500 input tokens, two and a half times one request. One
   decision in six was the code's, not a thought's (§1.2).
3. **Models will be fixed, one per kind of thought**, with a set reasoning effort, reply length and time limit. Each
   gets one named backup, used only when the first is down, never because a reply came back malformed. The ladder may
   make optional thinking rarer. It never changes who thinks or how much they may say (§2, §3).
4. **Bigger models: yes, wherever there is time to think.** The quota counts input tokens, and on this subscription a
   strong model's input counts the same as a weak one's (except for about a dozen models counted double), so the
   strongest model costs no more quota per thought. What it costs is seconds. Fast thought (moment to moment, under
   fire) uses the same strong model with its hidden thinking off and a short answer, not a smaller model (§3.1).
5. **Most of the saving is in waste, not in model choice.** That means fixing broken replies locally, small repair
   requests, no cross-model fallback on a bad reply, and a shorter fixed prompt. The target is at most 5,500 input
   tokens per decision acted on (from about 14,500) and at most 450,000 an agent-hour in all (from about 800,000) (§6).
6. **The choices are confirmed on real packets before any long run**: about 3 million tokens of benchmarks, 5% of the
   week. Long runs follow in three rounds, and no measured run starts above 70% of the week's quota (§5, §8).

---

## 1. What the logs show

### 1.1 The quota ladder shrank the mind

The ladder (§22.4, `packages/llm/src/governor.ts`) decides each call's tier from the week's quota: from 70%, L3 calls
run on L2; from 85%, the CC runs on L1 as well; from 95%, no calls. The long-run test starts the LLM layer with
`pollUsage: false`, so the level found at startup holds for the whole run. Nothing logs it. L1 allows 200 tokens of reply
(`config/models.yaml`). The mind passes its own time limit but not its own reply length, so on L1 it was cut at 200.

| run | started (UTC) | quota then | level | the mind ran on | replies still broken after repair |
|---|---|---|---|---|---|
| duo (34) | 03:43 | 83–84% | 1 | L2 | 0 |
| solo, seed 1 (29); solo, seed 2 (22) | 04:32, 04:37 | 85.5% or more | 2 | L1, 200 tokens | 20; 7 |
| solo, seed 1 (30); solo, seed 2 (23); duo (35) | 04:48–04:49 | 85.5–88.4% | 2 | L1, 200 tokens | 12; 10; 22 |
| solo, seed 1 (31); solo, seed 2 (24); duo (36) | 05:06 | 88.4–91.2% | 2 | L1, 200 tokens | 29; 6; 27 |
| solo, seed 2 (25); duo (37) | 05:39 | 93.4% | 2 | L1, 200 tokens | 14; 18 |
| solo, seed 1 (32) | 05:58 | 96.1% | 3 | no model (code only) | none |

The broken replies end where 200 tokens end. minimax-m3, which shows all it writes, broke its JSON at characters 690–910
(once at 1,280). glm-5.3 broke earlier, at 370–670, because its unseen thinking used part of the 200. Its "{}" in JSON
mode and its 32 empty replies (logged as provider errors) fit the same cap: after thinking, nothing was left to answer
with. The earlier reading in DESIGN.md §24 ("the first model's thinking ran out of tokens, or its JSON mode answered
{}") was right about the symptom and wrong about the cause. Raising L2's reply length to 2,500 could not help a mind that
was running on L1.

Level 1 did its own harm from 22:33 UTC on 2026-10-24. Plans, lessons and reflections ran on L2's chain with L2's 8 s
limit instead of L3's 45 s, and Goal Gen's plans timed out on minimax-m3 and qwen3-coder-next (15 times in these runs).

So for about seven hours of testing the agents did not think with the minds they were configured with. This is the
"models vary" problem the owner named, in its worst form: silent and dependent on the quota.

### 1.2 Most of the mind's requests bought nothing

Across the eleven runs (266 minutes, 6.6 agent-hours):

- **Requests and use.** At least 863 mind requests went out, and 351 decisions came of them (41%). That is about 131
  requests and 53 thought-out decisions per agent-hour.
- **How the waste breaks down.** 165 replies were still invalid after a repair; each cost two requests, the first try and
  the repair. There were 78 timeouts, 32 empty replies, 51 requests aborted when the state moved on, and 54 decisions
  dropped as stale.
- **What made the decisions.** About 110 decisions an agent-hour in all: 53 from the model, 38 from intentions (the
  "then" steps of an earlier thought) and 19 code defaults (17%).
- **Token cost.** A mind request is about 5,700 input tokens: a system prompt of about 3,600, of which the skills
  catalogue is 1,790, and a packet of about 2,100 at the median. So each decision acted on cost about 14,500 input
  tokens, and the mind alone spent about 775,000 an agent-hour. That is a lower bound, and it matches the
  ~800,000 measured over the day.
- **Latency.** The mind took 4–5 s at the median and 10–22 s at the 90th percentile, repairs and fallbacks included.

The code defaults matter beyond their number: "code default: get iron_pickaxe for the goal" is a directive in all but
name, and so was the stroll at 12 health that killed `solo, seed 1 (31)`.

### 1.3 Hidden thinking

`z-ai/glm-5.3` thinks before it answers, and its thinking counts against the reply length. At 900 tokens a tangled
situation came back "{}" three times of three; at 3,000, four of four answered (benched 2026-10-25). At L2 with the
thinking on, it took 10–25 s. It is the model that judged best in every careful test this project ran: the sheep sheared
rather than killed, the flyer asked how, the controller's six cases, four buildings out of four. Its trouble is the
unseen thinking, not its judgment. NanoGPT takes a `reasoning_effort` of `none`, `minimal`, `low`, `medium`, `high`,
`xhigh` or `max`, and `none` turns thinking off "only on models that support turning it off". The mind already thinks in
the open, in its `thought` field, so for the mind the hidden thinking is a second, unseen copy of the same work.

### 1.4 What the quota counts

- NanoGPT: "Input-token quotas count tokens". The weekly allowance is about 60 million input tokens. Output tokens,
  hidden thinking included, cost time but not quota.
- Reported (Standard Compute, checked 2026-10-13): 12 of the 315 subscription models count input twice. GLM 5.2 moved to
  2x on 2026-10-12 and GLM 5.3 counts 1x. No full list is published, so the weights are measured in §5.1.
- Cache markers (`cache_control`) move a request to pay-as-you-go billing. The guard already refuses them (§22), and
  they stay refused. Whether automatic provider caching lowers the count is not documented, so the plan does not count on
  it.
- Only open-weight models are on the subscription. Claude, GPT and Gemini are pay-as-you-go, which the subscription lock
  forbids.
- A request that times out still takes one of the key's 60 requests a minute and probably its input tokens. A timeout
  followed by a fallback is two requests for one thought.

### 1.5 What is not measured

The cost meter (`packages/llm/src/meter.ts`) keeps totals by module, tier, model and agent in memory, and the long runs
throw them away. The quota level at startup is not logged. Failing replies are logged only up to 600 characters, so where
a reply broke can't always be seen. Nothing records why a decision went stale.

---

## 2. How the models are chosen

1. **One model for each kind of thought, named in the config**, with its reasoning effort, reply length and time limit.
   There is no `auto` and no chain of five models.
2. **One named backup for each, for outages only.** The backup is used when the primary's circuit is open, after a
   provider error, or after two timeouts in a row. It is never used because a reply was malformed: a malformed reply is
   repaired (§4.4). Every switch is logged and counted.
3. **The quota changes how often, never who or how much.** Under pressure, optional thinking (reflection, social goals,
   re-planning, the controller) runs less often. The mind, speech, plans and quick checks keep their models and lengths.
   At 95%, everything stops (code only), as now. The same rule holds for the per-agent hourly share.
4. **Efficiency is input tokens per answer that was used**, after weighting each model by how it counts against the
   quota. It is compared only among models that clear a quality floor and a time limit.
5. **Fast and slow thought, as in a person.** Fast thought (what to do next, what to do under fire, a quick check) has no
   hidden thinking and a short answer. Slow thought (plans, lessons, buildings, skills) may think unseen and take its
   time, because nothing waits on it.

---

## 3. The kinds of thought and their models

These are provisional choices from what is measured so far; §5 confirms or replaces each one. A replacement is the
runner-up of the same benchmark, never `auto`. With them, L1 is quick checks, L2 is fast thought and L3 is slow thought,
each fixed.

| Kind of thought | Call sites | Model | Effort | Reply (tokens) | Limit | Backup (outages only) | Benchmarked against |
|---|---|---|---|---|---|---|---|
| **The mind**: what to do next | `cc.ts` | `z-ai/glm-5.3` | none (low if none is refused) | 1,200 | 12 s | `deepseek/deepseek-v4-pro` | kimi-k2.6, qwen3.5-397b-a17b, longcat-2.0, minimax-m3 |
| **Under fire**: a glance and a choice | `cc.ts` in danger | `z-ai/glm-5.3` | none | 600 | 5 s | `deepseek/deepseek-v4-flash` | mimo-v2.6-flash, minimax-m3 |
| **Speech**: a line said | `talking.ts` (the line) | `moonshotai/kimi-k2.6` | (none set) | 300 | 8 s | `minimax/minimax-m3` | glm-5.3 at none |
| **Reading others** | `awareness.ts` (social), `socialGoalGen.ts` | `z-ai/glm-5.3` | none | 800 | 10 s | `deepseek/deepseek-v4-pro` | kimi-k2.6 |
| **Quick checks**: was it kept, was it settled, was it said to me, is it worth remembering, am I stuck | `memory.ts`, `commitments.ts`, `awareness.ts` (promises), `consensus.ts`, `talking.ts` (addressed to me), `selfMonitor.ts` | `deepseek/deepseek-v4-flash` | none | 200 | 4 s | `xiaomi/mimo-v2.6-flash` | qwen3.8-flash, gpt-oss-120b, llama-3.3-70b (today's, which timed out at 7 s) |
| **Plans** | `goalGen.ts` | `z-ai/glm-5.3` | medium | 4,000 | 60 s | `deepseek/deepseek-v4-pro` | kimi-k2.6 |
| **Lessons and reflection** | `learning.ts`, `reflection.ts` (audit, annotation) | `z-ai/glm-5.3` | medium | 2,500 | 60 s | `deepseek/deepseek-v4-pro` | |
| **Buildings** | `architect.ts` | `z-ai/glm-5.3` | medium | 4,000 | 90 s | `deepseek/deepseek-v4-pro` | (2026-10-24: glm-5.3 drew 4 of 4 first time) |
| **Skills** (code) | `skillWriter.ts` | `z-ai/glm-5.3` | high | 4,000 | 90 s | `deepseek/deepseek-v4-pro` | kimi-k2.7-code |
| **The overseer** | hub `controller.ts` | `z-ai/glm-5.3` | medium | 1,500 | 45 s | `moonshotai/kimi-k2.6` | (2026-10-24: glm-5.3 judged 6 of 6) |
| **New people** | hub `personaWriter.ts` | `moonshotai/kimi-k2.6` | (none set) | 1,500 | 45 s | `z-ai/glm-5.3` | |

Why these:

- **The mind on glm-5.3 with thinking off.** It judged best in every careful test, it counts 1x, and its failures were
  the reply length and unseen thinking, both of which go away with effort none. If NanoGPT refuses `none` for it and its
  90th percentile at `low` passes 10 s, the mind goes to deepseek-v4-pro, which does not think unseen (2.9 s median in the
  2026-10-23 bench), and its fast thought goes to deepseek-v4-flash.
- **Under fire, the same mind.** A person's mind under fire is their own mind, quicker. The short format and a short
  reply make it fast; a smaller model would make it a different person. The backup is a fast model for when glm-5.3 is
  slow or down.
- **Speech on kimi-k2.6.** In the 2026-10-25 test it wrote only the line, in a player's way, in 1.7–2.6 s. glm-5.1 wrote
  out its working before the line. Speech is the agents' voice, so it stays one model.
- **Quick checks on a fast small model.** These are yes/no and a few words. Today's llama-3.3-70b and gemma-4-12b timed
  out at 7 s (25 times in these runs). deepseek-v4-flash and mimo-v2.6-flash have not been timed yet, so the benchmark
  picks between them.
- **Slow thought on glm-5.3 with thinking on.** Plans, lessons, buildings, skills and the overseer have time, and quality
  there pays for itself across hours of play.

### 3.1 Bigger models

They help where there is time to think, and that is most kinds of thought. Since input tokens count the same for a large
and a small model (bar the double-counted dozen), the strongest model costs no more quota per thought. It costs seconds,
and the runs say seconds hurt less than broken replies: the median decision took 4–5 s, while 59% of requests were
wasted. So each kind of thought gets the strongest model that answers well within its limit. For fast thought that means
the same strong model with no hidden thinking. The strongest models on the subscription, by the listed price the code
uses as a proxy for size, are deepseek-v4-pro, glm-5.1, longcat-2.0, glm-5.3, qwen3.5-397b-a17b and kimi-k2.6. All of
them are in the benchmarks.

A bigger model will not fix what the agent is not told or cannot do: a stalagmite under a block, a roof with no way down,
a reply cut at 200 tokens. Those stay with the senses, the hands and the client (§4, §7).

---

## 4. Changes that need no quota (first, once the owner says "Continue")

**4.1 Fixed thoughts in the config.** Add a `thoughts:` section to `config/models.yaml`, with model, backup, effort, reply
length and limit for each kind in §3. It replaces the `prefer` lists and the `auto` tiers for the agents, and is checked
against the subscription list at startup: a model that is not on the list stops startup with a clear message rather than
being skipped silently. Each call names its kind of thought (`cc` under fire is its own kind). `auto` stays for an
unconfigured install.
Files: `packages/shared` (schema), `packages/llm/src/client.ts`, `router.ts`, the call sites in §3.

**4.2 The ladder slows, never shrinks.** `ladder()` and `agentDegrade()` no longer change a thought's tier or model.
Level 1 runs optional thought half as often; level 2 turns optional thought off; level 3 is code only, unchanged.
Files: `governor.ts`, with its unit tests rewritten to say so.

**4.3 Long runs know their quota and keep their costs.**
- The long run polls the quota and logs its level at startup and at every change.
- A measured run will not start at 70% or more unless it is started with `AGORA_LONGRUN_ALLOW_DEGRADED=1`.
- Every call's cost record goes to `<run>-calls.jsonl`: thought, model, input and output tokens, ms, ok, failure kind,
  cut off, stale and why. Totals by thought and model go into the run's JSON report.
- Failing replies are kept whole in the packets file rather than cut at 600 characters.

No key and no prompt text are written to any of these. Files: `tests/live/longrun.test.ts`, `packages/llm/src/start.ts`,
`meter.ts`.

**4.4 Fewer wasted requests.**
1. **Local repair first.** Before a model is asked again, a local repair closes a reply cut off mid-string, adds missing
   commas, drops trailing ones and escapes stray quotes (`escapeStrays` exists). The result is accepted only if it
   passes the schema.
2. **A cut-off reply is not sent back.** When a reply stops at its length, it is logged as cut off rather than sent for
   repair under the same limit, because the cure is the length.
3. **Small repair requests.** A model repair sends the bad reply, the error and the schema, about 1,000 tokens, not the
   system prompt and packet again (about 6,000).
4. **The same model.** No other model is tried on a bad reply (§2.2).
5. **Not sent if already stale.** A thought that went stale while waiting for its rate token is not sent.
6. **Why it went stale.** The guard logs which change made a thought stale, so that only changes that matter (danger,
   being spoken to, the target gone) drop one, and the rest go into the next thought as "meanwhile: …".

**4.5 Reasoning effort per thought.** `reasoning_effort` is a model setting, not a provider, billing or cache option, so
the subscription lock allows it. The guard's tests add it as allowed, and the forbidden list stays as it is.

**4.6 A shorter fixed prompt.** The skills catalogue drops from about 1,790 tokens to about 700, one line a skill; the
reply format drops from about 880 to about 450. Both are measured with the sizes script. The target is 4,500 input tokens
or fewer per mind request, from about 5,700. The prompt's fixed part stays first and the same for every call by one
agent, which lets providers that cache prefixes answer faster even if the quota counts it all.

**4.7 The benchmark harness.** `scripts/bench-thoughts.ts` runs the cases in `bench/thoughts/*.jsonl` (§5.2) against
named models through the real client, and writes a table: valid, cut off, latency at the median and 90th percentile,
rubric score, input tokens, weight. The rubric is only for choosing models; nothing of it reaches an agent's prompt. The
scoring gets unit tests.

**4.8 The behaviour items in §7** that need only the hands tests, which run without the model.

---

## 5. Benchmarks after the reset

### 5.1 How each model counts against the quota

For each shortlisted model: one request of about 2,000 input tokens, asking for at most 1 token, reading `used` before and
after (polled until it moves, up to 60 s). The weight is the change in `used` over the request's `prompt_tokens`. A model
counted double is dropped unless it is far better. This costs about 30,000 tokens.

### 5.2 Golden sets from real packets

Cases are taken from the saved packets of runs 22–37, chosen to cover what has killed or stalled the agents. Each case
has the options and skills a sensible player might choose, the ones that are plainly wrong, and what the thought should
notice.

- **The mind** (30 cases):
  - dusk out in the open far from home, with no hut;
  - 8 health with zombies near and cooked food carried;
  - hungry with raw meat and fuel;
  - nine iron ingots and no armor;
  - a dripstone cave;
  - lava in sight;
  - the partner asking something;
  - a plan step just done;
  - the same failure three times;
  - full pockets;
  - stuck in a pond's notch;
  - on a roof;
  - getting ready for the Nether;
  - the house short of materials.
- **Under fire** (12 cases): three zombies and a skeleton at 8 health; a creeper close; an archer out of reach; cornered
  in a tunnel; in water with a drowned; lava at the feet.
- **Quick checks** (8 for each of the six kinds).
- **Speech** (12 lines): an answer, a request, a refusal, small talk, an agreement.
- **Slow thought** (12 cases): a plan from seven tasks, a lesson from a death, a reflection, a building, a skill, two
  controller cases.

### 5.3 What is measured and how a model is picked

For each model and kind of thought:
- the share of valid replies, before and after the local repair;
- the share cut off;
- latency at the median and 90th percentile;
- the rubric score, and any plainly wrong choice;
- input tokens times the quota weight, per answer used.

A model qualifies when, after the local repair, at least 95% of its replies are valid, none are cut off, and its 90th
percentile is within the limit for that kind:

| Kind of thought | 90th-percentile limit |
|---|---|
| The mind | 10 s |
| Under fire | 4 s |
| Speech | 3 s to the first words, 8 s in all |
| Quick checks | 3 s |
| Plans and lessons | 60 s |
| Buildings and skills | 90 s |

Among the models that qualify, the highest rubric score wins. Within 5 points, the one with fewer weighted input tokens
per answer used wins; after that, the faster. For the mind, the best two get a second pass of two more tries a case. For
the top two, the thoughts are read as well as scored. The pick goes into `config/models.yaml` with its numbers in the
comment, as the existing comments do, and the table goes into DESIGN.md §24.

### 5.4 Cost

| Benchmark | Calls | Input tokens |
|---|---|---|
| Quota weights | 15 | 30,000 |
| The mind, first pass (7 setups × 30) | 210 | 950,000 |
| The mind, second pass (2 × 30 × 2) | 120 | 540,000 |
| Under fire (5 × 12 × 2) | 120 | 520,000 |
| Quick checks (5 × 48 × 2) | 480 | 400,000 |
| Speech (3 × 12 × 2) | 72 | 150,000 |
| Slow thought (3 × 12) | 36 | 300,000 |
| **All** | **about 1,050** | **about 2.9 million (5% of the week)** |

---

## 6. The token budget

| | Now (runs 22–37) | Target |
|---|---|---|
| Input tokens per mind request | about 5,700 | 4,500 or fewer |
| Mind requests whose decision was used | 41% | 85% or more |
| Input tokens per decision acted on | about 14,500 | 5,500 or fewer |
| Decisions that are code defaults | 17% | 5% or fewer |
| Input tokens per agent-hour, all thoughts | about 800,000 | 450,000 or fewer |

The week, at 60 million input tokens:

| Use | Input tokens | Share | Running total |
|---|---|---|---|
| Benchmarks (§5) | 2.9 million | 5% | 5% |
| Round 1: three one-hour runs (solo seed 1, solo seed 2, the duo: 4 agent-hours) | 1.8 million | 3% | 8% |
| Rounds 2–4: three four-hour runs each (16 agent-hours a round) | 21.6 million | 36% | 44% |
| Benchmarks again after prompt changes | 2 million | 3% | 47% |
| Kept in reserve: the owner's own use, surprises | | | to 70% |

No measured run starts above 70%, the point where the ladder's level 1 begins. If the burn stays at today's 800,000 an
agent-hour, only two four-hour rounds fit.

---

## 7. What still kills the agents, answered in the general mind and hands

Each of these gets a sense or a hand, never a rule for the case. That is the owner's rule: "YOU CANNOT fix anything by
directly coding the agent to do certain goals."

1. **Code defaults** steering a hurt, unfed agent, which caused 17% of decisions and the stroll at 12 health. With the
   mind answering, defaults become rare. When it doesn't answer, the default carries on with the last thought-out course
   (its intentions) and the mind is asked again within seconds. The code no longer picks a goal step. Defaults keep only
   what the body does by itself: the reflexes.
2. **Hurt among mobs** (the owner's example: run, dig into a wall, dig up; better, carry cooked food and eat). The senses
   say what a player sees:
   - which ways are open and how far one could run;
   - a wall at hand to dig into;
   - how far up the sky is;
   - what the food on hand does for healing, and how fast.

   Nothing says "run" or "dig". The food knowledge and the "could make" line (cooked food from raw meat and fuel) are
   already in.
3. **A fight given up for a run where there is no room to run.** The same senses tell it: "no way out east or south; a
   wall 1 m west".
4. **Down off a built roof.**
   - The hands may drop as far as the body can take, felt from its health: a fall costs a heart for every two blocks
     past three, and the drop is kept within a third of the health on hand.
   - The hands may take down their own scaffold, the blocks placed to climb, which belong to nothing built.

   A hands test on a plank roof checks it.
5. **Slow fast thought.** Under fire it is the fast setup of §3, with its 90th percentile at 4 s or less.
6. **Thoughts dropped as stale**, about 7% of decisions: only changes that matter drop a thought (§4.4).

How each is judged in the runs:
- whether the agents carry cooked food;
- what they do at low health with mobs near;
- how they come down from what they build;
- how many decisions are the code's.

---

## 8. Long runs after the benchmarks

- **Round 1** (one hour each, the three at once, about 9 requests a minute against the key's 60). This checks that the
  fixed minds hold live:
  - at least 85% of requests used, and at most 5% code defaults;
  - nothing cut off;
  - latency within the limits;
  - at most 450,000 tokens an agent-hour.

  If any of these fails, back to §4 and §5.
- **Rounds 2–4** (four hours each: solo seed 1, solo seed 2, the duo). Each run is read as a player would read it:
  deaths and their causes, stalls, food carried, nights lived through, the time to each of the test's conditions. What is
  found is answered as in §7 and checked with the hands tests before the next round.
- **What is reported for each run:**
  - the conditions met and when;
  - tokens by thought and model, from the cost log;
  - the share of decisions by the model, by intentions and by the code;
  - the quota level throughout.

---

## 9. Order of work

1. §4.1–4.6 with unit tests, and lint and typecheck passing. No quota.
2. §4.7 and the golden sets. No quota.
3. §4.8 and the hands tests for §7. No quota.
4. After the reset: §5.1, then §5.2–5.4, then the models in the config with their numbers. About 3 million tokens.
5. Round 1, then rounds 2–4, with DESIGN.md §24 kept current after each.

Done means: each kind of thought on one named model chosen by measurement; no run degraded by the quota without saying
so; the targets of §6 met in round 1; and the test conditions of both variations worked towards by agents that think
rather than follow directives.

---

## 10. Sources

- NanoGPT, *Chat completion* (`reasoning_effort` and its levels, `none` only where a model supports it; `response_format`
  json_schema): https://docs.nano-gpt.com/api-reference/endpoint/chat-completion.md
- NanoGPT, *Subscription usage* ("Input-token quotas count tokens"; fields `used`, `remaining`, `percentUsed`,
  `resetAt`): https://docs.nano-gpt.com/api-reference/endpoint/subscription-usage.md
- Standard Compute, *NanoGPT pricing guide*, facts checked 2026-10-13 (60 million input tokens a week; 12 of 315 models
  counting input twice; GLM 5.2 at 2x and GLM 5.3 at 1x from 2026-10-12; cache markers moving a request to
  pay-as-you-go): https://standardcompute.com/nanogpt-pricing
- The subscription's own model list (`GET /api/subscription/v1/models?detailed=true`, read 2026-10-25: 327 models, 312
  of them chat).
- This repository: `packages/llm/src/governor.ts` (the ladder), `client.ts` (attempts and repairs),
  `tests/live/longrun.test.ts` (`pollUsage: false`), `config/models.yaml`, and the saved run logs of 2026-10-25.
