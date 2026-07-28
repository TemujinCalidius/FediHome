FROM node:20-alpine AS builder
WORKDIR /app
# Prisma 7's postinstall runs `prisma generate`, which needs the schema + config,
# so copy those before `npm ci`. The client is generated into src/generated and
# bundled into the standalone build.
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Next's standalone server binds to $HOSTNAME, and Docker sets HOSTNAME to the
# container ID — which resolves to the container's own IP. The server therefore
# listened on 172.x.x.x:3000 ONLY, refusing loopback. Published ports still
# worked (Docker forwards to that IP), which is why it went unnoticed — but any
# in-container probe, including the HEALTHCHECK below, got ECONNREFUSED.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Which commit this image was built from (#358). Nothing inside a container can
# work this out for itself — .dockerignore excludes .git — so it has to be
# passed in: `docker build --build-arg FEDIHOME_BUILD_SHA=$(git rev-parse HEAD)`.
# Unset is fine; /api/health then reports build: null.
ARG FEDIHOME_BUILD_SHA=""
ENV FEDIHOME_BUILD_SHA=$FEDIHOME_BUILD_SHA
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
# The manual-migration runner, shared with update.sh (#355).
COPY --from=builder /app/scripts ./scripts
# Prisma 7's startup `db push` (the CMD below) needs the CLI + @prisma/engines
# (the schema engine) + @prisma/config (to load prisma.config.ts) + a TS loader.
# Copying the builder's node_modules guarantees they're all present. (The app
# itself serves from the traced .next/standalone deps; this is only for the
# one-shot db push at startup.)
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000

# Run the app unprivileged (#360) — the standalone server binds 3000 and needs
# nothing root can give it.
#
# A bare `USER node` is NOT enough, and would be a regression: public/uploads is
# a bind mount in docker-compose, and a bind mount keeps the HOST directory's
# ownership, so writes fail with EACCES for uid 1000. Verified in a container,
# not assumed. Instead the entrypoint starts as root purely to fix ownership,
# then hands off to `node` via su-exec — so existing installs keep working
# without the operator having to chown anything by hand.
RUN apk add --no-cache su-exec
RUN chown -R node:node /app

# The scheduler runs in-process, so a wedged instance can keep serving HTTP
# while silently no longer publishing. /api/health reports that as degraded,
# which makes it worth restarting on.
#
# start-period must comfortably exceed manual migrations + `db push` on a cold
# start, or the container is killed mid-migration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
# Sync the schema to the database before starting the server. FediHome doesn't
# track migration files; `db push` is the install/upgrade path. Refuses by
# default if a change would drop data, which is the right safety stance for
# automatic startup runs.
#
# The manual migrations MUST run first (#355). They exist precisely because
# `db push` won't add a unique constraint on its own, so skipping them is what
# would make it fail. This path previously ran `db push` alone, so containers
# silently skipped every one of them.
#
# They are recorded in the ManualMigration table and normally apply once per
# content version (#384) — before that ledger existed they re-ran on every start,
# which is how a data backfill came to overwrite live delivery state. See
# prisma/manual-migrations/README.md.
#
# If `db push` fails, say so plainly instead of letting `&&` short-circuit into
# a bare crash-loop with no explanation.
CMD ["sh", "-c", "sh scripts/apply-migrations.sh && { npx prisma db push || { echo '\n✗ Database update failed. Common causes: DATABASE_URL missing or wrong, the database unreachable, or a change that would drop data (Prisma refuses by default). See the error above.\n' >&2; exit 1; }; } && node server.js"]
