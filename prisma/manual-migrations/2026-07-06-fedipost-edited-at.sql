-- Incoming ActivityPub Update support (#205): record when a remote edit was
-- applied to a stored FediPost. Additive + idempotent.
ALTER TABLE "FediPost" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3);
