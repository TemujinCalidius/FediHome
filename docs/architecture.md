# Architecture

This document gives an overview of FediHome's codebase for developers who want to understand how things work or contribute new features.

## Tech Stack

- **Next.js 16** with the App Router
- **React 19** for UI components
- **TypeScript** in strict mode
- **Prisma** ORM with PostgreSQL
- **Tailwind CSS 4** for styling
- **AT Protocol** (`@atproto/api`) for Bluesky crossposting
- **HTTP Signatures** (custom implementation) for ActivityPub federation

## Directory Structure

```
fedihome/
  prisma/
    schema.prisma          # Database schema — all models defined here
  public/
    fonts/                 # Inter, Source Serif 4 woff2 files
    images/                # avatar.png, banner.webp, og-image.webp
    uploads/               # User-uploaded media (photos, images)
  scripts/
    cleanup-fedi-media.ts  # Maintenance script to clean old cached fedi media
  src/
    app/                   # Next.js App Router pages and API routes
      .well-known/
        webfinger/route.ts # WebFinger endpoint for Fediverse discovery
      about/page.tsx       # About page
      ap/                  # ActivityPub protocol endpoints
        actor/route.ts     # Actor profile (Person object)
        inbox/route.ts     # Inbox — receives Follow, Like, Boost, Note, DM
        outbox/route.ts    # Outbox — lists published activities
        followers/route.ts # Followers collection
        following/route.ts # Following collection
        post/[slug]/route.ts # Individual post as AP object
      api/                 # Internal API routes (admin-only or token-auth)
        admin/
          login/route.ts   # Admin login
          route.ts         # Admin settings CRUD
        bluesky-dms/route.ts    # Fetch Bluesky DMs
        bluesky-replies/route.ts # Fetch Bluesky replies
        comments/route.ts       # Guest comment submission
        compose/route.ts        # Create post from admin panel
        conversation/route.ts   # Thread/conversation API
        feed/route.ts           # Timeline feed for followed accounts
        media/route.ts          # Media upload endpoint (Micropub)
        micropub/route.ts       # Micropub protocol endpoint
        notifications/route.ts  # Notification feed
      articles/page.tsx    # Articles listing page
      compose/             # Admin compose UI
        page.tsx
        ComposeClient.tsx
      feed.xml/route.ts    # RSS feed
      journal/page.tsx     # Journal listing page
      photography/
        page.tsx           # Photo gallery grid
        [slug]/page.tsx    # Individual photo page
      post/[slug]/page.tsx # Individual post page
      rsd.xml/route.ts     # RSD (Really Simple Discovery) for MetaWeblog
      timeline/
        page.tsx           # Fediverse timeline
        TimelineClient.tsx # Client component for timeline
        TimelineLogin.tsx  # Login prompt for timeline
      uploads/[...path]/route.ts # Serve uploaded files
      users/[username]/page.tsx  # Remote user profile view
      layout.tsx           # Root layout (Navbar, Footer, metadata)
      page.tsx             # Homepage
      globals.css          # Theme variables, fonts, component classes
    components/
      blog/
        PostCard.tsx        # Post card for listings
      fedi/
        FediInteractions.tsx # Like/boost/reply display
        GuestCommentForm.tsx # Guest comment form
      layout/
        Navbar.tsx          # Top navigation bar
        Footer.tsx          # Site footer
        NotificationBell.tsx # Notification indicator
      photography/
        PhotoGrid.tsx       # Photo gallery grid component
      ui/
        Lightbox.tsx        # Full-screen photo lightbox
        Pagination.tsx      # Page navigation
    lib/
      auth.ts              # Token hashing, Micropub auth, admin verification
      bluesky-dm-poll.ts   # Poll Bluesky for new DMs
      bluesky-poll.ts      # Poll Bluesky for reply counts
      crosspost.ts         # Bluesky, Threads, DayOne crossposting
      db.ts                # Prisma client singleton
      fedi-media.ts        # Download/process media from federated posts
      federation.ts        # Actor profile, key generation, federation init
      http-signatures.ts   # HTTP Signature signing, verification, delivery
      sanitize.ts          # HTML sanitization for incoming federated content
    middleware.ts          # Next.js middleware
  docker-compose.yml       # Docker Compose for app + PostgreSQL
  Dockerfile               # Multi-stage Docker build
  ecosystem.config.cjs     # PM2 process manager config
  install.sh               # One-command install script
  next.config.ts           # Next.js configuration
  site.config.ts           # Site-wide configuration (reads env vars)
  tsconfig.json            # TypeScript configuration
```

