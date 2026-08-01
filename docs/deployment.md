# Deployment

This guide covers deploying FediHome to production. FediHome is a Node.js app that needs PostgreSQL and a public domain with HTTPS.

## Overview of Options

| Method | Best For | Complexity |
|--------|----------|------------|
| Home server + Cloudflare Tunnel | Privacy-focused users, free hosting | Low |
| VPS + nginx + Let's Encrypt | Full control, traditional hosting | Medium |
| Docker on any server | Reproducible, isolated deployments | Low-Medium |

## Option 1: Home Server with Cloudflare Tunnel (Recommended)

This is the recommended approach for most users. Your FediHome runs on a computer at home (a Mac Mini, Raspberry Pi, old laptop, etc.) and Cloudflare Tunnel exposes it to the internet without opening any ports on your router. Your home IP address is never exposed.

See the full guide: [Cloudflare Tunnel](cloudflare-tunnel.md)

**Summary:**
1. Install FediHome on your home machine
2. Add your domain to Cloudflare (free plan)
3. Install `cloudflared` and create a tunnel
4. Point the tunnel at `http://localhost:3000`
5. Run `cloudflared` as a system service

## Option 2: VPS with nginx + Let's Encrypt

### 1. Provision a VPS

Any Linux VPS works. Recommended specs:
- 1 CPU core, 1 GB RAM minimum (2 GB recommended)
- 20 GB disk
- Ubuntu 22.04 or 24.04

Providers: Hetzner, DigitalOcean, Linode, Vultr, etc.

### 2. Install Prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql

# Create database and user (OWNER fedihome → the role can run `prisma db push` on PG15+)
sudo -u postgres psql -c "CREATE USER fedihome WITH PASSWORD 'your-secure-password';"
sudo -u postgres psql -c "CREATE DATABASE fedihome OWNER fedihome;"
# Managed/external Postgres where the role can't own the DB? Also grant CREATE on schema public:
#   sudo -u postgres psql -d fedihome -c "GRANT ALL ON SCHEMA public TO fedihome;"

# Install nginx
sudo apt install -y nginx

# Install certbot for Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx
```

### 3. Install FediHome

```bash
cd /opt
sudo git clone https://github.com/TemujinCalidius/fedihome.git
sudo chown -R $USER:$USER /opt/fedihome
cd /opt/fedihome
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```
DATABASE_URL=postgresql://fedihome:your-secure-password@localhost:5432/fedihome
SITE_URL=https://yourdomain.com
ADMIN_SECRET=$(openssl rand -hex 32)
FEDI_HANDLE=yourhandle
FEDI_DOMAIN=yourdomain.com
```

Push the schema and build:

```bash
npx prisma db push
npm run build
```

### 4. Configure nginx

Create `/etc/nginx/sites-available/fedihome`:

```nginx
server {
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # ActivityPub responses can be large
        client_max_body_size 50M;
    }
}
```

Enable the site and get an SSL certificate:

```bash
sudo ln -s /etc/nginx/sites-available/fedihome /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certificate (follow the prompts)
sudo certbot --nginx -d yourdomain.com
```

Certbot will automatically configure HTTPS and set up auto-renewal.

### 5. Set Up PM2 for Process Management

PM2 keeps FediHome running and restarts it after crashes or reboots.

