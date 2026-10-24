# Research basis: agents that think like Minecraft players

*Prepared 2026-10-24 for the redesign of the agents' mind (DESIGN.md §4.8): perception, the Cognitive Controller (CC) and skills. Every source was opened and checked; URLs and DOIs are in §6. Text marked **(inference)** applies the sources to this project and is not a finding of the sources. Code remarks refer to the code before the redesign (`a98a26b`).*

---

## 0. Key findings

1. **People notice what violates their expectations.** Perception runs on prediction, and attention goes to prediction error. Nobody tells a player to watch for flying: unsupported bodies fall, so a hovering player is surprising. Our perception states no expectations, so nothing can surprise the agents.
2. **Human problem solving happens at impasses.** A stuck person, like the Soar architecture, opens a subproblem: why did this fail, what else would close the gap, what is the goal for? The answer is then compiled into a reusable rule. The wool loop was an impasse with no subgoaling and no knowledge of other ways to get wool.
3. **Experts are fast because most of their play is not deliberated.** They run compiled routines and commit to multi-step intentions, act on opportunities as they come up, and deliberate only when something is new, dangerous, failing or surprising.
4. **Human Minecraft knowledge is external and social.** It comes from the wiki, videos, experiments and other players. An "experienced" agent needs game knowledge it can look things up in, not only a claim in its prompt that it knows the game.
5. **Giving up is a calculation, not a failure.** People quit when the odds and costs say so, and they leave a patch when its yield drops below what is available elsewhere. The usual errors are the sunk-cost trap and, for LLMs, quitting too early.
6. **The Minecraft LLM-agent work converges on one design:** text observations, explain-then-replan, structured knowledge of how things are obtained, verification against game state, and memories of what worked. None gives the model a relational scene description (MP5 only answers questions about relations), and none models what is normal. Project Sid names missing spatial reasoning as its main limit.
7. **Code must do what LLMs do badly.** LLM agents tend to ignore unexpected observations, struggle to correct themselves without outside feedback, and handle egocentric frames and coordinate lists poorly. So code should compute geometry, expectations, surprises and checks; the LLM interprets, chooses and explains.

---

## 1. The owner's three failures as cognitive gaps

### 1.1 The wool loop: an unresolved impasse

The agent killed the nearby sheep (one wool each) and then kept repeating a skill that could no longer succeed. In Soar this is an **impasse**: the selected operator can't be applied (an *operator no-change*) and nothing else is proposed (a *state no-change*). Soar responds in the architecture itself. It opens a substate whose goal is to resolve the impasse. Once resolved, the result is compiled into a new rule (a *chunk*) "so that this new production may match in a similar situation in the future and prevent an impasse from arising" (Soar Manual ch. 2; Laird, Rosenbloom & Newell 1986).

The human version is **means–ends analysis** (Newell & Simon 1972): name the difference (no wool), list the operators that reduce it, and turn their missing preconditions into subgoals. The Minecraft Wiki lists these sources of wool:

- shearing an adult sheep: 1–3 wool, and the sheep lives and regrows wool after grazing;
- killing a sheep: 1 wool, only if it is unsheared;
- crafting from 4 string;
- buying from an apprentice shepherd;
- taking it from village houses, woodland mansions, pillager outposts and ancient cities, and from village shepherd chests (*Wool*; *Sheep*).

String in turn comes from spiders, cobwebs cut with a sword, chests, bartering and cat gifts (*String*). A player also **regresses the goal**: wool is usually for a bed, and beds generate in village houses and are sold by shepherds (*Bed*). And a player **stops**. Giving-up decisions use the same estimates of success probability and cost that guide moves (Payne & Duggan 2011), and foragers leave a patch whose yield has dropped below what the environment offers elsewhere (Charnov 1976).

(inference, from the code) Three things in the code invite this loop:

- The item planner routes items only through block drops, crafting and smelting.
- The CC packet (`modules/bottleneck.ts`) lists no animals at all.
- minecraft-data's 26.1 `entityLoot` gives sheep only mutton (checked in `node_modules`), so a source graph built from the data alone would miss wool.

### 1.2 The unnoticed flyer: no expectation, no surprise

Infants of 4.5 months look longer at an object left in mid-air without support (Needham & Baillargeon 1993). At 11 months they explore objects that violated their expectations and test the specific violation (Stahl & Feigenson 2015). Predictive-processing accounts make prediction error the core of perception (Clark 2013; Friston 2010). Bayesian surprise, a measure of how much an observation changes beliefs, drew 72% of viewers' gaze shifts to above-average-surprise locations (Itti & Baldi 2009).

The game uses the same principle:

- With `allow-flight=false`, a server kicks a player who stays airborne for about 5 s (*Server.properties*).
- Simulation anticheats such as Grim keep "a 1:1 replication of the player's possible movements" and flag what falls outside it (Grim README).
- The movement envelope is documented in blocks/s: walk 4.317, sprint 5.612, sprint-jump 7.127, creative flight about 11, sprint-flight about 22, elytra about 30 (*Transportation*).

(inference) Our perception reports a person's name, distance, sentiment and held item, never their motion or what is under them, so the model could not have noticed. Even when LLM agents do see something unexpected they tend not to act on it. In AppWorld, agents read documentation saying a command "returns the complete solution to this task" in over 90% of attempts but used it in under 7% (Engländer et al. 2026). The violation has to be computed and shown *as a surprise*.

### 1.3 Slow and rigid: deliberation where habit should be

Across 3,360 StarCraft II players, a perception–action cycle took about 5 s in the lowest league and about half that for professionals, with a similar number of actions per cycle. Action latency best predicted rank, and worker production stopped separating the top players, which the authors read as automatization (Thompson et al. 2013). Experienced decision makers usually recognise a situation, take the first workable option and check it by mental simulation (Klein 1993). In Kinny & Georgeff's simulations of agents in changing worlds, the authors concluded that neither replanning at every change nor never reconsidering is right: an agent should commit to its plans and reconsider them at crucial moments (Kinny & Georgeff 1991, summarised in Georgeff et al. 1999).

(inference) At HEAD the CC is asked again after every option ends, with about twenty directive rules in its prompt. That produces the slow, rule-following feel.

---

## 2. How people learn and play Minecraft (question A)

### 2.1 Novices: priors, probing, trial and error

People learn games quickly because they bring priors. When Dubey et al. (2018) masked object semantics and visual regularities in a simple game, human completion time rose from about 2 to over 20 minutes. A model that builds an intuitive theory of a game, explores to reduce its uncertainty and plans with it matched human learning efficiency on 90 Atari-style games (Tsividis et al. 2021). Trial and error is itself guided: people sample actions from rich priors, simulate them mentally and update after each real try (Allen, Smith & Tenenbaum 2020).

Gee (2003) described game learning as probe, hypothesise, re-probe, rethink. Observation shows players also use plain trial and error without a hypothesis, alongside hypothesis-testing *experiment* (Iacovides et al. 2014). Expertise shifts the mix. In a think-aloud study of a puzzle game, experts reasoned by analogy and novices by trial and error (Hong & Liu 2003). In a Minecraft learning task, early wandering predicted poorer learning (Esclamado & Rodrigo 2022).

