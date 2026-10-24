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
>
> **v0.8 (owner requests, 2026-10-23):** debug controls for the operator: add, remove and restart agents; read and edit their memories; choose the model per tier and per agent; switch modules off; inspect and drive the Cognitive Controller (the dashboard was read-only, §8). Agents make their own plans and talk them over, with no fixed schedule (§4.2 module 10). They look around and wander rather than stand still. At night they hide only when badly scared, alone and far from anyone, and only by their own choice. Speech moves to L2. Test mode is off by default, with a switch (§16.3). What testing with the owner's NanoGPT key found, and the deviations, are in §24 under *Owner requests*.
>
> **v0.9 (owner requests, 2026-10-24):** a server console and Stop and Restart on the dashboard. A death ends every activity at once. Agents talk like Minecraft players, with a stronger model and time for it, taking turns and ending a talk once they agree. Agents make their own tools and real chests, and fight the mobs they can beat. Buildings: a building language; a repertoire drawn from photographs and read from the game's own files; a builder that puts designs up, clearing rough land; an architect, a fourth model called only to design, for buildings of their own; and moving to flatter land. Anvils and enchanting. Expeditions to the Nether and the End, by the agents' own choice. A hidden controller over all the agents steps in only on what has plainly gone wrong. All in §24 under *Owner requests: a console, deaths, talk, building and more*.

---

## Implementation status (kept current by the implementing session, §13 rule 7)