## How ActivityPub Works in This Codebase

FediHome implements ActivityPub directly — there is no external federation library handling the protocol at runtime. The implementation is spread across a few key files:

### Identity and Discovery

- **`src/app/.well-known/webfinger/route.ts`** — Handles WebFinger lookups. When a Mastodon server wants to find `@handle@domain`, it queries this endpoint. Returns a JSON document pointing to the actor URL.

- **`src/lib/federation.ts`** — Defines the actor profile (the Person object). Generates and manages the RSA key pair stored in the `ActorKeys` table. The actor profile includes the public key, inbox/outbox URLs, avatar, and bio.

- **`src/app/ap/actor/route.ts`** — Serves the actor profile as `application/activity+json`.

### Receiving Activities

- **`src/app/ap/inbox/route.ts`** — The inbox receives all incoming ActivityPub activities. It verifies HTTP signatures, then dispatches based on activity type:
  - **Follow** — Stores the follower, auto-sends Accept back
  - **Undo Follow** — Removes the follower
  - **Like** — Records the interaction, increments like count
  - **Undo Like** — Reverses the like
  - **Announce (Boost)** — Records the interaction, increments boost count, fetches the original post for timeline display
  - **Create Note** — Either stores as a timeline post (if from someone you follow), as a reply interaction (if replying to your content), or as a DM (if addressed privately to you)
  - **Delete** — Handled silently
  - **Accept** — Acknowledgement that a follow request was accepted

### Sending Activities

- **`src/lib/http-signatures.ts`** — The core delivery system. Contains:
  - `signedFetch()` — Signs an HTTP request with HTTP Signatures (RSA-SHA256) and sends it
  - `deliverActivity()` — Delivers a single activity to one inbox
  - `deliverToFollowers()` — Fetches all followers, deduplicates by shared inbox, and delivers in parallel
  - `verifyIncomingSignature()` — Verifies signatures on incoming inbox requests

### Publishing and Federation

When a post is created (via the admin compose UI or Micropub), the flow is:

1. Post is saved to the `Post` table with an `apId` like `https://domain/post/slug`
2. A Create activity is constructed wrapping the post as a Note or Article
3. `deliverToFollowers()` signs and delivers the activity to all follower inboxes
4. Crossposting to Bluesky/Threads happens in parallel

This logic lives in:
- `src/app/api/compose/route.ts` — Admin panel publishing
- `src/app/api/micropub/route.ts` — Micropub publishing

Both endpoints follow the same pattern: create the post, build the AP activity, deliver to followers, crosspost.

## Database Schema Overview

The Prisma schema (`prisma/schema.prisma`) defines these models:

### Content

| Model | Purpose |
|-------|---------|
| `Post` | Blog posts, notes, and journal entries. Has Markdown content, optional title, category (note/article/journal), photos, tags, and cached interaction counts. |
| `Photo` | Photography gallery entries. Has image path, EXIF data (JSON), category, and interaction counts. |
| `GuestComment` | Comments from visitors. Linked to a Post or Photo. Has moderation status (pending/approved/rejected). |

### Fediverse