```bash
sudo npm install -g pm2

cd /opt/fedihome
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

The `ecosystem.config.cjs` file is included in the repo and configures PM2 with:
- Production `NODE_ENV`
- Auto-restart on crash (up to 10 restarts)
- 5-second restart delay

**Background jobs need no extra process.** FediHome's scheduler — publishing
**scheduled posts** at their time, running the Bluesky sync, and checking daily
for updates and security advisories — runs *inside* the app itself and starts
automatically with it (any deployment: PM2, plain `npm start`, or Docker). No
cron entry is needed; the old `scripts/scheduled-bluesky-sync.ts` cron is
obsolete — if you had it in crontab/PM2, remove it. Cadences/toggles are
configurable in **Admin → Instance settings** and via the `SCHEDULER_*` env vars
(see `.env.example`); look for a `scheduler: starting (in-app)` line in the app
log at boot.

The update check makes outbound requests to the npm registry and the GitHub API
and reports what it finds in your notifications. It's on daily by default,
remembers when it last ran (so restarting doesn't re-run it and doesn't skip a
due one), and can be turned off entirely with
`SCHEDULER_UPDATE_CHECK_ENABLED=false` or the toggle in Instance settings, which
also has a **Check now** button.

Check status:

```bash
pm2 status                 # fedihome should be "online"
pm2 logs fedihome          # includes the scheduler's log lines
```

## Option 3: Docker Deployment

### Standalone Docker

```bash
git clone https://github.com/TemujinCalidius/fedihome.git
cd fedihome
cp .env.example .env.local
# Edit .env.local with your settings
```

The included `docker-compose.yml` runs both FediHome and PostgreSQL:

```bash
docker compose up -d
```

This starts:
- **app** — FediHome on port 3000, with `./public/uploads` bind-mounted so your media lives on the host
- **db** — PostgreSQL 15 on an internal network with a persistent volume

To use an external PostgreSQL database instead, set `DATABASE_URL` in `.env.local` and remove the `db` service from `docker-compose.yml`.

> **Set `ADMIN_SECRET` in the host's `.env.local` before you run setup.**
> Compose reads `.env.local` from the **host**, but the setup wizard writes to `.env.local`
> **inside** the container — two different files. If you let the wizard generate the secret and
> don't copy it to the host file, the container loses it the next time it's rebuilt while the
> database still records setup as complete, and you're locked out of admin. The wizard warns you
> about this if it detects it's running in a container.

**Two things live outside the database and must both be preserved:**

| What | Where | Persisted by |
|---|---|---|
| Posts, followers, comments, settings, **federation keys** | PostgreSQL | the `pgdata` volume |
| Uploaded images, photos, audio, cached feed media | `public/uploads/` | the `./public/uploads` bind mount |

Without that bind mount, every uploaded file lives only in the container's writable layer and is
destroyed whenever the container is replaced — including by a plain host reboot. The database
survives either way, and because it stores file *paths* rather than the files themselves, the site
would come back looking intact with every image and audio player returning 404.

### Docker Behind nginx

If you want nginx + Let's Encrypt in front of Docker, set up nginx as described in Option 2, but point the proxy at the Docker container's port:

```nginx
proxy_pass http://127.0.0.1:3000;
```

### Updating with Docker

> ### ⚠️ Upgrading a Docker install from before v1.18.0 — do this FIRST
>
> Before v1.18.0 the `app` service had no volume, so all your uploads live **inside** the running
> container. v1.18.0 adds a `./public/uploads` bind mount — and a bind mount **shadows** whatever is
> already at that path, so pulling the update and restarting would hide your existing files and then
> destroy them on the next rebuild.
>
> **Copy them out to the host before you rebuild:**
>
> ```bash
> cd /path/to/fedihome
> docker compose cp app:/app/public/uploads ./public/uploads
> ls public/uploads          # confirm your files are there
> ```
>
> Only then `git pull` and rebuild. If you've already rebuilt without doing this and the old
> container is gone, those files are unrecoverable — restore them from a backup.
>
> This is a one-time step. Fresh v1.18.0+ installs need nothing.

```bash
cd /path/to/fedihome
git pull
docker compose build
docker compose up -d
```

## Backups

> **A database dump on its own is NOT a complete backup.** Your instance has three
> pieces of state, and only one of them is in PostgreSQL:
>
> | What | Where | Lose it and… |
> |---|---|---|
> | Posts, followers, comments, settings, **federation keys** | PostgreSQL | everything goes |
> | Uploaded images, photos, audio, cached feed media | `public/uploads/` | posts survive but every image and audio player 404s |
> | **`ADMIN_SECRET`** | `.env.local` | you can't log in, and every saved credential becomes unreadable |
>
> The database stores file **paths**, not the files. So restoring a `pg_dump` alone
> gives you back a site that *looks* intact with every piece of media missing.
>
> **⚠️ `ADMIN_SECRET` is not in the database at all.** It's your login *and* the key
> that encrypts every credential you've saved — your Bluesky app password, Threads
> token, Tinylytics key, and the Web Push signing key. Restore a database onto a host
> with a freshly generated secret and all four become permanently undecryptable:
> push notifications stop arriving and crossposting stops happening, while the admin
> panel still shows them as configured. FediHome now detects this and raises an alert
> naming exactly what needs re-entering — but the credentials themselves are gone.
> Back up `.env.local` alongside your database.
>
> **⚠️ The single most important row is `ActorKeys`** — your ActivityPub signing keypair.
> It's what proves posts came from you. Restore a dump without it and your instance
> generates a *new* identity: existing followers hold your old public key, so your
> posts may stop verifying on remote servers. A plain `pg_dump` includes it; a
> "content-only" or selective dump may not. FediHome will warn you loudly in the logs
> and in the admin panel if it ever detects this has happened.

### Manual Backup

Both halves:

```bash
# 1. Database (includes ActorKeys)
pg_dump -U fedihome -h localhost fedihome > backup-$(date +%Y%m%d).sql

