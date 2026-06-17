#!/bin/bash
# FediHome — One-command install
# Usage: curl -sSL https://raw.githubusercontent.com/TemujinCalidius/fedihome/main/install.sh | bash
#
# This script is designed for non-technical users. It does its best to:
#   1. Install missing prerequisites (Node, PostgreSQL) with your permission
#   2. Create a database and user for you
#   3. Generate secrets and write .env.local
#   4. Build the app and tell you exactly what to do next
#
# If anything fails, it prints what went wrong and how to fix it — it does not
# leave you with a half-broken install.

set -e

# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------
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

echo ""
echo "  🏠 FediHome Installer"
echo "  ====================="
echo ""
echo "  This will install FediHome on your computer. It takes about 5 minutes."
echo "  You'll be asked a few questions along the way."
echo ""

# Detect when piped via curl (stdin is not a TTY). We still want interactive
# prompts to work — read from /dev/tty so the user can answer questions.
if [ ! -t 0 ]; then
  if [ -t 1 ] && [ -e /dev/tty ]; then
    INPUT_FROM=/dev/tty
  else
    fail "No interactive terminal available. Please run this script directly:"
    echo "    curl -sSL https://raw.githubusercontent.com/TemujinCalidius/fedihome/main/install.sh -o install.sh"
    echo "    bash install.sh"
    exit 1
  fi
else
  INPUT_FROM=/dev/stdin
fi

ask() {
  # ask "Prompt text" "default value" -> echoes the answer
  local prompt="$1"
  local default="$2"
  local answer
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " answer < "$INPUT_FROM"
    echo "${answer:-$default}"
  else
    read -r -p "  $prompt: " answer < "$INPUT_FROM"
    echo "$answer"
  fi
}

ask_yes_no() {
  # ask_yes_no "Question?" "y" -> returns 0 for yes, 1 for no
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
# OS detection
# ---------------------------------------------------------------------------
OS="unknown"
PKG_MGR=""
if [ "$(uname)" = "Darwin" ]; then
  OS="mac"
  PKG_MGR="brew"
elif [ -f /etc/debian_version ]; then
  OS="debian"
  PKG_MGR="apt"
elif [ -f /etc/redhat-release ]; then
  OS="redhat"
  PKG_MGR="dnf"
else
  OS="linux"
fi

say "Detected: $OS"

# ---------------------------------------------------------------------------
# Helper: install a package via the OS package manager
# ---------------------------------------------------------------------------
install_pkg() {
  local pkg="$1"
  case "$PKG_MGR" in
    brew)
      if ! command -v brew >/dev/null 2>&1; then
        fail "Homebrew not found. Install it from https://brew.sh first, then re-run this script."
        exit 1
      fi
      brew install "$pkg"
      ;;
    apt)
      sudo apt-get update -qq
      sudo apt-get install -y "$pkg"
      ;;
    dnf)
      sudo dnf install -y "$pkg"
      ;;
    *)
      fail "Don't know how to install $pkg on this OS. Please install it manually and re-run."
      exit 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Step 1: Node.js
# ---------------------------------------------------------------------------
header "Step 1 of 6 — Checking Node.js"
NODE_OK=true
if ! command -v node >/dev/null 2>&1; then
  NODE_OK=false
else
  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VERSION" -lt 20 ]; then
    warn "Found Node v$(node -v | tr -d v) — FediHome needs Node 20 or newer."
    NODE_OK=false
  fi
fi

if [ "$NODE_OK" = false ]; then
  warn "Node.js 20+ is not installed."
  if ask_yes_no "Install Node.js 20 now?"; then
    case "$OS" in
      mac)    install_pkg node ;;
      debian) install_pkg nodejs ;;
      redhat) install_pkg nodejs ;;
      *)
        fail "Please install Node.js 20+ from https://nodejs.org and re-run."
        exit 1
        ;;
    esac
    ok "Node $(node -v) installed"
  else
    fail "Node.js is required. Install it from https://nodejs.org and re-run this script."
    exit 1
  fi
else
  ok "Node $(node -v) is good"
fi

# ---------------------------------------------------------------------------
# Step 2: git
# ---------------------------------------------------------------------------
header "Step 2 of 6 — Checking git"
if ! command -v git >/dev/null 2>&1; then
  warn "git is not installed."
  if ask_yes_no "Install git now?"; then
    install_pkg git
    ok "git installed"
  else
    fail "git is required. Install it and re-run."
    exit 1
  fi
