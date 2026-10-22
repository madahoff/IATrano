# Image de production IATrano — Next.js (sortie standalone) + Prisma.
# Cibles : `runner` (application) et `migrator` (migrations Prisma, exécutées une fois puis arrêtées).

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache openssl libc6-compat
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /app

# --- Dépendances (couche mise en cache tant que le lockfile ne change pas)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- Build Next.js
FROM deps AS builder
COPY . .
# public/ peut être absent du dépôt (Git ne versionne pas les dossiers vides) : on le garantit.
RUN mkdir -p public && pnpm prisma generate && pnpm build

# --- Migrations : `prisma migrate deploy` (n'applique que les migrations en attente, jamais de reset)
FROM deps AS migrator
ENV NODE_ENV=production
CMD ["pnpm", "prisma", "migrate", "deploy"]

# --- Exécution
FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache openssl libc6-compat && addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    IATRANO_IN_DOCKER=true
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
