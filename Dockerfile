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
CMD ["sh", "-c", "npx prisma db push && node server.js"]
