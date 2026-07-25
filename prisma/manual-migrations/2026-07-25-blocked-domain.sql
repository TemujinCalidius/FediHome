-- Instance-wide domain blocks (#180 follow-up). Additive + idempotent: a brand
-- new table, so `prisma db push` applies it without the data-loss flag.
CREATE TABLE IF NOT EXISTS "BlockedDomain" (
  "id"        TEXT NOT NULL,
  "domain"    TEXT NOT NULL,
  "reason"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlockedDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BlockedDomain_domain_key" ON "BlockedDomain"("domain");