else
  ok "git found"
fi

# ---------------------------------------------------------------------------
# Step 3: PostgreSQL — install if missing
# ---------------------------------------------------------------------------
header "Step 3 of 6 — Checking PostgreSQL"

postgres_running() {
  case "$OS" in
    mac)    pg_isready -q -h localhost 2>/dev/null ;;
    *)      pg_isready -q -h localhost 2>/dev/null ;;
  esac
}

if ! command -v psql >/dev/null 2>&1; then
  warn "PostgreSQL is not installed."
  echo "  PostgreSQL is the database FediHome uses to store your posts, photos, and followers."
  if ask_yes_no "Install PostgreSQL 15 now?"; then
    case "$OS" in
      mac)
        brew install postgresql@15
        brew services start postgresql@15
        # postgresql@15 is keg-only — make sure psql is on PATH for this session
        if [ -d /opt/homebrew/opt/postgresql@15/bin ]; then
          export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
        elif [ -d /usr/local/opt/postgresql@15/bin ]; then
          export PATH="/usr/local/opt/postgresql@15/bin:$PATH"
        fi
        ok "PostgreSQL installed and started"
        warn "PostgreSQL was added to PATH for this install. To make it permanent, add this to your shell profile:"
        echo "    export PATH=\"\$(brew --prefix postgresql@15)/bin:\$PATH\""
        ;;
      debian)
        sudo apt-get update -qq
        sudo apt-get install -y postgresql postgresql-contrib
        sudo systemctl enable --now postgresql
        ok "PostgreSQL installed and started"
        ;;
      redhat)
        sudo dnf install -y postgresql-server postgresql-contrib
        sudo postgresql-setup --initdb
        sudo systemctl enable --now postgresql
        ok "PostgreSQL installed and started"
        ;;
      *)
        fail "Don't know how to install PostgreSQL on this OS."
        echo "  See https://www.postgresql.org/download/ and re-run this script."
        exit 1
        ;;
    esac
  else
    fail "PostgreSQL is required. Install it and re-run."
    exit 1
  fi
else
  ok "PostgreSQL found"
fi

# Wait up to 15s for PostgreSQL to become ready (it may have just been started)
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if postgres_running; then break; fi
  sleep 1
done
if ! postgres_running; then
  warn "PostgreSQL is installed but not responding on localhost:5432."
  case "$OS" in
    mac)    echo "  Try: brew services start postgresql@15" ;;
    debian|redhat) echo "  Try: sudo systemctl start postgresql" ;;
  esac
  fail "Start PostgreSQL and re-run this script."
  exit 1
fi
ok "PostgreSQL is running"

# ---------------------------------------------------------------------------
# Step 4: Clone the repo
# ---------------------------------------------------------------------------
header "Step 4 of 6 — Downloading FediHome"

INSTALL_DIR="${INSTALL_DIR:-$PWD/fedihome}"
if [ -d "$INSTALL_DIR" ]; then
  warn "$INSTALL_DIR already exists."
  if ask_yes_no "Continue using the existing folder?"; then
    cd "$INSTALL_DIR"
    if [ -d .git ]; then
      ok "Using existing checkout"
    else
      fail "$INSTALL_DIR is not a git checkout. Move or rename it and re-run."
      exit 1
    fi
  else
    fail "Aborting — move $INSTALL_DIR out of the way and re-run."
    exit 1
  fi
else
  git clone --depth=1 https://github.com/TemujinCalidius/fedihome.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  ok "Downloaded into $INSTALL_DIR"
fi

say "Installing app dependencies (this can take a minute)..."
npm install --silent
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# Step 5: Database setup
# ---------------------------------------------------------------------------
header "Step 5 of 6 — Setting up the database"

# Helper: run a SQL command. On macOS Homebrew, the current user is a superuser.
# On Debian/RedHat, we need sudo -u postgres.
run_psql() {
  local sql="$1"
  case "$OS" in
    mac)    psql -d postgres -tAc "$sql" ;;
    *)      sudo -u postgres psql -d postgres -tAc "$sql" ;;
  esac
}

echo "  FediHome needs a database to store your content."
echo "  Option 1: let this script create one locally for you (recommended)"
echo "  Option 2: paste a connection URL if you already have one (advanced)"
echo ""