**Apply (inference):** for an experienced agent, the first move on a new problem is retrieval and analogy (memories, game knowledge). Trial and error is a bounded fallback.

### 2.2 Knowledge from outside the game and from other players

- **The knowledge lives outside the game.** Recipes had no in-game help until the recipe book arrived in Java 1.12 (*Recipe book*). The MineDojo corpus holds 730k YouTube videos, about 7k wiki pages and 340k Reddit posts (Fan et al. 2022).
- **Players produce it by experiment.** The wiki's movement-speed table came from timed trials; Watson (2017) calls this "procedural elaboration".
- **Players seek and judge it.** Teenagers seek game information in "affinity spaces" and evaluate what other players share (Bebbington & Vellino 2015). Minecraft YouTube comment threads give just-in-time access to "quasi-experts" (Walker, Slater & Kafai 2019).
- **They learn from each other selectively.** In a Minecraft foraging experiment, the best players flexibly combined their own exploration with copying others, guided by their own success (Wu et al. 2025).
- **Exploring builds memory.** In a two-week study, gains in hippocampus-linked memory tracked how much people explored in Minecraft (Clemenson, Henningfield & Stark 2019).

**Apply (inference):** an "experienced" agent needs three things: knowledge it can look things up in (as players use the wiki), a map memory built by exploring, and the habit of watching and asking others when its own approach stops paying.

### 2.3 How experts play efficiently

Human baselines give the scale:

- Diamond tools take "proficient humans upwards of 20 minutes (24,000 environment actions)" (Baker et al. 2022).
- MineRL's expert time is the average for players with at least five years' experience (Guss et al. 2019).
- Optimus-1's human baseline (ten volunteers with at least 20 h of play) solved 36.41% of 67 long-horizon tasks, against 22.26% for the best agent (Li et al. 2024).

What makes experts fast:

- **Chunking and compiled procedures.** Masters perceive chess positions as chunks (Chase & Simon 1973). Practice speeds performance as a power law (Newell & Rosenbloom 1981). Skills move from slow declarative steps to fast procedures (Fitts & Posner 1967; Anderson 1982).
- **Routines.** The wiki's first day is a script: logs → planks → crafting table → wooden pickaxe → stone tools and furnace → food → shelter and bed (*Tutorials/Beginner's guide*).
- **Preparation and bulk.** Mining guides list what to bring: food, two stacks of wood, torches, a weapon, two water buckets. They say where to dig (Y −59 to −54 for diamonds) and how far apart to space branch tunnels (3 for general mining, 6 for diamond efficiency) (*Tutorials/Mining*; *Diamond Ore*).
- **Projection.** The top level of situation awareness is projecting the near future (Endsley 1995): dark in four minutes, the creeper's path.
- **Opportunism and multitasking.** People planning errands jump between levels of abstraction and seize opportunities as they arise (Hayes-Roth & Hayes-Roth 1979). Multitasking interleaves goal threads on one serial procedural resource (Salvucci & Taatgen 2008), like mining the coal passed on the way to the iron.
- **Recognition first.** Experts generate one workable option from a recognised pattern (Klein 1993).

### 2.4 What players do when stuck

Iacovides et al. (2014) coded eight strategies players used to get past breakdowns:

1. trial and error, including pausing to check external resources;
2. experiment;
3. repetition;
4. stop & think;
5. take the hint;
6. knowledge exchange (cooperative play only);
7. guidance (cooperative play only);
8. handing control to the other player (cooperative play only).

Stop & think "tended to occur after repeated breakdowns and the failure of other strategies". Related findings:

- **Re-represent the problem.** Insight after an impasse comes from re-encoding the problem or relaxing a self-imposed constraint (Ohlsson 1992): "I need wool" becomes "I need a bed".
- **Leave depleted patches.** Leave a patch when its rate of return falls to the average rate elsewhere (Charnov 1976). The same logic applies to searching for information (Pirolli & Card 1999).
- **Give up by odds and cost.** Faced with unsolvable water-jar problems, people persisted longer when solvability was more likely and the problem space larger. "Giving-up decisions are informed by the same judgments of probability of success and costs of solution that inform move-choice" (Payne & Duggan 2011). Felt effort tracks opportunity cost (Kurzban et al. 2013). The trap is sunk cost (Arkes & Blumer 1985).
- **Re-engage.** People who can let go of unattainable goals and take up others fare better (Wrosch et al. 2003).

§5.3 works through the wool case this way.

### 2.5 How players spot the abnormal

Three kinds of expectation do the noticing:

- **Physical.** Unsupported things fall and solids don't pass through each other (Baillargeon, Spelke & Wasserman 1985; Needham & Baillargeon 1993). Adults judge scenes by running an approximate mental simulation of the physics (Battaglia, Hamrick & Tenenbaum 2013).
- **Psychological.** People expect agents to act efficiently given what they know (Gergely & Csibra 2003), and infer goals by inverting that expectation (Baker, Saxe & Tenenbaum 2009). An x-ray user is suspicious because he acts on knowledge he cannot have. The X-Ray Detective author estimates one diamond per ~300 blocks mined for an ordinary player and one per ~30 with x-ray. His planned (not yet implemented) checks are tell-tale: steep tunnels straight to ore, mining only exposed ore, stopping right after finding it, and no torches.
- **Statistical.** What is normal here and for this person is learned by exposure. In Sokolov's account, the nervous system models repeated stimuli: a mismatch triggers orienting, a match habituates (Sokolov 1963).

Noticing is not accusing. In a study grading aimbot clips, experienced reviewers flagged cheating only when it was "exceptionally evident", knowing legitimate players can look inhumanly skilled. FPS players flagged every strong-aimbot clip (Kanervisto et al. 2022).

---

## 3. Mechanisms worth emulating (question B)

