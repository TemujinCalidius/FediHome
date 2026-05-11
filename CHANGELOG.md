# Changelog

## 0.1.14 (2026-05-12)

### Added
- **Unified Bluesky + Fediverse followers/following in the admin Timeline.** The header counts beside the **+ Compose** button (`src/app/timeline/page.tsx`) now show the combined total across both networks. The **Followers** and **Following** tabs render a single merged list sorted by `createdAt` desc, with a small `bsky` pill on Bluesky rows; profile links route to `https://bsky.app/profile/{handle}` for Bluesky entries. Each tab gains a **Sync Bluesky** button that pulls the live graph from the AT Protocol (`getFollowers` + `getFollows`, paginated 100/page) and reconciles it into the local DB — rows whose DID is not seen during sync are deleted so unfollows propagate. **Follow Back** on a Bluesky follower not yet in the following list creates a real `app.bsky.graph.follow` record. **Unfollow** on a Bluesky following row calls `agent.deleteFollow()` against the stored follow-record URI. The Follow form in the Following tab now accepts either a Fediverse handle (`@user@domain`) or a Bluesky handle/DID (`name.bsky.social`, `did:plc:...`) — handler classifies via a `@user@host.tld` regex and routes to the right backend action. Empty-state copy in the Followers tab now uses `siteConfig.fediAddress` instead of a hardcoded handle (a stray personal handle had been carried over in past releases; sanitized in this release).
- **Daily scheduled Bluesky sync.** New `scripts/scheduled-bluesky-sync.ts` runs `syncBlueskyGraph()` and `pollBlueskyDMs()` once and exits. Intended to be wired up as a PM2 cron entry — script header documents the `pm2 start ... --cron-restart "0 3 * * *" --no-autorestart` invocation — or via system crontab. Manual one-shot: `npx tsx --env-file=.env.local scripts/scheduled-bluesky-sync.ts`. Not auto-installed; operators run the `pm2 start` command once on the host (then `pm2 save`).

### Fixed
- **Bluesky chat (DM) endpoints now use the required proxy header.** `pollBlueskyDMs()` (`src/lib/bluesky-dm-poll.ts`) and the `bsky_dm_reply` admin action (`src/app/api/admin/route.ts`) were calling `agent.api.chat.bsky.convo.*` against `bsky.social` directly, which returns HTTP 501 `MethodNotImplemented`. Both now route via `agent.withProxy("bsky_chat", "did:web:api.bsky.chat")`. Without this, the manual "Poll Bluesky" button and outgoing Bluesky DM replies were silently broken — verified by reproducing the 501 from a standalone runner. The same fix lets `scheduled-bluesky-sync.ts` actually pull DMs.

### Schema
- Two new Prisma models: `BlueskyFollower` and `BlueskyFollowing` (the latter carries a nullable `followUri` for the AT URI of our follow record, required to call `deleteFollow`). Apply with `npx prisma db push`. Existing tables are untouched.

### Files
- New `src/lib/bluesky-graph.ts` — `syncBlueskyGraph()` paginates `getFollowers` / `getFollows` and reconciles the local mirrors with prune-on-miss; `followBlueskyAccount()` / `unfollowBlueskyAccount()` create and undo follow records, persisting the AT URI returned from `agent.follow()`; `resolveBlueskyActor()` turns a handle (or DID) into a DID via `agent.resolveHandle`.
- New `scripts/scheduled-bluesky-sync.ts` — standalone tsx script for cron use.
- `src/app/api/admin/route.ts` — three new actions: `sync_bluesky_graph`, `bsky_follow` (accepts `did` or `handleOrDid`), `bsky_unfollow` (by local `followingId`, returns 422 if the row lacks `followUri`). DM-reply proxy header fix in the `bsky_dm_reply` branch.
- `src/lib/bluesky-dm-poll.ts` — chat-service proxy header on `listConvos` / `getMessages`.
- `src/app/timeline/page.tsx` — loads `blueskyFollower` / `blueskyFollowing` alongside the Fedi tables, builds discriminated-union merged arrays sorted by `createdAt` desc, derives `totalFollowerCount` / `totalFollowingCount` for the header, and passes `siteConfig.fediAddress` through to the client.
- `src/app/timeline/TimelineClient.tsx` — `FollowerItem` / `FollowingItem` are now `{ source: "fedi" } | { source: "bsky" }` unions; both tab renderers branch on `source` for the identity row, profile link, Follow Back / Unfollow targets, and Sync Bluesky button. The Follow form's submit handler detects `@user@domain` via regex and falls back to `bsky_follow` otherwise. Accepts a new `fediAddress` prop used in the empty-state copy.

