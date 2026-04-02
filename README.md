# FediHome 🏠

> Your home on the Fediverse. Blog, share photos, and connect — all from your own domain.

## What is FediHome?

FediHome is a self-hosted, single-user publishing platform that connects to the Fediverse via ActivityPub. Your domain becomes your identity — `@you@yourdomain.com`. No Mastodon instance, no WordPress, no Pixelfed — just one app that does it all.

## Features

**Publishing**
- Write blog posts, notes, and journal entries in Markdown
- Photo gallery with EXIF metadata and lightbox viewer
- RSS feed for subscribers
- Post from any Micropub-compatible app (iA Writer, micro.blog)

**Fediverse**
- Your domain IS your identity (`@you@yourdomain.com`)
- Follow and be followed from Mastodon, Pixelfed, Misskey, etc.
- Timeline of posts from people you follow
- Receive likes, boosts, replies, and DMs
- Reply to conversations from your admin panel

**Crossposting**
- Automatic crosspost to Bluesky
- MetaWeblog API support for legacy blog apps

**Simple Setup**
- One command to install
- Setup wizard configures everything
- Docker support (optional)

## Quick Start

### Option 1: Script install
```bash
curl -sSL https://raw.githubusercontent.com/FediHome/fedihome/main/install.sh | bash
```

### Option 2: Manual install
```bash
git clone https://github.com/FediHome/fedihome.git
cd fedihome
npm install
cp .env.example .env.local
# Edit .env.local with your database URL
npx prisma migrate deploy
npm run build
npm start
```

Then visit `http://localhost:3000/setup` to configure your instance.

### Option 3: Docker
```bash
git clone https://github.com/FediHome/fedihome.git
cd fedihome
cp .env.example .env.local
docker compose up -d
```

## Requirements
- Node.js 20+ (or Docker)
- PostgreSQL 15+
- A domain name with DNS access

## Documentation
- [Getting Started](docs/getting-started.md) — First 10 minutes
- [Configuration](docs/configuration.md) — All settings explained
- [Deployment](docs/deployment.md) — Production setup with Cloudflare/VPS/Docker
- [Cloudflare Tunnel](docs/cloudflare-tunnel.md) — Secure home server hosting
- [Fediverse Setup](docs/fediverse-setup.md) — How federation works
- [Bluesky Integration](docs/bluesky-integration.md) — Crossposting setup
- [Micropub](docs/micropub.md) — Post from third-party apps
- [Theming](docs/theming.md) — Customize your site's look
- [Architecture](docs/architecture.md) — Codebase overview

## Tech Stack
- **Framework:** Next.js 16 + React 19
- **Language:** TypeScript
- **Database:** PostgreSQL via Prisma
- **Styling:** Tailwind CSS
- **Federation:** ActivityPub + HTTP Signatures
- **Crossposting:** AT Protocol (Bluesky)

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
MIT

---

Built with code and AI. FediHome believes the web should be personal, federated, and yours.
