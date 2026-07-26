#!/bin/sh
# Container entrypoint: fix up writable paths, then drop privileges.
#
# WHY THIS EXISTS: the app has no reason to run as root (#360) — the standalone
# server binds 3000 and needs nothing privileged. But `public/uploads` is a BIND
# MOUNT in docker-compose, and a bind mount keeps the HOST directory's
# ownership. A plain `USER node` in the Dockerfile therefore breaks uploads on
# every existing install the moment they upgrade: the host directory is owned by
# whoever checked the repo out, and the container's `node` user is uid 1000.
#
# Verified, not assumed: with `USER node` alone, writing to a bind-mounted
# uploads directory fails with EACCES.
#
# So we start as root purely to chown what needs it, then hand off to `node`
# with su-exec. The server itself never runs privileged.
#
# POSIX sh — the runtime image is alpine and has no bash.
set -e

UPLOADS="/app/public/uploads"

if [ "$(id -u)" = "0" ]; then
  # Only touch it when it isn't already right: a large uploads directory on a
  # slow volume shouldn't be walked on every single boot.
  if [ -d "$UPLOADS" ] && [ "$(stat -c %u "$UPLOADS" 2>/dev/null)" != "1000" ]; then
    echo "  Adjusting ownership of $UPLOADS so the unprivileged app user can write to it…"
    chown -R node:node "$UPLOADS" 2>/dev/null || \
      echo "  ⚠️  Could not change ownership of $UPLOADS — uploads may fail to save. On the host: chown -R 1000:1000 ./public/uploads"
  fi
  exec su-exec node "$@"
fi

# Already unprivileged (e.g. `docker run --user`), nothing to hand off.
exec "$@"
