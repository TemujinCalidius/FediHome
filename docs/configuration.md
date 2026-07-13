# Configuration

FediHome is configured through environment variables (in `.env.local`) and through the admin panel. This document covers every setting.

## Environment Variables

All environment variables are set in `.env.local` at the project root. The `.env.example` file documents the available options.

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string. Used by Prisma to connect to your database. | `postgresql://user:pass@localhost:5432/fedihome` |
| `SITE_URL` | The full public URL of your site, including protocol. No trailing slash. Used for ActivityPub, RSS, link generation, and CORS. | `https://myblog.com` |
| `ADMIN_SECRET` | A random secret string used to authenticate admin actions. Generated automatically by the install script, or set manually. Keep this safe. | `a1b2c3d4e5f6...` (64-char hex string recommended) |
| `FEDI_HANDLE` | Your Fediverse username (the part before the `@domain`). | `sam` |
| `FEDI_DOMAIN` | The domain portion of your Fediverse identity. Usually matches your site domain. | `myblog.com` |

### Optional: App / Runtime

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | The port the app binds to (`npm start` / `npm run dev` / pm2). Set this if port 3000 is already in use on the host. | `3000` |
| `FEDIHOME_PORT` | **Docker Compose only.** The host port published in front of the container (which always listens on `3000`). | `3000` |
| `ADMIN_SESSION_TTL_DAYS` | How many days an admin login stays valid before re-authentication is required. Sessions are individually revocable from **/admin/sessions** (linked from the timeline header), so a lost device can be signed out without rotating `ADMIN_SECRET`. | `30` |

> **Changing the port?** Also set `SITE_URL` to your real public origin. The listen port and the public URL are independent: `SITE_URL` drives ActivityPub IDs, WebFinger, RSS, and the CSRF origin check, so behind a reverse proxy or tunnel the port you bind locally is usually *not* the port in your public URL. A wrong `SITE_URL` silently breaks federation.

### Optional: Site Info

These can also be set via the setup wizard or admin panel. Environment variables take precedence over database settings.

| Variable | Description | Default |
|----------|-------------|---------|
| `SITE_NAME` | The title of your site, shown in the navbar and page titles. | `My FediHome` |
| `AUTHOR_NAME` | Your display name, shown on posts and the about page. | `Your Name` |
| `AUTHOR_TAGLINE` | A short line displayed under your name on the homepage. | (empty) |
| `AUTHOR_BIO` | A longer bio for the about page. | (empty) |
| `CONTACT_EMAIL` | Your email address (shown on the about page if set). | (empty) |
| `SITE_DESCRIPTION` | Meta description for SEO and RSS. | `A personal space on the Fediverse.` |
| `ACTOR_SUMMARY` | The bio text shown on your ActivityPub profile (what Mastodon users see). | `A personal blog on the Fediverse, powered by FediHome.` |

### Optional: Bluesky Crossposting

| Variable | Description | Default |
|----------|-------------|---------|
| `BLUESKY_HANDLE` | Your Bluesky handle (e.g., `yourname.bsky.social`). | (empty — crossposting disabled) |
| `BLUESKY_APP_PASSWORD` | An app password generated at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords). Do NOT use your main password. | (empty) |

### Optional: Threads Crossposting

| Variable | Description | Default |
|----------|-------------|---------|
| `THREADS_ACCESS_TOKEN` | A long-lived access token from the Meta Threads API. | (empty — crossposting disabled) |
| `THREADS_USER_ID` | Your Threads user ID (numeric). | (empty) |

### Optional: Email (SMTP)

Email is used for DayOne journal crossposting and future account recovery features.

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_HOST` | SMTP server hostname. | (empty) |
| `SMTP_PORT` | SMTP server port. Use `587` for STARTTLS, `465` for implicit TLS. | `587` |
| `SMTP_USER` | SMTP username (usually your email address). | (empty) |
| `SMTP_PASS` | SMTP password or app-specific password. | (empty) |
| `DAYONE_EMAIL` | The email address DayOne uses for email-to-journal imports. | (empty) |

## Site Config File

The file `site.config.ts` in the project root defines additional configuration that merges environment variables with defaults. Most values here are derived from the env vars above, but you can also edit it directly if you prefer.

Key properties:

```typescript
export const siteConfig = {
  name: process.env.SITE_NAME || "My FediHome",
  url: siteUrl,
  description: process.env.SITE_DESCRIPTION || "...",
  authorName: process.env.AUTHOR_NAME || "Your Name",
  authorBio: process.env.AUTHOR_BIO || "",
  authorTagline: process.env.AUTHOR_TAGLINE || "",
  contactEmail: process.env.CONTACT_EMAIL || "",
  fediHandle,
  fediDomain,
  fediAddress: `@${fediHandle}@${fediDomain}`,
  actorSummary: process.env.ACTOR_SUMMARY || "...",
  avatarPath: "/images/avatar.png",
  bannerPath: "/images/banner.webp",
  ogImagePath: "/images/og-image.webp",
  nav: {
    showJournal: true,
    showArticles: true,
    showPhotography: true,
    showAbout: true,
  },
};
```

## Admin Panel Settings

Some settings are stored in the database (`SiteSettings` table) and managed through the admin panel or setup wizard:

| Setting | Description |
|---------|-------------|
| Site Name | Overrides `SITE_NAME` env var when set via wizard |
| Author Name | Display name for the site owner |
| Author Bio | Longer bio text |
| Author Tagline | Short tagline under the name |
| Contact Email | Public-facing email |
| Accent Color | The primary accent color used throughout the UI (default: `#3b82f6`, a medium blue) |

