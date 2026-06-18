# Changelog

## Unreleased

### Security
- **Hardened the outbound federation path.** `signedFetch` (the signed ActivityPub delivery POST) now runs the same `assertPublicHost` SSRF guard the inbound/resolver paths use, so a delivery target can never be coerced to a private/internal host even if a caller forgets to vet it. Also fixed a tainted-format-string in delivery error logging (the inbox URL is now passed as a `%s` argument, not interpolated into the format string), and added least-privilege `permissions:` blocks to the CI workflows. Resolves CodeQL `js/request-forgery` (delivery), `js/tainted-format-string`, and `actions/missing-workflow-permissions`.

### Fixed
- **The app listen port is now configurable.** The `dev`/`start` scripts hardcoded `--port 3000`, which overrode Next.js's built-in `PORT` support — so FediHome couldn't run on a host already using port 3000, and `PORT=…` was silently ignored. The flag is dropped (Next reads `PORT` natively), pm2 forwards `PORT`, and Docker Compose's host port is now `FEDIHOME_PORT`. All default to 3000, so existing deploys are unchanged. Remember to keep `SITE_URL` pointed at your real public origin if you change the port. (#27)
- **The Docker image now builds and runs under Prisma 7.** Enabled Next.js `output: "standalone"` (the Dockerfile expected it but it was never configured, so `docker build` failed at the standalone copy); bundled the Prisma CLI's runtime deps (`@prisma/engines`, `@prisma/config`) into the runner so the startup `prisma db push` resolves them; and added a `.dockerignore` so host binaries can't leak into the Linux image. The `next start` / pm2 path is unaffected. (#40)

## 1.0.1 (2026-06-17)

### Fixed
- **Inbound federation now ingests `Create(Article)`, not just `Note`.** Titled posts (e.g. federated blog posts) from followed accounts were silently dropped on receipt and never reached the feed; the Article's title is now preserved as a heading. (#43)
- **`/ap/actor` now content-negotiates.** Browsers are redirected to the profile instead of receiving raw ActivityPub JSON; ActivityPub clients still get the actor JSON. (#44)

## 1.0.0 (2026-06-17)

**First stable release.** FediHome is a self-hosted, single-user Fediverse home — blog, photos, video, audio, and a live following feed, all on your own domain via ActivityPub. 1.0 marks the project production-ready: a test suite + CI gate every change, the security-audit findings are resolved, the dependency stack is current (Prisma 7, Next 16, Fedify 2), and a public demo runs the exact code at [fedihome.social](https://fedihome.social).

### Changed
- **Upgraded to Prisma 7** — driver adapter (`@prisma/adapter-pg`) + the new `prisma-client` generator (client generated to `src/generated/` on install via `postinstall`). A connection/codegen change only; your data and schema are untouched. (#19)
- **`update.sh` / `install.sh` no longer pass the removed `--skip-generate` flag** to `prisma db push`, and `update.sh`'s Step-4 failure message no longer misattributes every error to data loss. (#39)

### Added
- **Continuous integration** — every PR and push to `main` runs typecheck + the Vitest suite (`.github/workflows/ci.yml`).
- **Config-gated public landing/showcase homepage** (`LANDING_MODE`) and a **read-only public Fediverse feed** (`PUBLIC_FEED`) — opt-in, off by default. (`src/components/home/LandingShowcase.tsx`, `src/app/fediverse/page.tsx`)
- **Configurable navigation visibility** (`NAV_SHOW_*`) and a **config-driven footer** (copyright / handle / email / webring all from config).
- **Vitest test suite** (sanitize, url-guard, auth) — the project's first automated tests.

### Security
- [P0] **Dependency CVE fixes** — `@fedify/fedify` → 2.2.5 (LD-Signature bypass), `tsx` → 4.22.4 (esbuild file-read), `nodemailer` → 8.0.11 (CRLF injection).
- [P1] **HTML sanitizer rewritten on `sanitize-html`** (tree-based parser) — closes known mXSS bypass vectors.
- [P1] **kudosLog memory leak** — TTL + hard-cap eviction on the in-memory rate-limit map.
- **Removed hardcoded personal data** from the public repo (footer, `security.txt`, media/audio/video metadata) — all now config-driven.

### Notes for upgraders
- **Prisma 7:** `npm run update` handles the upgrade, but `@prisma/adapter-pg` uses node-postgres, which reads `sslmode` differently from the old engine. If the DB won't connect after upgrading, append `?sslmode=disable` (SSL off) or `?sslmode=no-verify` (self-signed cert) to `DATABASE_URL`.
- The Prisma CLI now reads `.env.local` (via `prisma.config.ts`) — the old `.env` symlink workaround is no longer needed.
- **Docker:** a runner-stage dependency fix for Prisma 7 is pending (#40) — verify with `docker build` before deploying via container.

### Versioning
- First tagged release / GitHub Release; `package.json` is now `1.0.0`. Prior 0.x history is below.

## 0.9.0 (2026-06-16)

### Added
- **"View thread" now loads everyone's replies, not just ones you'd already seen.** It pulls the full conversation from the origin instance's Mastodon-API context endpoint (`/api/v1/statuses/:id/context` → ancestors + descendants), ingesting each reply locally (sanitised) so the whole thread renders — even replies from accounts you don't follow. Falls back to the signed-AP ancestor walk + local replies for non-Mastodon servers. Capped at 200 posts per view. (`src/app/api/conversation/route.ts`)
- **Like / boost a reply from within the thread view.** Each post in the conversation now has like and boost buttons (state seeded from the post so it persists). (`src/app/timeline/TimelineClient.tsx`)

## 0.8.1 (2026-06-15)

### Added
- **"Read article / Read more →" cue on post cards.** Article cards showed only the excerpt with no sign there was more to read. Cards now show a "Read article →" link for articles (and "Read more →" for posts with an excerpt or truncated body), so it's clear the whole card opens the full post. (`src/components/blog/PostCard.tsx`)

## 0.8.0 (2026-06-15)

### Added
- **One-click translate on each post.** A translate icon (next to share, bottom-right of each feed card) opens **Kagi Translate** with the post's text already filled in (target English, source auto-detected) — no more selecting text and right-clicking. Long posts translate the original page instead so nothing is truncated. (Kagi Translate is a paid Kagi feature; non-subscribers will hit Kagi's sign-in gate.) (`src/components/fedi/TranslateButton.tsx`, `src/app/timeline/TimelineClient.tsx`)

## 0.7.0 (2026-06-15)

### Fixed
- **Like/boost no longer reset after a page reload.** The feed's like and boost buttons were driven by component state that always started "off" and was never persisted, so reloading lost the activated look. We now record the owner's like/boost on the post (`FediPost.likedByMe` / `boostedByMe`, set when the Like/Announce is sent) and initialise the buttons from it. (`prisma/schema.prisma`, `src/app/api/admin/route.ts`, `src/app/timeline/TimelineClient.tsx`)

### Schema
- `FediPost.likedByMe` / `FediPost.boostedByMe` booleans. Apply with `npx prisma db push` (or `prisma/manual-migrations/2026-06-15-fedipost-reactions.sql`).

## 0.6.0 (2026-06-15)

### Fixed
- **Interaction counts ("Tap to load") were almost always blank, and "View thread" on a reply to someone else loaded no context.** Both were caused by **unsigned** ActivityPub GETs, which servers running Mastodon "authorized fetch" (secure mode — now the default) reject with 401. Added a signed-GET helper (`signedGet`, HTTP Signatures with the site actor key) and used it everywhere we read remote objects:
  - **Counts:** now read from the Mastodon REST API (`/api/v1/statuses/:id`, which publicly exposes favourites/reblogs/replies for the bulk of the fediverse — Mastodon/Pixelfed/GoToSocial/Pleroma), falling back to the **signed** AP object's collection totals. Mastodon doesn't expose like/boost totals over AP at all, which is why the old AP-only path came back empty. (`src/app/api/fedi-post-counts/route.ts`)
  - **View thread:** ancestor posts that aren't stored locally are now fetched with a **signed** GET, so the full reply chain above a "RE:" loads. Remote note content is also sanitised before storage (it's rendered as HTML). (`src/app/api/conversation/route.ts`)
  - (`src/lib/http-signatures.ts` — new `signedGet`.)

## 0.5.0 (2026-06-14)

### Fixed
- **RSS feed (`/feed.xml`) no longer looks broken for short notes, and now carries media.** Previously a titleless note repeated its (truncated, raw) text as both the `<title>` and `<description>`, and the feed included no photos/video/audio. Now:
  - Titleless notes get a **date + time title** (e.g. "14 June 2026, 3:23 pm") instead of duplicating the body.
  - The `<description>` carries the **full rendered HTML** (not a 280-char raw-markdown slice).
  - **Photos, video thumbnails/links, and audio links are embedded** (absolute URLs), plus a lead-image `<enclosure>` for thumbnail-style readers. (`src/app/feed.xml/route.ts`)

## 0.4.0 (2026-06-14)

### Added
- **Share a post / copy its source link.** Each feed post card now has a share icon at its far bottom-right. On macOS/iOS (and Android) it opens the native share sheet via the Web Share API; elsewhere it copies the link with a brief "Copied!" confirmation. The shared URL is the post's **originating source** on its home server (a boost resolves to the original post's URL, not the local timeline). Posts with no canonical URL hide the icon. (`src/components/fedi/ShareButton.tsx`, `src/app/timeline/TimelineClient.tsx`)

## 0.3.0 (2026-06-14)

### Added
- **Live in-app updates (feed + notifications).** The timeline feed and the notification bell now refresh themselves instead of needing a manual reload — important for an always-open Dock/home-screen PWA:
  - **Push as the realtime signal** — when a Web Push arrives, the service worker pings any open window, which refreshes the feed and the bell **instantly** (no SSE/WebSocket, so it's proxy-safe).
  - **Focus + light polling backstop** — both also refresh the moment the app regains focus and poll every 30s while visible (paused while hidden).
  - **Non-disruptive feed updates** — at the top, new posts merge in seamlessly (prepend-only, never replacing loaded pages or rewinding the cursor); scrolled down, they're buffered behind a "↑ N new posts" pill so the reading position isn't yanked. Suppressed while composing an inline reply. (`src/app/timeline/TimelineClient.tsx`, `src/components/layout/NotificationBell.tsx`, `public/sw.js`)

## 0.2.3 (2026-06-14)

### Fixed
- **Test push no longer bumps the app-icon badge.** The "Send test" push was counting as 1 unread on the Dock/home-screen badge with no real notification to clear it against. The service worker now skips the badge for `type: "test"` pushes. (Existing stuck badges clear themselves the next time the app opens and re-syncs to the true unread count.) (`public/sw.js`)

## 0.2.2 (2026-06-14)

### Added
- **App-icon notification badge.** The installed app (macOS Dock, or home screen elsewhere) now shows a number badge for unread notifications via the Web Badging API. The service worker sets/increments it when a push arrives — even while the app is closed (persisted in IndexedDB so it survives the worker being torn down) — and the open app keeps it synced to the true unread count, clearing it on "Mark all read". No-ops where the Badging API isn't supported. (`public/sw.js`, `src/components/layout/NotificationBell.tsx`)

## 0.2.1 (2026-06-14)

### Added
- **Pull-to-refresh in the installed PWA.** Home-screen apps run in standalone mode, which disables the browser's native pull-to-refresh — this adds a custom one. Pull down from the top of any page and release to reload. Only active in standalone (a normal browser tab keeps its built-in gesture). (`src/components/ui/PullToRefresh.tsx`, mounted in the root layout.)

### Fixed
- **More mobile horizontal-drift fixes.** The `@mention` autocomplete dropdown is `position: fixed` (so it escapes the page's `overflow-x: clip`) and was positioned with stale scroll offsets + no right-edge clamp, letting it spill past the viewport and drift the page. It's now viewport-clamped (`max-w-[calc(100vw-1rem)]` + clamped `left`, no scroll offset). Added `overscroll-behavior-x: none` to `html, body` as an iOS belt-and-suspenders against horizontal rubber-band, and `break-words` to the compose result banner. (`src/components/ui/MentionAutocomplete.tsx`, `src/app/globals.css`, `src/app/compose/ComposeClient.tsx`)

## 0.2.0 (2026-06-14)

### Added
- **Web Push / PWA notifications.** FediHome is now an installable home-screen app that delivers native push notifications for fediverse activity — **likes, boosts, replies, follows, DMs** — plus guest **comments**, even when the app is closed. Push is emitted from the AP inbox (`src/app/ap/inbox/route.ts`) and `src/app/api/comments/route.ts`, fanned out to every enrolled device via `sendPushToOwner` (`src/lib/push.ts`, web-push + VAPID). Dead endpoints are auto-pruned on 404/410. The feature is **dormant until you set VAPID keys** — generate them with `npx web-push generate-vapid-keys` and add `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` to `.env.local` (see `.env.example`).
- **Enrolment UI** in the admin-only notification bell (`src/components/layout/PushSetup.tsx`): "Enable phone notifications", a Test button, Turn-off, and iOS "Add to Home Screen" guidance (iOS 16.4+ only delivers push to a standalone home-screen install). Endpoints: `GET/POST/DELETE /api/push` (admin + CSRF) and `POST /api/push/test`.
- **PWA shell** — web manifest (`src/app/manifest.ts`, `display: standalone`, built from `siteConfig`), service worker (`public/sw.js`, push + tap-to-open), apple-touch-icon + `appleWebApp` + theme-color metadata in the root layout, and app icons generated from the site avatar (`public/icons/`).

### Fixed
- **Mobile: feed no longer drifts left/right while scrolling vertically.** Fedi post/reply/DM bodies render sanitised HTML that could contain long unbroken URLs or `@handle@domain` strings, pushing cards past the viewport. Added `break-words` to all four content containers (`src/app/timeline/TimelineClient.tsx`) and a document-level `overflow-x: clip` on both `html` and `body` plus `max-width: 100%` on media (`src/app/globals.css`). `clip` (not `hidden`) keeps the sticky navbar working.

### Schema
- New Prisma model **`PushSubscription`** (one row per enrolled browser/device). Apply with `npx prisma db push` (or `prisma/manual-migrations/2026-06-14-push-subscriptions.sql`).

## 0.1.20 (2026-06-06)

### Added
- **Back-to-top button** — a floating rounded button appears bottom-right once you scroll past ~400px on any page; clicking smooth-scrolls to the top. Respects `prefers-reduced-motion`. Mounted once in the root layout so it covers the whole site. (`src/components/ui/ScrollToTop.tsx`)

## 0.1.19 (2026-05-10)

### Added
- **Edit existing posts** via the compose page (`?edit=<id>`). Admin Edit link on every post page jumps back into the compose form pre-filled with the original title, content, photos, video URLs, and audio attachments. Saving federates an ActivityPub `Update` activity so Mastodon shows &ldquo;edited X ago&rdquo;. Slug and AP id are preserved.
- **Edit existing fedi replies** inline. Outgoing fedi replies show an Edit affordance in timeline / post pages. Saving federates AP `Update`.
- **Symmetric reply crossposting** &mdash; inline fedi-comment replies can now also post to Bluesky (threaded under the local post&apos;s Bluesky version if it exists, standalone otherwise). Inline Bluesky-comment replies can now also federate to the Fediverse. Per-reply checkbox; auto-enabled when a cross-network mention is detected.
- **`@mention` autocomplete** in every compose / reply / edit textarea, drawing from `FediFollower` + `FediFollowing` AND `BlueskyFollower` + `BlueskyFollowing`. New endpoint `GET /api/mentions/search?q=...`. Auto-detected fedi mentions build AP `Mention` tags and direct-deliver to the mentioned actor&apos;s inbox.

### Known limitations
- Bluesky/Threads/DayOne crossposts are NOT re-published on edit (AT Protocol has no edit primitive).
- Auto-created Photo / Video / Audio records from &ldquo;Add to&hellip;&rdquo; toggles are not retroactively modified by editing &mdash; manage from their respective admin tabs.
- Editing Bluesky replies is hidden in v1 (delete + repost would lose existing likes/replies on Bluesky).

### Critical files
- `src/lib/mentions.ts` &mdash; new shared parser + AP tag/inbox helpers
- `src/app/api/mentions/search/route.ts` &mdash; new admin-only search endpoint
- `src/components/ui/MentionAutocomplete.tsx` &mdash; new hook + dropdown
- `src/components/fedi/EditReplyForm.tsx` &mdash; new inline-edit widget

## 0.1.18 (2026-05-19)

### Changed
- **Inline reply in the thread modal now prefills the recipient's `@user@domain` handle.** Previously, clicking **Reply** on a post inside the conversation modal opened an empty textbox, leaving you to wonder whether you needed to type the handle yourself. Now the input is pre-populated with the post author's handle followed by a space, so the cursor lands ready for the body of the reply. Replying to one of your own outgoing posts in the chain (`isOutgoing = true`) still opens empty — no point @-mentioning yourself.
- **Server `reply` action de-duplicates the leading mention.** The handler already prepends a proper `<span class="h-card">…</span>` mention to `contentHtml` and includes the `Mention` tag on the federated `Create`/`Note`. With the new prefill, the plain `content` would otherwise also carry a literal `@user@domain ` at the start, and recipients would see the handle twice. `case "reply"` in `src/app/api/admin/route.ts` now strips a leading copy of `mentionHandle` from the incoming `content` (whitespace-tolerant) before building `linkedContent`, and stores the stripped `bodyText` on the locally-persisted `FediPost` row so the canonical mention HTML stays the single source of truth.

### Files
- `src/app/timeline/TimelineClient.tsx` — `FediPostItem` gains optional `isOutgoing?: boolean` (the field already comes back from `/api/conversation`, it just wasn't declared on the client). The Reply button's `onClick` in `ThreadView` switches from `setReplyContent("")` to a conditional prefill.
- `src/app/api/admin/route.ts` — `case "reply"` adds an 8-line strip block before the URL auto-link regex; the `prisma.fediPost.upsert` `create` block now writes `content: bodyText` instead of `content: replyContent`.

### Notes for upgraders
- No schema changes, no env changes, no upgrade steps beyond `git pull && npm run build && pm2 restart fedihome` (or your usual process). Threading (`inReplyTo`), inbox delivery, and follower fan-out are unchanged — only the textbox UX and the dedup on the way out.

## 0.1.17 (2026-05-18)

### Added
- **"Replies" tab in the admin Timeline.** A new top-level tab between **Feed** and **Messages** lists every reply you've sent to someone else's post — outgoing `FediPost` rows where `isOutgoing = true` and `inReplyTo` is set. Each row shows a quoted parent line (`@user@domain` plus a 160-char snippet from the parent's content if cached locally, or an italic "Replying to a post not cached locally — open the thread to fetch it." fallback), the body of your reply, and a **View thread** button that opens the existing conversation modal so you can see the full ancestor chain plus sibling replies. Paginated 25 at a time (`publishedAt` cursor). Reuses the existing `/api/conversation` thread walker — no new threading code.
- **Like / repost / reply counts on others' posts in the feed.** A small `💬 / 🔁 / ❤` strip below each `PostCard` shows interaction counts pulled on demand from the remote ActivityPub object (the `replies`, `shares`, `likes` collections — Mastodon, Pleroma, and Misskey all expose these in some form). Until you tap, the strip shows "💬 🔁 ❤ Tap to load" so the feed scroll stays fast and we don't hammer remote servers. Clicking **View thread** auto-triggers the same fetch as a side effect. Counts are cached on the `FediPost` row for 5 minutes; re-tapping within that window returns the cached values without a network call. Each post inside the conversation modal also gets its own counts strip + Reply box, so you can jump into a chain at any depth.
- **"View thread" now works on every post,** not just replies. The existing `/api/conversation` endpoint already walks both directions (ancestors via `inReplyTo`, descendants via reply lookup), so calling it for a top-level post returns the same shape — the modal handles either case naturally.

### Schema
- New nullable columns on `FediPost`: `likeCount Int?`, `boostCount Int?`, `replyCount Int?`, `countsFetchedAt DateTime?`. All NULL means "never fetched"; NULL after a fetch means the remote hides that collection (Mastodon's authenticated-fetch quirk). Apply with `npx prisma db push`.

### Files
- New `src/app/api/replies/route.ts` — `GET /api/replies?cursor=<ISO>` returns the admin's outgoing replies, latest first, with a `parent` summary attached per row when the parent post is in our local cache. Reuses the existing `@@index([inReplyTo])` and `verifyAdmin()` gate.
- New `src/app/api/fedi-post-counts/route.ts` — `POST /api/fedi-post-counts { postId }` fetches the remote AP object, reads `totalItems` off each collection (handles both inline OrderedCollection and URL-referenced forms), persists `likeCount`/`boostCount`/`replyCount`/`countsFetchedAt`, and returns the result. SSRF-guarded via `assertPublicHost()` (`src/lib/url-guard.ts`), 8s per outbound fetch, 5-minute cache TTL on the row.
- `src/app/timeline/TimelineClient.tsx` — adds `RepliesTab`, `ThreadCountsStrip`, and `fmtCount` components. `PostCard` and `ThreadView` gain `counts` + `onLoadCounts` props. New top-level state: `postCounts` (Map<postId, FediCountsState>), `replies`, `repliesCursor`, `repliesLoading`. `handleLoadCounts` does the optimistic-update + POST dance.

### Notes for upgraders
- Run `npx prisma db push` before restarting the server so the four new `FediPost` columns exist; otherwise `/api/replies` and `/api/fedi-post-counts` will 500.
- Counts populate lazily — old posts in your feed will show "Tap to load" until you click. There is no backfill cron; that's intentional, both to stay polite to remote servers and so counts are fresh when you actually look.
- Existing `PostCard` and `ThreadView` call sites in `TimelineClient` need the new `counts` + `onLoadCounts` props if you've forked the file.

## 0.1.15 (2026-05-12)

### Added
- **"+ New message" compose flow in the admin Timeline DMs tab.** A modal (`NewMessageModal` in `src/app/timeline/TimelineClient.tsx`) lets you start a brand-new conversation without first receiving an inbound DM. Three picker tabs: **Following** and **Followers** (both merged Fedi + Bluesky lists, searchable by name/handle/domain), and **Other** (free-text input — Fediverse `user@domain.tld` or Bluesky `name.bsky.social`). Selecting a contact opens a textarea; on send the modal POSTs to `/api/admin` and the page reloads to show the sent message in the conversation thread.
- **"Mark all read" button** in the conversations list header. Disabled when nothing is unread; bulk-upserts a `lastReadAt = now` row for every conversation key currently in `DirectMessage`.
- **Outgoing-DM delivery audit.** `DirectMessage` gains nullable `deliveredAt` (set when the remote inbox returned 2xx for Fedi, or when `chat.bsky.convo.sendMessage` returned success for Bluesky) and `deliveryError` (the HTTP status + truncated body, or the network error message). Thread view (`MessagesTab`) renders a green ✓ next to delivered outgoing messages with a tooltip showing the timestamp, a red ✗ for failures with the error in the tooltip, or a grey · for messages stored before this release.
- **Two new admin actions for the new compose flow.** `dm_new_fedi` accepts `recipientUri` (already-known Fediverse actor) or `recipientHandle` (free-text — resolves via WebFinger). `bsky_dm_new` accepts `recipientDid` or `recipientHandle` and calls `chat.bsky.convo.getConvoForMembers` to start (or fetch) the conversation before posting the first message. Both share the same delivery-audit code path as the reply actions.
- **Two new admin actions for read tracking.** `mark_dm_read` upserts a single `DmConversationRead` row; `mark_all_dms_read` runs a `prisma.$transaction` of upserts across every distinct `conversationKey` in `DirectMessage`.

### Changed
- **DM read state moved from browser localStorage to the database.** Previously `MessagesTab` tracked unread/read with a `dm-read-timestamps` localStorage key, which meant clearing site data or opening on a different device made already-read conversations look unread again. Read state now lives in a new `DmConversationRead` table (one row per `conversationKey`), loaded into `TimelineClient` via the new `dmReadState` prop on `src/app/timeline/page.tsx`. The unread-count badge on the **messages** tab reads from the same state, so it stays consistent. Mark-read is optimistic — the UI updates instantly and the POST happens in the background.
- **Fediverse DM recipient inbox is now resolved properly.** The previous `dm_reply` handler fell back to `${recipientUri}/inbox` when no inbox was passed in — fine for Mastodon but unreliable elsewhere. Both `dm_reply` and `dm_new_fedi` now consult `FediFollower` / `FediFollowing` first (already-vetted inbox) and only fall back to a live actor fetch if the URI isn't cached.
- **`deliverActivity()` (`src/lib/http-signatures.ts`) now returns `DeliveryResult` instead of `void`.** Previously it logged failures to console and returned nothing; callers had no way to surface delivery status to the user. The new `{ ok, status, error? }` return is what powers the new `deliveredAt` / `deliveryError` audit fields. Existing callers (boost / like / follow-accept / federate-comment / federate-reply / shared-inbox fan-out) still `await` and ignore the return — behaviour is unchanged for them.

### Schema
- New nullable columns `deliveredAt` (`DateTime?`) and `deliveryError` (`String?`) on `DirectMessage`. Existing rows get NULL, which the UI renders as the grey · "delivery status unknown" indicator.
- New table `DmConversationRead { conversationKey @id, lastReadAt, updatedAt @updatedAt }`. Apply with `npx prisma db push`.

### Files
- New `src/lib/fedi-resolve.ts` — `resolveFediActorByHandle()` runs WebFinger then fetches the actor JSON; `resolveFediActorByUri()` skips WebFinger when the actor URI is already known. Both are SSRF-guarded via `assertPublicHost()` and 10s-timeouted. Returns `{ actorUri, inbox, sharedInbox, username, domain, displayName, avatarUrl }` or null.
- `src/lib/http-signatures.ts` — `deliverActivity()` returns `DeliveryResult`; the success / error branches both go through the same return path so callers can capture status without try/catch.
- `src/app/api/admin/route.ts` — two helpers (`resolveFediRecipient`, `sendFediDm`) shared by `dm_reply` and `dm_new_fedi`. The `bsky_dm_reply` and `bsky_dm_new` cases share a single switch arm; `bsky_dm_new` uses `getConvoForMembers` to bootstrap the convo before sending. `mark_dm_read` and `mark_all_dms_read` are thin upsert handlers.
- `src/app/timeline/page.tsx` — loads `DmConversationRead` rows alongside `DirectMessage` and passes a `dmReadState: Record<conversationKey, ISO timestamp>` prop to `TimelineClient`.
- `src/app/timeline/TimelineClient.tsx` — `MessagesTab` is now a controlled component (read state + handlers passed in). New `NewMessageModal` component holds the picker + compose UI. `DirectMessageItem` interface gains `deliveredAt` and `deliveryError`. The localStorage helpers (`READ_TIMESTAMPS_KEY`, `getReadTimestamps`, `markConversationRead`) are removed; the unread-count tab badge now uses the same `buildConversations()` helper as the tab body so the two can't drift.

### Notes for upgraders
- Run `npx prisma db push` before restarting the server, otherwise the timeline page will 500 on the new `DmConversationRead` query.
- Existing localStorage read state is dropped — on first load after the upgrade, all conversations look unread until the user clicks into them or hits **Mark all read**. There is no migration of prior client-side state to the server (it would have been per-browser and incomplete).

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
