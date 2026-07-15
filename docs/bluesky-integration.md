# Bluesky Integration

FediHome can automatically crosspost your content to Bluesky when you publish. Posts, photos, and articles are sent to your Bluesky account with images and link cards.

## How It Works

When you publish a post on FediHome, the crossposting system:

1. Logs into your Bluesky account using the AT Protocol
2. Formats the content for Bluesky's 300-character limit
3. Uploads any attached images (up to 4) as blobs
4. Parses rich text to detect links, mentions, and hashtags
5. Creates the post on Bluesky
6. Stores the returned `at://` URI on the post record for reply syncing

**Articles** are crossposted as a summary (the description field or the first 300 characters of content) with a link back to the full post on your site.

**Notes** are crossposted as-is, truncated to 300 characters if necessary.

## Getting a Bluesky App Password

Do NOT use your main Bluesky password. Instead, generate a dedicated app password:

1. Log into [bsky.app](https://bsky.app)
2. Go to **Settings** > **Privacy and security** > **App passwords**
   - Direct link: [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
3. Click **Add App Password**
4. Give it a name like "FediHome"
5. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`)

This app password can create posts and upload media but cannot change your account settings or password.

## Configuration

### Preferred: the admin panel (no file editing)

Go to **Admin → Integrations** (`/admin/integrations`), enter your handle and app
password under **Bluesky**, and click **Test** then **Save**. The app password is
stored **AES-256-GCM-encrypted at rest** (the key is derived from your
`ADMIN_SECRET`, which never touches the database), verified on save, and never
shown again. No restart needed. Threads is configured the same way.

### Alternative: environment variables

You can instead set these in `.env.local` (an admin-panel value takes precedence):

```
BLUESKY_HANDLE=yourhandle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

If you use a custom domain as your Bluesky handle, use that (e.g.
`BLUESKY_HANDLE=yourdomain.com`). Restart FediHome after setting env variables.

## What Gets Crossposted

| Content Type | Bluesky Format |
|-------------|----------------|
| Note (short post, no title) | Full text, truncated to 300 chars. Images attached inline. |
| Article (post with a title) | Summary/description text + link to the full article. Images attached inline. |
| Photo post | Caption text + link. Photos uploaded as image embeds (up to 4). |

### Image Handling

FediHome reads images from the local filesystem when possible (faster and avoids race conditions with the public URL not being available yet). If the image is at an external URL, it falls back to an HTTP fetch.

Images are uploaded to Bluesky as blobs with the correct MIME type detected from the file extension. Bluesky supports JPEG, PNG, WebP, and GIF.

Alt text from your photo captions is included on each image.

### Rich Text

The crossposting system uses Bluesky's `RichText` class to automatically detect and create facets for:
- URLs (clickable links)
- Mentions (`@handle.bsky.social`)
- Hashtags (`#topic`)

### Character Limit

Bluesky has a 300-character limit. FediHome handles this:
- If the content + URL fits within 300 characters, both are included
- If not, the content is truncated with `...` to make room for the URL
- If there's no URL and content exceeds 300 characters, it's truncated to 297 + `...`

## Reply Syncing

FediHome can poll for replies to your crossposted Bluesky posts and display them on your site alongside Fediverse interactions.

When a post has a `blueskyUri` stored (set automatically during crossposting), the reply polling system:
1. Fetches the thread from Bluesky's API
2. Stores new replies in the `BlueskyReply` table with the author's handle, display name, avatar, and content
3. These replies are displayed on the post page alongside guest comments and Fediverse interactions

The follower-graph, DM, and notification sync runs automatically every 15 minutes
via FediHome's built-in scheduler (no cron needed) — tune or disable it with the
`SCHEDULER_BLUESKY_*` env vars (see `.env.example`).

## Disabling Crossposting Per Post

When composing a post from the admin panel, each crosspost destination has a toggle. You can disable Bluesky crossposting for individual posts by unchecking it before publishing.

When posting via Micropub, crossposting is enabled by default if credentials are configured.

## Troubleshooting

### "Bluesky credentials not configured"

The `BLUESKY_HANDLE` or `BLUESKY_APP_PASSWORD` env var is missing or empty. Check `.env.local`.

### "Authentication required" or login failure

- Make sure `BLUESKY_HANDLE` is your full handle (e.g., `name.bsky.social`, not just `name`)
- Verify the app password is correct — regenerate it if unsure
- If you changed your Bluesky handle recently, update the env var

### Images not appearing on Bluesky

- Check the server logs for "Bluesky image upload failed" errors
- Ensure images are in a supported format (JPEG, PNG, WebP, GIF)
- Bluesky has a ~1MB limit per image blob. Very large images may fail.

### Posts appearing on Bluesky without link cards

Bluesky does not automatically generate link card previews from URLs in post text. FediHome sends the URL as plain text with a link facet. The link is clickable but may not show a rich card preview.