## 0.1.13 (2026-05-11)

### Fixed
- **New installs would never create database tables.** `install.sh`, the Dockerfile, the README, and the deployment docs all ran `npx prisma migrate deploy` — but FediHome doesn't track migration files (no `prisma/migrations/` directory). With nothing to deploy, `migrate deploy` exited cleanly without creating any tables, so a fresh `curl install.sh | bash` produced an app that crashed the moment it tried to query Postgres. Verified with the actual Prisma CLI: against an empty `prisma/migrations/` it prints *"No migration found in prisma/migrations / No pending migrations to apply"* and creates zero tables.
- Switched `install.sh`, `Dockerfile`, `README.md`, `CONTRIBUTING.md`, and the relevant `docs/*.md` to `npx prisma db push`, which is what the project's no-migrations workflow actually requires. `db push` reads `prisma/schema.prisma` directly and creates/updates tables to match. Prisma refuses any push that would drop data unless you pass `--accept-data-loss`, so it's also safe to run on existing production databases when upgrading.
- **Dockerfile**: container now runs `npx prisma db push --skip-generate` at startup before launching the server, so the schema is synced against whatever database `DATABASE_URL` points at — first install or upgrade. The Prisma CLI is now copied into the runner stage (was builder-only) for this purpose.

### Notes for upgraders
- Existing operators don't need to do anything — your DB already has the tables. Future `git pull && npx prisma db push && npm run build && pm2 restart fedihome` upgrade flow remains unchanged.
- Contributors changing `prisma/schema.prisma`: run `npx prisma db push` (no `migrate dev`) and document the change under a "Schema" heading in the changelog.

## 0.1.12 (2026-05-11)

