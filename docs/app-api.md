# FediHome App API

How a native app (or any OAuth/IndieAuth client) connects to a FediHome instance
and drives its private API on the owner's behalf.

The owner **authenticates on their own site** — the app never sees `ADMIN_SECRET`.
It receives a **scoped, revocable bearer token** and sends it as
`Authorization: Bearer <token>` on every request.

> Status: shipped on the `dev` branch (#158). To test locally, run your FediHome
> instance from `dev`. `SITE_URL` below is your instance base URL (e.g.
> `http://localhost:3000` in dev, `https://your.domain` in prod).

---

## Two ways to get a token

1. **OAuth login** (below) — the interactive flow for apps that can open a browser.
2. **Generate + paste** — the owner mints a scoped token at **`/admin/apps` → "Generate app token"**, picks scopes + a label, and copies the raw token **once** (only its hash is stored). Paste it into any client that accepts a bearer token — headless/CI, a read-only reader, or App Store review — and send it as `Authorization: Bearer <token>`. No OAuth round-trip, no `ADMIN_SECRET`. Long-lived + revocable from the same screen; a lost token is revoked and reissued.

### One-paste sign-in link

The generate-token reveal also offers a **sign-in link** that bundles the
instance URL and the token, so a native app can onboard from a single copy (or,
in future, a scan) instead of two fields:

```
fedihome://connect?instance=<SITE_URL>&token=<token>
```

Both values are `encodeURIComponent`-escaped. An app registers the `fedihome://`
URL scheme, parses `instance` + `token`, and connects — same as pasting the two
fields. The token is still shown once and never persisted; the link is only
displayed in the same reveal box.

> **Status: proposed onboarding contract.** The web side emits this format
> today; the exact scheme/params should be confirmed against the macOS/iOS app
> before it's treated as stable.

## The login flow (OAuth 2.0 Authorization Code + PKCE)

1. **Discover** — `GET SITE_URL/.well-known/oauth-authorization-server` → the
   authorize / token / revoke endpoints and supported scopes.
2. **PKCE** — generate a random `code_verifier` (43–128 chars, unreserved
   `[A-Za-z0-9-._~]`) and `code_challenge = BASE64URL(SHA256(code_verifier))`.
   Also generate a random `state`.
3. **Authorize** — open `SITE_URL/api/oauth/authorize?…` (see params below) in an
   in-app browser (`ASWebAuthenticationSession`). The owner signs in with their
   admin password **on their own site** and approves a consent screen listing the
   requested scopes.
4. **Callback** — the page redirects to your `redirect_uri?code=…&state=…`.
   Verify `state` matches, then exchange `code`.
5. **Token** — `POST SITE_URL/api/oauth/token` with the code + `code_verifier` →
   `{ access_token, token_type, scope, me }`. Store `access_token` in the Keychain.
6. **Call the API** with `Authorization: Bearer <access_token>`. Revoke anytime
   via `/api/oauth/revoke` or the owner's **Connected apps** screen (`/admin/apps`).

---

## Endpoints

### Discovery — `GET /.well-known/oauth-authorization-server`

RFC 8414 metadata. No auth.

```json
{
  "issuer": "https://your.domain",
  "authorization_endpoint": "https://your.domain/api/oauth/authorize",
  "token_endpoint": "https://your.domain/api/oauth/token",
  "revocation_endpoint": "https://your.domain/api/oauth/revoke",
  "scopes_supported": ["read","create","update","delete","media","interact","dm","manage"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

### Authorize — `GET /api/oauth/authorize`

Open in a web session. Query parameters (all required except `state`, which is
strongly recommended):

| param | value |
|---|---|
| `response_type` | `code` |
| `client_id` | your registered client id, e.g. `fedihome-macos` |
| `redirect_uri` | must exactly match a registered redirect (see below) |
| `scope` | space-separated, e.g. `read create interact dm media manage` |
| `state` | opaque anti-CSRF value you round-trip |
| `code_challenge` | `BASE64URL(SHA256(code_verifier))` |
| `code_challenge_method` | `S256` (only S256 is accepted; `plain` is rejected) |

On approve → `302`/navigation to `redirect_uri?code=<code>&state=<state>`.
On deny → `redirect_uri?error=access_denied&state=<state>`.

### Token — `POST /api/oauth/token`

`Content-Type: application/x-www-form-urlencoded` (JSON also accepted). Public
client — no client secret.

```
grant_type=authorization_code
code=<code from the redirect>
redirect_uri=<the SAME redirect_uri>
client_id=<your client id>
code_verifier=<the original PKCE verifier>
```

**200**:

```json
{
  "access_token": "…64 hex chars…",
  "token_type": "Bearer",
  "scope": "read create interact dm media manage",
  "me": "https://your.domain"
}
```

The code is single-use and expires ~60s after issue. Errors are
`{ "error": "...", "error_description": "..." }` with the OAuth codes
`invalid_grant` / `invalid_client` (401) / `unsupported_grant_type` /
`invalid_request` / `temporarily_unavailable` (429).

### Revoke — `POST /api/oauth/revoke`

`token=<access_token>` (form-encoded or JSON). Always returns **200** (per RFC
7009, whether or not the token existed). No auth beyond the token itself.

---

## Scopes

Space-separated. Request only what you need; the owner sees the list on the
consent screen. A first-party app typically requests the full set.

| scope | grants |
|---|---|
| `read` | private feed, notifications, conversations, post counts, social graph, account |
| `create` `update` `delete` | create / edit / delete your own posts (Micropub) |
| `media` | upload media (`POST /api/media`) |
| `interact` | like, boost, reply, follow (fediverse + Bluesky) |
| `dm` | read and send direct messages |
| `manage` | comment moderation, backfill, sync, and **block** (block deletes the actor's posts, so it's a manage-level action) |

A bearer token missing an endpoint/action's scope gets **403 `insufficient_scope`**.

---

## Read API (`read` scope, unless noted)

All are `GET` (read-only, no CSRF) with `Authorization: Bearer <token>`.

| endpoint | returns |
|---|---|
| `GET /api/feed?cursor=<ISO>&replies=1&boosts=1` | `{ posts: [...], nextCursor }` — your private Fediverse timeline (paged, 20/page; `cursor` = last `publishedAt`) |
| `GET /api/posts?cursor=<ISO_id>&status=&type=&limit=` | `{ posts: [...], nextCursor }` — **your own** posts for a content manager (incl. drafts/scheduled). Each post has `id, slug, url, title, excerpt, preview, category, type, status, published, publishedAt, updatedAt, scheduledFor, counts, media`. `preview` is a short markup-stripped body snippet (`""` when genuinely empty) so title-less notes still render. Filters: `status` = `all\|published\|draft\|scheduled`, `type` = `note\|article\|journal\|photo\|video\|audio` |
| `GET /api/notifications` | `{ count, items, categoryCounts }` — the bell. **DM items require `dm` scope** (redacted otherwise) |
| `GET /api/conversation?postId=<id>` | `{ thread: [...] }` — a full thread (ancestors + replies) |
| `POST /api/fedi-post-counts` `{ postId }` | `{ likeCount, boostCount, replyCount, countsFetchedAt }` (cached ~5 min) |
| `GET /api/graph` | `{ followers: [...], following: [...], counts: { followers, following } }` (Fedi + Bluesky, merged) |
| `GET /api/account` | `{ me, actor, handle, domain, fediAddress, name, authorName, summary, avatar, banner, counts }` — the app's "who am I connected as" |
| `GET /api/dms` | `{ messages: [...], readState }` — direct messages. **Requires `dm` scope** |

---

## Creating posts — `POST /api/micropub` (`create` scope)

Standard [Micropub](https://micropub.spec.indieweb.org/). JSON:

```json
{ "type": ["h-entry"], "properties": { "content": ["Hello from my app"] } }
```

Optional properties: `name` (title → article), `category` (tags array),
`"post-status": ["draft"]`, `photo` (media URLs from `/api/media`). Also accepts
form-encoded h-entry. **201** with a `Location` header for the new post.
`action: "delete"` + `url` deletes a post (`delete` scope). `GET
/api/micropub?q=config` returns the media-endpoint + post types.

---

## Write actions — `POST /api/admin` (scoped per action)

One endpoint, dispatched on a JSON `action` field, each gated on its own scope.
`403 insufficient_scope` if the token lacks it; unknown action → `400`.

| action | scope | body (besides `action`) |
|---|---|---|
| `like` / `unlike` / `boost` / `unboost` | `interact` | `postApId`, `targetInbox` |
| `reply` | `interact` | `content`, `inReplyTo`, `targetInbox`, `actorUri`, `mentionHandle`, `crosspostBluesky?` |
| `edit_reply` | `interact` | `replyId`, `content` |
| `follow` | `interact` | `handle` (`@user@domain`) |
| `unfollow` / `unfollow_by_uri` | `interact` | `followingId` / `actorUri` |
| `bsky_reply` / `bsky_follow` / `bsky_unfollow` | `interact` | (Bluesky equivalents) |
| `dm_reply` / `dm_new_fedi` | `dm` | `content`, `recipientUri` **or** `recipientHandle`, `recipientInbox?` |
| `bsky_dm_reply` / `bsky_dm_new` | `dm` | (Bluesky DM) |
| `mark_dm_read` / `mark_all_dms_read` | `dm` | `conversationKey` / — |
| `approve_comment` / `reject_comment` | `manage` | guest-comment moderation |
| `backfill_replies` / `sync_bluesky_graph` | `manage` | maintenance |
| `block` | `manage` | `actorUri` (unfollows + deletes their posts/interactions) |

Marking notifications read: `POST /api/notifications` (empty body) — requires
`interact` (it's a write).

Exact field details live in the source under
`src/app/api/admin/_actions/*.ts`; the web timeline client is a working reference.

## Media upload — `POST /api/media` (`media` scope)

`multipart/form-data` with a `file` field (image or audio). Returns the stored
URL. Micropub tokens carry `media` by default.

---

## Notes for native apps

- **Redirect URIs** (registered per client, exact-match): a custom scheme
  `fedihome-macos://callback` **or** a loopback URL `http://127.0.0.1:<any-port>/callback`
  (also `http://[::1]:<port>/callback`). No other web redirects are allowed, and
  no userinfo/query/fragment on loopback.
- Use **`ASWebAuthenticationSession`** with your custom scheme as the callback —
  it intercepts the redirect automatically.
- Store the token in the **Keychain**. Treat it like a password.
- Tokens are long-lived and **revocable** (no refresh tokens in v1). Handle a
  `401` by prompting the owner to reconnect.
- The consent step returns an HTML page that navigates to your redirect (not a
  raw 302) — a browser session handles this transparently.

### First-party client ids

| client_id | redirect scheme |
|---|---|
| `fedihome-macos` | `fedihome-macos://callback` (+ loopback) |
| `fedihome-ios` | `fedihome-ios://callback` (+ loopback) |
| `fedihome-android` | `fedihome-android://callback` (+ loopback) |

Third-party clients (IndieAuth `client_id` URLs, dynamic registration) are not
supported yet.