DB_URL=""
if ask_yes_no "Create a local database automatically?"; then
  DB_NAME="fedihome"
  DB_USER="fedihome"
  DB_PASS="$(openssl rand -hex 16)"

  say "Creating database '$DB_NAME' and user '$DB_USER'..."

  # If the user/db already exist, reuse them and reset the password
  USER_EXISTS=$(run_psql "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER';" 2>/dev/null || true)
  if [ "$USER_EXISTS" = "1" ]; then
    run_psql "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
    ok "User '$DB_USER' already existed — password reset"
  else
    run_psql "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
    ok "User '$DB_USER' created"
  fi

  DB_EXISTS=$(run_psql "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';" 2>/dev/null || true)
  if [ "$DB_EXISTS" = "1" ]; then
    ok "Database '$DB_NAME' already exists"
  else
    run_psql "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
    ok "Database '$DB_NAME' created"
  fi

  run_psql "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" >/dev/null

  DB_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
  ok "Database is ready"
else
  echo ""
  echo "  Paste your full PostgreSQL connection URL."
  echo "  It looks like: postgresql://USER:PASSWORD@HOST:5432/DBNAME"
  echo "  (You can usually find this in your hosting provider's dashboard.)"
  echo ""
  while [ -z "$DB_URL" ]; do
    DB_URL=$(ask "DATABASE_URL" "")
    if [ -z "$DB_URL" ]; then
      warn "A connection URL is required."
    fi
  done
fi

# ---------------------------------------------------------------------------
# Step 6: Write .env.local, push schema, build
# ---------------------------------------------------------------------------
header "Step 6 of 6 — Configuring and building"

cp -n .env.example .env.local 2>/dev/null || true
chmod 600 .env.local

# Generate admin secret (preferring openssl, falling back to /dev/urandom)
if command -v openssl >/dev/null 2>&1; then
  ADMIN_SECRET=$(openssl rand -hex 32)
else
  ADMIN_SECRET=$(head -c 32 /dev/urandom | xxd -p -c 64)
fi

# Use a Node one-liner to update .env.local safely — sed -i has different
# syntax on macOS vs Linux, and our values may contain special chars.
node -e '
  const fs = require("fs");
  const path = ".env.local";
  let content = "";
  try { content = fs.readFileSync(path, "utf8"); } catch {}
  const set = (key, val) => {
    const escaped = String(val).replace(/[\\"]/g, "\\$&");
    const line = `${key}="${escaped}"`;
    if (new RegExp(`^${key}=.*$`, "m").test(content)) {
      content = content.replace(new RegExp(`^${key}=.*$`, "m"), line);
    } else {
      content += (content.endsWith("\n") || content === "" ? "" : "\n") + line + "\n";
    }
  };
  set("DATABASE_URL", process.env.DB_URL);
  set("ADMIN_SECRET", process.env.ADMIN_SECRET);
  fs.writeFileSync(path, content, { mode: 0o600 });
' DB_URL="$DB_URL" ADMIN_SECRET="$ADMIN_SECRET"
ok ".env.local written"

say "Creating database tables..."
npx prisma db push
ok "Schema applied"

say "Generating Prisma client..."
npx prisma generate >/dev/null 2>&1 || npx prisma generate
ok "Prisma client generated"

say "Building FediHome (this takes a minute or two)..."
npm run build
ok "Build complete"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}✅ FediHome is installed!${NC}"
echo ""
echo "  Installation folder: $INSTALL_DIR"
echo ""
echo -e "${BOLD}Start the server:${NC}"
echo "    cd $INSTALL_DIR"
echo "    npm start"
echo ""
echo -e "${BOLD}Then open:${NC}"
echo "    http://localhost:3000/setup"
echo ""
echo "  Follow the on-screen wizard (about 2 minutes) and you're done."
echo ""
echo -e "${BOLD}For a public site (your own domain):${NC}"
echo "    See $INSTALL_DIR/docs/deployment.md"
echo "    Or: $INSTALL_DIR/docs/cloudflare-tunnel.md (recommended for home servers)"
echo ""
echo -e "${BOLD}To update later:${NC}"
echo "    cd $INSTALL_DIR && npm run update"
echo ""

if ask_yes_no "Start FediHome now?"; then
  echo ""
  say "Starting FediHome on http://localhost:3000 ..."
  echo "  (Press Ctrl+C to stop)"
  echo ""
  exec npm start
fi
