# syntax=docker/dockerfile:1
# Agora in one container (DESIGN.md §23.2): Temurin JRE for Paper, Node for the Hub and the bots, everything pinned.
# Build from the repository root:  docker compose -f deploy/compose.yaml up -d --build
# State lives in the DATA_DIR volume; the API key comes from .env (mounted, never copied into the image).

FROM eclipse-temurin:25.0.4.1_1-jre-noble@sha256:3f2223fe04b750aa5a8179e29b5c9a1ddf7665fc9bb08bfe11ad01d143bc13a5

# Node 22 LTS, checked against nodejs.org's SHASUMS256.txt for this release.
ARG NODE_VERSION=22.23.4
ARG NODE_SHA256_X64=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
ARG NODE_SHA256_ARM64=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b
ARG TARGETARCH
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sum="$NODE_SHA256_X64" ;; \
      arm64) arch=arm64; sum="$NODE_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    echo "${sum}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    corepack enable; \
    node --version

WORKDIR /app
# Dependencies first (cached while only the code changes); pnpm's version comes from package.json via corepack.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/shared/package.json packages/shared/
COPY packages/llm/package.json packages/llm/
COPY packages/hub/package.json packages/hub/
COPY packages/agent/package.json packages/agent/
RUN corepack pnpm install --frozen-lockfile
COPY . .

# Inside the container Minecraft and the dashboard listen on all interfaces so ports can be published;
# compose.yaml publishes them on the host's 127.0.0.1 only (never expose offline-mode Minecraft, §23.3).
ENV DATA_DIR=/data \
    AGORA_CONTAINER=1 \
    AGORA_SUPERVISED=1 \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 25565 8080
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "scripts/container.ts"]
