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
# Prisma 7: the generated client is bundled into .next/standalone (there is no
# node_modules/.prisma anymore). Runtime `db push` needs the schema, the CLI,
# the config file, and dotenv (which prisma.config.ts imports).
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
EXPOSE 3000
# Sync the schema to the database before starting the server. FediHome doesn't
# track migration files; `db push` is the install/upgrade path. Refuses by
# default if a change would drop data, which is the right safety stance for
# automatic startup runs.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
