#!/bin/sh
# Apply the hand-written SQL in prisma/manual-migrations/ before `prisma db push`.
#
# This is a thin wrapper so the Docker CMD and update.sh don't have to change.
# The work happens in scripts/apply-migrations.mjs — see its header for why it is
# Node rather than shell (it has to read a ledger, which `prisma db execute`
# cannot do, and hash files portably, which busybox and macOS disagree about).
#
# POSIX sh ON PURPOSE: the runtime image is node:20-alpine, which has no bash.
# Do not introduce bashisms.
#
# ALWAYS EXITS 0, and that is load-bearing: the Docker CMD chains this with `&&`,
# so a non-zero exit here would stop `db push` AND `node server.js`, turning a
# recoverable state into a container that won't boot.

node scripts/apply-migrations.mjs "$@" || \
  echo "  ⚠️  Manual migrations could not be applied — continuing; 'db push' will reconcile or report the cause."

exit 0
