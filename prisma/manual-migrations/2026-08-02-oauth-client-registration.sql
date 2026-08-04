-- Manual migration for #366. Additive, idempotent, DDL only.
--
-- Third-party OAuth clients the owner registered by hand. First-party ids stay
-- in code; a registration is the only way a custom-scheme redirect
-- (obsidian://, raycast://) can be trusted, because nothing about a scheme
-- proves who owns it.
--
-- clientId is deliberately NOT unique: `prisma db push` is the upgrade path and
-- refuses to add a unique constraint without --accept-data-loss. Uniqueness is
-- enforced when a registration is created.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-08-02-oauth-client-registration.sql
-- Or (preferred): npx prisma db push

CREATE TABLE IF NOT EXISTS "OAuthClientRegistration" (
  "id"           TEXT NOT NULL,
  "clientId"     TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "redirectUris" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"   TIMESTAMP(3),
  CONSTRAINT "OAuthClientRegistration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OAuthClientRegistration_clientId_idx"
  ON "OAuthClientRegistration"("clientId");
