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

# The built-in location, plus a relocated one if FEDIHOME_UPLOADS_DIR is set
# (#363). A directory mounted outside /app/public is owned by whoever the host
# says, so without chowning it too the app would start fine and then fail every
# single upload. The database setting can't be read from here — no Prisma, no
# DATABASE_URL guarantee at this point — so a path configured in the admin panel
# needs the env var set as well if it's a fresh mount. That's called out in
# docs/deployment.md.
UPLOAD_DIRS="/app/public/uploads"
if [ -n "$FEDIHOME_UPLOADS_DIR" ] && [ "$FEDIHOME_UPLOADS_DIR" != "/app/public/uploads" ]; then
  UPLOAD_DIRS="$UPLOAD_DIRS $FEDIHOME_UPLOADS_DIR"
fi

if [ "$(id -u)" = "0" ]; then
  for UPLOADS in $UPLOAD_DIRS; do
    # Only touch it when it isn't already right: a large uploads directory on a
    # slow volume shouldn't be walked on every single boot.
    if [ -d "$UPLOADS" ] && [ "$(stat -c %u "$UPLOADS" 2>/dev/null)" != "1000" ]; then
      echo "  Adjusting ownership of $UPLOADS so the unprivileged app user can write to it…"
      chown -R node:node "$UPLOADS" 2>/dev/null || \
        echo "  ⚠️  Could not change ownership of $UPLOADS — uploads may fail to save. On the host: chown -R 1000:1000 <that directory>"
    fi
  done
  exec su-exec node "$@"
fi

# Already unprivileged (e.g. `docker run --user`), nothing to hand off.
exec "$@"
