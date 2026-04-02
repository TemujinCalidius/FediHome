# Micropub

FediHome supports the [Micropub](https://micropub.spec.indieweb.org/) protocol, which lets you create posts from third-party apps instead of using the web admin panel. This is useful for posting from your phone, tablet, or desktop writing apps.

## What is Micropub?

Micropub is an open W3C standard for creating, editing, and deleting posts on a website. It uses simple HTTP requests with bearer token authentication. Many IndieWeb-compatible apps support it out of the box.

## Setting Up Authentication

Micropub uses bearer tokens to authenticate requests. FediHome stores hashed tokens in the `AuthToken` database table.

### Generating a Token

Currently, tokens are generated programmatically. You can create one using Prisma Studio or a quick script:

```bash
# Open Prisma Studio
npx prisma studio
```

Or run a one-off script:

```bash
node -e "
const crypto = require('crypto');
const token = crypto.randomBytes(32).toString('hex');
const hash = crypto.createHash('sha256').update(token).digest('hex');
console.log('Token (save this — you will not see it again):');
console.log(token);
console.log('');
console.log('Hash (stored in database):');
console.log(hash);
"
```

Then insert the hash into the `AuthToken` table:

```sql
INSERT INTO "AuthToken" (id, "tokenHash", label, scope, "createdAt")
VALUES (gen_random_uuid(), 'YOUR_HASH_HERE', 'iA Writer', 'create update delete media', NOW());
```

Or via Prisma Studio: create a new `AuthToken` record with the `tokenHash` and a descriptive `label`.

### Token Scopes

The default scope is `create update delete media`, which allows full posting capability. You can restrict tokens to specific actions by setting a narrower scope.

## Supported Clients

### iA Writer

[iA Writer](https://ia.net/writer) supports Micropub for publishing directly from the app.

1. In iA Writer, go to **Settings** > **Accounts** > **Add Account** > **Micropub**
2. Enter your site URL: `https://yourdomain.com`
3. iA Writer will discover the Micropub endpoint from the `<link rel="micropub">` tag in your HTML
4. Enter your bearer token when prompted
5. Write in Markdown and publish directly to FediHome

### micro.blog

[micro.blog](https://micro.blog) can post to any Micropub endpoint.

1. Go to your micro.blog account settings
2. Under **External blog**, set the Micropub endpoint to `https://yourdomain.com/api/micropub`
3. Enter your bearer token
4. Posts from micro.blog will be published to your FediHome

### Quill

[Quill](https://quill.p3k.io) is a web-based Micropub client.

1. Go to [quill.p3k.io](https://quill.p3k.io)
2. Enter your site URL
3. Authenticate with your token
4. Use Quill's interface to create notes, articles, and photo posts

### Any HTTP Client

You can post from any tool that can make HTTP requests:

```bash
curl -X POST https://yourdomain.com/api/micropub \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": ["h-entry"],
    "properties": {
      "content": ["Hello from curl!"]
    }
  }'
```

## Creating Posts

### JSON Format

```bash
curl -X POST https://yourdomain.com/api/micropub \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": ["h-entry"],
    "properties": {
      "name": ["My Article Title"],
      "content": ["The full content of the article in Markdown."],
      "category": ["tech", "fediverse"]
    }
  }'
```

- **With a `name`** — Creates an Article (long-form blog post)
- **Without a `name`** — Creates a Note (short status update)
- **`category`** — Sets tags on the post
- **`post-status`: `"draft"`** — Creates an unpublished draft

### Form-Encoded Format

```bash
curl -X POST https://yourdomain.com/api/micropub \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d "h=entry" \
  -d "content=A quick note from my phone"
```

### Response

A successful post returns HTTP 201 with a `Location` header pointing to the new post:

```
HTTP/1.1 201 Created
Location: https://yourdomain.com/post/my-article-title
```

## Uploading Photos

Photos are uploaded to the media endpoint first, then referenced in the post.

### Upload an Image

```bash
curl -X POST https://yourdomain.com/api/media \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/photo.jpg"
```

Response:

```
HTTP/1.1 201 Created
Location: https://yourdomain.com/uploads/2026/04/photo.jpg
```

### Create a Post with Photos

```bash
curl -X POST https://yourdomain.com/api/micropub \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": ["h-entry"],
    "properties": {
      "content": ["Sunset at the beach"],
      "photo": ["https://yourdomain.com/uploads/2026/04/sunset.jpg"]
    }
  }'
```

## Querying Configuration

Micropub clients can discover your endpoint's capabilities:

```bash
curl "https://yourdomain.com/api/micropub?q=config" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Response:

```json
{
  "media-endpoint": "https://yourdomain.com/api/media",
  "post-types": [
    { "type": "note", "name": "Note" },
    { "type": "article", "name": "Article" },
    { "type": "photo", "name": "Photo" }
  ],
  "categories": ["journal", "note", "article", "photo"]
}
```

## Querying a Post's Source

```bash
curl "https://yourdomain.com/api/micropub?q=source&url=https://yourdomain.com/post/my-post" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Response:

```json
{
  "type": ["h-entry"],
  "properties": {
    "name": ["My Post Title"],
    "content": ["The raw Markdown content..."],
    "published": ["2026-04-01T12:00:00.000Z"],
    "category": ["tech"],
    "post-status": ["published"]
  }
}
```

## Deleting a Post

```bash
curl -X POST https://yourdomain.com/api/micropub \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "delete",
    "url": "https://yourdomain.com/post/my-post"
  }'
```

Returns HTTP 204 on success.

## Federation and Crossposting

Posts created via Micropub are automatically:
- **Federated** to all ActivityPub followers
- **Crossposted** to Bluesky and Threads (if configured)
- **Added to the RSS feed**

This works identically to posts created from the web admin panel.

## Endpoint Discovery

FediHome includes the standard `<link>` tags in the HTML `<head>` so Micropub clients can auto-discover the endpoint:

```html
<link rel="micropub" href="https://yourdomain.com/api/micropub" />
<link rel="token_endpoint" href="https://yourdomain.com/api/micropub" />
```

Most clients use these links to configure themselves automatically when you enter your site URL.