# 2. Uploaded media
tar czf uploads-$(date +%Y%m%d).tar.gz public/uploads/
```

### Automated Daily Backup

Create a cron job:

```bash
crontab -e
```

Add:

```
0 3 * * * pg_dump -U fedihome -h localhost fedihome | gzip > /backups/fedihome-$(date +\%Y\%m\%d).sql.gz
15 3 * * * tar czf /backups/uploads-$(date +\%Y\%m\%d).tar.gz -C /path/to/fedihome public/uploads
```

This backs up the database at 3 AM and your media just after.

### Docker Backup

```bash
# Database
docker compose exec db pg_dump -U fedihome fedihome > backup-$(date +%Y%m%d).sql

# Media — bind-mounted to the host, so back it up from the checkout
tar czf uploads-$(date +%Y%m%d).tar.gz public/uploads/
```

### Restoring

Restore **both**, or your media links will dangle:

```bash
# 1. Database
psql -U fedihome -h localhost fedihome < backup-20260401.sql

# 2. Media
tar xzf uploads-20260401.tar.gz          # restores into public/uploads/
```

After restoring, check the admin notifications. If FediHome reports that your
federation identity was regenerated, the restore didn't carry the `ActorKeys`
row — restore that row from the dump to recover your original identity before
posting again.

### Migrating to a new host

Same two pieces: dump and restore the database, and copy `public/uploads/`
across. Keep `.env.local` too — it holds your `ADMIN_SECRET` and any crossposting
credentials.

## DNS Configuration

Point your domain to your server:

| Record Type | Name | Value |
|-------------|------|-------|
| A | `@` | Your server's IP address |
| AAAA | `@` | Your server's IPv6 address (if available) |

If using Cloudflare Tunnel, see [Cloudflare Tunnel](cloudflare-tunnel.md) instead — DNS is configured automatically.

## Updating FediHome

How you update depends on how you installed, and the bundled updater only covers
one of the three:

| Install | Update with |
| --- | --- |
| `git clone` (Options 1 and 2 above) | `npm run update` |
| Docker | `docker compose pull && docker compose up -d`, **on the host** |
| Release archive (no git history) | unpack the new release, then the manual steps below |

A container **cannot** update itself: the image has no git history, no Docker
socket, and runs unprivileged. `npm run update` inside one refuses and tells you
this. FediHome's own update alerts link you to the release rather than assuming a
git checkout.

**If your image is rolled by a platform or orchestrator** — Kubernetes, Nomad,
Swarm, Fly, Render, any PaaS — neither of those instructions fits: there is no
host to run `docker compose` on. Two environment variables let you say what
should happen instead, and no detection can work this out for you:

| Variable | Effect |
| --- | --- |
| `FEDIHOME_UPDATE_TEXT` | Replaces the "to apply it, run…" sentence with your own. |
| `FEDIHOME_UPDATE_URL` | Points the update alert's link at your deploy pipeline, runbook or control plane instead of the GitHub compare view. |

`FEDIHOME_UPDATE_URL` is the more useful of the two today, because the alert in
the notification bell is a link — clicking it is the action. It applies only to
FediHome's own update alerts; dependency and security-advisory alerts keep
pointing at npm and the advisory, since those links are the evidence rather than
the action.

For a git checkout, the bundled updater handles git pull, dependency install,
schema migration, rebuild, and restart in one command:

```bash
cd /opt/fedihome    # or wherever you installed it
npm run update
```

It auto-detects how FediHome is running (pm2, systemd, or docker compose) and restarts it after the build. Before pulling, it shows you the new commit log and asks for confirmation.

If you'd rather run the steps manually:

```bash
cd /opt/fedihome
git pull
npm install
npm run migrate        # hand-written migrations — see the note below
npx prisma db push
npm run migrate        # again, for anything that needed a table db push just made
npm run build
pm2 restart fedihome
```

`npm run migrate` is easy to miss and `npm run update` does it for you, which is
why the bundled updater is the recommended path. It runs either side of
`db push` on purpose: the first pass prepares the schema so `db push` never hits
its data-loss guard, and the second catches anything that needed a table
`db push` had yet to create. Both passes are no-ops once applied — every file is
recorded in the `ManualMigration` table.

For Docker (manual):

```bash
git pull
docker compose build
docker compose up -d
```
