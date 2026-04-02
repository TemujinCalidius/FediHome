#!/bin/bash
# FediHome — One-command install
# Usage: curl -sSL https://raw.githubusercontent.com/FediHome/fedihome/main/install.sh | bash

set -e

echo ""
echo "  🏠 FediHome Installer"
echo "  ====================="
echo ""

# Color helpers
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo -e "${RED}✗ $1 is not installed.${NC}"
    echo "  Please install $1 and try again."
    if [ "$(uname)" = "Darwin" ]; then
      echo "  macOS: brew install $2"
    else
      echo "  Linux: sudo apt install $2"
    fi
    exit 1
  fi
  echo -e "${GREEN}✓${NC} $1 found"
}

# Check prerequisites
echo "Checking prerequisites..."
check_command node node
check_command npm npm
check_command git git

# Check Node version >= 20
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${RED}✗ Node.js 20+ required (found v$NODE_VERSION)${NC}"
  exit 1
fi
echo -e "${GREEN}✓${NC} Node.js v$(node -v | cut -dv -f2)"

# Check PostgreSQL
if ! command -v psql &> /dev/null; then
  echo -e "${RED}✗ PostgreSQL is not installed.${NC}"
  if [ "$(uname)" = "Darwin" ]; then
    echo "  macOS: brew install postgresql@15 && brew services start postgresql@15"
  else
    echo "  Linux: sudo apt install postgresql && sudo systemctl start postgresql"
  fi
  exit 1
fi
echo -e "${GREEN}✓${NC} PostgreSQL found"

echo ""
echo -e "${BLUE}Cloning FediHome...${NC}"
git clone https://github.com/FediHome/fedihome.git
cd fedihome

echo -e "${BLUE}Installing dependencies...${NC}"
npm install

echo -e "${BLUE}Setting up environment...${NC}"
cp .env.example .env.local

# Generate admin secret
ADMIN_SECRET=$(openssl rand -hex 32)
sed -i.bak "s/^ADMIN_SECRET=$/ADMIN_SECRET=$ADMIN_SECRET/" .env.local && rm -f .env.local.bak

# Prompt for database URL
echo ""
echo "Enter your PostgreSQL connection URL"
echo "  (default: postgresql://localhost:5432/fedihome)"
read -p "  DATABASE_URL: " DB_URL
DB_URL=${DB_URL:-postgresql://localhost:5432/fedihome}
sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env.local && rm -f .env.local.bak

echo ""
echo -e "${BLUE}Setting up database...${NC}"
npx prisma migrate deploy

echo -e "${BLUE}Building FediHome...${NC}"
npm run build

echo ""
echo -e "${GREEN}✅ FediHome installed successfully!${NC}"
echo ""
echo "  To start:  cd fedihome && npm start"
echo "  Then visit: http://localhost:3000/setup"
echo ""
echo "  For production deployment with a custom domain,"
echo "  see: docs/deployment.md"
echo ""
