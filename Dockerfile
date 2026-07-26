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
# Sync the schema to the database before starting the server. FediHome doesn't
# track migration files; `db push` is the install/upgrade path. Refuses by
# default if a change would drop data, which is the right safety stance for
# automatic startup runs.
#
# The manual migrations MUST run first (#355). They exist precisely because
# `db push` won't add a unique constraint on its own, so skipping them is what
# would make it fail — and one of them backfills data that `db push` cannot
# produce at all. This path previously ran `db push` alone, so containers
# silently skipped every one of them.
#
# If `db push` fails, say so plainly instead of letting `&&` short-circuit into
# a bare crash-loop with no explanation.
CMD ["sh", "-c", "sh scripts/apply-migrations.sh && { npx prisma db push || { echo '\n✗ Database update failed. Common causes: DATABASE_URL missing or wrong, the database unreachable, or a change that would drop data (Prisma refuses by default). See the error above.\n' >&2; exit 1; }; } && node server.js"]
