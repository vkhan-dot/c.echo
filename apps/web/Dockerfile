FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ─── Install dependencies ─────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ─── Build ────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app ./
COPY . .

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_LIVEKIT_URL
ARG NEXT_PUBLIC_LIVEKIT_FORCE_RELAY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_LIVEKIT_URL=$NEXT_PUBLIC_LIVEKIT_URL
ENV NEXT_PUBLIC_LIVEKIT_FORCE_RELAY=$NEXT_PUBLIC_LIVEKIT_FORCE_RELAY

RUN pnpm --filter @centras/shared build && pnpm --filter web build

# ─── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependencies and config files
COPY --from=deps    /app                      ./
COPY --from=builder /app/apps/web             ./apps/web
COPY --from=builder /app/apps/web/public      ./public
COPY --from=builder /app/packages/shared/dist  ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE 3000

CMD ["pnpm", "--filter", "web", "start"]
