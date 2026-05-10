FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
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
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# The Prisma CLI is needed at runtime to run `db push` against the live DB on
# first boot and after schema changes. Keep production deps only.
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
EXPOSE 3000
# Sync the schema to the database before starting the server. FediHome doesn't
# track migration files; `db push` is the install/upgrade path. Refuses by
# default if a change would drop data, which is the right safety stance for
# automatic startup runs.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
