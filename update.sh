#!/bin/bash
# FediHome — One-command update
# Usage from inside the FediHome folder:
#   npm run update         # recommended
#   bash update.sh         # equivalent
# Or from anywhere:
#   curl -sSL https://raw.githubusercontent.com/TemujinCalidius/fedihome/main/update.sh | bash -s -- /path/to/fedihome
#
# What this does:
#   1. Shows you what's new since your last update (so you know what you're getting)
#   2. Pulls the latest code from GitHub
#   3. Installs any new dependencies
#   4. Applies database schema changes (safely — Prisma refuses if data would be lost)
#   5. Rebuilds the app
#   6. Restarts the running server (pm2, systemd, or docker compose — whichever it finds)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

say()    { echo -e "${BLUE}▶${NC} $*"; }
ok()     { echo -e "${GREEN}✓${NC} $*"; }
warn()   { echo -e "${YELLOW}!${NC} $*"; }
fail()   { echo -e "${RED}✗${NC} $*"; }
header() { echo -e "\n${BOLD}$*${NC}"; }

# Allow `bash update.sh /some/path` to update an install in another folder
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  cd "$1"
fi

if [ ! -d .git ] || [ ! -f package.json ]; then
  fail "This doesn't look like a FediHome checkout (no .git or package.json)."
  echo "  Run this script from your FediHome folder, or pass the path:"
  echo "    bash update.sh /opt/fedihome"
  exit 1
fi

INSTALL_DIR="$PWD"
echo ""
echo "  🏠 FediHome Updater"
echo "  ==================="
echo "  Folder: $INSTALL_DIR"
echo ""

# Read from /dev/tty when stdin is piped (curl | bash)
if [ ! -t 0 ] && [ -e /dev/tty ]; then
  INPUT_FROM=/dev/tty
else
  INPUT_FROM=/dev/stdin
fi

ask_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local answer
  local suffix="[Y/n]"
  [ "$default" = "n" ] && suffix="[y/N]"
  read -r -p "  $prompt $suffix " answer < "$INPUT_FROM"
  answer="${answer:-$default}"
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Safety: warn on uncommitted changes
# ---------------------------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "You have uncommitted local changes. Updating may cause merge conflicts."
  git status --short
  echo ""
  if ! ask_yes_no "Continue anyway?" "n"; then
    fail "Aborting. Commit or stash your changes first."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 1: Fetch and preview what's new
# ---------------------------------------------------------------------------
header "Step 1 of 5 — Checking for updates"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
say "On branch: $CURRENT_BRANCH"

git fetch --quiet origin "$CURRENT_BRANCH"

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse "origin/$CURRENT_BRANCH")
BUILT_SHA=$(cat .fedihome-built-sha 2>/dev/null || true)

SKIP_PULL=false
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  if [ "$BUILT_SHA" = "$LOCAL_SHA" ]; then
    ok "You're already up to date (and the running build matches HEAD)."
    exit 0
  fi
  # Nothing to pull, but the build on disk doesn't match HEAD — e.g. after a
  # branch switch or a manual checkout. Rebuild + restart the current code
  # rather than exiting, or the old build keeps serving. (#63)
  warn "No new commits to pull, but the running build doesn't match HEAD — rebuilding and restarting the current code."
  SKIP_PULL=true
fi

if [ "$SKIP_PULL" = false ]; then
  COMMIT_COUNT=$(git rev-list --count "HEAD..origin/$CURRENT_BRANCH")
  echo ""
  echo "  ${BOLD}$COMMIT_COUNT new commit(s):${NC}"
  git --no-pager log --pretty=format:"    %h  %s" "HEAD..origin/$CURRENT_BRANCH" | head -20
  echo ""
  echo ""

  if ! ask_yes_no "Apply these updates?"; then
    warn "Update cancelled."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: Pull
# ---------------------------------------------------------------------------
header "Step 2 of 5 — Pulling latest code"
if [ "$SKIP_PULL" = false ]; then
  git pull --ff-only origin "$CURRENT_BRANCH"
  ok "Code updated"