| Mechanism | What the research says | How to apply it here |
|---|---|---|
| **Predictive processing, violation of expectation, surprise** | Perception minimises prediction error (Clark 2013; Friston 2010). Surprise attracts gaze (Itti & Baldi 2009). Prediction-error spikes mark event boundaries, which gate attention and memory (Zacks et al. 2007). Mismatch triggers orienting; repetition habituates (Sokolov 1963). Violations drive exploration (Stahl & Feigenson 2015). | An **expectation engine** in perception predicts each entity's and process's next state. Surprise is the confidence-weighted mismatch. It wakes the CC, is stored as important, and fades by habituation. |
| **Curiosity and novelty** | Curiosity is a response to information gaps (Loewenstein 1994). Information-seeking follows expected learning (Gottlieb et al. 2013; Kidd & Hayden 2015). Prediction-error curiosity (Pathak et al. 2017) breaks down in stochastic settings (Burda et al. 2018). | A **curiosity drive** in goal generation: investigate violations, unseen places and unknown mechanics. Score by expected information gain about what matters, not by raw unpredictability. |
| **Schemas and scripts** | Stereotyped event sequences with slots and defaults support understanding and prediction, and make deviations stand out (Schank & Abelson 1977). | **Scripts** for the agent's routines (day one, mining trip, night, trade) and for others' activities. They serve as fast plans and as expectation sources. |
| **Dual-process control** | Contention scheduling runs routines. A supervisory system steps in for planning, novelty, danger, errors and overriding habit (Norman & Shallice 1986; Shallice & Burgess 1996). Rasmussen (1983) separates skill-, rule- and knowledge-based levels. Control is arbitrated by relative uncertainty (Daw, Niv & Dayan 2005). An LLM-agent analogue is SwiftSage (Lin et al. 2023). | Skills, routines and reflexes run by default. The CC is the supervisory system, woken by surprise, impasse, danger, intention end or a social bid, not by a timer. |
| **Skill acquisition and chunking** | Declarative knowledge compiles into procedures (Anderson 1982; Taatgen & Lee 2003; ACT-R: Anderson et al. 2004). Practice follows a power law (Newell & Rosenbloom 1981). Soar has tie, conflict, constraint-failure and no-change impasses; each creates a substate, and the resolution is compiled into a chunk (Soar Manual; Laird et al. 1986, 1987). | Classify failures as impasse types and resolve them by deliberation. Store the resolution as a conditioned rule or a routine. The L3 skill writer is the procedural memory. |
| **Means–ends analysis** | Reduce the state–goal difference with operators whose preconditions become subgoals (Newell & Simon 1972). | Extend `obtain` from recipes to every acquisition operator (shear, breed, trade, loot, barter, fish, mob drop), each with preconditions and cost. |
| **Metacognition and quitting** | People monitor and control their own thinking (Nelson & Narens 1990). Effort reflects opportunity cost (Kurzban et al. 2013). Foragers leave a patch whose yield has fallen below the rest of the environment (Charnov 1976); continuing because of past spending is the sunk-cost error (Arkes & Blumer 1985). People give up by odds and cost (Payne & Duggan 2011) and do better if they can disengage and re-engage (Wrosch et al. 2003). If-then plans fire on cue (Gollwitzer 1999). | A **progress monitor** compares the observed rate with the route's expected rate. Stop rules end in an explicit drop, a deferral with a cue, or a request for help. |
| **Affordances** | People perceive what the environment lets them do (Gibson 1979). Game challenge lies in perceiving and using affordances (Linderoth 2013). SayCan grounds LLM plans in affordance values (Ahn et al. 2022). | Label perceived things with what the agent could do with them now, and what that needs. |
| **Situation awareness** | SA has three levels: perceiving elements, comprehending them and projecting their future. It is limited by attention and working memory and helped by mental models and goals (Endsley 1995). | Order the packet and the thinking prompt by these three levels (§5.1–5.2). |
| **Goal reasoning and commitment** | Goal-driven autonomy is a loop of discrepancy detection → explanation → goal formulation → goal management (Molineaux, Klenk & Aha 2010; Aha 2018). Intentions are commitments that limit re-deliberation (Bratman 1987). | Surprises and failures run the GDA loop. Every intention carries its own reconsideration triggers. |

---

## 4. LLM agents in Minecraft and similar worlds (question C)

### 4.1 System by system

| System | What the model observes | Failure handling and verification | Memory and reported results |
|---|---|---|---|
| **Voyager** (Wang et al. 2023) | Unique block names in a 17×5×17 box around the bot. Mob types with their nearest distance within 32 blocks (players and items excluded). Also inventory, equipment, biome, time, vitals, chests, last code, errors and critique (repo files `voxels.js`, `status.js`, `action.py`). The prompt says to explore in a random direction when something isn't found. | Up to 4 code rounds using feedback, errors and critique, then a new task; failed tasks are handed back to the curriculum. A GPT-4 critic judges success from game state; without self-verification, 73% fewer items. | Library of verified JS skills retrieved by embedding. 3.3× unique items, 2.3× distance, milestones up to 15.3× faster. Iterations: wooden 6±2, stone 11±2, iron 21±7, diamond 102 (1 of 3 runs, the only method to get there). |
| **DEPS** (Wang et al. 2023) | A text description of plan-relevant state after each sub-goal. | The **Explainer** names the failed precondition ("mining iron_ore needs to use the tool stone_pickaxe, but my inventory does not have stone_pickaxe") and the plan is fixed. The **Selector** ranks parallel sub-goals by predicted steps (acacia over oak in savanna). | 71 tasks: 48.56% vs 25.77% for the best baseline (39.36% without the selector). ObtainDiamond 0.59%. |
| **GITM** (Zhu et al. 2023) | Rays and voxels for actions. The planner gets inventory plus biome, y-level and whether it is above or below ground. | The Decomposer uses wiki and recipe text to build a sub-goal tree. The Planner gets per-action success, failure and reason, and writes an *explanation* field before re-planning. | Successful action lists stored per sub-goal and summarised after five. ObtainDiamond 67.5% (VPT 20%, DEPS 0.6%). All 262 Overworld items; one 32-core CPU node. |
| **JARVIS-1** (Wang et al. 2023b) | Frames captioned as text ("I can see sheep in the acacia plains") plus symbolic state. | *Self-check* simulates the plan and predicts inventory before acting. *Self-explain* locates the faulty step. 2–3 replanning rounds vs more than 6 for DEPS. | Memory of successful plans keyed by task and state. ObtainDiamondPickaxe 6.22% (20 min), 12.5% (60 min). |
| **Optimus-1** (Li et al. 2024) | Visual input to a multimodal LLM. | A reflector periodically returns COMPLETE, CONTINUE or REPLAN. | A learned "what crafts what" graph from free exploration; an experience pool of successes *and* failures. 22.26% vs 16.89% (JARVIS-1) vs 36.41% (humans). Ablations: −20% without the graph, −12% without the pool. |
| **ODYSSEY** (Liu et al. 2024) | Voyager-style text. | A critic gives execution feedback ("No hoe in inventory. Craft a hoe first!"), checks inventory changes and suggests strategy. | 40 primitive skills (8 spatial) and 183 compositional ones; LLaMA-3 tuned on 390k wiki Q&A. On a zombie task: 8/8 with about 10 LLM iterations vs 67.3 for Voyager. |
| **Plan4MC** (Yuan et al. 2023) | Pixels, with RL skills. | An LLM-made skill graph (consumes, requires, obtains), which had 6 errors in 55 skills. Searched depth-first and re-planned after every skill. | 40 tasks, large gains over baselines. |
| **MP5** (Qin et al. 2024) | **Active perception.** A Patroller asks a Percipient about the view until every task condition is confirmed (a pig *near water*, *at night*). | The Patroller checks every module. Without its checks, wooden-level success fell from 76.67% to 7.33%. | 22% on diamond-level process tasks; 91% on context-dependent tasks. |
| **Mindcraft / MineCollab** (White et al. 2025) | Queries: `!nearbyBlocks` (unique types within 16), `!entities` (counts), `!inventory`, `!craftable`, `!getCraftingPlan`, `!searchWiki`. | 47 commands plus generated code. Coded modes interrupt actions (e.g., "hunting: hunt nearby animals when idle"). | Up to 15% worse when agents must communicate detailed plans; with five agents instead of two, success falls from up to 90% to under 30%. |
| **Project Sid / PIANO** (Altera.AL et al. 2024) | Agent state through the CC bottleneck. | Action awareness (expected vs observed outcomes) improved item progression. | 17 unique items in 30 min on average; top agents 30–40, "comparable to a human player with some Minecraft experience". Main limit: "lack of vision and spatial reasoning"; no drives such as curiosity. |
| **Generative Agents** (Park et al. 2023) | The world as a tree of areas and objects; each agent holds its own subtree, which can go stale. | Re-plans when an observation warrants a reaction. | Retrieval by recency (0.995 decay), importance and relevance. Reflection triggers at summed importance above 150. Plans are broken into 5–15 min chunks. |
| **Reflexion** (Shinn et al. 2023) | Text (ALFWorld). | First-person reflection after a failure, triggered when the same action gets the same response for more than 3 cycles, or after more than 30 actions. | 130/134 ALFWorld tasks. |
| **ExpeL** (Zhao et al. 2024) | Text. | Compares failed and successful attempts at the same task. | Insights edited with ADD, EDIT, UPVOTE and DOWNVOTE, and removed when their count reaches 0. Similar successes retrieved as examples. |