### Added
- **Author follow-ups on microblog posts.** From your own post detail page, an admin-only "Add follow-up" button lets you compose a threaded reply that cross-posts to Bluesky as a real reply (uses `reply.root` and `reply.parent` against the original's stored AT URI, with thread-root resolution if the parent is itself a reply) and federates as an ActivityPub Note with `inReplyTo` set to the parent's `apId`. Follow-ups become first-class `Post` rows with their own slug, permalink, and federation, but are hidden from the homepage feed, journal, articles, RSS, XML-RPC, and profile post counts — they appear inline on the original post's page as author-styled comment cards (uses `siteConfig.authorName` and `siteConfig.avatarPath`) with a "View follow-up thread →" link, and a "↩ in reply to [original]" header at the top of any follow-up's permalink. Threads/DayOne are skipped for follow-ups (no useful threading model). Replies-to-incoming-comments still stay platform-local (existing behavior unchanged). UI is gated to top-level posts in v1; the data model already supports chained follow-ups.

### Schema
- New self-referential FK on `Post`: `inReplyToPostId` (nullable) → `Post.id`, with reverse relations `inReplyTo` / `followUps` and an index on `inReplyToPostId`. Apply with `npx prisma db push`. Existing rows get `NULL`.

### Files
- New `src/lib/crosspost.ts:crosspostReplyToBluesky()` — resolves the parent CID via `agent.getPost`, walks up to the thread root if the parent is itself a reply, then calls `agent.post` with the proper `reply.root` / `reply.parent` refs. Shares text-truncation / embed-building with the existing `crosspostToBluesky` (extracted into a private `truncateForBluesky` helper).
- New `src/components/fedi/AuthorFollowUpForm.tsx` — small client form (textarea + 300-char counter + submit) that POSTs `{ content, inReplyToPostId }` to `/api/compose` and refreshes on success.
- `src/app/api/compose/route.ts` — accepts optional `inReplyToPostId`; routes Bluesky to the threaded helper when the parent has a `blueskyUri`; sets `inReplyTo: parent.apId` on the federated AP `Create` activity; gates Threads/DayOne to top-level only.
- `src/app/post/[slug]/page.tsx` — fetches `followUps` and `inReplyTo`; renders follow-ups inline; renders the in-reply-to header; mounts the form when `isAdmin && !post.inReplyToPostId`.
- `src/app/page.tsx`, `src/app/journal/page.tsx`, `src/app/articles/page.tsx`, `src/app/feed.xml/route.ts`, `src/app/users/[username]/page.tsx`, `src/app/xmlrpc/route.ts` — listing queries filtered with `inReplyToPostId: null` so follow-ups don't clutter feeds.
- `src/app/ap/outbox/route.ts`, `src/app/ap/post/[slug]/route.ts` — emit `inReplyTo` in the AP object so other servers thread follow-ups correctly.

## 0.1.11 (2026-05-10)

### Security
This release applies the cross-portable findings from a deep security audit run against the sister project samuellison-web on 2026-05-10. (Findings tagged H4/H6/C4/C5/H7 from the previous fedihome audit were already fixed.)

#### Critical
- **AP inbox SSRF.** `verifyIncomingSignature`, `fetchActorInfo`, and `handleBoost`'s remote-post fetch now reject URLs whose hostname is in private/loopback/CGNAT/link-local space — and additionally DNS-resolve to defeat rebinding. New `src/lib/url-guard.ts` exports `isPrivateUrl` (public, with decimal/hex/octal IPv4 + IPv6 ULA + link-local + v4-mapped) and an async `assertPublicHost` for trust-boundary fetches.
- **HTML sanitizer entity bypass.** `src/lib/sanitize.ts` now decodes HTML entities before checking dangerous URI schemes, so `&#x6a;avascript:alert(1)` no longer slips through to federated content rendered with `dangerouslySetInnerHTML`. Also strips `<iframe>` and catches self-closing `<script/>`/`<style/>`.

#### High
- **`image/svg+xml` removed** from the `/uploads/[...path]` MIME map. The route no longer serves uploaded SVGs (XSS-prone when navigated directly).
- **CSP hardening.** Dropped `'unsafe-eval'` from `script-src`. Added `Strict-Transport-Security`, `Permissions-Policy`, and `object-src 'none'`/`base-uri 'self'`/`form-action 'self'`. New per-route `/uploads/*` header (`default-src 'none'; sandbox`) so any payload that slips media validation can't execute scripts.
- **XML-RPC brute force.** `/xmlrpc` no longer accepts `ADMIN_SECRET` as the password — Micropub bearer tokens only — and is now per-bucket rate-limited (10 attempts / 60s, same `TRUSTED_PROXY` model as the admin login route).

#### Medium
- **CSRF on guest endpoints.** `verifyOrigin` is now applied to `/api/comments` and `/api/kudos`.
- **Bluesky thumbnail fetch SSRF.** `crosspostToBluesky`'s video link-card path rejects private/internal `thumbnailUrl`s and adds a 10s timeout.
- **XML-RPC content & XML injection.** Post titles and IDs are XML-escaped on output; CDATA-wrapped content has internal `]]>` split to prevent CDATA termination.
- **`verifyOrigin` protocol check.** Validates protocol in addition to hostname.

#### Low / hygiene
- `<script>`/`<style>` strip regex extended to catch self-closing variants.
- Middleware uses `pathname.slice` instead of `pathname.replace`.
- Removed unused `isAdminRequest` helper from `src/lib/auth.ts`.
- Added `/.well-known/security.txt` template (replace email before deploying).

### Notes for forks
- This release does **not** introduce the DB-backed session-token model from samuellison-web. FediHome's existing per-login HMAC-bound cookie (added in a prior release) is functionally equivalent for the H4 finding. Operators wanting the DB-session approach should adapt from samuellison-web v0.4.0.

## 0.1.10 (2026-05-10)

### Fixed
- **Bluesky video crossposts** now render as a tappable rich link card instead of a broken/missing preview. PeerTube/MakerTube thumbnails are fetched, uploaded as a blob, and attached as `app.bsky.embed.external` (uri + title + description + thumb). Posts with photos still use the existing `app.bsky.embed.images` path; posts with both photos and a video keep the photos embed and append the video URL inline. Threads/DayOne crossposts unchanged.
- **Mobile menu drift** — `MobileMenu.tsx` was missing "Videos" and "Audio" entries (added in 0.1.9 to the desktop navbar) and still listed a stale "Store" item that never existed in FediHome. Both menus now read from a shared `src/lib/nav.ts` config to prevent future drift.

### Changed
- Home page intro now also links to Videos and Audio (in addition to About Me and Photography). Row uses `flex-wrap` so it tidies on mobile.

## 0.1.9 (2026-05-09)

### Added
- **Video section** at `/videos` — embed PeerTube videos in posts. Paste a URL in compose, the system fetches title + thumbnail via PeerTube oEmbed. Federation includes the video URL so Mastodon shows a link preview. Allowlist of trusted PeerTube hosts (makertube.net, framatube.org, tilvids.com, etc.) — extend in `src/lib/peertube.ts`.
- **Audio section** at `/audio` — upload MP3s with automatic duration detection. Native HTML5 audio player. Dedicated `/audio/[slug]` page. Hero slider for featured tracks.
- **Podcast RSS feed** at `/audio/feed.xml` — RSS 2.0 + iTunes namespace, ready for any podcast app. Configure title/author/cover via `PODCAST_TITLE`, `PODCAST_AUTHOR`, `PODCAST_DESCRIPTION`, `PODCAST_EMAIL`, `PODCAST_IMAGE` env vars.
- **Compose post types** — `+ Add video` (URL modal with oEmbed preview) and `+ Add audio` (MP3 upload, max 100MB). "Add to Videos" and "Add to Audio" toggles.
- **HTTP Range request support** in the `/uploads/[...path]` route — needed for audio scrubbing.
- ActivityPub federation: outgoing posts with audio attach a `Document` with `mediaType: audio/mpeg`; posts with videos include the URL in content.

### Schema
- New `Video` model
- New `Audio` model
- `Post` extended with `videos[]`, `videoTitles[]`, `audioPaths[]`, `audioTitles[]`, `audioCovers[]` arrays

### New dependencies
- `music-metadata` — reads MP3 duration without needing ffmpeg

### Other
- Navbar gains "Videos" and "Audio" links

## 0.1.8 (2026-05-09)

### Security
- Fix HIGH severity Fedify CVE [GHSA-gm9m-gwc4-hwgp](https://github.com/advisories/GHSA-gm9m-gwc4-hwgp) — resource exhaustion via unbounded HTTP redirects (Fedify 2.0.6 → 2.2.0)

### Added
- **Service update monitor** — `npm run check-updates` script reads `npm outdated`, `npm audit`, and GitHub release feeds for a curated watchlist (Fedify, Next.js, Prisma, atproto, React); findings appear in the notification bell under a new "Updates" category with dismiss/apply actions
- **Hero slider** on `/photography` — opt-in via `Photo.hero` flag (disabled by default); 16:7 auto-advancing carousel with dot + arrow + swipe nav, respects `prefers-reduced-motion`
- **`MaintenanceItem` model** + key-value `SiteSetting` model already added in 0.1.7 now powers maintenance read state
- **Photo dimension columns** (`width`, `height`) backfilled via `sharp` — required for masonry layout
- **Lightbox bottom action bar** — optional "View post" link surfaces detail-page comments/EXIF without forcing a full nav

### Changed
- **Photography grid switched from forced 1:1 uniform crop to true masonry** via `react-masonry-css` — portraits stay portrait, landscapes stay landscape, mixed orientations render at native aspect ratio
- Photo click now opens a fullscreen Lightbox with arrow/keyboard/swipe nav across the entire portfolio (no longer routes to the blog post)
- Notification API includes maintenance items as a new `update` type with wrench icon and amber accent

### Updated dependencies
- `@fedify/fedify` 2.0.6 → 2.2.0 (security)
- `@fedify/next` 2.0.6 → 2.2.0
- `@atproto/api` 0.19.4 → 0.19.16
- `next` 16.2.0 → 16.2.6
- `react`, `react-dom` 19.2.4 → 19.2.6
- `nodemailer` 8.0.3 → 8.0.7
- `tailwindcss` / `@tailwindcss/postcss` 4.2.2 → 4.3.0
- `postcss` 8.5.8 → 8.5.14
- `fast-xml-parser` 5.5.6 → 5.7.3
- `marked` 17.0.4 → 17.0.6
- `@prisma/client`, `prisma` 6.19.2 → 6.19.3
- `@types/node` 25.5.0 → 25.6.2
- New: `react-masonry-css` 1.0.16, `tsx` 4.21.0 (devDep)

## 0.1.7 (2026-04-11)

### Added
- Notification category sidebar — filter by Likes, Boosts, Replies, Follows, Comments, Messages
- Per-category unread count badges on sidebar icons
- Outgoing reply tracking — replies to your replies now generate notifications

### Changed
- Removed all notification query limits — all interactions, followers, and comments shown
- Removed 24-hour window restriction on notifications
- Notification read state moved from cookie to database (syncs across devices)
- Notification dropdown widened to fit category sidebar

### Added (schema)
- `SiteSetting` key-value model for persistent settings

## 0.1.6 (2026-04-08)

### Added
- Hamburger mobile menu for all navigation links (solid dark overlay)
- Reply to Bluesky comments from post pages (admin only)
- Optional email field on guest comment form (for reply notifications)
- ReplyToBlueskyComment component with inline reply form

### Fixed
- Mobile menu rewritten as absolute dropdown (fixed overlay had stacking context issues)
- ALT badge now shows on photography grid page (was only on post pages)

## 0.1.5 (2026-04-07)

### Added
- Analytics dashboard tab in admin panel (powered by Tinylytics)
  - Overview cards: total visits, kudos, recent hits, unique pages
  - Top pages leaderboard with percentage bars
  - Referrer sources breakdown
  - Country breakdown
  - Visitor journey visualization
- Setup prompt for unconfigured Tinylytics (instructions to add API key)
- View count always displayed on posts (even when 0)

## 0.1.4 (2026-04-07)

### Security
- Strip EXIF metadata (GPS coordinates, camera serial numbers, timestamps) from all uploaded images
- Strip EXIF from fedi-proxied images before saving to disk
- Small images (<2MB) now also processed through Sharp for metadata removal
- GIFs preserved as-is (no EXIF concern, animation preserved)

## 0.1.3 (2026-04-07)

### Added
- Reply to fedi comments directly from post pages (admin only) — inline reply form with @mention
- Author replies now visible in post comment threads with "Author" badge
- Lightbox gallery on fedi feed images — click to expand, swipe to navigate
- Combined Fedi + Bluesky like/boost counts on homepage feed cards

### Fixed
- Lightbox now renders via React portal for proper fullscreen overlay in all contexts

## 0.1.2 (2026-04-03)

### Added
- "Add to Photography" toggle in compose UI — attach photos to your portfolio with category selection
- Logout endpoint (`/api/admin/logout`) — visit in browser or POST to clear session
- Dynamic compose status text — updates based on which crosspost toggles are enabled

### Fixed
- Timeline, compose, and navbar pages now correctly verify hashed admin cookie (was comparing raw secret)
- Photo upload in compose no longer sends broken Bearer token (uses cookie auth)

### Planned (v0.2)
- Customizable photography categories via admin panel (currently: General, Wildlife, Macro, Landscape, Street)

## 0.1.1 (2026-04-03)

### Security
- **CRITICAL:** Enforce HTTP signature verification on all ActivityPub inbox activities — unsigned requests are now rejected
- **HIGH:** Admin cookie no longer stores raw secret — uses SHA-256 hash instead
- **HIGH:** Add rate limiting to admin login (5 attempts per IP per minute)
- **HIGH:** Remove admin secret from setup API response body
- **HIGH:** Add SSRF protection to image/video proxy — blocks private IPs, CGNAT, link-local ranges
- **HIGH:** Reject SVG files from media proxy to prevent stored XSS
- Replace all secret comparisons with timing-safe `crypto.timingSafeEqual`
- Make cookie `secure` flag conditional on production environment
- Consolidate inline auth checks to use central `verifyAdmin()` function

### Fixed
- Replace personal favicon with FediHome branded icon
- Fix GitHub URLs in README, install script, and docs to point to correct repository

## 0.1.0 (2026-04-03)

### Initial Release
- Blog publishing with Markdown (notes, articles, journal entries)
- Photo gallery with EXIF metadata and lightbox
- Full ActivityPub federation
- Fediverse timeline with follow/unfollow
- Direct messages from Fediverse and Bluesky
- Bluesky crossposting
- Micropub and MetaWeblog API support
- Guest comments with moderation
- RSS feed
- Setup wizard for first-run configuration
- Dark theme with customizable accent color
