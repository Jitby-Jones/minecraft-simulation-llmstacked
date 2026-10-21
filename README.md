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

Everything mutable lives in `DATA_DIR` (default `./data`): `server/`, `agents/`, `graveyard/`, `logs/`, `cache/`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm run setup [--accept-eula] [--skip-model]` | Downloads and verifies the pinned jars and model, writes server files, generates `RCON_PASSWORD` |
| `pnpm run doctor` | Environment and safety checks (§23.5) |
| `pnpm server-mode test\|live [--new-world]` | Rewrites `server.properties` for the mode (§16.3); refuses to switch an existing world without `--new-world` |
| `pnpm run server` | Only the Minecraft server, foreground, same preflight as `pnpm start` |
| `pnpm chat-discovery [--seconds 60] [--speak "hi"]` | Logs raw chat JSON and how the parser reads it (§15.3) |
| `pnpm build:guard-plugin` | Rebuilds `server-plugin/agora-guard` (needs a JDK 25) and prints its sha256 |
| `pnpm run check` | Typecheck + lint + forbidden-strings (§22.2) + unit tests. Must be green after every change |
| `pnpm test:live` | Live tests against a real, isolated Paper server (needs `AGORA_JAVA`) |

## Remote / headless

All ports bind to `127.0.0.1` by default. From your PC:

```bash
ssh -L 25565:localhost:25565 -L 8080:localhost:8080 user@host
```

then join `localhost:25565` with a vanilla client and open `http://localhost:8080`. Never expose an
offline-mode server to the internet (DESIGN.md §23.3). If your machine needs an HTTPS proxy for downloads, set
`NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY`.

## Layout

```
config/          models.yaml world.yaml hub.yaml versions.yaml sex-differences.yaml
personas/        persona pool (YAML)
packages/shared  types, zod schemas, config, geometry, chat format, logging
packages/llm     NanoGPT client and subscription lock
packages/hub     supervisor, server management, rate limiter, dashboard
packages/agent   one bot: body, blackboard, modules, social, memory
server-plugin/   agora-guard (disables private chat commands for non-ops)
scripts/         setup, start, doctor, server-mode, ctl, logs, export/import, …
tests/           unit tests; tests/live/ needs a real server
```
