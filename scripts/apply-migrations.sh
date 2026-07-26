#!/bin/sh
# Apply the hand-written, idempotent SQL in prisma/manual-migrations/ before
# `prisma db push`.
#
# WHY THESE FILES EXIST: `db push` refuses to add a unique constraint without
# --accept-data-loss — even a provably safe additive one on a brand-new column —
# so any change needing one ships as a `CREATE ... IF NOT EXISTS` file here.
# Pre-applying them means the `db push` that follows sees no diff and never
# trips the data-loss guard. (#124)
#
# WHY THIS IS A SHARED SCRIPT: it used to live only inside update.sh, which
# requires a git checkout and therefore never ran in a container — so container
# deployments silently skipped every one of these. Two consequences: a future
# release adding a unique constraint would crash-loop every container on
# upgrade, and — already true today — the data backfill in
# 2026-07-03-post-delivery-markers.sql never ran, leaving `federatedAt` NULL on
# posts published before it and risking re-federation with duplicate Bluesky
# crossposts. (#355)
#
# POSIX sh ON PURPOSE: the runtime image is node:20-alpine, which has no bash.
# Do not introduce bashisms.
#
# Ordering matters and is the shell glob's lexicographic order, which is date
# order for these filenames. 2026-07-03-post-delivery-markers.sql UPDATEs a
# column created by 2026-07-02-scheduled-posts.sql, so do not sort differently.
#
# Failures here are deliberately NON-FATAL. Every file is idempotent, and the
# `db push` that follows will either reconcile the difference or report the real
# cause with a better message than a raw SQL error. Exiting here instead would
# turn a recoverable state into a container that won't boot.

DIR="${1:-prisma/manual-migrations}"

if [ ! -d "$DIR" ]; then
  echo "  No manual migrations directory ($DIR) — nothing to apply."
  exit 0
fi

applied=0
failed=0

for migration in "$DIR"/*.sql; do
  # No .sql files yet → the glob stays literal, so skip it.
  [ -e "$migration" ] || continue
  name=$(basename "$migration")
  echo "  Applying $name…"
  if npx prisma db execute --file "$migration"; then
    applied=$((applied + 1))
  else
    failed=$((failed + 1))
    echo "  ⚠️  Could not apply $name — continuing; the 'db push' that follows will reconcile or report the cause."
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "  Applied $applied migration(s), $failed could not be applied (see above)."
else
  echo "  Applied $applied migration(s)."
fi

exit 0
