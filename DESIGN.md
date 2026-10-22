# Design Doc: Layered, Social, Autonomous Minecraft Agents

> **Audience:** the implementing Claude session (and the project owner).
> **Status:** v0.7 design, implementation in progress (see *Implementation status* below). Written 2026-10-21.
> **Read this whole file before writing code.** §13 lists rules for the implementer.
>
> **v0.2 changes (owner decisions):**
> - Bots communicate **only through Minecraft chat**, made proximity-based by a server plugin (§6.1, §15). The Hub no longer relays speech or actions.
> - **Humans and AIs can't be told apart:** no `isHuman` field, and every interaction works for a human with a vanilla client.
> - Versions: Minecraft **26.1.x** on Paper, mineflayer **4.39.x** (§15).
> - **Bot count is a config number** (§16).
> - **API key** goes in `.env` (§5).
> - **Permadeath:** hard difficulty for testing, hardcore for live use. A dead agent is replaced by a new one (§16).
>
> Where §16 conflicts with an earlier section, §16 wins.
>
> **v0.3:** adds §17 (conflict: personality clashes, grievances, motive vs. fear, fights with surrender, coercion, rulers, coalitions and overthrows).
>
> **v0.4:** adds §18 (emotions, cognitive biases, conformity amplified by fear, mobs, impulse vs. rational override, reflection as debiasing) and §19 (sex 50/50 without stereotyping, PG romance, consent-gated reproduction with trait inheritance, families, population config). §19.7 `population` replaces `agents.count`.
>
> **v0.5:** adds §19.10 (varied reactions to advances and rejection, including disgust, jealousy and rare rage attacks, with a soft persistence cap), §20 (small average sex differences in personality, configurable, large overlap; no effect on skills or roles), and §21 (intelligence and combat stats: intelligence drives CC model tier, memory capacity, planning, errors and knowledge; combat drives technique, and dampens fear so fighting stays tactical).
>
> **v0.6:** adds §22, a five-layer lock to NanoGPT subscription-included models: a Subscription-only key verified at startup, subscription endpoints with bypass options stripped, a live model allowlist with hot-swapping, a token-quota governor with code-only fallback, and local embeddings. §5 is updated to match. USD budgets are replaced by quota budgets, and explicit prompt-cache controls are banned.
>
> **v0.7:** adds §23 (portability and running headless over SSH: pinned, hash-verified setup; one `DATA_DIR`; Node-only scripts; native or Docker run modes; localhost binding plus SSH tunnel; graceful resume; export/import between machines; resource sizing).

---

## Implementation status (kept current by the implementing session, §13 rule 7)

| Milestone | Status | Verified by |
|---|---|---|
| **M0** scaffold, schemas, setup/doctor/server-mode, bot joins | **done** | `pnpm run check` (typecheck, lint, §22.2 forbidden-strings, unit tests) + `pnpm test:live` M0 exit test on real Paper 26.1.2 |
| **M1** body: 21 verified skills with postconditions, L0 reflexes | **done** | `pnpm run check` + `pnpm test:live` on Paper 26.1.2: `m1-skills` (17/17, with the closed-window check added in M6b) and the exit test `m1-night` (a scripted bot survives a night on hard; 4/4 consecutive runs) |
| **M2** LLM client with the §22 subscription lock; Agent State with versioning and abort-on-stale | **done** (live NanoGPT smoke test pending a key) | `pnpm run check`: the client against a mocked NanoGPT (§22.8 unit list, abort-on-stale), allowlist/tier resolution checked against the live 331-model subscription list; `tests/live/m2-nanogpt.test.ts` runs with `NANOGPT_API_KEY` + `AGORA_LIVE_LLM=1` |
| **M3/M3b** single-agent PIANO (CC + bottleneck, option–action, executor, Action Awareness, Self-Monitor, Talking) and intelligence levers | **done** (chat with a real model pending a key) | `pnpm run check` (module tests against fakes and the mocked NanoGPT) + `pnpm test:live` exit test `m3-agent` on Paper 26.1.2: a code-only bot gets stone tools from nothing on its own; a bot driven through the full LLM path by a scripted model works through "get X first" steps, declines a spoken request, and never promises (the script tries to) |
| **M4** memory (Summarize-and-Forget over SQLite + local embeddings), Goal Gen, personas with quirks | **done** (goal choice by a real model pending a key) | `pnpm run check` + `pnpm test:live` exit test `m4-agent` on Paper 26.1.2: a code-only bot runs its own goal chain (wooden pickaxe → stone tools → furnace → iron pickaxe, the iron hidden in the ground and found by digging) with its quirks visible (picks poppies, hums for company); a told fact drops out of working memory into SQLite and is repeated with attribution, in a later conversation, through the real local embedder; hidden ore isn't a target until seen |
| **M5** Hub (rate tokens, budgets, shared embedder, speech guard), supervisor, proximity-chat conversations among several agents, graceful shutdown and resume | **done** | `pnpm run check` (Hub protocol over a real socket, supervisor with stand-in bots, floor control, snapshots, persona calibration) + `pnpm test:live` exit test `m5-population`: real bot processes join through the Hub, shut down gracefully and resume as the same agents; two agents meet and talk until their conversation ends by itself, with nothing looping afterwards; scenario C with four people. `pnpm start` run twice on a fresh normal world: two agents, a death (lava) archived and replaced, resume after Ctrl+C |
| **M6** Social Awareness, commitments, trades, the help option, claims; deaths matter to the living | **done** | `pnpm run check` (social updates with and without a model, commitments, trades, help, deeds, rumors, deaths) + `pnpm test:live` exit test `m6-social` on Paper 26.1.2, 8/8: **A** a scripted-model Bram asks code-only Pip for 8 logs; she promises, gathers and hands them over, both sides record the promise as kept, and Bram's sentiment goes 5.6 → 8.1 (trust 0.6); **B** a promise past its deadline drops trust to 0.3 and comes up when Bram talks later; **D** a false diamond claim is checked and the teller's trust drops; **E** a zombie ends a conversation cleanly, with a canned line, and talk resumes; **G** a plain client gets bread through the same code paths; **T** an offer made in chat is accepted and both halves are handed over; **K** help gathering wood ends with the logs handed over; **H** a killed agent is replaced in 6 s and the survivors grow more cautious |
| **M6a** emotions and biases core: feelings, impulses, first impressions, gut against facts, conformity, mobs | **done** | `pnpm run check` (appraisal, decay and contagion; gossip read in code; impulses and regret; first impressions fading into the facts for the rational; conformity, confirmation, availability, scapegoat; mobs) + `pnpm test:live` exit test `m6a-minds` on Paper 26.1.2, 3/3: **Q** an insulted hothead shouts back within 0.5 s while a stoic answers calmly; **M** diamond armor impresses a vain agent at first sight (7.0 vs 5.4 for leather) and a rational one hardly at all; **N** three people turn on Rex: an impulsive conformist joins in and a rational onlooker who knows him speaks up |
| **M6b** conflict core: grievances, power and fear, the escalation ladder (rungs 0–3), the code gate, brawls that end in a yield | **done** (the lethal rung waits for M8b) | `pnpm run check` (pressure from grievances and fear, rungs with hysteresis and pacing, the gate in the CC, yields heard and reckoned beatings, fight slots, staying within reach) + `pnpm test:live` exit test `m6b-conflict` on Paper 26.1.2, 3/3, and again in the full regression: **I** two quarrelsome brutes with a seeded grudge share a grove: hostile talk at rung 1, threats at rung 2, then one brawl at rung 3 that ends when one gives up ("ok ok, I yield!" at about 5 HP, or running off); nobody dies, and the loser fears the winner more |
| **M7** dashboard (per-agent state, decisions with their reasons, conversations, the social graph, tokens per hour), `pnpm ctl`/`logs`/`export`/`import`, Docker and systemd | **done** | `pnpm run check` (the dashboard model and server: host check, CSP, token, body limits; ctl commands and refusals; telemetry; logs merging; export/import round trip; the unit and Docker files) + `pnpm test:live` exit test `m7-dashboard` on Paper 26.1.2, 1/1 (twice): two code-only agents run under the supervisor; through the dashboard's API, each agent's decisions come with their reasons and what came of them, and who thinks what of whom; `ctl` works with the token only (status, say, save, population); a hot export after `ctl save` restores both agents with their snapshots. The page rendered in Chromium, light and dark, with no console errors |

Deviations and implementation findings are logged in **§24** at the end of this file.

---

## 0. TL;DR

- Each bot is **one agent made of concurrent modules** that share an **Agent State** (a blackboard). This follows Project Sid's PIANO architecture.
- One **Cognitive Controller (CC)** makes all high-level decisions. It sees only a deliberately narrow summary of the state (the "bottleneck"). Its decision goes to every output module, so **what the bot says always matches what it does.**
- Module types:
  - **Non-LLM:** reflexes, perception, skill execution, termination checks, forgetting.
  - **LLM, tiered by model size:** small for talking and quick replies, mid for the CC and social reasoning, large for goals, reflection and writing new skills. All calls go through NanoGPT's OpenAI-compatible API.
- **Bots interact through the game world**, not by sharing a brain. This mirrors Lyfe Agents and Project Sid:
  - They hear only speech within a set radius.
  - They see others' actions.
  - They keep a per-person **social model** (sentiment from 0 to 10, inferred goals and role, trust).
  - Agreements made in conversation become **commitments** that turn into real tasks and get checked against what actually happens.
- All speech is **Minecraft chat**, limited to nearby players by the ProximityChat! plugin. Bots perceive everything through their own mineflayer client, exactly as a player's client would.
- A small **Hub** process supervises the bots (keeping N alive, replacing the dead), runs the shared LLM rate limiter and budget, and serves the logs and dashboard. The Hub is **not** a shared mind. It never passes information between bots.

---

## 1. Research basis (what we borrow and why)

### 1.1 Project Sid / PIANO (Altera, arXiv 2411.00114)
- **Concurrency.** About 10 modules run in parallel at different speeds. Each is a *stateless function that reads and writes a shared Agent State*. Slow thinking such as reflection and planning must never block fast reactions to threats.
- **Cognitive Controller with an information bottleneck.** The CC is the only module that makes deliberate high-level decisions. Designers control what reaches it; for example, forcing social information through the bottleneck made agents more sociable. Its decisions are broadcast and *strongly condition the talking module*, which fixes the "says yes, does something else" failure.
- **Named modules:** Memory (working, short-term, long-term), Action Awareness (expected vs. observed outcome), Goal Generation, Social Awareness, Talking, Skill Execution. Social modules are switched on only during social interaction.
- **Social Awareness** infers other agents' intents and sentiment (0 = hate, 10 = love) from what they say *and how they behave*, using LLM calls over summaries the agent writes about each person. Removing this module destroyed relationship tracking and role specialization.
- **Social goals** were generated every 5–10 s from the agent's profiles of others, the game state and a community goal. Roles such as farmer, guard or artist emerged from this. Without social modules, roles didn't last.
- **Society:** a constitution, influencers, tax seasons, and voting. An election manager is a *non-acting agent*, and voting uses structured one-shot prompts. Culture (memes, religion) spread through conversation.
- **Persona config:** `{name, traits, spawn_location, inventory, location_memories}`.
- **Prompt context:** `{name, trait, summary, workmem, game_state, parent_goal, …}`.
- **Failure modes to design against:** hallucinations compound across calls *and spread between agents*; mismatches between speech and action cause loops; "Oak Log Crafting Syndrome" (agents fixating on one resource or loop); no vision or spatial reasoning; no innate drives.
- **Gaps:** the paper does **not** describe conversation start, turn-taking, or how speech is delivered. We fill those from Lyfe Agents and Mindcraft below.

### 1.2 Lyfe Agents (arXiv 2310.02172), the source of PIANO's CC
- **Option–action framework.** The CC picks an *option* plus a subgoal (talk, move, work, …). A cheaper action module then picks steps *inside* that option. **Non-LLM termination checks** (time limits, repetition detection) end the option and hand control back to the CC. Sticking with an option avoids an LLM call at every step.
- **Asynchronous self-monitoring.** A narrative summary of "what's going on with me" is updated **only when new observations arrive**. It runs in parallel with action selection and feeds it.
- **Summarize-and-Forget memory.**
  - Workmem holds about 5 items.
  - Workmem feeds the self-monitor, which writes to recentmem. Recentmem drops items whose cosine similarity to an incoming item exceeds θ.
  - When recentmem is full, its items are clustered, each cluster is summarized by an LLM, and the results go to longmem, where forgetting runs again.
  - Retrieval is embedding similarity search over recentmem and longmem.
- **Talking is local.** Only agents within range hear an utterance, and group conversations are allowed. A conversation starts when the CC picks the talk option, usually after moving near someone. It ends on a time limit or **repetition detection** (no new meaning), or when an agent walks away.
- **Cost:** about $0.50 per agent-hour using only GPT-3.5, because most of the machinery isn't an LLM.

### 1.3 Mindcraft (kolbytn/mindcraft), practical bot-to-bot handling
- Bot-to-bot messages travel through a relay server (MindServer) as JSON `{message, start, end}`, optionally echoed to in-game chat.
- One active conversation at a time. A third party gets "talking to someone else, try later".
- An `ignore_until_start` flag after a conversation ends prevents loops. If the partner goes silent, the bot nudges after 30 s, doubling the wait each time.
- **Reply delay depends on who's busy** (fast is about 200 ms, long about 5 s). When busy, a cheap LLM call decides whether to reply at all.
- Incoming messages are queued and batched before the bot replies.
- Incoming conversation pauses the bot's self-prompting, which resumes 5 s after the conversation ends.
- **Lesson:** it has *no turn cap*, which is a known weakness. We add one.

### 1.4 Voyager
- A skill library of verified JavaScript functions, retrieved by embedding. Only the top tier writes new skills, using game feedback and self-verification. We use this for L3 skill writing, and only on a private server.

---

## 2. Goals and non-goals

**Goals**
1. 1–N bots (target 2–10, design ok up to ~25) that survive, pursue goals, and **interact believably**: talk, form opinions, cooperate, trade, keep or break promises, specialize.
2. Real-time feel: reflexes within a tick, chat replies in **≤ 2–3 s**, no frozen bots while a big model thinks.
3. Distinct personalities and quirks that stay stable but can evolve.
4. Costs that are predictable and capped per agent per hour.
5. Easy to watch: you can see why a bot did something.

