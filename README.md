# minecraft-simulation-llmstacked

Layered, social, autonomous Minecraft agents, built from [`DESIGN.md`](DESIGN.md) (PIANO-style concurrent
modules, a Cognitive Controller with an information bottleneck, proximity-chat-only communication, and a
NanoGPT subscription lock). Bots and human players are indistinguishable to the agents: everything an agent
knows comes through its own Minecraft client.

The implementation status per milestone and every deviation from the design are tracked at the top and in
§24 of `DESIGN.md`.

## Requirements

- Node **22.12+** (`.nvmrc`), pnpm via corepack (`corepack enable`)
- Java **25+** for Paper 26.1.2 (Temurin recommended). Point to it with `JAVA_HOME`, `AGORA_JAVA` or
  `server.javaPath` in `config/world.yaml`.
- A NanoGPT subscription key set to **Subscription only** (DESIGN.md §22.1)

## Quick start

```bash
pnpm install
pnpm run setup --accept-eula   # pinned, hash-verified Paper + ProximityChat! + embedding model; server files
# put NANOGPT_API_KEY=... into .env (created by setup from .env.example)
pnpm run doctor                # versions, RAM, ports, hashes, binding, key + subscription lock
pnpm start                     # server + hub + agents
```

`pnpm setup`, `pnpm doctor` and `pnpm import` are pnpm built-ins, so those three need `pnpm run`.

