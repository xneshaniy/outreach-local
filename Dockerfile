# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Email Outreach Platform — production image (Next.js standalone + worker).
#
# One image serves both roles:
#   web:    `node server.js`            (Next.js standalone server)
#   worker: `node worker.mjs`           (background sender, see compose)
# Migrations run from a separate step using the Prisma CLI.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# OpenSSL is required by Prisma's query engine.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# Prisma's postinstall runs `prisma generate`; give it a placeholder URL.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` evaluates the app's route modules, but it must not need the
# production secrets: a hosting platform applies them to the running app, not
# to the build step. src/lib/env.ts therefore uses a placeholder while
# NEXT_PHASE=phase-production-build, and the real values are injected at
# RUNTIME - where a missing secret still fails fast.
#
# DATABASE_URL is still needed here: the Prisma client's postinstall runs
# `prisma generate`, and it only needs a URL it can parse.
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" \
    APP_URL="http://localhost:3000"
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Next.js standalone output (server.js + traced node_modules).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma: schema, migrations and the CLI (needed by `migrate deploy`), plus the
# compiled worker bundle produced by the build step.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
# The Prisma CLI package (contains `prisma` CLI + engine binaries) so that
# `npx prisma migrate deploy` works inside the image.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
# The CLI shim in .bin, so `npx prisma` resolves to the local package instead
# of downloading one at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder --chown=nextjs:nodejs /app/dist/worker ./worker
USER nextjs
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