Changes made in the admin panel are saved to the database and take effect immediately without restarting the server.

## Navigation Configuration

The `nav` object in `site.config.ts` controls which top-level pages appear in the navbar:

```typescript
nav: {
  showJournal: true,      // /journal page
  showArticles: true,     // /articles page
  showPhotography: true,  // /photography page
  showAbout: true,        // /about page
}
```

Set any of these to `false` to hide that section from the navigation. The corresponding routes will still work if accessed directly, but the nav link will not appear.

## macOS App Download

FediHome has a native menu-bar Mac app. When enabled, a **Download** nav link, a homepage hero CTA, and a `/download` marketing page appear. It's **off by default** — a personal instance isn't advertising an app it may not use — and is intended for the public demo.

| Env var | Default | Purpose |
|---------|---------|---------|
| `DOWNLOAD_MACOS_ENABLED` | `false` | Show the Download link, hero CTA, and `/download` page. |
| `DOWNLOAD_MACOS_RELEASE_URL` | the app repo's GitHub Releases `latest` | Primary download — always the newest notarized build. Prefer `releases/latest` over a pinned tag so it auto-tracks new versions. |
| `DOWNLOAD_MACOS_APP_STORE_URL` | *(empty)* | Optional Mac App Store listing. When set, a "Download on the Mac App Store" button appears alongside the GitHub download; until then that slot shows a "coming soon" placeholder. |

All three are also editable at runtime from **Admin → Site settings** (they overlay the env defaults, no restart).

## Assets

Place your site assets in the `public/` directory:

| File | Purpose |
|------|---------|
| `public/images/avatar.png` | Your profile picture. Shown in the navbar, about page, and as your ActivityPub icon. |
| `public/images/banner.webp` | Banner image for the homepage and ActivityPub profile header. |
| `public/images/og-image.webp` | Default Open Graph image used when sharing links without a specific cover image. |
| `public/fonts/` | Custom font files (Inter and Source Serif 4 are included by default). |

## Database

FediHome uses PostgreSQL via Prisma. The connection string is set in `DATABASE_URL`.

### Creating the Database

If you don't have a database yet:

```bash
# macOS with Homebrew
brew install postgresql@15
brew services start postgresql@15
createdb fedihome

# Linux
sudo -u postgres createdb fedihome
```

> **PostgreSQL 15+:** the `public` schema no longer grants `CREATE` implicitly, so a role that doesn't **own** the database can't run `prisma db push` (it fails with `permission denied for schema public`). Create the database owned by your app role (`createdb -O fedihome fedihome`, or `CREATE DATABASE fedihome OWNER fedihome;`), or grant it explicitly: `sudo -u postgres psql -d fedihome -c 'GRANT ALL ON SCHEMA public TO fedihome;'`. The `install.sh` auto-create path handles this for you.

> **Installing alongside an existing PostgreSQL?** `install.sh` defaults to a `fedihome` database + role, but **`DB_NAME`, `DB_USER`, `PGHOST` and `PGPORT` are all overridable** via environment variables — e.g. `DB_NAME=myblog DB_USER=myblog bash install.sh`. If a role or database with the chosen name already exists, the installer **asks before reusing it** and never silently resets an existing role's password. For managed Postgres (RDS / Supabase / Neon) where you can't own the database, use the installer's "paste a connection URL" option and make sure the role has `CREATE` on schema `public`.

### Syncing the Schema

FediHome doesn't track migration files — `prisma/schema.prisma` is the source
of truth and `prisma db push` syncs your database to it.

After pulling updates that include schema changes (look for a "Schema" entry
in the changelog), run:

```bash
npx prisma db push
```

`db push` is additive-safe: Prisma refuses any push that would drop data
unless you pass `--accept-data-loss`, so it's safe on production databases
with real content.

If you change `schema.prisma` yourself while developing, run the same
command — it'll sync the local database to your edits.

### Inspecting the Database

```bash
npx prisma studio
```

This opens a web UI at `http://localhost:5555` where you can browse and edit all tables.
