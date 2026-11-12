# Kloru: the website, the voice service and the agent in one image for one always-on Fly machine.
# Caddy on :8000 routes by hostname (app.kloru.com → website, voice.kloru.com → voice); the agent
# listens on loopback only. See docs/DEPLOY-KLORU.md.

# --- Node workspace: agent (packages/server) and website (packages/web) ---
FROM node:22-bookworm-slim AS node-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
COPY packages/core/package.json packages/core/
COPY packages/inkbox/package.json packages/inkbox/
COPY packages/computer/package.json packages/computer/
COPY packages/context/package.json packages/context/
COPY packages/apps/package.json packages/apps/
COPY packages/desk/package.json packages/desk/
COPY packages/store/package.json packages/store/
COPY packages/network/package.json packages/network/
COPY packages/payments/package.json packages/payments/
COPY packages/ample/package.json packages/ample/
COPY packages/atomicmail/package.json packages/atomicmail/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
COPY skills ./skills
RUN pnpm -r --workspace-concurrency=1 --filter './packages/*' run build \
  && pnpm prune --prod

# --- Python voice service ---
FROM python:3.12-slim-bookworm AS voice-build
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app/voice
COPY voice/pyproject.toml voice/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY voice/voice ./voice

# --- Runtime ---
FROM python:3.12-slim-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates util-linux git chromium fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system kloru \
  && useradd --system --gid kloru --uid 10001 --create-home --home-dir /home/kloru --shell /usr/sbin/nologin kloru
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
# npm, for the packages an app's server names (packages/desk/src/app-servers.ts).
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY --from=caddy:2.8.4 /usr/bin/caddy /usr/bin/caddy
WORKDIR /app
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/packages ./packages
COPY --from=node-build /app/skills ./skills
COPY --from=node-build /app/package.json ./package.json
COPY --from=voice-build /app/voice ./voice
COPY deploy/kloru/Caddyfile deploy/kloru/run.sh ./deploy/kloru/
ENV NODE_ENV=production PATH=/app/voice/.venv/bin:$PATH INSTINCT_SKILLS_DIR=/app/skills
EXPOSE 8000
# No tini: Fly's init is PID 1 and reaps children; when run.sh exits, the machine exits and Fly restarts it.
ENTRYPOINT ["/app/deploy/kloru/run.sh"]