### 4.2 Other results that bear on the redesign

- **Learning from experience.** CLIN keeps causal abstractions (+23 points over Reflexion; Majumder et al. 2023). Agent Workflow Memory induces reusable routines (+24.6% and +51.1% relative; Wang et al. 2024). AutoManual turns experience into a manual of rules (97.4% on ALFWorld; Chen et al. 2024).
- **Knowledge has to be grounded.** SPRING read the game's paper and, with GPT-4, beat RL baselines trained for 1M steps on Crafter (Wu et al. 2023). Plancraft's unsolvable crafting tasks found models "eager to emit impossible when it is available, even when the task is solvable". Recipe search raised impossibility detection from 0.45 to 0.71 F1 (Dagan et al. 2024).
- **Self-checking and noticing.** LLMs struggle to self-correct without external feedback (Huang et al. 2024), and they ignore unexpected findings (Engländer et al. 2026).
- **Spatial text.** LLMs struggle "with frames of reference relative to an embodied agent and identifying 3D shapes from coordinate lists" (Sidhu & Hockenmaier 2026). Robot planners give LLMs object-centric scene graphs with relations (SayPlan: Rana et al. 2023; ConceptGraphs: Gu et al. 2023).
- **Novelty detection.** In a Minecraft-like dataset, simple detectors could beat leaders on standard scores when false positives matter, and combining symbolic with visual data sped detection (NovelCraft; Feeney et al. 2023).
- **Cost and latency.**
  - Closed-loop language feedback helps embodied agents (Inner Monologue; Huang et al. 2022), and interleaving reasoning with acting is the standard agent loop (ReAct; Yao et al. 2023).
  - Comparing several reasoning paths helps planning (Tree of Thoughts; Yao et al. 2023b).
  - Lyfe's option-action framework cut cost 10–100× (Kaiya et al. 2023).
  - Pairing fast reflexes with asynchronous reflection handles LLM latency (Zheng et al. 2025).
- **Social learning.** MindForge adds theory of mind and dialogue to Voyager-style agents and reports expert-to-novice knowledge transfer (Lică et al. 2024).

### 4.3 Cross-cutting lessons

1. **Text observations work, but nobody gives a relational scene.** Only MP5's question-asking perceives relations. Sid calls spatial reasoning its primary limit, and LLMs are weak at coordinates and egocentric frames. **Code should compute relations and describe them in words.**
2. **Explain before re-planning, but the alternatives come from structured knowledge:** GITM's wiki-backed decomposer, Optimus-1's graph, Plan4MC's skill graph. Without that knowledge an explanation is just "no sheep".
3. **Verify against game state, not opinion:** Voyager's critic (−73% without it), MP5's checks (76.67% → 7.33% without them), and Huang et al.
4. **Remember successes and failures:** GITM, JARVIS-1, Optimus-1, ExpeL, CLIN, AWM, Voyager.
5. **Bound persistence, and ground the decision to quit:** Voyager's 4 rounds and Reflexion's repetition trigger, versus Plancraft's premature quitting.
6. **Efficiency comes from selection and commitment:** the DEPS selector, Lyfe's option-action framework, and fewer replanning rounds (JARVIS-1, ODYSSEY).
7. **None of these systems models what is normal for others or the world.** Anomaly detection is open ground.

---

## 5. Design recommendations for this architecture (question D)

### 5.1 A complete scene, computed by code and told in words

