-- App auth / OAuth token layer, part 1 (schema).
--
-- Extends AuthToken with OAuth fields (clientId / createdVia / expiresAt) so app
-- tokens issued via the OAuth flow live alongside hand-issued Micropub tokens,
-- and adds the AuthorizationCode table (short-lived, single-use PKCE codes).
--
-- Additive and non-destructive: new nullable columns + one NOT NULL column with a
-- default (existing rows get 'micropub') + a brand-new table. `prisma db push`
-- creates all of this without --accept-data-loss.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-07-01-app-auth-tokens.sql
-- Or (preferred):
--   npx prisma db push

ALTER TABLE "AuthToken"
  ADD COLUMN IF NOT EXISTS "clientId"   TEXT,
  ADD COLUMN IF NOT EXISTS "createdVia" TEXT NOT NULL DEFAULT 'micropub',
  ADD COLUMN IF NOT EXISTS "expiresAt"  TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AuthorizationCode" (
  "id"            TEXT NOT NULL,
  "codeHash"      TEXT NOT NULL,
  "clientId"      TEXT NOT NULL,
  "redirectUri"   TEXT NOT NULL,
  "scope"         TEXT NOT NULL,
  "codeChallenge" TEXT NOT NULL,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthorizationCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AuthorizationCode_codeHash_key" ON "AuthorizationCode"("codeHash");
CREATE INDEX IF NOT EXISTS "AuthorizationCode_expiresAt_idx" ON "AuthorizationCode"("expiresAt");
