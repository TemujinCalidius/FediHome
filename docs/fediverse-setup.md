# Fediverse Setup

This guide explains how FediHome connects to the Fediverse, how your identity works, and how to test and troubleshoot federation.

## What is the Fediverse?

The Fediverse is a network of interconnected servers that communicate using the **ActivityPub** protocol. Mastodon, Pixelfed, Misskey, Lemmy, PeerTube, and many other platforms all speak ActivityPub, which means users on any of these platforms can follow, interact with, and receive posts from users on any other platform.

FediHome makes your personal website a full participant in this network. When someone on Mastodon follows you, your posts show up in their home feed — even though you're not on Mastodon.

## Your Identity

Your Fediverse identity is:

```
@yourhandle@yourdomain.com
```

This is set by two environment variables in `.env.local`:

- `FEDI_HANDLE` — the username part (e.g., `sam`)
- `FEDI_DOMAIN` — the domain part (e.g., `samcorner.com`)

Together, these form `@sam@samcorner.com`. This is what people type into Mastodon's search bar to find and follow you.

## Moving Here From Another Account

Coming to FediHome from Mastodon (or anywhere else that speaks ActivityPub)?
You can bring your **followers** with you.

The network verifies a move from both ends, so the order matters:

1. **On FediHome**, go to **Admin → Site settings → Moving here from another
   account** and add your old profile address (e.g.
   `https://mastodon.social/users/you`). This publishes it as an `alsoKnownAs`
   alias on your actor — it's how the other server confirms the two accounts are
   really the same person.
2. **On the old account**, start the move (on Mastodon: **Preferences → Account →
   Moving to a different account**) and give it your FediHome address.
3. Their server sends a `Move` to everyone following you. Each of those servers
   fetches *your FediHome actor*, checks that the alias from step 1 names the old
   account, and only then re-points the follow.

**Keep the old account online.** The verification in step 3 fetches both ends, so
if the old server is gone the move can't be checked and nothing happens. Give it
weeks, not hours.

**Only followers move.** Your posts, the list of people *you* follow, and any
blocks or mutes stay behind — export and re-import those separately. Mastodon
also enforces a 30-day cooldown between moves, and a move can't be undone.

## Changing Your Domain

**Choose your domain before you federate, and treat it as permanent.**

In ActivityPub there is no rename. Your identity is your **actor id** — a URL
built from `SITE_URL`, like `https://samcorner.com/ap/actor`. Every remote server
that has ever seen you stores *that URL*, along with the public key it fetched
from it. Change the domain and, as far as the network is concerned, the old
account simply stopped existing and an unrelated new one appeared. Your followers
stay attached to an address that no longer answers.

### How the network handles a move

Mastodon (and micro.blog, and others) solve this with a two-sided handshake:

1. On the **new** account you add an **alias** — `alsoKnownAs` — pointing at the
   old actor URL.
2. From the **old** account you publish a **`Move`** activity and set `movedTo`
   on the old actor.
3. Each remote server that receives the `Move` **fetches the old actor to verify
   it, then fetches the new one and checks that its `alsoKnownAs` names the old
   address.** Only if both agree does it move the follow across.

Step 3 is the part that catches people out: **the old domain has to still be
serving** while followers migrate. A `Move` published from a domain you no longer
control cannot be verified, so nothing moves. Lose the domain first and your
followers are simply gone — you keep the list of accounts *you* follow, because
that lives in your own database, but the people following *you* cannot be
brought across by any later action.

Even done correctly, migration is best-effort: servers that are down during the
move, or that don't implement `Move`, will keep pointing at the old address.

### What this means for FediHome today

