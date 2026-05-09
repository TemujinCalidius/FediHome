# Changelog

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
