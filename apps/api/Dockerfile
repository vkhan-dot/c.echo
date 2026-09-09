FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ─── Install dependencies ─────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ─── Build ────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app ./
COPY . .
RUN pnpm --filter @centras/shared build && pnpm --filter api build

# ─── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate
RUN addgroup -S centras && adduser -S centras -G centras

# Create Railway Volume mount point
RUN mkdir -p /data/audio && chown centras:centras /data/audio

COPY --from=deps    /app                      ./
COPY --from=builder /app/apps/api/dist        ./apps/api/dist
COPY --from=builder /app/apps/api/src/db/schema.sql ./apps/api/dist/db/schema.sql
COPY --from=builder /app/packages/shared/dist  ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

USER centras

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD node apps/api/dist/db/migrate.js && node apps/api/dist/index.js