FediHome implements the **arriving** half — you can publish an `alsoKnownAs`
alias (see [Moving Here From Another Account](#moving-here-from-another-account)),
so someone can move *to* a FediHome from elsewhere and bring their followers.

FediHome also **follows accounts that move away**: if someone you follow migrates
to another server, their `Move` is verified and your follow is re-pointed
automatically, and you get a notification saying so.

FediHome implements the **leaving** half too (#347): **Admin → Site settings →
Moving away from here**. Enter the new account's address and FediHome sets
`movedTo` on your profile and sends a `Move` to every follower.

Before it sends anything, it checks the new account lists this one in its
`alsoKnownAs`. That check is not politeness — it is exactly what every receiving
server does, and a `Move` that fails it is refused everywhere, silently, while
you are told it worked. So FediHome refuses to send one at all and tells you what
to add on the other server.

What you need to know before pressing it:

- **Only followers move.** Your posts, your own following list, your blocks and
  your mutes all stay. That is a limit of the protocol, not of FediHome --
  Mastodon behaves identically.
- **Keep this instance running afterwards.** Every server verifies the move by
  fetching this profile. Take it down and any follower whose server had not yet
  checked can never be moved, by you or by anyone. FEP-7628 asks servers to keep
  serving `movedTo` for **at least a year**.
- **This account stops publishing.** New posts are refused from the composer,
  Micropub, XML-RPC and the scheduler, so nothing goes out from an account whose
  profile says you are elsewhere. Replies and likes still work, so you do not
  abandon a conversation mid-thread.
- **Send it again whenever you like.** The activity keeps a stable id, so servers
  that already moved your followers ignore a repeat. Worth doing if someone tells
  you their follow did not come across.
- **Cancelling stops telling people you moved. It does not bring followers back**
  — anyone whose server already acted is following the new account now, and
  nothing on this end can reach into theirs.
- Moving somewhere **else** afterwards means waiting 30 days, matching Mastodon.

### Moving to a new domain, rather than to another server

A move carries followers to a **different account**. It does not rename this one,
and the caveats below still apply if what you actually want is the same content
on a new domain:

1. Stand up a **new instance on the new domain**, running alongside the old one.
2. Migrate your content to it (a database restore keeps your posts and your
   following list).
3. Publish the move from the old instance, and **leave the old server running**
   for a good while — weeks, not hours — so every remote server gets a chance to
   verify and follow the redirect.
4. Only then decommission the old domain.

Note that **post URLs are stored absolutely**: a post published at
`https://old.example/post/hello` keeps that URL in the database. A restore onto a
new domain carries those old URLs with it, so links and federated copies of older
posts still point at the old host. That is another reason to keep the old domain
alive rather than cutting it over.

And it's why setting up against `localhost` or a private address matters: the
setup wizard makes you confirm it explicitly, because an identity nobody can
reach gets written into your actor *and* into every post you publish before you
move.

## DNS Requirements

For federation to work, your domain must:

1. **Resolve to your server.** Either via a direct A/AAAA record or via Cloudflare Tunnel.
2. **Serve HTTPS.** ActivityPub requires TLS. Use Let's Encrypt, Cloudflare, or another certificate provider.
3. **Respond to WebFinger requests** at `https://yourdomain.com/.well-known/webfinger`. FediHome handles this automatically.

## How Federation Works

### WebFinger Discovery

When someone searches for `@sam@samcorner.com` on Mastodon, their server makes a WebFinger request:

```
GET https://samcorner.com/.well-known/webfinger?resource=acct:sam@samcorner.com
```

FediHome responds with a JSON document pointing to your ActivityPub actor:

```json
{
  "subject": "acct:sam@samcorner.com",
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://samcorner.com/ap/actor"
    }
  ]
}
```

### Actor Profile

The remote server then fetches your actor profile:

```
GET https://samcorner.com/ap/actor
Accept: application/activity+json
```

This returns your profile information, including your name, bio, avatar, banner image, public key, and endpoint URLs (inbox, outbox, followers, following).

### Following

When a Mastodon user clicks "Follow," their server sends a Follow activity to your inbox:

```
POST https://samcorner.com/ap/inbox
```

FediHome automatically accepts the follow, stores the follower in the database, and sends back an Accept activity to confirm.

### Being Followed

When you follow someone from FediHome's timeline interface, FediHome:
1. Fetches their actor profile via WebFinger + actor URL
2. Sends a Follow activity to their inbox, signed with your private key
3. Waits for their server to send an Accept back to your inbox
4. Once accepted, stores them in the `FediFollowing` table

After that, their server will deliver new posts to your inbox, and they'll appear in your timeline.

### How Posts Federate

When you publish a post, FediHome:
1. Creates the post in the database with an ActivityPub ID (e.g., `https://samcorner.com/post/my-first-post`)
2. Wraps it in a Create activity
3. Signs the activity with your RSA private key (HTTP Signatures)
4. Delivers it to every follower's inbox (or shared inbox for efficiency)

The signed HTTP request proves the post really came from your server. Remote servers verify the signature against the public key in your actor profile.

### Interactions

When someone on Mastodon likes, boosts, or replies to your post, their server sends the corresponding activity to your inbox:

- **Like** — Increments the like count on the post. Stored as a `FediInteraction`.
- **Announce (Boost)** — Increments the boost count. If the booster is someone you follow, the boosted post appears in your timeline.
- **Create (Reply)** — Stored as a `FediInteraction` of type "reply." If the replier is someone you follow, the reply also appears in your timeline.
- **Undo Like / Undo Follow** — Reverses the original action.

### Direct Messages

If someone sends you a Note that is addressed only to your actor (not to the public `as:Public` audience), FediHome stores it as a direct message in the `DirectMessage` table, viewable in your admin panel.

## Testing WebFinger

The easiest way to verify federation is working:

```bash
curl -s "https://yourdomain.com/.well-known/webfinger?resource=acct:yourhandle@yourdomain.com" | python3 -m json.tool
```

Expected output:

```json
{
    "subject": "acct:yourhandle@yourdomain.com",
    "aliases": [
        "https://yourdomain.com/ap/actor"
    ],
    "links": [
        {
            "rel": "self",
            "type": "application/activity+json",
            "href": "https://yourdomain.com/ap/actor"
        },
        {
            "rel": "http://webfinger.net/rel/profile-page",
            "type": "text/html",
            "href": "https://yourdomain.com"
        }
    ]
}
```

You can also test the actor endpoint:

```bash
curl -s -H "Accept: application/activity+json" "https://yourdomain.com/ap/actor" | python3 -m json.tool
```

This should return your full actor profile with name, bio, avatar, endpoints, and public key.

## Testing from Mastodon

1. Log into any Mastodon instance.
2. In the search bar, type `@yourhandle@yourdomain.com`.
3. Your profile should appear. If it does, WebFinger and actor discovery are working.
4. Click Follow. Within a few seconds, FediHome should accept and you should see the follow confirmed.
5. Make a post on FediHome. It should appear in your Mastodon home feed.

## HTTP Signatures

FediHome signs all outgoing ActivityPub requests with HTTP Signatures (draft-cavage-http-signatures-12), which is the standard used by Mastodon and most other ActivityPub implementations.

Each request includes:
- A `Signature` header with the key ID, algorithm (`rsa-sha256`), signed headers list, and the signature itself
- A `Digest` header with a SHA-256 hash of the request body
- A `Date` header with the current UTC time

Your RSA key pair is generated automatically on first run and stored in the `ActorKeys` table. The public key is published in your actor profile so remote servers can verify your signatures.

FediHome also verifies incoming signatures on requests to the inbox endpoint. If a request has an invalid signature, it is rejected with a 401 status.

## ActivityPub Endpoints

FediHome exposes these ActivityPub endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/webfinger` | GET | WebFinger discovery |
| `/ap/actor` | GET | Actor profile (Person object) |
| `/ap/inbox` | POST | Receive activities (Follow, Like, Create, Announce, Undo, Delete) |
| `/ap/outbox` | GET | List of published activities |
| `/ap/followers` | GET | Followers collection |
| `/ap/following` | GET | Following collection |
| `/ap/post/[slug]` | GET | Individual post as ActivityPub object |

## Troubleshooting

### "Could not find user" when searching from Mastodon

- Verify WebFinger is working (see testing section above)
- Check that `FEDI_HANDLE` and `FEDI_DOMAIN` match exactly what you're searching for
- Make sure `SITE_URL` uses `https://`, not `http://`
- Some Mastodon instances cache failed lookups. Wait a few minutes and try again.

### Followers not receiving posts

- Check the server logs for "Failed to federate post" errors
- Verify your actor keys exist: `npx prisma studio` and check the `ActorKeys` table
- Some servers reject signatures if the `Date` header is more than 30 seconds old. Make sure your server's clock is accurate.

### Posts from followed accounts not appearing

- The remote server must have accepted your follow request (check `FediFollowing` table for the entry)
- Posts only appear if the sender is in your `FediFollowing` table
- Replies from non-followed accounts only appear if they're replying to your content