(inference, on Endsley's levels and the scene-graph and Mindcraft precedents)

- **Frame.** Egocentric (ahead, left, behind) plus compass bearings. Distances in blocks, heights relative to the agent, and the age of each item.
- **What is visible.** Raycast-visible blocks and entities (existing `canSeeBlock` and `Sightings`), plus a hearing radius.
- **Features, not blocks.** Cluster visible blocks into named features (tree groups, ore seams, bare stone, water, caves, cliffs, buildings, farms, paths) with extent, count, direction and distance.
- **Entities as individuals with state.**
  - For all: kind, count, variant (colour, baby, sheared), activity, held and worn items.
  - For players, also: movement mode (walking, sprinting, sneaking, swimming, gliding, falling, unsupported), speed, and what they are doing to the world.
- **Relations.** *On, inside, next to, between, behind (hidden), along, facing*; and relative to the agent: in reach, reachable, path length.
- **Affordances.** What the agent could do with each thing now, and what that needs.
- **Changes since the last look.** Generalise `SurroundingsWatch` to entities as well as blocks.
- **Remembered places out of view**, with direction, distance and age.
- **Surprises, placed first** (§5.5).
- **An attention budget.** Rank by goal relevance, threat, surprise and social salience; summarise the rest; let the CC ask for more (`look {at}`), as in MP5 and Mindcraft.

Example packet:

```
Where you are: open plains by a river, daytime (dark in about 6 min), standing on grass, facing north.
Surprising:
- Bram, 22 m north-east and 7 m above the grass, has had nothing under him for 6 s and is moving
  west at about 11 m/s. People fall unless they glide with an elytra, and he wears none.
In view, by what matters to you now:
- 2 sheep, already sheared, grazing in the fenced pen beside the farmhouse, 14 m south-west.
  You could breed them (needs wheat); sheared sheep grow wool back after eating grass.
- Mira, 9 m east, walking toward the village with 12 oak logs (she was chopping in the grove).
- Oak grove 20-35 m north (about 30 logs in sight).
- Bare stone in the hillside 30 m west with 4 coal ore showing; a cave opening below it.
Remembered, out of view:
- A herd of 5 sheep in the meadow about 140 m south-east (seen yesterday).
- 6 iron ingots in the village chest, 40 m east.
Since you last looked: the 3 sheep you killed are gone; Mira has felled 4 trees in the grove.
```

### 5.2 A thinking prompt instead of a rulebook

- **Replace directive rules with knowledge looked up for the situation** ("What you know about getting wool …"), as GITM, SPRING and Mindcraft's `!searchWiki` do. Keep only real constraints (permadeath, content rules) as rules.
- **Telling the model it is an experienced player is not enough.** Version-specific facts should be retrieved, because grounding is what made impossibility judgments reliable in Plancraft. (The working tree's new `EXPERIENCE` text asserts this knowledge; retrieval would ground it.)
- **Personality sets priorities, not instructions.**
- **Ask for a short first-person monologue in situation-awareness order** (Inner Monologue, ReAct). Have it start from what the agent would normally do (Klein) and consider a few genuinely different options (Tree of Thoughts in miniature):

```
Think it through as yourself, briefly, in this order:
1. What is going on, and what does it mean for you?
2. Did anything surprise you? What might explain it? Does it matter to you?
3. What happens in the next few minutes if you carry on as you are?
4. What are you trying to do, and what is it for?
5. How could you get there? Start from what you would normally do, then name other ways you know.
   For each: what it needs first, about how long, how likely it is to work, what could go wrong.
6. Choose. Say what you will do, how you will know it worked, what you expect to see on the way,
   and what would make you stop and think again.
```

- **Output:** the `Decision` plus an `intention` (`steps, successTest, expect[], reconsiderIf[], budgetSeconds`), a `noticed` note and an optional `lesson`. Code checks `expect` and `reconsiderIf` during execution; that generalises Action Awareness.

### 5.3 Impasses: explain, look for other ways, or let go

1. **Detect (code).** Watch for these impasse types:
   - no progress at the expected rate (operator no-change);
   - no route at all (state no-change);
   - equally good options (tie);
   - clashing goals (conflict);
   - an unmet precondition (constraint failure);
   - repetition (the same action and result 3 times, as in Reflexion);
   - a blown budget (Voyager's 4 rounds).
2. **Explain (LLM, one sentence)** in precondition terms, as DEPS and GITM do: "no sheep within 32 blocks; I killed the three that were here".
3. **Generate alternatives, code first:**
   - a **source graph** from minecraft-data (`recipes`, `blockLoot`, `entityLoot`) plus curated wiki facts (shearing, breeding, trades, structure loot, bartering, fishing, gifts);
   - goal regression ("what is it for?");
   - search guided by map memory, rather than Voyager's random direction;
   - asking or trading with people;
   - deferring with a cue.
4. **Choose** by expected value per minute, including opportunity cost (Kurzban; Charnov). Prefer routes that keep renewable sources.
5. **Give up explicitly** when nothing has positive value within budget:
   - tell whoever asked;
   - set cue-triggered intentions (Gollwitzer; the working tree's `later` field is one);
   - write a lesson.

   Offer "give up" only after the source graph has been checked (Plancraft).
6. **Compile** the resolution into a rule or routine, the way Soar chunks a resolved impasse.

Wool from the example scene (inference, from wiki facts):

| Route | Needs first | From here | Keeps the sheep? |
|---|---|---|---|
| Shear the herd 140 m SE | shears (2 iron, in the chest 40 m E) | a few minutes; 5 sheep × 1–3 wool | yes |
| Breed the pen pair, shear later | wheat; wool regrows after grazing | slow (lambs take 20 min to grow) | yes |
| Craft from string | 4 string per wool (spiders, cobwebs) | night or a mineshaft; risky | — |
| Buy from a shepherd | a shepherd villager, emeralds | depends on the village | — |
| Take a village bed (if the wool was for a bed) | a village | depends on distance | — |

### 5.4 Learning from experience

- **Episodes.** Store (situation, goal, plan, outcome, explanation) for successes and failures, as Optimus-1, JARVIS-1 and GITM do. Retrieve by goal and situation.
- **Lessons.** Short causal statements with evidence counts and scope, maintained with ADD/EDIT/UPVOTE/DOWNVOTE (ExpeL; CLIN; AutoManual). Run this as an experience pass in `reflection.ts`, triggered by accumulated importance (Generative Agents) or by a failure (Reflexion).
- **Routines.** Induce them from repeated successful sequences (AWM; production compilation) and pass them to `skillWriter.ts`. They become the defaults the agent reaches for first.
- **Norms.** Keep running statistics per entity kind, place and person: speeds, heights, activities, hours, items. These are the learned half of the expectation engine.
- **Social learning.** Watch who succeeds (Wu et al. 2025), ask, and share lessons in conversation (MindForge), tagged with their source under the existing rumor rules.

### 5.5 One general anomaly detector

| Channel | What code predicts | Example violation |
|---|---|---|
| Motion of each entity | Unsupported bodies fall; speeds stay within the movement mode's limits | hovering; 11 m/s with no elytra; teleporting; passing through blocks |
| Block changes | Every change has a cause: digging in reach for the dig time, an explosion, fire, growth | a block vanishes with nobody near; instant breaking |
| Item flows | Items come from drops, chests, crafting or trades | someone suddenly holds 64 diamonds |
| Others' knowledge | Actions fit what the actor could know (Gergely & Csibra; Baker et al.) | tunnelling straight to unseen ore |
| Base rates | Learned per kind, place and person | a villager far from home at night; a friend not back by dark |
| Claims | Speech matches what was seen | "I gave you 5 iron", with no transfer |
| Own actions | Postconditions (Action Awareness) | dug, but nothing dropped |

**How it works:**

1. Code emits `{what, expected, observed, confidence, candidate explanations}` as a sentence (the Bram line in §5.1).
2. The LLM runs the GDA loop: explain (creative mode or op, cheat, lag, misperception), judge whether it matters, act (watch, ask, tell others, ignore) and update its beliefs.
3. Code habituates per (subject, feature) and suppresses surprises about unlearnable noise (Burda et al.).
4. Code keeps "noticed" separate from "concluded" (Kanervisto et al.).

(inference, from local code) mineflayer tracks other entities' `elytraFlying` flag from metadata but keeps no `onGround` for them, so support must be checked against the blocks below each entity.

### 5.6 Fluent play

- **Intentions with commitment.** Multi-step intentions carry success tests, expectations and reconsideration triggers. Skills run them without LLM calls (Bratman; Kinny & Georgeff; Lyfe). The working tree's `then` field is a start.
- **Event-driven thinking.** The CC wakes on surprise, impasse, danger, intention end or a social bid (the supervisory-system conditions, event boundaries), not on a timer.
- **Think while acting.** Plan the next intention while the current one runs (PIANO concurrency, threaded cognition), with reflexes ahead of reflection (Zheng et al. 2025).
- **Routines as defaults:** day one, mining trip, night, farm round.
- **Opportunism and anticipation.**
  - Take cheap detours for useful things on the way (Mindcraft's `item_collecting` is a crude precedent).
  - Gather in bulk for the plan horizon.
  - Use preparation checklists from the knowledge base.
  - Pick among parallel subgoals by expected time (the DEPS selector).
  - Pre-check plans by simulating the inventory (JARVIS-1).

### 5.7 Where this lands in the code (inference)

- `perception/*` and `body/sightings.ts` → scene builder plus expectation engine.
- `modules/bottleneck.ts` → scene, surprises, intention status, knowledge and lessons.
- `modules/prompts.ts` → knowledge entries, persona priorities and the §5.2 scaffold.
- Action Awareness's "stuck after 3 failures" (DESIGN §4.6) → the §5.3 handler.
- `body/skills/planner.ts` → the full source graph.
- `reflection.ts` and `skillWriter.ts` → lessons and routines.
- The hub controller's pushes should become rare.

### 5.8 How to tell it worked

- **Wool scarcity.** Herd 150 m away, spiders at night, a village 300 m away. The agent should name at least 3 routes, pick a cheap or non-destructive one, and finish or give up within budget, saying why.
- **Creative flyer.** Agents should notice within seconds, comment or ask, and remember. Elytra glides should stop raising alarms once agents are used to them.
- **X-ray miner (scripted).** Suspicion should grow with evidence; one lucky find should not produce an accusation.
- **Fluency.** Time to stone tools, iron tools and a bed against VPT, MineRL and Optimus-1 baselines. Also track LLM calls per game hour, idle seconds between intentions, and the share of intentions that end in success vs impasse.

---

## 6. References

**Minecraft players, game knowledge and anomaly detection**
- Baker, B. et al. (2022). Video PreTraining (VPT): Learning to act by watching unlabeled online videos. https://arxiv.org/abs/2206.11795
- Bebbington, S. & Vellino, A. (2015). Can playing Minecraft improve teenagers' information literacy? *Journal of Information Literacy* 9(2). https://doi.org/10.11645/9.2.2029
- Clemenson, G. D., Henningfield, C. M. & Stark, C. E. L. (2019). Improving hippocampal memory through the experience of a rich Minecraft environment. *Frontiers in Behavioral Neuroscience* 13. https://doi.org/10.3389/fnbeh.2019.00057
- Esclamado, M. A. & Rodrigo, M. M. T. (2022). Are all who wander lost? An exploratory analysis of learner traversals of Minecraft worlds. AIED 2022, LNCS. https://doi.org/10.1007/978-3-031-11647-6_48
- Fan, L. et al. (2022). MineDojo: Building open-ended embodied agents with internet-scale knowledge. https://arxiv.org/abs/2206.08853 ; corpus figures: https://minedojo.org/
- Gee, J. P. (2003). *What Video Games Have to Teach Us About Learning and Literacy*. Palgrave Macmillan.
- Grim Anticheat, README. https://github.com/GrimAnticheat/Grim
- Guss, W. H. et al. (2019). MineRL: A large-scale dataset of Minecraft demonstrations. IJCAI. https://arxiv.org/abs/1907.13440
- Hong, J.-C. & Liu, M.-C. (2003). A study on thinking strategy between experts and novices of computer games. *Computers in Human Behavior* 19(2), 245–258. https://doi.org/10.1016/S0747-5632(02)00013-4
- Iacovides, I., Cox, A. L., Avakian, A. & Knoll, T. (2014). Player strategies: Achieving breakthroughs and progressing in single-player and cooperative games. CHI PLAY '14, 131–140. https://doi.org/10.1145/2658537.2658697 (open copy: https://eprints.whiterose.ac.uk/130587/)
- Kanervisto, A., Kinnunen, T. & Hautamäki, V. (2022). GAN-Aimbots: Using machine learning for cheating in first person shooters. IEEE Transactions on Games. https://arxiv.org/abs/2205.07060
- Minecraft Wiki (accessed 2026-10-24): Wool https://minecraft.wiki/w/Wool · Sheep https://minecraft.wiki/w/Sheep · String https://minecraft.wiki/w/String · Bed https://minecraft.wiki/w/Bed · Transportation https://minecraft.wiki/w/Transportation · Server.properties https://minecraft.wiki/w/Server.properties · Recipe book https://minecraft.wiki/w/Recipe_book · Tutorials/Mining https://minecraft.wiki/w/Tutorials/Mining · Diamond Ore https://minecraft.wiki/w/Diamond_Ore · Tutorials/Beginner's guide https://minecraft.wiki/w/Tutorials/Beginner%27s_guide
- Thompson, J. J., Blair, M. R., Chen, L. & Henrey, A. J. (2013). Video game telemetry as a critical tool in the study of complex skill learning. *PLoS ONE* 8(9): e75129. https://doi.org/10.1371/journal.pone.0075129
- Walker, J., Slater, S. & Kafai, Y. (2019). A scaled analysis of how Minecraft gamers leverage YouTube comment boxes to participate and collaborate. CSCL 2019, 440–447. https://repository.isls.org/bitstream/1/4437/1/440-447.pdf
- Watson, N. (2017). Procedural elaboration: How players decode Minecraft. *Loading…* 10(16), 75–86. https://loading.journals.publicknowledgeproject.org/index.php/loading/article/view/181
- Wu, C. M., Deffner, D., Kahl, B., Meder, B., Ho, M. K. & Kurvers, R. H. J. M. (2025). Adaptive mechanisms of social and asocial learning in immersive collective foraging. *Nature Communications* 16. https://doi.org/10.1038/s41467-025-58365-6
- X-Ray Detective (Bukkit plugin page). https://www.curseforge.com/minecraft/bukkit-plugins/x-ray-detective

**Cognitive science**
- Aha, D. W. (2018). Goal reasoning: Foundations, emerging applications, and prospects. *AI Magazine* 39(2), 3–24. https://doi.org/10.1609/aimag.v39i2.2800
- Allen, K. R., Smith, K. A. & Tenenbaum, J. B. (2020). Rapid trial-and-error learning with simulation supports flexible tool use and physical reasoning. *PNAS* 117(47). https://doi.org/10.1073/pnas.1912341117
- Anderson, J. R. (1982). Acquisition of cognitive skill. *Psychological Review* 89(4), 369–406. https://doi.org/10.1037/0033-295X.89.4.369
- Anderson, J. R. et al. (2004). An integrated theory of the mind. *Psychological Review* 111(4), 1036–1060. https://doi.org/10.1037/0033-295X.111.4.1036
- Arkes, H. R. & Blumer, C. (1985). The psychology of sunk cost. *OBHDP* 35(1), 124–140. https://doi.org/10.1016/0749-5978(85)90049-4
- Baillargeon, R., Spelke, E. S. & Wasserman, S. (1985). Object permanence in five-month-old infants. *Cognition* 20(3), 191–208. https://doi.org/10.1016/0010-0277(85)90008-3
- Baker, C. L., Saxe, R. & Tenenbaum, J. B. (2009). Action understanding as inverse planning. *Cognition* 113(3), 329–349. https://doi.org/10.1016/j.cognition.2009.07.005
- Battaglia, P. W., Hamrick, J. B. & Tenenbaum, J. B. (2013). Simulation as an engine of physical scene understanding. *PNAS* 110(45). https://doi.org/10.1073/pnas.1306572110
- Bratman, M. E. (1987). *Intention, Plans, and Practical Reason*. Harvard University Press.
- Charnov, E. L. (1976). Optimal foraging, the marginal value theorem. *Theoretical Population Biology* 9(2), 129–136. https://doi.org/10.1016/0040-5809(76)90040-X
- Chase, W. G. & Simon, H. A. (1973). Perception in chess. *Cognitive Psychology* 4(1), 55–81. https://doi.org/10.1016/0010-0285(73)90004-2
- Clark, A. (2013). Whatever next? Predictive brains, situated agents, and the future of cognitive science. *BBS* 36(3), 181–204. https://doi.org/10.1017/S0140525X12000477
- Daw, N. D., Niv, Y. & Dayan, P. (2005). Uncertainty-based competition between prefrontal and dorsolateral striatal systems for behavioral control. *Nature Neuroscience* 8, 1704–1711. https://doi.org/10.1038/nn1560
- Dubey, R., Agrawal, P., Pathak, D., Griffiths, T. L. & Efros, A. A. (2018). Investigating human priors for playing video games. ICML. https://arxiv.org/abs/1802.10217
- Endsley, M. R. (1995). Toward a theory of situation awareness in dynamic systems. *Human Factors* 37(1), 32–64. https://doi.org/10.1518/001872095779049543
- Fitts, P. M. & Posner, M. I. (1967). *Human Performance*. Brooks/Cole.
- Friston, K. (2010). The free-energy principle: A unified brain theory? *Nature Reviews Neuroscience* 11, 127–138. https://doi.org/10.1038/nrn2787
- Georgeff, M., Pell, B., Pollack, M., Tambe, M. & Wooldridge, M. (1999). The belief-desire-intention model of agency. ATAL-98. https://www.cs.huji.ac.il/course/2003/imas/readings/atal98b.pdf
- Gergely, G. & Csibra, G. (2003). Teleological reasoning in infancy: The naïve theory of rational action. *TiCS* 7(7), 287–292. https://doi.org/10.1016/S1364-6613(03)00128-1
- Gibson, J. J. (1979). *The Ecological Approach to Visual Perception*. Houghton Mifflin.
- Gollwitzer, P. M. (1999). Implementation intentions: Strong effects of simple plans. *American Psychologist* 54(7), 493–503. https://doi.org/10.1037/0003-066X.54.7.493
- Gottlieb, J., Oudeyer, P.-Y., Lopes, M. & Baranes, A. (2013). Information-seeking, curiosity, and attention. *TiCS* 17(11), 585–593. https://doi.org/10.1016/j.tics.2013.09.001
- Hayes-Roth, B. & Hayes-Roth, F. (1979). A cognitive model of planning. *Cognitive Science* 3(4), 275–310. https://doi.org/10.1207/s15516709cog0304_1
- Itti, L. & Baldi, P. (2009). Bayesian surprise attracts human attention. *Vision Research* 49(10), 1295–1306. https://doi.org/10.1016/j.visres.2008.09.007
- Kidd, C. & Hayden, B. Y. (2015). The psychology and neuroscience of curiosity. *Neuron* 88(3), 449–460. https://doi.org/10.1016/j.neuron.2015.09.010
- Kinny, D. & Georgeff, M. (1991). Commitment and effectiveness of situated agents. IJCAI-91, 82–88. https://mlanthology.org/ijcai/1991/kinny1991ijcai-commitment
- Klein, G. A. (1993). A recognition-primed decision (RPD) model of rapid decision making. In Klein, Orasanu, Calderwood & Zsambok (Eds.), *Decision Making in Action*, 138–147. Ablex.
- Kurzban, R., Duckworth, A., Kable, J. W. & Myers, J. (2013). An opportunity cost model of subjective effort and task performance. *BBS* 36(6). https://doi.org/10.1017/S0140525X12003196
- Laird, J. E., Rosenbloom, P. S. & Newell, A. (1986). Chunking in Soar: The anatomy of a general learning mechanism. *Machine Learning* 1, 11–46. https://doi.org/10.1007/BF00116249
- Laird, J. E., Newell, A. & Rosenbloom, P. S. (1987). SOAR: An architecture for general intelligence. *Artificial Intelligence* 33(1), 1–64. https://doi.org/10.1016/0004-3702(87)90050-6
- Lake, B. M., Ullman, T. D., Tenenbaum, J. B. & Gershman, S. J. (2017). Building machines that learn and think like people. *BBS* 40, e253. https://doi.org/10.1017/S0140525X16001837
- Linderoth, J. (2013). Beyond the digital divide: An ecological approach to gameplay. *ToDiGRA* 1(1). https://doi.org/10.26503/todigra.v1i1.9
- Loewenstein, G. (1994). The psychology of curiosity: A review and reinterpretation. *Psychological Bulletin* 116(1), 75–98. https://doi.org/10.1037/0033-2909.116.1.75
- Molineaux, M., Klenk, M. & Aha, D. W. (2010). Goal-driven autonomy in a Navy strategy simulation. AAAI-10, 1548–1554. https://doi.org/10.1609/aaai.v24i1.7576
- Needham, A. & Baillargeon, R. (1993). Intuitions about support in 4.5-month-old infants. *Cognition* 47(2), 121–148. https://doi.org/10.1016/0010-0277(93)90002-D
- Nelson, T. O. & Narens, L. (1990). Metamemory: A theoretical framework and new findings. *Psychology of Learning and Motivation* 26, 125–173. https://doi.org/10.1016/S0079-7421(08)60053-5
- Newell, A. & Rosenbloom, P. S. (1981). Mechanisms of skill acquisition and the law of practice. In J. R. Anderson (Ed.), *Cognitive Skills and Their Acquisition*. Erlbaum.
- Newell, A. & Simon, H. A. (1972). *Human Problem Solving*. Prentice-Hall.
- Norman, D. A. & Shallice, T. (1986). Attention to action: Willed and automatic control of behavior. In Davidson, Schwartz & Shapiro (Eds.), *Consciousness and Self-Regulation* 4, 1–18. Plenum.
- Ohlsson, S. (1992). Information-processing explanations of insight and related phenomena. In Keane & Gilhooly (Eds.), *Advances in the Psychology of Thinking*, 1–44. Harvester Wheatsheaf.
- Payne, S. J. & Duggan, G. B. (2011). Giving up problem solving. *Memory & Cognition* 39(5), 902–913. https://doi.org/10.3758/s13421-010-0068-6
- Pirolli, P. & Card, S. (1999). Information foraging. *Psychological Review* 106(4), 643–675. https://doi.org/10.1037/0033-295X.106.4.643
- Rasmussen, J. (1983). Skills, rules, and knowledge; signals, signs, and symbols. *IEEE Trans. SMC* 13(3), 257–266. https://doi.org/10.1109/TSMC.1983.6313160
- Salvucci, D. D. & Taatgen, N. A. (2008). Threaded cognition. *Psychological Review* 115(1), 101–130. https://doi.org/10.1037/0033-295X.115.1.101
- Schank, R. C. & Abelson, R. P. (1977). *Scripts, Plans, Goals and Understanding*. Erlbaum.
- Shallice, T. & Burgess, P. (1996). The domain of supervisory processes and temporal organization of behaviour. *Phil. Trans. R. Soc. B* 351, 1405–1412. https://doi.org/10.1098/rstb.1996.0124
- Soar Manual, ch. 2 "The Soar Architecture" (impasses, substates, chunking). https://soar.eecs.umich.edu/soar_manual/02_TheSoarArchitecture/
- Sokolov, E. N. (1963). Higher nervous functions: The orienting reflex. *Annual Review of Physiology* 25, 545–580. https://doi.org/10.1146/annurev.ph.25.030163.002553
- Stahl, A. E. & Feigenson, L. (2015). Observing the unexpected enhances infants' learning and exploration. *Science* 348(6230), 91–94. https://doi.org/10.1126/science.aaa3799
- Taatgen, N. A. & Lee, F. J. (2003). Production compilation. *Human Factors* 45(1), 61–76. https://doi.org/10.1518/hfes.45.1.61.27224
- Tsividis, P. A. et al. (2021). Human-level reinforcement learning through theory-based modeling, exploration, and planning. https://arxiv.org/abs/2107.12544
- Wrosch, C., Scheier, M. F., Miller, G. E., Schulz, R. & Carver, C. S. (2003). Adaptive self-regulation of unattainable goals. *PSPB* 29(12), 1494–1508. https://doi.org/10.1177/0146167203256921
- Zacks, J. M. et al. (2007). Event perception: A mind-brain perspective. *Psychological Bulletin* 133(2), 273–293. https://doi.org/10.1037/0033-2909.133.2.273

**LLM and embodied agents**
- Ahn, M. et al. (2022). Do As I Can, Not As I Say: Grounding language in robotic affordances (SayCan). https://arxiv.org/abs/2204.01691
- Altera.AL et al. (2024). Project Sid: Many-agent simulations toward AI civilization. https://arxiv.org/abs/2411.00114
- Burda, Y. et al. (2018). Large-scale study of curiosity-driven learning. https://arxiv.org/abs/1808.04355
- Chen, M. et al. (2024). AutoManual. NeurIPS. https://arxiv.org/abs/2405.16247
- Dagan, G., Keller, F. & Lascarides, A. (2024). Plancraft: An evaluation dataset for planning with LLM agents. https://arxiv.org/abs/2412.21033
- Engländer, L. et al. (2026). Agents explore but agents ignore: LLMs lack environmental curiosity. https://arxiv.org/abs/2604.17609
- Feeney, P. et al. (2023). NovelCraft: A dataset for novelty detection and discovery in open worlds. TMLR. https://arxiv.org/abs/2206.11736
- Gu, Q. et al. (2023). ConceptGraphs. https://arxiv.org/abs/2309.16650
- Hafner, D. et al. (2023). Mastering diverse domains through world models (DreamerV3). https://arxiv.org/abs/2301.04104
- Huang, J. et al. (2024). Large language models cannot self-correct reasoning yet. ICLR. https://arxiv.org/abs/2310.01798
- Huang, W. et al. (2022). Inner Monologue: Embodied reasoning through planning with language models. https://arxiv.org/abs/2207.05608
- Kaiya, Z. et al. (2023). Lyfe Agents. https://arxiv.org/abs/2310.02172
- Li, Z. et al. (2024). Optimus-1: Hybrid multimodal memory empowered agents excel in long-horizon tasks. NeurIPS. https://arxiv.org/abs/2408.03615
- Lică, M. et al. (2024). MindForge. https://arxiv.org/abs/2411.12977
- Lin, B. Y. et al. (2023). SwiftSage. NeurIPS. https://arxiv.org/abs/2305.17390
- Liu, S. et al. (2024). Odyssey: Empowering Minecraft agents with open-world skills. https://arxiv.org/abs/2407.15325
- Majumder, B. P. et al. (2023). CLIN: A continually learning language agent. https://arxiv.org/abs/2310.10134
- Mindcraft repository (`src/agent/commands/queries.js`, `src/agent/modes.js`, `src/agent/library/world.js`). https://github.com/kolbytn/mindcraft
- Park, J. S. et al. (2023). Generative Agents: Interactive simulacra of human behavior. UIST '23. https://arxiv.org/abs/2304.03442
- Pathak, D. et al. (2017). Curiosity-driven exploration by self-supervised prediction. ICML. https://arxiv.org/abs/1705.05363
- Qin, Y. et al. (2024). MP5: A multi-modal open-ended embodied system in Minecraft via active perception. CVPR. https://arxiv.org/abs/2312.07472
- Rana, K. et al. (2023). SayPlan. CoRL. https://arxiv.org/abs/2307.06135
- Shinn, N. et al. (2023). Reflexion: Language agents with verbal reinforcement learning. https://arxiv.org/abs/2303.11366
- Sidhu, R. & Hockenmaier, J. (2026). Grid Spatial Understanding (GSU). https://arxiv.org/abs/2603.17333
- Sumers, T. R., Yao, S., Narasimhan, K. & Griffiths, T. L. (2024). Cognitive architectures for language agents (CoALA). TMLR. https://arxiv.org/abs/2309.02427
- Wang, G. et al. (2023). Voyager: An open-ended embodied agent with large language models. https://arxiv.org/abs/2305.16291 ; code and prompts: https://github.com/MineDojo/Voyager
- Wang, Z. et al. (2023). Describe, Explain, Plan and Select (DEPS). NeurIPS. https://arxiv.org/abs/2302.01560
- Wang, Z. et al. (2023b). JARVIS-1. https://arxiv.org/abs/2311.05997
- Wang, Z. Z., Mao, J., Fried, D. & Neubig, G. (2024). Agent Workflow Memory. https://arxiv.org/abs/2409.07429
- White, I. et al. (2025). Collaborating action by action: A multi-agent LLM framework for embodied reasoning (MINDcraft, MineCollab). https://arxiv.org/abs/2504.17950
- Wu, Y. et al. (2023). SPRING: Studying the paper and reasoning to play games. https://arxiv.org/abs/2305.15486
- Yao, S. et al. (2023). ReAct. ICLR. https://arxiv.org/abs/2210.03629
- Yao, S. et al. (2023b). Tree of Thoughts. NeurIPS. https://arxiv.org/abs/2305.10601
- Yuan, H. et al. (2023). Skill reinforcement learning and planning for open-world long-horizon tasks (Plan4MC). https://arxiv.org/abs/2303.16563
- Zhao, A. et al. (2024). ExpeL: LLM agents are experiential learners. AAAI. https://arxiv.org/abs/2308.10144
- Zheng, Y. et al. (2025). Reflex first, reflect later: Latency-aware embodied LLM agents. https://arxiv.org/abs/2506.07223
- Zhu, X. et al. (2023). Ghost in the Minecraft (GITM). https://arxiv.org/abs/2305.17144
