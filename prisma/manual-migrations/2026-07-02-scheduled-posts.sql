-- Scheduled posts (#183): Post.scheduledFor.
--
-- A post scheduled for future publication is created with published=false and
-- scheduledFor/publishedAt set to the target time; the FediHome scheduler flips it
-- live (published=true) at that time and federates + crossposts it. A plain draft
-- leaves scheduledFor NULL so the scheduler ignores it.
--
-- Additive and non-destructive: one new nullable column + an index. `prisma db push`
-- applies it without --accept-data-loss.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-07-02-scheduled-posts.sql
-- Or (preferred):
--   npx prisma db push

ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Post_scheduledFor_idx" ON "Post"("scheduledFor");
