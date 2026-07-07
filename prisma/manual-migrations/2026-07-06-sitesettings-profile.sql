-- Runtime-editable profile fields (#201). Additive + idempotent.
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "actorSummary" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "avatarPath" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "bannerPath" TEXT;
