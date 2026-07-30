-- Resolvable maintenance items (#412). Additive + idempotent.
--
-- MaintenanceItem had eight writers and one of them ever cleared anything, so
-- the notification bell filled up and stayed full — including with security
-- advisories that had long since been fixed, which is the case that actively
-- misleads. Checkers now mark-and-sweep: anything not re-seen in a run is
-- resolved.
--
-- Resolved rather than deleted, so a recurring fault reads as a repeat
-- (`occurrences`) instead of arriving indistinguishable from a first occurrence.
--
-- No backfill: every existing row is, by definition, still outstanding as far as
-- anything knows — NULL resolvedAt and occurrences 1 are both correct for them,
-- and the column defaults supply that at ADD COLUMN time.
ALTER TABLE "MaintenanceItem" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
ALTER TABLE "MaintenanceItem" ADD COLUMN IF NOT EXISTS "occurrences" INTEGER NOT NULL DEFAULT 1;