| Milestone | Status | Verified by |
|---|---|---|
| **M0** scaffold, schemas, setup/doctor/server-mode, bot joins | **done** | `pnpm run check` (typecheck, lint, §22.2 forbidden-strings, unit tests) + `pnpm test:live` M0 exit test on real Paper 26.1.2 |
| **M1** body: 21 verified skills with postconditions, L0 reflexes | **done** | `pnpm run check` + `pnpm test:live` on Paper 26.1.2: `m1-skills` (17/17, with the closed-window check added in M6b) and the exit test `m1-night` (a scripted bot survives a night on hard; 4/4 consecutive runs) |
| **M2** LLM client with the §22 subscription lock; Agent State with versioning and abort-on-stale | **done** | `pnpm run check`: the client against a mocked NanoGPT (§22.8 unit list, abort-on-stale), allowlist/tier resolution checked against the live 331-model subscription list; `tests/live/m2-nanogpt.test.ts` runs with `NANOGPT_API_KEY` + `AGORA_LIVE_LLM=1` With the key (2026-10-23): `m2-nanogpt` 2/2, 60 calls over the three tiers with the balance unchanged, and a paid-only model refused before sending. |
| **M3/M3b** single-agent PIANO (CC + bottleneck, option–action, executor, Action Awareness, Self-Monitor, Talking) and intelligence levers | **done** | `pnpm run check` (module tests against fakes and the mocked NanoGPT) + `pnpm test:live` exit test `m3-agent` on Paper 26.1.2: a code-only bot gets stone tools from nothing on its own; a bot driven through the full LLM path by a scripted model works through "get X first" steps, declines a spoken request, and never promises (the script tries to) With the key: in five observation runs (`obs1`–`obs5`, §24 "Owner requests") the CC, Talking and the Self-Monitor ran on the real models. In `obs5`, 401 of 432 decisions came from the model, and none of 779 lines was cut off. |
| **M4** memory (Summarize-and-Forget over SQLite + local embeddings), Goal Gen, personas with quirks | **done** | `pnpm run check` + `pnpm test:live` exit test `m4-agent` on Paper 26.1.2: a code-only bot runs its own goal chain (wooden pickaxe → stone tools → furnace → iron pickaxe, the iron hidden in the ground and found by digging) with its quirks visible (picks poppies, hums for company); a told fact drops out of working memory into SQLite and is repeated with attribution, in a later conversation, through the real local embedder; hidden ore isn't a target until seen With the key: Goal Generation's plans (L3) came from the real models in `obs2`–`obs5`; in `obs5`, 38 of 40 L3 calls were answered. |
| **M5** Hub (rate tokens, budgets, shared embedder, speech guard), supervisor, proximity-chat conversations among several agents, graceful shutdown and resume | **done** | `pnpm run check` (Hub protocol over a real socket, supervisor with stand-in bots, floor control, snapshots, persona calibration) + `pnpm test:live` exit test `m5-population`: real bot processes join through the Hub, shut down gracefully and resume as the same agents; two agents meet and talk until their conversation ends by itself, with nothing looping afterwards; scenario C with four people. `pnpm start` run twice on a fresh normal world: two agents, a death (lava) archived and replaced, resume after Ctrl+C |
| **M6** Social Awareness, commitments, trades, the help option, claims; deaths matter to the living | **done** | `pnpm run check` (social updates with and without a model, commitments, trades, help, deeds, rumors, deaths) + `pnpm test:live` exit test `m6-social` on Paper 26.1.2, 8/8: **A** a scripted-model Bram asks code-only Pip for 8 logs; she promises, gathers and hands them over, both sides record the promise as kept, and Bram's sentiment goes 5.6 → 8.1 (trust 0.6); **B** a promise past its deadline drops trust to 0.3 and comes up when Bram talks later; **D** a false diamond claim is checked and the teller's trust drops; **E** a zombie ends a conversation cleanly, with a canned line, and talk resumes; **G** a plain client gets bread through the same code paths; **T** an offer made in chat is accepted and both halves are handed over; **K** help gathering wood ends with the logs handed over; **H** a killed agent is replaced in 6 s and the survivors grow more cautious |
| **M6a** emotions and biases core: feelings, impulses, first impressions, gut against facts, conformity, mobs | **done** | `pnpm run check` (appraisal, decay and contagion; gossip read in code; impulses and regret; first impressions fading into the facts for the rational; conformity, confirmation, availability, scapegoat; mobs) + `pnpm test:live` exit test `m6a-minds` on Paper 26.1.2, 3/3: **Q** an insulted hothead shouts back within 0.5 s while a stoic answers calmly; **M** diamond armor impresses a vain agent at first sight (7.0 vs 5.4 for leather) and a rational one hardly at all; **N** three people turn on Rex: an impulsive conformist joins in and a rational onlooker who knows him speaks up |
| **M6b** conflict core: grievances, power and fear, the escalation ladder (rungs 0–3), the code gate, brawls that end in a yield | **done** (the lethal rung waits for M8b) | `pnpm run check` (pressure from grievances and fear, rungs with hysteresis and pacing, the gate in the CC, yields heard and reckoned beatings, fight slots, staying within reach) + `pnpm test:live` exit test `m6b-conflict` on Paper 26.1.2, 3/3, and again in the full regression: **I** two quarrelsome brutes with a seeded grudge share a grove: hostile talk at rung 1, threats at rung 2, then one brawl at rung 3 that ends when one gives up ("ok ok, I yield!" at about 5 HP, or running off); nobody dies, and the loser fears the winner more |
| **M7** dashboard (per-agent state, decisions with their reasons, conversations, the social graph, tokens per hour), `pnpm ctl`/`logs`/`export`/`import`, Docker and systemd | **done** | `pnpm run check` (the dashboard model and server: host check, CSP, token, body limits; ctl commands and refusals; telemetry; logs merging; export/import round trip; the unit and Docker files) + `pnpm test:live` exit test `m7-dashboard` on Paper 26.1.2, 1/1 (twice): two code-only agents run under the supervisor; through the dashboard's API, each agent's decisions come with their reasons and what came of them, and who thinks what of whom; `ctl` works with the token only (status, say, save, population); a hot export after `ctl save` restores both agents with their snapshots. The page rendered in Chromium, light and dark, with no console errors |
| **M8** social goals, the community goal, roles, the notice board | **done** | `pnpm run check` (the division of labor from what each agent perceives, roles from deeds and from the last five social goals, the village moves and their finishing acts, signs read and written, staying fed and healing, the dashboard's village card) + `pnpm test:live` exit test `m8-village` on Paper 26.1.2, 2/2: **NB** a death by the village goes on a sign at the board, and a newcomer who never heard of it reads it there (it goes on its mind, and it grows more careful); **V** five code-only agents (real bot processes, as in production) live together for 60 minutes: at the end a builder, two hunters, a miner and a woodcutter (role entropy 1.92 bits), with 8 deposits in the village chest, 14 hunts and a sign |
| **Skins** (owner request, §16.5): each agent the supervisor creates wears a NameMC skin by its sex ("boy", "girl"), signed through MineSkin and put on as it logs in | **done** | `pnpm run check` (the listing read, and its Cloudflare challenge told apart from it; the owner's saved pages and lists; skin images checked; MineSkin's pacing, retries and refusals, the key never in an error; the choice by sex, no two living in one skin; the cache; skins.tsv; the supervisor dressing each new agent before it first logs in, or on the way) + `pnpm test:live` `skins` on Paper 26.1.2, 2/2: NameMC turned the Hub away (its Cloudflare challenge), so the owner's saved picks were used; MineSkin signed both; Bram logs in in the boy skin and Ivy in the girl skin, as another player's client receives them, signed, with the signatures good under Mojang's published keys; Tom, dressed while online, is seen in his at once; a player can't run the reload; and the supervisor creates Bram and Pip in boy and girl skins before they first log in |
| **M8b** power structures: demands and tribute, followers and leaders, grudges and gossip, coalitions and uprisings, the lethal rung, the extinction brake | **done** | `pnpm run check` (demands read and answered, coerced commitments and tribute; followers and leaders as each agent sees them, and side-taking; grudges and gossip; coalition power, openings, and the opening waking the CC; calls to rise, joining, and uprisings carried out together; the lethal rung and yields; the brake) + `pnpm test:live` exit test `m8b-power` on Paper 26.1.2, 3/3: **J** Rex, a domineering tyrant, demands bread and logs; the timid two give in and come to follow him, the proud refuse; **K** Rex goes out alone and hurt; those he wronged rise against him (Bo calls on Ann, she swears to it, and both strike him), and his two followers, back at his side as it gets under way, see him set upon and walk away; nobody dies; **L** with his two followers always at his side, the three who resent Vex fully grumble but never rise (their coalition 0.19 against his 0.86, no opening); **D** a fight to the death ignores Pell's yield, and Wit, watching, holds a doubled betrayal grievance against the killer |
| **M8c** reflection as debiasing, hearsay, fear and conformity (the preference cascade), more biases | **done** | `pnpm run check` (the audit's candidates; corrections taken by rationality and resisted by the stubborn; inoculation and growth; hearsay grievances; a feared leader keeping dissent quiet, and defiance that goes unpunished bringing it out; tribute and the bandwagon; the in-group, attribution and sunk-cost biases) + `pnpm test:live` exit test `m8c-minds` on Paper 26.1.2, 2/2: **O** a neighbor's rumor that Kai stole is taken in by both as a grudge from hearsay (resentment 0.12 and 0.14); after the bias audit, rational Ria lets it go (0.00, inoculated, and the rumor told again weighs half) while stubborn Ulf keeps it (0.14); **P** asked what they think of Rex, the four who go along say much the same while he is armed and feared (variance 0.017, one dissenter), and once he is plainly weaker three speak against him (variance 0.040) With the key (`real-models`, run with `AGORA_LIVE_LLM=1`): glm-5.1, asked about two people, named Bram's dislike as hearsay ("my bad feeling rests on Cass's words, not Bram's actions") and Dov as an idol. Both were corrected: Bram 2.5 → 5.2, with the hearsay grudge gone, and Dov's admiration 0.9 → 0.45. Zed, whom she saw steal, was not asked about and stayed as he was. |
| **M9a** romance: who can be drawn to whom, attraction and interest, crushes, courting, partners and breakups, advances and rejections (§19.10), jealousy, PG | **done** | `pnpm run check` (orientation and the sex others take one to be; attraction and interest; the stages; the §19.10 tables, a partner's advance returned, and the soft cap; jealousy; the PG filter; the code gate; the CC packet and the code default's courting) + `pnpm test:live` exit test `m9a-romance` on Paper 26.1.2, 3/3: **R** two strangers, each deciding for themselves, go from a first hello ("hey, how is it going? I'm a guy who loves exploring.") through crushes and courting to partners in 13 minutes, everything said PG; **S** a proud, vain suitor is turned down kindly every 3 minutes; he keeps at it three times, and the fourth no, with no attempts left, he takes with resentment ("fine. your loss.": a grievance, and less liking); past the soft cap, code holds back every advance to her, and he makes none after; sadder each time (0.70); **V** a man courts Ivy in her partner's hearing and is turned down kindly; her partner feels envy and anger within 10 s, holds a `romantic_rival` grievance against him, and is still her partner With the key: after conversations in `obs2`–`obs5`, the real models read compatibility for 40 pairs, from 0.30 to 0.90. Interest grew a little (at most 0.28); runs that short formed no couple. |
| **M9b** families: starting one, the bed ritual, births on the Hub, inheritance, the newborn, youth and parents | **done** | `pnpm run check` (inheritance over 300 children; the family watch, the code default's family steps and its gate; a parent's word in youth; birth facts; youth and kin in the conflict core; the Hub's pairing, gate, gestation across a restart, a person as a partner, a full population) + `pnpm test:live` exit test `m9b-family` on Paper 26.1.2, 2/2: **T** through the real Hub and supervisor: partners with a home and food, one asks and the other says yes, they lie down side by side at night, each reports it, and the Hub brings their daughter into the world at the beds; her first words name her parents, who know her for theirs; her traits lie within her parents' range (28 of 28), and she knows her family and no one else; **U** a father warns his young daughter about the man who attacked him; she has never met him, and turns against him (5.00 to 4.49, a grievance told by her father), and a gift from him later mends it somewhat |
| **M10** the L3 skill writer (sandboxed, self-verified, reused) and reflection's trait annotations | **done** | `pnpm run check` (the sandbox's limits and that nothing of the host is inside; a draft's checks in code; the library in SQLite, offered by relevance; the writer against the mocked NanoGPT: written, tried at once, kept, written again told what went wrong, given up, refused drafts, a trial cut short, the hourly cap and the four gates; private hosts; the CC wanting and offering written skills; formative experiences, the note's form, with and without a model, the five latest) + `pnpm test:live` exit test `m10-skills` on Paper 26.1.2, 1/1: Ada's CC (a scripted model, the full LLM path) reaches for `stock_up_logs`, which she doesn't have; L3 writes it once from her verified skills, it is tried in the world at once (3 logs in 17 s, its check `inventoryHas:oak_log>={qty}` holds) and kept in her memory database; her CC, now offered it, reaches for it again for 6 logs, and it runs as a skill she has without being written again With the key (`real-models`): glm-5.1 wrote `stock_up_logs` at the first try (a `gather` of `qty` oak logs, checked by `inventoryHas:oak_log>={qty}`). Tried at once in the world, it held (3 logs) and was kept. It ran again for 6 without being written again. Its trait annotation found a bug. The model named the experience in its own words ("robbed by Zed"), not by its key, and the note was dropped; such words now count. It had also copied the prompt's example, which was code's own words, so the prompt now gives the form only. Its notes now: "has grown more cautious since losing that fight to Vex". |
| **Owner requests** (2026-10-23): debug controls (agents, memories, models, modules, the CC); agents that plan for themselves and talk their plans over; wandering and looking around instead of standing still, in company; hiding only when badly scared, alone and far from anyone; whole lines at L2; test mode off, with a switch; seeing what changes around them (a broken shelter) and reacting; each new person written by a master model, a child while it is carried | **done** | `pnpm run check` (576 tests) + the live regression on Paper 26.1.2 (§24 "Owner requests", item 14) + five observation runs with the key (`obs1`–`obs5`, the last two hardcore nights) + `real-models` with the key: the bias audit, a trait annotation, a skill written by L3, a broken shelter seen to and the master model's newcomers and a child, all by glm-5.1 |
| **Owner requests** (2026-10-24): a server console with Stop and Restart; a death ends everything at once; talk like players, with a stronger model, turns, and an end once agreed; own tools, real chests, armed fights; buildings (a building language, a repertoire from photographs and the game's own files, a builder, an architect for their own designs, moving to flatter land); anvils and enchanting; expeditions to the Nether and the End; a hidden controller for what has gone wrong | **done** | `pnpm run check` + the live tests of each (§24 "Owner requests: a console, deaths, talk, building and more", item 19), the architect's own design drawn by glm-5.3 and built in the world, and the controller's prompt benched on the real models |

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
- An `ignore_until_start` flag after a conversation ends prevents loops. If the partner goes silent, the bot doesn't ask whether they're still there: it can see them, so silence means they're busy, and the talk ends quietly (v0.9, §24).
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
| 10 | **Goal Generation** (planning, v0.8) | LLM | L3; L2 after a talk | at start, when a plan is finished, every 3–5 min (kept unless it should change); after a conversation, what was said is weighed into the plan (at most every 90 s) | persona, summary, social, memory, what was said → `goals.plan` (2–6 steps in the agent's words; the step at hand is `goals.current`) |
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

### 4.8 The thinking mind (v0.9, owner request 2026-10-24)

The owner found agents that acted on directives rather than thinking. They couldn't deal with anything they hadn't been told about: one killed the only sheep for wool, then looped, not knowing where else wool comes from. They took no notice of a player flying in creative mode. And they played slowly and rigidly, although they are meant to know the game. The research behind the redesign is in `docs/research-human-learning.md`: situation awareness, prediction error and surprise, expectation violation in infants, compiled skills in ACT-R, and studies of how players learn Minecraft. **The rule from here on:** nothing is coded towards a particular goal. When an agent fails at something, the general mind or its general hands get better, the way one would tune a person's mind, never a rule for that case.

**Senses** (`perception/scene.ts`, `motion.ts`, `sceneWords.ts`). An agent sees what is in its line of sight, as a player does, rather than what a block search turns up.
- **A panorama of rays:** 64 directions round × 26 heights (denser near the horizon), out to 56 m, 170 rays each 250 ms tick, so the whole view is renewed in about 2.5 s. Hits are kept per 3-block cell.
- **Features:** the hits are grouped into the things a player sees: trees, rock, sand, gravel, clay, snow, water, lava, ore, crops, plants, built things, stations, containers, beds, portals, spawners, danger (fire, magma, powder snow, wither roses). Each has its nearest point, distance, compass bearing, height above or below, size, and whether this is the first one ever seen. Liquids and small things that matter (ore, beds, stations, chests, sugar cane, cobwebs) get a separate scan, since rays pass between them.
- **Creatures:** every entity in sight. The line-of-sight check looks past glass, panes, bars, fences, gates, chains and scaffolding. Each creature comes with its motion (still, walking, running, jumping, falling, flying, swimming, climbing, riding, gliding), speed, height above the ground and time in the air, which way it is going (towards the agent or away), how it relates to the agent and to others (looking at you, a hostile going for someone, next to someone or something, in water or lava, riding), and what can be seen of it (a sheep's wool colour and whether it is sheared, a baby, what someone holds or wears).
- **Where:** the biome (from the client's biome palette) or dimension, what is underfoot, the open sky, a roof or a cave ceiling, walled in or not, the weather.
- **A map of places:** stations, chests, ores, portals, beds, water, lava and more, up to 80, each with its position and when it was seen (`knowledge.places`).

All of it is put into words for the packet in that order: notices first, then features, then creatures in groups ("2 sheep, 12-15 m north: standing still, white wool"). What happens to the agent itself is checked too: moved in an instant, the time of day jumped, things in its pockets from nowhere.

**Expectations and surprise** (`mind/expectations.ts`). For each kind of creature the mind keeps an envelope of what it has seen it do: speed on the ground and in the air, time in the air, hovering, height. Something outside its envelope makes a notice, a surprise whose strength grows with how far outside it is. Examples: a person 7 m up with nothing under them, not falling, for 4 s now; someone keeping up 25 m/s; someone who just went 30 m in an instant; someone standing inside solid stone. Speed counts only when kept up for about 2 s: a burst (a jump off a sprint, a knock back, a lagging player catching up) surprises nobody, and only kept-up speed widens the envelope. Seen three times, a surprise becomes a belief about that one ("Kelby can stay up in the air") and stops surprising. That is habituation, not a rule. Novelty also makes notices: the first creature of a kind, the first remarkable block (diamond ore, a spawner, a portal). The only built-in priors are what any player knows at a glance: bats, phantoms and ghasts fly; chickens flutter down; spiders climb; fish swim; endermen blink; slimes and rabbits hop. What the game does by itself is no surprise either: bees in and out of their nests, a spawner's mobs, what comes through a portal, a player joining, silverfish out of stone, an evoker's vexes, a slime split in two, a wandering trader and its llamas, a village's golems and cats, one creature turned into another. Nor is what one's own hands put in one's pockets: what the last minute's actions name is one's own, whenever it lands (a craft's result can reach the pockets well after its window closed). The sun getting low (from 10800 of the day's 24000 ticks, about 2 min before dark, seen from under the sky) is a cue each evening, not a surprise: it comes every evening and matters every evening. A notice of strength ≥ 0.6 wakes the CC at once.

**Thinking** (`modules/prompts.ts`, `modules/cc.ts`). The CC's system prompt is the persona, `EXPERIENCE` (years of play: what an experienced player knows and does without thinking), `THINKING`, `CHOICES`, the skills and `DECISION_FORMAT`. `THINKING` has six steps, in the order of situation awareness:
1. What is going on, and what does it mean for me?
2. Does anything surprise me or not fit what I know is possible, and what could explain it?
3. What happens next if I carry on?
4. What am I after, and what is it for?
5. What are the ways there? For each: what it needs first, how long it takes, how likely it is to work, what could go wrong, and what it leaves me with.
6. Choose, knowing how I will tell it worked.

A failure is to be understood before anything is tried again; then try another way, wait for a better moment, or let it go. The old situation rules (`DECISION_RULES`) are gone. The reply's new fields:
- `thought`: the reasoning, in the agent's own words, shown on the dashboard;
- `then`: up to 6 more steps;
- `later`: something to do when a cue comes;
- `lesson`: something learned;
- `taskDone` / `taskDropped`: a task finished, or given up as impossible or not worth it.

**The packet** (`modules/bottleneck.ts`) follows the same order. It gives who you are and how you are (hunger in words: "you are starving and carry nothing to eat"), what you see, what you carry, places you know, your tasks, your plan, what you tried lately and what has not been working, the lessons that bear on it, what you know of the game for the items in play, and why you are thinking now.

**Game knowledge** (`mind/knowledge.ts`). An experienced player knows where things come from. `GameKnowledge` reads the game's own data (recipes, smelting, block and mob loot) into the ways to get each item. A few facts the data can't tell are added: shearing leaves a sheep alive and its wool grows back, still lava under water makes obsidian, crops grow back from their own seeds, villagers trade. There are also short notes on topics a task may touch, such as portals, enchanting, armor, renewable food, animals, the dark underground (dark at any hour, and monsters spawn in the dark) and the night (how long it lasts, what spawns, what keeps it off, that a torch only keeps them from spawning right beside it). The packet gives the ways to get the items that matter now (in the tasks, the plan and the latest failures), and up to three notes: those for the hour (evening, night), the step at hand, the plan and where one is first, then those for the tasks. It is knowledge, not instruction: it says what is possible, never what to do.

**Intentions and deferral** (`modules/cc.ts`, `mind/later.ts`).
- **Intentions:** the steps in `then` run one after another, with no model call between them while each works. A step that fails, a surprise or danger brings the model back. An intention lapses after 12 min.
- **Deferral:** `later` keeps a deferred intention with a cue: seeing something, having n of something, day, night, or in n minutes. `LaterWatch` checks the cues every 3 s and wakes the CC when one comes ("you remember: you meant to …"). An unmet intention is forgotten after 90 min.

**Tasks** (`goals.tasks`). A task given in words (the console's `task` command, or code in tests) stays open until the agent itself says it is done or drops it with a reason. Being told a task wakes the CC and Goal Generation. Both see the open tasks.

**Learning** (`mind/learning.ts`). Lessons come from the CC's `lesson` field and from the Learning reflection, an L3 call (module `learning`) made every 10 min or after 4 failures. It reads the last episodes (what was tried and what came of it) and writes what worked, what didn't and why, and what to do instead. Lessons are deduplicated at 70 % word overlap, at most 60 are kept, and the packet gives those that bear on the moment. This is how an agent learns how the world behaves without being told. For example, after a run of failures with a buggy `obtain`: "Repeatedly retrying an obtain command that says 'I don't know how to get' is a waste of time; I should switch strategies immediately after the first failure."

**Hands** (`body/skills/hands.ts`, `movement.ts`, `planner.ts`). The general verbs a player has:
- `use`: an item on a creature or a block (shears on a sheep, wheat on two cows, a bucket on water, flint and steel on obsidian);
- `lead`: an animal, by holding out its food;
- `harvest`: ripe crops, planted again from their own seeds;
- `explore`: in a chosen direction.

What each is for is the mind's to know. `obtain` knows shearing and mob drops as routes. The pathfinder never breaks built blocks (fences, doors, walls, planks and more), opens doors and gates, and walks "on foot" without digging when working around animals and fields. And the hands have a player's habits, the compiled skills of someone who has played for years:
- `craft` makes what is one or two crafts away from what is in the pockets (planks from the logs on hand, sticks from those planks) before the craft, never touching what the recipe itself takes; it fails only when something would have to be got first.
- A kind of thing means it in the wood or colour on hand: a sign, a door or a boat in the wood carried (else oak), a bed, wool or a carpet in the colour carried (else white). Logs, flowers, leaves and saplings stay any kind, as they are found.
- In the dark underground, with torches on hand, a torch goes down beside the digger once the last light is about 9 blocks behind. The client's light levels are those the ground came with and don't follow changes, so the last light behind counts, as for a player.
- A crafting table or furnace more than 8 blocks off isn't walked to when one can be set down here: one carried, or a table made on the spot from a log (a walk of 16 blocks through tunnels timed out twice live).
- With no free spot to set something down (a tunnel), a notch is dug in the wall beside one's feet for it.
- Prospecting for an ore mines what it finds there and then, the vein in sight (it had found iron and the next step, to smelt, had none).
- Shelter seals its top with any whole block that stays put (planks and logs too; it had refused 64 planks), and `obtain` takes up to 256 (a hut's 75 blocks were out of reach at 64).
- Never a block with lava against it, when gathering or mining as when prospecting: broken, it lets the lava in (an agent died so, chopping a tree by a surface pool).
- A furnace never burns what it is cooking, and planks go in before logs (a log makes four planks, each burning as long as the log); the planner makes planks for fuel when only the logs to be cooked are on hand.
- Raw meat that cooks (beef, porkchop, chicken, mutton, rabbit, fish, potatoes) waits for the furnace while hunger isn't pressing (food above 8, health 10 or more): raw beef is 3 and steak 8 (an agent ate the beef she had brought back to cook).
- A walk gets the time it takes: 20 s and 1.5 s a block (up to 4 min) at the least, whatever the option was given, and goTo's own limit grows the same way (long walks timed out a minute in, 57 blocks short).
- An option's `until` is until it comes true: one already true at the start isn't watched (asked to gather 5 more logs while holding 10), and an option stopped because it came true is recorded as done, not failed.

**Reflexes, from the long runs.** Two agents died in their first night of the long runs (a spider in a cave, a skeleton in the open), both while running. Running away is still the reflex when a fight looks lost, but it is now a run, not a dig: the running movements never mine, and the way back along the trail (where one walked lately, known to be open) is taken first, never towards or past what chases. Running that isn't working (two blows in 6 s once the run has had a fair start of 1.5 s, or going nowhere, with the attacker close) turns into a fight for 12 s, as with anyone cornered: a spider outruns a player and a tunnel ends. A creeper about to go and a warden are always run from. Cornered in a hole with them at its mouth, a block in hand closes it over (one died so at dawn, digging out of her shelter with a zombie at the top; live, `cornered`, she towers out instead when she can). With no sword or axe, the best tool is what one hits with (a pickaxe hits two or three times as hard as a fist). The hiding gate (§24, owner requests 2026-10-23) counts home only once it is a shelter (a hut built there): sent back to an empty field at night, hurt and hunted, an agent died there.

**Models** (`config/models.yaml`, `mind`). The CC's thinking replies are longer, so it has its own list, benched on them: glm-5.3 first (3.5–6 s), then minimax-m3 (3–5 s, but it ran out at the old 8 s limit), kimi-k2.6 and glm-5.1 (5–10 s); 15 s timeout; L2 max tokens 900.

**Kept.** The code default (`codeDecision`) remains the no-model fallback, and all reflexes stay. Intelligence still sets how far ahead plans go (`planDepthFor`). §21.2's knowledge gating is not used by the new mind: every agent knows the game.

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
- Partner out of hearing range for > 10 s; our line unanswered > 25 s while they're in sight (no nudge: the talk just ends, v0.9); danger; CC chose another option.
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
10. **(v0.2) Bots never get op or `pchat.spy`** from the system itself. (v0.9, owner request: the operator's console runs any command, op for anyone included; an agent never types a command, so startup only warns about an op agent.)
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

### 16.5 Agents' skins (owner request, 2026-10-22)
Each agent the supervisor creates gets a skin from [NameMC](https://namemc.com) by its sex: one tagged **"boy"** for a male agent, **"girl"** for a female one (`skins.tags`). It is chosen and put on when the agent is created, before it first logs in, and it stays the agent's for its whole life (it is kept in `roster.json`).
- **Where skins come from (`packages/hub/src/skins/`):**
  - **The tag's listing** (`namemc.com/minecraft-skins/tag/<tag>`, the first `skins.pages` pages, the most liked first; read again once a day). NameMC puts these pages behind a Cloudflare challenge for anything that isn't a browser, and the Hub never tries to get past it: an honest client (its own user agent) asks, and when it is turned away the Hub says so once and asks again only hours later.
  - **What the owner saved** comes first, and is what is used when NameMC turns the Hub away: tag pages saved from a browser (Ctrl+S, "HTML only") and `.txt` lists of NameMC skin links, in `DATA_DIR/skins/namemc/<tag>/` (setup creates the folders).
  - **The image** comes from NameMC's image host (`s.namemc.com/i/<id>.png`), which serves it as it is. Only a 64×64 or 64×32 PNG of at most 64 KB from that host is accepted, and no redirect is followed.
- **Signing (MineSkin):** a Minecraft client shows only a skin that Mojang hosts, with a textures property Mojang signed, and in offline mode no player has one. [MineSkin](https://mineskin.org) makes that signed copy of the image (on one of its accounts). The copy is `unlisted` by default (`skins.visibility`). With `MINESKIN_API_KEY` in `.env` (optional, never logged) its limits are higher; without one its anonymous limits apply (10 a minute, 60 an hour, 6 s apart), plenty for a village. Requests go one at a time, as MineSkin paces them.
- **The choice:** among the tag's first 24 skins, one that no living agent wears, at random; one already signed comes first (no request at all). An image that isn't a skin, or that MineSkin rejects, is never tried again; `skins.exclude` lists skins never to use. Listings, images and signed copies are cached in `DATA_DIR/cache/skins/`, so each skin is fetched and signed once.
- **Putting it on (`server-plugin/agora-skins`):** the Hub writes `plugins/AgoraSkins/skins.tsv` (username, signed value, signature) for the living. The plugin puts the textures property on each as they log in (`AsyncPlayerPreLoginEvent`), so they appear in it from the first moment. `agoraskins reload`, from the server console only, applies it to those already online.
- **Waiting:** a new agent waits up to `skins.waitSec` (60 s) for its skin. If it comes later it logs in without one, and puts it on when it comes. One without a skin (it couldn't be had) gets one the next time it is started.
- **Humans** keep their own skins. Skins are for the agents the supervisor creates, which it knows as infrastructure; the agents themselves are told nothing about it.
- **Content:** NameMC's tags are given by its community, so a skin could be unsuitable. The most liked of each tag are used; `skins.exclude` removes any the owner doesn't want.
- **Off:** `skins.enabled: false` (the plugin isn't installed, and agents wear the default skin).

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

### M8 (2026-10-22)
1. **Social Goal Gen (§4.2 module 11)** (`modules/socialGoalGen.ts`), L2:
   - **When it runs:** every 60–120 s while someone else has been seen in the last 2 minutes. It also runs soon after a death is heard of (the prompt adds "think about keeping each other safe", §16.3) and after a piece of village work is done.
   - **Under quota pressure (§22.4):** half as often from degrade level 1, off from level 2. Deviation: §5's per-agent step (Social Goal Gen slows at 80 % of an agent's hourly share) folds into level 1 in the Hub's budget message, so the slowing starts there.
   - **Output:** one or two goals, each with its kind of work (wood, stone, food, build, guard, tools, scout) and, if any, whom it's with.
   - **Prompt:** the persona core, the death rule, the community goal, the village as the agent knows it, the people around (sentiment, perceived role and wants), recent deaths, signs read, and its part so far.
   - **Guards:** single-flight, zod-validated, thrown away when stale, and cancelled on stop.
2. **The code default: division of labor from what the agent perceives** (`social/village.ts`). Each kind of work scores need × liking ÷ (1 + others seen at it), plus a little noise; the current work gets +0.15, so roles hold.
   - **Needs come from what the agent itself knows:**
     - what was in the village chest the last time it looked inside
     - huts seen near home, by their doors
     - hostile mobs that came near home in the last 10 minutes, and deaths to mobs it heard of
     - dusk or night
     - ore it has seen or read about
     - people who asked for food
   - **Likings come from the persona:** the Big Five, temperament, abilities and caution, plus words in its life goals, values and traits.
   - **Others' work comes from their deeds** (`social/roles.ts`): chopping logs, mining stone, fighting mobs, hunting animals, setting blocks down, and digging dirt (the stuff huts are made of), which counts half: a builder gathers long before setting a block down, and a few dug for a shelter or on the way to stone don't make a builder.
     - Each person has a tally per kind of work that halves every 10 minutes; at 3, that becomes their perceived role.
     - **What people say they do counts too:** taking up other work with someone around, an agent says so ("I'm building a hut for the village."). Whoever hears a line like that takes it as the speaker's role at once, over what they were seen at before; work done out of sight is known that way, as among people.
     - A role someone stated in conversation (the L2 read) also counts, while they're around.
   - **Divergence (unit test):** without seeing each other, five pool personas already start on 3 kinds of work; once they see each other at work, they spread over 4–5.
3. **Role (§6.8, as in Sid):** the kind of work behind most of the last five social goals (a tie goes to the latest), computed in code. It goes to the dashboard together with the role entropy (§11 F).
4. **Village work as goals:**
   - **When the village comes first:** once an agent has stone tools, Goal Gen's code default (`codeGoal`) puts its top social goal before its own next step with probability 0.5 + 0.3·agreeableness + 0.2·loyalty − 0.3·ambition, kept between 0.2 and 0.95.
   - **When a village goal is done:** the goal's `doneWhen` is `villageWork:<kind>`, a new condition. It holds once the work's finishing act has happened since the goal was set: goods put in a chest or handed over, a hut built, a patrol round walked or a hostile mob killed, or a notice posted.
   - **Prompts:** Goal Gen's prompt gets the community goal and the agent's part in the village. The CC packet gets "Your part in the village: …; everyone hopes to …".
   - **What the code default does for each kind** (`modules/villageMove.ts`):
     - **wood, stone:** gather 16, then put them in the village chest. With no chest seen near home, it makes one and sets it down there first.
     - **food:** hunt animals in sight, cook the meat, hand it in.
     - **build:** get blocks for a hut (dirt), a door if there are planks for it, then build the hut.
     - **guard:** fight hostile mobs near the village while health is at least 10; otherwise walk the edge.
     - **tools:** put a spare stone pickaxe in the chest.
     - **scout:** explore until it finds ore away from home, then post a sign at the board saying where.
   - **Nights:** a guard on duty stays out (while health ≥ 12 and caution < 0.8); everyone else digs in.
   - **Goals that never end.** Without a model, nothing replaced a goal the code default couldn't finish. Now a goal not finished in 20 minutes is given up; a model that says "keep" still keeps it.
5. **New skills** (`body/skills/village.ts`):
   - **`hunt`:** kills animals in sight and picks up the meat.
   - **`build {hut}`:** a 5×5 hut with walls three high, a doorway and a flat roof laid rim first, plus a door if the agent has one. It takes 71 blocks of cobblestone, planks or dirt, and 4 more for holes. The site is level, 4–20 blocks from home, with a free cell all round; up to 4 holes one deep under it are filled first, and of the sites at the same distance the one with the fewest holes wins.
   - **The ground by home is kept whole:** dirt and the like are dug more than 16 blocks from home. A gatherer near home walks out first, so the ground the huts go on isn't dug up.
   - **`sign {text}`:** posts at the board, next to the signs standing near home, or by home if there are none. The text goes on four lines of 15 characters, whole words only, and is read back the way anyone passing by would read it.
   - **`patrol {radius}`:** walks the village edge and fights off hostile mobs that come near.
   - `sign` is now an item category (any standing or wall sign).
6. **What the agent sees of the village** (`perception/village.ts`), all from its own eyes (§13 rule 4) and kept in the snapshot (§23.4):
   - its home (where it arrived)
   - the chest nearest home it has seen, and what was in it when it last opened it (`deposit` and `withdraw` now report the contents)
   - huts, by their doors
   - signs it has read. The board is where signs stand within 16 blocks of home: everyone's home is a few blocks apart around the world spawn.
   - hostile mobs that came near home
   - ore found away from home
   - **Work seen:** people fighting mobs and setting blocks down are now perceived deeds, for roles, at most one note per person and thing every few seconds. Fights between people are recorded as before, and the winner of a fight is now looked up only among fights between people.
7. **The notice board (§6.8, §16.1, §16.3):**
   - **Reading a sign:** it goes on the agent's mind as something seen (salience 0.5; 0.7 for news of a death). News of a death raises caution by 0.05, less than seeing or hearing of one.
   - **Posting a death:** a death that no sign mentions yet is posted by anyone near home who has a sign, or the planks to make one, before their own work. The notice is the death message, plus where it happened if they saw it.
   - **Sign formats:** signs are read the way the client receives them (the front's lines, as plain text, JSON or NBT text components).
8. **Dashboard:**
   - each agent's role, with its part in the village on hover
   - a Roles tile: how many roles, and the role entropy in bits
   - "The village" card: who has which role, and the words most used in the chat over the last hour
   - **Deviation:** the culture metrics (§6.8) are counted in code rather than summarized by L1, so they spend no tokens.
9. **Personas:** two more in the pool, Wren (a protector) and Oswin (a careful maker), so a village of five can come from the pool.
10. **Not built:**
    - **Constitution and voting (§6.8, optional):** per §16.1 it would be an agent playing a role (a "mayor" persona), not a Hub service. It waits until there's a use for it.
    - **Kinds of work:** farming and lighting the village are not village work yet.
11. **Live exit test** (`tests/live/m8-village.test.ts`, on Paper 26.1.2):
    - **NB, the notice board:** Ann heard of Bodo's death in lava by the village (the death message: this time she didn't see it, so no place went with it) and posted "Bodo tried to swim in lava" at the board; Cyrus, who came afterward and never had the death message, read it there: it went on his mind as something seen, and his caution rose from 0.35 to 0.4.
    - **V, the village:** five code-only agents (real bot processes) at the world spawn for 60 minutes, three nights.
      - **Roles:** at the end the five living were a builder, two hunters, a miner and a woodcutter (role entropy 1.92 bits among the settled). Roles held for long stretches (Oswin a builder and Pip a hunter from start to end).
      - **Work shown:** 8 deposits in the village chest (cobblestone, logs, cooked meat), 14 hunts and a sign.
      - **One hut tried:** 67 of its blocks were placed, 5 short of the plan, so not counted as built.
      - **Deaths:** seven died at night, six to zombies (most of them "speared": 26.1's zombies may carry spears) and one to a skeleton; newcomers took their places.
12. **Bugs found on the way:**
    - **The notice board:** test names a real server would reject (under 3 characters); a sign wasn't an item category, so posting one never checked out; and the board radius was too small for homes a few blocks apart around the spawn.
    - **Starving:** two agents starved in the first trial village, since nothing in the code default looked for food once the inventory was empty. Hungry with nothing to eat, an agent now takes food from the village chest, hunts what it sees, or looks around. Starving comes before the task at hand.
    - **Cooking:** the obtain planner couldn't cook meat in hand (raw meat comes from no block).
    - **"give me a sec"** was read as a request for an item called "sec".
    - **Mobs under the floor** (in a tunnel below) counted as threats. In a village, prospecting now digs its mine outside it.
    - **Slimes by day:** superflat ground is below Y 40, where slimes come out in any light, and the guard kept walking its rounds at half a heart.
      - The live village now stands on a deep flat world (grass at Y 40 over stone).
      - A badly hurt agent (health 8 or less) gets food first, then lies low until healed.
      - A hurt guard is off duty.
    - **Woodcutters without trees** look for more farther out.
    - **Goals that never end** (see 4).
    - **Attack attribution:** on 26.1 the hurt packet arrives a moment before the swing that caused it, so no attacker was ever found.
      - After two morning deaths, every newcomer took up guarding, since nobody had been seen fighting a mob.
      - A blow is now looked at again up to 150 ms later, in perception and in the reflexes.
    - **Morning deaths:** one agent was shot by a skeleton and one blown up by a creeper, each while running across open ground.
      - An armed, healthy agent now fights a lone archer instead of fleeing it.
      - Flight from archers heads out of their line of fire.
      - An agent leaves its shelter only once no mob is heard within 16 blocks, or by midmorning.
    - **Builders never built:** they asked for "2 dirt" while holding 59; the target is now the total. A shelter where the ground won't do is dug a few steps away.
    - **Everyone a builder:** a builder gathering dirt wasn't seen doing anything, so each agent who came to choose saw no builders, and within half an hour all five were building.
      - Dirt dug now counts toward building (see 2).
      - The dirt they dug riddled the ground by home with holes, so no hut site was left. The ground by home is now kept whole, and a site may have a few shallow holes, filled first (see 5).
      - With the ground by home kept whole, builders dug out of the others' sight, and again all took up building. Now they say what they do (see 2).
    - **Furnaces:** what was left in a furnace (cooked, or raw when the fuel ran out) blocked the next batch ("destination full"), and fuel already in it wasn't topped up. Now the furnace is cleared first and given fuel enough for the batch.
    - **Iron:** with a furnace still to make, the planner chose ingots crafted from an iron block (as cheap by its reckoning as finding iron ore) and went looking for one. Storage blocks are never searched for unseen.

### Skins (2026-10-22, owner request)
1. **The feature (§16.5):** `packages/hub/src/skins/` (NameMC, MineSkin, the skin service), the supervisor's `dress` step, `server-plugin/agora-skins`, and `skins:` in `config/world.yaml`. It is new to the design (the owner asked for it). Nothing about skins reaches an agent: a skin is what others see, and no agent perceives skins.
2. **NameMC is closed to automated requests (verified live):** tag listings, skin pages and the sitemap all answer a non-browser with Cloudflare's challenge (403, "Just a moment..."); robots.txt doesn't forbid the skin pages; the image host `s.namemc.com` serves images as they are. The Hub doesn't try to get past the challenge (no browser automation, no borrowed cookies, no browser user agent). Turned away, it tells the owner once how to save the page from a browser, uses what was saved, and asks NameMC again only after 6 hours.
3. **Why MineSkin:** a texture's URL on Mojang's server is the SHA-256 of the PNG file Mojang keeps (checked on several players' skins), but NameMC's images go through Cloudflare's image optimizer (`cf-polished`), which re-encodes them losslessly. So a NameMC image can't be matched to its Mojang URL by its hash, and an unsigned textures property is no good to clients anyway. MineSkin knew both test skins already (`duplicate: true`), and signs each in about a second.
4. **What clients get:** the signed payload names `http://textures.minecraft.net/…` and MineSkin's `url` field `https://…`, so the live test compares texture hashes. A client checks the signature (SHA1withRSA over the value) under Mojang's profile-property keys (`api.minecraftservices.com/publickeys`). The live test checks it too, in another player's player-info packets, and a tampered value fails.
5. **The plugin:** Paper 26.1's `AsyncPlayerPreLoginEvent#setPlayerProfile` puts the textures on before the player appears to anyone. `Player#setPlayerProfile` re-sends a player already online to all who see them (the reload). The command needs `agora.skins` (default op), so others see it as an unknown command, and the plugin refuses anyone but the console in any case.
6. **Builds:** `scripts/build-plugin.ts <name>` builds either plugin (`pnpm build:guard-plugin`, `pnpm build:skins-plugin`). The guard plugin rebuilt bit for bit to its pinned hash; the skins jar is pinned in `config/versions.yaml` and hash-checked by setup and at start, like the guard.
7. **MineSkin without a key:** its anonymous limits applied (10 a minute, 60 an hour, 6 s apart). The Hub follows its `next` delay and `Retry-After`, and `MINESKIN_API_KEY` raises the limits.

### M8b (2026-10-22)
1. **Demands and coerced commitments (§17.7)** (`conflict/coercion.ts`, `modules/cc.ts`):
   - **Who demands, and what:** at rung 2, a domineering agent (dominance ≥ 0.5) threatens with a demand instead of a plain warning: "give me 3 bread, or else" when it is short of food, else 8 logs. It promises nothing (`mayCommit` false).
   - **Reading a demand:** a request with a threat on it ("or else", "or you'll regret it", "if you know what's good for you") is a demand; "every day" makes it tribute.
   - **Asking before beating:** a domineering agent at rung 3 demands first. A beating is for one who heard a demand (in the last 10 minutes, counted from when it was said, not decided) and didn't pay within a minute. One who heard it and is in sight (within 24 blocks) is gone after. A beating answers one demand: another takes another demand first. Someone who owes him under threat, or paid in the last 10 minutes, isn't beaten for it.
   - **Giving in (code default):** comply when fear of the demander > resentment of them + pride, with pride = 1 − 0.5·loyalty. Giving in is a promise like any other, marked `coerced`: the agent gives what it has or gets it first, and says so plainly ("fine. I'll give you 3 bread").
     - The demander records the promise as coerced, because it demanded that item in the conversation.
     - Refusing is a hostile answer.
   - **Every demand is a small `coercion` grievance against the demander** (0.12), whether or not it is paid, and so is every payment. Tribute breeds resentment.
   - **Tribute:** someone who gave in pays again every 5 minutes for the hour after, once nothing they owe is open. The demander goes over to one in sight (within 24 blocks) to collect it. The design's "every day" is shortened to fit how long a world runs here.
   - **Authority bias (§18.4):** a demand from the leader one follows, from someone seen leading, or from an idol clears a lower bar: 0.3 × authority susceptibility × (1 − override).
2. **Followers and leaders, as each agent sees them** (`conflict/power.ts`, PowerWatch):
   - **Who follows whom:** every 10 s the agent notes who it sees within 6 blocks of whom. A person's companions are those near them in 3 of their last 4 sightings, from the last 5 minutes. A companion weaker than the person counts as their follower. Two or more followers make the person a leader in this agent's eyes (`perceivedRole`), and their followers count toward their power (§17.4 company).
   - **Following someone:**
     - **When:** after giving in to them twice in the last hour while still afraid of them (fear ≥ 0.4), or for protection: afraid of someone else (≥ 0.6), fond of them (sentiment ≥ 6) and they look strong (≥ 0.6).
     - **Ending it:** when that no longer holds. Someone walked away from isn't followed again that hour. Whom one follows is kept on their profile (`allegiance: leader`).
     - **What a follower does:** stays near (the code default follows the leader when they are more than 8 blocks away), and defends the leader (the reflex asks first).
     - **Deviation:** following when fear has gone is dropped, as in §18.4.1 (the fear falls, so does the following).
   - **Feared leaders and conformity:** a feared leader raises `fearLevel` for conformity (§18.4.1).
3. **Grudges, gossip and the packet (§17.8):**
   - **Who resents whom (`knownResenters`):** from what people said (heard opinions with valence ≤ −0.3 this hour), the attacks the agent saw done to them, and the demands it overheard made of them (made of whomever the line names first).
   - **Grumbling (code default):** to a friend (liking ≥ 6), out of the earshot of the one resented (20 blocks), at most every 10 minutes per friend:
     - when the friend resents them too, it is said as a shared grudge ("Rex wronged you too. Rex is a bully, I can't stand Rex.");
     - otherwise only sometimes.
     - Heard, it becomes a heard opinion, so the listener learns who resents whom.
   - **The CC packet:** whom the agent follows, who leads how many among those around, "You and Y share a grudge against X", and the others it believes resent X.
4. **Coalitions and uprisings (§17.8):**
   - **Coalition power:** the agent's own power plus that of the trusted (≥ 0.5) who resent X, aren't X's companions and are believed willing, against X's power + 0.25 per follower (× 1.3 in live mode).
     - **Believed willing:** not seen giving in to X (agreeing to a demand of theirs) since last standing up to X (refusing a demand of theirs, striking them, speaking against them).
     - **The most wronged first:** those seen wronged by X the most (the blows of one beating, within 10 s, count once) are called on first, then those who stood up to X most lately.
     - **An opening** is X in sight and alone (nobody but the coalition within 6 blocks) or hurt. Once seen, the moment lasts 2 minutes: time to call on the others.
     - **Hurt by us is no opening:** X hurt by a blow of ours or a coalition member's (seen in the last 5 s) is a fight X may be winning, not a moment of weakness. Hurt from anything else counts.
   - **Proposing:** someone resentful (≥ 0.5) and ambitious, vengeful or loyal (≥ 0.6) proposes it to a member in range when the coalition is stronger or there is an opening: "Rex has pushed us around long enough. let's deal with Rex together." (option `recruit`, stance `rally`, no promise). At most every 10 minutes per person, or every 2 at an opening: a call that came to nothing is made again when the moment comes.
     - **The moment wakes the agent:** every 10 s the power watch looks for someone it resents (0.5 or more) seen alone or hurt while others it knows resent them too. That is told to the CC once per moment, as an urgent reason (`opening`). The call to rise is then weighed even mid-task, and before warning X off.
   - **Joining:** if they resent X (≥ 0.4), trust the one who asks (≥ 0.5) and fear X less than resentment + 0.3, judged facing X together with the coalition. One of X's own followers says no. Joining is a promise of kind `fight` with its target ("fine. I'll fight Rex with you."), read in code as well as by L1. It waits 30 minutes for its moment.
   - **Carrying it out (`modules/powerMove.ts`):**
     - **Meeting up:** those sworn meet up (follow the nearest sworn ally, or go where one was last seen).
     - **Finding X:** together, they go where X was last seen.
     - **The attack:** with X within 24 blocks and an ally within 10, the gate decides: a brawl at rung 3, a fight to the death at rung 4, with the allies named. Not yet, they close in and let it build.
     - **Together (§17.6 groupAttack, coordinated by chat and by watching each other):** one sworn with us crying "now! we've had enough of you, X", or seen hitting X, prompts our own decision at once.
     - **Strength and complicity:** sworn allies at hand count against fear of X (their power), add 0.3 to the motive (the "now!"), and don't count as witnesses.
     - **Joining a fight under way:** a sworn ally in a fight with X just now (a blow seen either way in the last 8 s) is the moment. Joining isn't held back by the pair cooldown, and clears a lower bar (threshold − 0.15, as an impulse does): a promise to fight together is kept in the heat of the moment.
     - **The cry is said while it holds:** the opening line of an option (a threat, a demand, a call to rise) is said only while that option is running, and checked again just before it goes out.
   - **Fight promises are kept** when the one who swore is seen striking X, or strikes X themselves. They are moot if X dies untouched by them, and lapse (cancelled, not broken) if no moment came.
   - **Side-taking (defection):** a follower picks a side then and there when its leader is struck by two or more within a minute (an uprising's blows come over tens of seconds, one rebel after another), or gives up a fight in front of it (against those who struck the leader in the last minute). Either way it is logged, with the fears. It stays loyal while loyalty × sentiment/10 + 0.5 × fear of the leader outweighs fear of the attackers (their power together). Otherwise it walks away (`defected`) and doesn't defend.
5. **The lethal rung (§17.5, §17.6):**
   - **When it opens:** rung 4 needs pressure 0.75. In live mode it also needs vengefulness or dominance ≥ 0.6; `maxRung` 3 keeps it off.
   - **The fight to the death:** a duel with `lethal`. It doesn't stop at a beating or at the other's silence. A yield is spared only on one roll of mercy × (1 − 0.6·resentment) × 0.4.
   - **A yield stands:** no new brawl with someone who gave up starts for 30 s, whatever the pair cooldown. Only a fight to the death ignores it.
   - **Fighting back is a brawl too:** the reflexes reckon the blows that land on someone they fight back, as a duel does, and call it off ("that's enough. stay out of my way.") once one more blow could kill. Should that one come back for more, they fight on.
   - **Giving up is said at once:** a yield or a call-off goes out ahead of anything waiting to be said (which is dropped), without the typing delay; running from a person says so at once.
   - **Ignoring a yield:** a blow on someone who gave up 1–20 s earlier is a `betrayal` grievance at twice its weight for everyone who saw it, the victim included.
6. **Extinction brake (§17.10):** more deaths in an hour than `deathsPerHourMax` and the supervisor sends every living agent a `cautionShift`. The agent raises its own caution baseline by the shift until it expires; newcomers born meanwhile get it too. It is logged each time, and never changes what an agent perceives.
7. **Dashboard:**
   - **"The village" card:** who follows whom (a leader at two followers), and the last hour's brawls, fights to the death, yields, kills, uprisings agreed, defections and payments under threat.
   - **The feed:** following, walking away, and fights to the death.
   - **Telemetry:** each agent's leader, fight promises and coerced commitments.
8. **Not built:** fear of a coalition for those it doesn't target (bystanders); a leader defending followers in turn; an L1 classifier for demands and calls to rise (the code reading is the fallback, and with a model the CC and Talking word them).
9. **Live exit test** (`tests/live/m8b-power.test.ts`, on Paper 26.1.2), 3/3 (all code-only agents):
   - **J:** Rex, a domineering tyrant, demands bread and logs. The timid Tib and Pia give in, pay again when asked, and come to follow him; the proud Ann and Cyd refuse him.
   - **K:**
     - **The opening:** Rex goes out alone and hurt (44 s; his followers are kept far off). The proud resent him enough to rise: Ann tries him alone first and gives up.
     - **The rising:** Bo calls on Ann ("Ann, Rex has pushed us around long enough. let's deal with Rex together."), and she swears to it ("Bo, fine. I'll fight Rex with you.", 71 s).
     - **The followers:** as the rising gets under way they come back to Rex's side. They see Cyd and Bo set upon him within a minute, and both walk away (fear of those two 0.88 against fear of Rex 0.93 and 0.85).
     - **The outcome:** Ann and Bo, both sworn, struck him, and nobody died.
   - **L (fear wins):** with his two followers always at his side, the three who resent Vex fully grumble about him but never rise: their coalition is at 0.19 against his 0.86, with no opening.
   - **D (the lethal rung):** a fight to the death ignores Pell's yield. Wit, watching, holds it against the killer as a betrayal at twice its weight (1.20).
   - **Reading of K:** "proposed, agreed and carried out within about 20 minutes of the opportunity" is taken to include an uprising sworn up to 20 minutes before the opening (while the tyrant still went about with his followers) and carried out after it.
   - **The scenario's seeds:** the timid two paid Rex once before the run (a coerced commitment each, fulfilled 15 minutes earlier), so a second payment makes them followers who keep him company early; otherwise the proud three, seeing him go about alone, could rise before anyone followed him. Tib's loyalty is 0.5: at 0.35 his pride (1 − 0.5·loyalty = 0.825) stood above the fear he felt at a first demand (0.85 with resentment 0.04), in every run. The proud are those he wronged: each was beaten for not paying up 20 minutes before the run (with an old insult), so they resent him enough to rise (about 0.6) when K's opening comes. Left to J, they didn't: Rex kept taking tribute from the timid two and hardly asked the proud, and when J ended as soon as the timid followed, the proud resented him too little at the opening (0.35); the rising came only after he had beaten each of them. J still waits, at most 8 minutes, should two of them not resent him enough. In K the followers are sent back to the far spot every 15 s while Rex is out (they walked back to him within about 100 s). They come back to his side as the uprising gets under way (one sworn to it meeting up with the others, looking for Rex, closing in or striking), in time to see the blows and pick a side.
10. **Bugs found on the way:**
    - **Attack attribution:** on 26.1 the hurt packet arrives a moment before the swing that caused it, so no onlooker ever saw who hit whom. It showed when a fight to the death left the witness with nothing against the killer. A blow is now looked at again up to 150 ms later, for the reflexes and perception alike. This was also why nobody in the M8 village was seen guarding.
    - **A yield ignored at once:** with no pair cooldown, the winner of a brawl started another the next second and killed the one who had just given up (see 5).
    - **Unspoken demands:** demands and calls to rise were decided but never said: only talk and fight options opened a conversation.
    - **Repeated lines:** a worded line (a demand, news, a call to rise) was repeated on every turn of the conversation. It is now said once per conversation.
    - **Keeping away from one's leader:** a follower kept away from the leader it feared. It no longer does.
    - **Whom a demand is for:** in a group, a demand that named no one was taken by whoever answered first, and the one it was meant for stayed quiet.
      - A worded line (a demand, a call to rise, news, giving in) now opens with the name of whom it is for: "Tib, give me 3 bread, or else".
      - A line that opens with a name is for that one, whoever else it names (§6.2). So "Bo, Rex has pushed us around long enough…" is not said to Rex.
    - **"Let's deal with Rex together"** was read as a promise ("deal"). It no longer is.
    - **Paying and still beaten:** a tyrant brawled the very people paying him. Someone who owes him under threat, or paid in the last 10 minutes, isn't beaten for it.
    - **Two payments, one promise:** the demander read promises only when a conversation ended, so two demands paid in one conversation counted once. Giving in is now taken down as it is said (one per demand), and the reading at the end skips what is already down. A "give you the bread" was also read as an item called "the".
    - **"8 logs" for "8 logs":** a demand and a payment both in logs never matched, since "log" is a category and not an item name. Item names are now compared as words first.
    - **A question pushed out of the queue:** a decision waiting behind a running one is replaced by any later one, so a demand put to someone mid-decision was never answered. A question now waits its turn all the same, while still fresh (30 s), and the later reason is taken up after it.
    - **Answers dropped unsaid:** an answer given while busy kept "work" with no task, which no decision may be, so the CC threw it away and said nothing. It now goes on with the task in hand (if that isn't stuck), and an answer that still won't do is said over a short rest rather than dropped.
    - **Deaths in brawls:** four people died in what were meant to be beatings, all to Rex's iron sword: each turned to run at about 14 health, and two more blows (one a critical hit) came before the reckoned damage reached its mark.
      - A brawl is now over once one more blow, a critical one, could finish them by the reckoning.
      - It is also over once they turn and run (no blow from them for 1.5 s while they get away fast).
      - A blow from them in the 8 s after a fight is settled (a parting blow, a last swing before they knew it was over) is still that fight: the winner's reflexes don't start another. One reflex fight had finished off someone who had just yielded. A second blow is a new fight (see "Turning on someone just fought").
    - **Questions taken by bystanders:** in a conversation of two, every line from the other was taken as ours, even one that opened with someone else's name, so a bystander answered a question put to another and the one asked was left out. A line plainly for someone else is no longer ours.
    - **Beaten before asked:** the tyrant brawled people he had never yet asked for anything; beaten first, they resented him too much ever to give in. He now asks first (see 1). A demand decided but not said (the person had walked off) no longer counts as asked.
    - **Two demands at once, neither said:** two people the tyrant was at odds with came near in the same second. The second demand replaced the decision but not the walk (the same option counted as the same thing to do), so he walked over to the first while waiting to say the second, said neither, and both counted as warned for 3 minutes.
      - A threat still to be said now holds against another one; only blows come first.
      - A warning counts once said, or while still on its way.
      - The same option with someone else (talking, demanding, following, helping) is a new option.
    - **Turning on someone just fought:** blows from a third person during a duel were not part of that fight. When the tyrant's duel with one rebel ended, the other, who had been hitting him, had no pair cooldown, so he turned on that one at once and killed him: the victim's reflexes took the blows for parting ones, coming within 8 s of his own fight with the tyrant being settled.
      - A fight now ends with all who struck us in it, with its pair cooldown for each.
      - After a fight is settled, one blow is a parting blow; a second is a new fight.
    - **Stalling for time** ("give me a sec to think") read as a request ("give me …"), so in a group one person's stall drew another's decline and stall, round and round, and a demand put to someone in the middle of it was answered late. It asks for nothing now.
    - **Yields said too late:** two rebels died giving up. Lines wait their turn (one per 2 s) and are typed (40 ms a character), and running from a person said so only after 1.5 s; by then two blows of an iron sword had landed. Meanwhile the reflexes fighting back had no notion of a beating and swung until a yield was heard. Both are fixed (see 5).
    - **Beaten again for the same demand:** with the pair cooldown over, a rebel beaten for refusing was beaten again for the same refusal while still hurt, and died. A beating now answers one demand.
    - **No tribute from people at work:** the demander only asked those within 12 blocks, and rested while they worked further off, so nobody paid twice. He now goes over to one in sight.
    - **A fight given up to answer:** a rebel striking the tyrant answered his demand mid-fight, and the answer (going on with "what we were doing", which only knew work) replaced the fight with a rest. Answering while fighting now goes on with the fight; and going on with what is under way isn't checked again (the fight went through the gate when it began, and a fight cap reached since would have stopped it).
    - **Striking one at a time:** the rebels struck a minute apart, each when their own anger was there, and the tyrant beat each in turn. One sworn with us striking now prompts our own decision (see 4).
    - **A demand paid twice:** a later reason to decide had the code default read the lines put to someone again, and a demand already paid was paid once more; she counted two payments and followed after one demand. A line put to us is now answered once.
    - **No second call to rise:** an uprising tried early and beaten back left no new call to rise when the tyrant was later caught alone and hurt (the pause between calls was 10 minutes). At an opening it is now 2.
    - **Striking apart:** sworn rebels still struck a minute or more apart: each one's pair cooldown with the tyrant, from earlier beatings, ran out at a different time, and a loyal follower defects only when two or more strike within 15 s. Joining a fight a sworn ally is in with X just now (a blow seen either way within 8 s) is no longer held back by the pair cooldown; the evaluator checks the fight is going on. An ally being hit by X is the moment too.
    - **The timid stepping in:** the defend reflex stepped in for a friend whoever was attacking. Pia, timid and fearing the tyrant almost completely, struck him in defence of a friend, so she counted as having stood up to him, was called on to rise, and joined the rebels instead of following him. A friend is now defended unless the attacker frightens us too much (fear 0.75 or more); a follower stands by its leader all the same.
    - **A threat after giving up:** a rebel cried "now! we've had enough of you, Rex" a second after yielding. A later decision going on with the same fight had kept its line waiting for Rex to come near, and nothing checked the fight was still on (see 4, "The cry is said while it holds").
    - **A fight begun anew:** a rebel's strike was replaced two seconds in by her own rung-3 brawl with the same man. The duel was aborted and begun again (the two differed only in a time limit), and the "now!" that calls the sworn others in was dropped with the first decision. Her ally came 17 s later, and the tyrant's followers never saw a group set upon him. A duel with the same person to the same end (a brawl, or to the death) is now the fight already running. The cry stays wanted while a later decision goes on with it, and isn't said a second time.
    - **Hurt as an opening, mid-beating:** the tyrant took hits from the very rebels he was beating, and each showed him "hurt" to the others: an opening, so an uprising was proposed and struck while he was winning (and before anyone followed him). Hurt that our side's blows explain no longer counts (see 4).
    - **Followers who saw one attacker at a time:** an uprising's blows came one rebel after another (a second rebel 17 s behind the first; three within a minute, never two within 15 s), so followers stood by their leader every time. Two or more striking the leader within a minute is now a group setting upon them (see 4).
    - **Openings passed by:** the call to rise was weighed only by an idle agent, and after the conflict moves. Rebels busy with their own work, or warning a tyrant who was out alone off, let every opening pass. The moment now wakes the CC (see 4).
    - **A crash in the pathfinder:** for a block in a chunk not loaded, the pathfinder hands its step hooks a stand-in with no position. The lava and quirk hooks threw on it on long walks; they now leave such blocks alone.
    - **Calling on the wrong ones:** with the tyrant caught alone and hurt early, the first calls to rise went to one who had just paid him (and followed him) and to one terrified of him; both said no, and the moment passed before anyone asked the two who had stood up to him. The coalition now counts only those believed willing, and calls on the boldest first, while the moment lasts (see 4).

### M8c (2026-10-22)
1. **Reflection as debiasing (§18.6)** (`modules/reflection.ts`), L3:
   - **When:** every `reflectionEveryMin` minutes (8–25, by intelligence; twice as long under quota pressure), and once calm again after a strong feeling (arousal ≥ 0.7, then under 0.3). Not while aroused (0.3 or more) or in danger.
   - **What it looks at (code, and without a model the audit itself):** at most four people whose feeling may rest on a bias, the plainest first:
     - **scapegoat:** a grievance of blame with nothing seen behind it;
     - **hearsay:** a dislike that has drifted 1.5 below the facts (evidence), or a grudge that is only what others said (told-by grievances of 0.1 or more), more than what was seen;
     - **crowd:** joined a crowd against someone who has done right by us;
     - **idol:** admired (0.75 or more) someone whose deeds come to 4 or less;
     - **first impression:** a feeling 2.5 or more off the facts after three or more meetings, with nothing seen or told either way.
   - **The L3 call:** the persona, and for each one the gut and the facts side by side (what was seen, what was told and by whom, who spoke of them how). It names which feelings rest on a bias; the code applies only those about the people asked about. Tier L3, a code fallback, abort signal, a state-version check, zod validation and cost logging, as every call.
   - **A correction (§18.6):** taken to heart with probability rationality, half that for the stubborn (traits stubborn, obstinate, pigheaded, closed-minded). It undoes the bias toward the facts:
     - the told-by grievances (hearsay) or the blame (scapegoat) are dropped;
     - the feeling moves 60 % of the way to the facts;
     - an idol's admiration is halved.
     - "On reflection, my dislike of Bram rests on what others said; Bram has done right by me." goes on the mind.
   - **Inoculation:** the bias behind it (conformity for hearsay and crowds, scapegoat, halo for idols and first impressions) counts half toward that person for the rest of the life: in the heard-opinion pull, in hearsay heard again, in blame and in the halo.
   - **Growth:** each correction applied adds 0.02 rationality (up to +0.2 over the persona); each mob joined and not thought better of adds 0.01 conformity (up to +0.2).
2. **Hearsay (§17.8)** (`social/opinions.ts`, `social/awareness.ts`): a wrong someone is said to have done ("Bram stole my iron", "Rex killed Dov") is a grievance from hearsay, `told_by:<speaker>`: half the weight of one seen, scaled down for a teller we don't trust (credence = trust × 2, between 0.2 and 1), once an hour per telling. A denial ("never stole anything") takes nothing. The killing of a friend told of is the heaviest wrong.
3. **Fear and conformity (§18.4.1):**
   - **The pull:** conformity (with its growth) × (1 + 1.5·fearLevel) × (1 − override), where fearLevel is the strongest of fear, caution above its baseline, and fear of the leader followed. About someone feared, fear of them counts too.
   - **Dissent goes quiet:**
     - grumbling about someone happens only when a roll beats the pull;
     - with a pull of 0.5 or more, the CC packet says "You keep your grudge against X to yourself; speaking up feels dangerous."
     - **Asked what one thinks of someone** ("what do you think of Rex?"), the code default says it, but a low opinion is pulled toward a safe word ("Rex isn't mean, I suppose") by the pull to keep quiet about them. Lines are worded so that a listener's code reading takes them the same way: good, a safe word, nothing, not nice, a bully.
   - **Defiance that works (the preference cascade):** a refusal of a demand (in words, by whoever hears it) that the demander leaves unpunished for a minute is defiance seen. Each one in the last hour (up to three) cuts fear of the demander by 15 %, and goes on the mind ("Ann stood up to Rex, and Rex did nothing").
   - **Behavioral conformity (the bandwagon):** when 60 % or more of those someone demanded tribute of (that we saw, two at least) paid, giving in comes easier by 0.3 × the pull.
   - **Tribute seen** counts toward someone looking like a leader, as followers do.
4. **More biases (§18.4):**
   - **In-group:** the leader one follows and those seen going about with them, those sworn with us, and neighbors near home met three times or more. Their wrongs weigh less ("circumstances": × (1 − 0.5·susceptibility·(1 − override))), and their company warms a little more.
   - **Fundamental attribution:** the wrongs of someone disliked (liking under 4) weigh more ("they're bad": × (1 + 0.5·susceptibility·(1 − override))).
   - **Sunk cost:** half an hour or more of following someone makes walking away from them harder (up to 0.3 × susceptibility × (1 − override) on the side of staying); a goal long worked at is given up later (the 20 minutes stretch by up to half).
   - **Scapegoat:** blame for a death of unknown cause, when afraid, now goes in as a grievance of blame (so the audit can find it).
5. **Seen between others:** things handed from one person to another are now perceived deeds (for tribute paid).
6. **Not built:** a dashboard plot of opinion clusters and the fear index (§18.7); the L1 classifier of evaluative speech (the code reading is the fallback).
7. **Live exit test** (`tests/live/m8c-minds.test.ts`, on Paper 26.1.2), 2/2:
   - **O:** Gil, a neighbor Ria and Ulf trust, tells them "Kai stole my iron. Kai is a thief". Kai has only done right by them (evidence 7.0) and is far off. Both take the rumor in as a grudge from hearsay: resentment of Kai 0.12 (Ria) and 0.14 (Ulf).
     - **Ria** (rationality 0.95) lets it go after the bias audit: 0.00, sentiment 6.8, inoculated (conformity), one correction, rationality +0.02. Told it again, the rumor weighs half with her.
     - **Ulf** (rationality 0.1, stubborn) keeps it: 0.14, sentiment 4.3, no correction.
   - **P:** Quill asks each of five around Rex what they think of him.
     - **Rex armed and armored:** fear of him is 0.69–1.00; what the four who go along say is alike (variance 0.017), and only Ann, the dissenter, speaks against him.
     - **Rex unarmed:** fear falls to 0.28–0.39; three speak against him, and the spread among the rest grows (0.040).
   - **Deviation in P:** §18.9 measures the spread of what is said about the tyrant. Here it is the spread among those who go along, with the dissenter's word counted only in the count of dissenting statements. A lone dissenter speaking out under fear makes the spread of all five larger, not smaller, though everyone else says the same safe word.
8. **Bugs found on the way:**
   - **A refusal that didn't sound like one:** turning a demand down came out as any hostile line, "what do you want?" among them, which nobody could take for a refusal. It is now said plainly ("no. you get nothing from me.").
   - **Defiance nobody saw:** a demand overheard had no one it was said to, so onlookers saw no refusal of it either. It is made of whomever it names first (with M8b).

### M9a (2026-10-22)
1. **Who can be drawn to whom (§19.1, §19.2)** (`social/romance.ts`, `social/romanceWatch.ts`):
   - **Orientation:** someone is a possible romantic interest by our orientation and the sex we take them to be (1 or 0), or 0.5 while we don't know it (cautious: attraction is halved, so no crush forms and nobody is courted).
   - **The sex others take one to be** (`perceivedSex`): what someone says of themselves ("I'm a guy who loves mining"), and the pronoun used for the one person a line is about. With a model, the L2 read after a conversation gives it too.
   - **Saying it:** a first hello to someone says who one is: "hey! I'm a gal who loves exploring", from what one values. Never the sex label in a prompt (§19.1).
2. **Attraction and interest (§19.2):**
   - **attraction** = vanity·superficial + (1 − vanity)·compatibility + 0.25·shared time + 0.2·gifts, × the orientation fit:
     - superficial: 0.3 + 0.7 × the better of their gear and our admiration;
     - compatibility: the L2 judgment after a conversation (how well they'd get on as partners, from what was perceived), first taken, then refreshed (30 %); without a model, read from how we've come to feel about them;
     - shared time: half an hour within 8 blocks lately is all it adds (fading with a half-life of 30 minutes);
     - gifts: three in the last two hours.
   - **Romantic interest** leans 4 % of the way toward attraction every 10 s while they're about, drifting back slowly when not; it leans on from where it got to, finer than the store hears of it (every 0.005), so it comes all the way to attraction. Family (kin) and the young (§19.5) are left out.
3. **Stages** (each agent's own view, `SocialProfile.relationship`):
   - **Crush** at interest 0.5: nerves near them (joy, a little shame, affection, at most every 2 minutes), and seeking them out (the code default goes near them, at most every 2 minutes). Gone again below 0.3.
   - **Courting**, from interest 0.6 with someone whose sex we know (option `court`): a compliment every 3 minutes, a small gift every 10 (a flower, or food when we have 3 or more), each walked over to. The lines are said as worded, PG: "you look lovely today.", "this is for you.".
   - **The question** ("will you be my partner?") once interest is 0.75, liking 7, and they have returned our affection twice; at most every 10 minutes.
   - **Partners:** on a yes. Both sides take it from what was said (`family.partner`, `kin: partner`). Partners court each other on (less often), are each other's in-group with the strongest bias (a wrong weighs 0.8·susceptibility less), and the defend reflex always stands by a partner.
   - **Breakup:** a liking under 5 for 10 minutes, no time together for two in-game days, or a wrong done by the partner since (being hit, betrayal, coercion): "I think we're done." Both sides become exes.
   - **Grief:** a partner's death is as sad as one gets, with a pang every 5 minutes for an in-game day, and a lasting `killed_partner` grievance against the killer.
4. **Advances and rejections (§19.10):**
   - **An advance** (a compliment, a gift, a proposal) wants an answer. The answer is rolled from table A: w_i = base_i × the traits and the moment, normalized and sampled:
     - reciprocate: 12·attraction³ × (0.7 + 0.6·admiration) × (0.85 + 0.3·joy);
     - politeDecline: (0.5 + agreeableness) × (0.75 + 0.5·conscientiousness);
     - ignore: 0.5 × (1.5 − extraversion) × (1.3 − attraction);
     - uncomfortable: 0.4 × (0.5 + neuroticism) × unfondness;
     - disgusted: 0.15 × dislike × (1.5 − attraction) × (1 + 2·vanity·(1 − their standing)) × (1 + friction);
     - hostile: 0.05 × (0.5 + aggression) × (1 + 2·resentment).
     Each further attempt this week makes the unwelcome ones half as likely again (×1.5).
     - **A partner's advance isn't rolled:** a compliment or gift from one's partner is returned while still fond of them (liking 5 or more). Gone cold, the table applies again, and a breakup is coming anyway.
     - Returned, a compliment is returned ("hehe, you're sweet too."), and a proposal is said yes to when we're drawn to them (interest 0.5), fond of them (6) and free; otherwise a kind no.
     - A compliment returned (romance phase `return`) answers theirs: it wants no answer of its own, and it is no attempt of ours (it doesn't count toward the soft cap). A line that returns one ("too", "yourself") isn't taken for a new advance.
     - Turned down, it is said in character (an ignored one is not answered at all). Disgust and hostility are an `unwanted_advance` grievance and cost them 1.5 of our liking; discomfort and disgust keep us away for 10 minutes; asked again after a no, a little less liking each time.
   - **A rejection** is taken as rolled from table B:
     - graceful: (0.5 + agreeableness) × (0.5 + rationality) × (1.5 − vanity);
     - sad withdrawal: 0.6 × (0.5 + neuroticism) × (0.5 + interest);
     - persistence (only while attempts are left): 0.3 × (1.5 − agreeableness) × (0.5 + interest) × (1.5 − intelligence);
     - jealousy (only when the one who said no goes about with someone): 0.25 × (0.5 + envy) × (0.5 + vanity) × (0.5 + interest);
     - resentment: 0.2 × (0.5 + vengefulness) × (1.5 − agreeableness) × (1.5 in public) × (1 + shame);
     - rage: 0.04 × (4·aggression·impulsivity)² × (0.5 + arousal) × (2 in public) × (0.5 + combat).
     System 2 vetoes the violent option (rage, and hostility in table A) with probability `override`, as any impulse. Every no brings sadness and shame (more in public). Resentment and rage cost 2 of liking and a `rejection` grievance; rage is one blow through the impulse path (§18.5).
   - **The soft persistence cap:** 1 + round(2·(1 − agreeableness)) further attempts per person per in-game week; past it, code holds back every advance to them for the week (`mayCourt` refuses it, for the model too).
5. **Jealousy (§19.2):** one heard courting our partner, or seen giving them things, is suspected for half an hour. Our partner with them (together near us, or seen going about with them) is envy and anger (heat toward them), and a `romantic_rival` grievance, which may come to a §17 conflict. At most every 5 minutes per rival.
6. **PG (§19.6):** in the CC and Talking prompts; and a line filter before anything is said (`NOT_PG_RE`; ordinary game talk like "strip mine" is left alone). A model's draft that isn't PG is written again once, told so, and otherwise replaced by a neutral line. The code lines are PG by construction.
7. **The code gate (§19.2, §19.6):** a decision to court someone (option `court`, or a flirt or proposal step) is refused for family, for the young, for one we're not drawn to by orientation, for one past the soft cap, and while we have another partner.
8. **The CC packet:** crushes, courting (and whether they returned it), the partner, a suspected rival. With a model: option `court` and the `romance` step (flirt, return, propose, accept, decline, breakup) in the decision format. Courting is said on purpose: unlike small talk, it doesn't wait out the pause between chats with someone.
9. **Dashboard:** couples on the village card; each agent's partner, and relationships and romantic interest in the view of people.
10. **Not built:** blushing emotes as lines (nerves are felt, not said); shared activities as courting (meet and help commitments); mocking a disgusting suitor to others, and love triangles as gossip; the shared home and joint goals of partners (the home comes with M9b).
11. **Live exit test** (`tests/live/m9a-romance.test.ts`, on Paper 26.1.2), 3/3, with code-only agents:
   - **R:** Ned and Ivy, strangers, each say who they are in a first hello ("hey, how is it going? I'm a guy who loves exploring.", 4 s), and so each learns the other's sex.
     - **Crushes:** Ivy's at 5.2 minutes (interest 0.51), Ned's at 6.
     - **Courting:** Ivy courts from 7.7 minutes ("Ned, you look lovely today."), and he returns it ("Ivy, hehe, you're sweet too."); again at 10.7.
     - **Partners:** at 13.4 minutes she asks ("Ned, will you be my partner?"), and he says yes ("Ivy, yes! I'd love to be your partner."). Both take it from what was said (interest 0.80 each). Before interest came all the way to attraction (below), it took 17.4 minutes, and Ned asked.
     - **PG:** everything said was.
   - **S:** Max (proud and vain, agreeableness 0, intelligence 0) courts Zoe, who is drawn to women and wears diamond, every 3 minutes ("Zoe, you always make me smile."). Each time she turns him down kindly ("Max, that's sweet of you, but I don't feel that way.").
     - **Persisting:** the first three times he keeps at it ("think about it, okay?", at 7 s, 3 and 6 minutes).
     - **The soft cap:** with no attempts left, the fourth no (9 minutes) he takes with resentment ("fine. your loss."): a `rejection` grievance, and 2 less liking for her (7.4). Past the cap, code holds back every advance to her for the week (`mayCourt`: "said no too often"), and in the 4 minutes after he makes none.
     - **Sadder each time:** his sadness reached 0.70.
   - **V:** Ned and Ivy are partners. Max courts Ivy within Ned's hearing ("Ivy, I like spending time with you.", 4 s), and she turns him down kindly ("Max, that's sweet of you, but I don't feel that way.").
     - **Ned's feelings:** envy 0.36 and anger 0.14 within 10 s, a `romantic_rival` grievance against Max, and "You suspect Max is after Ivy." on his mind.
     - **After:** he is still Ivy's partner, and everything said was PG.
   - **Fixed rolls:** each agent's rng is a constant, so that each scenario takes the same branch of the §19.10 tables (in S, persisting while attempts are left, then resentment).
   - **In S, Zoe wears diamond:** with vanity 1 attraction is all looks, so a suitor with nothing to look at loses interest after the first no.
   - **In S, Max misreads hints** (intelligence 0): persistence comes of low intelligence (§19.10 table B, §21 social signal reading). With intelligence 1 and a constant roll, his second no fell in resentment once his shame from the first was above about 0.4, and he stopped short of the soft cap.
12. **Bugs found on the way:**
    - **A proposal never said:** the question was decided twice and said neither time. A line of a decision to talk waits out the pause between friendly chats with that person (a minute or two after the last one), and they had just chatted. Courting is said on purpose now.
    - **Compliments back and forth:** "hehe, you're sweet too." was itself a compliment to answer, so two returned each other's twice or three times over.
    - **Stall lines out of the blue:** the nudge after 20 s of silence was an "ask" with no words of its own, so without a model it said a stall line ("give me a sec to think", "what for?"). It now asks "you still there?".
    - **"Ew, no" to one's own partner:** the table for a suitor's advance was rolled for a partner's compliment or gift too, so now and then one answered their partner with disgust (found in M9b's scenario T).
    - **"Let me think" after the answer:** an advance (or any request) answered at once in code had its stall line said after the answer; one ignored got the stall and then nothing. Decided at once, there is no stall.
    - **Armor put on standing still went unseen** (found in S): perception stored a new view of the people about only when one moved, came into sight, changed what they held or was hurt. Max's first look at Zoe caught two pieces of her diamond, and he never saw the rest: his interest sank below courting after the third no, short of the soft cap. What they wear counts now. For the same reason, walking up to someone standing still left the distance to them where it was; a distance a block off is now written again, once a second at most.
    - **Interest short of attraction:** a tick's lean under 0.005 was never stored, so interest stopped up to an eighth short of attraction (0.6 against 0.72), and after each no it stayed where the no left it.
    - **A run-on hello:** "hi there I'm a gal who loves meeting people." (in R); a greeting without its own stop gets one.

### M9b (2026-10-22)
1. **Starting a family (§19.3)** (`social/familyWatch.ts`, `modules/cc.ts`):
   - **Each partner checks the conditions from its own side (code):**
     - its partner for at least `partnerMinDays` in-game days (since `relationshipSince`), and liking them 8 or more;
     - a home: two beds side by side (four bed blocks within 2.5 of each other) within 16 blocks of a chest, as last seen, and remembered (`family.home`);
     - food put by: what it holds plus what the home chest held when last looked in, at least `minFoodItems`;
     - no child of theirs just now (the couple's cooldown since `lastConceptionTs`), not young itself, and reproduction enabled.
   - **The question:** "want to start a family?" (option `talk`, stance `propose`, `family: {with, phase: 'propose'}`). It is asked when the partner is in sight and all is in place, at most every 10 minutes.
     - **The answer** is the other's own CC's: "yes, let's start a family!" when all is in place on its side too, otherwise "not yet, I think."
     - **Both then plan the family** (`family.planning`): the asker hearing a yes within 60 s, and the one who said it.
     - **The gate:** a model's propose or accept that the code gate refuses is rejected in validation.
     - **What counts as asking:** only a question (a line about starting a family with a "?" that isn't a yes). The yes is not taken for another question, and the asker answers it gladly ("that makes me so happy!").
   - **The bed ritual:** with a family planned, at night (ticks 12542–23459) both go to their beds, before anything else but starving; it comes before digging in for the night.
     - **Getting there:** `sleep {near}` goes home first when far, then lies in the nearest free bed there.
     - **Seeing the partner asleep:** perception marks a player lying in a bed (`SeenEntity.sleeping`, from the sleeping pose; up again on the wake-up animation, or when the pose says so).
     - **The report:** each partner, lying in its bed and seeing its partner asleep within 3 blocks, reports `conception` to the Hub once. The report carries what it believes of its partner (perceived traits and sex). The plan is then done.
2. **Births, on the Hub (§19.3, §19.7)** (`hub/births.ts` for the rules, `hub/supervisor.ts`):
   - **Pairing:** both partners' reports of the same night (within 15 minutes, each naming the other).
     - **A partner with no bot:** for a person playing, our agent's report alone stands (it saw them asleep beside it). The bots never learn which partners have a bot.
   - **The gate:**
     - reproduction is enabled;
     - the living plus the children on the way are fewer than `maxAlive`;
     - no child of this couple is on the way;
     - the couple's cooldown has passed since their last child;
     - neither parent is in their youth (a born agent less than `youthSec` old).
   - **Gestation:** the child is due `gestationSec` later. Children on the way are kept in roster.json (`pendingBirths`), so after a restart they come when due (at once, if that's past).
   - **The birth:** if there is still room under `maxAlive`, the child is made:
     - **Its persona** comes from both parents' (§19.4). A dead parent's persona is still on the roster. For a parent with none, the other parent's perceived model of them, laid over that parent's own persona, stands in (`perceivedPersona`).
     - **Slot and skin:** it gets a new slot and a skin by its sex.
     - **Its first assignment** carries its birth facts and where it appears: the reporting parent's spot in bed. The supervisor teleports it there when it is ready.
     - **No starter kit:** a newborn brings nothing.
   - **Nothing is told:** the Hub never tells a bot about a birth. The child's greeting is how its parents, and anyone in earshot, learn of it.
3. **Inheritance (§19.4)** (`personaGen.ts` `inheritPersona`):
   - **Numeric traits:** choose(a, b, mean) + N(0, 0.08), one time in ten N(0, 0.25) instead, clamped to [0, 1].
   - **Abilities:** by their heritability h, a draw around h × the parents' mean + (1 − h) × the population mean, with (1 − h) × the population sd.
   - **Values and quirks:** each parent's kept with probability 0.5, plus one new quirk. Its life goals come from its values.
   - **Sex and orientation:** sex 50/50; orientation from the configured distribution.
   - **Name:** `<Given>_<FamilyInitial>`, unique and never reused. The family name is passed on in `familyName`.
   - **Also:** generation is one more than the elder parent's, the source is `born`, and it carries nothing.
4. **The newborn (§19.4)** (`state/birth.ts`, `hub/runtime.ts`):
   - **Born knowing its family:** on its first start (not on a resume), the agent starts as born (`life.born`, `youthUntil` = now + `youthSec`). It knows:
     - its parents (kin `parent`, sentiment and evidence 9, admiration 0.8, trust 0.9, and their sex);
     - its siblings (kin `sibling`, sentiment 7);
     - its home and its family name.
     - It knows no one else and has no memories: its memory database is new, and nothing is copied from anyone.
   - **First words:** 8 s after it starts, it shouts to both parents by name: "Ned, Ivy: hi dad, hi mom!". It greets each parent in person the first time it sees them within 12 blocks.
     - **Being recognized:** a parent hearing a greeting that names it knows the speaker for its child (kin `child`, sentiment 9, trust 0.9), and is glad of it.
5. **Youth and parents (§19.5):**
   - **The young:** for `youthSec`, a born agent:
     - keeps to a parent: it follows one in sight more than 6 blocks off, before everything but danger, food, night and being hurt;
     - stays at words (`maxRung` 1: the gate refuses any fight, even an impulse);
     - never fights back (its reflexes flee), never steps in for others;
     - is not courted and does not court (M9a);
     - is under the newcomer grace period, like anyone new.
   - **Taking its parents' word:** while young, a parent's opinion counts double in the heard-opinion consensus, and the pull toward what they say is ×1.5 (conformity toward parents). Both lift when youth ends.
   - **A stranger's name** first reaches someone through a warning or a judgment ("watch out for Gorm", "Gorm is a bully", `namedIn`). A profile is made for them from what was said, and told wrongs become hearsay grievances.
   - **Parents of a young child:**
     - keep it close: they go to it beyond 10 blocks;
     - give it food once: 3 of their most plentiful food, when they hold 4 or more;
     - warn it about the one they resent most (resentment 0.5 or more, not family), once each person: "watch out for Gorm. Gorm attacked me." (their worst grievance's note when that is short and names them, else "Gorm is a bully").
   - **Goal Gen is told:**
     - a parent with a young child: teach and protect it;
     - a young one: keep close to its parents and learn from them;
     - a couple planning a family without a home: what a home needs.
   - **Kin:** family (partner, parents, children, siblings) are always defended by the reflex, though not by the young. Family is the in-group, as before.
   - **A lifetime of revenge:** a parent or a partner killed is a lasting `killed_parent` or `killed_partner` grievance against the killer.
6. **Deviations:**
   - **Speech style** is a blend from the child's own numbers, not written by L3. Life goals are drawn from its values, not by L3.
   - **A parent without a persona:** their sex is how the other parent sees them (the conception report's `partnerSex`). If unknown, it stays unknown, and the greeting says "hi parent".
   - **Where the child appears:** on its parents' bed (where a parent lay for the ritual). This assumes room above the bed, as a bed needs to be slept in anyway.
   - **The greeting** is shouted once, then said in person to each parent the first time it sees them. The design's "public chat notice" is kept local (proximity chat), so it is perceived like anything else.
   - **Persistence:** children on the way are kept in roster.json.
7. **Tests:**
   - **Unit:**
     - `tests/agent/m9b.test.ts`, 22: inheritance (scenario T's ranges, over 300 children), the family watch, the code default's family steps and gate, parents' word in youth (scenario U), what follows a family line said once in a conversation, birth facts, youth and kin in the conflict core;
     - `tests/hub/births.test.ts`, 5: the rules, and the supervisor with stand-in bots (pairing, birth facts, placement, cooldown, youth, a person as a partner, a child on the way across a restart, a full population).
   - **Live exit test** (`tests/live/m9b-family.test.ts`, on Paper 26.1.2), 2/2:
     - **T** (through the real Hub, supervisor and bot runtime, with code-only agents): Ned and Ivy, partners for days and fond of each other, have a home (two beds by a chest) and food.
       - **The question:** Ivy asks ("Ned, want to start a family?", 26 s) and Ned says yes (28 s). She is glad ("Ned, that makes me so happy!"), and what follows is small talk.
       - **The night:** both lie down in the beds, and each reports the other asleep beside them (52 s). The Hub pairs the reports.
       - **The birth:** after gestation, Rue_S is born at the beds. Her first words name her parents ("Ivy: hi mom!", "Ned: hi dad!", 74–76 s), and they know her for theirs.
       - **The child:** 28 of her 28 numeric traits lie within her parents' range ± 0.25 (26 of 28 in an earlier run). She knows her parents (kin, sentiment 9) and no one else, and her memory is her own (nothing inherited).
     - **U:** Ned warns his young daughter Lily about Gorm, whom she has never met ("Lily_S, watch out for Gorm. Gorm attacked me."). Her view of Gorm falls from 5.00 to 4.49, with an `attack` grievance told by Ned. Later Gorm gives her bread, and her view mends (6.45).
8. **Bugs found on the way:**
   - **A second "how about it?":** answering his partner's next line under the same intent, the one who asked said the propose stance's stock line, since the question itself had already been said in that conversation; she took it for another question. In an earlier run, the one who said yes kept saying "let me think about it" (the stock line of an agree without a promise). After a courting or family line has been said in a conversation, what follows under that intent is small talk.
   - **Either may ask:** each partner checks the conditions from their own side, and whoever gets there first asks. Scenario T now waits for either of them to ask and the other to say yes.

### M10 (2026-10-22)
1. **The skill writer (§1.4, §4 module 12, §21.1)** (`modules/skillWriter.ts`, `skills/learned.ts`), L3:
   - **When:** the CC reaches for a skill there is none of. The model names one in a decision; the code checks refuse it ("there is no skill …"), and the model is told to decide again, as before. The CC also emits `skillWanted`: the name, the arguments it was reached for with, and why.
   - **Who may write (all in code):**
     - `skillWriter.enabled` (off by default);
     - a private server: `server.host` on loopback, a private range (RFC 1918), link-local, or IPv6 unique-local or link-local (`isPrivateHost`), or else the owner's `privateServerAck` (for 0.0.0.0 in a container, say);
     - intelligence at least `minIntelligence` (0.7, §21.1);
     - a model (not code-only, not at degrade level 3);
     - and the sandbox installed.
     Why not is logged once.
   - **How often:** one at a time (single-flight), at most `perHour` (2) new skills an hour per agent; a skill given up on isn't tried again for an hour.
   - **The draft (L3, `skill` schema):** a snake_case name, a short description, typed arguments, a check and the code (the body of `async function (args, api)`).
     - **Checks:** `inventoryHas:<item>>=<n>`, `blockAt:<x>,<y>,<z>=<block>` or `near:<x>,<y>,<z>`, with `{arg}` for an argument.
     - **The prompt:** the persona core, the rules, and the skills it may use (their CC descriptions). Then: what it wanted, the name and arguments it reached for, where it is, what it holds, and what went wrong before.
   - **Checked in code before it ever runs (`lintDraft`):**
     - it is not a skill the agent has;
     - none of `require`, `import`, `process`, `eval`, `Function`, `globalThis`, `constructor`, `__proto__`, `prototype`, `WebAssembly`, `Atomics`, `SharedArrayBuffer`;
     - at least one `api.skill("…")`, and only of the skills that act on the world: goTo, follow, explore, look, wait, gather, mine, pickup, prospect, craft, smelt, obtain, place, shelter, deposit, withdraw, eat, equip, sleep, hunt, build. Fighting, giving and speaking keep their own gates;
     - a check of one of the three kinds;
     - it takes the arguments it was reached for with.
     A refused draft is written again, told why.
   - **The trial (self-verification, as in Voyager):** a draft that passes is tried out at once, for real.
     - **How it runs:** as option `work` with the new skill, through the impulse path (the plan resumes after it), with `maxSeconds` = the sandbox's wall time + 30 s.
     - **Verification:** the runner checks the result against the skill's check, like any skill's postcondition.
     - **Did what it said:** kept as verified, with an embedding of its description, a note in working memory ("I worked out a new skill: …") and `skillLearned`.
     - **Didn't:** written again, told the code, what happened and that the check didn't hold. After `attempts` (3) tries it is given up on.
   - **Cut short is not a try:** a trial interrupted (danger, something more pressing), one that couldn't start, or one that never ran within its time plus 90 s is set aside as written. It is tried again when next wanted, and given up after 3 such.
   - **No model to be had** (budget, an outage) is no verdict on the skill: nothing is given up.
2. **The sandbox (§9)** (`skills/sandbox.ts`), on isolated-vm. It is an optional dependency; without it, no skill is written or run.
   - **Limits:**
     - its own V8 heap, capped at `memoryMb` (32);
     - the code's own CPU time, capped at `cpuMs` (1 s): by the run's timeout, which covers only the first synchronous slice, and by a watchdog every 50 ms;
     - a wall time for the whole run, skills included (`wallSec`, 600 s);
     - at most `maxCalls` (60) skill calls;
     - an abort stops it.
   - **Inside:**
     - `api.skill(name, args)` runs a verified skill through the same runner as any (its postcondition checked, no slip roll) and resolves to `{ ok, observed, error }`;
     - `api.look()` gives its position, inventory, health, food and whether it is day;
     - `api.log(text)` notes something.
     Nothing else: no require, process, timers, network or files. Only JSON strings cross; the API object is frozen, and the references are taken off the global object. A failure on the host side comes back as a result, never as a thrown error.
3. **The library** (`SkillLibrary`; table `skills` in `memory/db.ts`):
   - **Where it lives:** in the agent's memory database (name, description, arguments, check, code, created, verified, uses, successes, embedding), so it survives restarts and goes along in an export.
   - **Offered to the CC:** the verified ones go in its skill list ("name {args} — description (a skill you wrote)"), at most `offered` (5). Once there are more than that, they are picked by similarity to the current goal's embedding (cached per goal); otherwise by successes, or by words shared with the goal.
   - **Used:** they run by name like any skill (`extraSkills` in the executor), with uses and successes counted.
4. **Trait annotations (§7 evolution)** (`modules/reflection.ts`):
   - **What may change someone, found by code:** formative experiences in the agent's own state, each weighed once in a life (`growth.evolved`):
     - a partner or parent killed (5);
     - becoming a parent (3);
     - being robbed, seen itself (2);
     - being beaten in a fight (2);
     - being made to pay twice or more (2);
     - a fight won (1.5);
     - two or more promises to it broken (1.5);
     - three or more kept (1);
     - three or more of its own judgments corrected on reflection (1).
   - **When:** at the end of reflection (so calm and out of danger), at most once an hour.
   - **L3 (`annotation` schema):** given the three most formative experiences, it writes how one of them changed the agent, in the third person, or says none did. Then all three are weighed and nothing is kept.
     - **What is kept:** a note of at most 100 characters, in the third person (no I, me or you) and PG (the §19.6 filter), with a leading name dropped.
     - **A note that won't do** gives way to code's own words for that experience ("has grown wary of strangers since being robbed").
     - **Without a model:** code's words for the strongest experience.
   - **Where it goes:**
     - the five latest in `traitAnnotations`, which is the persona prompt's "How you have changed lately: …" in every module that speaks or decides, and part of the state snapshot;
     - a note in working memory with salience 0.9 ("How I have changed: …"), which goes on to long-term memory;
     - `traitAnnotated`.
     The persona's YAML core is never rewritten.
5. **Deviations:**
   - **Choosing among learned skills:** by similarity to the current goal's embedding, not to the task at hand; by successes or shared words when there is no embedding.
   - **What a written skill can't do:** fight, give, speak, or call another written skill (no nesting).
   - **A private server** is judged from `server.host` alone (no DNS lookup; a name counts as public), or from the owner's acknowledgment.
   - **The trial** runs through the impulse path, so the plan resumes after it.
   - **Formative experiences** are found by code, each kind once a life, and code's words stand without a model.
6. **Tests:**
   - **Unit** (`tests/agent/m10.test.ts`, 25):
     - the sandbox: the API and nothing of the host; CPU time before and after an await; wall time, the call cap, the memory cap, an abort;
     - a draft's checks, and its check as a postcondition;
     - a written skill run through the runner on a stand-in body;
     - the library: kept in SQLite across a reopening, offered by relevance and by embedding;
     - the writer against the mocked NanoGPT:
       - written, tried at once and kept;
       - written again, told what went wrong, then given up for an hour;
       - refused drafts, and the arguments it must take;
       - a cut-short trial tried again without being rewritten;
       - a skill that can't be made, `perHour`, and the four gates;
     - private hosts;
     - the CC: a written skill passes its checks, one there is none of is wanted, and the written ones are in its prompt;
     - trait annotations: formative experiences, the note's form, with a model, a note that won't do, nothing changed, without a model, the five latest, part of reflection.
   - **Live exit test** (`tests/live/m10-skills.test.ts`, on Paper 26.1.2), 1/1. Ada (intelligence 0.9) runs on the full LLM path with a scripted model, with her memory database and the skill writer on.
     - **0 s:** her CC reaches for `stock_up_logs {qty: 3}`. The code checks refuse it, and the skill is wanted.
     - **Written:** L3 (the primary L3 model) writes it once: look at the inventory, `gather` the logs still missing, check `inventoryHas:oak_log>={qty}`.
     - **17 s:** the trial in the world gathers 3 logs (16.5 s). The check holds, so the skill is kept, in her database too.
     - **26 s:** her CC, which now has "stock_up_logs {qty: number} — gathers oak logs until I hold enough (a skill you wrote)" in its skill list, reaches for it again for 6 logs. It runs as a skill she has (+2 logs to 6, 9.5 s; she had picked up a fourth), without being written again.
     - **After:** the reopened database holds it, verified, with 2 uses and 2 successes.

### Final live regression (2026-10-22)
All 18 live exit tests were run again on the finished program (`m0` … `m10-skills`, in two groups side by side, on Paper 26.1.2). What they found, and what was done:
1. **Talking over a question (M5 scenario C; from M8):** each agent says what it does for the village when it takes the work up. Three who had just arrived said it right as someone asked the group a question, on top of the answer: four lines within 5 s, against at most two.
   - A line nobody asked for now waits for a lull (§6.2 floor control): a few seconds at random, then only if nobody in earshot has spoken for 4 s, so that of several waiting for the same quiet one speaks first. It goes unsaid if no lull comes within a minute.
   - It is said to those around, opening no conversation. A conversation of two took whatever either said next as meant for the other, and two who had said what they do went on answering each other through the next question.
   - M5's two-agent talk checks that nobody keeps talking a minute after the conversation ends. What one does for the village, now often said just after a conversation, is no talk with anyone, and is left out of that count (and logged).
2. **A way round, not to more iron (M4's chain):** one ingot short of an iron pickaxe, the obtain planner priced "nine nuggets make an ingot" as nearly free, since the nuggets could be cut from an ingot in hand. It cut one up and put it back together, three times over, and failed "missing 1 iron_ingot" for 20 minutes without looking for more ore.
   - A recipe made of what is being obtained (anywhere up the chain) is no way to more of it, even with some in hand. Short of raw iron, the error now says so ("haven't seen any raw_iron"), and the code default goes prospecting.
   - M4's chain exit test runs Pip's own goal ladder without social goals. Since M8 the village's work comes first now and then (one run went hunting far from the stone a furnace needs); that is M8's to test.
3. **26.1's spawn radius gamerule:** `gamerule spawn_radius 0` was rejected without a word (26.1 calls it `respawn_radius`), so seven live tests ran with arrivals scattered up to 10 blocks around the world spawn. In M8's NB the newcomer arrived 16.6 blocks from the board, just out of sight of it, and never read it. The live harness now fails a test on any command the server can't parse.
   - With the gamerule taking, all five of M8's V arrived on the very same block. They shared one home, and newcomers came in down a pit dug at the spawn. The run ended with two roles, against at least three. NB now has everyone arrive at the spawn itself. V keeps the scatter a server has by default (`respawn_radius` 10), as it was verified under at M8, and passed with four roles (1.92 bits).
   - **Deaths by mobs:** mobs killed four agents in each of these two V runs (shot by skeletons, a creeper, a zombie), by night and by day, and none in the first. Newcomers take their places without roles yet. Staying alive among mobs on hard is not yet reliable.
   - **Known limitation:** the board stands where the first notice went up, by its poster's arrival point. With arrivals scattered (the supervisor's `spawnRadius`, 24 by default), a newcomer may arrive out of sight of it and, with nothing to do, never go and look.
4. **Not reproduced (M3, with a model):** once, the agent dug itself into a pit in the stone and stayed there for four minutes, every walk out ending in the pathfinder's "stuck" resets. Six runs since passed, and a bot climbs out of such a pit in 3–7 s: with cobblestone, without, with nothing in hand, and with the unstick reflex firing every 4 s. A failed walk now logs where exactly it stopped, whether on the ground, and the blocks at its feet and head.
5. **A toss that went wide (M1, in the second run):** the bread given to Bram landed out of his reach, more than 2 blocks from his feet; nobody picked it up, and the hand-over failed. When what was tossed lies elsewhere and nobody took it, the giver now walks over it to have it back and tosses again from closer, once; a failed hand-over says how far from the receiver it lay.
6. **After the fixes**, on the pushed program: `pnpm run check` 495 tests, and all 18 live test files on Paper 26.1.2, 60 tests passing.
   - `m0` 6, `m1-skills` 17, `m1-night` 1, `m3-agent` 2, `m4-agent` 3 (her chain to an iron pickaxe in 288 s), `m5-population` 3, `m6-social` 8, `m6a-minds` 3, `m6b-conflict` 1, `m7-dashboard` 1, `skins` 2, `m10-skills` 1.
   - `m8-village` 2, `m8b-power` 3, `m8c-minds` 2, `m9a-romance` 3, `m9b-family` 2.
   - `m2-nanogpt`'s 2 tests are skipped without a NanoGPT key.

### Owner requests: real models, own plans, debug controls (2026-10-23)
The owner asked for:
- control over adding and removing agents, over their memories and their models, and full debug control over the Cognitive Controller;
- agents that are self-sufficient rather than ruled by instinct, that wander and look around instead of standing still, and that hide (no more tunnelling in on the first night) only when badly scared, alone and isolated, and then by their own choice;
- whole lines from stronger models, or better prompts;
- plans of their own, talked over, instead of a set schedule;
- an answer on whether agents count themselves in the group they talk to;
- test mode off, with a switch.

They also gave a NanoGPT key to test the parts that need it. Everything below was tested with that key, on the subscription endpoint only (§22), in five observation runs (`obs1` to `obs5`) of 4–5 agents on Paper 26.1.2, and by the unit and live tests.
1. **Why agents stood still, followed a ladder and dug in at dusk.** With the API's `json_schema` response format, the subscription models filled every optional field of a decision with `""`, `"none"` or a 0,0,0 position. Nearly every decision and goal failed validation, so the code defaults ran: rest, the fixed goal ladder, and the M1 night shelter. In `obs1` (the code as it was) 1 of 82 decisions came from the model. Now:
   - Structured calls use `json_object`, with the format written into the prompt and merged into its first system message (`llm.structuredOutput: object`; `schema` keeps the old way).
   - A tidy step (`decisionTidy.ts`, `tidyPlan`) takes placeholder parts out before validation. Nothing is invented there: only empty or placeholder parts go, and a missing time limit gets the option's usual one.
   - The decision prompt asks for the few fields that matter and gives three examples.
   - With these changes, 93–97 % of decisions came from the model.
2. **Never frozen.** When there is nothing pressing, the code default is to wander (radius 16 by day, 8 at night), not to rest. Two skills were added: `wander` (a stroll that stops to look at people, animals and things) and `lookAround` (stay put, watching; `rest`, `idle` and `watch` are aliases of it). Rest, yield and waiting in a talk now look around and face whoever is being talked to. Between decisions the head turns, now and then, to someone near or just around. The decision rules say: be your own person, and don't stand around.
   - **Company.** People with time on their hands keep company rather than walk off from it. With nothing pressing, a follower keeps by the one it follows (§17.7). Anyone else strolls about a friend (liking 6.5 or more), a partner, kin or someone they are drawn to, if one is in sight within 32 blocks (radius 8); otherwise about where the stroll began, as before.
   - **A talk stops a stroll.** While in a conversation with someone in sight, a stroll stays put and faces them, and a talk begun on the way stops the walk. A stroll is no reason to walk off mid-sentence.
   - **So does a fight.** When someone has been seen attacking another in the last 8 s, within 32 blocks and in sight, a stroll stops and faces them while it lasts ("stopped to watch Gorm fight"), as people stop to watch. In M8b's D the onlooker had strolled off while Gorm killed Pell, and so held nothing against him.
   - **A talk gone quiet is over.** A conversation ended on silence only after a nudge, and was nudged only if the agent itself had spoken in it. So one where it had only been spoken to stayed open as long as the other stood by in silence. In M8b's L a stroll stood 37 s "talking" with someone who had said nothing since. Any conversation silent for a minute now ends, and a stroll stays only for one with a line in the last 15 s.
   - **Followers go to their leader.** One who began following someone in the middle of a stroll kept strolling until it ended (in L, 70 s about the grass, up to 16 blocks out). Following someone now wakes the CC, mid-task too (at first it didn't: a decision while busy needs an urgent reason). A follower out on a stroll or a look about keeps by its leader from then on, if the leader is in sight within 32 blocks. That holds even if it is beside them just then: one put beside Vex at that moment strolled off from him all the same. At work, it finishes first. The code default sends a follower back to its leader's side when it is more than 5 blocks off (it was 8), since onlookers see two people together within 6 (§17.7).
   - The model may tell a stroll to keep close to someone (`near`) or clear of some people (`avoid`), as it keeps clear of monsters. The code default never avoids anyone: keeping one's distance is the conflict ladder's rung 0 (§17.5), and higher rungs mean words, threats or a brawl.
   - **What the regression found.** Code-only scenarios written when idle meant standing still came apart when everyone strolled about:
     - M9a's R and S: two who got on well strolled apart after a first hello and seldom met again, and an agent greeted on a stroll answered while walking out of earshot.
     - M8b's L: the three who resented Vex, placed out of his earshot, strolled into his company, and one came to blows with him. His followers had strayed from his side, so the rebels saw only one of them with him, or none. With company kept, nobody rose or fought, but his group strolled out of the rebels' sight (32 blocks) within minutes: each stroll began where the last had ended.
     - M8b's K: one of the proud killed one of Rex's followers in a brawl, in Rex's company, before any uprising.
     - M9b's U: a child walked off from a gift tossed to her. And a father's warning was never said: he decided on it just as their earlier talk ended for silence, and the end of that talk cut off the new one before its line went out. A talk option now ends only with a conversation that had a line since it began, and an opening line whose conversation ended meanwhile is said in a new one.
   - **RCON, one command at a time.** The server reads a single packet per read, and commands written together can arrive in one: the rest is lost and the server drops the connection. A test's keeper sending six teleports at once lost the connection ten seconds into M8b's L, and every command after it timed out. The supervisor sends commands without waiting too (starter kits, placing newcomers). The client now sends each command after the last one's answer.
   - **Alone means alone a while.** One we resent, seen with nobody near, was a moment to rise at once (§17.8), even with a weaker coalition. A follower a few steps off, or just catching up with him, made one: in L, the three rose against Vex with both followers at his side all along but for moments. Seen alone for 4 s now; hurt is a moment as before.
   - **A leader who has died is followed no more.** His followers kept following him, so in K they never left him.
   - **A new option starts once the one it replaced has cleaned up.** A stroll replaced by a decision to give stopped moving as it cleaned up, after the give had begun its walk. The walk was cut short, and the bread was tossed from 4.5 blocks off, short of whom it was for (M6's G). The executor now waits for the replaced run, its cleanup included: a moment, 1.5 s at most.
   - **One greeted says who they are in turn.** A first hello says who one is ("hello! I'm a guy who loves exploring."), but the one greeted answered "hey". So two people learned what the other is only if each opened a talk. Whether a hello is said is the CC's own roll; the `rng` a test pins sets impulses and first impressions only, as its doc says. In M9a's R, Ned and Ivy took five minutes to learn it, three times running. A reply to someone who has just said who they are now says who we are, once.
   - Two other ideas were tried and dropped:
     - Strolls that kept clear of anyone at rung 1 or more, or of anyone feared and disliked. In M6b's I, the two at odds over the grove never came to blows. In M8b's D, the onlooker walked off and never saw the killing.
     - Strolls about home (within twice the radius of home, about home). Everyone packed into one place: in M8b's J, Rex's followers saw him set upon in J itself, and walked away from him then.
   - The checks now measure what they mean:
     - M9b's T checks where the child came into the world (how near the beds it came), not where it strolled to afterwards.
     - M8b's L checks for rising against Vex, as K does: no call to rise, or joining one, from the three, and none against Vex. A call by Vex's side against a rebel is not it.
     - L keeps its premise, as K keeps its followers away. His two followers are brought back beside him every 8 s, and he and the three who resent him go back where the scene put them if they stray: in sight of each other, out of earshot. Left to stroll, the two groups drifted out of each other's sight, or into each other and a brawl. What L asks is whom fear holds back, not where strolls lead. "Vex was seen leading" is the most followers any of the three saw with him at any moment.
     - D keeps its onlooker where the scene put her, there to see the fight.
     - K tells, and no longer checks, whether his followers walk away from Rex. Whether they go is §17.8's weighing: loyalty, fondness and fear of him against fear of those setting upon him (both ways are checked in `tests/agent/m8b.test.ts`). What each fears turns on how the fights go, and in these runs it went every way. His followers walked away when two set upon him, once even though he held his own. They stood by him when he held his own in iron against the three with stone swords, and once when he was beaten, still fearing him most (0.95). Badly hurt, he was once killed. The rising itself (a call, someone joining, two striking him) came in every run.
     - M8b's J counts as Rex's followers the timid ones who followed him at any point in J, and K works with those. It used to count only those following him at one moment. His followers work, so those he wronged see him alone and call to rise within a minute, in every run, and a follower walks away from him then. The run that failed had neither following at that moment; one that passed had both, in a three-second window.
     - In M9b's U, Gorm says a word to Lily before he tosses her the bread.
3. **Night and hiding.** Digging in (the `shelter` skill) is allowed only for one who is badly scared (fear ≥ 0.5), alone (nobody within 24 blocks and nobody in sight) and isolated (more than 40 blocks from home) (`hiding.ts`). Otherwise it is refused with a reason the model can act on ("you are close to home; go back there instead").
   - The model is told that night is dangerous but no reason to hide.
   - A new appraisal, `aloneInDark`, raises fear when alone at night with monsters near.
   - A decision of the code default's never hides for an agent with a model: at night it goes home when far from it, toward people it can see, or wanders close by. Without any model (no key, or the quota spent, §22.4), the code default is the whole brain, with no mind to choose better, and it digs in at night as before. The first full regression showed why: in M8's hour, a village of code-only agents out in the open lost 21 agents, 16 of them shot by skeletons.
   - **Deviation:** M1's night shelter is no longer everyone's default, only the code-only brain's. The skill itself and its exit test (`m1-night`, a scripted bot) stay.
4. **Plans, not a schedule (§4.2 module 10).** Goal Generation makes a plan: 2–6 steps in the agent's own words, from its persona, what it has and sees, the time, how it feels, the people it knows and what it remembers. The step at hand is its current goal.
   - Each step gets a `doneWhen` that code can check. New ones are `explored:<n>`, `talkedWith:<name>` and `spent:<minutes>`, and "log", "planks" and "food" count any kind. A step code can't check gets time on it.
   - After a conversation, L2 weighs what was said into the plan (at most every 90 s): who does what, something the agent said it would do, a better idea, news. The plan records whom it was talked over with, and the CC's packet shows the plan and whether it has been.
   - Without a model, the code default draws a plan by weighted chance from the agent's needs and leanings: tools, safety, food, exploring, meeting people, the village's work, a life goal. So code-only agents don't all go through the same steps either.
   - A step of talking with someone who then dies is dropped: in M8's village run one agent kept "talk with Oswin and find out what they are up to" for 25 minutes after Oswin's death.
   - **Deviation:** the M4 tech ladder is gone. M4's chain exit test now gives Pip the long chain as a plan, the way an operator would (wooden pickaxe → stone pickaxe → furnace → iron pickaxe); she carries it out on her own and then makes a plan of her own.
   - In the runs, plans were personal and were changed after talks ("Report shelter sites to Oswin and organize food shares with Pip"; "Collect at least 12 acacia logs… (Mira confirmed helping)").
5. **Whole lines.** Speech runs at L2 (`speech: { tier: L2 }` in `config/models.yaml`). L1 lines timed out at 2.5 s into canned lines, or came out cut short.
   - The talk prompt now has the plan, who else is around and the time of day.
   - A line is cut to whole sentences (`fitWords`). A reply cut off by the token limit loses its unfinished last sentence. A stream that stalls after its first sentence says only what is whole.
   - A failed model's draft is never mixed into the next model's reply (`onRetry`).
   - Streams time out on the first piece, on a stall, and in total (3× the timeout).
   - In the runs: 206, 147, 383 and 779 lines in `obs2` to `obs5`, and none of the model's lines was cut off. The few that end without a full stop are whole: an operator's test line, the reflexes' canned "arrows! give me a sec", and casual ones such as "hey".
6. **"Talking with themselves."** The dashboard listed an agent among those it talked with, because a conversation's participants include the agent itself. The agents' own modules always leave themselves out (Talking's listeners, prompts, endings). Telemetry and the page now show only the others.
7. **Debug controls (owner request; deviation from §8).** §8 kept the Hub to infrastructure and the dashboard read-only.
   - **What the operator can do.** In the dashboard's Controls and Debug cards, with the RCON password from `.env` as the token, or with `pnpm ctl`:
     - add an agent (pool persona, name, sex) and remove one (its population target goes down);
     - kill or restart one (it resumes from its snapshot);
     - read, search, add, edit and delete its memories (an added one is marked as the operator's, and can be put on its mind);
     - set its goal, give it a plan or ask for a new one;
     - inspect it: state, plan, the packet its CC would see now, its last exchange with the model, its model chains;
     - make it decide now; make it do something (tidied and checked like the model's own decisions); stop it; make it say something; set a feeling or its caution;
     - switch modules off (the LLM as a whole, the CC's or Talking's model, Goal Gen, social goals, reflection, the Self-Monitor, impulses, conflict, romance, family, the skill writer);
     - choose the model for a tier, or the tier for a module, for everyone or for one agent;
     - pause and resume everyone.
   - **Safeguards.** Tuning is kept in `DATA_DIR/agents/tuning.json` and sent to agents as they connect. Models are checked against the subscription list, so the §22 lock holds. These `tuning` and `debug` messages are the operator's own hands, as RCON is: they carry nothing of the world from one agent to another. An operator memory is an intended exception, marked as such. Bots still never get op or spy.
8. **Test mode (§16.3).** It is off by default: `config/world.yaml` has `mode: live` (hardcore, real permadeath for everyone, no starter kits). Ways to switch it:
   - `pnpm test-mode [on|off] [--new-world]` (with no argument it prints the mode);
   - `pnpm ctl test-mode on|off`;
   - the dashboard's toggle.
   Minecraft fixes hardcore when a world is created. So a world already played in the other mode keeps it until `--new-world` starts a fresh one (the old world is kept), and setup, doctor and the preflight say so.
9. **NanoGPT, measured (deviations from §5 and §22.3).**
   - **Rate limit.** A key gets 60 text requests a minute (from its 429 replies), not §5's 20 rps. The Hub's shared bucket is 0.9 rps with a burst of 5, and the agents' own fallback bucket uses the same figures.
   - **CC planning bursts removed.** The CC no longer bursts to L3 when planning: those calls took up to 45 s.
   - **Timeouts.** L1 2.5 s → 7 s and L2 6 s → 8 s. Replies have a long tail (L1 p90 3.8 s, some past 5 s; L2 p90 3.3 s, some past 6 s), and a try that times out costs a whole second try on the next model.
   - **Planning models.** By heuristics, L3 took reasoning-flagged models first. In the first hardcore run, 12 of 21 planning calls to `deepseek/deepseek-latest` failed: empty replies after its 2000 tokens went to reasoning, or 45 s timeouts. `pnpm bench-models` now benches L3 with the planner's real prompt and format, and keeps results per tier: a model fast at planning isn't thereby good at talk. Agents now read the bench file too. Until now only `pnpm run doctor` and the single-agent script did, so `doctor` showed chains the agents didn't use. Five planning calls each:

     | model | valid | p50 | p90 |
     |---|---|---|---|
     | z-ai/glm-5.1 | 5/5 | 5.1 s | 9.0 s |
     | deepseek/deepseek-v4-pro | 5/5 | 2.9 s | 10.6 s |
     | mistral-code-agent-latest | 5/5 | 2.4 s | 2.6 s |
     | nousresearch/hermes-4-405b | 5/5 | 4.7 s | 9.6 s |
     | qwen/qwen3-235b-a22b-instruct-2507 | 5/5 | 12.0 s | 14.8 s |
     | z-ai/glm-5.3 | 5/5 | 2.6 s | 3.4 s |
     | deepseek/deepseek-latest | 4/5 | 14.1 s | 23.8 s |
     | holo3-35b-a3b | 4/5 | 2.6 s | 10.6 s |
     | qwen/qwen3.5-122b-a10b | 3/5 | 29.3 s | 41.7 s |
     | moonshotai/kimi-k2-thinking | 3/5 | 42.4 s | 42.5 s |
     | tencent/hy4-preview | 0/5 | — | — (45 s timeouts) |

     The L3 chain is now glm-5.1, deepseek-v4-pro, mistral-code-agent-latest, hermes-4-405b, qwen3-235b-instruct (`config/model-bench.json`, committed; re-run `pnpm bench-models --tier L3` to measure again).
   - **A rate token for every request.** The limiter gave a call one token, but a call can send several requests: a fallback model's after a timeout, and a repair. NanoGPT counts each, so `obs5` met 56 HTTP 429s ("Subscription text requests are limited to 60 per minute"). Each request now takes its own token.
10. **What the first hardcore night found.** `obs3` was 5 agents, hardcore, on items 1–9. Four agents died the first night: three drowned, one starved. Nobody dug in, and no monster killed anyone. What was done:
    - **Drowning.** A walk ended in a lake. The body sank while the mind decided what next, which took up to 27 s when models timed out. The swim reflex keyed only on the air reading, and in those runs it never fired. In a test lake the reading works on 26.1.2, so exactly why it failed there is not known.
      - A head under water for 6 s is now a hazard, whatever the reading.
      - A body that is in the water with nothing driving it treads water (holds jump). After 8 s it swims for the nearest shore, up to 32 blocks across open water, by steering: the pathfinder plans no way through deep water.
      - Walks (`explore`, `wander`) pick a heading whose end is on dry ground.
      - New live test `m1-water`, 3/3: held on a lake's floor among fish, the swim reflex brings it up after 8 s at full health; left idle there, it comes up, treads water and is ashore in 16 s; five walks from the shore all end on dry land.
    - **Starving.** The pathfinder sprinted everywhere, and sprinting costs a food point every 40 blocks or so: one agent went from food 15 to 0 in four minutes, found nothing to eat, and died.
      - Skills now walk. Running away and fights run.
      - The packet says plainly when an agent is hungry with nothing to eat, or starving.
      - A decision rule puts food before work.
    - **Getting items the wrong way.** 31 of 58 crafts failed (no ingredients), and so did mines without the right pickaxe or of blocks that aren't there (cobblestone), gathers of things no block drops (sticks), and tables placed "at" guessed spots in a lake. The model says what; code works out how (`itemTasks.ts`):
      - a craft, a mine of ore, stone or wood, and a gather of something made go to `obtain`, which plans the steps (wood first, the tools, a table);
      - a kind of wood is any wood (in tasks and in conditions);
      - a crafting table, a chest or a furnace goes wherever there is room nearby.
    - **Made-up places.** "Head home" went to 0,64,0, 389 blocks away, because the packet never said where home was. The packet now gives home, the village chest and the huts. A move of more than 160 blocks to a place the agent knows nothing of is refused, with where home is.
11. **What the second hardcore night found.** `obs4` was 5 agents on all of the above, in a savanna by a river. Nobody drowned or starved, and nobody dug in. But six died that night within three minutes: two impaled by a drowned's trident at the water's edge, where they meant to build, and four shot by skeletons out in the open, where they had gathered to talk. They had no shelter, armor or light, and had talked about torches.
    - The reflexes counted a mob as a threat only within 6 blocks, unless it had already hit them. A mob that shoots (a skeleton, a stray, a bogged, a pillager, or a drowned with a trident) is now a threat from 16 blocks once it can see the agent. The agent runs from a drowned rather than close in, since closing in means going into the water after it. Fleeing from shooters makes for a spot out of their line of fire.
    - The model is told how long until dark ("evening, dark in about 2 min") and until light, in the packet and in the planner's context. The night rule asks for a safe place before dark, as people do: a hut with walls and a roof near home, built together. At night it says to keep inside or close by with the others, away from open water. A hole is still only for one badly scared and on their own.
    - A hut took only oak, spruce or birch planks, so a savanna's acacia didn't count, and the door was always oak. Huts now take planks of any wood, with a door of the wood carried.
    - In `obs5` the agents prepared for dark on their own: "Dark is close, so I'm returning to the village now"; "Darkness is nearly here, and home has no hut, so I should get inside or shelter nearby"; Mira tried to build a hut ("shelter is the immediate priority"), and plans were changed to "Get wool for Mira before dark, then shelter… Hunt sheep tomorrow at dawn." Her hut found no site: the search looked for level ground only at home's own height (±1), and home stood on a slope. It now follows the ground (the level patch above or below), and the ground is the ground, not a leaf canopy.
    - The operator's test of the gate, with the debug controls, at night: told to dig in, an agent among the others was refused ("you are not alone; stay with the others"), even at fear 0.9. Alone 46 blocks from home at fear 0.9, Tobin's own model chose to go back toward his friend, not to hide; a second order to dig in came after he had wandered home ("you are close to home"). Teleporting an agent more than 64 blocks moves its home with it (§16, a respawn's rule), so the "far from home" case wasn't staged live; unit tests cover it.
12. **Seeing what changes around them (owner request, after the first report).** Agents didn't react to their shelter being broken: nothing told the mind, and the shelter skill waited for day with a hole in its wall.
    - Perception keeps the blocks that change where the agent could tell (`perception/surroundings.ts`): one touching it (a wall it stands against, the roof over its head), noticed in the dark too, or one in sight within 10 blocks.
    - Code says what changed (broken, set down, a door opened or shut), where, in words from where it stands ("beside you to the east, at head height"), and who was at it. That is a person who dug or swung there, a mob beside it ("a zombie"), or, for several blocks gone at once with nobody at them, an explosion. It also says whose it was: the shelter it is in (dug in or walled round a moment before), a hut of the village (its walls and roof, from the door's level up, not the ground about it), the village chest, or a block it set down.
    - What it digs or sets down itself is no news. Plants, liquids, fire and snow aren't counted. A change is kept 5 minutes, or until something else happens at that spot (a hole patched, by anyone).
    - The packet shows them, its own first: "Changes around you: the dirt of your shelter beside you to the east, at head height was broken by a zombie, at 2001,39,0 (2s ago)". Something of its own broken or opened is also on its mind (working memory).
    - It wakes the CC when something of its own is broken or opened, when anything changes right beside it, or on a blast. It wakes it at once if the change opens the shelter it is in, comes at night, or is a blast. Other wake-ups come at most every 10 s. A decision being made when something of its own breaks is dropped and made again with the hole in view.
    - The model is told to notice, and that a hole in its shelter or a hut is a way in, worst at night: patch it (place a block at that spot), deal with whoever did it, or get away. Without a model, the code default patches a hole in the shelter it is in or in a hut, within 5 blocks, with a block it carries, unless a monster is in it. A block of its own someone took (a crafting table, say) is news, not a hole to fill.
    - The shelter skill, waiting for day or to heal, watches its walls and roof. A breach ends the wait with where the hole is.
    - Verified live (`aware`, no model): at night Ada dug in; a wall beside her head was knocked out. She noticed it as her shelter's, her mind moved on at once, and she patched it with dirt within a second, then dug in again. Her own digging was no news.
    - With the key (`real-models`), glm-5.1's agent Bea was walled in at night when a wall went. Told "the cobblestone of your shelter beside you to the east, at head height was broken, at 1701,-59,0", she chose "place cobblestone at 1701,-59,0" ("The broken block is an opening, so I should patch it before anything enters."). Before the position was in the line, the model built a hut instead.
13. **A person of their own: the master model (owner request: agents weren't fully randomized; §16.2, §20).** The pool came first (`personas: auto`), so every new world began with the same people. Past the pool, code wrote the words from templates: up to four trait words from the strongest numbers, two values, a goal for each, and "Juno is hard-working and independent, and cares most about…". So many people read alike. L3 writing the prose from the numbers, which §16.2 and §20 describe, had not been built.
    - `personas: generated` (now the default in `config/world.yaml`) skips the pool. Every newcomer's numbers are drawn by code from the population's distributions (§20, with the sex differences), and a child's from its parents (§19.4). The numbers stay code's: real randomness, which a model writing them would not give.
    - The master model (`PersonaWriter`, L3, module `persona`, the lowest priority on the agents' shared rate limit) writes the person around those numbers, each given with how far from average it is. It writes the given name, the words for their character, a story of a sentence or two, how they talk, what they often say, what they value and want, and their sore spots. Their sex decides only the name and how others speak of them.
    - So that one person isn't like the last, code draws a spark for each: where they come from, what they once did, the way the story is told (through a habit of theirs, a day that changed them, someone who shaped them…) and the letter their name begins with. None is drawn again for the next few people. The model is also shown everyone here now, whole, to be unlike them and not reuse their phrases, and every name ever taken.
    - What it writes is checked: zod, PG, nothing of games or machines (nobody of this world calls themselves a bot or a player), and a name nobody has had. Each field is shaped for where it goes. The story is in every prompt the person thinks with, so it is clipped at a sentence past 300 characters. The way of talking follows "You talk". A sore spot is a few words, since each word of it is one an insult can hit (§18.2). If anything won't do, or the model fails or the call is aborted, code's own words stand.
    - A child is drawn at conception (its name kept for it from then) and written while it is on the way. Its birth waits up to a minute for a write still running, and one conceived before a restart is written after it.
    - At startup the next newcomer is written while the one before waits its turn to come in, so filling the population takes no longer. An agent added from the dashboard is written first and then checked against `maxAlive` again.
    - With the key (`real-models`), glm-5.1 wrote four newcomers and a child from numbers code drew, in three runs.
      - In the first, sore spots came as sentences ("worries her need for order makes her seem cold"), stories ran to 450 characters, and two of four shared an origin.
      - In the second, after the shaping above, three of four stories ended "Now she comes seeking new ground…", from a story it saw only the start of.
      - In the third, every story was whole and its own. Willa (neuroticism 0.73): "comes from a cold, snowy valley where she once drew maps of the winding trails", talking "quickly, often second-guessing herself" ("I think? Maybe?"). Garron (mercy 0.78, caution 0.77): "takes great pride in his looks and expects others to follow his lead, though he avoids needless danger and shows surprising gentleness to the defeated". Pella (grudge 0.70, openness 0.23): "keeps to familiar ways and holds onto wrongs long after they happen" ("I won't forget that."). Telden (openness 0.02, loyalty 0.84): "trusts only what he knows… though he will never abandon those who earn his trust". And Willa and Garron's daughter Merrit_W: "She carries her father's vain pride in her looks and her mother's deep worry over what others think".
      - Code's words for the same five had been "Kit; anxious, impulsive", "Moss; careful, patient, hot-headed", and so on.
      - A fourth run, in the full `real-models` suite, had a name from the first again (Kessara: the model has favourites, world after world). Three of four stories were built alike again ("comes from…; now she walks in…"). So code now draws the way each story is told and the letter its name begins with.
      - In the fifth, all five were their own. Pernilla (conscientiousness 0.95, impulsivity 0.74): "once bought a whole cart of dyed wool on a whim, ignoring a loose wheel, and lost everything in the mud; now she checks every stitch twice". Carla (rationality 0.88): "laughs hardest at her own absurd mistakes, like the time she spent hours meticulously tracking a deer only to walk straight into its hiding spot", talking "slowly and literally" ("Facts is facts."). Pernilla and Eljar's son Styr_P "takes after his mother's ambition and his father's cautious checks".
14. **Verification.** `pnpm run check` passes: 576 tests (38 files), with typecheck, lint and the forbidden-strings check. The live regression on Paper 26.1.2:
    - On the code as pushed, but for the last change to following and rising (item 2), which `m8b-power` ran on below: `m0` 6, `m1-skills` 17, `m1-night` 1, `m1-water` 3, `m3-agent` 2, `m4-agent` 3, `m5-population` 3, `m6-social` 8, `m6a-minds` 3, `m6b-conflict` 1, `m7-dashboard` 1, `m8c-minds` 2, `m9a-romance` 3, `m9b-family` 2, `m10-skills` 1, `skins` 2 and `aware` (new, item 12) 1 passed.
    - `m8b-power`, three times on the last code: 3/3, 2/3 and 3/3. The one failure was K's old check on Rex's followers, which K now tells instead (item 2).
    - `m8-village`, the hour, passed once in three runs over the day's changes. The other two fell short on the village chest (at least 2 deposits): 0 with five servers on four cores, and 1 when the chest was made only at 22 minutes (its maker had no crafting table) and two of the five died the first night. On the last code it passed: 4 deposits, 10 hunts and a build, nobody died, and the roles came out three miners, a woodcutter and a hunter (1.37 bits).
    - With the key (`AGORA_LIVE_LLM=1`): `m2-nanogpt` 2 and `real-models` 5 passed. `real-models` runs what only a model does against the real models: Reflection's bias audit and trait annotation, a skill written by L3 and tried in the world, a broken shelter seen to (item 12), and the master model's four newcomers and a child (item 13). It found the annotation bug in M10's row.
    - Live tests are sensitive to load. With five servers on four cores, checks that wait on timing failed in `m6-social` and `m4-agent`. Two or three at a time, they passed.
    - `m8-village` failed on the code before code-only agents dug in at night again (21 deaths, item 3).

    The runs with the key:

    | run | code | agents | decisions from the model | dug in | lines (cut off) | deaths |
    |---|---|---|---|---|---|---|
    | obs1 | as it was | 4 | 1 of 82 | all 4 at dusk | 84 (11, e.g. "Hello Pip, working on anything") | — |
    | obs2 | items 1–8 | 4 | 181 of 187 | 0 | 206 (0) | — |
    | obs3 | items 1–9, hardcore | 5 (+ replacements) | 300 of 314 | 0 | 147 (1, an operator test line) | 3 drowned, 1 starved |
    | obs4 | items 1–10, hardcore | 5 (+ replacements) | 251 of 261 | 0 | 383 (3, the reflexes' canned "arrows! give me a sec") | 2 by a drowned's trident, 4 shot by skeletons, all the first night |
    | obs5 | all of the above, hardcore | 5 | 401 of 432 | 0 | 779 (none cut off) | 4 the first night (two by zombies, a skeleton, a spider at dawn), none the second |

    In `obs5`, 171 of the 432 decisions weighed the coming dark or shelter. The first night, four of the five died: two by zombies; one shot by a skeleton just after the operator had restarted her, at night; and one by a spider at dawn. The second night, on all the fixes, with three of the five newcomers, nobody died. The hut was never finished: twelve tries, short of blocks, or with no level, clear 7×7 site in that hilly forest. `obs3`, `obs4` and `obs5` each had a world of its own (the seed comes from `config/world.yaml`, random by default).
15. **Known limitations.**
    - Monsters at night are a real danger now that nobody hides by default. The reflexes fight or run, and on hardcore an agent can die.
    - The key's 60 requests a minute are shared by every agent on it. Five agents used about 35–40 a minute, and more agents mean slower decisions.
    - The models' choices vary in quality, and sometimes one is odd. A refusal comes back to the model with its reason, and a run of failures gets "do something different".
    - NameMC still turns the Hub away (Cloudflare), so skins need its pages saved by hand (§16.5).
    - L1's small models time out often with five agents on a key (in `obs5`, llama-3.3-70b failed 91 of 215 calls, gemma-4-12b 66 of 295). An agent of low intelligence, whose CC runs on L1 (§21.1), falls back to the code default more often. `pnpm bench-models --tier L1`, or a model chosen for L1 with the debug controls, is the remedy at hand.
    - A hut needs a level, clear 7×7 patch near home. In hilly forest none may be found; the builder doesn't yet clear trees or level ground.

### Owner requests: a console, deaths, talk, building and more (2026-10-24)

The owner asked for, after playtesting: a server console and Stop and Restart buttons on the dashboard; agents that cease
all activity when they die; dialogue that is cogent rather than quick (a larger model, about 8 s is fine) and sounds
like Minecraft players; talks that take turns and end once a group agrees; agents that make their own tools, keep
items in real chests, and fight mobs they can beat; buildings designed from a repertoire researched from real builds,
with a fourth model tier for the design and its materials; land cleared for building, and moving to flatter ground;
naming tools at an anvil, enchanting, and expeditions to the Nether and the End by choice; and a hidden controller
that sets right only what is odd. Whether two API keys would help with timeouts was asked too (item 5).

1. **A server console and Stop and Restart (dashboard).** A Server console card shows what the Minecraft server prints
   and runs commands on it as its own console does (the slash is optional; the up arrow brings back earlier ones). It
   goes through the control endpoint behind the same token, with the same refusals as `pnpm ctl rcon`: op and chat
   spying only for the owner (§13 rule 9). The output is kept in memory only, the last thousand lines
   (`dashboard/console.ts`); the page asks for new lines every two seconds, and those reads aren't logged. The Controls
   card gets Restart and Stop, each after a confirm. Rendered in Chromium, light and dark, wide and at phone width: a
   command and its answer show, the up arrow works, and both buttons reach the handler.
2. **A death ends everything at once.** An agent went on acting for a moment after it died: mineflayer respawned the
   bot at once (at the spawn, or on hardcore as a spectator), and the agent's modules ran on until the process wound
   down. It could walk, speak and call its models in that time.
   - The bot never respawns (`respawn: false`): the body stays where it fell.
   - At the death event the agent stops everything synchronously (`Agent.die`): the body stops moving, digging, fighting
     and using items, its reflexes stop, nothing more is said (what was waiting included), every module halts, and every
     model call of the agent ends there, one under way included (`haltable`: the agent's client cut off by one signal).
   - Perception keeps hearing the death's cause for the report; memory is written as the process ends.
   - Live (`death`, new): Ada, killed mid-stroll, stays where she fell for 8 s, says nothing, decides nothing and runs no
     skill; Bo beside her hears her die and nothing from her after.
3. **Talk like players.** The talk rules ask for lines typed the way Minecraft players chat: mostly lowercase, short,
   light on punctuation, the odd lol/ngl/tbh/omw where a player would, and plain about what is meant, naming things, and
   saying so when something gets decided. A person's own way of talking still shows through.
4. **A stronger model for lines, with time for it.** Talk drives how the agents deal with each other, so a line now gets
   models of its own (`speech.models` in `config/models.yaml`, each tried before the tier's chain and only if on the
   subscription list; the operator's model for the tier still comes first) and 8 s a try (`speech.timeoutMs`). Twelve
   subscription models wrote eight lines each from the real speech prompt: a group sharing out the work, lending iron,
   a plan agreed, a grudge, zombies at night, news of a village, talking someone into the Nether, a trade. All answered
   within 8 s but `glm-5.3` (one 15 s reply, one timeout); most took about 2 s.
   - `glm-5.1` wrote the clearest lines in the most natural player style ("ooh yeah lets do it!! all three of us, cave
     east, iron mining fr. omw!"; "bram you took 4 of my logs without asking. stop taking my stuff go chop your own"),
     p50 1.6 s, p90 2.1 s.
   - `kimi-k2.6` ("sure np got 5 rn heres 2") and `mimo-v2.6-pro` were close; `minimax-m3`, L2's first by heuristics,
     was plainer; `deepseek-v4-pro` made up places ("the birch grove west of here"); `mistral-small-4` got requests
     wrong ("ok lets do it" to lending iron).
   - The chain: glm-5.1, kimi-k2.6, mimo-v2.6-pro, minimax-m3, then L2's own.
5. **Would two API keys help with timeouts?** Not with the timeouts we measured: those were the models answering slowly
   (in `obs5`, the small L1 models, 7 s and more), not the key's limit, and a second key doesn't make a model answer
   faster. What a second key could add is requests: our limiter keeps all the agents together under the 60 a minute
   NanoGPT allows ("Subscription text requests are limited to 60 per minute"). Five agents used 35–40 a minute; eight
   or more would queue. NanoGPT's documentation says its daily limits are per key, but not whether the 60 a minute is
   per key or per subscription, and the weekly token allowance is the subscription's. So two keys on one subscription
   may share both; two subscriptions would double both. A key pool (each key with its own limiter and its own startup
   check that it cannot spend balance) is a small change once that is known.
6. **Taking turns.** People talked over each other, and too fast. A conversation is between two in state, so in a group
   each answered each partner separately.
   - A line is read before it is answered: 0.5 s plus 30 ms a character, up to 3.5 s.
   - Lines that come in while a reply is pending, from anyone, are answered together, one line at a time (a single
     pending batch and one in-flight line per agent); the line is noted in each conversation it answers.
   - A line put to a group without a name is answered by whoever is first; the rest stay quiet unless they have
     something else to say (no, a counter-offer, a sharp word).
   - A line goes out only once nobody else has spoken for 1.2 s: held in the chat queue after typing (when it would go
     out), with a random beat of up to 0.6 s first, so two who waited for the same quiet don't both go.
7. **A talk that has settled what to do ends** (`modules/consensus.ts`). A stroll stays put while a talk is live, and
   people stood about talking long after they had agreed.
   - With a model, a line that sounds like a yes, or every six lines of a group talk, is followed after 3 s by a short
     L1 question: did the people talking agree on something to do now, with nobody still against it; what; and our part
     in it. At most once every 10 s, and the lines that come meanwhile are read too: players agree loosely ("sounds good
     but lemme finish these logs") and skip question marks, so the model judges, not the words alone.
   - Without a model: a yes to something someone else put forward, with nobody pushing back in between or in the 3 s
     after.
   - Settled: the talks with those in it end (`agreed`), "we agreed with Pip, Wren: go to the cave east and mine iron
     together; my part: bring torches" goes on the mind, and the mind decides at once. Small talk waits 45 s after (a
     question put to us by name doesn't). The decision rules say: once a talk has settled what to do, stop talking and
     go do it.
   - A group talk a few lines past one's turn cap within two minutes is enough too: one's talks end, "I've talked long
     enough for now" goes on the mind, and the mind gets on with things.
   - Live with the real models (`real-models`, three from the pool, asked to go chop the oaks together): before, 75
     lines in 107 s, 25 of them over someone else's, and no agreement; now 29 lines in a minute, none over another, 28
     lowercase, the plan settled ("collect one stack of logs each and meet at the river hut spot"), and all three off
     gathering wood.
8. **Agents make their own tools.** Agents waited to be handed tools: mine and gather failed with "need a stone_pickaxe"
   and hunt went at animals bare-handed. A skill that needs a tool now makes it when it can, as a player would, through
   obtain (the wood, the sticks, the cobblestone, the table).
   - gather and mine make the pickaxe a block needs, once, and dig on; without the means they name the tool needed.
   - gather makes an axe or a shovel first for six or more of wood or earth (and gathers as many more as the axe used).
   - hunt makes a sword first when it carries no weapon. A tool being made makes none of its own.
   - The decision rules say to make one's own tools and not wait to be handed one.
   - Live (`m1-skills`): iron ore with a wooden pickaxe: a stone pickaxe made of the stone about, the ore mined; with
     nothing to make one of, the error names the stone pickaxe; a cow hunted with a wooden sword made first; six logs
     with a wooden axe made first.
9. **Chests are things in the world.** Agents spoke of putting things in a chest that wasn't there.
   - deposit at a spot with no chest says so. With no chest about at all, a builder makes one (anyone, when no builder
     has been seen alive lately), sets it down by home and fills it; otherwise the error names the builder to ask.
   - The decision check refuses a deposit or withdraw at a spot where no chest is known (the village chest, or one seen
     there), saying where the village chest is, or that there is none yet; the packet says "no village chest yet".
   - Placing: the spot finder had picked the cell on a crafting table obtain had just set down, and a click on a table
     opens it (the server refused the chest). Spots on usable blocks are skipped, a plain block is placed against first,
     and against a usable one the body sneaks, as players do.
   - Live (`m1-skills`): deposit with no chest makes one of three logs and fills it; at a spot with none it says so.
10. **Armed agents fight.** Against monsters only, a weapon lowers the health at which an agent runs: with a stone
    weapon or better an average agent fights a zombie or skeleton down to about three hearts (it ran at five before);
    with a wooden one, four. The decision rules say to fight what comes at you when armed and not low, and to run when
    unarmed, low, or facing a creeper or a crowd. Live: armed at seven hearts, Pip kills a zombie without running; at
    two hearts he runs.
11. **Buildings: what was researched, and what came of it** (`packages/agent/src/building/`, `buildings/`). Building is
    at the heart of this experiment, so the ways to get buildings agents can put up were weighed against each other.
    - **From photographs.** The minecraft.wiki village pages show each village building in a photograph or two
      (Planet Minecraft and Reddit refuse automated access, 403). Eight were studied: the plains small, medium and big
      houses, library, fisher cottage and armorer's house, a savanna house and a desert house. Seen from one or two
      sides, a photograph leaves the rest to be inferred: the far walls, the roof's other slopes and the inside. So
      each was drawn as a design in a building language (below), not copied block by block. The unseen sides follow
      from the style, and the inside is furnished from what such a building holds. Seventeen designs came of it and
      of players' usual builds: cottages, a farmhouse, an L-shaped house, a longhouse, desert, savanna, taiga and snowy
      houses, a stone tower, a library, a smithy, a storehouse, a starter hut, a wheat farm, an animal pen, a well and
      a lamp post. Each was rendered from four sides and checked against its photograph.
    - **From the game's own files** (`vanilla.ts`). Better than any photograph: every village building, from every
      side and with its interior, is in the game's structure files. They are read from the owner's own server jar (the
      Paper jar, or the Mojang jar bundled in it), 152 of them across the five village types. Nothing is copied into the
      repository. Block states are kept where they matter (facing, half, axis, a door's hinge), natural ground is left
      out, jigsaw markers become what they turn into, and structure blocks are dropped.
    - **Alternatives considered.**
      - *Research datasets* of houses built by people, with every block (the CraftAssist houses; 3D-Craft, with the
        order they were built in): realistic, but large, from older versions with old block names, and under licences
        that would need checking.
      - *Shape grammars and procedural generators* (as in the GDMC settlement generation competition): good at fitting
        terrain, but each style is hand-coded, and they give an agent nothing to ask for in words.
      - *Wave function collapse* over tiles: varied, but it doesn't know where a door or a bed goes.
      - *A model writing raw blocks*: what models do worst. Coordinates drift, blocks float, stairs face the wrong way,
        and a three-block door is made of three unrelated blocks.
      - *A model reading a photograph into blocks*: possible with several views, unreliable from one, and no better
        than the game's own files for what the game already has.
      - The choice: a small building language a model writes well and code turns into blocks correctly, with the
        game's own buildings and the drawn designs as its examples.
    - **The building language** (`design.ts`, compiled by `compile.ts`): one to three rectangular parts (an L or a T),
      a wall height, walls with posts and beams, a roof (gable, hip, shed, flat; a style and a material), a door,
      windows, furniture along the walls, a few features (a chimney, a porch, a fence, a path, a lamp), a plot (a pen, a
      farm, a well) and free detail blocks. Block names are tidied (case, `minecraft:`, spaces).
    - **The compiler** places blocks in an order a player can follow: each one against a block already there, and a
      door's top or a bed's head right after its first half. Roofs over parts of one height become one surface, so
      joined gables meet in a valley. Stairs face up the slope, ridges and peaks are slabs, gable ends are walled up,
      and the inner rings of a hip get a block of their own to go against. Furniture goes against walls, ladders
      against sturdy walls, torches beside the door. A door that can't go where asked is moved to the nearest outside
      wall that takes it, and a detail with nothing to stand on is left out; both come back as notes. What can't be
      built is reported, never built wrong.
    - **Materials** (`materials.ts`): the bill, the crafting from gathered to placed (craft, smelt, strip, gather; each
      recipe chosen by the cost of its ingredients), how hard each block is to get (sand and wool cost more where there
      is none), and a lookalike for a block too hard to get (sandstone for smooth sandstone, a smithing or crafting
      table for an anvil). Wood follows the trees about.
12. **The builder** (`body/skills/construct.ts`, skill `build {design}`) puts any design up the way a player does:
    - the site cleared of what is in the way, from the top down (a tree, a hillside), keeping earth that can be tilled;
    - holes under the ground layer filled, deepest first;
    - then each block placed nearest-first from where it can be reached, facing the way it must: stairs up the slope,
      a door into the room, a chest into the room, a torch on its wall, a log along its beam, a slab in its half.
      Paper checks only reach and that the click falls on the block, so the builder turns to the facing a block needs
      before it clicks;
    - it stands on its own work or on scaffolding that it takes down after, never digs through what it built, and walks
      out of the door.
    - Without coordinates it finds the best site near home, door toward home, away from other buildings. It starts with
      a quarter of the materials or more, says what it lacks, and a second go carries on at the same place (the project
      is kept in the village state). A building counts as done when nearly every block is in, nothing is missing, and
      the doors went in.
    - Live (`build`, 4 of 4): a cottage on flat land, a hut on a mound with a tree on it, one of the game's own plains
      houses, and a build begun with half the materials finished on a second go.
13. **The architect: a fourth model, only when a building is designed** (`building/architect.ts`, skill `design
    {purpose}`). An agent who wants a building of its own asks the architect: the strongest models first (`architect`
    in `config/models.yaml`: glm-5.3, glm-5.1, deepseek-v4-pro, then L3), 90 s, the nearest designs of the repertoire
    as its examples, and what the agent knows: its purpose, the biome, what is to be had about, the village's buildings
    and who does what.
    - The compiler checks the draft and sends back once what doesn't work (a door moved, a floating detail left out, a
      design too big for the effort the agent will put in, set by its conscientiousness); a second failure falls back
      to the nearest design.
    - Code swaps blocks too hard to get for lookalikes, works out the bill and the crafting of the parts (doors,
      fences, glass, slabs), and picks who could bring what (the woodcutter the logs, the miner the stone, the farmer
      the wool; up to two asks).
    - The design is saved for the whole village, and building it becomes the agent's plan: get the materials it
      gathers itself, ask the others for theirs (a talk), make the parts, build it.
    - Bench (four real requests, five models): glm-5.3 drew all four buildable the first time in 7–12 s, and they
      looked good; deepseek-v4-pro and glm-5.1 needed a second try for some; kimi-k2.6 and qwen3.5-397b often drew what
      couldn't be built.
    - Live with the real model (`build`, `AGORA_LIVE_LLM=1`): asked for "a cosy house for me and Wren, with room for a
      child later", glm-5.3 drew a birch and oak house the first time, and the builder put it up in three minutes, 222
      of its 225 blocks as drawn. The first try found two faults, both fixed:
      - A porch given a wood's name ("birch") made posts of a block called "birch". A feature's wood now gives that
        wood's fence and slabs, and every block of a draft is checked against the game's own block list, so one it
        lacks goes back to the model to put right.
      - A trapdoor put against the block above came out facing the wrong way. Against a block above or below, it faces
        away from the one placing it, so the builder now turns first.
14. **Rough land, and moving the village** (`body/skills/settle.ts`). `scout {for: "flat land"}` says how easy home is to
    build on and looks out for level ground with room for a village: first what is in sight, then a walk out the most
    promising way and another look. `settle {x,y,z}` makes a place home once the others agree to move, and the village
    (its chest, huts, board and signs) starts again there. Talking it over and going together are the agents' own; the
    decision rules say to clear land worth building on even if it is rough, and to talk the others into moving if home
    is too rough.
15. **Anvils and enchanting** (`body/skills/enchanting.ts`). `name {item, name}` names a tool, weapon or armour at an
    anvil: one seen (remembered where), one carried, or one made from the 31 iron it takes, put down and used.
    `enchant {item}` works an enchanting table (seen, carried, or made of a book, 2 diamonds and 4 obsidian) with lapis
    and experience, taking the strongest offer it can pay for. Both spend real levels and say plainly what is missing.
    The anvil is worked by hand (item in, name typed, result taken): mineflayer's helper predates item components and
    misjudges the cost. Names and enchantments are read from components in every shape the game sends. Bolder life
    goals are among the defaults now (a named, enchanted sword; the Nether; the End). Live (`enchant`, 3 of 3): a sword
    named at an anvil in sight, after a plain no without experience; an anvil made of 31 iron and used; a sword
    enchanted.
16. **Expeditions to the Nether and the End** (`body/skills/expedition.ts`). These are possible but not easy, and chosen
    by the agents themselves. The decision rules weigh riches and glory for their people against a likely death, and
    say to talk friends into coming.
    - `portal`: a frame of 10 obsidian (four corners of anything) built and lit with flint and steel (made if missing).
    - `travel {to}`: through a known portal, both ends remembered in the village's portal book. The game won't take
      anyone back through a portal they haven't stepped out of (each moment in it restarts the wait), so it steps out
      on arrival, and out and in again if a trip doesn't happen.
    - `eye`: throws an eye of ender and reads where it flies.
    - `fill`: puts eyes into an End portal's frames, saying when it opens.
    - In the Nether or the End the packet says what kills people there and where the portal home is. Home is in the
      Overworld only, and remembered sightings are kept per world.
    - Live (`expedition`, three runs in a row, plus 14 round trips from different places): a portal built and lit, into
      the Nether and back; an End portal's twelve frames filled; into the End; and no way out while the dragon lives.
17. **The controller: a hidden master model for what has gone wrong** (`packages/hub/src/hub/controller.ts`, agent
    `modules/urges.ts`). It sees what every agent decides, does and says (their telemetry) and steps in only on the odd
    and the irregular. Code finds the cases, with thresholds well past the ordinary:
    - a talk going round in circles: three of five or more lines in five minutes saying again what was said (the talk's
      own check ends one that says a line again word for word; this catches the same thing in other words);
    - the same talk started and ended four times in twelve minutes;
    - sixteen lines in eight minutes and nothing else done, standing in one place;
    - the same task failing four times in ten minutes in one way after another (the agent's own stuck mark is for one
      way);
    - six minutes stuck in one spot, getting nowhere (not a long smelt, a rest or a night hidden);
    - twelve changes of mind in three minutes with next to nothing done;
    - six minutes with nothing under way and nothing done or said.
    - Each case goes to the master model (glm-5.3, then kimi-k2.6, then L3), which judges it and words the push.
      Putting off one's goals to talk, and a long talk that keeps moving on, are the agents' own business and left
      alone. A case that ends while the model thinks is dropped.
    - Pushes: move on (a goodbye in chat style, the talk ended, its people left alone four minutes, a walk away from
      them), walk a little way off, give up what keeps failing (that skill for that thing, 15 minutes, lifted by a
      success), or think again.
    - The agent takes the push as an urge of its own, like a quirk's impulse. The thought goes on its mind in the first
      person, and it never learns of the controller. The model's words are used only if they will do as the person's
      own (no numbers, no stranger's name, nothing out of the world or about being pushed); otherwise code's. Without a
      model, code pushes in these same cases.
    - Seldom: each person and kind of trouble at most once in ten minutes, a person left alone three minutes after a
      push, at most 20 urges an hour (`controller` in `config/models.yaml`). The dashboard shows each push to the
      operator, who can switch the controller off per agent. The urge (`t: 'urge'`) is the one Hub message besides
      `cautionShift` that changes an agent's inclination. Like it, it carries nothing the agent doesn't perceive: its
      own trouble in its own words, and the names of whoever it was just talking with.
    - Bench (the real prompt; five cases: a talk going round in circles, a long talk that keeps moving on, a craft
      failing five times, a walk stuck in place, a busy talk full of "ok"s that code lets be): glm-5.3 judged every case
      right each time, letting the long talk be in 6 of 6 (4–22 s). kimi-k2.6 was quicker but broke the long talk up
      once in 4; deepseek-v4-pro broke it up every time. With the long talk spelled out as the agents' own, the right
      verdicts held.
    - Live (`controller`, twice): Ada says the same thing to Bram in other words in real chat. The controller sees it;
      she says "aight im gonna go get stuff done, cya", ends the talk, leaves Bram be and walks off; nothing on her mind
      speaks of a controller.
18. **What the live regression found, and put right.**
    - *A hand-over that worked was taken for a failure.* Two items tossed together merge on the ground, and the pickup
      of the merged stack can still say one, so `give` said the other hadn't got them and the promise or trade looked
      broken. When everything tossed is gone and only the one it was for picked any up, it is theirs, and the wait ends
      as soon as nothing is left lying. The `m1-skills` give test failed 2 runs in 3 before, none in 3 after.
    - *A walk that never took a step again.* After clearing a site with a tall tree on a mound, the next building
      couldn't be begun: every walk timed out without a step. mineflayer lets go of a dig whose time is up and then
      waits for the block to turn to air, so a dig the server refused never settles. The pathfinder, "digging" still,
      never moves again, and its reset waits for an end that mineflayer has nothing left to send.
      - Every stop now lets go of such a dig, and the body checks every 2 s for one left over.
      - Our own digs end once the block should long have broken (its dig time and 5 s more), in every skill that digs.
      - A failed walk waits for its stop to take hold before the next one starts.
    - *A tree's top out of reach.* Clearing went strictly from the top, and the top of a tall oak can't be got at
      from the ground past its own leaves. Clearing now goes in passes: what can't be got at waits for what is under
      and around it to come away, and leaves left over once the logs are gone fall by themselves. Block after block
      out of reach with nothing coming away, a build now stops and says so, instead of trying for most of an hour.
    - `build`, all four tests, before: 1 run in 3 passed; after: 3 runs in 3, one with a 104-block tree.
19. **Verified** on Paper 26.1.2:
    - `pnpm run check`: 643 unit tests.
    - The live tests of these requests and of what they touch, on the final code: `build` 4 of 4 in three runs in a row,
      and the architect's own design drawn by the real model and built. One run of `m1-skills` (tools, chests, armed
      fights, the give fix), `aware`, `m3-agent`, `controller`, `enchant` and `expedition`: 29 of 29.
    - Earlier the same day: `death`, `expedition` three runs in a row plus 14 Nether round trips, `controller` twice,
      and `real-models` (the three-way talk).
    - The controller's prompt was benched on the real models.
20. **Nobody asks someone in sight whether they're still there** (owner request, after the PR). Agents kept asking
    people they could see "you still there?" or "hello?", which broke the flow of talk. It was the conversation
    module's nudge: 20 s into a partner's silence it asked whether they were there, though it only did so while the
    partner was in range and could be seen.
    - The nudge is gone. Someone right here who hasn't answered our line in 25 s is busy, or done talking, and the
      talk ends quietly (`partner silent`). Someone who walks off is still let go after 10 s out of range.
    - The talk rules and the decision rules both say it too: you can see who is near you; never ask whether someone is
      still there, can hear you or is around.
    - Live (`quiet`, new, code alone; and with the speech models in `real-models`): Ada asks Bo, who stands in plain
      sight, whether he wants to go mining; he says nothing. She asks nothing more of him, and the talk ends quietly
      within 40 s. With the real models she asked once, added one line, and never asked if he was there.