else
  say "Already at the latest commit — skipping pull, rebuilding the current code."
fi

# ---------------------------------------------------------------------------
# Step 3: Dependencies
# ---------------------------------------------------------------------------
header "Step 3 of 5 — Installing dependencies"
npm install --silent
ok "Dependencies in sync"

# ---------------------------------------------------------------------------
# Step 4: Database schema
# ---------------------------------------------------------------------------
header "Step 4 of 5 — Applying database changes"
# Prisma db push refuses by default if a change would drop data — that's the
# right safety stance. If it fails, we bail and tell the user.
if ! npx prisma db push; then
  fail "Database update failed (Step 4)."
  echo "  Common causes:"
  echo "    • DATABASE_URL is missing or wrong — check .env / .env.local"
  echo "    • the database server is unreachable (connection refused / timeout)"
  echo "    • a schema change would drop data — Prisma refuses by default."
  echo "      If you're sure, re-run: npx prisma db push --accept-data-loss"
  echo "  See the error above and CHANGELOG.md for details."
  exit 1
fi
npx prisma generate >/dev/null 2>&1 || npx prisma generate
ok "Schema is current"

# ---------------------------------------------------------------------------
# Step 5: Build + restart
# ---------------------------------------------------------------------------
header "Step 5 of 5 — Rebuilding and restarting"

say "Building..."
npm run build
# Record the commit we just built so a later run can detect a stale build
# (e.g. after a branch switch) even when there's nothing to pull. (#63)
git rev-parse HEAD > .fedihome-built-sha 2>/dev/null || true
ok "Build complete"

# Detect how the app is running and restart it. We check in order:
#   1. docker compose — if docker-compose.yml is here and the project is up
#   2. pm2 — if a pm2 process named "fedihome" exists
#   3. systemd — if a fedihome service unit exists
# Otherwise we just tell the user to restart manually.

RESTARTED=false

if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  if docker compose ps --services --filter "status=running" 2>/dev/null | grep -q "^app$"; then
    say "Restarting via docker compose..."
    docker compose build app
    docker compose up -d
    ok "Restarted via docker compose"
    RESTARTED=true
  fi
fi

if [ "$RESTARTED" = false ] && command -v pm2 >/dev/null 2>&1; then
  # Match the pm2 process by working directory, so it works whatever the
  # operator named it (not just the literal "fedihome"), then fall back to the
  # canonical name. Node is a hard dependency of the app, so parsing the JSON
  # process list is safe.
  PM2_NAME=$(pm2 jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const dir = process.argv[1];
        const m = JSON.parse(s).find((p) => p.pm2_env && p.pm2_env.pm_cwd === dir);
        if (m) console.log(m.name);
      } catch {}
    });
  ' "$INSTALL_DIR") || true
  if [ -z "$PM2_NAME" ] && pm2 describe fedihome >/dev/null 2>&1; then
    PM2_NAME=fedihome
  fi
  if [ -n "$PM2_NAME" ]; then
    say "Restarting via pm2 ($PM2_NAME)..."
    pm2 restart "$PM2_NAME"
    ok "Restarted via pm2"
    RESTARTED=true
  fi
fi

if [ "$RESTARTED" = false ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q "^fedihome\.service"; then
    say "Restarting via systemd..."
    sudo systemctl restart fedihome
    ok "Restarted via systemd"
    RESTARTED=true
  fi
fi

echo ""
if [ "$RESTARTED" = false ]; then
  fail "New code was built, but FediHome could NOT be auto-restarted — your site is still running the OLD version."
  echo "  If you started it with 'npm start', stop it (Ctrl+C) and run 'npm start' again."
  echo "  If it's behind a process manager you set up yourself, restart it there."
  echo "  Tip: run FediHome under pm2 from this folder (any process name) or systemd"
  echo "  so future updates restart automatically."
  echo ""
  exit 1
fi

echo -e "${GREEN}${BOLD}✅ FediHome is up to date!${NC}"
echo ""
echo "  Visit your site to see the changes. If you set up the maintenance dashboard,"
echo "  the 'new version available' notification will clear on the next check."
echo ""