Everything mutable lives in `DATA_DIR` (default `./data`): `server/`, `agents/`, `graveyard/`, `logs/`, `cache/`,
and `skins/` (NameMC pages you saved for agents' skins, below).

## New people

Every new agent's numbers (temperament, the Big Five, mind, abilities) are drawn by code from the population's
distributions (DESIGN.md §20), and a child's from its parents. The master model, on the key, then writes the person
around them: a name, their character, a short story, how they talk, what they want and what stings them
(`personas: generated` in `config/world.yaml`, DESIGN.md §24). Without a key, code's own words stand.
`personas: auto` uses the hand-written pool in `personas/` first, and `ctl add <persona>` adds one from the pool either
way.

## Agents' skins

Each agent is created in a skin from [NameMC](https://namemc.com): one tagged **boy** for a male agent, **girl**
for a female one (`skins:` in `config/world.yaml`, DESIGN.md §16.5). [MineSkin](https://mineskin.org) signs a copy
so clients show it, and our `agora-skins` plugin puts it on as the agent logs in. A MineSkin key is optional
(`MINESKIN_API_KEY` in `.env`; without one its anonymous limits apply, enough for a village).

NameMC shows its tag pages only to browsers (a Cloudflare challenge), and agora doesn't try to get around that.
If it is turned away, the log says so: open `https://namemc.com/minecraft-skins/tag/boy` (and `…/girl`) in your
browser, save the page (Ctrl+S, "HTML only") into `data/skins/namemc/boy/` (and `girl/`), or list NameMC skin
links in a `.txt` file there. New agents pick from what you saved. `skins.exclude` lists skins never to use, and
`skins.enabled: false` turns skins off.

## Scripts

| Command | What it does |
|---|---|
| `pnpm run setup [--accept-eula] [--skip-model]` | Downloads and verifies the pinned jars and model, writes server files, generates `RCON_PASSWORD` |
| `pnpm run doctor` | Environment and safety checks (§23.5) |
| `pnpm server-mode test\|live [--new-world]` | Rewrites `server.properties` for the mode (§16.3); refuses to switch an existing world without `--new-world` |
| `pnpm run server` | Only the Minecraft server, foreground, same preflight as `pnpm start` |
| `pnpm test-mode [on\|off] [--new-world]` | Test mode **off** (the default, `mode: live`): hardcore, real permadeath for everyone, no starter kits. **On**: hard, a death still ends the agent, persona kits. A played world keeps its mode until `--new-world` starts a fresh one (the old one is kept). No argument prints the mode |
| `pnpm ctl status\|stop\|restart\|save\|population <n>\|test-mode on\|off [--new-world]\|say <msg>\|rcon "<cmd>"` | Controls the running system from any shell on the machine (token: `RCON_PASSWORD` from `.env`) |
| `pnpm ctl help` | The debug controls (below), e.g. `ctl add [persona] [--name N] [--sex male\|female]`, `ctl remove Pip`, `ctl agent Pip inspect`, `ctl agent Pip memory.list q=iron`, `ctl model all L2 <model-id>` (or `Pip` for one agent), `ctl module all romance off` |
| `pnpm bench-models [--tier L3] [--count 5] [--models a,b]` | Measures subscription models with the agents' real prompts and writes `config/model-bench.json`, which `auto` tiers use (DESIGN.md §22.3) |
| `pnpm logs [--agent Pip] [--module cc] [--level warn] [--lines 50] [--since 10] [--no-follow] [--raw]` | Follows every process's JSON logs, merged by time |
| `pnpm export [--hot] [--with-logs] [--out file]` | World, agents, graveyard, roster and config into `export-<date>.tar.gz`; never `.env` or caches. `--hot` saves everything first while it runs |
| `pnpm run import <file> [--force]` | Restores an export (`--force` moves the existing data aside first); then `pnpm run setup` |
| `pnpm deploy:systemd` | Writes `deploy/minecraft-agents.service`, a systemd user unit for this checkout |
| `pnpm chat-discovery [--seconds 60] [--speak "hi"]` | Logs raw chat JSON and how the parser reads it (§15.3) |
| `pnpm build:guard-plugin` / `pnpm build:skins-plugin` | Rebuilds `server-plugin/agora-guard` / `agora-skins` (needs a JDK 25) and prints its sha256 |
| `pnpm run check` | Typecheck + lint + forbidden-strings (§22.2) + unit tests. Must be green after every change |
| `pnpm test:live` | Live tests against a real, isolated Paper server (needs `AGORA_JAVA`) |
| `AGORA_LIVE_LLM=1 pnpm test:live m2-nanogpt real-models` | The live tests that spend real subscription quota (needs `NANOGPT_API_KEY`): the subscription lock, and what only a model does (the bias audit, a trait annotation, a skill written by L3 and tried in the world, the shelter broken open at night, new people written by the master model) |

## Debug controls

The dashboard (`http://localhost:8080`) has a **Controls** card and, for the agent you pick, a **Debug** card. Paste
`RCON_PASSWORD` from `.env` into the token field once. From there, or with `pnpm ctl`, you can:

- add an agent (a persona from the pool, a name, a sex), remove one, restart or kill it;
- read, search, add, edit and delete its memories;
- set its goal, give it a plan, or ask for a new one;
- see what its mind sees right now (its plan, the packet its Cognitive Controller would get, its last exchange with
  the model, its model chains);
- make it decide now, do something you write as a decision (checked like its own), stop, or say something;
- set a feeling;
- switch modules off;
- choose the model per tier, for everyone or for one agent;
- pause and resume everyone, and turn test mode on and off.

Settings are kept in `DATA_DIR/agents/tuning.json`. Models must be on the subscription list (DESIGN.md §22).

## Remote / headless

All ports bind to `127.0.0.1` by default. From your PC:

```bash
ssh -L 25565:localhost:25565 -L 8080:localhost:8080 user@host
```

then join `localhost:25565` with a vanilla client and open `http://localhost:8080` for the dashboard: what each
agent is doing and why, what it said, who thinks what of whom, and tokens per hour against the weekly quota.
Never expose an offline-mode server to the internet (DESIGN.md §23.3). If your machine needs an HTTPS proxy for
downloads, set `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY`.

To keep it running on the host: `pnpm deploy:systemd`, then follow the install lines it prints (a user unit that
starts on boot, restarts after a crash, and comes back after `pnpm ctl restart`).

### Docker

```bash
cp .env.example .env              # NANOGPT_API_KEY, and AGORA_ACCEPT_EULA=true once you've read the EULA
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec agora pnpm ctl status
```

The image pins Temurin 25 and Node 22 (checksummed). State lives in `./data` (mounted as `/data`), `.env` is
mounted, never copied in, and both ports are published on the host's `127.0.0.1` only.

## Layout

```
config/          models.yaml world.yaml hub.yaml versions.yaml sex-differences.yaml
personas/        persona pool (YAML)
packages/shared  types, zod schemas, config, geometry, chat format, logging
packages/llm     NanoGPT client and subscription lock
packages/hub     supervisor, server management, rate limiter, dashboard
packages/agent   one bot: body, blackboard, modules, social, memory
server-plugin/   agora-guard (disables private chat commands for non-ops), agora-skins (agents' skins)
scripts/         setup, start, doctor, server-mode, ctl, logs, export/import, …
tests/           unit tests; tests/live/ needs a real server
```