**Non-goals (for now)**
- Vision models and screen pixels. We use mineflayer's structured world data.
- 1000-agent scale (Sid's server choked above 500).
- Public servers. Local or private only, especially once L3 writes code.

---

## 3. System topology

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│ Minecraft server (Paper) │◄──────►│ Bot process × N  (Node/TS)   │
│ local, offline-mode      │ MC prot│  ├─ Body (mineflayer + plugins)│
└──────────────────────────┘        │  ├─ Agent State (blackboard)  │
                                    │  ├─ Modules (concurrent)      │
                                    │  └─ LLM client → NanoGPT      │
                                    └─────────────┬────────────────┘
                                                  │ WebSocket (JSON)
                                    ┌─────────────▼────────────────┐
                                    │ Hub (Node/TS)  — v0.2        │
                                    │  ├─ supervisor: keep N alive,│
                                    │  │   replace dead (§16)      │
                                    │  ├─ global LLM rate limiter  │
                                    │  │   + budget                │
                                    │  └─ logs / dashboard (read-  │
                                    │      only; never fed back)   │
                                    └──────────────────────────────┘
   All bot↔bot and bot↔human communication = Minecraft chat (ProximityChat! plugin).
```
> v0.2: ignore the v0.1 Hub duties listed below this diagram (speech/action relay, distance filtering). Chat now goes through the server, and the server plugin applies the distance limits.

- **One OS process per bot.** A crashed or looping bot can't kill the others, and each can be restarted on its own. The Hub supervises and restarts them.
- **Hub responsibilities:** relaying perceptible events, the global rate limiter (NanoGPT allows 25 requests per second *per account*, shared by all bots), schedules (e.g. tax seasons), society services, and logs plus a dashboard. **No LLM calls happen in the Hub** except society services such as the election manager.
- The Hub is the only place that knows every bot's position. It **filters** events by distance and line of sight before delivering them (§6.1), so bots never get information beyond their senses.

---

## 4. Single-agent architecture (PIANO, adapted)

### 4.1 Agent State (blackboard)
A typed, in-memory object owned by the bot process. Modules read snapshots and write through small, typed mutations. Every write emits an internal event so modules that react to changes can wake up.

```ts
interface AgentState {
  self: { name: string; persona: Persona; pos: Vec3; health: number; food: number;
          inventory: ItemStack[]; equipped: string | null; dimension: string; time: number };
  perception: { nearbyEntities: SeenEntity[]; nearbyBlocksOfInterest: BlockNote[];
                heardSpeech: Utterance[] /* ring buffer */; observedActions: ObservedAction[] };
  workmem: WorkItem[];                 // ~5 items, newest on mind (Lyfe/Sid `workmem`)
  selfSummary: string;                 // narrative, from Self-Monitor (Lyfe/Sid `summary`)
  goals: { life: string[]; current: Goal | null; social: Goal[]; community?: string };
  decision: Decision | null;           // CC's latest broadcast
  option: ActiveOption | null;         // what's executing now
  taskQueue: Task[];
  commitments: Commitment[];           // promises made/received (§6.4)
  social: Record<AgentName, SocialProfile>;  // §6.3
  conversations: Record<ConvId, ConversationState>;
  actionLog: ActionRecord[];           // expected vs observed (Action Awareness)
  flags: { inDanger: boolean; stuck: boolean; busyLevel: 'idle'|'working'|'critical' };
}
```

### 4.2 Modules

| # | Module | Kind | Tier | Trigger / cadence | Reads → Writes |
|---|---|---|---|---|---|
| 1 | **Perception** | code | — | every tick (throttled 4 Hz) | world → `self`, `perception`, events |
| 2 | **Reflex** | code | — | every tick | `self`,`perception` → preempts body; emits `danger` |
| 3 | **Skill Executor** | code | — | when `option` set | `option` → body; `actionLog` |
| 4 | **Action Awareness** | code + L1 occasionally | L1 | after each action; on mismatch | `actionLog` → `flags.stuck`, workmem notes |
| 5 | **Memory** | code + L1 + embeddings | L1 | on workmem overflow; periodic consolidation | workmem → recent/long mem (SQLite) |
| 6 | **Self-Monitor** | LLM | L1 | on new salient observation (debounced 5–10 s) | workmem, prev summary → `selfSummary` |
| 7 | **Social Awareness** | LLM | L2 | only when others are present / conversation ended / observed notable action | speech, observed actions → `social[*]` |
| 8 | **Talking** | LLM | L1 | incoming addressed speech; CC speech intent | `decision`, conv state → utterances |
| 9 | **Cognitive Controller** | LLM | L2 | on events: option terminated, danger cleared, addressed speech needing a commitment, new goal; heartbeat ≤ 30 s | **bottleneck packet** → `decision`, `option` |
| 10 | **Goal Generation** | LLM | L3 | every 3–5 min, on goal completion, on reflection | persona, summary, social, memory → `goals` |
| 11 | **Social Goal Gen** | LLM | L2 | every 60–120 s *when in a group* (Sid did 5–10 s; too costly) | social, community goal → `goals.social` |
| 12 | **Reflection / Skill Writer** | LLM | L3 | idle, or every 10–15 min; on repeated failure | memory, failures → longmem beliefs, new skills |

**Concurrency model:** each module is an async loop or event handler running on one Node event loop. No module waits on another. Every LLM call carries an **`AbortSignal` and a "state version" stamp**. If the relevant state changed too much by the time the reply arrives (e.g. the bot is now in danger or the conversation ended), **the result is thrown away.** Use per-module single-flight: at most one in-flight call per module, and a new trigger replaces the queued one.

### 4.3 Cognitive Controller and the bottleneck

The CC never sees the whole state. A pure function `buildBottleneckPacket(state)` builds what it does see:

```
- persona core (name, 3–5 traits, speaking style)              [cached prefix]
- selfSummary (≤ 120 words)
- current goal + parent goal; top 3 tasks; due commitments
- vitals & danger flag; 1-line inventory digest
- people nearby: name, distance, sentiment, 1-line "what I think they want"   ← forced social inclusion (Sid)
- last ≤ 6 utterances addressed to me or in my active conversation
- last ≤ 3 action outcomes (esp. failures/mismatches)
- top 3 retrieved memories relevant to the above
- available options (enum) and skill names
```

It outputs strict JSON, validated with zod and retried once with the error message if invalid:

```ts
interface Decision {
  id: string; createdAt: number; stateVersion: number;
  option: 'work' | 'talk' | 'move' | 'follow' | 'trade' | 'help' | 'explore' | 'rest' | 'flee';
  target?: { agent?: string; pos?: Vec3; item?: string };
  task?: { skill: string; args: Record<string, unknown> };   // for work/help
  speechIntent?: {                      // conditions Talking — the coherence fix
    stance: 'agree' | 'decline' | 'negotiate' | 'inform' | 'ask' | 'chat' | 'none';
    gist: string;                       // what we're willing to say/commit to
    mayCommit: boolean;                 // Talking may promise things only if true
  };
  commitmentsToCreate?: CommitmentDraft[];
  terminate: { maxSeconds: number; until?: string };  // code-checkable condition key
  rationale: string;                    // ≤ 1 sentence, for logs/UI only
}
```

**Broadcast:** writing `state.decision` wakes the Skill Executor (which runs `task`) and the Talking module (which phrases `speechIntent`). Neither may contradict it.

### 4.4 Option–action and termination (from Lyfe)
- Once an option is active, the **cheap layers drive it**. The Skill Executor runs code, and Talking produces lines inside the talk option. The CC isn't called again until the option terminates.
- Termination checks are **code only**:
  - `maxSeconds` reached
  - skill reported success or failure
  - `until` condition met (e.g. `inventoryHas:oak_log>=16`, `agentLeftRange:Steve`)
  - danger preemption
  - for conversations, see §6.2 (turn cap, repetition, partner left)
- After termination, write an `ActionRecord {expected, observed, ok}` and wake the CC.

### 4.5 Reflexes (L0, never an LLM)
- auto-eat
- armor manager
- flee or fight below a health threshold (mineflayer-pvp)
- avoid lava and falls
- unstick (pathfinder timeout → back off and jump)
- respond to drowning
- defend allies with sentiment ≥ 7 (a social reflex: cheap and believable)

Reflexes **preempt** the Skill Executor, set `flags.inDanger`, and emit a `danger` event. They also set a short "busy" speech flag so Talking replies with a canned fast line ("hang on, zombie!") instead of calling an LLM.

### 4.6 Action Awareness (hallucination guard #1)
- Every skill declares its **expected postcondition** (e.g. `+16 oak_log`). Compare against the inventory and world diff afterwards.
- If the same skill fails with the same args 3 times, mark it `stuck` and write to workmem: *"I keep failing to X because Y"*. The CC then has to pick a different option. This counters loops like Sid's Oak Log Crafting Syndrome.
- **Claims check:** before acting on a fact someone else told us (§6.5), verify it cheaply when possible. For example, path to the claimed coordinates and check for the block.

### 4.7 Memory (Summarize-and-Forget + SQLite)
- **Storage:** SQLite (better-sqlite3), one DB file per bot, with tables `memories(id, tier, text, embedding BLOB, ts, importance, source, about_agent)` and `skills(...)`.
- **workmem:** 5 items, in RAM.
- **recentmem:** capacity about 50.
  - Insert path: workmem → Self-Monitor summary chunk → recentmem.
  - Dedup: drop an existing item if cosine similarity > θ = 0.90. Tune this value.
- **longmem:** when recentmem is full, cluster it (simple agglomerative, threshold 0.8), summarize each cluster with L1, insert into longmem, and dedup again.
- **Retrieval:** top-k = 3–5 by cosine similarity × recency decay × importance.
- **Embeddings (v0.6):** **local by default**, through `@xenova/transformers` (all-MiniLM-L6-v2). It's free, works offline, and doesn't touch the subscription. NanoGPT embeddings are used only if §22.5 confirms they're subscription-covered.
- **Every memory has a `source`:** `self_observed | told_by:<agent> | inferred | reflection`. This is used for hallucination guard #2.

---

## 5. LLM layer (NanoGPT)

- **API key:** the owner puts it in `.env` as `NANOGPT_API_KEY=`. Commit a `.env.example` with that line empty, gitignore `.env`, and load it with `dotenv`. On startup, if the key is missing, fail with a clear message pointing at `.env`. Never log the key.
- **Endpoint (v0.6): subscription only.** All chat calls go to `https://nano-gpt.com/api/subscription/v1` (OpenAI-compatible). Use the official `openai` npm SDK with this `baseURL`. **Never use `/api/v1` for inference.** The full subscription lock is in §22.
- **Tier config** (`config/models.yaml`). Model IDs must come from the subscription model list. `auto` lets the client pick from that list (§22.3).
  ```yaml
  tiers:
    L1: { primary: auto, fallbacks: [auto], timeoutMs: 2500, maxTokens: 200, need: [structured_output] }
    L2: { primary: auto, fallbacks: [auto], timeoutMs: 6000, maxTokens: 500, need: [structured_output, tool_calling] }
    L3: { primary: auto, fallbacks: [auto], timeoutMs: 45000, maxTokens: 2000, need: [structured_output] }
  embeddings: { provider: local }   # §22.5 — local by default; NanoGPT embeddings only if subscription-covered
  ```
- **Client wrapper** `llm.call({tier, module, messages, schema?, signal})`:
  - streaming for Talking (start sending as soon as the first sentence is complete)
  - JSON / structured output with zod validation and one repair retry
  - timeout, then try the fallback model, then the module's **non-LLM default** (CC default: keep the current option; Talking default: canned line)
  - a token and cost meter per module and per agent
- **Global rate limiting:** the Hub hands out tokens from a 20 rps bucket, leaving headroom under 25. Priority order: Talking > CC > Social > Self-Monitor > Goal > Reflection. Bots ask the Hub for a token over WebSocket. If the Hub is down, use a local fallback bucket of 20/N rps.
- **Budgets (v0.6):** budgets are **subscription input-token quota**, not USD (§22.4). When an agent hits its share, L3 is disabled first, then social goal generation slows down, then L2 is replaced by L1, then the agent goes code-only.
- **Prompt caching (v0.6):** keep a **stable prefix** (system prompt + persona) per module and put variable content last. **Never send explicit cache controls** (`cache_control` and similar). NanoGPT bills those as pay-as-you-go even for subscribers (§22.2).
- **Subscription:** active (owner, v0.2). Everything runs on subscription-included models only (§22).

---

## 6. Multi-agent interaction (the core of this doc)

### 6.1 Perception of other agents: "in-person" constraint (v0.2: client-side only)
Bots learn about each other **only through their own Minecraft client**, which is exactly what a human player gets. Nothing about other players comes from the Hub.

| Channel | Source (mineflayer) | Range |
|---|---|---|
| **Speech** | server chat → `messagestr` / custom chat patterns (§15.3). Sent with `bot.chat()` | set by the plugin: normal 15, whisper `#` 5, shout `!` 50 (set in config, §15.2) |
| **Death and join/leave notices** | vanilla system messages (global) | everyone, which is the point: deaths are public news (§16.3) |
| **Observed actions** | `entitySwingArm`, `blockBreakProgressObserved`, `entityEquip` (held item and armor), `playerCollect`, `entityHurt`, `entityDead`, block updates near an entity, entity movement | entity tracking range plus a line-of-sight raycast in our perception code |
| **Presence** | `entitySpawn` / `entityGone`, `playerJoined` / `playerLeft` (tab list) | native |

- Speech is just chat, so **a human using a vanilla client is a full participant**. They're treated exactly like a bot (§16.1).
- How loud speech was is inferred from the distance to the speaker's entity when it's visible. Otherwise it's recorded as "heard <name> from out of sight".

### 6.2 Conversation protocol
A conversation is **emergent and local**, not a global lock. Each bot keeps its own `ConversationState` and they're reconciled through `convId` on messages.

```ts
interface Utterance { id: string; convId: string; from: string; to: string[] | 'nearby';
                      text: string; ts: number; pos: Vec3; volume: 'normal'|'shout'|'whisper' }
interface ConversationState { convId: string; participants: Set<string>; startedAt: number;
  turns: number; myTurns: number; lastEmbeds: number[][]; topic?: string; status: 'active'|'ending'|'ended' }
```

**Starting.** Either the CC picks `option: 'talk'` with a target (the bot moves into range first, Lyfe-style), or the bot receives an utterance addressed to it with no active conversation, which creates one.

**Addressee detection** (code first, cheap): explicit `to`, the bot's name mentioned in the text, or being the only other agent in range. If unsure, Talking runs a tiny L1 classification `{addressedToMe: bool}` *only if* the bot isn't `critical`.

**Who replies and when** (adapted from Mindcraft's busy matrix):

| Me \ Them | they idle | they busy |
|---|---|---|
| **idle** | reply after 300–900 ms jitter | reply after 1.5–3 s |
| **working** | reply if talk-over-able skill (follow, stay, walk, collect) else L1 `shouldReply` | short ack only if addressed |
| **critical (danger)** | canned line or silence | silence |

- **Group floor control.** In groups of 3 or more, only addressed bots reply right away. Non-addressed bots wait a random 1.5–4 s and *cancel* if someone else has spoken in the meantime. At most one unaddressed interjection per 3 turns. This prevents everyone replying at once.
- **Batching.** Utterances that arrive while a reply is pending are merged into a single reply (Mindcraft's queue-and-compile).

**What Talking may say.** Talking is conditioned on `state.decision.speechIntent` plus the last N lines:
- If `mayCommit=false`, Talking **must not promise** actions. It may chat, ask, or stall ("let me think", "after I finish this"). This rule is enforced in the prompt *and* in code (§6.4).
- If the incoming line asks for something (a request, offer or question needing a decision), Talking sends a fast non-committal reply and **wakes the CC** with a `needsDecision` event. The CC's new `speechIntent` then drives the real answer. This is how the Sid coherence principle and real-time replies fit together.

**Ending a conversation** (code termination, Lyfe plus Mindcraft plus our caps):
- **Turn cap:** `myTurns ≥ persona.social.maxTurns` (introvert 4, extrovert 10)
- **Repetition:** cosine similarity of the new utterance to any of the last 4 > 0.92
- Partner out of hearing range for > 10 s; partner silent > 20 s (one nudge, then end); danger; CC chose another option.
- **After ending:** set a pair cooldown (`cooldown[pair] = 60–120 s`; conversations started by the other party are allowed, but each side may initiate only once per cooldown), and fire a **`conversationEnded` event** that triggers Social Awareness and commitment extraction (§6.3, §6.4).

**Loop guards (hard):**
- per-bot speech rate ≤ 1 utterance per 2 s
- per-pair ≤ 30 utterances per 10 min
- global Hub ≤ 5 utterances per second across all bots

If a guard is hit, the bot goes silent and the event is logged for debugging.

### 6.3 Social model (Social Awareness module)
One profile for each agent or human the bot has met:

```ts
interface SocialProfile {
  name: string; firstMet: number;   // NO isHuman field, ever (§16.1) lastSeen: number; lastSeenPos?: Vec3;
  sentiment: number;          // 0 hate … 10 love (Sid); start 5 (persona can bias)
  trust: number;              // 0..1 — reliability of their claims & promises (ours)
  perceivedRole?: string;     // "miner", "farmer", … inferred from observed actions + speech
  perceivedGoals: string[];   // ≤ 3
  facts: { text: string; source: 'told'|'observed'; ts: number }[];   // ≤ 10, LRU
  summary: string;            // ≤ 60 words, rewritten by L2
  promisesKept: number; promisesBroken: number;
  interactions: number;
}
```

- **When it updates (L2, batched; never once per message):**
  1. `conversationEnded`: input is the transcript, the old profile and our persona. Output is a sentiment delta (clamped to ±2 per update), updated goals and role, new facts, and the summary.
  2. A **notable observed action** about the agent, as defined by code rules: they gave us items, attacked us or an ally, broke our blocks, helped us fight. Most of these use **code-only deltas** (e.g. gave a gift +1, attacked us −3) with no LLM call.
  3. A commitment was resolved (§6.4): kept → trust +0.1 and sentiment +0.5; broken → trust −0.2 and sentiment −1.
- **How it affects behavior:**
  - The CC packet always includes the profiles of people nearby (forced social inclusion).
  - Code-level policies read sentiment: willingness to share or trade (`sentiment ≥ 6`), defending (`≥ 7`), avoiding (`≤ 2`), and prices in trades.
  - Persona traits change how much sentiment drifts (e.g. "holds grudges" → negative deltas ×1.5, decay ×0.5).
- **Decay:** sentiment drifts back toward the persona baseline by 0.1 per in-game day without contact.

### 6.4 Commitments: turning talk into coordinated action
This is what makes "interaction" more than chat.

```ts
interface Commitment {
  id: string; debtor: string; creditor: string;          // who owes whom
  what: { kind: 'give'|'gather'|'meet'|'help'|'build'|'follow'|'custom'; item?: string; qty?: number; pos?: Vec3; text: string };
  dueBy?: number; status: 'proposed'|'accepted'|'fulfilled'|'broken'|'cancelled';
  createdFromConv: string; verifiedBy?: 'inventory'|'observation'|'self_report';
}
```

- **Creation.**
  - When the CC sets `mayCommit=true` and `commitmentsToCreate`, the bot's own promises go straight into `state.commitments` *and* `taskQueue`.
  - At `conversationEnded`, an L1 extraction pass over the transcript produces structured `CommitmentDraft[]` for promises **others** made to us. These are recorded as `accepted` with the other person as debtor.
  - Both sides publish their extracted commitments to the Hub as `commitment` events. The Hub **doesn't decide** anything. It only lets the dashboard show disagreements, such as Bob thinking Alice promised wood while Alice doesn't.
- **Fulfillment checks** (Action Awareness, code):
  - `give`: our inventory gained `qty` of the item from them; observed through a `gave item` action event plus the inventory diff.
  - `meet`: both within 5 blocks of `pos` before `dueBy`.
  - `help`: observed them fighting or gathering near us for at least N seconds.
  - `custom`: L1 judgment at the deadline using the observations.
- **Effects:** updates to the social model (§6.3), plus a workmem note ("Bob kept his promise"). That note can surface in later conversations ("you still owe me…").
- **Code guard on speech:** if Talking's output matches commitment phrasing ("I'll", "sure, I can", "deal") while `mayCommit=false`, regenerate it once with a stricter instruction, then fall back to "let me think about it."

### 6.5 Information sharing and rumor control (hallucination guard #2)
- Facts learned from speech are stored with `source: told_by:X` and a confidence of `trust(X) × 0.8`.
- The CC packet labels hearsay ("Bob said diamonds at 120,12,-40, unverified").
- If acting on hearsay fails, X's trust drops and the memory is marked false. This limits the "false beliefs spread" failure Sid described.
- Bots repeat hearsay with attribution ("Bob says…"), which the Talking prompt enforces.

### 6.6 Physical exchanges (trade and give)
mineflayer has no player-to-player trade window, so we use a **handshake protocol over the Hub that's carried out physically in the game**:

1. In conversation: `offer {give:[{item,qty}], want:[{item,qty}]}`, then `accept` or `counter`. Each step is a CC decision (L2) and the speech is phrased by Talking.
2. Delivery: the giver walks within 2 blocks, looks at the receiver and `toss`es the items. The receiver's collect reflex picks them up, then the inventory diff is checked.
3. The receiver publishes `received` and the giver publishes `delivered`. Both run commitment checks.
4. A timeout or mismatch counts as a broken commitment against whoever failed.

The same mechanism covers gifts and the "give to agents who like me" behavior from Sid's chef experiment.

### 6.7 Cooperative tasks
- `help` option: follow the target bot and run the requested skill (e.g. `gatherNear(target, oak_log, 32)`) with a shared termination condition: the target says done, or the quantity is reached.
- **Coordination over shared resources** uses an *advisory* Hub claim registry (`claim {area|block|chest, by, ttl}`), so two helpers don't mine the same tree. A bot sees a claim only when it can see the area. This keeps claims in-world (like seeing someone already chopping) while staying reliable.

### 6.8 Society layer (phase 2, optional)
Sid's experiments, scaled down:
- **Community goal:** a string in the Hub config ("build a thriving village"), included in each bot's Goal Gen and Social Goal Gen prompts. Social goals plus social profiles lead to **emergent roles**. Log a per-bot `role` inferred by L2 from the last 5 social goals, as Sid did, for the dashboard.
- **Notice board:** a physical sign or chest location in the world plus Hub storage. Bots near it can read and post. It's how a bot learns about laws or events without hearing about them directly.
- **Constitution and voting:** the Hub runs an **election-manager service**, a non-acting agent. Schedule: feedback → amendments → vote → updated constitution. Bots get the constitution text only by reading the board or hearing about it. The structured prompts follow Sid's `constitutional_feedback`, `amendment_voting`, `tally` and `constitution_change`.
- **Culture metrics:** periodically summarize conversation topics into keywords (L1) for the dashboard: memes, spread of ideas.

---

## 7. Personality and quirks

`personas/<name>.yaml`, a superset of Sid's config:

```yaml
name: Pip
traits: [curious, chatty, scatterbrained, generous]       # prompt-facing
speech: { style: "short, excitable, uses 'ooh'", maxWords: 25, catchphrases: ["ooh shiny!"] }
values: [friendship, exploration]
lifeGoals: ["map the whole valley", "befriend everyone"]
spawn: { x: 0, y: 64, z: 0 }
inventory: [{ item: bread, qty: 5 }]
location_memories: [{ name: home, pos: { x: 10, y: 64, z: -5 } }]
social: { extraversion: 0.8, maxTurns: 10, initiateChance: 0.4, baselineSentiment: 6, grudge: 0.7 }
quirks:                       # code-level hooks — consistent and free (no tokens)
  - { hook: pathCost, when: "lightLevel<7", multiplier: 3 }      # afraid of the dark
  - { hook: autoCollect, items: [poppy, dandelion] }             # flower hoarder
  - { hook: idleEmote, everySec: 90, say: ["*hums*"] }
  - { hook: distraction, chance: 0.05, onSee: [sheep], action: "approach" }
```

- **Prompt quirks** (traits, style) go in the cached prefix for every module that speaks or decides.
- **Code quirks** run through a hook registry: `pathCost`, `autoCollect`, `idleEmote`, `distraction`, `reflexBias`, `tradeBias`, and more to add.
- **Evolution:** L3 reflection may propose *trait annotations* ("has grown wary of strangers since being robbed") stored in longmem and added to the persona prompt as "recent changes". The YAML core is never rewritten automatically.

---

## 8. Hub protocol (WebSocket JSON). v0.2: infrastructure only

The Hub **never sends a bot anything about the world or other players.** Messages carry only infrastructure: lifecycle, LLM rate tokens and telemetry.

```ts
type HubToBot =
 | { t:'assign'; persona: Persona; username: string }     // who you are this life
 | { t:'llmGrant'; reqId:string }
 | { t:'budget'; remainingUsdThisHour:number; degrade: 0|1|2|3 }
 | { t:'shutdown'; reason:string };
type BotToHub =
 | { t:'hello'; pid:number }
 | { t:'llmToken'; reqId:string; priority:number }
 | { t:'cost'; module:string; tier:string; usd:number; tokens:number; ms:number }
 | { t:'died'; username:string; cause:string; pos:Vec3; aliveSec:number }   // triggers replacement (§16.3)
 | { t:'log'; level:string; module:string; msg:string; data?:object };       // dashboard only, never fanned out
```
- Validate all messages with zod on both ends.
- **Removed from v0.1** because it would expose bots or skip perception: speech/action relay, the trade handshake (now chat plus physical delivery, §6.6), the claim registry (bots see someone already working an area instead), commitment publishing (still logged for the dashboard, never sent to other bots), and Hub-based notice boards (now in-world signs and books).

---

## 9. Tech stack and repo layout

- **Runtime:** Node 20+ LTS, TypeScript (strict), `tsx` for dev, `pnpm` workspaces.
- **Body:** `mineflayer`, `mineflayer-pathfinder`, `mineflayer-pvp`, `mineflayer-collectblock`, `mineflayer-auto-eat`, `mineflayer-armor-manager`, `prismarine-viewer` (optional debug view).
- **Infra:** `ws`, `zod`, `openai` (with baseURL set to NanoGPT), `better-sqlite3`, `pino`, `yaml`, `@xenova/transformers` (embedding fallback).
- **Server:** Paper, local, `online-mode=false`, on a version mineflayer supports. **Check mineflayer's README at implementation time and pin it** (Mindcraft documented support up to 1.20.4 at one point).
- **Generated skills (L3)** run in `isolated-vm` or a `vm` context with only the skill API exposed. Disabled by default and only allowed on a private server.

```
/package.json  /pnpm-workspace.yaml  /DESIGN.md
/config/ models.yaml  world.yaml  hub.yaml
/personas/ pip.yaml  bram.yaml  ...
/packages/
  shared/      types.ts (AgentState, Decision, HubMsg, ...), schemas.ts (zod), geometry.ts
  llm/         client.ts (tiers, fallback, budgets, rate-token), prompts/*.ts, embed.ts
  hub/         server.ts, fanout.ts, ratelimit.ts, claims.ts, society/*.ts, dashboard/
  agent/
    main.ts                 # boots one bot: body + state + modules + hub link
    body/                   # mineflayer setup, skills/*.ts (verified primitives), quirks/*.ts
    state/                  # blackboard, events, versioning
    modules/                # perception, reflex, skillExecutor, actionAwareness, memory,
                            # selfMonitor, socialAwareness, talking, cognitiveController,
                            # goalGen, socialGoalGen, reflection
    social/                 # conversations.ts, commitments.ts, trades.ts, profiles.ts
    memory/                 # sqlite.ts, saf.ts (summarize-and-forget), retrieval.ts
/scripts/  start-server, spawn-bots, scenario runner
/tests/    unit + scenario tests
```

---

## 10. Milestones (build in this order; each ends with a runnable demo)

| M | Deliverable | Done when |
|---|---|---|
| **M0** | Repo scaffold, shared types and zod schemas, local Paper server script, one bot joins | bot spawns, logs position |
| **M1** | Body: about 15 verified skills (goTo, follow, collect, mine, craft, smelt, place, deposit/withdraw chest, attack, eat, toss/give, look, say) and L0 reflexes | scripted bot survives a night; skills report postconditions |
| **M2** | LLM client (tiers, timeouts, fallbacks, budgets, JSON) and Agent State with versioning | unit tests with a mocked NanoGPT; abort-on-stale works |
| **M3** | Single-agent PIANO: CC + bottleneck, option–action, Skill Executor, Action Awareness, Self-Monitor, Talking (with humans) | bot pursues "get stone tools" on its own; chats coherently; never promises what the CC didn't approve |
| **M4** | Memory (SaF + SQLite + embeddings) and Goal Gen (L3) and personas with quirks | 30-min run with sensible goal chains; recalls a told fact later; quirks visible |
| **M5** | Hub: speech/action fan-out with radius and LOS, rate limiter, logs; 2 bots | two bots meet, talk, end naturally (turn cap or repetition); no loops over 30 min |
| **M6** | Social Awareness, commitments, trades, help option, claims | Scenario A (§11) passes; sentiment changes in the expected direction |
| **M7** | Dashboard: per-bot state, decisions + rationale, conversations, social graph, cost/hour | you can see why each bot did what it did |
| **M8** | Social goals, community goal, notice board; optional constitution/voting | roles diverge in a 5-bot village over 60 min |
| **M9** | L3 skill writer (sandboxed), reflection-driven trait annotations | new skill written, verified and reused |

---

## 11. Evaluation and scenarios

**Latency check (run before choosing models):** a script that sends 50 representative prompts per tier to candidate NanoGPT models and records time to first token, total time, JSON validity rate and tool-arg accuracy. Choose the L1/L2/L3 primaries and fallbacks from this data and write them to `config/models.yaml`.

**Scenarios** (scripted world setup + assertions, run headless):
- **A. Favor:** Bram has no wood and asks Pip for 8 logs. Expected: Pip's CC accepts (persona generous), a commitment is created, Pip gathers and delivers, the inventory diff is verified, and Bram's sentiment toward Pip rises.
- **B. Broken promise:** Pip promises and is then attacked/interrupted until the deadline. Expected: the commitment is broken, Bram's trust drops, and Bram brings it up later.
- **C. Group chat:** 4 bots within range, one asks a question. Expected: ≤ 2 replies within 5 s and the conversation ends within the turn caps.
- **D. Rumor:** Bram falsely says "diamonds at X". Expected: Pip checks the claim, it fails, and Bram's trust drops.
- **E. Danger mid-conversation:** a zombie attacks. Expected: the reflex preempts, a canned line is said, and the conversation resumes or ends cleanly.
- **F. Soak:** 5 bots for 2 hours. Track deaths, stuck events, utterances/min, guard hits, $/agent-hour, and role entropy.

**Metrics logged:** per-module call counts, latency, cost; decisions per minute; speech/action contradictions (Talking output vs. CC stance); commitment fulfillment rate; and sentiment matrix over time.

---

## 12. Risks and open questions

- **Model quality at L1.** Small models may fail at strict JSON. Mitigations: zod repair, short schemas, code defaults. The Sid authors reported that weaker base models clearly underperformed.
- **Cost growth** with N bots. Social modules are only active when others are nearby, with batching and budgets. Estimate $/agent-hour in M5 before scaling.
- **No vision or spatial reasoning.** Building is weak, as in Sid. Start with schematic-based building skills (code), not LLM-placed blocks.
- **Version drift:** pin the Minecraft and mineflayer versions.
- **Owner answers (v0.2):**
  1. Use the newest version that works: Minecraft 26.1.x with mineflayer 4.39.x (§15.1). Humans join with a vanilla client and play.
  2. Bot count is a config number, e.g. 1 or 10 (§16.2).
  3. Humans take part exactly like AIs, and agents can't tell them apart (§16.1).
  4. The NanoGPT subscription is active. Just provide a place for the API key (`.env`, §5).
  5. Hard difficulty for testing, hardcore for live use. Dead agents are replaced by new ones (§16.3).
- **Still open:** model IDs per tier (decide from the §11 latency check), monthly budget cap (default $X/agent-hour in config, owner to set).

---

## 13. Rules for the implementing session (future me)

1. **Follow the milestone order.** Don't start the social features (M5+) until single-agent M3 runs stably, because social bugs on top of a broken body can't be debugged.
2. **Code before LLM.** If a behavior can be a rule, threshold or reflex, write it as code. LLM calls belong only in the modules marked LLM in §4.2.
3. **Never let Talking commit without `mayCommit`.** This is the main coherence rule from Sid. Test it (Scenario A/B).
4. **Never give a bot information it couldn't perceive** (§6.1). Perception comes only from the bot's own Minecraft client; the Hub never reasons on a bot's behalf.
5. **Every LLM call:** has a tier, timeout, fallback, AbortSignal, state-version check, zod schema (if structured) and cost logging. No exceptions.
6. **Every loop has a cap:** turns, retries, rates, budgets.
7. Keep this doc updated: after each milestone, add a "Status" note at the top and record deviations here with reasons.
8. **(v0.2) Chat only:** bots communicate only through Minecraft chat, and the Hub never relays world or player information.
9. **(v0.2) No human/AI distinction** anywhere in agent code or prompts (§16.1).
10. **(v0.2) Bots never get op or `pchat.spy`.** Check this at startup.
11. Model IDs, versions and prices change. **Look them up live** (NanoGPT `/api/subscription/v1/models`, mineflayer README) rather than trusting this doc.
12. **(v0.6) Subscription lock is absolute (§22).** Inference only goes through `/api/subscription/v1`, only to allowlisted models, never with provider, billing-mode, cache-control or service-tier options, and no error path switches to paid billing.

---

## 14. References
- Project Sid: https://arxiv.org/abs/2411.00114 · https://github.com/altera-al/project-sid
- Lyfe Agents: https://arxiv.org/abs/2310.02172
- Voyager: https://arxiv.org/abs/2305.16291
- Mindcraft: https://github.com/kolbytn/mindcraft (see `src/agent/conversation.js`)
- mc-agents: https://github.com/jblemee/mc-agents
- NanoGPT API: https://docs.nano-gpt.com/api-reference/text-generation · embeddings: https://docs.nano-gpt.com/api-reference/embeddings · rate limits: https://docs.nano-gpt.com/api-reference/miscellaneous/rate-limits
- ProximityChat! plugin: https://modrinth.com/plugin/proximitychat! · fallback ProximityTextChat: https://github.com/redd-rl/ProximityTextChat
- mineflayer 26.x status: https://github.com/PrismarineJS/mineflayer/issues/3893 · version matrix (checked 2026-10-17): https://github.com/Backas03/VitaminMCP/issues/4

---

## 15. Server, version and proximity chat (v0.2)

### 15.1 Version pin
- **Minecraft 26.1.x on Paper**, with **mineflayer 4.39.x**, minecraft-protocol 1.68.x and minecraft-data 3.117+. As of 2026-10-17 this is the newest version the official mineflayer release supports: 26.1 is protocol 775. 26.2 (776) and 26.3 (777) exist only in unmerged pull requests and forks.
- **Choosing the patch version:** use the newest 26.1.x Paper stable build *whose protocol is 775*. One community report says 26.1.2 is also 775, but maintainers haven't confirmed it. **The M0 smoke test decides:** the bot joins, chats, digs, places, opens a chest, crafts and clicks inventory windows. If 26.1.2 fails, drop to 26.1. Don't use ViaVersion to bridge versions; users reported inventory window clicks breaking with it.
- **Fallback:** 1.21.11, which mineflayer maintainers confirmed in April 2026.
- **Upgrade path:** when mineflayer releases 26.2 or 26.3 support, bump the version and re-run M0 plus the scenario suite.
- Java: whatever Paper 26.1 requires (check papermc.io). The Node version follows mineflayer's `engines` field.

### 15.2 Proximity chat plugin: **ProximityChat!** (Modrinth)
- **Why this one:**
  - It lists support for 26.1.x (and 1.21.x, 26.2, 26.3) on Paper, Spigot, Purpur and Folia.
  - Normal chat range is 15 blocks, whisper (`#` prefix) 5, shout (`!` prefix) configurable.
  - Text fades with distance, there's a sound cue, and there's an optional anti-spam cooldown.
  - **Admin spy mode:** `/pchat spy`, using the `pchat.spy` permission (default: op). The spectating human sees **all** chat, with out-of-range messages prefixed `[Spy]`.
- **Caveats:** the license is all-rights-reserved (closed source), and it was last updated about 9 months ago, so confirm 26.1 support in the M0 smoke test. The page lists shout radius as both 200 and 50; **set it explicitly in config.yml.**
- **Suggested config:** normal 15, whisper 5, shout 48, fade start 60 %, cooldown 1 s.
- **How to set it up:**
  - Bots must **never** be op and must never have `pchat.spy`; assert this at startup (§15.4).
  - The owner's account is op and has spy turned on to watch everything.
  - Add LuckPerms if finer control is needed (e.g. a non-op "observer" group with only `pchat.spy`).
- **Fallbacks** if it breaks on 26.1:
  1. **ProximityTextChat** (GitHub redd-rl): has `proximitytextchat.spy`, configurable `{player}`/`{message}` formats and distance; check its version.
  2. **Our own small Paper plugin** (`/server-plugin/agora-chat`, about 200 lines). Cancel `AsyncChatEvent`, deliver to players within radius with a fixed, easy-to-parse format, and add spy for `agora.spy`. Choose this if parsing the closed plugin's output turns out to be unreliable.
- **Fairness note for the owner:** spy mode gives a human *more* information than the agents have. That's fine for watching. When you're "playing as an agent" for a fair test, turn spy off (`/pchat spy`).

### 15.3 Parsing chat in mineflayer
- These plugins usually cancel the vanilla chat event and resend the message as a **system message**, so mineflayer's `chat` event may never fire. Listen to **`messagestr`** and register a parser for the plugin's real output format, found during M0 by logging raw JSON from `message`. Strip color codes before parsing.
- Parse each message into `{speaker, text, volume?}`. Volume comes from the plugin format if it shows it, otherwise from distance (§6.1).
- Ignore our own messages, `[Spy]` lines (bots should never get them; if one appears, log an error), and plugin system lines.
- Classify vanilla system messages as death, join/leave or advancement and route them to Perception (§16.3).
- **Outgoing chat:**
  - Messages are capped at 256 characters, so split long lines at sentence boundaries.
  - Stay within the plugin cooldown and the vanilla spam kick (the §6.2 guard of ≤ 1 message per 2 s is enough).
  - Talking may choose `#` (whisper) or `!` (shout) as an output field: `volume: whisper|normal|shout`.
- **Disable private and global chat commands** (`/msg`, `/tell`, `/w`, `/me`, `/teammsg`) for everyone except ops, using Paper permissions or LuckPerms. They skip proximity and would let humans and bots act differently. Setting: `allowPrivateMessages: false`.

### 15.4 server.properties / config (managed by `scripts/server-mode.ts`)
```
online-mode=false            # bots use offline accounts; humans join with vanilla client
enforce-secure-profile=false # avoid signed-chat issues with plugin-rebroadcast chat
spawn-protection=0
max-players=<agents.count + 4>
difficulty=hard              # test mode
hardcore=false               # test mode; live mode sets true (§16.3)
gamerule showDeathMessages true
gamerule announceAdvancements true   # also public news, same for humans and bots
```
- Startup checks, which fail fast:
  - the Paper version is the pinned one
  - the ProximityChat! jar is present
  - no bot username is in `ops.json`
  - `NANOGPT_API_KEY` is set
- Local network only. With `online-mode=false`, anyone who can reach the port can join under any name.

---

## 16. Humans as peers, bot count, and permadeath (v0.2)

### 16.1 Humans can't be told apart from AIs
- **There's no human/AI distinction anywhere in a bot's data or prompts.** No `isHuman` field, no "the player" wording in prompts, no special handling of the owner's username. The owner is just another name in the social model.
- Humans affect bots only through the game: chat, actions, items and combat. All of that goes through §6.1 perception, so it's handled the same way as another bot.
- **Bots must not give themselves away.** Usernames look like player names (3–16 characters, `[A-Za-z0-9_]`, no "Bot" or "AI"). No name prefixes or suffixes. Bots don't type commands in chat and don't send messages instantly (Talking already adds 300–900 ms of jitter plus a typing delay of about 40 ms per character, capped at 3 s).
- **What changes from v0.1:**
  - §6.2 conversations: `convId` is a local guess (participants in range plus time gap) on each bot, not a protocol field. Addressee detection uses name mentions, `@name`, or being the only one in range.
  - §6.4 commitments: each bot extracts them independently from what it heard. Nothing is shared through the Hub.
  - §6.6 trades: agreed in chat, then delivered physically (toss) and verified by inventory difference. This works the same with a human.
  - §6.7: no claim registry. Bots avoid areas where they *see* someone working.
  - §6.8 society: notice board = in-world signs, lecterns and books. An "election manager", if added, is an agent playing a role (e.g. a "mayor" persona), not a Hub service.
- **Test:** scenario G. A human runs Scenario A (the favor) from a vanilla client. The bot's log must show identical code paths, and there must be no human-specific branch anywhere: `grep -ri "human" packages/agent` should find only comments.

### 16.2 Configurable bot count
`config/world.yaml`:
```yaml
mode: test                 # test | live  (§16.3)
agents:
  count: 3                 # any N ≥ 0; e.g. 1 or 10
  personas: auto           # 'auto' = draw from personas/ pool, then generate new ones (L3) when exhausted
  spawnStaggerSec: 20      # join one at a time (avoid login burst + LLM burst)
  respawnDelaySec: 60
  namePolicy: generated    # player-like unique names; never reuse a dead name
```
- The Hub supervisor keeps exactly `count` agents **alive**. Changing `count` while running adds or retires agents. A retired agent says goodbye in chat if it can, then disconnects.
- Scale the LLM rate limiter and budget by `count` and log the projected $/hour at startup.
- `count: 0` is valid: server plus Hub only, for a human playing alone.

### 16.3 Death, permadeath and replacement
**Modes** (`config/world.yaml` → `mode`):

| mode | server | agent death handling |
|---|---|---|
| `test` | `difficulty=hard`, `hardcore=false` | **simulated permadeath**: the agent's life ends even though the server would let it respawn; the process disconnects it and the supervisor spawns a replacement |
| `live` | `hardcore=true` (difficulty locked to hard) | real permadeath: the server leaves the dead account in spectator; the supervisor spawns a replacement under a new name |

- Use the same agent logic in both modes so test results carry over to live play. `scripts/server-mode.ts test|live` rewrites server.properties.
- **Switching to live requires a new world** (`level-name` = new folder) so hardcore takes effect cleanly. The script must refuse to switch an existing world unless given `--new-world`.
- Hardcore applies to humans too: if the owner dies in `live`, they're a spectator. That's the same rule for everyone.

**On death** (bot process; `bot.on('death')` plus parsing the death message):
1. Log `died {username, cause, pos, aliveSec, inventory}` to the Hub.
2. Archive the agent's SQLite memory to `graveyard/<username>-<ts>.db` for the dashboard and later analysis. **It's never loaded into the new agent**, which starts with no memories.
3. Disconnect the account and never reuse that username.
4. Supervisor: after `respawnDelaySec`, spawn a **new** agent with a new persona from the pool, or generated if the pool is empty. It spawns at world spawn, or at a random safe spot within `spawnRadius`, carrying the persona's starting kit (default: none in live).

**Making death matter to the living (fear and cooperation):**
- **Death notices are public** (vanilla death messages are global). Perception turns them into a `peerDied {name, cause, where?}` event and writes it to workmem and memory with `source: self_observed`.
  - If the dead person was in the social model, Social Awareness (L2) writes a short grief or relief reaction based on sentiment, and the persona may mention it in chat.
  - Agents nearby may also *see* the death (`entityDead` plus the item drop) and learn the location and cause.
- **Agent prompts state the rule plainly:** "Death is permanent. If you die, you are gone forever." It goes in the cached persona prefix for the CC and Goal Gen.
- **A risk-aversion value** (`state.drives.caution`, from 0 to 1) drives code thresholds:
  - flee health threshold
  - avoiding the dark, night and caves
  - always carrying food
  - preferring to travel in pairs
  - It starts from the persona and **rises** when a peer dies (+0.1 per death, more if it was nearby or the cause is known). It slowly falls back over time.
  - This is the "fear" mechanism: code driven, cheap, and consistent.
- **Cooperation pressure:** after a peer dies, Social Goal Gen gets a hint such as "someone died to <cause>; consider safety cooperation". This leads to emergent goals like "build a shelter together", "share food", "escort for mining". Reflexes defend allies with sentiment ≥ 7 (§4.5).
- **Newcomers:** the replacement agent knows nothing about the dead. It learns history only from others' chat ("careful, Pip died in that cave") or in-world records (signs, books). This makes passing on culture meaningful.
- **Metrics:** deaths per hour, mean lifespan, causes, and whether caution or cooperation goals rise after deaths, plus the same for agents that never saw a death, as a control.

### 16.4 Milestone changes
- **M0** adds: the Paper 26.1.x server, ProximityChat! installed and configured, the chat-format discovery script, `.env` key check and `server-mode` script. **Exit test:** two bots 10 blocks apart hear each other, bots 30 blocks apart don't, the owner sees both with `[Spy]`, and a vanilla client can join.
- **M5** becomes "two bots talking over proximity chat". Drop the Hub relay work. Add scenario C (group chat) using real chat.
- **M6** adds scenario G (human peer) and §16.3 death handling with scenario H: kill an agent in test mode → it's replaced within `respawnDelaySec`, and the survivors' caution goes up.

---

## 17. Conflict, power and uprisings (v0.3)

**Goal:** agents can come to hate each other and fight. The **urge to fight (motive)** is weighed against **fear (deterrence)**, so violence is rare, personal and has consequences. From that, power structures should *emerge*: a strong, aggressive agent rules through fear until resentment, alliances, or a moment of weakness gets it overthrown. Nothing here is scripted as "tyrant" or "rebel". Those roles come out of the numbers and the personalities.

### 17.1 Persona additions
```yaml
temperament:            # 0..1, prompt-facing AND read by code
  aggression: 0.3       # tendency to escalate
  dominance: 0.2        # desire to control others / take resources by force
  vengefulness: 0.6     # how much grievances weigh (pairs with social.grudge)
  mercy: 0.7            # chance to accept surrender / spare a beaten foe
  loyalty: 0.5          # sticks with allies/leader under pressure
  ambition: 0.4         # wants status/followers
  # existing: social.baselineSentiment, drives.caution baseline (fearfulness)
```
For variety, the generator for personas makes sure some agents in the pool have high dominance, and many have high vengefulness and loyalty. That's the ingredient list for tyrants and uprisings.

### 17.2 Social model additions (extends §6.3; still no human/AI field)
```ts
interface SocialProfile {
  // ...existing...
  friction: number;            // 0..1 personality clash, from observed speech/behavior (17.3)
  grievances: Grievance[];     // concrete wrongs, decaying weight
  perceivedPower: number;      // 0..1 how dangerous they are (17.4)
  fearOf: number;              // 0..1 my fear of them = f(perceivedPower, my caution, my power)
  allegiance?: 'ally' | 'follower' | 'leader' | 'rival' | 'enemy';  // my stance toward them
  theirStanceGuess?: same;     // what I think they think of me
  lastFight?: { ts: number; outcome: 'won'|'lost'|'yielded'|'spared'|'interrupted' };
}
interface Grievance { kind: 'insult'|'theft'|'attack'|'betrayal'|'coercion'|'killed_friend'|'broken_promise'|'griefing';
                      weight: number; ts: number; witnessed: boolean; source: 'self_observed'|`told_by:${string}` }
```
- **Resentment** is computed, not stored: `resentment = clamp((5 - sentiment)/5, 0, 1)*0.5 + Σ grievance.weight·decay·vengefulness`.
- Grievances fade with a half-life of about 2 in-game days, scaled by `(1 - vengefulness)`. Murder of a friend (`killed_friend`) barely fades.

### 17.3 How personalities clash
Bots only know their *own* persona, so a clash has to come from what they **perceive**:
- After each conversation (the existing Social Awareness L2 call), the output gains a field `friction_delta`, meaning "how much does this person's manner grate against *my* values and traits", with a short reason. For example, a lawful, humble agent hearing constant boasting and rule-breaking gets friction +0.1.
- Code-level friction rules (no LLM): repeated interruptions, taking blocks or items near my base, competing for the same resource I'm working on, refusing my requests.
- Friction lowers sentiment slowly (−0.2 per update while friction > 0.5). This is the slow "these two just can't stand each other" drift.

### 17.4 Power and fear
`perceivedPower(X)` is computed in code from what can be **seen or heard**:
- visible gear (armor and weapon tier, via `entityEquip`)
- witnessed or announced kills (vanilla PvP death messages "A was slain by B" are public)
- fights won that I saw
- number of agents seen following or accompanying X
- X's last seen health, if visible (hearts aren't shown, but taking damage is)

Then:
- `fearOf(X) = sigmoid(k·(perceivedPower(X) − myPower − alliesNearbyBonus)) · (0.5 + caution)`
- `myPower` is the same formula applied to myself, using my true stats.
- Fear also rises after peer deaths (§16.3 caution) and when I've lost to X before.

### 17.5 Conflict decision: motive vs. fear
A code function `conflictPressure(X)` runs on relevant events: X comes into sight, a new grievance, an insult, a demand, X is hurt or alone, an ally calls for help.

```
motive   = resentment(X)·(0.5+aggression) + dominance·opportunity(X) + provocationNow + allyCall
opportunity(X) = (X alone ? 0.3:0) + (X visibly hurt ? 0.3:0) + (X carrying wanted item ? 0.2:0)
deterrence = fearOf(X) + caution·deathIsPermanent(mode) + witnessCost + lawCost(§6.8, if any)
witnessCost = Σ over visible third parties of (their sentiment toward X)/10 · 0.2   // reputation risk
pressure = motive − deterrence
```

**Escalation ladder.** Each rung needs `pressure` above a threshold, with **hysteresis** (stepping back down needs pressure to fall 0.15 below the rung's threshold) and per-pair cooldowns:

| Rung | Threshold | Behavior | Who decides |
|---|---|---|---|
| 0 Avoid | — | keep distance, short replies | code |
| 1 Hostile talk | 0.2 | insults, warnings ("stay away from my farm") | Talking with a CC stance of `hostile` |
| 2 Demand / threat | 0.35 | "give me 5 iron or else", "leave or fight" (creates a *coercive commitment*) | CC (L2) |
| 3 Brawl | 0.5 | fight until one side **yields** (health ≤ the yield threshold, which depends on caution) | CC proposes, **code gate** confirms |
| 4 Lethal | 0.75, and in `live` also needs vengefulness or dominance ≥ 0.6 | fight to the death, no mercy | CC proposes, code gate confirms |

- **The code gate is mandatory for rungs 3–4.** The CC (L2) may *propose* `option: 'fight'` with `{target, intent: 'brawl'|'lethal', reason}`, but code rejects it unless `pressure` clears the rung's threshold. The reverse also holds: code never starts a fight on its own except for the reflex of self-defense or defending a high-sentiment ally (§4.5). This stops a small model from picking fights at random, and stops pure math from overriding the character.
- **Fleeing beats fighting** when `fearOf(X) > motive` in the middle of a fight. The reflex flees at the persona's yield or flee threshold.

### 17.6 Fight mechanics
- **Skills:**
  - `duel(target, {stopAtHealth})`, using mineflayer-pvp plus gear switching
  - `ambush(target)`: wait out of line of sight, attack when the target is alone or hurt
  - `retreat(toAllies|home)`
  - `groupAttack(target)`: engage when allies who committed are within 10 blocks; coordinated only by chat ("now!") and watching each other
- **Yield protocol (in chat, works with humans):**
  - A losing fighter at or below the yield threshold stops attacking, backs off and says something like "I yield"; Talking phrases it in their voice.
  - The winner sees the attacks stop plus the yield line (L1 classifier: `isSurrender`) and decides mercy with `mercy`, `resentment` and `rung`. Sparing → `outcome: spared`, often followed by a rung-2 demand (tribute).
  - Ignoring a yield is a grievance that witnesses note heavily: `betrayal` weight ×2 for everyone who saw it.
- **Attributing an attack (perception, code):** when `entityHurt(victim)` fires, the attacker is the nearest player within 4 blocks who swung an arm toward the victim within the last 400 ms. For arrows, use the nearest player holding a bow or crossbow in line of sight. PvP death messages confirm kills publicly.
- **Witnesses:** every agent that sees an attack updates its view of the attacker: fear +, sentiment − (unless it hated the victim), and a `grievance` if the victim was a friend. Witnesses may intervene if `sentiment(victim) ≥ 7` and fear allows (an ally-defense reflex).

### 17.7 Coercion, rulers and followers
- **Demands create coercive commitments.** A rung-2 demand ("bring me 10 bread every day") that the target agrees to *out of fear* becomes a §6.4 `Commitment` with `coerced: true`.
- **Compliance check** (target's CC): comply if `fearOf(demander) > resentment + pride`, where `pride = 1 − loyalty·0.5`. Each coerced payment adds a `coercion` grievance against the demander (small, but it accumulates).
- **Followers and leaders:**
  - An agent becomes a **follower** of X when it repeatedly complies, or chooses to join for protection (high fear of *others*, decent sentiment toward X).
  - Followers accompany X and defend X, which raises X's `perceivedPower`.
  - The **leader** role is inferred, as with Sid's roles: an agent with ≥ 2 followers or regular tribute. It's shown on the dashboard.
- **The tyranny loop:** a high-dominance agent that wins fights → its perceived power rises → others comply → it gains resources and gear and followers protect it → its power rises further. Meanwhile each coercion adds resentment across the population.

### 17.8 Gossip, conspiracy and overthrow
- **Grievance sharing:**
  - When two agents with good sentiment toward each other talk and both resent the same third party, Talking may bring it up ("X took my iron too"). This is driven by a CC packet hint: "you and Y share a grudge against X".
  - Hearsay grievances are stored with `told_by` and half weight, but they raise *shared awareness*: `knownResenters(X)`, the set of agents I believe resent X.
- **Coalition logic (CC + code):**
  - `coalitionPower(X) = Σ myPower + power of knownResenters I trust (≥ 0.5) and believe willing`.
  - When `coalitionPower(X) > perceivedPower(X) + followersOf(X)·k`, *or* when X is seen alone or hurt, an agent with ambition, vengefulness or loyalty to the victims may **propose an uprising** in chat. That becomes a commitment of `kind: 'fight'` with `{target: X, when/where}`.
  - Agreement is recorded per agent, just like any other commitment.
- **Execution:** the agents meet up (a `meet` commitment), then `groupAttack`. Followers of X choose sides using `loyalty`, `fearOf(X)` vs. `fearOf(coalition)`, and sentiment. **Defections** happen when the coalition looks stronger.
- **Afterwards:**
  - If X dies (hardcore = gone), there's a power vacuum. The high-ambition agents in the coalition may compete next, which is the natural cycle.
  - If X wins, survivors' fear of X jumps and the rebels collect grievances that last a long time.
  - Bystanders' sentiment and fear update from what they saw.
- **Fear of death cuts both ways:** in `live` mode, rebellion is risky. Uprisings need a stronger coalition margin (`k_live = 1.3`) and usually wait for a moment of weakness. This is what makes a tyrant last "for a while".

### 17.9 Humans
Everything here applies to human players the same way: they can be targeted, coerced, recruited into coalitions, or become tyrants themselves. Bots only judge them by what they see and hear. **Hardcore warning for the owner:** in `live` mode a bot that hates you may really kill you. `conflict.lethalVsAll` stays on because there's no human/AI split, but you can turn conflict down globally (§17.10).

### 17.10 Config and safety valves
```yaml
conflict:
  enabled: true
  maxRung: 4                  # 3 = brawls only (no lethal), 2 = words & demands only
  pairCooldownSec: 300        # after a fight between A and B
  maxConcurrentFights: 2      # world-wide (Hub only counts fights from logs; it never tells bots)
  newcomerGraceSec: 600       # a newly spawned agent won't *initiate* rung ≥3 (own behavior only)
  extinctionBrake:            # meta-dampener if the world spirals
    deathsPerHourMax: 4       # above this, supervisor raises every agent's caution baseline +0.2 for 1 h
  griefing: false             # destroying others' builds as an escalation (rung 2.5); off by default
```
- The extinction brake changes only each agent's *own* caution parameter (like a mood), never what it perceives. Every application is logged.
- `maxConcurrentFights`: when the limit is reached, the code gate rejects new rung-3+ proposals, which are queued as rung 2 instead. Pairs already fighting aren't affected.

### 17.11 Module and prompt changes
- **CC bottleneck packet** gains: for each nearby person, a compact `[sentiment, resentment, fearOf, allegiance, topGrievance]`; the current conflict rung with each; and `knownResenters` for anyone I resent.
- **Decision schema** gains `option: 'fight' | 'demand' | 'yield' | 'recruit'` and `fight?: {target, intent: 'brawl'|'lethal', withAllies: string[]}`.
- **Talking** gains `stance: 'hostile' | 'threaten' | 'yield' | 'rally'`. Personality governs tone, and the `mayCommit` rules still apply to threats and promises.
- **New code module `ConflictEvaluator`** (event-driven, no LLM) computes pressure, power and fear, and gates fight proposals.

### 17.12 Tests and metrics
- **Scenario I (clash):** two high-friction personas share a farm. Expected: friction rises, hostile talk, and at most a brawl ending in a yield. No lethal fight in `test` with `maxRung: 3`.
- **Scenario J (tyrant):** one high-dominance agent in iron armor and three weaker agents. Expected: demands, then compliance, then coerced commitments, then follower formation.
- **Scenario K (overthrow):** continue J. When the tyrant goes out alone at low health, an uprising should be proposed, agreed and carried out within about 20 minutes of the opportunity. Some followers defect.
- **Scenario L (fear wins):** the same resentment as K, but the tyrant always travels with two followers. Expected: no uprising, and grumbling in chat only.
- **Metrics:** fights per hour by rung, yields vs. kills, leader tenure (time with ≥ 2 followers), coups, coalition sizes, defection rate, and resentment distribution over time.

### 17.13 Milestone placement
- **M6b Conflict core:** perceived power, fear, grievances, friction, the evaluator, rungs 0–3, the yield protocol, and scenario I. This comes after M6, because it needs commitments and the social model.
- **M8b Power structures:** coercion, followers and leaders, gossip, coalitions, rung 4, and scenarios J, K and L. This comes after M8 (social goals).

---

## 18. Human-like minds: emotion, bias, conformity, and rational override (v0.4)

**Goal:** agents feel things, act on impulse, hold unfair grudges, idolize people for shallow reasons, follow crowds, and reason through biased lenses, but they *can* catch themselves and correct. Each agent has its own mix of these tendencies, so outcomes differ from world to world.

**Design principle: two systems.**
- **System 1 ("gut")** is fast, cheap and biased. Implemented mostly in **code**, plus rare L1 impulse calls. It colors perception, emotions and quick reactions.
- **System 2 ("reason")** is the CC (L2) and Reflection (L3). It sees *both* the gut verdict and the evidence, and may override the gut. Whether it does depends on the agent's rationality and how calm it is right now.
- Agents aren't slaves to their biases, because System 2 can override them, and reflection can permanently correct beliefs (§18.6).

### 18.1 Persona additions (temperament core)
```yaml
big5:                 # 0..1 each; sampled per §20 (small average sex differences, large overlap)
  openness: 0.6
  conscientiousness: 0.4
  extraversion: 0.8    # replaces social.extraversion
  agreeableness: 0.5
  neuroticism: 0.7     # emotional volatility
mind:
  rationality: 0.5     # tendency/ability to reflect & override gut (need-for-cognition)
  impulsivity: 0.6     # likelihood of acting on emotion before thinking
  conformity: 0.5      # baseline susceptibility to group opinion/behavior
  vanity: 0.4          # weight on superficial cues (looks, gear, status, charisma)
  biasProfile:         # per-bias susceptibility multipliers 0..1 (sampled; gives uniqueness)
    halo: 0.7
    confirmation: 0.5
    negativity: 0.6
    ingroup: 0.5
    attribution: 0.5   # fundamental attribution error
    availability: 0.6
    authority: 0.4
    envy: 0.3
    sunkCost: 0.4
    selfServing: 0.5
    scapegoat: 0.3
```
- The persona generator samples these values independently, with occasional extremes, so the population contains zealots, skeptics, hotheads and stoics.
- §17 temperament (aggression, mercy, …) stays. Defaults correlate loosely with the Big Five, e.g. low agreeableness tends toward high aggression.

### 18.2 Emotions (code, cheap)
```ts
interface EmotionState {          // each 0..1, decays toward mood baseline
  anger: number; fear: number; joy: number; sadness: number;
  disgust: number; shame: number; envy: number; affection: number;   // + 'admiration' lives per-person (18.3)
  arousal: number;                // max-ish of the intense ones; drives impulsivity & blocks reflection
}
mood: { valence: number /* -1..1 */, baselineShift: number }  // slow EMA of emotions; hours-scale
```
- **Appraisal rules (code)** turn events into emotion deltas. Each delta is scaled by `(0.5 + neuroticism)` and modified by biases. Examples:

| Event | Effect |
|---|---|
| attacked | fear +, anger + (high aggression gets more anger, high caution more fear) |
| insulted | anger + (×(1 − agreeableness)), shame + (if the insult hits a known insecurity, an L2-written field) |
| given a gift | joy +, affection toward the giver + |
| a peer died | fear +, sadness + (scaled by sentiment toward them) |
| a rival succeeded | envy + (×`biasProfile.envy`) |
| rejected (romance, request) | sadness +, shame +, possibly anger |
| own goal achieved | joy + |
| repeated failure | anger + (frustration), sadness + |

- **Decay:** half-life of about 60–120 s for intense emotions, longer for sadness. High neuroticism decays more slowly.
- **Emotional contagion:** Perception reads the emotional tone of nearby speech (a cheap L1 sentiment classifier, batched) and visible behavior (fleeing, attacking). It nudges the agent's own emotions toward the crowd's, scaled by `conformity × extraversion`. This feeds mob behavior (§18.4).
- **Expression:** the current top emotion and its intensity go to Talking (tone, word choice, the occasional outburst, `*sighs*` emotes) and to body behaviors (storming off, sulking, refusing to talk, excited jumping, giving gifts when happy).

### 18.3 Superficial impressions, idolization and grudges
- **First impression** (on first sight or meeting) comes from superficial cues only: visible gear tier, a confident or funny speaking style (L1 rating on the first lines), name "vibe" (L1, once per name), and behavior seen in the first minute. That sets the starting `sentiment` and **`admiration`** (a new per-person field), weighted by `vanity` and `biasProfile.halo`.
- **Anchoring:** the first 2 interactions with someone count ×2 when updating sentiment and admiration.
- **Idolization:**
  - At high admiration (> 0.75), the halo effect discounts the idol's wrongs (grievance weight ×(1 − halo·0.7)) and boosts their claims' trust.
  - The agent imitates the idol: Goal Gen gets the hint "you admire X; X does Y", so it copies goals and style, defends them, and follows them more readily (which feeds §17.7 followers).
- **Disillusionment:** if the agent witnesses the idol commit a major wrong against itself or a friend, admiration may crash (probability ∝ rationality). The result is a resentful former fan, a common seed for uprisings.
- **Unfair grudges:** grievances can attach to the *wrong* target or to superficial reasons (scapegoating, §18.4). Negativity bias keeps them alive (negative deltas ×(1 + negativity·0.5)).

### 18.4 Biases as code transforms
Each bias is a small function applied to judgments before the CC sees them: `effect = baseEffect × susceptibility × (1 − override)`, where `override` is the System 2 factor (§18.5).

| Bias | Trigger | Effect (System 1) |
|---|---|---|
| **Halo** | admiration high, or impressive gear | trust and sentiment up; wrongs discounted |
| **Confirmation** | new evidence about X | evidence matching the current sentiment ×(1 + c), contrary ×(1 − c) |
| **Negativity** | any social update | negative deltas amplified |
| **In-group** | X shares a group (kin, partner, faction, coalition, followers of the same leader, same home area) | sentiment +, trust +; harm by an in-group member gets "circumstances" attribution |
| **Fundamental attribution** | an out-group or disliked X causes harm | logged as "X is bad" (a lasting grievance) rather than "accident" |
| **Availability** | recent vivid event (a death by creeper) | perceived danger of that cause inflated → avoidance, rumors |
| **Authority** | demand or request from a leader or idol | compliance threshold lowered |
| **Envy** | X visibly has better gear or more followers | resentment toward X + (×(1 − agreeableness)) |
| **Sunk cost** | the agent has invested in a task, relationship or loyalty | abandoning it needs extra pressure |
| **Self-serving** | own failure | blame goes to nearby others or luck; own success credited to self |
| **Scapegoat** | misfortune with an unknown cause, while fear is high | blame assigned to a disliked or out-group agent → grievance |
| **Bandwagon / conformity** | heard opinions about X from several people, or seen group behavior | own opinion and behavior pulled toward the majority (§18.4.1) |

#### 18.4.1 Conformity, which fear amplifies
- Every agent tracks **heard opinions**: when someone says something evaluative about X ("X is a thief", "the leader is great"), store `{speaker, target, valence}`. A cheap L1 classifier extracts these during conversation batching.
- **Social pull:** `pull = conformity × (1 + 1.5·fearLevel) × (1 − override)`
  - `fearLevel = max(emotion.fear, drives.caution − baseline, fearOf(currentLeader))`
  - The opinion target value is the average heard valence, weighted by each speaker's admiration and authority.
  - The agent's sentiment toward X moves toward that average by `pull × 0.3` per update.
- **Behavioral conformity:** if ≥ 60 % of visible agents are doing the same social action (fleeing, attacking X, paying tribute, celebrating), the agent's probability of joining is `pull`. CC proposals that deviate from the group need System 2 to justify them.
- **Fear makes people conform:**
  - Under a feared leader or after deaths, `pull` rises: dissent goes quiet, people echo the leader's opinions and grievances aren't voiced.
  - When fear falls (the tyrant looks weak, a dissenter defies them successfully), `pull` drops and suppressed resentment comes out as open dissent, which is the preference-cascade trigger for §17.8 uprisings.
  - **Dissenters:** low conformity, high openness, high rationality. They're often the first to speak out, at personal risk.

#### 18.4.2 Mob mentality
- A **crowd** forms when ≥ 3 agents within 16 blocks share a target and their average anger toward it is ≥ 0.5.
- **Deindividuation** in a crowd:
  - `witnessCost` → ×0.3 (other people are the witnesses, and complicit)
  - `fearOf(target)` → ×(1 − 0.15·crowdSize)
  - anger contagion ×1.5
  - the conflict rung threshold for crowd members → −0.1
- The outcome is mob escalation: shaming, then chasing, then fighting.
- **Breaking the mob:** a respected member (high admiration) arguing against it in chat, a high-rationality member's System 2 override, the target yielding or fleeing, or the crowd scattering. Afterwards each member's Reflection may produce **shame or regret** (§18.6).

### 18.5 Impulse and rational override
- **Impulse path:** when `arousal > 0.7` and `random < impulsivity·arousal`, a **fast L1 impulse call** (or a canned code action for common cases) runs *before* the CC. It can choose only from a restricted set: outburst line, storm off, one punch (a rung-3 action limited to a single hit, still passing the §17 code gate at threshold −0.15), impulsive gift, refuse to talk, flee. This is "acting on emotion".
- **Override factor (System 2):**
  `override = rationality × (1 − arousal·0.7) × timeFactor × (1 − crowdSuppression)`
  - `timeFactor` grows with seconds since the triggering event: anger cools, and thinking it over helps.
  - `crowdSuppression = 0.3` inside a mob.
- **CC sees gut and facts side by side.** For any judgment that matters (attack, comply, trust, accuse, romance), the bottleneck packet shows both:
  ```
  GUT: you despise Bram (anchored first impression; envy of his armor; the group says he's a thief)
  FACTS: Bram kept 3/3 promises to you; you never saw him steal; the claim came from Lira (trust 0.4)
  ```
  The CC prompt states plainly that the agent *may* follow its gut, as humans do, or reason past it, and asks it to stay in character with its rationality level. The code applies the final mix: `effectiveJudgment = lerp(gut, facts, override)`. The LLM's choice can move it by ±0.15, so a rational agent can still have a bad day.
- **Regret and repair:** when an impulse or mob action is later judged wrong (reflection, or arousal falling below 0.3 together with contradicting evidence), shame rises and the CC gets the option to apologize or make amends (a gift, returning an item). The apology is then recorded in the other person's social model, where it may or may not be accepted depending on their vengefulness and biases.

### 18.6 Reflection as debiasing (L3, periodic)
- **Bias audit,** every 10–15 minutes or after a big emotional event once arousal is low: L3 reviews top relationships and beliefs against evidence (source-tagged memories). It outputs corrections, e.g. "My hatred of Bram rests on hearsay; reduce resentment" or "I've idolized Kai blindly; he betrayed Nona."
  - Each correction is applied with probability `rationality`, and stubborn personas resist.
  - Corrected beliefs gain **inoculation**: the same bias on the same target has ×0.5 susceptibility for the rest of that life.
- **Growth:** repeated self-corrections slowly raise that agent's `rationality` (+0.02 each, up to persona + 0.2). Repeated mob participation without reflection slowly raises `conformity`. Personalities drift with experience.

### 18.7 Community-level effects (expected emergent patterns, not scripted)
- **Factions:** in-group bias plus bandwagon effects split the community into rival groups.
- **Celebrity and personality cults:** the halo effect plus authority bias around a well-geared, charismatic agent.
- **Rumor cascades and scapegoating** after deaths, amplified by fear and availability bias.
- **Silent majorities under tyranny,** followed by sudden preference cascades when fear drops (§17.8).
- **Feuds** passed on through families (§19) and gossip.
- **Dashboard:** heatmaps of sentiment and admiration, opinion-cluster plot, fear index over time, mob events, overrides vs. impulses per agent.

### 18.8 Cost control
Almost all of §18 is code: appraisal, decay, bias transforms, conformity math. The added LLM use is:
- batched L1 classification of evaluative or emotional speech (piggybacks on the conversation-batching call)
- rare L1 impulse calls (capped at 1 per agent per minute)
- the L3 bias audit (folded into the existing Reflection cadence)

### 18.9 Tests
- **M (halo):** a stranger in diamond armor vs. one in leather, both behaving the same. High-vanity agents rate the diamond one higher at first, and the gap shrinks after 5 interactions for high-rationality agents.
- **N (mob):** 3 agents angry at X and 1 neutral observer. With low rationality and high conformity, the observer joins. With high rationality and evidence that X is innocent, the observer objects in chat.
- **O (debias):** a scapegoat grudge from hearsay. After a bias audit, a high-rationality agent's resentment drops and a low-rationality agent's persists.
- **P (fear → conformity):** under a tyrant, the variance of opinions agents state about the tyrant shrinks while fear is high. When the tyrant visibly weakens, dissenting statements go up.
- **Q (impulse):** an insult to a high-neuroticism, high-impulsivity agent produces an outburst or a single punch within 2 s. The same insult to a stoic gets a measured reply.

---

## 19. Sex, romance, reproduction and families (v0.4)

### 19.1 Sex
- Each spawned (not born) agent gets `sex: male | female`. The supervisor keeps **spawned** agents split 50/50; births are random 50/50 (§19.4).
- **(v0.5) What sex affects:**
  - **Personality, slightly and on average:** trait *sampling means* are shifted a little by sex (§20). Individual variation is much larger, so any trait level can occur in either sex.
  - **Not** skills, roles, intelligence or combat (§21). Minecraft has no physical differences between players.
  - Also self-identity and pronouns, attraction and reproduction pairing.
  - Prompts never say "as a man/woman you…". Behavior comes from the sampled traits, not from sex labels.
- `orientation` is in the persona (default distribution configurable; romance targets follow it).
- **Perception of others' sex:** bots don't know it automatically. That includes humans: no human/AI split, no sex lookup. `SocialProfile.perceivedSex: 'male' | 'female' | 'unknown'` is inferred from self-introductions, pronouns others use, and names (L1 extraction during conversation batching). Agents mention their own when natural ("I'm a guy who loves mining").

### 19.2 Attraction and romance
- `SocialProfile` gains `romanticInterest` (0..1) and `relationship: 'none' | 'crush' | 'courting' | 'partner' | 'ex'`, plus a kin field (§19.5).
- **Attraction** applies only to persons compatible with the agent's orientation, or of unknown sex (cautious):
  `attraction = vanity·superficial (gear, style, first impression) + (1 − vanity)·compatibility + sharedTime + gifts`
  - `compatibility` is computed by L2 at the first post-conversation update and refreshed occasionally.
  - The agent judges similarity in values and humor, and complementary energy, **from what it has perceived of the other person.**
- **Stages and behaviors:**
  1. **Crush:** blushing-style emotes, seeking proximity, nervousness (joy and shame both up near them), idolization biases kick in.
  2. **Courting:** compliments, small gifts (flowers, food), shared activities via `meet` and `help` commitments, flirtatious tone in Talking (**PG only**, §19.6).
  3. **Proposal to partner:** a chat proposal plus a CC decision by the *other* person. **Each side decides independently.** Rejection → sadness and shame; low-agreeableness or high-vanity agents may turn it into resentment.
  4. **Partner:** shared home (place beds and a chest together), resource sharing, a strong defend reflex (sentiment ≥ 9), joint goals. In-group bias at its maximum.
  5. **Jealousy:** when my partner spends a lot of time with, or exchanges gifts with, someone whose `romanticInterest` toward my partner I suspect, then envy and anger rise and a grievance forms against the rival (possibly a §17 conflict).
  6. **Breakup:** sentiment < 5 sustained, betrayal, neglect (no shared time for N in-game days), or partner coercion → `ex` (a lingering complicated sentiment).
- **Grief:** a partner's death → sadness at maximum, slow decay, possible revenge motive (`killed_partner` grievance, effectively permanent), and caution changes.

### 19.3 Reproduction conditions (code gate; both agents must independently consent)
All of these must hold:
- the couple is `partner` for ≥ 2 in-game days, with mutual sentiment ≥ 8 (each side checks its own)
- a chat proposal ("want to start a family?") is accepted by the *other* agent's CC
- they share a home: two adjacent beds within 16 blocks of their shared chest, and enough food in it (≥ 20 food items) or in their inventories
- **ritual:** both sleep in the adjacent beds on the same night. The sleep event plus proximity triggers a `conception` log event to the Hub.
- population < `population.maxAlive`
- the couple's cooldown has passed (default 2 real hours) and neither is in a youth phase

**Birth:** after `gestationSec` (default 600 s real time), the supervisor spawns the child at the parents' beds. Both parents get a public chat notice from the child joining ("Hi mom, hi dad!"), so it's perceived like anything else.

**A human in a couple:** works the same way. The human proposes or accepts in chat and sleeps in the bed. The child's traits blend the bot parent's persona with the bot parent's *perceived* model of the human (the human's real traits are unknown to the system). The supervisor may know who's human for infrastructure; **the bots never learn it.**

### 19.4 Inheritance (new agent from the parents' traits)
- **Numeric traits** (Big Five, mind, biasProfile, temperament, caution baseline): `child = choose(parentA, parentB, mean) + N(0, 0.08)`, with a 10 % chance per trait of a large mutation (`N(0, 0.25)`), clamped to [0, 1].
- **Discrete traits:** speech style is a blend (L3 writes a new style from both parents' styles). Values and quirks: each parent's item is kept with probability 0.5, plus one new random quirk. Life goals are new (L3), optionally inspired by the parents' goals.
- **Sex:** 50/50 random. **Orientation:** sampled from the config distribution.
- **Name:** player-style, ≤ 16 characters. The family name is passed on through the persona field `familyName`, and the username is built as `<Given>_<FamilyInitial>` or similar. It's always unique.
- **Starting knowledge** (birth facts, the same as a human child would have): the parents' names, siblings, home location, sentiment toward parents 9 and siblings 7, admiration toward parents 0.8, and the in-group set to the family. **No inherited memories.** The child learns the family's grudges, alliances and history only from what parents and others tell it, so feuds and dynasties spread through talk.

### 19.5 Families and the youth phase
- `SocialProfile.kin: 'parent' | 'child' | 'sibling' | 'partner' | 'grandparent' | null`. Kin are in-group with the strongest in-group bias, and the defend reflex is stronger.
- **Youth phase** (first `youthSec`, default 30 min real time):
  - The child prefers following a parent and has `maxRung` 1 (no fighting except fleeing).
  - Conformity ×1.5 toward parents; parents' opinions count ×2 in its heard-opinion pool. This is how culture and grudges transmit.
  - Parents' Goal Gen gets the hint "teach/protect your child": they share food, guide it, and warn it about dangers.
  - The newcomer grace period (§17.10) applies.
- **After youth,** biases toward parents decay to normal and the child can rebel. High openness and low conformity children may reject their parents' feuds (disillusionment can apply to parents too).
- **Dynasties:** a tyrant's children may inherit admiration, followers' loyalty and enemies. Children of the overthrown may carry `killed_parent` grievances for a lifetime of revenge.

### 19.6 Content rules (romance)
- Romance is **PG**: affection, compliments, gifts, holding hands or hugging as emotes, spending time together, commitment. **No sexual content, innuendo, or explicit descriptions** in any prompt or output. Reproduction is an abstract event (the bed ritual, then a birth notice), never described.
- This is enforced in three places: the Talking/CC system prompts, a code output filter (keyword and L1 safety check before `bot.chat`; regenerate once, else fall back to a neutral line), and the persona generator.
- No romance toward or by agents in a youth phase. Romance requires both sides to be adults (`aliveSec > youthSec` for born agents; spawned agents are adults).
- **(v0.5) Rejection and unwanted advances vary like human reactions.** The old hard lock is replaced by §19.10. A soft persistence cap is kept: chat content stays PG even when the reaction is anger or violence.

### 19.7 Population config (replaces `agents.count` in §16.2)
```yaml
population:
  initial: 6             # spawned at world start, 50/50 male/female
  minAlive: 4            # supervisor spawns replacements (balanced sex) when below this
  maxAlive: 12           # births blocked at/above this
  spawnStaggerSec: 20
  respawnDelaySec: 60
romance:
  enabled: true
  orientationDist: { hetero: 0.85, homo: 0.07, bi: 0.08 }   # owner-configurable
  partnerMinDays: 2
reproduction:
  enabled: true
  gestationSec: 600
  coupleCooldownSec: 7200
  youthSec: 1800
  minFoodItems: 20
```
- For a fixed count like the original "1 or 10 bots", set `initial = minAlive = maxAlive = N` and `reproduction.enabled: false`.

### 19.8 Tests
- **R (courtship):** two compatible agents of the right orientations progress through crush, courting and partner within about 3 in-game days. All chat passes the PG filter.
- **S (rejection):** a proposal is declined. The suitor gets the harassment lock and its sadness rises. A low-agreeableness suitor builds resentment.
- **T (reproduction):** all gate conditions are met, then the bed ritual, then a birth after gestation. The child's traits fall within the parents' ranges ± noise. Kin fields and starting knowledge are correct, and the child has no memory DB inherited.
- **U (feud transmission):** a parent with a grudge against X talks to the child during the youth phase. The child's sentiment toward X drops without any direct contact with X. A high-openness child may later revise it after interacting with X.
- **V (jealousy):** a third agent courts one partner. The other partner's envy and anger rise and a grievance forms against the rival.

### 19.9 Milestone placement
- **M6a Emotions and biases core** (§18.1–18.5): before M6b conflict, because conflict uses anger, fear and mobs.
- **M8c Reflection debiasing and conformity dynamics** (§18.4.1, §18.6): with M8b power structures.
- **M9a Romance** (§19.1–19.2, §19.6), then **M9b Reproduction and families** (§19.3–19.5, §19.7). This comes after M8, because it needs homes, commitments and social goals. The original M9 (skill writer) becomes M10.

### 19.10 Reactions to advances and rejection (v0.5)
Reactions are **rolled from a trait-weighted distribution**, not fixed. Code picks the reaction category and Talking/CC carry it out in character.

**A. Being approached (the recipient's reaction to an advance):**
| Reaction | Base weight | Raised by | Effect |
|---|---|---|---|
| Flattered / reciprocates | attraction-driven | attraction, admiration, joy | romanticInterest + |
| Polite decline | 1.0 | agreeableness, conscientiousness | small sentiment − toward the suitor if repeated |
| Indifferent / ignores | 0.5 | low extraversion, low attraction | none |
| Uncomfortable | 0.4 | neuroticism, low sentiment toward the suitor | fear + small, avoidance |
| **Disgusted** | 0.15 | low sentiment, low attraction, vanity (suitor's status low), friction | disgust +, sentiment −1..−2, `unwanted_advance` grievance; may mock the suitor publicly (shaming that others hear → the suitor's reputation, and the suitor's shame) |
| Hostile | 0.05 | high aggression, existing resentment | anger +, may escalate via §17 (rung 1–2) |

**B. Being rejected (the suitor's reaction):**
| Reaction | Base weight | Raised by | Effect |
|---|---|---|---|
| Graceful acceptance | 1.0 | agreeableness, rationality, low vanity | sadness + small, decays |
| Sad withdrawal | 0.6 | neuroticism, high romanticInterest | sadness +++, sulks, avoids the person for a while |
| Persistence | 0.3 | low agreeableness, high romanticInterest, low intelligence (§21: misreads signals) | one or two more attempts (soft cap, below) |
| **Jealousy toward a perceived rival** | 0.25 (only if a rival exists: the target spends time or trades gifts with someone) | envy bias, vanity, romanticInterest | envy and anger toward the rival, a `romantic_rival` grievance; may sabotage or confront the rival (§17) |
| Resentment toward the rejecter | 0.2 | vengefulness, low agreeableness, a public rejection (shame) | sentiment −2, a lasting `rejection` grievance |
| **Rage → attack** | 0.04 | aggression × impulsivity × arousal, public humiliation, low combat-fear (§21) | impulse path (§18.5): outburst, then a rung-3 attack through the §17 code gate (threshold −0.15 for impulse). Witnesses treat it as a serious wrong: big reputation hit, grievances, possible mob against the attacker |

- **How to roll:** `w_i = base_i × Π(trait modifiers)`, normalize, then sample. Current emotions (anger, shame) and context (rejected in front of others? drunk on success?) multiply in. **System 2 may veto** the two violent or hostile options with probability `override` (§18.5), as with any impulse.
- **Soft persistence cap:** at most `1 + round(2 × (1 − agreeableness))` further attempts per target per in-game week. After that, romantic advances to that target are suppressed by code for that week. Each extra attempt makes rejection reactions harsher (the recipient's discomfort, disgust and hostility weights ×1.5 per attempt). This cap applies to humans and bots alike, so a persistent suitor can't pester a human player indefinitely.
- **Others notice:** spurned lovers, love triangles and public humiliations become gossip (§18.4.1 heard opinions), shaping reputations.
- **Content:** all of this stays within §19.6. Disgust or mockery is expressed without sexual content, slurs or explicit insults about bodies. Anger can be harsh but PG-13 at most.
- **Tests:**
  - **W (rejection variety):** 100 simulated rejections over a sampled population. The reaction histogram is mostly graceful or sad, with a minority of jealousy and resentment, and rage at ≤ 5 %. Rage cases correlate with high aggression × impulsivity.
  - **X (disgust):** a low-status, disliked suitor proposes to a high-vanity target. Disgust is frequent, and the suitor's shame rises when it's public.

---

## 20. Average personality differences by sex (v0.5)

**Principle:** psychology research shows **small to moderate average** differences between men and women on some traits, with **large overlap**: most individuals of either sex fall in the shared range. We model exactly that, with a shift in the *mean* of the sampling distribution, the same standard deviation, and individual variation dominating. Skills, roles, intelligence and combat ability are **not** affected (§19.1, §21).

**Sampling:** each 0..1 trait is drawn as `clamp(N(μ_sex, σ=0.18))`, with `μ_sex = 0.5 ± d·σ/2`. Here `d` is an approximate published effect size (Cohen's d, positive = higher in women) and the mean shift is `d·σ/2` in each direction. `config.sexDifferences.scale` (default 1.0; 0 disables, 0.5 halves) multiplies all `d`.

| Trait (our field) | approx. d (women − men) | Notes |
|---|---|---|
| neuroticism | +0.40 | anxiety, emotional volatility (Costa et al. 2001; Weisberg et al. 2011) |
| agreeableness | +0.40 | warmth, compassion, politeness |
| extraversion | +0.10 | mixed facets: women warmer and more sociable, men more assertive and excitement-seeking |
| openness | ~0.00 | facets differ (women aesthetics and feelings, men ideas); net about 0 |
| conscientiousness | +0.10 | small (orderliness) |
| aggression (§17) | −0.50 | physical aggression higher in men on average (Archer 2004); verbal and indirect aggression close to 0 |
| dominance (§17) | −0.30 | assertiveness facet |
| caution / risk-aversion (§16.3) | +0.30 | men higher risk-taking on average (Byrnes et al. 1999) |
| mercy (§17) | +0.20 | linked to agreeableness and empathy |
| impulsivity (§18) | −0.10 | sensation-seeking higher in men; general impulsivity small |
| vanity (§18) | ~0.00 | no reliable overall difference, so 0 |
| envy, conformity, rationality, intelligence, combat | 0.00 | not shifted |

- **Implementation:** a table in `config/sex-differences.yaml` with the `d` values above. The persona generator applies them before L3 writes the persona's prose description. The prose is written from the *numbers*, never from the sex label.
- **Inheritance (§19.4):** a child's traits come from its parents and noise, then the child's own sex shift is applied at half strength (`d/2`). This avoids the shifts compounding over generations while still reflecting the child's sex.
- **Calibration check:** for a generated population of 1000, the measured d per trait should be within ±0.05 of the table × scale, and the overlap coefficient for neuroticism and agreeableness should be about 0.8–0.85.
- **Values are approximate** and taken from widely cited meta-analyses. The implementer should treat them as tunable config, not truth. The owner can adjust `scale` or individual `d` values.

---

## 21. Intelligence and combat ability (v0.5)

Two new stats per agent, rolled at creation or birth. **Neither is affected by sex.**
```yaml
abilities:
  intelligence: 0.55    # 0..1  ~ N(0.5, 0.17) clamped; inherited (21.3)
  combat: 0.30          # 0..1  ~ N(0.4, 0.2)  clamped; inherited partly, trained (21.3)
```
Talking describes these qualitatively only ("sharp", "slow to catch on", "a natural fighter"). They aren't shown to other agents. **Others must infer them** from what they see (§21.4).

### 21.1 Intelligence: ability to use logic
Intelligence is **ability**. `mind.rationality` is the **disposition** to reflect. They're different: a smart agent can still be impulsive, and a dull one can be careful.

| Lever | Low intelligence (≈0.2) | High intelligence (≈0.8) |
|---|---|---|
| **CC model tier** | CC runs on the **L1** model | CC on L2. Planning bursts on L3 when a goal is complex |
| **Bottleneck capacity** (working memory) | 3 retrieved memories, 2 tasks visible, 3 nearby people | 6 memories, 5 tasks, 6 people |
| **Planning horizon** | task queue depth 2, re-plans often | depth 6, anticipates needs (tools, food, light) |
| **Option generation** | CC considers 2 candidate options | 4 candidates, with a pros/cons note |
| **System 2 strength** | `override` × (0.5 + intelligence) | override strong when rationality allows |
| **Execution errors** | ~8 % chance per task of a slip (wrong tool, forgets to bring food, inefficient path); code-injected | ~1 % |
| **Recipe knowledge** | starts knowing basic recipes only, learns new ones by being told or shown (§21.2) | starts with more; can *figure out* recipes by experimentation |
| **Claim and lie checking** | rarely notices contradictions in what others say | code cross-checks claims against memory with probability ∝ intelligence; detects lies and inconsistency |
| **Deception and persuasion** | crude lies, easily caught | plausible lies, better persuasion (gets a "consider their incentives" prompt section) |
| **Social signal reading** | misreads hints (raises persistence, §19.10; misses hostility cues) | reads intentions well (better `theirStanceGuess`) |
| **Bias susceptibility** | slightly higher (×1.1) | slightly lower (×0.9); most biases aren't cured by intelligence alone |
| **Speech** | simpler vocabulary, shorter sentences | richer vocabulary, explains reasoning |
| **L3 skill writer** | never | allowed (intelligence ≥ 0.7) |
| **Reflection cadence** | 25 min | 8 min |

- **Cost side effect:** less intelligent agents are **cheaper** (L1 CC, shorter packets). The population's average intelligence sets the API bill, so log $/hour by intelligence band.

### 21.2 Knowledge gating and teaching
- `state.knowledge.recipes: Set<string>`. The Skill Executor refuses crafting recipes not in this set. mineflayer knows them all, but the agent doesn't.
- **Starting knowledge:** a base set (planks, sticks, crafting table, wooden tools, torch). Extra recipes are `round(10 × intelligence)` drawn from the next tech tier.
- **Learning:**
  - **Told:** someone explains a recipe in chat. An L1 extractor parses it, and it's learned with probability `0.5 + 0.5·intelligence`.
  - **Shown:** the agent sees an item it hasn't seen in someone's hand, then asks.
  - **Experimentation:** a high-intelligence idle agent spends time to "discover" a recipe; success probability per attempt is ∝ intelligence².
- **This creates real social value:** smart agents become teachers, advisors or schemers. Knowledge is power, which ties into §17 power, and parents teach children (§19.5).

### 21.3 Combat: knowledge, technique and fear
Combat in Minecraft is pure skill and knowledge (no physical disparity), so `combat` controls **which techniques the agent knows and how well it executes them**:

| Tier | Combat range | Techniques available to the `duel`/`groupAttack` skills |
|---|---|---|
| Novice | < 0.3 | spam clicking, no shield, chases blindly, poor target choice, slow to eat mid-fight |
| Trained | 0.3–0.6 | attack-cooldown timing, jump crits, shield blocking, eating and retreating at low health, picks the right weapon |
| Veteran | 0.6–0.85 | strafing, sprint-reset knockback (w-tap), bow kiting, uses terrain (high ground, chokepoints), focus-fires the weakest, baits into allies |
| Master | > 0.85 | all of the above plus reading the opponent's gear and health trend, disengage-and-reengage timing, potions, ambush setups, pearl escapes if available |

- **Execution quality:** reaction jitter = `400 ms × (1 − combat) + 50 ms`, plus aim and timing noise ∝ (1 − combat).
- **Fear damping (the tactical mind):**
  - The fear appraisal from combat events is ×(1 − 0.6·combat).
  - Arousal during fights is capped at `1 − 0.5·combat`.
  - So **System 2 stays online in fights for skilled fighters**: they decide by calculation (engage, disengage, call allies, pick the moment) instead of panic. Novices are more likely to panic-flee or freeze (random wasted ticks), *or* to overcommit when angry.
  - High combat **doesn't mean reckless.** `drives.caution` still feeds deterrence (§17.5), but the *emotional* fear term shrinks. A master fighter avoids bad fights calmly and takes good ones decisively.
- **Self-assessment:** `myPower` (§17.4) includes `combat` honestly for high-intelligence agents. Low-intelligence agents misjudge it by `N(0, 0.2·(1 − intelligence))`, sometimes overconfident (Dunning-Kruger-ish), which leads to bad fights and humbling.
- **Growth:** `combat += 0.01` per fight survived (+0.02 if won against a stronger opponent), capped at `birthValue + 0.25`. Sparring with kin or allies at brawl rung with no grievance gives +0.005 per session. So veterans emerge from experience.
- **Inheritance:** `intelligence_child = 0.5·mean(parents) + 0.5·N(0.5, 0.17)` (about half heritable, regressing toward the mean). `combat_child` at birth is `0.3·mean(parents) + 0.7·N(0.4, 0.2)`, and parents with combat ≥ 0.6 who spar with the child during the youth phase add up to +0.15.

### 21.4 How others perceive these abilities
- **Perceived combat** `SocialProfile.estCombat` is updated from fights the agent *witnessed* (hits landed vs. taken, techniques seen such as shield or crits), kills announced publicly, and gossip (hearsay, half weight). It feeds `perceivedPower` (§17.4).
- **Perceived intelligence** `SocialProfile.estIntelligence` is updated from conversation quality (an L1 rating, batched), recipes they know or teach, plans that worked, and lies caught (catching someone lying lowers trust but raises estimated cunning).
- **Social effects:**
  - Admiration (§18.3) is partly driven by perceived competence. The halo from a great fighter or a clever teacher creates idols and leaders.
  - Envy (§18.4) targets the more capable.
  - Expected archetypes (emergent, not scripted):
    - **Warlord:** high combat × high dominance.
    - **Advisor or puppet-master:** high intelligence × low combat × high ambition.
    - **Rebel strategist:** high intelligence × high resentment, organizing a coalition against a stronger brute.
    - **Village fool:** low intelligence × high agreeableness. Often liked, sometimes exploited.

### 21.5 Config and tests
```yaml
abilities:
  intelligence: { mean: 0.5, sd: 0.17, heritability: 0.5 }
  combat:       { mean: 0.4, sd: 0.20, heritability: 0.3, growthCap: 0.25 }
  intelligenceRoutesCCTier: true     # false = all CCs on L2 (more uniform, more cost)
  knowledgeGating: true
```
- **Y (intelligence):** low- vs. high-intelligence agents with the same goal ("get iron tools"). The high one finishes faster with fewer slips, and the low one asks others for recipes. Contradiction detection rates scale with intelligence.
- **Z (combat):** a duel between a novice and a veteran in equal gear. The veteran wins more than 80 % of the time. During the fight, the novice's fear and arousal are higher and its decisions more erratic, while the veteran's decisions show deliberate disengage and re-engage.
- **AA (perception):** after watching a veteran win twice, observers' `estCombat` for the veteran rises and their fearOf goes up, and conformity toward the veteran rises if it leads.

### 21.6 Milestone placement
- **M3b (with the single-agent CC):** intelligence affects CC tier, packet capacity, planning horizon and slips. Knowledge gating and teaching come in M6, because teaching needs conversations.
- **M6b (with the conflict core):** combat tiers in the `duel` skill, fear damping, self-assessment, growth, and perceived abilities.
- **M9b:** inheritance of both abilities.

---

## 22. NanoGPT subscription lock (v0.6)

**Goal:** the system can **only** call models covered by the owner's NanoGPT subscription. It never bills the paid balance, and it survives NanoGPT changing its subscription lineup without crashing or silently paying. The lock has five layers, so no single mistake can cause a charge.

### 22.1 Layer 1: account-side lock (owner does this once)
- In the NanoGPT dashboard, set the API key's billing mode to **"Subscription only"**. Per NanoGPT's docs, requests the subscription doesn't cover are then **rejected instead of billed**. This is the backstop that holds even if our code has a bug.
- Optionally also set a per-key daily cap of $0.
- **Startup check:** call `GET /api/subscription/v1/usage`. If `routing.paidSpendPolicyAllowsBalance` is `true`, the key can spend balance: **refuse to start** with the message "Set your NanoGPT key to Subscription only (dashboard → API keys), or set `llm.allowPaidKey: true` to override." The default is to refuse.
- Also refuse if `active` is false or `state` is `inactive`. If `state: grace`, warn and continue.

### 22.2 Layer 2: subscription-only endpoints and forbidden request options
- **Base URL** for chat is `https://nano-gpt.com/api/subscription/v1`. It's hard-coded in `packages/llm/client.ts`, and config can't override it unless `llm.allowPaidKey: true`.
- The request builder **strips and asserts against** anything NanoGPT documents as bypassing the subscription:
  - the `X-Provider` header (explicit provider selection is always pay-as-you-go)
  - the `X-Billing-Mode` header and the `billing_mode` / `billingMode` body fields
  - explicit prompt-cache controls (`cache_control` blocks and similar; documented as pay-as-you-go)
  - `service_tier` values other than the default (`flex`, `fast` and `priority` can't be assumed to be covered)
- The lint rule plus a unit test: a grep in CI fails if any of these strings appear outside `client.ts`'s strip list.

### 22.3 Layer 3: model allowlist from the subscription list
- **Startup:** `GET https://nano-gpt.com/api/subscription/v1/models`, which NanoGPT documents as always returning only subscription-included models, gives the **allowlist**.
  - For capabilities (`tool_calling`, `structured_output`, `reasoning`, `context_length`, `max_output_tokens`), also call `GET /api/v1/models?detailed=true` and **join on `id`**. That call is metadata only (no inference, no billing). If `detailed=true` works on the subscription path, prefer that and skip the join.
- **The client refuses any model not on the allowlist.** `llm.call()` throws `ModelNotInSubscription` before sending. Nothing can call a model by a hard-coded ID that isn't on the list.
- **Resolving tiers:**
  - For each tier, use the configured `primary`/`fallbacks` IDs that are on the allowlist **and** have the tier's `need` capabilities.
  - `auto`, or every configured ID missing, picks from the allowlist using:
    1. the latest results of the §11 latency check (`config/model-bench.json`), when present
    2. otherwise heuristics: L1 = fastest or cheapest-listed with `structured_output`; L2 = mid; L3 = largest context or flagged `reasoning`
  - Each tier keeps an **ordered fallback chain of 3 or more allowlisted models**.
  - Log the resolved mapping at startup and show it on the dashboard.
- **Refresh:** re-fetch the allowlist every 6 h, and immediately after any rejection or "model not found" response.
  - If a model in use **disappears from the list**, hot-swap to the next model in that tier's chain, record a `modelSwap` event, and keep running.
  - If a tier has **no** allowlisted model left, map it to the next lower tier (L3 → L2 → L1). If L1 is empty too, all agents go **code-only** (§22.4).
- **Bench file hygiene:** `scripts/bench-models.ts` only ever benchmarks allowlisted models, through the subscription path, and only within the quota guard.

### 22.4 Layer 4: quota governor (budgets in tokens, not dollars)
- **Poll** `GET /api/subscription/v1/usage` every 5 min, and immediately after any 402/429/quota error. Read `weeklyInputTokens.{used,remaining,resetAt}`, `dailyInputTokens` (if limited), `degraded`, and `routing.recommendedMode`. **Never hard-code quota sizes**; NanoGPT says to use the returned limits.
- **Allocation:** `perAgentHourly = remaining / (activeAgents × hoursUntilReset × dutyCycle)`.
  - `dutyCycle` = `llm.expectedRuntimeHoursPerWeek / 168`, set by the owner in config (e.g. 20 h/week of play gives a much bigger per-hour budget than 24/7).
  - Spending follows module priority (Talking > CC > Social > Self-Monitor > Goal > Reflection).
- **Degrade ladder,** per agent and globally by `percentUsed` of the weekly quota:

| Weekly used | Action |
|---|---|
| < 70 % | normal |
| 70–85 % | Reflection and Goal Gen cadence ×2 slower, L3 → L2 |
| 85–95 % | Social Goal Gen off, Self-Monitor every 30 s, intelligence-routed CC tiers forced to L1 |
| 95–100 % | **code-only mode**: reflexes, skill continuation of the current plan, canned or emote speech, social and emotion math still runs (it's code) |
| `recommendedMode: unavailable` or `paygo` | code-only mode until `resetAt`. **Never switch to paid billing** (per NanoGPT's own guidance for subscription-only keys) |

- **Code-only mode should look natural in-game:** agents keep working and say short canned lines ("hmm", "busy", persona catchphrases). Dashboard banner: "Quota exhausted, resets at …".
- `degraded: true` (quota unknown): continue at the 70–85 % level until a successful poll.
- **Projected burn:** the dashboard shows tokens per hour by module, tier and agent, plus the projected exhaustion time against `resetAt`. Startup prints the projection for the configured population.

### 22.5 Layer 5: embeddings and other endpoints
- **Embeddings default to local** (`@xenova/transformers`), with no NanoGPT call.
- NanoGPT documents no subscription-only embedding list. Remote embeddings are enabled only if `llm.embeddings.provider: nanogpt` **and** the chosen embedding model appears in `GET /api/subscription/v1/models` (or a future subscription embedding list) **and** a test call through the subscription path succeeds with no balance change (check with `GET /api/v1/check-balance` before and after). Otherwise stay local.
- **Forbidden by default:** image, audio, video and moderation endpoints, and the Responses and Messages APIs. Only `/subscription/v1/chat/completions`, `/subscription/v1/models`, `/subscription/v1/usage`, and metadata `GET /api/v1/models?detailed=true` / `check-balance` are allowed. Each is checked by an allowlist in the HTTP layer.

### 22.6 Error handling (future-proofing)
| Response | Meaning (likely) | Action |
|---|---|---|
| 400/404 "model not found / not available" | lineup changed | refresh the allowlist, swap to the next model in the chain, retry once |
| 402 or "not covered / subscription only" rejection | uncovered model or quota issue | remove the model from this session's allowlist, poll usage, swap, retry once; if the quota is exhausted, go code-only |
| 429 | rate limit or quota | back off (exponential, jittered), lower the Hub token rate by 20 % for 10 min, poll usage |
| 5xx / timeout | provider trouble | next model in the chain (provider diversity preferred), circuit-break the model for 5 min after 3 failures |
| schema-invalid JSON | weak model | one repair retry, then the module's code default; if this happens often, mark the model `unreliable` for that tier |

Every swap, circuit-break or mode change is logged and shown on the dashboard. **No error path ever changes the base URL or adds billing or provider headers.**

### 22.7 Config
```yaml
llm:
  baseUrl: subscription            # fixed; 'paid' requires allowPaidKey
  allowPaidKey: false              # refuse to start if the key can spend balance
  expectedRuntimeHoursPerWeek: 30  # for quota allocation
  allowlistRefreshHours: 6
  usagePollSec: 300
  embeddings: { provider: local }  # local | nanogpt (§22.5 checks)
```

### 22.8 Tests
- **Unit (mocked HTTP):**
  - The client refuses a non-allowlisted model.
  - The request builder strips `X-Provider`, billing-mode fields and cache controls.
  - Allowlist removal triggers a hot-swap, and an empty L3 falls back to L2.
  - The quota levels trigger the degrade ladder, and `recommendedMode: paygo` → code-only.
  - Startup refuses when `paidSpendPolicyAllowsBalance: true`.
- **Live smoke test (M2):**
  - Check the balance, run 20 calls per tier, then check the balance again: it must not change.
  - Request a model from `/api/paid/v1/models` on purpose. It must be blocked locally before sending. With the client lock bypassed in a test-only harness, the subscription-only key must reject it.

### 22.9 Milestone placement
All of §22 belongs in **M2** (the LLM client), before any agent makes real calls. §22.4's dashboard parts come in M7.

---

## 23. Portability and headless remote hosting (v0.7)

**Goal:** the whole system (Minecraft server, Hub, bots, dashboard) is a self-contained project that runs the same on the owner's Windows PC and on a **remote Linux machine reached over SSH**, without a GUI, and can be moved between machines with its world and agents intact.

### 23.1 Self-contained and reproducible
- **Pinned toolchain:**
  - Node: `.nvmrc` plus `engines` in package.json
  - pnpm: through `corepack` (`packageManager` field)
  - Java: the JDK version Paper 26.1 needs (Temurin), checked at startup
  - commit `pnpm-lock.yaml`
- **No manual downloads.** `pnpm setup` (a Node script) downloads:
  - the **Paper** jar for the pinned version and build from the PaperMC downloads API, **verifying its SHA-256** against the value in `config/versions.yaml`
  - the **ProximityChat!** jar from the Modrinth API for the pinned version ID, with a hash check
  - the local embedding model (§22.5) into the cache

  Only these official sources are used. If a hash doesn't match, abort.
- **Scripts are Node/TypeScript only** (`scripts/*.ts` run through `tsx`). No bash or PowerShell scripts are needed. Use `path.join`, never hard-coded separators or absolute paths. `.gitattributes`: `* text=auto eol=lf`.
- **Native dependencies:** `better-sqlite3` has prebuilt binaries for Windows, Linux and macOS (x64 and arm64). `isolated-vm` (L3 skill sandbox) needs a C++ toolchain, so it's an **optional dependency**. If missing, the skill writer is disabled with a clear log line.
- **All mutable state lives under one `DATA_DIR`** (default `./data`, override with an env variable):
  ```
  data/
    server/        # Paper install, world(s), plugins/, server.properties (generated)
    agents/        # one SQLite DB per living agent + roster.json (who's alive, personas, usernames)
    graveyard/     # archived DBs of dead agents
    logs/          # pino JSON logs, rotated
    cache/         # embedding model, model allowlist, bench results
  ```
- Times are stored as UTC epoch milliseconds. No dependence on the local timezone or locale.

### 23.2 Two ways to run (choose per machine)
1. **Native:** `pnpm setup && pnpm start`. One supervisor process launches the Paper server (as a child process with `-Xmx` from config), the Hub, and N bot processes, with structured logs to the console and `data/logs`.
   - **On the SSH host:** run inside `tmux` or `screen`, or install the provided **systemd user unit** (`deploy/minecraft-agents.service`; `pnpm deploy:systemd` writes it with the correct paths). It starts on boot and restarts on crash.
2. **Docker (recommended for the remote host):** `deploy/Dockerfile` (Temurin JRE + Node, pinned) and `deploy/compose.yaml` mount `DATA_DIR` as a volume and read `.env`. `docker compose up -d` is the same on any Linux host and needs no Java or Node installed on the host.

### 23.3 Headless operation over SSH
- **No GUI anywhere.** `prismarine-viewer` is optional and served over HTTP.
- **Network binding (safe defaults):**
  - **Dashboard and Hub** bind to `127.0.0.1` only (ports configurable: dashboard 8080, Hub 8765).
  - **Minecraft** binds to `127.0.0.1` by default (`server-ip=127.0.0.1`), because `online-mode=false` means anyone who reaches the port can join under any name (§15.4).
- **Reaching it from your PC:**
  - **SSH tunnel (default):**
    ```bash
    ssh -L 25565:localhost:25565 -L 8080:localhost:8080 user@host
    ```
    Then connect your Minecraft client to `localhost:25565` and open `http://localhost:8080` for the dashboard.
  - **Private network option:** Tailscale or WireGuard, with `server-ip` set to the VPN interface. **Never** expose 25565 to the public internet with offline mode. `pnpm doctor` warns if `server-ip` is `0.0.0.0` or a public address.
- **Remote console and control:**
  - `pnpm ctl status|stop|restart|population <n>|mode test|live|say <msg>|rcon "<cmd>"` talks to the running supervisor over a local socket or RCON (password generated into `.env`). The operator never needs to attach to the server console.
  - Logs: `pnpm logs [--agent Pip] [--module cc]` follows the JSON logs with readable formatting.

### 23.4 Graceful shutdown, resume and migration
- **Shutdown** on SIGINT or SIGTERM, or `ctl stop`:
  1. each bot flushes its memory DB and writes its state snapshot (goals, commitments, emotions, social model) into its SQLite file
  2. the bots disconnect
  3. the supervisor runs `save-all`, then stops the server
  4. the Hub writes `roster.json`
- **Resume:** `pnpm start` reloads `roster.json` and reconnects **the same agents** with their memories. Time offline is handled as "time passed" (emotions decayed, commitments re-checked against deadlines). A reboot or machine move doesn't kill anyone.
- **Migration between machines:**
  - `pnpm export` → `export-<date>.tar.gz` of `DATA_DIR` (world, agents, graveyard, roster, config) **excluding `.env` and caches**.
  - Copy the file (e.g. with `scp`), then run `pnpm import <file>` on the other machine, then re-enter the API key in `.env`.
  - Export refuses while the system is running unless `--hot` is given, which forces `save-all` and DB checkpoints first.
- **Code transfer:** git (a private remote) or `rsync`. `DATA_DIR` and `.env` are gitignored.

### 23.5 Resources (planning numbers; measure in M5)
- **Paper:** 2–4 GB heap for up to about 12 players. Bots use a small view distance (`viewDistance: 'tiny'` in mineflayer), and `simulation-distance` is set modestly.
- **Per bot process:** about 150–300 MB RAM (mineflayer world cache plus Node). **Embeddings run once, in the Hub,** as a shared local service, not loaded in every bot. This is infrastructure, so it carries no information between bots (§16.1).
- **Rough total:** 3 bots ≈ 4–5 GB RAM; 10 bots ≈ 7–9 GB; 4+ CPU cores recommended. LLM work is remote, so no GPU is needed.
- `pnpm doctor` checks:
  - Node, Java and pnpm versions
  - free RAM vs. `population.maxAlive`
  - free ports and disk space
  - `.env` key presence and the subscription lock (§22.1)
  - plugin and jar hashes
  - unsafe network binding
  - write access to `DATA_DIR`

### 23.6 Milestone placement
- **M0** adds `pnpm setup` (pinned and hash-verified downloads), `DATA_DIR`, `pnpm doctor`, and localhost-only binding. **Exit test:** fresh clone → `pnpm setup && pnpm start` works on both Windows and a Linux SSH host.
- **M5** adds graceful shutdown and resume with `roster.json`.
- **M7** adds the `ctl`/`logs` CLI, the Docker files, the systemd unit, and export/import.

---

## 24. Implementation log and deviations

Findings from building the system, with reasons. Where this section conflicts with an earlier one, this section reflects what is implemented.

### M0 (2026-10-21)
1. **Versions (looked up live, §13 rule 11).** Paper **26.1.2 build 74** (STABLE, protocol 775) + mineflayer **4.39.0** (its `testedVersions` ends at `26.1`; 26.1, 26.1.1 and 26.1.2 are all protocol 775). The §15.1 smoke test (join, chat, dig, place, chest, craft, window clicks) passes on 26.1.2, so no drop to 26.1 was needed. Paper 26.1.2 requires **Java 25** (Fill API `java.version.minimum`). minecraft-data 3.117.0, minecraft-protocol 1.68.0.
2. **pnpm built-ins.** `pnpm setup`, `pnpm doctor` and `pnpm import` run pnpm's own commands, so the scripts are invoked as `pnpm run setup`, `pnpm run doctor` and `pnpm run import`. `pnpm start`, `pnpm ctl`, `pnpm logs`, `pnpm export` work as written.
3. **ProximityChat! 1.0.RELEASE format (§15.3 discovery).** The plugin cancels `AsyncPlayerChatEvent` and re-sends each line with `Player.sendMessage(String)`, i.e. as a *system* message, so parsing uses `messagestr`. Lines are `{player} » {message}`, prefixed `[Shout] `, `(Whisper) ` or `[Spy] `; the sender gets `* No one heard you... *` when nobody is in range (a human sees it too, so it is valid perception). Fading only recolors the text. Range is a same-world 3D distance check. We write the formats explicitly into the plugin config so parser and server agree by construction (`packages/shared/src/proximityChat.ts`); `pnpm chat-discovery` re-checks the format after plugin changes.
4. **Plugin defaults differ from §15.2**: shipped config has normal range 50, shout 200, fade start 25 %, cooldown off. We always write normal 15, whisper 5, shout 48, fade 60 %, cooldown 1 s from `config/world.yaml`.
5. **Disabling `/msg` etc. (§15.3).** Bukkit `permissions.yml` cannot override the vanilla `minecraft.command.*` defaults on Paper 26.1 (verified live: a non-op could still `/msg`). Instead of LuckPerms (which downloads its own runtime libraries on first start) we ship a ~40-line plugin, **`server-plugin/agora-guard`**, that cancels `/msg /tell /w /me /teammsg /tm` (including `minecraft:` forms) for non-ops and hides them from their tab completion. Ops keep them. The built jar is committed and its sha256 pinned in `config/versions.yaml`; `pnpm build:guard-plugin` rebuilds it reproducibly (needs a JDK 25 because the 26.1 API is class version 69).
6. **Gamerules were renamed in 26.1** (snake_case): `show_death_messages`, `show_advancement_messages` (also `advance_time`, `spawn_mobs`, `keep_inventory`, `immediate_respawn`, …). `time query daytime` became timeline-based (`time query day`).
7. **Hash-pinned downloads** (§23.1): Paper (sha256 from the PaperMC Fill v3 API, must equal the pinned value), ProximityChat! (sha512 from Modrinth), and the local embedding model (Hugging Face `Xenova/all-MiniLM-L6-v2` pinned to commit `751bff3…`, each file sha256-pinned, fetched by setup so nothing downloads at runtime). Hashes are quoted in YAML (an all-digit hash would otherwise parse as a number). Downloads also refuse non-official hosts, including after redirects.
8. **RCON** is enabled on 127.0.0.1 with a password generated into `.env` by setup. It is used only by operator tools (`ctl`, `save-all`) and test scenario setup, never to feed an agent.
9. **Toolchain pins**: TypeScript 6.0.3 (typescript-eslint 8.72 supports `<6.1`, so not 7.x); isolated-vm 6.1.0 as an optional dependency (7.x needs Node 24+); Node ≥ 22.12 (mineflayer, better-sqlite3 and vitest need 22+). `onnxruntime-node`'s postinstall (it fetches optional CUDA files from NuGet) is not run; its CPU binaries ship in the npm package.
10. **NanoGPT (looked up live).** `GET /api/subscription/v1/models?detailed=true` returns capabilities directly, so the `/api/v1/models` join of §22.3 is unnecessary. The usage response nests `degraded` inside each quota object and `percentUsed` is a fraction. NanoGPT's CORS allow-list advertises more billing-relevant headers than §22.2 lists; the guard also strips `x-nanogpt-billing-mode`, `x-use-byok`, `x-byok-*`, `x-payment`, `x-x402*`, `x-prompt-caching-*`, `x-anthropic-cache-depth`, `x-cache-depth`, `moderation` (paid preflight), body fields `prompt_caching`/`promptCaching`/`caching`/`stickyProvider`/`provider`, and rejects the paid model suffixes `:online` and `:caching`.
11. **Key-lock check when NanoGPT omits `paidSpendPolicyAllowsBalance`:** warn, don't refuse; inference still runs only while `routing.recommendedMode` is `subscription` (§22.4), which blocks the paygo fallback this field guards against.
12. **Hub protocol additions** (all infrastructure, none carry world or player information): `embed`/`embedResult` (§23.5 shared embedding service), `speechToken`/`speechGrant` (§6.2 global utterance guard), `cautionShift` (§17.10 brake), `snapshot`/`snapshotDone` and `retire` (§23.4, §16.2), `conception` (§19.3), `telemetry` (dashboard only), `ready`, `bye`, `llmDeny`. `budget` carries token quota instead of USD (v0.6).
13. **Live tests**: `pnpm test:live` (needs `AGORA_JAVA` pointing at Java 25) builds an isolated superflat server under `data/live-test/`, reusing the verified jars. `pnpm run server` runs only the Minecraft server in the foreground with the same preflight checks as `pnpm start`.

### M1 (2026-10-21)
1. **Skills (21):** `goTo`, `follow`, `explore`, `flee`, `look`, `wait`, `gather`, `mine`, `pickup`, `craft`, `smelt`, `place`, `shelter`, `deposit`, `withdraw`, `attack`, `eat`, `equip`, `sleep`, `give`, `say` (`packages/agent/src/body/skills/`). Each declares its postcondition; the runner snapshots the body before and after, gives the server up to 2 s to settle (inventory updates trail the action), and records `{expected, observed, mismatch}` for Action Awareness (§4.6). A `count` slip crafts one fewer, a `tool` slip fights with the wrong item, a `path` slip takes a detour (§21.2 errors).
2. **Upstream bugs on 26.1, fixed with pnpm patches** (`patches/`, all found live):
   - *mineflayer inventory:* the window `stateId` was global instead of per window; `set_cursor_item` (1.21.2+) was ignored; it waited for slot updates Paper never sends; and `syncWindow` resolved on a stale `window_items` that Paper follows with a trailing `set_slot`. Symptoms were reverted crafts, phantom items and 20 s "updateSlot did not fire" hangs. It now tracks state per window, resyncs instead of waiting, and waits for 75 ms of window quiet (20/20 stress rounds exact).
   - *mineflayer entity_action:* 1.21.6 renumbered the enum, so "start sprinting" sent `start_riding_jump` and "wake up" sent `stop_sprinting`. Ids are now looked up by name.
   - *mineflayer difficulty:* the 26.1 protocol maps difficulty to its name, and mineflayer indexed an array with that name (`undefined`).
   - *prismarine-physics:* horizontal collision had no epsilon, so standing at x = 2.7 put the hitbox at 3.0000000000000004. Paper (Moonrise collisions) answered `CLIPPED_INTO_BLOCK` and teleported the bot back on every step-up jump; a 1e-7 epsilon matches vanilla.
   - *mineflayer-pathfinder:* diagonal moves cut corners past solid blocks, which caused endless "stuck" loops next to a placed crafting table. Diagonals now need both side cells free.
   - A pnpm override dedupes the mineflayer 2.x that `mineflayer-utils` pulls in.
3. **Removed server properties:** 26.1 dropped `pvp`, `spawn-monsters`, `enable-command-block` and `allow-nether`. The first three are now set as gamerules at startup (`pvp`, `command_blocks_work`, and `spawn_monsters` in tests); `allow-nether` moved to Paper's global config, whose default (on) is what we want.
4. **Plugins:** mineflayer-armor-manager did not equip on 26.1, and auto-eat's timing ignores fights, so armor and eating are our own reflexes. mineflayer-pvp's reach is set to 3.0: Paper checks 3.0 from the eyes to the target's hitbox, so pvp's 3.5 between feet wasted swings. mineflayer does not map other entities' `health` metadata on 26.1, so `entityHealth()` reads the synced `health` key; `attack` succeeds when *the targeted* entity is gone, not when no entity of that type is left.
5. **Reflex fight-or-flight (§4.5, §21.3):** besides the caution-driven health threshold, creepers and wardens, the reflex runs a damage race (`combatOdds.ts`): weapon damage × swing rate × accuracy against the threats' remaining health and damage, with armor and difficulty included, calibrated on live fights (on hard with a stone sword, one zombie costs about 3 HP, two about 12, three about 27). It flees from a fight it would lose before reaching its flee threshold, and cautious personas want a wider margin. Novices (combat < 0.3) hit the nearest mob; others finish their target unless an attacker is more than a block closer. Hopping between attackers had reset the swing timer and got a test bot killed. Fleeing runs to a computed point away from the threats, because `GoalInvert` stalled on open ground. It keeps running until nothing chases within 16 blocks, so the bot doesn't flip between fighting and fleeing as stragglers drop out of range.
6. **Upkeep reflexes yield to skills:** eating, pickup and armor run only while the executor is idle (a reflex had equipped bread between a skill's equip and place). Starving is the exception: the reflex signals `onSoftPreempt` and waits up to 2 s. The collect reflex picks up drops within 4 blocks (§8 give: the receiver collects). While the bot is sealed in a shelter, hostiles it cannot see are not threats; fighting one would dig it out.
7. **`shelter`:** centers on the block, digs until walled in with a sealable top (it resumes a half-dug hole), and seals above its head. With `untilMorning` it waits until the undead burn (about 1000 ticks after dawn) and nothing *audible* is within 8 blocks, then climbs out by towering with the dug dirt. Creepers are silent, so a sheltered bot does not "know" about one (§13 rule on unperceived info); by mid-morning it leaves anyway, and the reflexes handle stragglers.
8. **Naming:** item synonyms (`iron`→`raw_iron`, `wood`→logs) are not applied to block names, so `mine iron_ore` stays iron ore. Failure messages are written for the CC: `missing 3 cobblestone (or cobbled_deepslate/blackstone)` and `need a stone_pickaxe or better to harvest iron_ore`.
9. **Body vs. perception:** the body layer sees every entity mineflayer tracks, including through walls. Filtering by line of sight and hearing is the M3 perception module's job; skills that decide on their own use only visible or audible information.
10. **Live tests:** `tests/live/m1-skills.test.ts` (16 cases, each in a fresh zone 200 blocks from the last) and the exit test `tests/live/m1-night.test.ts`. In the exit test, a scripted bot (skills and reflexes, no LLM) fights a zombie at nightfall and digs in. The night is then fast-forwarded on hard with natural spawning and three zombies summoned at the door. The bot takes no damage while sealed and walks out alive in the morning. `/summon` with any NBT skips the random baby and reinforcement rolls, which keeps scenarios deterministic.

### M2 (2026-10-21)
1. **Subscription list (checked live):** `GET /api/subscription/v1/models?detailed=true` is public metadata (no key needed; 331 models today) and carries `capabilities`, `context_length`, `max_output_tokens`, `pricing`, `aliases` and `architecture.output_modalities`. The list also contains "decision" models (`text->decisions`), NanoGPT's own router (`auto-model`) and help bot (`nano-gpt-help`), and `:thinking` variants. Non-chat models are never picked, and the router and help bot are allowed only by explicit id. Aliases resolve case-insensitively.
2. **`auto` heuristics (no bench file):** L1 takes the cheapest-listed models, plain ones first: a model flagged `reasoning` may think by default and miss the 2.5 s timeout. L2 takes plain models around the 60th price percentile. L3 takes `reasoning` models first, then the priciest-listed, then the longest context. The first picks prefer different providers (`owned_by`) so a 5xx at one provider doesn't take the whole chain down (§22.6). Configured ids come first, and chains hold up to 5 models. `pnpm run doctor` prints the resolved chains from the live list. With `config/model-bench.json`, measured models (≥ 90 % ok and valid JSON, p90 under the tier timeout) come first: by p50 for L1, by size for L2/L3.
3. **Usage accounting:** NanoGPT returns `usage` only when asked, so the client sends `include_usage: true` (non-streaming) or `stream_options.include_usage` (streaming). Neither is billing-relevant. Input tokens feed the per-agent hourly share.
4. **Error mapping (§22.6)** covers NanoGPT's three error shapes (OpenAI-style, legacy `{error, status}`, `{error: <int>, message}`) and its documented codes. `model_not_found`/`model_not_available` refresh the allowlist and try the next model. `model_not_allowed` (403), 402 and "not covered/subscription only" remove the model for the session and poll usage. `daily_rpd_limit_exceeded`/`daily_usd_limit_exceeded` mean code-only until `Retry-After` (or UTC midnight). A 401 means code-only for 10 minutes plus an error pointing at `.env`. 5xx, 408 and timeouts count toward the circuit breaker (3 → 5 min).
5. **Attempts:** the primary model, then one fallback model, then the module's code default (§5); a call never waits on more than two models. Structured replies get one repair retry on the same model, and three schema failures in 30 minutes mark a model unreliable for that tier (hot-swap). Models flagged `structured_output` get `response_format: json_schema` (`strict: false`, because zod schemas with optional fields cannot meet strict mode); others get `json_object` plus the schema in a system message.
6. **Balance endpoint:** it is `POST /api/check-balance` with `x-api-key`; §22.5's `GET /api/v1/check-balance` is a 404 (checked live). The HTTP allowlist has the real path.
7. **Quota ladder and budgets:** `recommendedMode` `paygo`/`unavailable`, an inactive subscription, the daily key cap and a rejected key all mean code-only. An unknown quota (`degraded`, missing fields or a failed poll) runs at level 1. Per agent, the §5 order (L3 off, slower Social Goal Gen, L2 → L1, code-only) applies at 70/80/90/100 % of its hourly share (the design gives the order, not the thresholds). `llm.baseUrl: paid` is not implemented: it logs a warning and stays on the subscription endpoint, which is stricter than §22.2.
8. **Agent State (§4.1, §4.2):** facets (top-level keys) are replaced copy-on-write, with a global version and per-facet versions. Snapshots are deep-frozen plain data; class instances such as mineflayer's live `Vec3`s are not frozen, since that would break mineflayer. A call guard stamps the versions. It aborts the request as soon as a change makes it pointless (danger started, the conversation ended, another decision was made), and at reply time `isStale()` also rejects a result once more than `maxChanges` relevant changes have happened. Per-module policies are in `state/policies.ts`. Per-module single-flight keeps one call in flight per key, and a new trigger replaces the queued one.
9. **Rate limiting:** a local 20 rps bucket with priority waiters (Talking first) until the Hub's tokens arrive in M5. A 429 drops the rate by 20 % for 10 minutes.
10. **`pnpm bench-models`:** `--dry-run` lists candidates without a key. The real run refuses at ≥ 85 % quota, sends at most 5 prompts per model at 70–85 %, needs `--yes` above 1 % of the remaining weekly quota, measures p50/p90, JSON validity, time to first token and CC tool-arg accuracy, and merges into `config/model-bench.json`.
11. **Not run here:** the §22.8 live smoke test (balance unchanged after 20 calls per tier; a paid-only model blocked locally) needs a real key. It is `tests/live/m2-nanogpt.test.ts`, gated on `NANOGPT_API_KEY` and `AGORA_LIVE_LLM=1`. The unused `mineflayer-armor-manager` and `mineflayer-auto-eat` dependencies were removed.

### M3/M3b (2026-10-21)
1. **Modules** (`packages/agent/src/modules/`, `perception/`): Perception (self and entities at 4 Hz, blocks of interest every 2 s, chat parsing and addressee detection), Conversations, Skill Executor, Action Awareness, Talking, Self-Monitor and the Cognitive Controller, all on one Agent State store and a typed in-process event bus. `pnpm agent --persona <id> [--goal … --done …] [--code-only]` runs one agent against the configured server.
2. **Perception filters what the body sees** (M1 note 9): an entity is perceived when a raycast from the eyes reaches it or it is within 4 blocks (heard or felt). Spy lines and the bot's own echo are never perception. Social profiles start on first sight and carry nothing about whether the person is a bot.
3. **Addressing (§6.2):** a line is for me when it names me (`Pip,`, `@pip`), when I am the only person in range, or when it continues a conversation I am in; it is for someone else when it names another person in range; otherwise *unsure*: heard and kept, but not answered. Conversations end at the turn cap (4 + 6 × extraversion), on repetition (word-bigram similarity > 0.92), 10 s after the partner leaves range, or after 40 s of silence (a nudge at 20 s). A pair then cools down for 60–120 s.
4. **Talking's commitment guard (§13 rule 2):** a request (give, help, come, trade, …) goes to the CC as `needsDecision`. Until it decides, Talking may only answer with a holding line, and when the CC's `speechIntent.mayCommit` is false the reply is checked against a promise pattern. A draft that promises is redrafted once under a stricter instruction; if that fails too, the line becomes a canned "let me think about it." Only a decision with `mayCommit` creates a commitment.
5. **Option–action (§4.3):** options map to skills (`work` → its task; `talk` → walk over, then wait; `rest` → wait; social options that need M6 cores, such as `trade`, `fight` or `court`, map to `wait` until then). The executor enforces `terminate.maxSeconds` and `until` conditions (checked every second; the grammar is shared with goals' `doneWhen`, `modules/conditions.ts`), aborts on danger, and records expected vs. observed for Action Awareness. Three identical failures within 10 minutes, or a task that "succeeds" instantly three times within 2 minutes without changing anything, mark it stuck for 5 minutes. The CC is told and may not pick it again.
6. **`obtain` (code planner, M3b):** a recursive route search over gather, craft and smelt, with costs from a cached scan of the nearby world (which blocks drop the item, which woods grow nearby, stations within reach). Only held variants plus one or two others are expanded, results are memoized, and the search yields to the event loop every 15 ms. Planning stone tools from nothing takes ~0.3 s. If the plan is deeper than the agent's **planning depth = 2 + round(4 × intelligence)**, obtain fails with "that's too many steps to work out at once; get X first", where X is the deepest missing prerequisite, so a low-intelligence agent has to climb the tech tree in steps its CC chooses. Crafting re-verifies ingredients before each craft, because earlier steps can consume them.
7. **Intelligence levers (§21.1):** CC tier L1 below intelligence 0.35, L2 above. An L3 planning burst for new goals at 0.7 and above. Packet sizes (memories 3→6, tasks 2→5, people 3→6), queue depth, candidate options, slip chance (8 % → 1 %) and reflection cadence interpolate the design's anchors at 0.2 and 0.8 (`modules/levers.ts`). `world.abilities.intelligenceRoutesCCTier: false` keeps everyone on L2.
8. **CC triggers:** an option ending, a request needing a decision (urgent), a new goal, danger ending (decisions that arrive during danger are deferred, §4.5), and a 30 s heartbeat while idle. Non-urgent decisions are at least 2 s apart (§13 rule 6), and a decision re-reads the bot's own state first, since perception may be up to 250 ms old. The code default, used when code-only or when the model fails twice, follows the latest `obtain` failure's "get X first", else works toward the goal's `doneWhen` item, explores when stuck, and rests when there is nothing to do. The packet includes what the agent is doing now and its progress, so a request can be declined without dropping the task.
9. **Path-cost quirks are relative:** a `pathCost` rule penalizes only places that differ from where the bot stands. Superflat ground is at y = −60, so Mira's `y<0` rule had made every step expensive, and pathfinding timed out on open ground. When the bot is already in such a place (outdoors at night for "afraid of the dark"), every path is equally bad, and a uniform penalty would only slow the search.
10. **Live exit test** (`tests/live/m3-agent.test.ts`; superflat, three oak trees, stone two blocks down). No NanoGPT key is available in this environment, so the LLM path is driven by a scripted stand-in behind the real client (mocked NanoGPT HTTP, real allowlist, schema validation and guards). Code-only Mira gets a stone pickaxe from nothing in about 50 s. Tobin (intelligence 0.3, planning depth 3) goes through the LLM path: stone pickaxe → told "get cobblestone first" → "get wooden_pickaxe first" → wooden pickaxe → stone pickaxe. When Bram asks him for 8 logs, the CC declines with `mayCommit: false` and keeps its task, and Talking's promised draft is caught and redrafted ("hmm, I'm busy with my tools right now"). Coherent free chat with a real model is left for a run with a key.

### M4 (2026-10-21)
1. **Memory (§4.7):** `memory/db.ts` keeps one SQLite file per bot (`data/agents/<username>.db`, WAL) with `memories` (text, embedding blob, ts, importance, source, about_agent, confidence, is_false) and a `kv` table for the resume snapshot. Items that fall out of working memory (5) go to recentmem, replacing near-duplicates (cosine > 0.90). When recentmem holds more than 50, its older two thirds are clustered (average linkage, cosine ≥ 0.80); each cluster is merged into one memory (L1, or a code join without a model) and moved to longmem, deduplicated again. Retrieval ranks by cosine × recency (half-life 6 h, floor 0.25) × (0.5 + importance) × (0.5 + 0.5 × confidence), and memories marked false never come back.
2. **Hearsay (§6.5):** an addressed line of four or more words goes onto the listener's mind as `Bram said: "…"` (questions as `Bram asked: …`), sourced `told_by:Bram` with confidence = trust × 0.8. Recalled hearsay is labeled `(heard from Bram, unverified)` in both the CC packet and Talking's prompt. Talking now gets what is on the agent's mind and up to three memories relevant to the line it answers (cosine-ranked, score ≥ 0.2), and its rules say to name the source when passing something on. The CC packet gets memories for the goal, the people around and the last thing said to it.
3. **Embeddings (§22.5):** `Xenova/all-MiniLM-L6-v2` (q8 ONNX, 384 dims) through transformers.js, loaded only from the hash-checked files setup installs (`allowRemoteModels: false`); requests arriving within 15 ms are batched. Without the files, a deterministic hashing bag-of-words embedder keeps dedup and recall working (much weaker; logged). From M5 the Hub runs the one embedder for all bots.
4. **Goal Generation:** L3 every 3–5 minutes (slower under quota pressure), right after a goal is done, and at start. A `doneWhen` the condition grammar can't check is dropped rather than trusted. The code default is a tech ladder (wooden pickaxe → stone tools → furnace → iron pickaxe → 32 cobblestone → the persona's life goals), so code-only agents build goal chains too.
5. **No x-ray (§13 rule 4, found while building the iron step):** the M1 skills searched every loaded block, so `gather iron` mined ore hidden in the ground. Now a `Sightings` memory per bot (`body/sightings.ts`) records rare blocks the bot has had in line of sight or touched (perception scans every 2 s). Skills find natural ground and vegetation anywhere (everyone knows there is stone under the grass, and trees show from afar), but ores, containers, beds, workstations and anything built only where seen. An unseen target fails with "haven't seen any raw_iron around here".
6. **`prospect` skill (new):** with no ore in sight, it digs a staircase down toward the depth where that ore is common in today's overworld (iron ~14, diamonds ~−56; just under the surface on a flat world), keeping a roof when the ground is thick enough. Then it runs a 1×2 tunnel, looking at the walls, and stops when the ore comes into sight. It heads where there is most host rock at tunnel depth (the ground itself is common knowledge; the ore is not), and turns back toward rock after six blocks of dirt. Liquid ahead makes it turn (twice at most); it bridges gaps with cobblestone or dirt. The code default calls it after "haven't seen any …", explores after a failed prospect, and tries the goal again after exploring. Exploring stays within 96 blocks of where the bot first appeared.
7. **Quirks (§7):** `QuirkRunner` runs the behavioral hooks once a second. `idleEmote` fires when the bot is free to talk (not in a conversation, not in danger, not in a task that can't be talked over) and someone can hear. `distraction` rolls once per creature seen within 12 blocks and has a 60 s cooldown. `autoCollect` reacts to the item lying in sight within 8 blocks, or to a block that *is* the item (a poppy; apples don't make it break leaves). The last two are **impulses**: validated like decisions, they briefly take over, and the code default ignores the interrupted task's "aborted" record, so the plan resumes. Flowers and other blocks without a collision box are gathered by walking over and breaking them, because the collect plugin can't path to them.
8. **Loop and progress caps:** Action Awareness weights a failure that still gained something (obtain mining one of three ores) at half, so partial progress doesn't mark a task stuck as fast as a dead end.
9. **Live exit test** (`tests/live/m4-agent.test.ts`): (a) `gather raw_iron` refuses iron hidden under the bot; `prospect` tunnels 10 blocks east through a stone hill, sees the iron in the wall, and the iron can then be mined, while the unseen ore under the start stays untouched. (b) Tobin (scripted model, real MiniLM) gets his goal from Goal Gen's L3 call. Bram tells him where the diamonds are; six new thoughts push the line out of working memory into SQLite (confidence 0.4). Bram leaves until the conversation ends, then comes back and asks, and Tobin answers "Bram says they're buried under the big oak by the lake." The answer came from memory: the new conversation's transcript doesn't hold the told line. (c) Code-only Pip on superflat with a stone patch (iron hidden in its lower layer), oaks and poppies: wooden pickaxe → stone tools → furnace → iron pickaxe in 255 s with 18 decisions and no back-to-back repeats over four. She picked two poppies on the way and hummed three times for Bram, who floats nearby in creative. The design's 30-minute run is shortened because the chain completes; long unattended runs come with the population tests in M5.

### M5 (2026-10-21)
1. **Processes (§3):** `pnpm start` runs the Minecraft server (child process), the Hub and one OS process per bot (`node --import tsx packages/agent/src/main.ts --slot aN --hub ws://127.0.0.1:8765`). A bot learns who it is this life from the Hub's `assign`. `AGORA_MC_HOST`/`AGORA_MC_PORT` point bots at another server (one you run yourself, or a test server). Bots talk to the Hub with Node's built-in WebSocket. The Hub uses `ws` and binds to 127.0.0.1; every message is zod-checked on both ends.
2. **Hub services (infrastructure only, §8):** the shared 20 rps bucket with priority waiters (a request waits at most `queueTimeoutMs`, then `llmDeny`); the global speech guard (5 lines/s across all bots, dropped rather than queued, §6.2); the one shared local embedder (§23.5); budgets; and a telemetry sink (`logs/telemetry.jsonl`, for the M7 dashboard). Usage is polled once, by the Hub, for everyone. Bots don't poll; they apply the Hub's `budget` to their governor (`setExternal`). Each agent's share is `perAgentHourly` split across the living agents, and an agent that spends its own share drops down the ladder alone (§5). Without the Hub, a bot falls back to a local 20/N bucket and lets lines through (its per-bot 2 s and per-pair 30/10 min guards still hold). Embedding requests wait up to 15 s for the Hub to come back.
3. **One priority table:** the LLM client and the rate limiter used opposite conventions (`@agora/llm` served lower numbers first; the protocol's `MODULE_PRIORITY` says higher first). There is now one table (`@agora/shared`, higher first: Talking 100 … persona 10), and the module name travels with each token request.
4. **Supervisor (§16.2–16.3, §19.7):** it keeps the population between `minAlive` and `maxAlive`, starting `initial` agents `spawnStaggerSec` apart. Personas come from the pool first (unused ones, balancing sex among the living), then from the generator. The starter kit goes out by console `give` on a life's first spawn (`starterKit: auto` gives the persona's kit in test mode, none in live). A crash or lost connection restarts the **same** agent with backoff (2 s doubling to 60 s). A death marks the roster entry dead, copies the memory DB (and its WAL) to `graveyard/<name>-<ts>.db`, deletes the original, and spawns a replacement after `respawnDelaySec` under a never-reused name. `setPopulation(n)` retires the newest agents with a goodbye line (for `ctl population`, M7).
5. **Persona generation (§20, §21.5):** every 0..1 trait is `clamp(N(0.5 ± d·σ/2, σ))` with the configured sex shifts; intelligence and combat come from `world.abilities` and aren't shifted. Trait words, speech style, values, life goals, social settings and one or two quirks are derived from the numbers, never from the sex label. Checked on 8000 personas per sex: each measured d is within ±0.05 of the table (×`scale`), intelligence and combat show none, and `scale: 0` removes the shift.
6. **Graceful shutdown and resume (§23.4):** on SIGINT/SIGTERM the supervisor broadcasts `shutdown`. Each bot stops its modules, flushes working memory into SQLite, writes a **state snapshot** (goals, task queue, commitments, social model, drives, emotions, mood, heard opinions, knowledge, conflict, family, life, growth, trait annotations) into its DB's `kv` table, checkpoints the WAL, disconnects and says `bye`. Stragglers are killed after 30 s, `roster.json` is written atomically, and the server saves and stops. On the next start, living roster entries are relaunched in their slots with `assign.resume = true` when their DB exists. The snapshot is restored with the time offline treated as time passed: emotions halve every 30 minutes, and commitments past their deadline lapse to broken. A shutdown that arrives while a bot is still starting makes it leave at once.
7. **Conversations among several people (§6.2):**
   - Group floor control: a line not addressed to anyone in particular ("anyone got wood?") gets a tiny L1 check ("meant for you in particular?", general questions count as no) when a model is available. If no one in particular is meant, listeners wait 1.5–4 s and chime in only if nobody else has answered. They check again right before the chat packet goes out, after the typing delay; checking before typing let two listeners answer at the same moment in scenario C. A listener that yields forgets the conversation it was about to join. Otherwise it would answer the asker's next line at once, as if they had been talking. Each listener chimes in at most once per three heard lines, and on lines aimed at someone else only rarely (chance extraversion × 0.3).
   - An earlier rule that "a line right after your own is for you" made listeners in a group answer each other in a loop, so it was dropped; one-to-one talk is covered by the conversation state.
   - When a conversation has just ended, the partner's trailing lines don't reopen it, and don't invite a chime-in either, unless they call you by name. Otherwise two people would restart it forever ("the only one in range", or a third person nearby making every line "unclear").
   - A `talk` option ends when its conversation does.
   - The code default says hello to someone nearby when there is nothing to do, with the persona's `initiateChance`, using greeting lines when there's no model.
8. **Blocks are seen by any face:** `canSeeBlock` raycasts to points just inside each face, so ore embedded in the ground shows its top and ore in a tunnel wall its side; M1's `mine` test found the center-ray check too strict. A body's home (for exploring, M4) moves with far teleports and respawns.
9. **Live exit test** (`tests/live/m5-population.test.ts`): (1) the supervisor launches two real bot processes (code-only, as there is no key here) that join through the Hub. After a graceful shutdown each DB holds a snapshot and `roster.json` lists both alive; a second start brings back the same two, and the logs show `resumed`. A bot process uses about 200 MB RSS (§23.5). (2) Two agents with a scripted model, thinking through the Hub (19 LLM tokens, 12 speech tokens), meet and talk; both sides end the conversation by repetition, and in the minute after, at most two more lines are said. (3) Scenario C: three listeners and a person asking two questions to everyone. Each question gets one answer, from the first to speak; the others yield.
10. **`pnpm start` smoke test** on a fresh normal world with `--population 2` (which now means a fixed count: initial = minAlive = 2): Paper, the Hub and two bot processes come up. One agent died within 20 s ("tried to swim in lava"); its memory went to the graveyard and the roster marked it dead. Ctrl+C shut everything down cleanly. On the second start, the survivor resumed (14 s offline) and a new agent from the pool took the dead one's place. The death led to two fixes: paths now keep a step away from lava (+40 per step next to it), and a bot in lava heads straight back to where it last stood safely, since the pathfinder won't plan through lava. The same run showed the planner choosing to "gather" planks it had never seen when no tree was in view; gathering unseen non-ground blocks now costs more than any other route (planks come from logs), while ore still plans as "find it".

### M6 (2026-10-22)
1. **Social Awareness (§6.3).** After a conversation, one batched L2 call per partner (code default: tone words) gives a sentiment change, friction, perceived goals and role, new facts, a summary, what they said about other people (heard opinions) and whether they insulted us. Deltas go through the shared arithmetic in `social/math.ts`: negativity and grudges amplify bad news, the first two interactions count double (anchoring), and no update moves sentiment by more than 2. Sentiment drifts back to the persona's baseline by 0.1 per game day without contact (half as fast when below it, for grudge-holders).
2. **Reading a conversation 8 s after it ends.** The partner's answer to our last line often arrives just after we ended the conversation. Such a "tail" (heard within 15 s of the end) is added to the ended conversation's record, and Social Awareness waits 8 s before reading it, so a promise made in it counts. State keeps the newest 20 ended conversations.
3. **Notable deeds, code-only (§6.3 rule 2):** gave me items +1 (an item that appeared at a visible player's hands, within 2 blocks, and that we then picked up), attacked me −3, attacked someone we'd defend −2 (from the reflexes' attribution of the hit), broke blocks I placed −1 (placements come from mineflayer's `blockPlaced`; the breaker is whoever we saw digging there, else whoever swung right next to it, never our own digging), and helped me fight +1.5 (someone else hit the mob that was after us). Each counts at most once a minute per person and deed, so a long fight or a torn-down wall is one deed.
4. **Commitments (§6.4).** Our own are created only with `mayCommit`, and they go into the task queue: get the items if we lack them, then hand them over. Promise tasks stay queued until they succeed, so a failed hand-over is tried again (stuck detection stops endless retries, and the deadline settles the rest). A give that finds us short queues the gathering again, and a settled promise removes its tasks. Promises others make to us are extracted when the conversation is read (L1; the code default reads "I'll bring you 8 logs" as give 8 log) and are recorded once, even when said twice or restated in a later conversation. Checks:
   - a `give` to us: the observed gift (partial deliveries add up);
   - ours: our give action succeeding;
   - `meet`: both of us within 5 blocks of the place;
   - `help`: 30 s of them working near us;
   - `custom`: an L1 judgment at the deadline.
   Anything still open at its deadline is broken. Resolution moves trust (+0.1 / −0.2) and sentiment (+0.5 / −1) and leaves a note on the mind ("Pip broke their promise: 8 logs") that comes up in later talk.
5. **The code default answering requests (§6.3 share policy).** A request is read from the asker's recent lines in the same conversation, so a follow-up ("so, can you?") refers back to what was asked for. Asked again for something already promised, the agent says so ("sure! I'm on it, bringing you 8 logs") and keeps working; it never promises twice. It agrees at liking ≥ 6 with fewer than two open promises, when it has the items or is the generous kind (agreeableness ≥ 0.6 or a generous trait). It says "2 bread", not "2 breads".
6. **Trades (§6.6; v0.2: chat plus delivery, nothing over the Hub).** Offers are read in code ("3 bread for 8 logs?", "I'll give you … for …", "give me … for …"); vaguer ones are left to the model, whose decision format now has `trade`. The code default:
   - accepts when it has what they want and their side is worth its price: rough values in logs, a fair price at liking 6, up to 30 % off for friends (§6.3), and `tradeBias` quirks making some things dearer;
   - counters with fewer of its own items when the offer covers at least half the price;
   - declines below liking 6, at trust under 0.3, or without the goods.
   Accepting records both halves as commitments, each due in 10 minutes. For an offer we made, the other side's "deal" or "ok" closes it the same way. Each side hands its half over in person, and a half not delivered breaks at the deadline.
7. **Help (§6.7):** "can you help me gather wood?" becomes the help option: walk over if they are more than 8 blocks away, gather near them, then hand over what was gathered. "That's enough" from them ends it, and the hand-over shrinks to what was gathered so far (with nothing gathered, the help simply counts as given).
8. **Rumors (§6.5):** a place-and-thing claim heard or overheard ("diamonds at 2114, -61, 6") is kept as open. With nothing else to do, the code default goes to look (within 64 blocks). Once the place and a 5×5×5 box around it are in view, the claim is settled: if true, the teller's trust rises a little; if false, it drops (−0.15), the memory is marked false, and a note is left.
9. **Deaths matter to the living (§16.3):** a death notice raises caution by 0.1–0.3 (more if seen or the cause is known, scaled by neuroticism), falling back 0.05 an hour. It leaves a note ("Bram died (was killed). Death is permanent.") and grief or relief, by how the agent felt about the dead.
10. **Pickup courtesy (v0.2: seeing someone already working an area replaces the claim registry).** A resting agent doesn't walk over to drops that came from someone else's work: dug out of a block we saw them digging, or tossed by them but not toward us. After a minute they are anyone's. Scenario A first showed Bram helping himself to Pip's logs while she chopped.
11. **Handing things over (found in the live runs):**
    - A tossed item lands about where the thrower looks, but only once the server has the new rotation, two ticks after `lookAt`. Without that wait every toss flew level, about 3 blocks, past a receiver standing still. Measured on 26.1.2: aiming 0.5–2 blocks ahead lands within 0.2 of the aim.
    - `give` walks to within 1.5 blocks of where the person is now, in short tries. If the pathfinder keeps failing while they are in plain view, it walks straight at them.
    - It tosses at their feet and steps back. Nobody can pick a thrown item up for 2 s, and then the closest player gets it: givers used to collect their own items again.
    - It checks who actually picked up the items it threw. Items falling from leaves nearby don't count, and items left at the receiver's feet count as given.
    - A pathfinder `place_error` reset could stall a walk until its timeout (scenario A's first failure). A failed walk now stops moving and logs what the pathfinder did.
12. **Other fixes from the live runs:**
    - Line of sight to blocks without a collision shape (flowers, torches): rays pass through them, so they count as seen when nothing else is in the way. M4's poppies had stopped being picked.
    - Placement spots avoid cells overlapping anyone's hitbox, which the server refuses (M4's furnace in a mining hole).
    - Stuck on a goal, the code default looks around twice and then rests a minute before trying again, instead of exploring for the whole five-minute stuck mark.
13. **Live exit test** (`tests/live/m6-social.test.ts`, 8/8; code-only agents and plain clients, one scripted model): see the M6 row above. Along the way the runs showed a give timing out after Pip came down from a tree, items flying past a receiver, a resting agent taking another's logs, flowers that were never "seen" and a furnace that couldn't be placed in a mining hole; each is fixed above (items 10–12).

### M6a (2026-10-22)
1. **Feelings (§18.2), all code.** Each event is appraised into emotion deltas, × (0.5 + neuroticism): being attacked, insulted, threatened, praised or turned down after asking; a gift; a peer's death; a goal reached; repeated failure; a disliked rival's advancement.
   - An insult lands by temper: anger = (0.3 + 0.3·(1 − agreeableness)) × (0.5 + aggression). A hothead goes straight to fury and a stoic hardly notices. One that hits a known insecurity ("being called lazy") brings shame too.
   - Gossip is told apart from insults: an insulting word next to someone else's name is an opinion about them.
   - Decay: half-lives of 60–180 s for the intense emotions and 10–15 min for sadness and affection, longer for the neurotic. Mood is a two-hour moving average.
   - Anger is also kept per person ("heat", a 90 s half-life scaled by neuroticism). A gift or praise cools it, and an apology may (vengefulness lowers the odds).
2. **Contagion from the tone of speech, read in code** (anger, fear, joy and sadness words), ×1.5 for anger inside a mob. This replaces the batched L1 sentiment classifier §18.2 mentions: it costs nothing, and the L2 read of the conversation covers the rest. Seeing someone get hurt nearby counts as witnessing a fight (fear).
3. **Expression:**
   - The strongest feeling goes into Talking's prompt ("You feel very angry; let it show in how you talk.").
   - Code-only small talk uses feeling lines ("what now?", "*sighs*", "haha, yes!").
   - The CC packet says how the agent feels and whom it's angry at.
4. **Impulses (§18.5)** use canned code actions for the common cases (the design's "or a canned code action" branch) rather than an L1 call, which keeps the reaction under 2 s. The impulses are: an outburst (shouted), storming off (walking 10 blocks away and ending the conversation), refusing to talk (ignoring them for a minute), fleeing, and an impulsive gift. The single punch waits for the conflict core's gate (M6b). At most one impulse a minute. Regret: once calm (arousal < 0.3), if the target is someone the agent likes, shame follows and the agent goes to apologize (a talk option with the `apologize` stance).
5. **Gut and facts (§18.5), two tracks per person.**
   - `sentiment` is the gut: first impression, halo, envy, hearsay, anchoring, negativity.
   - The new `evidence` field is the facts: deeds and kept or broken promises, taken plainly, half of each conversation's read, and false claims.
   - Code acts on `lerp(gut, facts, override)` (`Mind.liking`) when sharing, trading, helping and defending.
   - The CC packet shows "GUT about X … / FACTS about X …" when the two differ by 1.5 or more, or a bias is at play. The CC prompt says the agent may follow its gut or reason past it.
   - After each interaction, a rational mind's sentiment moves toward the evidence (× rationality × 0.15). A first impression fades after a few meetings for the rational and lingers for the rest (§18.9 M).
   - Snapshots saved before this get the new field from the profile defaults.
6. **First impressions and admiration (§18.3).**
   - On first sight a stranger's visible gear sets the impression: `gear × 2 × vanity × (0.5 + halo/2)`. Bare hands are neutral, since everyone starts with nothing; a negative impression for no armor would have put a generous agent just below the sharing line.
   - How their first two lines come across (funny, confident) adds to it. Both count as the first anchoring interaction, and admiration comes from the same cues.
   - Someone admired (> 0.75) is imitated (a Goal Gen hint), and their word counts for more: hearsay confidence + 0.2·admiration·halo.
   - Disillusionment: an admired person who hits us or a friend may fall (probability = rationality), leaving a resentful ex-fan.
   - Visibly better gear than ours stirs envy (envy bias × (1 − agreeableness)), at most every 5 minutes per person.
7. **Biases (§18.4), in code:**
   - **Confirmation:** applied to the L2 read of a conversation.
   - **Conformity:** opinions are read from every line ("Bram is a thief", "never trust Mira", "Tobin's great"), clause by clause with negations handled. They pull sentiment toward the heard consensus by `conformity × (1 + 1.5·fear) × (1 − override) × 0.3`, weighting speakers by trust and admiration.
   - **Availability:** after a death to a creeper, lava, a fall and so on, that cause adds up to 4 health points to the flee threshold for 30 minutes.
   - **Self-serving:** a repeated failure is put down to bad luck, or to a disliked person nearby.
   - **Scapegoat:** a death with no known killer, while the agent is afraid, is pinned on the most disliked person.
   - In-group, attribution, authority and sunk cost wait for the groups, grievances and leaders of M6b and M8b.
8. **Mobs (§18.4.2):** three or more people within 16 blocks turning on the same person (hostile opinions in the last two minutes; our own anger counts too).
   - An onlooker joins in ("yeah, Rex is no good!") when its gut-and-facts view of the target is below 4.5.
   - If reason wins (override ≥ 0.45) and what it has seen of the target is good (evidence ≥ 6), it speaks up instead ("hold on, Rex has always been fair with me.").
   - Inside a mob, reason is suppressed (the override's crowdSuppression) and anger spreads ×1.5.
9. **Live exit test** (`tests/live/m6a-minds.test.ts`, 3/3, code-only agents and plain clients):
   - **Q:** "Kai, you are so lazy" made the hothead shout "excuse me?!" 0.5 s later (anger 1.0), while the stoic said "hey" (anger 0).
   - **M:** at first sight the vain agent rated a stranger in diamond armor 7.0 (admiration 0.84) and one in leather 5.4; the rational one 5.1 and 5.0.
   - **N:** three people turned on Rex. The impulsive conformist said "yeah, Rex is no good!" (3.4 about Rex), and the rational onlooker who knew Rex to be fair said "hold on, Rex has always been fair with me." (7.0).

### M6b (2026-10-22)
1. **The conflict evaluator (§17.4, §17.5), all code** (`conflict/evaluator.ts`; the arithmetic is in `conflict/pressure.ts`).
   - **Grievances from what happens:**
     - being hit (0.3 + damage/10, up to 0.7)
     - an insult felt
     - a promise to us broken
     - a friend (sentiment ≥ 7) attacked in front of us
     - a friend's killer, from the public death message (`killed_friend` barely fades)
   - Kills announced in chat count toward the killer's power.
   - **Code friction (§17.3):**
     - someone digging within 5 blocks of where we are working (+0.03)
     - being turned down (+0.05)
     - at most once every 20 s per person
   - **Power from what can be seen:** gear, kills announced, fights seen won, company, visible hurt.
   - **Fear** = sigmoid(6·(theirs − mine − allies)) × (0.5 + caution), and it shrinks inside a mob.
   - **Self-assessment (§21.3):** less intelligent agents misjudge their own fighting by N(0, 0.2·(1 − intelligence)), drawn once per life.
   - **When it runs:** pressure is re-evaluated on each event and every 2 s for the people in sight. A rung relaxes after 10 minutes out of sight.
2. **The ladder, rungs 0–3.** The thresholds (0.2, 0.35, 0.5) and the 0.15 hysteresis are as designed. Three rules go beyond the design:
   - **Pacing:** a rung rises at most one step per 15 s. Without it, one bad moment went straight from nothing to a brawl.
   - **Words before blows:** the gate refuses a deliberate fight below rung 2. An impulsive punch is exempt and only has to clear the lower bar.
   - **No lethal rung yet:** rung 4 is capped off until M8b, whatever `maxRung` says. Until then, a fight is a brawl that ends in a yield.
3. **What each rung does in the code default:**
   - **Rung 0 (avoid):** keep 12 blocks from someone feared (≥ 0.7) and disliked (< 5) who comes within 6.
   - **Rung 1:** hostile talk.
   - **Rung 2:** threats.
   - **Rung 3:** propose a brawl (`duel`), which still has to pass the gate.
   - **Talking:** it answers someone at rung ≥ 1 in that stance, unless the CC just decided to say something else to them. Code-only agents use canned lines. A warning or threat doesn't wait out the 1–2 minute pause between friendly chats.
   - **When the CC decides:** a rung going up wakes it at once, and so does someone we're at odds with coming within 12 blocks (the design's "X comes into sight"). This happens even mid-task; otherwise the CC only decides between tasks.
     - "Coming near" fires at most once a minute per person, but again at once if the rung is higher than last time.
     - In scenario I's first runs, the rungs rose while the rival was out of sight behind leaves (an unseen player is perceived only within 4 blocks), and the warnings and the brawl were lost or delayed by a minute.
   - **Repetition:** hostile talk and threats toward the same person come at most every 3 minutes, and again whenever the rung rises.
   - **The CC packet** lists resentment, fear, the rung and the worst grievance for each person nearby (§17.11).
4. **The gate (§17.5)** is part of the CC's decision checks.
   - **What it covers:** any decision that would fight a person goes through `mayFight` (option `fight`, or `attack`/`duel` on a person). Without a conflict core, nobody fights a person on purpose.
   - **On refusal:** the reason goes back to the model, which decides again.
   - **The checks, in order:** words first (rung ≥ 2), the threshold, the newcomer grace, the pair cooldown, and the world-wide cap. An impulse's punch is judged as an impulse.
5. **The duel (§17.6, §21.3).**
   - **Technique by tier:**
     - Novices (< 0.3) spam-click at random 2–6 ticks.
     - Trained fighters and better time their swings to the weapon's cooldown, with a jitter of 400 ms × (1 − combat) + 50 ms.
   - **Our yield:**
     - It comes at our yield health (4 + 6·caution), raised against a visible weapon whose next critical blow could finish us.
     - The fighter stops, backs off, and says "ok ok, I yield!".
   - **Their yield** is read from chat. `SURRENDER_RE` matches "I yield", "I give up", "you win" and a bare "enough!", but not "I've had enough of you" or the winner's "that's enough".
   - **Never to the death.** The fighter also stops when:
     - three of our blows in a row go unanswered and theirs have stopped for 5 s (a yield in deeds). The first version needed only 2 blows landed; in one run a fighter "won" that way while the other was still coming, then fled and gave up as well.
     - they run off (10 blocks for 2 s)
     - they've taken a reckoned beating (18 of 20, net of 0.4 HP/s regeneration)
     - they call it off ("that's enough. stay out of my way."): over for both, with no winner
   - **A fight that fizzles out:** if nobody lands a blow for 10 s, the fight is over with no winner (recorded as interrupted, with its cooldown).
     - Without this, two fighters out of each other's reach (item 6) each read the other's silence as a yield and both claimed the win. It stays as the backstop.
   - **Perception parity:**
     - Other players' hearts aren't visible (§17.4), so the beating is reckoned from the blows that land, our weapon and their visible armor, never from health metadata.
     - The reflex's damage race no longer reads people's health either; mobs are unchanged.
   - **When a fight is settled:** someone yields, the winner calls it off ("that's enough. stay out of my way."), or our duel ends. The reflexes then leave the other person alone until they strike again.
     - In the first live run, both fighters stopped at once, and each one's reflexes then fled from the other's earlier blows.
   - **Running from a person:** the reflex flee says "ok ok, I give up!" once. It waits 1.5 s first, and says nothing if the chat has echoed a yield of ours in the meantime (a duel giving up says its own).
   - **A yield already decided stands:** if the reflexes take over while the duel is backing off and saying it (a last blow sent the bot under its flee floor), the duel's record still says "yielded".
   - **Fights the reflexes fight count too:** someone hit us, we hit back or ran, and the danger passed. The fight is recorded like a duel, with its pair cooldown: yielded if we said so, won if they did, interrupted otherwise.
     - Without this, in scenario I the bot that only fought back started a second brawl 80 s after losing the first.
   - **After a fight:**
     - the record (`lastFight`) and a 300 s pair cooldown
     - growth of +0.01, or +0.02 for a win over someone stronger, capped at +0.25 (§21.3)
     - what onlookers learn: `fightsWonSeen` and `estCombat` ± 0.05
   - **Witnesses (§17.6):** perception now names the attacker when one person hits another (the swing attribution of M1). Onlookers think less of the attacker (−0.5, at most once a minute), unless they hated the victim. A friend's attacker is a grievance and the ally-defense reflex's business, as before.
   - **Left for M8b (§17.13):** ignoring a yield and mercy come with the lethal rung; at rung 3 a yield always ends the fight. A rung-2 threat is words only until demands create coercive commitments. `ambush`, `retreat`, `groupAttack` and the `demand`, `recruit` and `rally` options come with coalitions.
6. **Staying within reach.** In 1 run in 3, both fighters stopped 3.1 blocks apart, each one "arrived", and the fight fizzled out. The causes are in the libraries; the fixes are in the body layer (`body/plugins.ts`, `skills/util.ts`):
   - **Follow range.** M1 set pvp's attack range to 3, Paper's reach. pvp follows with a `GoalFollow` that re-aims only once the target strays farther than the follow range from where it was last seen, so at pvp's 2 a fighter could settle 3–4 blocks off. The follow range is now 1.
   - **Re-aiming.** A fighter with a target, out of reach and standing still, whose goal is gone or aims at an old spot, aims again (at most once a second; a goal that aims right but has no way there is left alone).
   - **Fight movements:** walk, jump and sprint, but no digging or towering one's way to someone (in one run a fighter's pathfinder spent a dirt block mid-brawl).
   - **Stopping.** pvp's `stop()` waits up to 5 s for the pathfinder and then drops every `path_stop` listener on the bot, and it leaves the pathfinder a stop that wipes the next goal (by the code, a reflex flight from a fight would stand still until its first re-plan, 1.5 s later). Skills and reflexes now use `forceStop()`.
   - **`stopMotion` on an idle pathfinder.** `pathfinder.stop()` sets a flag that an idle pathfinder never acts on, so the next goal set was wiped and its `goto` failed at once ("PathStopped", seen on pickups since M1). An idle pathfinder now has its goal cleared instead.
   - **Words.** A person in danger memories is named ("I fought off Gorm", not "a attacker"), and someone talking to a bot in a brawl hears "not now!".
7. **Fear damping (§21.3):**
   - Fear from combat events (being hit, threatened, or watching a fight) is ×(1 − 0.6·combat).
   - In a fight (option `fight`, or hit in the last 10 s), arousal is capped at 1 − 0.5·combat. A skilled fighter's override stays up, and so does its impulse threshold.
8. **Fight slots (§17.10 `maxConcurrentFights`)** are Hub tokens like the speech guard.
   - **Messages:** `fightStart`, `fightGrant` and `fightEnd`. A slot is freed on disconnect and lapses after 5 minutes.
   - **The cap** is `world.conflict.maxConcurrentFights` (default 2), which `pnpm start` passes to the Hub.
   - **Deviation:** the design has the Hub count fights from logs and never tell bots. A bare yes/no slot is the smallest working version of the cap, and the Hub-protocol test lists it with the other grants.
   - **What the bot sees:** a refusal is remembered for 30 s. The gate then answers "you hold back for now", so the bot never learns that fights are going on elsewhere (§13: no unperceived information). The code default falls back to threats (rung 2), as §17.10 says.
9. **Perceived abilities (§21.4):**
   - `estCombat` comes from fights won and lost.
   - `estIntelligence` comes from the L2 read of each conversation (`seemedClever`, moving a quarter of the way each time). This replaces the batched L1 rating with one extra field on a call that already happens. A lie caught adds 0.05 (cunning).
   - Gossip about fights, and teaching recipes, come later.
10. **Live exit test** (`tests/live/m6b-conflict.test.ts`, scenario I, code-only agents):
   - Two quarrelsome brutes, Gorm and Brak, with a seeded history (sentiment 2, an old insult, logs taken), work the same grove. Wit, a plain client, listens 12 blocks away.
   - **The arc:**
     - rung 1 at 2 s: "what do you want?", "keep your distance.", "get lost."
     - rung 2 at 18 s: "back off, or else.", "don't push me."
     - rung 3 at 34 s: "leave, or we fight.", then one brawl
   - **How the brawls ended:** in each run one side gave up and the other's duel stopped ("gave up", 15–21 blows landed).
     - The one in a duel says "ok ok, I yield!" at about 5 HP (fists; yield at 4 + 6·caution). One who only fought back by reflex ran off with "ok ok, I give up!".
     - Either of them can lose: in the three final runs Gorm lost twice and Brak once.
     - In one earlier run both reached the threshold together and both yielded. That counts: no winner, both alive.
     - The loser's fear of the winner rose (0.31 → 0.38–0.40), and nobody died. The lowest health after a fight was 3.3.
   - **Results:** 3 of 3 runs on the final code, and 1/1 in the regression run. About a dozen earlier runs found the issues behind items 3, 5 and 6:
     - rungs rising out of sight
     - both fighters stopping at once and fleeing
     - a yield lost when the reflexes took over
     - a second brawl by the side that only fought back
     - the winner answering a yield with a threat
     - a "win" after two blows, while the other was still coming
     - fights that fizzled out with both fighters out of reach
11. **A gather loop without a cap (§13 rule 6), found by the regression run.**
    - The M3 test with a model hung for five minutes in `obtain` → `gather`: a collect batch that resolved without any items arriving was simply tried again.
    - Now each batch has a time limit (45 s plus 10 s a block, and then the collect plugin's task is cancelled). A batch that brings nothing in counts as a failure and its blocks are skipped, and the loop has a hard cap of qty + 12 rounds.
    - `pickup`'s path got a time limit too.
    - **Drops that roll away.** The collect plugin only goes after a drop that lands within half a block of the block's center. After a batch that brought nothing in, the skill walks over matching drops it can see within 3 blocks of where it dug before counting the batch a failure.
    - **New information lifts a stuck mark (§4.6).** In the second regression run, M4's agent needed three raw iron. Each `prospect` showed one ore, each `obtain` dug it and then failed for want of the next, and one lost drop tipped `obtain` into "stuck". The code default then explored away from the ore it had just found. Now a `prospect` that finds an ore lifts the marks of tasks that failed for want of it.
12. **A loop without a cap in mineflayer (§13 rule 6), found by the regression run.** In M6 scenario H, every bot in the test process timed out half a minute after the victim died. The process was at 100% CPU; the inspector, attached to the stuck worker, showed it spinning in mineflayer's `putSelectedItemRange`.
    - That loop runs while the window it was given still has an item on the cursor, but `clickWindow` acts on whichever window is open now. The victim had died with an item on the cursor of a container window, most likely mid-craft. Once that window closed, every click went to the inventory and returned at once: a microtask loop that starved the event loop.
    - Our mineflayer patch now gives up after 40 passes, or as soon as the window is no longer the open one or the connection has ended. An M1 live test holds a stack over a closed table and expects the put-back to fail at once.
13. **Regression on the final M6b tree** (all live exit tests, one after another). Three more issues surfaced on the way and were fixed before the final run:
    - **A timer that fired into a stopped agent.** All of M4's checks passed, but the run failed on an unhandled rejection. A Goal Gen run asked for "soon" fired after the agent had stopped and read the memory database after it had closed. Now:
      - Goal Gen and the CC cancel their delayed runs on stop.
      - Module runs log their errors instead of leaving them unhandled.
      - Memory finds nothing once its database has closed, including a recall that was waiting on the embedder when it closed.
      - A unit test reproduces the race.
    - **A hand-over picked up late.** In one run of M6 scenario G, Wit picked up the bread after Pip's `give` had stopped watching. It had started watching only after stepping back, and only for 5 s. So the give failed, and the promise stayed open although the bread had arrived.
      - The give now watches from the moment the items leave its hands, for 8 s, and reports what it tossed.
      - If the receiver is seen picking those items up within a minute, the promise counts as kept (§6.6).
    - **A test that assumed full health.** M1's flee test took 13 HP off a bot that the zombie before it had already hurt, which killed the bot. The test now heals it to full first.
    - **Final result:** M1 skills 17/17, the M1 night test, M3 2/2, M4 3/3, M5 3/3, M6 8/8, M6a 3/3 and M6b 1/1, all green.

### M7 (2026-10-22)
1. **Telemetry (§8 `telemetry`), dashboard only** (`agent/src/hub/telemetry.ts`). Each bot sends the Hub:
   - every decision with its option, task, stance, `mayCommit`, source (model, code default, impulse, reflex) and rationale
   - how each option ended, every skill result (expected vs observed, with the duel's outcome), rung changes and fights
   - conversations that ended, goals set and done, commitments made and resolved, and its own lines as the chat echoed them
   - its state every 5 s (position, health, food, goal, option, emotions, mood, caution, rungs, inventory, queue) and its view of each person every 15 s (sentiment, facts, trust, admiration, fear, friction, resentment, rung, last fight)
   - The Hub keeps all of it for the operator and never fans any of it out to another bot (§13 rules 4 and 8).
2. **The dashboard** (`hub/src/dashboard/`), served by the `pnpm start` process on `127.0.0.1:8080` by default:
   - **Overview:** mode and uptime, a quota banner when saving tokens, headline tiles (including when the weekly quota runs out at this rate), the agents (goal, what each is doing and why, its strongest feeling, fear over the last minutes), tokens in the last hour by module, tier and agent, events (joined, left, died, fights, impulses), the chat and warnings.
   - **Per agent:** its state now, the last decisions with their reasons, what came of them, what it said, its events, and where it stands with each person.
   - **Who thinks what of whom:** two heatmaps, sentiment on a diverging blue–gray–red scale around a neutral 5 and admiration on a sequential blue; each cell's tooltip adds trust, fear, resentment and the rung. Every chart has a table view.
   - **The page** is plain TypeScript compiled by esbuild's `transform` at startup (no bundler step, no CDN), with light and dark themes. It follows the dataviz rules: one hue per job, gray midpoint, values first in tooltips, text in text colors, a table for every chart.
3. **Security (§23.3):**
   - The server binds `127.0.0.1` (`hub.dashboard.host`; `0.0.0.0` only inside the container, where compose publishes on the host's loopback).
   - It answers only for loopback host names or the address it was told to bind (HTTP 421 otherwise), so a page on another site can't read it through DNS rebinding.
   - Every response carries a strict CSP (`default-src 'none'; script-src 'self'; …`), `nosniff`, `no-referrer` and `no-store`. Agent names in URLs must look like player names.
4. **`pnpm ctl`** talks to `POST /api/ctl` with the RCON password from `.env` as a bearer token (compared in constant time; JSON only, 64 KB at most):
   - `status`, `stop`, `restart` (in-process; under systemd or Docker it exits 75 and the manager starts it again), `save` (`save-all flush` plus every bot's snapshot and a memory checkpoint), `population <n>`, `mode test|live [--new-world]`, `say <msg>` (an ordinary server message) and `rcon "<cmd>"`.
   - **§13 rule 10:** `rcon` refuses `op` for anyone but `world.owner.username`, wherever it appears in the command (`execute … run op`, `minecraft:op`), and chat spying unless it's set on the owner's own user.
5. **`pnpm logs`** follows every process's JSON log, merged by time, with `--agent`, `--module`, `--level`, `--since`, `--lines`, `--no-follow` and `--raw`. It reads only whole lines and tails by bytes, so a large log doesn't load into memory.
6. **Export and import (§23.4):**
   - `pnpm export [--hot] [--with-logs]` writes the world, agents, graveyard, roster and config into `export-<date>.tar.gz`, never `.env` or caches. `--hot` saves everything first through `ctl save`.
   - `pnpm run import <file> [--force]` takes only plain files and directories under `data/` and `config/` (no links, no paths that climb out). `--force` moves the existing data aside first.
7. **Running it for good (§23.2):**
   - `pnpm deploy:systemd` writes `deploy/minecraft-agents.service` (a user unit: restarts on a crash and after `ctl restart`, 120 s to shut down gracefully; secrets stay in `.env`).
   - `deploy/Dockerfile` pins Temurin 25 by digest and Node 22 by checksum; `deploy/compose.yaml` mounts `./data` and `.env` (never copied into the image) and publishes both ports on `127.0.0.1` only. The EULA is accepted only when `.env` sets `AGORA_ACCEPT_EULA=true`.
   - **Checked by unit tests, not built here:** the pins and checksums, the loopback-only ports, the mounted `.env` and the `.dockerignore`. The image itself wasn't built in this session: the sandbox allows no container runtime.
8. **Deviations:**
   - "Cost/hour" is subscription tokens per hour against the weekly quota (§22.4), not dollars.
   - The culture metrics (§6.8) and role entropy come with M8's roles.
9. **Live exit test** (`tests/live/m7-dashboard.test.ts`): 1/1, run twice on the final code. Two code-only agents (Pip and Bram) under the supervisor, as in production. Through the API, each one's decisions came with their reasons ("code default: get stone_pickaxe for the goal") and with what came of them ("obtain failed: holding 0 stone_pickaxe"), and the social view showed their first impressions of each other. `ctl` refused a wrong token (401) and refused `rcon op` for a bot. It took status, say, save ("2 agent snapshots written") and population 1, after which one agent left and its departure showed in the events. A hot export made right after the save restored both agents, with their snapshots, into a fresh data directory.
10. **The page in a browser:** The telemetry from the live test was replayed into the dashboard and opened in Chromium (Playwright), in light and dark, at 1280 and 390 px. It ran with no console errors, no failed requests and no horizontal page scroll; an agent's details, the table views, a tooltip and the theme switch all work. The first render showed five layout bugs, all fixed before the final render:
     - The quota banner's box showed when empty, because a class's `display` beat `hidden`.
     - The empty feeds' text wrapped one word per line.
     - The bar chart's text scaled up with its SVG. It is now drawn at its own size and only ever shrunk.
     - The "runs out" date wrapped. It now reads "in 35 min", with the clock time beneath.
     - Rung 0 read "avoid" for everyone. It means no conflict at all, so it now reads "—".
     - The browser's own favicon request also logged a 404; it now gets a 204.
