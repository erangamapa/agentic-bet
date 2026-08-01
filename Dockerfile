# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — full dependency tree, compile TypeScript to dist/
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Copy manifests first so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage — production dependencies only, non-root
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Served by @fastify/static from dist/server/../../public
COPY public ./public

# Cloud Run injects PORT; the default matches local development.
ENV PORT=3000
EXPOSE 3000

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

# The API service. The reconciler job overrides this with:
#   node dist/cli/reconcile.js
# and migrations run as:
#   node dist/db/migrate.js
CMD ["node", "dist/server/index.js"]
