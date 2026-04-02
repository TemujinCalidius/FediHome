# Changelog

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