| Model | Purpose |
|-------|---------|
| `FediFollower` | People who follow you. Stores their actor URI, inbox URL, display info. |
| `FediFollowing` | People you follow. Same structure as followers. |
| `FediPost` | Posts from people you follow, displayed in your timeline. Includes media URLs, link embeds, boost info, and conversation threading. |
| `FediInteraction` | Likes, boosts, and replies on your content from remote users. |

### Bluesky

| Model | Purpose |
|-------|---------|
| `BlueskyReply` | Replies to your crossposted Bluesky posts. Fetched by polling. |

### Messaging

| Model | Purpose |
|-------|---------|
| `DirectMessage` | DMs from both Fediverse (ActivityPub private Notes) and Bluesky. Grouped by `conversationKey`. |

### System

| Model | Purpose |
|-------|---------|
| `ActorKeys` | RSA key pair for signing ActivityPub requests. Single row, created on first run. |
| `AuthToken` | Micropub bearer tokens. Stores SHA-256 hash, label, scope, last used timestamp. |
| `SiteSettings` | Site configuration from the setup wizard: name, bio, accent color, etc. |

## How Posts Are Created and Federated

Here is the full lifecycle of a post:

1. **User writes content** in the compose page or a Micropub client
2. **API route** (`/api/compose` or `/api/micropub`) receives the request
3. **Slug is generated** from the title (articles) or first few words + timestamp (notes)
4. **Content is rendered** to HTML — Markdown for articles, plain text with auto-linked URLs for notes
5. **Post is saved** to the database with `apId = https://domain/post/slug`
6. **ActivityPub Create activity** is constructed with the post as the `object`
7. **Hashtags** are extracted and included as AP Tag objects
8. **Photos** are included as AP Image attachments with MIME types
9. **`deliverToFollowers()`** sends the signed activity to all follower inboxes in parallel
10. **Crossposting** to Bluesky/Threads/DayOne happens concurrently
11. **Bluesky URI** is saved back to the post if crossposting succeeds

## Adding New Features

### Adding a New Page

1. Create a new directory under `src/app/` (e.g., `src/app/links/`)
2. Add a `page.tsx` with a default export React component
3. If it needs data, fetch from Prisma directly in the server component
4. Add a nav link by updating `site.config.ts` nav options and `Navbar.tsx`

### Adding a New API Route

1. Create a new directory under `src/app/api/` (e.g., `src/app/api/bookmarks/`)
2. Add a `route.ts` with exported handler functions (`GET`, `POST`, etc.)
3. Use `verifyAdmin()` for admin-only endpoints or `verifyMicropubToken()` for token-based auth

### Adding a New Database Model

1. Add the model to `prisma/schema.prisma`
2. Run `npx prisma db push` to sync your local database (FediHome doesn't track migration files; the schema is the source of truth)
3. Run `npx prisma generate` if your editor's typed client doesn't auto-update
4. Document the change in `CHANGELOG.md` under a "Schema" heading so operators know to run `db push` when upgrading
5. If the change adds a **unique constraint** to an existing table, `db push` can't apply it flaglessly (it demands `--accept-data-loss`). Either enforce uniqueness in app code, or add an idempotent `prisma/manual-migrations/<date>-<name>.sql` (`CREATE UNIQUE INDEX IF NOT EXISTS …`) — `update.sh` applies these before `db push` on upgrade, so `db push` then sees no diff. (A new *table* or *nullable column* needs no SQL file; `db push` adds those without warning.)

### Adding a New Crosspost Target

1. Add a new function in `src/lib/crosspost.ts` following the pattern of `crosspostToBluesky()` or `crosspostToThreads()`
2. Add the required env vars to `.env.example`
3. Call the function from `src/app/api/compose/route.ts` alongside the existing crosspost calls
4. Add a toggle in the compose UI (`ComposeClient.tsx`)

### Handling a New ActivityPub Activity Type

1. Add a new case in the `switch (type)` block in `src/app/ap/inbox/route.ts`
2. Create a handler function (e.g., `handleFlag()`, `handleMove()`)
3. Store any relevant data in the database
