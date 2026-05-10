# Getting Started

This guide walks you through installing FediHome, running the setup wizard, making your first post, and connecting to the Fediverse. It should take about 10 minutes.

## Step 1: Install FediHome

Choose one of three installation methods.

### Option A: Script Install (Easiest)

The install script checks prerequisites, clones the repo, installs dependencies, and walks you through database configuration.

```bash
curl -sSL https://raw.githubusercontent.com/TemujinCalidius/fedihome/main/install.sh | bash
```

The script will:
1. Verify Node.js 20+, npm, git, and PostgreSQL are installed
2. Clone the FediHome repository
3. Run `npm install`
4. Copy `.env.example` to `.env.local`
5. Generate an admin secret
6. Prompt you for your PostgreSQL connection URL
7. Run database migrations
8. Build the production app

When it finishes, start the server:

```bash
cd fedihome
npm start
```

### Option B: Manual Install

```bash
git clone https://github.com/TemujinCalidius/fedihome.git
cd fedihome
npm install
cp .env.example .env.local
```

Edit `.env.local` and set your database URL:

```
DATABASE_URL=postgresql://user:password@localhost:5432/fedihome
```

Then set up the database and build:

```bash
npx prisma db push
npm run build
npm start
```

> `prisma db push` syncs your database to `prisma/schema.prisma`. FediHome
> doesn't ship migration files; the schema is the source of truth and
> `db push` is run once at install and again after each upgrade. Prisma
> refuses any push that would drop data unless you pass `--accept-data-loss`,
> so it's safe to run on existing databases.

### Option C: Docker

```bash
git clone https://github.com/TemujinCalidius/fedihome.git
cd fedihome
cp .env.example .env.local
```

Edit `.env.local` with your settings (the Docker Compose file provides its own `DATABASE_URL`, so you can leave that as-is if using the bundled PostgreSQL container).

```bash
docker compose up -d
```

This starts both the FediHome app and a PostgreSQL 15 database. The app is available on port 3000.

## Step 2: Run the Setup Wizard

Open your browser and go to:

```
http://localhost:3000/setup
```

(Or port 3001 if using `npm run dev`.)

The setup wizard asks for:

- **Site name** — The title shown in the navbar and page titles (e.g., "Sam's Corner")
- **Your name** — Displayed as the author on posts
- **Tagline** — A short line shown under your name on the homepage
- **Bio** — A longer description for the About page
- **Fediverse handle** — Your preferred username (the `@handle` part of `@handle@yourdomain.com`)
- **Domain** — Your public domain name (e.g., `samcorner.com`)
- **Site URL** — The full public URL (e.g., `https://samcorner.com`)

The wizard saves these settings to the database and generates your ActivityPub actor keys (an RSA key pair used to sign federation messages).

## Step 3: Make Your First Post

1. Log into the admin panel by visiting `/compose`. You'll need the `ADMIN_SECRET` from your `.env.local` file.
2. Type something in the compose box. For a short update, just write text (this creates a **Note**). To write a longer blog post, add a title (this creates an **Article** with full Markdown support).
3. Attach photos by uploading images. They'll be included in the post and crossposted with it.
4. Toggle crossposting options (Bluesky, Threads, DayOne) if you have them configured.
5. Hit **Publish**.

Your post is now:
- Visible on your site at `/post/your-slug`
- Federated to all your ActivityPub followers
- Included in your RSS feed at `/feed.xml`
- Crossposted to any connected services

## Step 4: Follow Someone on Mastodon

FediHome includes a timeline where you can read posts from people you follow across the Fediverse.

1. Go to your timeline page at `/timeline`.
2. Log in with your admin secret.
3. Enter a Fediverse address to follow, like `@someone@mastodon.social`.
4. FediHome sends a Follow request via ActivityPub. Once accepted, their posts will appear in your timeline.

You can also be followed: anyone on Mastodon, Pixelfed, Misskey, or another ActivityPub platform can search for `@yourhandle@yourdomain.com` and follow you. Your posts will appear in their home feed.

## Step 5: Share Your FediHome Address

Your Fediverse identity is:

```
@yourhandle@yourdomain.com
```

Share this anywhere. People can paste it into the search bar of any Mastodon, Pixelfed, or Misskey instance to find your profile and follow you.

You can verify it works by testing WebFinger:

```bash
curl "https://yourdomain.com/.well-known/webfinger?resource=acct:yourhandle@yourdomain.com"
```

You should get back a JSON response with your actor URL.

## What's Next?

- **Set up a custom domain** — See [Deployment](deployment.md) for production setup with nginx or Cloudflare Tunnel
- **Configure Bluesky crossposting** — See [Bluesky Integration](bluesky-integration.md)
- **Post from your phone or desktop** — See [Micropub](micropub.md) for using iA Writer, micro.blog, and other apps
- **Customize the look** — See [Theming](theming.md) for changing colors, fonts, and CSS
- **Understand every setting** — See [Configuration](configuration.md)
