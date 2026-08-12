# Changelog

## Unreleased

### Added
- **Set your own AT Protocol server from the admin panel** (#504) — v1.25.0 said you could point FediHome at a PDS you run yourself, and the only way to actually do it was an environment variable, which on a hosted platform often means no way at all. There's now a **Server address** field under **Bluesky** in Admin → Integrations. Leave it blank and nothing changes — that's what nearly everyone should do. **Test** signs in to whatever is in the box, so you can check a new address before committing to it, and clearing the box puts you back on `bsky.social`. If you'd set the environment variable, the panel says so and saving here takes over.

### Fixed
- **The support bundle stops contradicting itself about rate limiting** (#551) — the bundle has a line saying whether FediHome can tell your visitors apart, and it worked that out from your settings rather than from what the site was actually doing. Those agree until you mistype the header name — at which point FediHome correctly ignores it and falls back to treating everyone as one visitor, while the bundle confidently reported the opposite. That's the one line you'd check to find out why your limits were behaving oddly, so a wrong answer there sent you looking in the wrong place. It now asks the same code that does the keying, and when it says SHARED it also says why — whether the setting is off, or set to something unrecognised.
- **Setting the media cache to 0 now really does cache nothing** (#550) — it stopped images and went on copying every video from your feed to disk, up to 50MB each. The setting is documented as turning caching off entirely, and the admin panel says so under a sentence that also promises video is included, so the one place you'd check to confirm it was the place that misled you. Worse, `0` was quietly the *least* bounded choice: since the hourly storage scan became the only thing that trims the cache, turning that scan off as well left those video copies with no ceiling at all — which is exactly the pair of settings someone with a small disk would reach for. Videos are now refused like images, and load from the original server instead.
- **The Docker image can be built again** (#552) — v1.27.0 and v1.27.1 could not be built into a container at all, so anyone installing or upgrading with Docker was stuck on v1.26.0 and couldn't reach the admin-login fix or the trusted-proxy setting. The container was being built on Node 20 while parts of FediHome had come to need Node 22, and the mismatch showed up as a confusing failure part-way through the build that named a different page each time. The image now uses Node 22, matching what everything else is tested on. **And the reason it got out twice: nothing ever built the container.** Every automated check passed because none of them touched it — building the image is now one of those checks, so a release that can't be installed this way can't be published.
- **Your own AT Protocol server actually works now** (#541) — since v1.25.0 you've been able to point FediHome at a PDS you run yourself, and it only half worked: your timeline and your likes went to your server, but **posting, replying, follows, DMs and notifications all still went to bsky.social** and failed there, because twelve separate places had the address written into them instead of reading your setting. Your app password was being sent to Bluesky on each of those attempts too, in a sign-in that could never succeed. They all use the one shared connection now, so the address you configure is the address FediHome uses — everywhere. Nothing changes if you're on bsky.social, which is still the default.

## 1.27.1 (2026-08-08)

### Changed
- Declared the last two ESLint plugins the config imports directly — `@next/eslint-plugin-next` and `eslint-plugin-react-hooks` (#507). They resolved only because another package happened to pull them in, so a routine update could have removed them and broken linting with a confusing missing-module error. No lint rule changes; the output is byte-identical.

### Fixed
- **Checklists keep their ticks** (#529) — a markdown to-do list (`- [x] done`) had its checkboxes removed when the page was cleaned for safety, so a finished item looked exactly like an unfinished one. Not a styling quirk — the information was gone. Checkboxes now survive, as read-only ticks, and nothing else about what an outside server can put on your page has been loosened.
- **`***` and `___` are dividers again in the composer** (#530) — markdown has three ways to write a horizontal line and the composer only recognised one, so the other two were published as literal asterisks or underscores. Worse, two of them in the same article turned everything between into bold italics. All three now work, and match what an article posted from an app already did. **Code blocks are also left alone now** — the composer was reaching inside them and formatting your code: `**bold**` in a code block came out bold, and a line of dashes became a divider in the middle of your snippet. Articles already published keep what they have; this applies to new ones and to anything you edit.
- **Rolling back and forward again no longer republishes strangers' posts** (#516) — when you open one stranger's thread out of curiosity, the posts FediHome fetches to show it are marked so they never appear on your public page. A note recording that this marking has been done was kept separately from the marking itself — so if you ever downgraded and came back up, the marks were gone while the note still said the job was finished, and every one of those posts was public again under your domain, silently. FediHome now confirms the work is still there before trusting the note. It still only does the job once, so this doesn't reopen the problem that made the note necessary.
- **Bluesky posts arrive with their photos again** (#512) — a post you saw people talking about would come through with the words and nothing else. Bluesky has six different ways of attaching things to a post and FediHome only understood one of them, so **a quote post with a photo** — one of the most common kinds there is — imported completely blank, along with multi-photo galleries, videos and link previews. All six are now read: galleries and quoted photos appear, a video shows its still frame, and a shared link gets the proper preview card the fediverse posts already had. Two smaller faults went with it. If saving a copy of a picture failed, the picture was **deleted** rather than loaded from Bluesky — which meant setting your media cache to 0, documented as "media then loads from the original server", did the exact opposite for Bluesky. And every Bluesky post was silently excluded from the repair that puts images back after the cache is trimmed. Posts still in the polling window will pick up what they were missing on the next sync; older ones keep what they have.

### Security
- **Cleared two new advisories — `npm audit` is back to zero** (#542, #543) — `js-yaml` (GHSA-5p4m-2wfm-xmqj, CVE-2026-59870, quadratic CPU in `!!omap`) and `nanoid` (GHSA-2v37-7h3g-55p8, custom generators looping at size zero), both rated high, are pinned to patched versions tree-wide via `overrides`. Neither is reachable from a running site: `js-yaml` arrives only through the ESLint toolchain and nothing here imports it, and `nanoid` arrives through PostCSS, which asks it for a fixed six-character id rather than using the custom generator the advisory is about. Hygiene rather than an emergency, and it keeps a self-hosted install's audit clean. **The `js-yaml` pin had gone stale again** — it sat at a range that still allowed the affected version, so an override that looked current protected nothing. That is the third time this package has needed the same correction, so it is now pinned above the advisory rather than merely updated in the lockfile.
- **A stranger can no longer lock you out of your own admin login** (#531) — the login page allows five wrong passwords a minute before it starts refusing. That counter was keyed on who was asking — except that on a normal install FediHome can't tell one visitor from another, so **everyone counted as the same person**. Anyone could send five wrong passwords a minute, forever, and you'd be refused at your own door with the correct password, because the refusal happened before the password was even looked at. The strict per-visitor limit is now only used when your site can actually identify visitors — which is what `TRUSTED_PROXY_HEADER` does, and it's worth setting for exactly this reason. Otherwise there's a single overall limit of 20 failed logins per 5 minutes: high enough that you'll never meet it by mistyping, and short enough that if someone does try this you're waiting minutes rather than indefinitely. Restarting FediHome clears it at once. Your support bundle now says which of the two your site is using (corrected in #551 — it originally reported what your settings implied rather than what was actually happening).

## 1.27.0 (2026-08-05)

### Added
- **The owner area now has a home page, and a way to find things** (#368) — going to `/admin` used to give you "not found", and the only links to any of the admin pages lived in one row at the top of the timeline. Miss that row and Sessions, App activity and Integrations were effectively invisible. There's now **a proper home at `/admin`**: everything you can change, grouped by what you're trying to do rather than by which page it happens to live on, plus a few numbers about your instance. Every admin page carries the same navigation bar, so you can always get back. And there's a **search box** — type "push", "backup", "blocked" or "cron" and it takes you straight to the right section, including words the screens themselves don't use. **"Instance settings" is now called "Background jobs"**, which is what it contains; nothing moved, so your bookmarks and links still work.
- **Web apps like Quill and Micropublish can now just sign in** (#494) — the other half of the change below. An app whose ID is a web address doesn't need registering, because the address itself is the proof: FediHome fetches it, reads the app's name from the page, and accepts a sign-in only if the redirect is on that same site or is listed on that page. If the address can't be reached, or doesn't list the redirect, the sign-in is refused — an address nobody answers proves nothing. Apps with a custom link scheme (`obsidian://`, `raycast://`) still have to be registered by hand, because there's no page to check. The approval screen now tells you which kind you're approving, and for a web app shows the address it checked — worth a glance, since the *name* on that screen came from a page you don't control.
- **Take your followers with you when you leave** (#347) — the no-lock-in promise, finished. FediHome could already bring followers *in* from another server, and follow people who moved *away*; the one thing it couldn't do was let **you** go. **Admin → Site settings → Moving away from here** now sets up the move: enter the new account's address and FediHome tells every one of your followers' servers to move them across. **It checks first that the new account lists this one as an alias** — that's the same check every receiving server makes, and a move that fails it is refused everywhere while telling you it worked, so FediHome refuses to send one at all and tells you exactly what to add on the other server. The screen is honest about the parts people get caught by: **only followers move** (your posts and your own following list stay), **keep this instance running afterwards** — for a year is the recommendation, because servers verify the move by fetching this profile and any follower whose server hasn't checked yet can never be moved once it's gone — and cancelling stops telling people you've moved but **does not bring followers back**. Afterwards this account stops publishing new posts, from the composer, blog editors and scheduled posts alike, so nothing goes out from an account whose profile says you're elsewhere; replies and likes still work, so you don't abandon a conversation mid-thread. You can re-send the move any time, which is worth doing if someone says their follow didn't come across. Anyone visiting your profile sees where you went.
- **Explore: find people through the ones you already follow** (#386) — until now the only way to meet anyone new was to already know their address and paste it in. Turn on **Explore** in **Admin → Site settings** and you get a second tab beside your timeline showing posts from people you *don't* follow, surfaced because someone you *do* follow boosted them or replied to them. No algorithm and no firehose: the people you picked are the filter. Some of it is content your server has been receiving and discarding all along — every boost by someone you follow was already being saved and then hidden. The rest is new: when a friend replies to a stranger, FediHome now goes and fetches the post they were replying to, which is the half that never arrives on its own. Public posts only, nothing from anyone you've blocked (checked on whoever *wrote* the post, not whoever passed it on), at most ten requests to other servers an hour, and a limit on how much is kept so it can't fill your disk. **Off unless you turn it on**, and nothing it finds ever appears on your public pages. Liking, boosting and replying work exactly as they do in your timeline.

### Changed
- **Updated the networking library FediHome uses for every outbound request** (#506) — `undici` moves from 6.28 to 8.10. Nothing changes for you; the work was in making the update *possible*. The safeguard that pins each connection to the address it just checked is built by that library, and it was being handed to a different copy of it — fine while the two were the same version, and a total federation outage the moment they weren't. That was fixed first; this is the update it unblocked.
- Dependency refresh: `next` + `eslint-config-next` 16.3.0, `@atproto/api` 0.20.37, `@types/pg` 8.20.3, `tsx` 4.23.5. (`typescript` remains held at 6.x — see #234; `@typescript-eslint` remains capped at 8.61.1 by `eslint-config-next`.)

### Fixed
- **The support bundle no longer reports a setting you don't have** (#511) — the bundle lists the settings FediHome reads and whether each one is set. One of them was spelled wrong, so a site sitting behind a reverse proxy or Cloudflare — correctly configured, working fine — still had its bundle say `TRUST_PROXY   not set`. That's the one document you paste into a bug report, so it sent both of us chasing a setting that was never the problem. Fixed, and the list is now checked against the code, so a name nothing actually reads can't quietly appear there again.
- **Federation keeps working when undici updates** (#506) — an internal safeguard that pins every outbound connection to the address it just checked was built by one copy of a networking library and handed to a different one. They agree today, so nothing is broken — but the next routine dependency update would have made them disagree and **stopped every outbound request**: no posts delivered, no profiles fetched, no crossposting. Neither the type checker nor the build could see it, and it would only have surfaced as a wall of failing tests. Both halves now come from the same place.
- **The sidebar's Recent list no longer says "Untitled" over and over** (#307) — a short note doesn't have a title, and it isn't supposed to, so anyone posting mostly notes got a sidebar reading Untitled five times. It now shows the first line of the post instead, in italics so it's still obvious which entries have real titles. A post with no title *and* no text — a photo on its own — shows just its date, which at least tells you something. Same wording your apps already use for the same posts. Only affects the optional sidebar layout.
- **The support bundle now includes recent log lines** (#490) — the bundle told you what your instance *is*; the logs are what tell you what went *wrong*, and on a hosted platform or in a container they're often the one thing you can't get at. The last 200 lines are now included, with the credentials you've saved in the admin panel replaced by `[redacted]` — checked against the real saved values, not just against environment variables, which on a normal install aren't where your passwords live. The check happens as each line is recorded, so a password never sits in memory waiting to be scrubbed, and again over the finished bundle before you see it. If that check can't run, you get an error instead of a bundle. Log lines can still contain anything your instance logged, so the bundle says so at the top: read it before you paste it anywhere.

### Security
- **Rate limits can no longer be sidestepped by setting a header** (#515) — if your site runs behind a reverse proxy or Cloudflare and you'd switched on `TRUSTED_PROXY`, FediHome worked out who a visitor was by trying three forwarded headers in a fixed order and taking the first one it found. Only one of those is genuinely set by your proxy; the other two a visitor can simply send. So on most setups anyone could hand over a different value on every request, land in a fresh bucket each time, and walk straight past the limits on admin login, comments, kudos, search and sign-in — the limits looked like they were working and weren't. **You now name the one header to trust**, with `TRUSTED_PROXY_HEADER`, because only you know what sits in front of your site. Leave it unset and FediHome assumes `x-real-ip`, which is what the nginx config in our deployment guide sets — **if you're behind Cloudflare, set it to `cf-connecting-ip`**, and the docs now have a table for every common setup. Anything not named is ignored outright, and if your site is sending a header other than the one assumed, that's written to your log once so it turns up in your support bundle. This mattered beyond rate limiting: the same value is stored against guest comments, and it caps the requests FediHome makes to other sites while signing an app in — before anyone has proved who they are.
- **Cleared two new advisories — `npm audit` is back to zero** (#518, #519) — `brace-expansion` (GHSA-rgw5-rvv9-x895) and `fast-uri` (GHSA-7p8r-x3mc-p8w7), both rated high, are pinned to patched versions tree-wide via `overrides`. Neither is reachable from a running site: `brace-expansion` arrives only through the ESLint toolchain and `fast-uri` only through the Prisma CLI, so both are build-time. This is hygiene rather than an emergency, and it keeps a self-hosted install's audit clean. The `brace-expansion` pin had also gone stale — it was fixed at a version the new advisory covers, so an override that looked current no longer protected anything.

### Schema
- `FediPost.discoveredVia` — records that a post reached you through Explore rather than your own feed, so it can never appear on your timeline or your public page (#386). Applied automatically on upgrade; every existing post is left as feed content, so nothing you already had changes.

## 1.26.0 (2026-08-04)

### Added
- **Let a third-party app sign in, if you say so** (#366) — only FediHome's own apps could use the sign-in flow, so anything else needed a token pasted in by hand. You can now register an app in **Admin → Connected apps** with its ID and redirect address. FediHome can't verify who owns that address — **you registering it is the check** — so the panel says so plainly and asks you to confirm the redirect matches what the app documents. Removing a registration cuts the app off immediately.
- **Download everything you've written, from the admin panel** (#365) — posts, photos, videos, audio, your own Fediverse posts and approved comments, with the original text and all the metadata, as one file. No shell access, no database tools. It streams as it's built, so a large site won't run your server out of memory, and a partial download is still readable up to the last complete line. Your uploaded files aren't included — they're already on your disk — but every reference to them is, so an archive can be reassembled.
- **A support bundle you can copy without touching a terminal** (#395) — **Admin → Site settings → Support bundle** gives you a plain-text summary of your instance: version, how it was installed, whether the background scheduler is running, disk space, which integrations are set up, and how many posts, followers and failed deliveries you have. Paste it into a bug report instead of trying to describe your setup. It contains **no passwords, tokens or keys** — environment variables are listed by name with whether they're set, never by value — and nothing is sent anywhere; you get the text and decide what to do with it.
- **The About page is yours to write** (#439) — it was fixed text with one editable paragraph, and it told your visitors what *this* site is built with whether or not that was true of yours. Now there's a **heading and a Markdown body** in **Admin → Site settings**: headings, links, lists, `---` for a divider. Leave it blank and you get the built-in text, which still includes your bio and follows your Fediverse address if you ever change it. Your contact details are added underneath automatically, so you don't need to repeat them.
- **Set how much disk other people's media may use** (#364) — FediHome copies images and video from posts in your feed onto your own disk, so they load fast and your visitors' addresses aren't handed to other servers. That was fixed at 2GB with no way to change it, on the same disk as your own uploads. It's now a setting in **Admin → Site settings → Storage**, still 2GB unless you change it, and **0 turns the copying off entirely** if you'd rather media loaded from the original server. Your own uploads are never touched by it.
- **Choose how long an app token lasts when you generate it** (#327) — 7 days, 30, 90, a year, or never, on the **Admin → Connected apps** screen, and the one-time reveal now tells you the expiry date. Short-lived is the safer choice for anything you paste once, like App Store review or a one-off script. **This also fixes a real gap:** the "app token lifetime" setting in Instance settings only ever applied to tokens issued by signing in from an app — tokens you generated by hand ignored it completely and never expired. They now follow it unless you pick something else. Nothing changes if you've never set that lifetime, since it ships as "never".

### Changed
- **Releases now record who cut them and when** (#517) — a release tag used to be a bare pointer holding no information at all, so nothing said when a release was made, and the tag could be quietly moved to a different commit afterwards leaving no trace. From this release on it carries that detail. Nothing changes for you when updating. (Cryptographic *signing* is a further step and isn't done yet.)
- **Your own timeline follows the feed layout setting too** (#269) — the cards-or-list choice already applied to your public feeds; your private timeline was the one place still ignoring it. Picking **list** gives you a tighter row with the images and link previews left out, so you can see more at once. Liking, boosting and replying still work exactly as before — density shouldn't cost you the ability to act on a post. Open a thread and you still see everything.

### Fixed
- **The media cache limit now actually saves** (#495) — you could change **Cache for other people's media** in **Admin → Site settings → Storage**, press save, get the green confirmation, and reload to find your old number back. Nothing was ever written. It matters most for the people who set it to **0**, which is how you say "don't copy other people's images onto my disk at all" — they were told it saved, and copying carried on exactly as before. **Use defaults** was leaving that setting behind too. Only this one setting was affected; everything else on that screen saved correctly.
- **A third-party app that tries to sign in now gets told what's actually wrong** (#486) — every page advertises the endpoints an IndieAuth app needs, so apps like Quill and Micropublish find them, follow the standard exactly, and were turned away with "Unknown application". That reads as your site being broken, and nothing in your logs or panel explained it. The message now says plainly that this instance only accepts its own apps, and points at generating a token by hand in **Admin → Connected apps**, which does work today.
- **Clearing space no longer breaks the pictures in old posts** (#478) — when the cache of other people's media went over budget, FediHome deleted the oldest files and left every post using them showing a broken image, forever. It deleted by age, so it hit posts far enough back that nobody would notice until much later — and lowering the cache limit triggered it immediately, which is the moment you'd least connect the two. Those posts now go back to loading the picture from the server it came from. Posts saved before this update can't be repaired, because the original address was never kept; from now on they can.
- **Moving your uploads folder no longer strands the old media cache** (#479) — after you changed the folder, cached copies of other people's images stayed in the old place: still shown, never cleaned up, and not counted in the disk figure the panel showed you. So the number you were looking at was smaller than what was actually on your disk — worst of all if you moved the folder *because* you were running out of space. Both the cleanup and the disk figure now look everywhere media can be.
- **Your contact email now actually appears on your site** (#480) — you could set it in **Admin → Site settings**, press save, and nothing changed: the footer and the About page were both still reading the value from your `.env.local` file. Only two optional layouts had it right, and neither is the default — so on a normal install the setting did nothing a visitor could see, and if you'd never touched `.env.local` you got no contact link at all.
- **Horizontal rules no longer vanish from your posts** (#481) — writing `---` in an article silently dropped the divider. It looked like a styling choice rather than something being deleted, which is why it lasted; imported posts lost theirs too.

### Security
- **The maintenance scripts now refuse to be pointed at your own network.** The repair and backfill scripts in `scripts/` fetch addresses chosen by other servers — an account link out of a lookup, a post list out of a profile — and were doing it without the checks the app itself applies. Someone would have had to get a hostile address into your follow list and then wait for you to run one of those scripts by hand, so this is far narrower than the equivalent in the app, but it was the same gap. The check that keeps the app from being redirected into your private network now covers them too, and the test that enforces it no longer stops at the app's own folder. Found by internal review, with no evidence of use.

### Schema
- `OAuthClientRegistration` — third-party OAuth apps you've registered (#366). Applied automatically on upgrade.
- `FediPost.mediaRemoteUrls` — the original address of each cached image, so the cache cleanup can put a post back to loading from source instead of breaking it (#478). Applied automatically on upgrade.

## 1.25.0 (2026-08-03)

### Added
- **Point FediHome at your own AT Protocol server** (#449) — the Bluesky host was fixed at `bsky.social`. If you've moved your account to a PDS you run yourself you keep your handle, posts and followers, but the server address changes — and FediHome couldn't sign in at all. Set `BLUESKY_SERVICE` in your `.env.local` to your own server's address and it will. **This release is the environment variable only** — there's no box for it in the admin panel yet, which is tracked in #504. Leave it unset and nothing changes.
- **Tell FediHome how *your* deployment applies an update** (#438) — it works out whether you're on a git checkout, a container or a release archive and gives you the right command. If a platform or orchestrator rolls your image instead — Kubernetes, Nomad, Swarm, Fly, Render, any PaaS — none of those fit, and no amount of detection can guess your pipeline. Set `FEDIHOME_UPDATE_URL` to point the update alert at your own deploy pipeline or runbook, and `FEDIHOME_UPDATE_TEXT` to replace the instruction. Dependency and security alerts still link to npm and the advisory, since those are the evidence rather than the action.
- **Your own domain can now be your Bluesky handle** (#448) — `@yourdomain.com` instead of `@yourname.bsky.social`. Normally that means adding a DNS record; FediHome already serves your domain, so it hands Bluesky the proof itself and you never touch DNS. Turn it on in **Admin → Integrations** — it starts serving straight away — then change your handle in the Bluesky app and press **Check with Bluesky** to confirm. Nothing is lost in the change — your followers, follows and posts belong to your account rather than its name, and Bluesky reserves your old handle. This doesn't move your account off Bluesky; it relabels it.

### Changed
- **The owner nav link is now called "Admin", not "Fedi Feed"** (#367) — it opens a page with seven tabs, of which the Fediverse feed is one; the rest are messages, comment moderation, your blocklist, followers, following and analytics. It's also the only door into site settings, integrations, connected apps and sessions, so calling it a feed was the main reason the owner area was hard to find. Same page, same address — just an honest name.
- Dependency refresh: `@atproto/api` 0.20.36, `@types/pg` 8.20.2. (`typescript` remains held at 6.x — see #234; `typescript-eslint` remains held at 8.61.1 by `eslint-config-next`.)

### Fixed
- **Your instance no longer answers for usernames it doesn't have** (#429) — a Fediverse request to `/users/anything-at-all` returned your profile, so anyone crawling for accounts got a valid-looking answer for every guess. The same address correctly showed "not found" in a browser, which is how the mismatch went unnoticed. It now checks the name, and sub-paths like `/users/you/followers` no longer return the wrong document.
- **Installing FediHome from source without a lockfile no longer fails** (#451) — `npm install` died with `Unable to resolve reference $postcss` before installing anything. It only affected fresh installs that regenerate the dependency list, which is why normal installs and upgrades were unaffected — but that's exactly the path a dependency update takes, so it had quietly blocked routine maintenance.
- **Blocking now holds when you scroll, not just on the first screen** (#459) — a blocked account was hidden when a page first loaded and came back the moment anything fetched more: loading older posts, flipping a filter, or the timeline's own background refresh. Apps were affected throughout, since they only ever use that path. Thread views had the same gap on one side — a blocked reply was hidden on a Bluesky thread and shown on a Fediverse one.
- **Opening a thread no longer publishes strangers' posts on your public page** (#460) — expanding one conversation out of curiosity saved every post in it, and a thread's *first* post looks exactly like a post from someone you follow. So it appeared on your public Fediverse page, under your domain, and stayed there. Viewing someone's profile did the same with up to ten of their posts at once. FediHome now records whether a post arrived in your feed or was fetched because you looked at something, and shows only the former. Threads still show everything, as they should. **After upgrading, posts that came in this way disappear from your feeds** — including some from people you used to follow, since nothing distinguishes them now; anyone you currently follow is unaffected.
- **Docker: the panel now warns before you point uploads somewhere that gets wiped** (#387) — you could set the uploads directory to a path inside the container, and it saved without complaint. Uploads kept working, older photos kept displaying, and then a rebuild deleted everything added since. The delay was the worst part: no error, no symptom, and by the time anything looked wrong the change that caused it was days old and didn't look related. FediHome now checks the directory is on a mounted volume — or a `tmpfs`, which looks mounted but lives in memory — and asks you to confirm. It asks rather than refuses: you may have a reason, and only you know your setup. Outside Docker nothing changes.
- **A wrong site address is now recoverable even after you've published** (#447) — the panel refuses to change it once anything is out there, for a good reason: the address is written inside every post you've sent, so changing it orphans them. But that left anyone who set it wrong early with no way out at all. There's now `scripts/set-identity.ts`, which tells you exactly what you'd be orphaning — how many posts, followers and follows — and refuses unless you confirm. It writes to the database rather than a file, so it works on hosts where `.env.local` is wiped on every deploy. And if every change in the panel is being refused as "forbidden", the logs now say plainly that the site address is wrong, naming both the address you're browsing and the one that's configured.
- **An update check that fails now says so** (#437) — if the background check died, nothing reported it: its output was discarded and its exit code ignored, so a check that crashed looked exactly like one that ran and found nothing. Your update and security alerts would quietly go stale. It now logs the failure and how to run it by hand, and the check's own output reaches your logs.
- **The update checker can no longer tell you to downgrade** (#465) — it flagged a package whenever the available version merely *differed* from yours, so on the occasions the registry reported an older version it raised an update alert pointing backwards, helpfully labelled "(major)". It now checks the version is actually newer.
- **A bad site address in the database can no longer become your identity** (#431) — the admin panel validated the address you typed, but a row written any other way — a hand edit, a restore, a script — went straight through unchecked. A value of `not a url` produced an actor address of `not a url/ap/actor`, which the instance then published under. The same rules now apply wherever the value comes from, and an invalid one falls back to your environment setting instead. The panel is also honest that it can't verify you own the domain, and says what happens if it's wrong.
- **The app API docs said you couldn't like a Bluesky post** (#432) — the table for like/boost listed only `postApId`, which Bluesky posts don't have, while the text just above it and the code both accept `postId` for either network. Corrected, and `targetInbox` is now marked optional, which it always was.

### Security
- **Closed a timing gap where a hostile server could still reach your local network.** FediHome checks that a remote address is public before fetching from it, but the connection then looked the address up a second time — and whoever controls that domain's DNS can answer the two lookups differently, sending the connection somewhere the check never saw. The check and the connection now use the same lookup, so there is nothing in between to change. Found by internal review, with no evidence of use.

## 1.24.1 (2026-08-01)

### Changed
- Dependency refresh: `@atproto/api` 0.20.35, `@types/react` 19.2.18, `@types/react-dom` 19.2.4. (`typescript` remains held at 6.x — see #234.)

### Fixed
- **A wrong site URL no longer locks you out of your own admin panel** (#426) — if you set your site URL to an address you don't actually serve, every admin action started refusing you, *including the page that would let you change it back*. The only way out was editing the database or `.env.local` by hand. The security check behind that now also accepts the address you're genuinely browsing from, so you can always fix a typo from the panel itself. Note this only helps before you've published anything — after that, changing your address is refused for a different and deliberate reason.
- **A capital letter in your domain no longer makes you invisible** (#427) — if you'd written your domain with any capitals in `.env.local`, nobody could find or follow you. Other servers always ask in lowercase, FediHome compared the two exactly, and every lookup came back "not found" — while your site looked perfectly healthy from the inside. Domains are now normalised wherever they're set, including in your site URL, which is the one that gets stamped into every post you publish and can't be corrected afterwards.
- **The setup wizard now has the same cross-site protection as everything else** (#430) — it was the one place that could be submitted from another site. Not something an attacker could have used on a working instance, since setup refuses to run twice, but it was the odd one out.
- **Changing your address is now blocked if you follow anyone** (#428) — FediHome already refused to let you change your domain once you'd published something or gained a follower, because it would silently break them. It wasn't counting the people *you* follow, whose servers deliver to your current address — so that change could still quietly cut you off from everyone in your timeline, with nothing on either side to explain why.

### Security
- **Closed the last way another server could point your instance at your own network.** The check that stops FediHome connecting to private addresses understood most of the ways an IPv4 address can be hidden inside an IPv6 one — but not all of them, so a handful of spellings still slipped through. It now covers the remaining transition formats, plus several address ranges that are reserved or local by definition and are never a legitimate place to fetch from. Completes the fix released in 1.24.0; found by internal review, with no evidence of use.

## 1.24.0 (2026-07-31)

### Added
- **You're now offered a real password instead of typing a 64-character key forever** (#411) — if you sign in with your `ADMIN_SECRET`, FediHome now says so and offers to set a proper password, rather than leaving you to discover the option buried in Site settings. It's an offer, not a wall: "Not now" gets you straight in, and your saved Bluesky, Threads and notification credentials are unaffected either way.
- **FediHome now tells you when there's an update — without you having to ask** (#399) — the update check has always existed, and nothing ever ran it. So the notification bell was wired to a source that only produced anything if you happened to run `npm run check-updates` by hand, which nothing tells you to do: an instance simply never heard about a new release or a security advisory. It now runs daily on its own, and **Admin → Instance settings** has a **Check now** button plus a toggle if you'd rather your instance didn't call out to the npm registry and GitHub. It remembers when it last ran, so restarting doesn't re-run it and a box that restarts every night doesn't skip it forever.

### Changed
- Dependency refresh: `@fedify/fedify` and `@fedify/next` 2.3.4, `postcss` 8.5.25. (`typescript` remains held at 6.x — see #234.)

### Fixed
- **Update instructions that actually work on your install** (#398) — the "FediHome update available" alert told everyone to run `npm run update`. In Docker that command **refuses**, because the image deliberately has no git history — so the advice looked like the update was broken when it was only the instructions. It now tells you what applies to your install: the updater for a git checkout, `docker compose pull && docker compose up -d` **on the host** for a container, and the manual steps for a release-archive install. `npm run update` inside a container now explains this instead of saying the folder doesn't look like FediHome. The README and deployment docs say the same thing.
- **The notification bell no longer nags you about things you already fixed** (#412) — every maintenance alert FediHome raised stayed there for good. Upgrade a package and it kept telling you to upgrade it; let a few upstream releases go by and you collected a separate permanent alert for each one. The worst case was security: once an advisory was fixed and `npm audit` came back clean, nothing noticed, so the bell went on reporting a vulnerability that no longer existed — and that's the alert you're most likely to act on. Docker users had it worst, with one permanent "update available" per release even while running the newest one. Alerts now clear themselves when the thing behind them goes away, and dismissing one still means dismissed. Anything that comes back is marked as a repeat (`×2`) rather than looking brand new, because a credential that breaks twice is telling you something different from one that broke once.

### Security
- **App tokens are now checked properly when posting from a blog client.** The XML-RPC endpoint that MarsEdit, micro.blog and similar apps use was checking only that a token existed — not what it was allowed to do, and not whether it had expired. So a token you had deliberately limited to read-only could still publish and delete posts, and a token past its expiry date kept working. Both are now enforced the same way they already were everywhere else. Tokens you have not restricted keep working exactly as before. Blog-client activity also shows up in **Admin → Apps** now, where it previously always read "never used" — so a token you rely on no longer looks abandoned, and one being used without your knowledge is visible. Also stops that endpoint returning the contents of an unpublished draft.
- **Another server could point your instance at things on your own network** (#433) — before connecting to a remote address, FediHome checks it's a real public one. That check had two holes. It could be walked straight past using an unusual but perfectly valid way of writing a local address, so no trickery was needed at all. And where it did work, it only checked the *first* address: a server could answer "it moved over there" and send the request somewhere private instead — a database on the same machine, or the metadata service your hosting provider runs. Both are fixed, every redirect is now re-checked, and sending a post refuses to follow a redirect to a different server at all, since nothing legitimate needs that. As far as we can tell nothing could be read back out this way, and there's no evidence of it being used. Found during an internal audit.

### Schema
- `MaintenanceItem` gains `resolvedAt` and `occurrences` (#412). Added automatically on upgrade; nothing to do.

## 1.23.1 (2026-07-30)

### Fixed
- **Bluesky posts stayed hidden in the web timeline** — v1.23.0 announced them, and they only appeared on the first paint of the page, disappearing again as soon as anything reloaded the feed. Holding them back from the macOS app (so its feed didn't go blank) accidentally held them back from the website too. The web timeline shows them again, and the app still doesn't get them until it's ready for them.

## 1.23.0 (2026-07-30)

### Added
- **Posts from the people you follow on Bluesky now show up** (#393) — following someone on Bluesky imported their name and their avatar and then nothing else: their posts never arrived, because nothing had ever asked for them. FediHome now pulls your Bluesky Following feed on the same schedule as the rest of the Bluesky sync, and those posts sit in your timeline alongside federated ones. Replies and reposts land as replies and boosts, so the toggles you already have work on them. Images are cached locally rather than hot-linked, blocked accounts are skipped — including when someone you follow reposts them — and your own posts are left out so they don't appear twice. **Liking, boosting and replying work too** — a like from your timeline is a real Bluesky like, and shows up in the Bluesky app straight away. If you already liked something over there, the heart is already lit here.

### Changed
- Dependency refresh: `postcss` 8.5.24.

### Fixed
- **A brand-new Docker install no longer looks like it failed** (#410) — the hand-written database migrations ran before the tables they change existed, so a first boot printed twenty warnings and then applied them only on the *next* restart, which nothing told you to perform. They now run either side of the schema sync, so a fresh install is fully set up in one boot and says "waiting for the schema" instead of "could not be applied". `install.sh` applies them too, so your first `npm run update` isn't the run that does nineteen at once.
- **The macOS app keeps working while it catches up** — importing Bluesky posts changed the shape of a post (they have no ActivityPub id), and an app that expects one gets an empty feed rather than a partial one. Bluesky posts are therefore left out of the app's feed until the app asks for them, so nothing breaks for anyone running the current version.
- **A queued post could still reach someone you'd just blocked** (#397) — when a follower's server is down, the post waits in a retry queue. Those queued items recorded only where they were going, not who they were for, so on retry FediHome could tell whether you'd blocked the whole *server* but not whether you'd blocked the *person*. Blocking normally clears the queue immediately; if that clean-up failed at the wrong moment, the post kept being re-sent to them for the next day and a half. The queue now remembers the recipient, so the retry makes the same decision the first attempt would have.
- **Opening a thread could bring back someone you'd blocked** (#396) — blocking removes that person's posts from your instance, but viewing a conversation they'd replied in fetched the whole thread from the other server and wrote their posts straight back. If the post it re-imported was the start of the thread, it reappeared in your main feed and stayed there. Your instance was also making signed requests to servers you'd blocked in order to do it. Both are now checked before anything is fetched or stored, and blocked accounts are additionally filtered out of the feed on the way to the screen — so a block holds even if some future path forgets to ask.

## 1.22.0 (2026-07-29)

### Added
- **See how full your disk is before it bites** (#385) — nothing told you the uploads volume was filling until a post failed to save, which matters more now that media can live on a separate disk. **Admin → Site settings → Storage** shows free space, and splits your own photos and audio from the cache of other people's media — so you know whether the answer is a bigger disk or just a smaller cache. `/api/health` reports a plain `ok` / `low` / `critical`, enough for an uptime monitor to warn you, without publishing your disk size to anyone who asks. A full disk is reported but never marks the instance unhealthy, because restarting doesn't free space. Also fixes the cache trim itself: it only ever ran after a **video** was cached, so an instance that mostly saw images never trimmed at all and its 2GB budget was fiction.

### Changed
- Dependency refresh: `prisma`, `@prisma/client` and `@prisma/adapter-pg` 7.9.1, `@types/node` 26.1.2. (`typescript` remains held at 6.x — see #234.)

### Fixed
- **A scheduled post could be marked as sent when it never was** (#384) — FediHome ships a few hand-written database updates that run before the app starts. One of them was meant to tidy up posts from before delivery tracking existed, but the condition it matched wasn't "old posts" at all — it was "any scheduled post that is being sent right now". On a container, that ran on **every restart**. So if your instance restarted in the seconds while a scheduled post was going out, that post was recorded as delivered, and the safety net that would have re-sent it was told there was nothing to do. Silently, with nothing in the interface to show it. Fixed, and posts that were affected are repaired on upgrade: they'll be sent shortly after your instance restarts. If a post was already crossposted to Bluesky or Threads, it won't be sent there twice. Two further changes make this class of mistake much harder: these files are now recorded once they've run, instead of being replayed forever, and a test refuses any future one that changes data without saying why it's safe to repeat.

## 1.21.0 (2026-07-28)

### Added
- **Set your Fediverse address from the admin panel, while your site is still new** (#326) — your address used to be fixed at install and changeable only by editing a file on the server. It's now in **Admin → Site settings → Identity** for as long as it's genuinely safe to change: the moment you publish anything, or anyone follows you, FediHome refuses. That isn't caution — every post stores its own full address inside it, and every server that has seen you keeps the first one it saw, so a later change would orphan your posts rather than move them.
- **Change your journal email settings without touching the server** (#326) — the SMTP host, username and password behind DayOne journalling were the last credentials readable only from a file. They move into the admin panel, encrypted at rest like your Bluesky and Threads credentials, and you're told if they ever stop being readable. Existing setups keep working exactly as they are.
- **Put your media on a different disk** (#363) — uploads were hardcoded to `public/uploads` inside the install, so moving them to a bigger volume meant a symlink, and a folder of your own photos and audio sat inside the source checkout where a clean re-clone could lose it. **Admin → Site settings → Storage** now takes any absolute path; FediHome checks it exists and that it can actually write there before saving, and tells you which of the two failed. Changing it never moves a file: new uploads go to the new place and everything already on disk keeps being served from the old one, so you can relocate at your own pace or not at all.
- **You can see which follows haven't gone through yet** (#348) — following someone wrote the row and called it done, so an account that approves followers by hand, or one whose server flatly refused you, looked exactly like a real follow: their posts never arrived and nothing said why. FediHome now listens for the answer. Unconfirmed follows are marked **pending** in your Following list, and if someone declines you're told, with the follow removed. Existing follows are unaffected — they're treated as accepted, which they are.

### Fixed
- **Blocking someone now stops us talking to them, too** (#379) — a block only ever worked one way: it silenced what they sent you, but every outbound path still reached out. You could send a direct message to someone you'd blocked, and with a whole server blocked you could still follow anyone there by typing their handle — which quietly fetched their profile and imported ten of their posts. Likes, boosts, replies and mentions all went out unchecked, and anything already queued kept retrying to a blocked inbox for the next day and a half. All of it now stops before any contact is made, which is the point: FediHome deliberately never tells anyone they've been blocked, and that promise only holds if we also stop initiating. **This also closes a bypass that affected blocking in both directions** — a server running on a non-standard port was never actually covered by a domain block.


## 1.20.0 (2026-07-26)

### Added
- **You can finally set a real admin password** (#356, #359) — until now the thing you typed to sign in was also the key that encrypted every credential you'd saved, which meant you could never change it: doing so silently destroyed your Bluesky password, Threads token, analytics key and push keys. Those are now separate. Set a password in **Admin → Site settings → Security** and change it as often as you like — your saved connections are unaffected, and other signed-in devices get signed out. Existing installs keep working untouched: sign in with your `ADMIN_SECRET` exactly as before, and you'll be prompted to pick a real one. Scripted and hosted installs can set `ADMIN_PASSWORD` instead, which is used once on first boot — no more reading a 64-character key out of a file just to log in.
- **The health check can tell you which build is running, and whether the scheduler is alive** (#358, #360, #361) — `/api/health` now reports the exact commit, how long the instance has been up, and when the background scheduler last ran. That last one matters: the scheduler runs inside the web app, so it can stop publishing scheduled posts while the site keeps answering normally — previously nothing would have told you. Docker containers now have a proper health check wired to it, so an orchestrator can restart a wedged instance, and they no longer run as root. Update notifications also work on container and tarball installs now, where they previously did nothing at all and said nothing about it.
- **Documented what actually happens when you change your domain** (#326) — `docs/fediverse-setup.md` gains a **Changing Your Domain** section. ActivityPub has no rename: your identity is a URL, and every server that has seen you stores it. The network's answer is an alias on the new account plus a `Move` from the old one — which only works while **the old domain is still serving**, because remote servers verify the move by fetching both ends. Move first and lose the domain later and your followers can still be brought across; lose the domain first and they can't, by anyone, ever. FediHome doesn't implement that handshake yet, so for now the guidance is to treat your domain as permanent, and the recommended shape of a move (new instance alongside the old, then decommission slowly) is written down.
- **You keep following people when they change servers** (#339) — when someone you follow moves to a different server, their old server announces it. FediHome used to ignore that entirely: your follow stayed pointed at the abandoned account, their posts quietly stopped arriving, and nothing told you why. Now the move is checked and your follow is carried over automatically, with a notification saying who moved where. The check matters — FediHome confirms the *new* account genuinely claims the old one before moving anything, so nobody can redirect your follow to an account they happen to control.
- **Move to FediHome from another account, and bring your followers** (#326) — a new **Moving here from another account** section in **Admin → Site settings** lets you list your old profile address. That's the piece the other server checks before it will hand your followers over: it fetches your FediHome profile, confirms your old account is listed, and only then moves everyone across. Add it here first, then start the move from the old account. (Keep the old account online while it happens — the check fetches both ends, so once it's gone nobody can move those followers.) Leaving FediHome for somewhere else is the other half, and isn't built yet.
- **Click anyone, and act on them** — when someone replied from Mastodon there was no way to reach them: their name was plain text, with no profile link, no follow, no block. Names and avatars are now clickable wherever a person appears — replies on a post, the people who liked or boosted it, and everyone in a thread — opening a small card with a link to their profile and, when you're signed in, **Follow / Unfollow / Block**. It offers the action that actually applies (it checks whether you already follow them rather than showing both), and it works with the person's real address, so it's correct for people on any server, not just Mastodon.
- **See and undo your blocks, and block whole servers** — the web app could create a block but never show one, so blocking from a browser was a one-way door: no list, no way to reverse it. **Timeline → Moderation** now lists everyone you've blocked with an unblock button. It also adds **server blocks**, for when one instance keeps producing new accounts — blocking a server refuses everything from it *including subdomains*, deletes what it has already sent, and drops follows in both directions. Both kinds stay private: nothing is sent to the person or server, so they're never told. You can't block your own domain.

### Changed
- **Plain-language marketing on the showcase landing and Mac pages** — the `LANDING_MODE` homepage and the `/download` page led with terms most people don't know ("speaks ActivityPub", "the Fediverse", "IndieWeb", "federated with Mastodon"). They now lead with what FediHome actually *is* — a personal site for short posts, articles, photos, video and audio that people can follow from anywhere, explained with a plain "it works like email" framing — while the technical standards (ActivityPub, WebFinger, RSS, and the fediverse) move into a dedicated **Open by design** section that doubles as the no-lock-in pitch and keeps the search terms technical folks look for. The "written by AI" section is gone. New default landing headline and subhead ship with it (still overridable via `LANDING_HEADLINE` / `LANDING_SUBHEAD` or the admin panel).
- **The FediHome macOS app is on the Mac App Store** — it's out of review and live, so the download surface now links straight to the [App Store listing](https://apps.apple.com/app/fedihome/id6790605091) instead of showing "coming soon". The link is region-neutral, so Apple sends each visitor to their own storefront, and it's the default now (alongside the existing direct GitHub download) for any instance that turns the download page on — no configuration needed. Still overridable via env or the admin panel.
- Dependency refresh: `next` and `eslint-config-next` 16.2.12. (`typescript` remains held at 6.x — see #234.)
- **Setting up on an address the Fediverse can't reach is now a deliberate choice** (#326) — the wizard used to let you finish on `localhost` or a private-network address with nothing but a warning. That bakes an identity nobody can follow into your ActivityPub actor, and because posts store their full URL, into everything you publish before you move. It's still allowed — testing locally is a perfectly reasonable thing to do — but you now have to tick a box confirming that's what you're doing. Setting up on a real domain is unchanged.

### Fixed
- **Containers only accepted connections on one address** — the server bound to the container's own IP rather than all interfaces, so anything inside the container (including a health check) was refused. Published ports still worked, which is why it went unnoticed.
- **You're now told when saved credentials stop working** (#359) — your Bluesky password, Threads token, analytics key and push-notification key are stored encrypted, using a key derived from `ADMIN_SECRET`. If that secret is ever lost or regenerated — which happens easily, since it lives in `.env.local` and **isn't in a database backup** — all four become permanently unreadable, and until now that was completely silent: push notifications and crossposting simply stopped, while the admin panel still showed everything as configured. FediHome now checks at startup and raises an alert naming exactly which ones need re-entering, and the backup documentation now lists `ADMIN_SECRET` as a third thing to keep safe alongside your database and uploads.
- **Docker upgrades never applied database migrations** (#355) — FediHome ships a handful of hand-written SQL files for changes Prisma won't make on its own, and they were only ever run by `update.sh` — which needs a git checkout, so **container installs skipped every one of them**. Two consequences: any future release adding a unique constraint would have left containers unable to start at all, and — already the case today — scheduled posts published before a July change were left marked as never-delivered, so they could be re-sent and crosspost to Bluesky twice. Containers now apply the same migrations on startup, and a database failure at boot says what went wrong instead of restarting in a loop with no explanation.
- **An instance can no longer start up with an address nobody can reach** (#357, #362) — if `SITE_URL` was missing or pointed at `localhost`, FediHome would quietly federate as `@me@localhost:3000`. That address goes into your Fediverse identity *and* into every post you publish, and it can't be corrected later — other servers keep the first one they saw. It now refuses to start and tells you exactly what to set (with an opt-out for local testing). The setup wizard always guarded against this; the one install path that skips the wizard was the one with no protection. Related: a headless install now also records that setup finished, which re-arms a safety check that warns you if your federation identity is ever lost.
- **Three more ways a block leaked, closed** — following on from the block fix below, an adversarial review found the guarantee still had holes. A blocked person's post could reappear in your feed when **someone you follow boosted it**; you could **follow an account you'd blocked**, which quietly re-imported their recent posts while the block was still in force; and blocking left the **like and boost counts on your posts overstated**, showing "3 likes" above two faces with no way to ever correct itself. All three now behave.
- **Blocking someone now actually blocks them** — blocking removed their posts and dropped the follow, but nothing ever checked the block list again, so a blocked account could re-follow, like and reply again seconds later and it would all show up as normal. Anything sent by a blocked account is now refused at the door. Blocks stay **private**: their server gets the same ordinary response as everyone else, so the person you blocked is never told — unlike Mastodon, which notifies them. (FediHome no longer sends a block notice at all, in either direction.)
- **Blocking or replying could target the wrong person entirely** — the timeline rebuilt someone's address by guessing at Mastodon's URL format instead of using the one it had already stored. For anyone on Mastodon or Pleroma the guess happened to be right; for Lemmy, Akkoma, PeerTube — **and other FediHome sites** — it was wrong, so a block or unfollow silently did nothing, and replies could fail to arrive. It now uses the stored address.
- **An instance could be completely undiscoverable while looking perfectly healthy** (#326) — if you set `SITE_URL` but not `FEDI_DOMAIN`, your site advertised `@you@yourdomain` on every page, served a valid profile, and federated posts — but WebFinger, the endpoint every other server uses to *find* you, answered only to `@you@localhost`. So every search from Mastodon returned "not found", nobody could follow you, and nothing in the logs said anything was wrong. Your Fediverse identity now comes from a single place, so the address your site shows and the address it answers to cannot disagree. This also means a site URL with a stray trailing slash, or a non-default port, no longer produces a subtly different identity.

### Security
- **Hardened four trailing-slash comparisons against a slow-input attack** — a regular expression used to tidy up web addresses could be made to run in quadratic time by feeding it a very long run of slashes. Two of those comparisons ran on values a remote server fully controls, including one on **every inbound federated request**, so a hostile instance could have burned CPU cheaply. Replaced with a plain character scan, which can't backtrack. Flagged by CodeQL.
- **Cleared three new advisories — `npm audit` is back to zero** (#342, #343, #344) — `brace-expansion` (memory-exhaustion crash), `find-my-way` and `valibot` (both reached only through Prisma's dev server) are pinned to patched versions tree-wide via `overrides`. None was reachable from a running site — the first arrives through ESLint, and the other two only execute under `prisma dev` — so this is hygiene rather than an emergency, and it keeps a self-hosted install's audit clean. Dependency refresh alongside it: `@atproto/api` 0.20.34, `eslint` 10.8.0, `postcss` 8.5.23.

### Schema
- New `BlockedDomain` table for server blocks. Additive — `npm run update` applies it automatically (`prisma db push`, plus the matching idempotent SQL in `prisma/manual-migrations/`).

## 1.19.0 (2026-07-23)

### Added
- **Set your avatar and banner during first-run setup** (#59) — the setup wizard now takes a profile picture and banner (optional), so a fresh install lands looking like *you* without a later trip to the admin panel. Uploads are gated by your setup token (the same one that protects setup) and go through the same optimise/EXIF-strip pipeline as everywhere else. A corrupt or mislabelled image is now a clear error instead of a 500.
- **Set session + token lifetimes from the admin** (#59) — a new **Security** section in **Admin → Site settings** sets how long an admin session stays signed in (default 30 days) and how long a generated app token lasts (0 = never expires), with no `ADMIN_SESSION_TTL_DAYS` / `APP_TOKEN_TTL_DAYS` env editing. Changes apply to newly-created sessions and tokens; the env vars still work as defaults.
- **A third theme — "Classic Blog"** (#250) — a left sidebar of your bio, recent posts and links beside a serif reading column, on a warm charcoal ground with a pine-green accent: a traditional personal-blog counterpoint to the default's glass and Editorial's sepia. Pick it in **Admin → Site settings → Appearance → Theme** (no restart) or set `THEME=classic`. Default instances render identically — nothing changes unless you choose it. A theme can now also **preset the sidebar's side and blocks** (Classic Blog ships a left sidebar with the nav kept out of it), which you can still override per-site.
- **Turn on phone notifications without touching the server** (#59) — **Admin → Site settings → Phone notifications** generates your Web Push (VAPID) keypair in one click, so PWA push works with no `npx web-push generate-vapid-keys` or `.env` editing. The private signing key is **stored AES-256-GCM-encrypted at rest** and never sent to the browser; the `VAPID_*` env vars still work as a fallback. Regenerating keys correctly **unsubscribes every device** (a subscription is bound to the old key and can't receive new sends) — and this also fixes a latent bug where, after any key change, a device would show notifications as "on" while silently receiving nothing; it now detects the mismatch and prompts you to re-enable.
- **Put the sidebar where you want it, with the blocks you want** (#307) — the sidebar layout can now sit on the **left or right**, and its blocks are an **ordered list you control**: `about, recent, sections, connect`. The order you write is the order they render, and leaving one out hides it — so dropping `sections` stops your nav appearing in both the header and the sidebar. Set both in **Admin → Site settings → Appearance** (they appear once you pick the Sidebar page width), or during first-run setup. On mobile your content always comes first regardless of which side you choose.

- **Themeable text colour** (#250) — text now resolves through a `content-*` ramp (primary → strong → muted → subtle → faint → dim → ghost) instead of fixed Tailwind greys, so a theme can move body copy and not just its background. This is the groundwork a **light theme** and the upcoming in-admin **custom palette** both need: `@theme` extends Tailwind's palette rather than replacing it, so hard-coded `text-white` / `text-gray-*` could never follow a theme — which is why every theme so far has had to be dark. **Nothing changes visually:** each token defaults to the exact neutral it replaces, and every built-in theme shares the default ramp, so the emitted CSS is unchanged. The site's header, footer, sidebar, mobile menu and notification menu are converted; the rest of the app follows in later passes, and until then themes stay dark (the contrast invariant still enforces it).

### Changed
- **Web Push is documented** (#59) — `docs/configuration.md` gains a **Phone Notifications** section. Push had no documentation anywhere: how to switch it on, the iOS home-screen requirement, that regenerating keys deliberately unsubscribes every device, and that the `VAPID_*` env vars are now only a fallback.
- **`docs/theming.md` rewritten for the current theme system** (#250) — the old guide predated themes entirely (it told you to hand-edit `globals.css` and swap avatar files on disk). It now covers what's web-editable in the admin panel, the `Theme` token contract + region×variant model, and a **developer scaffold** for adding a built-in theme (one data file + one registry line, with the dark/contrast and self-hosted-font constraints spelled out).
- Dependency refresh: `next` 16.2.11, `react`/`react-dom` 19.2.8, `postcss` 8.5.22, `marked` 18.0.7, `@atproto/api` 0.20.31, `eslint-config-next` 16.2.11. (`typescript` remains blocked upstream — #234.)

### Fixed
- **Phone notifications couldn't be switched on at all on a fresh install** (#59) — the 🔔 menu offered **Enable phone notifications** even when the server had no Web Push keypair yet, then failed on the click with a terse *"push not configured on server"* — and nothing pointed at the panel that would fix it, which sat in a different screen entirely. The menu now checks first and, when there's no keypair, offers **Set up phone notifications**: one click creates the keys *and* enables the device. If that can't work (for instance `ADMIN_SECRET` isn't set, so the private key can't be encrypted at rest) it now tells you the actual reason. iPhone users still need **Share → Add to Home Screen** first — iOS only gives push to installed apps — and the menu keeps saying so.

### Security
- **Patched a high-severity image-processing vulnerability** (#329) — `sharp` moves to 0.35.3, clearing [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) (four libvips CVEs, CVSS 7.0). This one was genuinely reachable rather than theoretical: FediHome decodes images fetched from **arbitrary remote instances** when it caches fediverse media, and `/_next/image` is a public endpoint that fetches and decodes thumbnails from the allow-listed PeerTube hosts — so bytes an attacker controls reached the vulnerable decoders. Upgrading alone would **not** have fixed it: Next.js pins its own copy of `sharp`, which would have left a second, still-vulnerable one (and a duplicate native image library) in the tree, invisible to type-checking, tests and builds alike. `sharp` is therefore pinned tree-wide via `overrides`, so exactly one patched copy is installed. Giving `postcss` the same treatment clears the last remaining transitive advisory (#12), and `npm audit` now reports **0 vulnerabilities**.

## 1.18.0 (2026-07-21)

### Fixed
- **A lost federation keypair is no longer silent** (#310) — if the `ActorKeys` row goes missing on an instance that already has history (a dropped `pgdata` volume, a content-only restore, a botched migration), FediHome used to quietly generate a replacement. That **rotates your Fediverse identity**: existing followers still hold your old public key, so posts can stop verifying on remote servers with nothing to explain why. It still generates keys — your site never breaks — but now logs a prominent warning **and** raises a dismissible alert in the admin notifications, pointing at restoring the row from backup. A genuinely new instance still bootstraps silently.
- **Backup docs no longer describe an incomplete backup** (#309) — the guidance covered `pg_dump` only, but `public/uploads/` is the one category of your data that **isn't** in the database. Since the DB stores file *paths* rather than the files, a documented restore gave you a site that looked intact with every image and audio player 404ing. Backup, restore and migration steps now cover both halves, and call out `ActorKeys` as the single most important row.
- **Docker installs no longer lose every uploaded file when the container is replaced** (#308) — the `app` service had **no volume**, so images, photos, audio and cached feed media lived only in the container's writable layer and were destroyed by any recreate: `docker compose up --build`, `--force-recreate`, a prune, or simply **a host reboot**. The database always survived, and because it stores file *paths* rather than the files, the site came back looking intact with every image and audio player 404ing. `public/uploads` is now bind-mounted to the host. The setup wizard also warns when it detects it's running in a container, since the `.env.local` it writes there isn't the one Compose reads — a mismatch that could lock you out of admin after a rebuild.
  > **Upgrading a Docker install:** run `docker compose cp app:/app/public/uploads ./public/uploads` **before** you rebuild. A bind mount shadows whatever is already at that path, so your existing files must be copied to the host first. One-time step; fresh installs need nothing.

### Security
- **Cleared two high-severity advisories** (#311, #312) — `js-yaml` (GHSA-52cp-r559-cp3m, quadratic-CPU DoS via YAML merge keys) and `brace-expansion` (GHSA-3jxr-9vmj-r5cp, exponential-time DoS). Both were stale lockfile pins rather than upstream blocks. Neither was reachable at runtime, and `js-yaml` is now dev-only — the **unused `gray-matter` dependency has been removed entirely** (it was declared in production but imported nowhere, and was the only path that pulled `js-yaml` into the runtime tree). `npm audit` is back to **0 high**.

### Added
- **Edit your profile from the web admin** (#59) — a new **Your profile** section in **Admin → Site settings** sets your **display name, tagline, bio, Fediverse summary, avatar and banner**. Until now none of these had *any* web UI: your bio is what `/about` renders, and the only way to change it was hand-editing `.env.local` on the server. Avatar and banner upload in-place (reusing the same media pipeline as compose) and each has a **Revert to default**. Only fields you actually change are saved, so a routine settings save no longer sends a pointless profile update to your followers.
- **A sidebar layout for your public pages** (#250) — a new **Sidebar** option under **Admin → Site settings → Appearance → Page width** (or during setup) puts your content beside a column of **about/bio, recent posts, sections and connect links**. It's the frame the upcoming "Classic Blog" theme is built on, and it collapses to a single column on mobile. Entirely opt-in — neither built-in theme uses it, so existing sites are unchanged.
- **Themeable page width, and a proper public/admin layout split** (#250) — public pages now render inside their own **shell** region, with **Normal** (each page's natural width — the default) and **Narrow** (a tighter reading column) selectable in **Admin → Site settings → Appearance → Page width** or during setup. Under the hood the visitor-facing pages moved into a `(public)` route group so the shell wraps *only* them and never your admin screens — **URLs are completely unchanged**. This is the structural groundwork the upcoming sidebar / "Classic Blog" layout needs. Default instances render identically (Normal adds no markup at all).
- **Themeable footer layout** (#250) — the footer joins the feed and header as a swappable **layout region**, with three variants: **Row** (today's credit/badges/links row — the default), **Minimal** (a single quiet line), and **Columns** (a sitemap footer with your sections, connect links and credit). Pick it in **Admin → Site settings → Appearance → Footer layout** or during first-run setup, or let each theme choose. Default instances are unchanged (both built-in themes use Row).
- **Themeable header layout** (#250) — the header is now a swappable **layout region** like the feed, with three variants: **Bar** (the default sticky top bar), **Centered** (a masthead — site name over a centered nav row), and **Minimal** (just your name + a menu button). Pick it per site in **Admin → Site settings → Appearance → Header layout** or during first-run setup, or let each theme choose its own. Default instances are unchanged (both built-in themes use Bar). This is the first non-feed region on the region×variant contract — the groundwork the upcoming sidebar/"Classic Blog" shell builds on.
- **Set your Tinylytics API key from the web admin** (#59) — **Admin → Site settings → Analytics** now takes the analytics **API key**, not just the site id, so the in-app **dashboard, kudos and leaderboard** work with no `.env` editing or restart. The key is **stored AES-256-GCM-encrypted at rest** (same `secret-box` used for crosspost credentials — a DB leak alone can't reveal it) and is never returned to the browser; a saved key/id takes precedence over the `TINYLYTICS_*` env vars, which still work as a fallback. Setting the key also finishes the site-id story: the dashboard now honours a **web-set** site id, not only the env var.

### Fixed
- **`npm test` ran the whole suite twice if you had a worktree inside the project** (#303) — Vitest had no `include`, so it fell back to scanning the entire repo root and collected any nested checkout's tests too (64 → 128 files). Because the nested copy is a *different commit*, the suite could fail on code you never touched. Discovery is now scoped to `src/`, with nested checkouts explicitly excluded. Contributor-facing only; no runtime change.
- **A failed first-run setup could permanently brick an install** (#59) — `/api/setup` marked setup complete **before** writing `.env.local`, so if that write failed (read-only directory, root-owned file, Docker bind-mount) or the site URL was malformed, the instance was left "set up" with **no admin secret**: every page redirected to `/setup`, which then refused with "Setup has already been completed", recoverable only by hand-editing files or SQL. Setup now **validates everything first, and rolls the claim back if the write fails**, so you can simply fix the permission and run it again. A malformed site URL is also a clear 400 instead of an opaque 500.

### Changed
- **The setup wizard asks for your public site address, and shows a review step before installing** (#59) — the wizard used to silently assume the browser's address was your canonical `SITE_URL`, which is wrong behind a proxy or tunnel, and it's baked into your Fediverse identity, feeds and links (changing it later means editing files on the server). It's now an editable field with warnings for `localhost` / private / non-HTTPS addresses, validated server-side as a clean origin. A new **Review & confirm** step lists everything — including your full `@handle@domain` and the derived federation domain — before anything is written.
- Dependency refresh: Prisma 7.9.0 (client, CLI and pg adapter in lockstep), `@fedify/fedify` + `@fedify/next` 2.3.3, `postcss` 8.5.20. (`sharp` is deliberately held at 0.34.x to match Next's optional pin — bumping it would install a duplicate libvips binary.)

## 1.17.0 (2026-07-19)

### Fixed
- **Tinylytics collected zero pageviews when only the numeric site id was set** (#288) — the on-page tracking embed needs the site's `uid` (embed code), but it was built from the numeric `TINYLYTICS_SITE_ID`, so `…/embed/3461.js` 404'd and **nothing was ever collected** — silently, while the dashboard (which correctly uses the numeric id) looked fine. Now the embed's `uid` is **derived from the API automatically** (with an API key set), so collection just works from the site id alone; Site settings → Analytics shows whether pageviews are actually being collected, and warns if not. `TINYLYTICS_EMBED_ID` still works as an explicit override. The build-time uid lookup is also hardened (longer timeout + a retry, so parallel `next build` workers don't race it) and its log no longer alarmingly claims "not being collected" during a build when runtime collection is fine.

### Added
- **`GET /api/posts` now returns each post's `contentHtml`** (#292) — the sanitized HTML body, so a native "My Posts" manager can render a post in **full and styled** (the previous `preview` was capped at ~200 chars, and `q=source` only returns markdown for the editor). Nullable, returned as-is; drafts + scheduled posts included as before. Documented in `docs/app-api.md`.
- **Turn on analytics from the web admin** (#59) — **Admin → Site settings → Analytics** sets your Tinylytics site id, so page-view collection starts with no `.env` editing or restart. (The in-app analytics dashboard still needs the API key via env — that stays server-side for now.)
- **Pick your theme during setup** (#250) — the first-run wizard's Site Features step now has an Appearance section (Theme + feed layout), so a fresh install lands on the look you chose without a config file or an admin visit.
- **Gallery categories are now web-editable** (#284) — **Admin → Site settings → Categories** sets the photo / video / audio gallery categories (comma-separated slugs) instead of the old hard-coded lists. Each medium now has one source of truth: the compose dropdowns follow it, and **/videos** and **/audio** gain the same category filter tabs **/photography** already had. Removing a category never hides existing items — each gallery's filter is the union of your list plus any category still in use. Blank fields fall back to the built-in defaults, so existing instances are unchanged. The resolved lists are also exposed to API clients on `GET /api/micropub?q=config` as `mediaCategories` (structured `{ slug, label }` per medium, the same config-plus-in-use union the galleries show), so a native app can offer the owner's real categories — including one configured but not yet used — instead of guessing from existing posts. Part of the "configure everything from the web" goal (#59).
- **Contact email + podcast feed settings are now web-editable** (#59) — **Admin → Site settings → Contact & podcast** sets your contact email and the `/audio` podcast feed's title / author / description / email / cover image (each blank field derives from your profile), with no `.env` editing or restart. This also fixes the podcast feed ignoring a web-edited author name — it now reads your live profile/settings instead of only the env vars.
- **Themes can now vary *texture*, not just colour and type** (#250) — new "feel" tokens (`--radius-card`, `--radius-button`, `--glass-filter`) let a theme set its corner rounding and glass blur. The **Editorial** theme uses this to go crisp and flat (tight corners, no backdrop blur) — a genuine print/editorial counterpoint to the default's rounded frosted glass. Default instances are byte-identical (the defaults equal the values they replaced).
- **One-paste app sign-in link** (#255) — the "Generate app token" reveal now also offers a `fedihome://connect?instance=…&token=…` link that bundles your instance URL + the token, so a native app can connect from a single copy instead of two fields. Documented in `docs/app-api.md` (proposed onboarding contract).
- **Set your accent colour from the web admin** (#276) — **Admin → Site settings → Appearance** now has an accent-colour picker, so you no longer need the macOS app (or a rebuild) to change it. It's **per theme**: each theme remembers its own accent, and "Use theme's accent" falls back to the theme's built-in colour — so choosing a custom accent no longer silently overrides a theme's identity, and (finally) you can pick any colour, including the default blue, on any theme. Saving the accent alone no longer federates a redundant ActivityPub actor `Update` to your followers. (The docs claimed this control existed since v1.0 — now it actually does.)

## 1.16.0 (2026-07-18)

### Added
- **A second theme — "Editorial"** (#250) — warm sepia surfaces, a terracotta accent, serif body copy under sans headlines, and the compact list feed: a reading-first counterpoint to the default's cool glassy Cards. Pick it in **Admin → Site settings → Appearance → Theme** (no restart), or set `THEME=editorial`. Default instances render **identically** — nothing changes unless you choose it.
- **A theme picker** in the admin panel, alongside the feed-layout control. Feed layout gained an explicit **"Inherit from theme"** option, so each theme's own preset applies unless you deliberately override it.

### Changed
- Dependency refresh: `@atproto/api` 0.20.30, `tailwindcss` + `@tailwindcss/postcss` 4.3.3.

### Fixed
- The **browser/PWA theme colour now follows your active theme** (#250) — the address-bar tint, iOS status bar and installed-app splash were hardcoded to the default theme's near-black, so they clashed the moment a different theme was selected.
- **Saving Site settings no longer silently pins your feed layout** (#250) — the first save wrote an explicit `cards` override even if you'd never touched the control, which stopped a theme's own feed preset from ever applying. Feed layout now defaults to "Inherit from theme".
- **Bluesky crossposting now works when your handle is configured as `@you.bsky.social`** (#257) — the leading `@` is stripped (and the handle trimmed + lowercased) wherever credentials are read, not just when saved from the admin panel. Previously a `BLUESKY_HANDLE=@you.bsky.social` in `.env.local` — or a handle saved before v1.14.0 — failed every crosspost, poll and DM sync with a misleading `InvalidEmail` error, **silently**, because those run as background jobs.

## 1.15.0 (2026-07-17)

### Added
- **Swappable feed layouts** — first step of themeable *layout*, not just colour (#250, Phase 3). Every feed renders through a region dispatcher with two variants: the default **`cards`** (today's glass cards, pixel-identical) and a new **`list`** — a compact, date-led index that fits more posts per screen. Applies across **all** your feeds — home, journal, articles, and the public Fediverse feed (#267) — selectable in **Admin → Site settings → Appearance** (no restart) or via the `LAYOUT_FEED` env var. This lands the region×variant contract (`resolveLayout` + a per-theme layout preset) that the upcoming header/shell/post variants and the "Classic Blog" theme build on.
- **Generate scoped app tokens in the admin panel** (#255) — **Admin → Apps → "Generate app token"** mints a bearer token with the scopes you pick + a label, and reveals the raw token **once** (only its hash is stored, as with OAuth tokens). Paste it into any client that accepts a token — headless/CI, a read-only reader, or App Store review — without ever sharing your `ADMIN_SECRET`. Long-lived + revocable from the same screen. Documented alongside the OAuth flow in `docs/app-api.md`.
- `GET /api/posts` now returns a short body `preview` for each post (#253) — so a native "My Posts" list can show a snippet for title-less microblog notes instead of "Untitled". It's the explicit excerpt, else a markup-stripped body snippet, else `""` (empty stays empty). Also documented `GET /api/posts` in `docs/app-api.md`.

### Fixed
- Plain-text previews now decode HTML entities instead of showing them literally (#267) — search results, link/OG card descriptions, notification bodies and the new Fediverse list layout no longer render `it&#39;s` / `Tom &amp; Jerry`; they read `it's` / `Tom & Jerry`.

## 1.14.0 (2026-07-16)

### Added
- Connect **Bluesky and Threads for crossposting from the admin panel** (Admin → Integrations) — no more editing `.env.local` or restarting the server. The app password / access token is stored **AES-256-GCM-encrypted at rest** (the key derives from your `ADMIN_SECRET`, which never touches the database, so a DB backup leak alone can't reveal it), verified with a live **Test** before it's saved, and never shown again. The existing `BLUESKY_*` / `THREADS_*` env vars still work as a fallback. (advances #59)
- Your instance's **accent colour now themes the whole UI** — buttons, links, card borders and badges all follow it (it could be set before but applied nowhere). Under the hood this lands the runtime theme-token contract + a theme registry (selectable via `theme.id` / the `THEME` env var) that the wider theming system builds on; default instances render identically. (#250, advances #59)

### Fixed
- Connecting Bluesky with a handle typed as `@name.bsky.social` now works (#257) — the leading `@` is stripped (and the handle trimmed + lowercased) before login, instead of failing with a misleading "InvalidEmail" error.
- Photography grid + hero-slider images now show up too — the earlier image-preview fix relied on `SITE_URL`, which isn't available in client-component bundles, so `next/image` still 400'd after hydration on those pages. Made the fix origin-independent (relativize by local media path), so it works identically on the server and after client hydration.
- Your own post/photo images show up again on your site. Uploaded media is stored with absolute URLs (so it federates + appears in RSS correctly), but `next/image` was rejecting those absolute same-origin URLs on your own pages — a broken-image icon in feed previews, post pages, and the photo grid — because the optimizer only allows relative or allow-listed hosts. On-page rendering now uses relative URLs for your own uploads (federation and RSS still emit absolute URLs, unchanged).
- Declared `sharp` as a direct dependency (#245). Three shared-core files (`api/media/route.ts`, `lib/fedi-media.ts`, `scripts/backfill-photo-dimensions.ts`) import `sharp`, but it was only resolving transitively via Next's `optionalDependencies` — so image uploads and remote federated-media processing would throw `Cannot find module 'sharp'` under a slim install (`npm ci --omit=optional`) or a future Next that drops it. Pinned to `^0.34.5` to match Next's optional pin (no duplicate install).

### Changed
- Bumped `postcss` 8.5.18 → 8.5.19 and `tsx` 4.23.0 → 4.23.1 (patch, sandbox-verified).
- Refreshed dependencies (sandbox-verified): `@fedify/fedify` + `@fedify/next` → 2.3.2, `@atproto/api` → 0.20.29, `music-metadata` → 11.14.0, `fast-xml-parser` → 5.10.1. (`sharp` held at 0.34.5 to stay aligned with Next's optional pin and avoid a duplicate native binary; `typescript` still pinned at 6.x — 7.0.2 breaks `next build`, tracked in #234.)

## 1.13.0 (2026-07-14)

### Added
- A "Download the macOS app" marketing surface (#241): an opt-in `/download` page, a homepage hero CTA, and a nav link that advertise the native FediHome macOS app. The primary download tracks the app's GitHub Releases `latest` (always the newest notarized build), with a slot for the Mac App Store badge once the listing is live. Off by default — enable it (and edit the URLs) from **Admin → Site settings** or via `DOWNLOAD_MACOS_ENABLED` / `DOWNLOAD_MACOS_RELEASE_URL` / `DOWNLOAD_MACOS_APP_STORE_URL`.
- The first-run setup wizard now collects your site's appearance and feature choices — public Fediverse feed, landing-page mode, and which navigation sections show — and writes them straight to the DB-backed site config, so a fresh install lands pre-configured with no file editing. Reuses the same validated config store the admin panel uses. (#59)
- Optional retention sweep for cached remote federated data (#240): a new scheduler job prunes stale copies of *remote* posts (re-fetchable from their origin) and reclaims their cached media, so a long-running instance's disk doesn't grow unbounded. **Off by default** — enable it, set the sweep cadence, and choose the age window (default 90 days) from `/admin/settings`, or via `SCHEDULER_RETENTION_ENABLED` / `SCHEDULER_RETENTION_INTERVAL_SEC` / `SCHEDULER_RETENTION_DAYS`. Your own posts, interactions on your posts, follows, threads you're part of, and DMs are never pruned.

### Changed
- Refreshed dependencies (all sandbox-verified): `@atproto/api` 0.20.27 → 0.20.28, `@types/node` 26.1.0 → 26.1.1, `@eslint/eslintrc` 3.3.5 → 3.3.6, `fast-xml-parser` 5.9.0 → 5.10.0, `marked` 18.0.5 → 18.0.6, `postcss` 8.5.16 → 8.5.17, `sanitize-html` 2.17.5 → 2.17.6. (`typescript` stays pinned at 6.x — 7.0.2 breaks `next build`; tracked in #234.)
- Bumped `eslint` 10.6.0 → 10.7.0 and `postcss` 8.5.17 → 8.5.18 (sandbox-verified). Note: the top-level `postcss` bump doesn't clear the `npm audit` finding — that's Next's *vendored* postcss, tracked in #12 and blocked upstream.

## 1.12.0 (2026-07-12)

### Added
- **Failed crossposts are now retried automatically instead of being lost.** When you published a post, a Bluesky/Threads crosspost that failed *transiently* (a network blip, a 5xx, an HTTP/2 `GOAWAY`) was discarded with no log line and no retry — the crosspost helpers return `{ success: false }` rather than throwing, and the compose path only handled the success case (Bluesky) or a thrown error (Threads/Day One via a bare `.catch`), so the failure fell through silently. A real incident lost a video post's Bluesky copy this way with zero evidence. Now: every crosspost failure is **logged** (matching the scheduled-publish path), and Bluesky/Threads failures are **persisted and retried by the scheduler with backoff** (2 min → 10 min → 1 h → 6 h → 24 h, then it gives up), writing the `blueskyUri`/`threadsPostId` marker on success — the same atomic-claim + prune design as the follower-delivery retry (#207). Because Bluesky/Threads (unlike ActivityPub) don't dedupe a re-sent post, a retry re-reads the post first and skips if its marker is already set or the post was deleted, so a crash between a successful crosspost and its bookkeeping can't produce a duplicate. The retry job is a fourth toggle on `/admin/settings` (`SCHEDULER_CROSSPOST_*`). Day One (a local journal export) logs failures but isn't retried. (#225)

### Changed
- Bumped `@atproto/api` 0.20.26 → 0.20.27 (sandbox-verified: tsc/tests/build green).

### Schema
- New `FailedCrosspost` table backing the crosspost retry queue (#225). Additive and non-destructive (a brand-new table). **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-08-failed-crosspost.sql` — `npm run update` does both).

## 1.11.0 (2026-07-08)

### Added
- **Edit your site's appearance & features in the admin panel — no file editing, no restart.** A new **Site settings** screen (`/admin/site`, linked from the timeline header) makes the display/feature config editable in-app: site name & description, the project landing page (on/off + headline/subhead/repo), the public Fediverse feed (on/off + title + hide-follower/following lists), which nav sections show (Journal/Articles/Photography/Videos/Audio/About), and footer links (webring/badge/funding). Saved values live in the database as overrides on the `SITE_*`/`NAV_*`/`FOOTER_*` env defaults — "Use env defaults" reverts — and apply across your site (homepage, nav, footer, `/fediverse`, RSS, PWA manifest, metadata) within a minute. Owner-cookie only. Identity/secret config (`SITE_URL`, `FEDI_HANDLE`, `ADMIN_SECRET`) stays env-set — it's baked into your federated identity — so a managed host can pre-set it while the owner configures everything else in-app. Advances #59 toward a file-editing-free setup. (#59)

### Security
- **Incoming ActivityPub activities are now bound to the actor, not just its host.** The inbox verified an HTTP signature and then only checked that the signing key's *host* matched the claimed `actor` — so any account on the same instance as someone you follow could forge activities (follows, likes, replies, edits) as that other account. Verification now binds to the key's true **owner** and requires it to exactly equal the activity's `actor`. The owner is only trusted when it's on the key's own host, so a malicious server still can't serve a key document claiming to be owned by an actor on a *different* instance. Narrow threat model (a hostile/misconfigured instance an account is shared with), but genuine federation-security hardening. Adds the first dedicated `verifyIncomingSignature` unit tests. (#209)

## 1.10.1 (2026-07-07)

### Security
- **Unpublished drafts and scheduled posts could be read by an unauthenticated caller, and editing them before publishing leaked their content to followers — both fixed.** `GET /api/micropub?q=source` returned a post's full source (title, body, tags) including **unpublished drafts and scheduled posts**, but — unlike the `POST` handler — required no authentication, so anyone who could guess a post's slug (slugs derive from the title, or the first words + a timestamp) could read draft content. It now requires a valid token, matching the `POST` handler; `q=config` (public discovery info) is unchanged. Separately, editing a draft or a not-yet-published scheduled post via a token federated a signed, public ActivityPub `Update` of its content to every follower *before* it was ever published; editing an unpublished post now updates it silently and federates nothing (the scheduler still delivers a `Create` at publish time). (GHSA-x3j3-ghcw-8r77, #224)

## 1.10.0 (2026-07-07)

### Added
- **Follower deliveries that fail are now retried instead of silently lost.** Sending a post/reply/edit/delete to your followers was fire-and-forget: if a follower's instance was briefly down, rate-limiting, or 5xx'ing at that moment, that follower simply never got it — no retry, no record. Failed deliveries are now persisted and retried by the scheduler with exponential backoff (2 min → 10 min → 1 h → 6 h → 24 h, then it gives up), each retry claimed atomically so overlapping runs can't double-send, and the re-send reuses the identical activity (stable id → remote servers dedupe if it actually landed). Terminal/old rows are pruned automatically. The retry job appears as a third toggle on `/admin/settings` (`SCHEDULER_DELIVERY_*`). (#207)
- **Edit your profile after setup — name, bio, tagline, summary, accent colour, avatar and banner.** Until now the owner's profile came only from env vars (with the avatar/banner paths hardcoded), so there was no way to change it short of editing files and restarting. A new `update_profile` admin action (`manage` scope + owner cookie) writes the changes to the database and they take effect immediately — no restart — across the **ActivityPub actor**, `GET /api/account`, **and your own site** (homepage, about page, profile page, footer, RSS), all now reading a `SiteSettings` overlay on the env defaults. An actor `Update` is federated so Mastodon and friends refresh their cached copy. Avatar/banner come from a prior `POST /api/media` upload; image paths are validated as same-origin uploads (no external URLs or path traversal). Backs the native apps' "Edit Profile" screen and moves the in-app admin panel forward. (#201, part of #59)

### Changed
- Refreshed dependencies: `@atproto/api` 0.20.25 → 0.20.26, `vitest` & `@vitest/coverage-v8` 4.1.9 → 4.1.10 (sandbox-verified).
- Bumped `tsx` 4.22.5 → 4.23.0 (dev dependency; sandbox-verified). Documented the `hashToken` invariant in `src/lib/auth.ts` (it only ever hashes high-entropy random tokens — a fast SHA-256 lookup hash, never a password) and dismissed the corresponding CodeQL `js/insufficient-password-hash` alert as a false positive.

### Fixed
- **Feed pagination no longer skips posts that share a timestamp at a page boundary.** The timeline and `/api/posts` paged on `publishedAt` alone with a strict `<`, so when the last post of one page and the first of the next had the exact same millisecond `publishedAt` (a batched/scheduled publish, a bulk import), every post at that timestamp was excluded from the next page and silently vanished from the feed. Pagination now uses a compound `(publishedAt, id)` keyset cursor with a unique tiebreak. Existing (plain-timestamp) cursors from in-flight clients still work. (#206)
- **Editing a post via a connected app no longer wipes its media, and the post id is now available to edit it.** Two gaps blocked native "edit my post": `GET /api/posts` didn't return each post's `id` (only its slug), so a client had nothing to pass to the edit endpoint; and `POST /api/compose` with `editingPostId` mapped omitted media straight to empty arrays, so a title/content-only edit **destroyed** the post's photos, videos, and audio. Now `/api/posts` items include `id`, and an edit only touches a media group when it's provided — omit `photos` to leave them untouched, or send `[]` to clear them (the same rule for videos and audio). Preserved media is also carried on the federated `Update`, so remote copies keep their attachments too. (#202)

### Schema
- `SiteSettings` gains nullable `actorSummary` / `avatarPath` / `bannerPath` columns backing post-setup profile editing (#201). Additive and non-destructive. **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-06-sitesettings-profile.sql` — `npm run update` does both).
- New `FailedDelivery` table backing the delivery retry queue (#207). Additive and non-destructive (a brand-new table). **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-06-failed-delivery.sql` — `npm run update` does both).

## 1.9.0 (2026-07-06)

### Added
- **The scheduler is now configurable from the admin UI — no restart, no env editing.** A new **Instance settings** screen (`/admin/settings`, linked from the timeline header) lets you toggle the scheduler's jobs (scheduled-post publishing, Bluesky sync) and change their cadences; the scheduler re-reads its configuration every tick, so changes apply within a minute. Saved values live in the database as overrides on top of the `SCHEDULER_*` env defaults — "Use env defaults" reverts. Cadences are clamped to 10s–24h so a typo can't wedge the scheduler. Owner-cookie only (an app token can't reconfigure your instance). First slice of the in-app admin/config panel (#59).

### Fixed
- **Edits made on other Fediverse servers now apply here.** The ActivityPub inbox had no `Update` branch, so when a followed account edited a post or reply, the stored copy silently kept the old, pre-edit text forever. Incoming `Update(Note|Article)` is now applied: content is re-sanitized exactly like first ingest (titles preserved as escaped headings), attachments are re-processed, reply copies shown in the notification bell/threads are kept in sync, and the edit time is recorded (`editedAt`, surfaced in the feed/conversation APIs so clients can show an "edited" hint). Ownership is enforced — only the stored author's own actor can update its content (the HTTP-signature check binds to the host, not the actor, so this closes a same-host rewrite hole). Updates for objects we never stored are ignored, matching Mastodon. (#205)
- **A crash mid-publish can no longer strand a scheduled post as published-but-undelivered.** Publishing a due scheduled post flips it live *before* delivering (so overlapping runs can't double-post) — but a crash/restart in that window left the post visible on the site while followers never received it, with no retry. A completed delivery attempt is now recorded (`Post.federatedAt`), and the scheduler retries a claimed-but-undelivered scheduled post once, after a 10-minute *quiet* period (anchored to the row's last activity, so a post claimed late after downtime still gets its full grace). Retries can't double-post: federation reuses the same activity id (remote servers dedupe), the Bluesky/Threads crossposts are guarded by persisted markers **re-read at post time**, publish sweeps never overlap in-process, and the retry itself is claimed atomically across instances. (#195)
- **Scheduled posts now get Bluesky reply-syncing.** The scheduler's publish path never stored the crosspost's `at://` URI (`Post.blueskyUri`), so replies to a *scheduled* post's Bluesky copy were never synced back — the shared publisher now persists it on success (as the immediate-compose path already did), plus the new `threadsPostId` marker.

### Schema
- New nullable `Post.federatedAt` + `Post.threadsPostId` columns (delivery markers for #195). Additive and non-destructive. **Upgrade with `npm run update`** (it applies `prisma/manual-migrations/2026-07-03-post-delivery-markers.sql` before `db push`), or apply that SQL by hand — **plain `prisma db push` alone is NOT sufficient for this one**: the migration also backfills `federatedAt` for scheduled posts published before the markers existed; without the backfill each of them would be re-crossposted once.
- New nullable `FediPost.editedAt` column (remote-edit timestamp, #205). Additive and non-destructive. **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-06-fedipost-edited-at.sql` — `npm run update` does both).

## 1.8.0 (2026-07-03)

### Added
- **Schedule posts to publish later.** Set a future date/time when composing and FediHome creates the post unpublished, then publishes it — federating a `Create` to your followers and cross-posting to Bluesky/Threads — automatically at that time, via the background scheduler (default check: every 60s). Works from the **web composer** (a "Schedule" date/time picker next to Publish) and from **connected apps** over Micropub (a future `published`/`mp-scheduled` datetime) and `POST /api/compose` (a `scheduledFor` ISO datetime). Scheduled posts are listable via `GET /api/posts?status=scheduled`. Publishing is claimed atomically so overlapping scheduler runs can't double-post. (#183)
- **Connected apps can create rich posts (galleries, captions, video, audio).** `POST /api/compose` — the full composer behind the web UI (photo galleries with captions, PeerTube video, uploaded audio, and opt-in Photography/Videos/Audio gallery inclusion) — now accepts a `create`-scoped bearer token, not just the admin cookie. This unblocks native-app compose beyond what Micropub can express. The web path is unchanged (cookie + CSRF); the token path skips CSRF (not ambient) and is audit-logged. (#175)
- **Remote profile lookup + handle discovery for apps.** New `GET /api/profile` (read-scoped): for an actor already in your network (`?actor=<uri>` or a known `?handle=@user@domain`) it returns a **full** profile — handle, display name, avatar, header, bio, follower/following/post counts, `followedByMe`/`followsMe`; for a **stranger** `?handle=` it returns a lightweight WebFinger-resolved card (name/avatar/handle) for "find someone to follow". Rich fetches only ever hit a **DB-sourced** actor URI (no request-URL SSRF surface); remote fetches are SSRF-guarded and the bio is sanitized. (#176, #177)
- **Blocks are now listable and reversible.** Blocking a Fediverse actor used to unfollow + purge their content but record nothing, so you couldn't see who you'd blocked or undo it. `block` now records the actor; `GET /api/graph` returns a `blocked` list (read scope); and a new `unblock` action (manage scope) removes the block and delivers an `Undo Block`. Backs a native block-list/unblock screen. (#180)
- **A "My Posts" API for connected apps.** New `GET /api/posts` (read-scoped) lists the owner's *own* content — notes, articles, journal, photo/video/audio posts, including drafts — with slug, relative URL, title, excerpt, a derived `type`, published state, interaction counts, and media counts. Filter by `?status=published|draft` and `?type=…`; paginate with `?cursor=`/`?limit=`. Backs a native content-manager view (edit/delete via the existing Micropub endpoints). (#182)
- **Micropub can set an article excerpt.** `POST /api/micropub` now reads the standard `summary` property into `Post.excerpt` (and echoes it back in `q=source`), so a token-authenticated app can give an article a short description/excerpt under its title. (#181)

### Fixed
- **The setup wizard page is no longer reachable on a configured instance.** `/setup` rendered the full first-run wizard UI for any visitor (logged in or not) even after the instance was fully configured — confusing, and a foot-gun for a signed-in owner, since an admin-authenticated wizard completion could rewrite `.env.local` (including rotating `ADMIN_SECRET`). The proxy now redirects `/setup` to the homepage whenever `ADMIN_SECRET` is configured — the same signal that already drives the fresh-install redirect the other way. The completion endpoint itself was already locked (admin auth + one-time claim), so this was UI exposure, not a takeover path; fresh installs and the no-`ADMIN_SECRET` recovery path are unchanged.
- **Likes, boosts and replies on a *boosted* post now reach the original author.** A boosted feed row has a synthetic `boost:…` apId; the interaction handlers used it verbatim as the federated activity's `object` / `inReplyTo`, which remote servers reject — so the like/boost/reply never arrived (while sending the real URL would have broken the button's persisted state). The federated `object`/`inReplyTo` now use the original post URL (via a shared `originalApId()` helper), while local persistence stays keyed on the row apId — both halves correct, no client change needed. (#174)
- **Tinylytics analytics now actually collects data.** The site read Tinylytics stats (analytics dashboard, footer hit counter, per-post view counts) but never embedded the **tracking script**, so no pageviews were ever recorded and everything showed empty. FediHome now loads the Tinylytics embed on every page when configured — keyed by your `TINYLYTICS_SITE_ID` (or `TINYLYTICS_EMBED_ID` if your embed code differs) — and the CSP is opened for `tinylytics.app` only when it's set. Note: the tracking embed needs `TINYLYTICS_SITE_ID`; the in-app dashboard additionally needs `TINYLYTICS_API_KEY`. (#170)
- **IndieAuth/OAuth discovery link tags now point at the real OAuth endpoints.** The homepage `<link rel="token_endpoint">` / `authorization_endpoint` still advertised `/api/micropub` (from before the app API shipped); they now point to `/api/oauth/token` and `/api/oauth/authorize`, plus a new `rel="indieauth-metadata"` link to the discovery document — so IndieAuth/OAuth clients that use HTML link-rel discovery reach the right endpoints. The token-revocation endpoint also sends `Cache-Control: no-store` now, matching the token endpoint.

### Changed
- Refreshed dependencies: `next` & `eslint-config-next` 16.2.9 → 16.2.10, `@atproto/api` 0.20.23 → 0.20.25, `@types/node` 26.0.1 → 26.1.0, `tsx` 4.22.4 → 4.22.5.
- **CI now guards the changelog's structure, not just its presence.** A new "CHANGELOG in sync" check enforces that released sections are immutable on `dev` (after stripping `## Unreleased`, a PR's changelog must match `main`'s byte-for-byte — catching dropped version headings, edited released entries, and entries filed under old versions), and that a PR to `main` has no lingering `## Unreleased` and a top version matching `package.json`. Releases are now prepared with `node scripts/prepare-release.mjs <major|minor|patch|X.Y.Z>` (converts `## Unreleased` → the dated version heading + bumps `package.json`/`package-lock.json` deterministically); the full release runbook lives at `docs/releasing.md`.
- Documented previously-undocumented optional env vars in `.env.example`: `TRUSTED_PROXY` (per-IP rate limiting behind a proxy), `FEDIHOME_DEBUG` (verbose AP/Micropub logging), and the `PODCAST_*` audio-feed overrides.
- Internal: extracted post federation + crosspost into a reusable `publishPost()` (`src/lib/publish-post.ts`), shared by Micropub and the scheduler — groundwork for scheduled posts (#183). No behaviour change.
- **A built-in scheduler now runs FediHome's periodic jobs inside the app** — publishing due scheduled posts (#183) and the Bluesky sync start automatically with the server (`src/instrumentation.ts`), on **every** deployment: PM2, plain `npm start`, or Docker. No second process, no hand-rolled cron. The standalone `scripts/scheduled-bluesky-sync.ts` cron script is **removed** (it was broken under `npx tsx` anyway — `@atproto`'s `multiformats/cid` export map crashes tsx's resolver); if you had it in crontab/PM2, remove that entry. Cadences/toggles are env-configurable (`SCHEDULER_*`, see `.env.example` — the scheduler also runs under `next dev`) via a `getSchedulerConfig()` indirection a future admin backend can make editable in-app. (An earlier dev-only iteration ran the scheduler as a separate `fedihome-scheduler` PM2 process via tsx, which crash-looped on the same resolver bug — if you deployed that dev state, run `pm2 delete fedihome-scheduler && pm2 save` before updating.)

### Schema
- New `BlockedActor` table backing the block list + unblock (#180). Additive and non-destructive (a brand-new table). **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-02-blocked-actor.sql`).
- New nullable `Post.scheduledFor` column (+ index) — groundwork for scheduled posts (#183). Additive and non-destructive. **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-02-scheduled-posts.sql`).

## 1.7.0 (2026-07-01)

### Added
- **Micropub clients can now delete posts.** The Micropub endpoint handles `action=delete` (form-encoded and JSON), gated on the token's `delete` scope. Deleting a published post now federates an ActivityPub `Delete` to your followers (so Mastodon etc. drop their cached copy) and cleanly removes the post's replies/comments — previously the delete was JSON-only, unscoped, silent-on-failure, and left remote copies + could fail outright on posts that had comments. The XML-RPC `deletePost` path shares the same behaviour now. (#16)
- **A `/api/health` endpoint for uptime monitoring.** Returns the app version and a live database round-trip check (`200` when healthy, `503` when the DB is unreachable) — handy for uptime monitors and post-update smoke checks. Public and read-only. Ships alongside a small structured (JSON-line) logger for new server code. (#17)
- **Log a native app into your instance without ever handing it your password.** FediHome is now a small OAuth 2.0 provider (Authorization-Code + PKCE `S256`, IndieAuth-compatible): an app discovers the endpoints at `/.well-known/oauth-authorization-server`, opens `/api/oauth/authorize` where *you* sign in on your own site and approve a consent screen listing the requested scopes, then exchanges a single-use, PKCE-bound code at `/api/oauth/token` for a scoped, revocable bearer token (revoke via `/api/oauth/revoke`). The app only ever holds a least-privilege token — never your `ADMIN_SECRET`. First-party clients only for now (FediHome for macOS/iOS/Android, custom-scheme + loopback redirects, exact-match allowlist). Groundwork for the upcoming native apps; no existing behaviour changes, and hand-issued Micropub tokens are unaffected. A full client-integration guide (the login flow, endpoints, scopes) lives at [`docs/app-api.md`](docs/app-api.md). (#158)
- **A "Connected apps" screen to see and revoke app access.** `/admin/apps` (linked from the timeline header) lists every bearer token that can reach your instance — native apps you signed in via OAuth *and* any Micropub tokens — with each one's scopes, when it was added, and when it was last used. Revoke one, or revoke all; a revoked token stops working on its next request. You can also **edit a token's scopes in place** — e.g. tighten an over-permissioned app down to `read` without re-authorizing; the change takes effect on its next request. Mirrors the existing Sessions screen. (#158)
- **A read API for connected apps.** A `read`-scoped app token can now pull your private feed, notifications, conversation threads and Fediverse post counts — the same endpoints the web timeline already uses — plus three new ones: `GET /api/graph` (followers + following across Fediverse & Bluesky), `GET /api/account` (your instance identity + counts), and `GET /api/dms` (direct messages, gated on the stricter `dm` scope so a feed-only token can't read your messages). Scope boundaries are enforced end-to-end: DM notifications in the bell are redacted for a token without `dm`, and marking notifications read (a write) needs a write-capable scope, not bare `read`. The web UI is unchanged: cookie-authenticated requests work exactly as before, and a state-changing cookie request still requires a matching origin (CSRF); only the token (Authorization-header) path skips CSRF, since it isn't an ambient credential. (#158)
- **A write API for connected apps.** With the right scope, an app token can now drive the same actions the web timeline does: `POST /api/admin` gates each of its actions on its own least-privilege scope — `interact` (like/boost/reply/follow), `dm` (read + send direct messages), `manage` (comment moderation, backfill, sync, and `block` — which is destructive, since it deletes the blocked actor's posts) — and `POST /api/media` now requires the `media` scope (which Micropub tokens already carry, so existing clients are unaffected). A token missing an action's scope gets `403 insufficient_scope`. The web UI is unchanged: cookie requests still require a matching origin (CSRF); only the token path skips it. (#158)
- **Search your own posts and photos.** A new `/search` page and a `GET /api/search` endpoint find your content by title, body text, or tag across posts and photos. Read-scoped (owner cookie OR a `read` app token, so the native app can search too), rate-limited, and strictly published-only — drafts never appear.
- **Optional expiry for app tokens.** Set `APP_TOKEN_TTL_DAYS` to auto-expire OAuth app tokens after N days (default: no expiry — long-lived + revocable, unchanged). Expired tokens are rejected on use and swept from the table automatically (piggybacked on the health check). (#158)
- **An "App activity" log.** Write actions made by connected apps (posting, likes/boosts/follows, DMs, media, scope changes) are recorded — which app, which endpoint, and when — and shown at `/admin/audit` (linked from the timeline header). Read polls aren't logged (high signal, low noise); it's coarse (method + path — no request bodies or token secrets are stored), kept for 30 days, and pruned automatically. (#158)

### Changed
- Refreshed dependencies: `@fedify/fedify` & `@fedify/next` 2.3.0 → 2.3.1, `@atproto/api` 0.20.22 → 0.20.23, `nodemailer` 9.0.1 → 9.0.3, `tailwindcss` & `@tailwindcss/postcss` 4.3.1 → 4.3.2, `postcss` 8.5.15 → 8.5.16.
- Internal: cleared the remaining 29 ESLint warnings with scoped `eslint-disable` + justifications — federated `<img>` (avatars/media from unbounded remote hosts, where `next/image` doesn't fit) and legitimate mount/prop-sync effect patterns. No behaviour change. (#83)

### Security
- **The CSRF origin check now also compares the port.** `verifyOrigin()` — which guards every state-changing admin (and now OAuth consent) POST — matched only host + protocol, so a page served from the *same host on a different port* (a distinct origin under the same-origin policy) would have passed. It now requires the port to match as well. Default-port deployments are unaffected (browsers omit the default port, so `""` still matches `""`). Surfaced by the app-auth security audit. (#158)
- **Rate-limit bucketing no longer collapses on a blank forwarded header.** With `TRUSTED_PROXY=true`, a whitespace-only `CF-Connecting-IP` made `rateLimitKey()` return the shared `"default"` bucket instead of falling through to `X-Forwarded-For` / `X-Real-IP`, weakening per-visitor limiting for such requests. It now falls through to the next header. (#158)

### Schema
- Groundwork for the token-authenticated app API (#158): `AuthToken` gains `clientId` / `createdVia` / `expiresAt` columns, and a new `AuthorizationCode` table holds short-lived single-use OAuth/PKCE codes. Additive and non-destructive (existing tokens are unaffected). **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-01-app-auth-tokens.sql`).
- New `AppTokenUsage` table backing the App-activity audit log (#158). Additive and non-destructive (a brand-new table). **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-07-01-app-token-usage.sql`).

## 1.6.1 (2026-07-01)

### Changed
- Refreshed dependencies: `@fedify/fedify` & `@fedify/next` 2.2.5 → 2.3.0, `@atproto/api` 0.20.19 → 0.20.22, `@types/node` 26.0.0 → 26.0.1, `eslint` 10.5.0 → 10.6.0.

### Fixed
- **The timeline admin tab bar is reachable on narrow phones.** With seven tabs (feed…analytics) in one row, the trailing tabs were clipped off-screen on small viewports with no way to reach them. The row now scrolls horizontally. (#147)
- **No more phantom badge counts from likes/boosts on posts you don't own.** An incoming Fediverse `Like` or `Announce` was always recorded + pushed + counted toward the app badge, even when its target wasn't your content — but the notification bell only ever lists interactions on *your* posts, so the badge would climb with a push that had no matching bell entry (e.g. someone likes a post that's in your feed because you follow the booster). Incoming likes/boosts are now gated on an ownership check (`resolveOwnedTarget`, the same test the bell uses), so they only notify when they're genuinely on your content; the boosted-post-into-your-feed behaviour is unchanged. (#103)

## 1.6.0 (2026-06-27)

### Added
- **Bluesky interactions now reach your notification bell.** Likes, reposts, replies, mentions, quotes, and follows on your crossposted Bluesky posts are pulled in from Bluesky's notification feed (`listNotifications`) and shown in the bell alongside Fediverse activity — previously only the per-post reply poll ran (on page render), so likes/reposts were never recorded and nothing surfaced in the bell. Ingestion is incremental (resumes from a watermark), de-duplicated by each notification's own id (so a re-sync never double-counts), and the very first sync backfills history silently (no notification storm). The "Sync Bluesky" admin button and the scheduled Bluesky sync both run it. (#134)
- **Post pages show who liked and reposted on Bluesky, not just a count.** The interaction strip now renders the actual liker/reposter avatars from both Fediverse and Bluesky (source-tinted rings), using the per-actor data from the new Bluesky ingestion. (#135)

### Schema
- New `BlueskyInteraction` table holding per-actor Bluesky likes/reposts/mentions/quotes/follows on your posts (#134). Additive and non-destructive (a brand-new table). **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-06-25-bluesky-interaction.sql`).

## 1.5.1 (2026-06-25)

### Changed
- Bumped `@atproto/api` 0.20.16 → 0.20.19 (patch).

### Fixed
- **An incoming like or boost is no longer counted twice when redelivered.** The inbox recorded every incoming `Like` / `Announce` unconditionally — bumping the post's like/boost count, adding a notification, and firing a push — so a redelivered activity (federation retries / shared-inbox fan-out) double-counted, duplicated the bell entry, and re-notified. The matching `Undo` only decremented once, leaving a permanent residue on the count. Incoming likes/boosts are now de-duplicated per `(actor, post, type)`, so a redelivery is a no-op; a genuine re-like after an un-like still counts (the un-like removed the earlier record first). (#118)
- **`npm run update` no longer breaks on schema changes that add a unique constraint.** `update.sh` runs `prisma db push`, which refuses to add a unique index without `--accept-data-loss` (even a provably safe additive one) and bailed the whole upgrade. The updater now applies the idempotent `prisma/manual-migrations/*.sql` files (via `prisma db execute`) **before** `db push`, so a unique index can be pre-created and `db push` then sees no diff. Self-hosters don't need `--accept-data-loss`; the safety stance against genuine data loss is unchanged. (#124)

## 1.5.0 (2026-06-24)

### Added
- **Un-like and un-boost from the timeline.** The like and boost buttons are now toggles — clicking a lit one sends an `Undo(Like)` / `Undo(Announce)` to the post author's real inbox (resolved server-side, per #110) and clears the local state, so a mis-click is reversible. (#111)

### Security
- **Rate-limit keying now uses Cloudflare's authoritative client IP behind a trusted proxy.** With `TRUSTED_PROXY=true`, `rateLimitKey()` keyed on the leftmost `X-Forwarded-For` hop — but Cloudflare *appends* to `X-Forwarded-For`, so that hop is client-supplied and spoofable, letting an attacker rotate it to evade the admin-login / guest-comment / XML-RPC / kudos rate limits. It now prefers `CF-Connecting-IP` (set by Cloudflare, not client-overridable), falling back to `X-Forwarded-For` / `X-Real-IP` for non-Cloudflare proxies. The default (`TRUSTED_PROXY` unset → one shared bucket) is unchanged. This makes it safe to enable `TRUSTED_PROXY` behind Cloudflare for genuine per-visitor limiting. (#109)

### Fixed
- **Likes, boosts, and replies now reach FediHome (and other non-Mastodon) servers.** Outbound delivery built the target inbox from Mastodon's convention `https://{domain}/users/{name}/inbox`, so it silently 404'd to FediHome (whose inbox is `/ap/inbox`) and any server with a different inbox path — meaning FediHome↔FediHome likes/boosts/replies never actually arrived. The inbox is now resolved server-side from the target actor's advertised/stored value — a cached follower/following record, else a live actor fetch — via a shared `resolveActorInbox()` helper; Mastodon targets are unaffected (they still resolve to their advertised `/users/<name>/inbox`). (#110)
- **Likes and boosts no longer double-deliver, inflating a follower's counts.** A `Like` was broadcast to all followers *and* sent to the post author, and a boost (`Announce`) was sent to followers *and* directly to the author — so a post author who also follows you received the activity twice, double-counting the like/boost (and the matching `Undo` only decremented once, leaving the count stuck). Likes now go only to the author (the standard target — they aren't broadcast to followers); boosts go to followers plus the author, but the direct author send is skipped when they already follow you (`deliverToFollowers` already reaches them). The same dedup applies to the `Undo` on un-like / un-boost. (#119)
- **A redelivered reply no longer shows up twice in notifications.** Incoming replies to your posts were recorded without a dedup guard, so when a federated server redelivered the same `Create(Note)` (retries / shared-inbox fan-out) you got a duplicate bell entry and a duplicate push. Replies are now de-duplicated on the reply's own ActivityPub id (a new `sourceApId` on the interaction record), so a redelivered reply is recognised and skipped — while genuinely distinct replies from the same person to the same post are still each kept. (#121)

### Schema
- `FediInteraction.sourceApId` — new nullable, **indexed** column holding the interacting activity's own apId (a reply Note's id), used to dedup redelivered replies (#121). Additive and non-destructive (existing rows get `NULL`). Deliberately **not** a unique constraint — `prisma db push` refuses to add a unique index without `--accept-data-loss`, so dedup is enforced in app code. **After upgrading, run `npx prisma db push`** (or apply `prisma/manual-migrations/2026-06-23-fediinteraction-sourceapid.sql`).

## 1.4.1 (2026-06-23)

**Fix release.** Hardens the kudos rate-limiter against a spoofable `X-Forwarded-For` (#93), and fixes the notification badge/bell desync — the badge now tracks the real unread count, boost counts decrement on un-boost, and like/boost notifications deep-link to the post (#103, partial). Backward-compatible — `npm run update`.

### Security
- **Kudos rate-limiting no longer trusts a spoofable `X-Forwarded-For`.** The guest "kudos" endpoint keyed its one-per-hour limit on the raw `X-Forwarded-For` header, so a scripted client could rotate it to inflate a post's kudos count without limit. It now uses the shared `rateLimitKey()` helper, which honours forwarded headers only when `TRUSTED_PROXY=true`; otherwise all requests share a single bucket per path (a spoofed header can't mint unlimited buckets). Per-visitor kudos therefore require a trusted reverse proxy. Also removed the now-unused `clientIp()` helper. (#93)

### Fixed
- **Notification badge stays in sync with the bell, boost counts decrement on un-boost, and like/boost notifications deep-link to the post.** Part of #103: (1) the app-icon badge now derives from the authoritative unread total (the same count the bell computes, extracted into a shared `computeNotifications()` and sent with every push) instead of a blind per-push `+1`, so it no longer climbs out of sync while the app is closed; (2) a new Undo-Announce handler decrements boost counts and removes the stored boost when a boost is retracted (previously boost rows only ever accumulated); (3) like/boost push notifications now open the relevant post instead of always `/timeline`. (The remaining parts of #103 — realigning the push gate to the bell and the inverse "silently-dropped reply" cases — are deferred to a dedicated change.) (#103)

## 1.4.0 (2026-06-22)

**Federation & maintenance release.** Shared posts now unfurl with a real preview card (image + summary) instead of a bare title+link, and the ActivityPub post object is unified across every publish path (#96); plus a five-major dependency refresh — TypeScript 6, marked 18, @atproto 0.20, @types/node 26, ESLint 10 (#100). Backward-compatible — upgrade with the usual `npm run update`.

### Changed
- **Dependency refresh — five major bumps, all backward-compatible.** TypeScript `5.9 → 6.0`, `marked` `17 → 18` (markdown→HTML output verified unchanged on representative posts), `@types/node` `25 → 26`, `@atproto/api` `0.19 → 0.20` (Bluesky SDK), and ESLint `9 → 10`, plus in-range patch/minor updates (Next 16.2.9, React 19.2.7, `pg`, `tailwindcss`, `fast-xml-parser`, `music-metadata`, `@fedify/next`). Verified with tsc / 77 tests / build / lint (0 errors) / `npm audit` (unchanged at 3 moderate — the parked postcss advisory). The ESLint 9→10 bump installs with peer warnings (`@next/eslint-plugin-next` and `eslint-plugin-react-hooks` still declare `eslint ^9`); lint runs clean regardless — to be tidied once those plugins ship eslint-10 peers.

### Fixed
- **Shared posts now unfurl with a real preview, and federate consistently across every publish path.** A titled post (Article) used to appear as a bare title + link on Mastodon and other servers — no description, no image. Two changes: (1) every post page now emits a complete Open Graph / Twitter card — a guaranteed preview image (cover → first photo → first inline image → audio cover → site default) and a clean, markdown-stripped description — so the link shows a picture and summary wherever it's posted (Mastodon's link card, Bluesky, Threads, Slack, Discord, …); (2) the ActivityPub post object is now built by one shared `buildPostObject()` used by the Micropub, XML-RPC, outbox, and per-post AP routes, so all paths federate identically — the Micropub/XML-RPC paths no longer send escaped raw markdown, titled Articles carry their `name`, and the cover image is attached (previously only inline photos were). (#96)

## 1.3.0 (2026-06-21)

**Features & hardening release.** Individually revocable admin sessions (#14), a "hide social graph" privacy opt-out (#23), and an optional "support the project" link (#64), plus rate-limit/dependency-advisory hardening (#10, #12, #55) and a large maintainability refactor that splits the 1,076-line `admin/route.ts` into per-domain modules (#11). Backward-compatible — upgrade with the usual `npm run update`. **One-time note:** this adds an `AdminSession` table and invalidates existing admin logins once, so sign in again after upgrading (see Schema below).

### Added
- **Optional "Support the project" link.** Set `FUNDING_URL` (e.g. your GitHub Sponsors / Ko-fi / Liberapay page) to show a themed `♥` link on the landing page (`LANDING_MODE`) and in the footer; `FUNDING_LABEL` customises the text (default "Support FediHome"). Unset → nothing renders, so other self-hosters see no change. Mirrors the existing config-driven webring/badge footer extras. (#64)
- **`HIDE_SOCIAL_GRAPH` privacy knob.** When set, `/ap/followers` and `/ap/following` still report their counts (`totalItems`) but no longer enumerate who follows you / who you follow — Mastodon's "hide social graph" behaviour. Off by default; federation delivery is unaffected (it only references the collection URIs, never their contents). (#23)
- **Revocable admin sessions.** Admin logins are now persisted server-side, so an individual session can be revoked without rotating `ADMIN_SECRET` (which logs *everyone* out). A new **/admin/sessions** page (linked from the timeline header) lists every signed-in device with its browser/OS and last-active time, and lets you revoke any one, "sign out all other sessions", or sign out the current device. Sessions also expire now — `ADMIN_SESSION_TTL_DAYS` (default 30) bounds their lifetime. **On upgrade, existing admin logins are invalidated once** (the new session store starts empty), so you'll sign in again after deploying. (#14)

### Security
- **Cleared 4 of 5 outstanding transitive-dependency advisories** via npm `overrides`, forcing patched versions of `yaml`, `js-yaml`, `@opentelemetry/core`, and `@hono/node-server` (the last dev-only, via `@prisma/dev`). All were low-exposure moderates; verified with tsc / 70 tests / build / lint. The one remaining — `postcss` bundled *inside* Next.js (GHSA-qx2v-qp2m-jg93) — has no upstream fix and is build-time / trusted-CSS only. (#12, #55)

### Changed
- **Restored `npm run lint` under Next 16** (which removed the `next lint` command): added ESLint 9 with a flat `eslint.config.mjs` wiring `@next/eslint-plugin-next`, `eslint-plugin-react-hooks` v7 (React 19 "Rules of React"), and the TypeScript parser. The new render-purity/ref rules are surfaced as warnings for now. (#21)
- **Debug `console.log`s on the hot publish/federation paths are now silent by default.** Five informational logs (Micropub crosspost success, AP inbox activity received / unhandled type / DM received) are gated behind `FEDIHOME_DEBUG=true`; `console.error`/`console.warn` diagnostics are untouched. (#13)
- **Unified the rate-limit IP keying behind a single `rateLimitKey()` helper** (`src/lib/client-ip.ts`). The admin-login, XML-RPC, and guest-comment endpoints each carried their own byte-identical copy of the "trust `X-Forwarded-For` only when `TRUSTED_PROXY=true`, else one shared bucket" logic; they now share one tested helper, so the security invariant can't drift between routes. Behaviour is unchanged (the guest-comment hash now keys off `default` instead of `unknown` in the degenerate "proxy trusted but no forwarded header" case). (#10)
- **Split the 1,076-line `admin/route.ts` into per-domain action modules.** The single giant `switch (action)` POST handler is now a thin auth + dispatch layer (~55 lines) delegating to `_actions/{comments,replies,dms,fedi-graph,fedi-interactions,bluesky}.ts`. Pure refactor — every admin action (comment moderation, fedi/Bluesky replies, DMs, follow-graph, like/boost/block) behaves identically; verified by a per-action old-vs-new equivalence audit. (#11)

### Fixed
- **Post pages no longer re-poll Bluesky on every render.** Polling is now throttled by a per-post TTL and each network call has a timeout, so a slow or failing Bluesky never blocks page render; poll failures now log `err.cause` and the post URI instead of being swallowed. (#54)
- **Fixed two React 19 render-purity violations** surfaced by the restored lint: a ref written during render in the timeline (`TimelineClient`) now updates in an effect, and `NotificationBell` no longer calls `Date.now()` during render (relative times come from effect-backed state). (#78)
- **Cleared the one ESLint error** (`@next/next/no-html-link-for-pages`) on the setup wizard's completion screen — "Go to your site" is now a `next/link` `<Link>` (client transition instead of a full reload) — and removed two stale `eslint-disable` directives. (#83)
- **`install.sh` / `update.sh` run cleanly without a controlling terminal.** They no longer emit `/dev/tty: Device not configured` when run headlessly (the tty is now probed for openability before use), and they honour a non-interactive mode — set `FEDIHOME_NONINTERACTIVE=1` / `FEDIHOME_YES=1` / `CI=1` to skip prompts and take each one's stated default (destructive install prompts default to "no", so unattended runs are fail-closed). (#77)

### Schema
- New **`AdminSession`** table — persisted admin login sessions, enabling individual session revocation. Apply with `npx prisma db push` (the `update.sh` upgrade path runs this automatically). Existing admin logins are invalidated once on upgrade (the table starts empty), so sign in again afterwards. (#14)

## 1.2.0 (2026-06-20)

**Security & reliability release.** Clears a high-severity `nodemailer` advisory (#66) and adds the `assertPublicHost` SSRF guard to signed ActivityPub GETs (#67), migrates to the Next 16 `proxy` convention (#68), and hardens self-hosted installs/updates — configurable/safe PostgreSQL setup including PG15+ (#29, #31) and stale-build rebuilds (#63). Backward-compatible — upgrade with the usual `npm run update`.

### Security
- **Bumped `nodemailer` to v9** to clear GHSA-p6gq-j5cr-w38f (arbitrary file read / SSRF via the `raw` message option). FediHome doesn't use the `raw` option, so exposure was low, but it's a high-severity advisory on a direct dependency and the upgrade is drop-in. (#66)
- **`signedGet` now runs the `assertPublicHost` SSRF guard**, matching `signedFetch`. Every current caller already vets the URL, so this is defense-in-depth/consistency — a signed ActivityPub GET can no longer be coerced to a private/internal host even if a future caller forgets to check. (#67)

### Changed
- **Migrated the Next.js `middleware` convention to `proxy`** (Next 16 deprecated `middleware`). `src/middleware.ts` → `src/proxy.ts`, function renamed `middleware` → `proxy`; the matcher and behaviour (setup redirect + ActivityPub content negotiation) are unchanged. Clears the `next build` deprecation warning and stays ahead of the eventual removal. (#68)

### Fixed
- **`install.sh` is safer alongside an existing PostgreSQL, and works on PostgreSQL 15+.** The database name/role/host/port are now overridable (`DB_NAME` / `DB_USER` / `PGHOST` / `PGPORT`); the installer now **asks** before reusing an existing database or resetting an existing role's password (previously it reset silently); and it grants the app role ownership + `CREATE` on schema `public`, so `prisma db push` succeeds on PG15+ / non-owner setups where it used to fail with `permission denied for schema public`. Defaults are unchanged on a clean host. (#31, #29)
- **`npm run update` now rebuilds + restarts when the running build is stale, not only when there are commits to pull.** It records the last-built commit and, if HEAD differs from it (e.g. after switching branches) with nothing to pull, rebuilds and restarts the current code instead of exiting "already up to date" while the old build keeps serving. (#63)

## 1.1.0 (2026-06-19)

**Security & reliability release.** A hardening pass across the federation, XML-RPC, guest-comment, and setup paths, plus a configurable app port (`PORT` / `FEDIHOME_PORT`) and smoother self-hosted installs. Backward-compatible — upgrade with the usual `npm run update`, no action required. Validated live on the [fedihome.social](https://fedihome.social) demo before release.

### Security
- **Hardened the outbound federation path.** `signedFetch` (the signed ActivityPub delivery POST) now runs the same `assertPublicHost` SSRF guard the inbound/resolver paths use, so a delivery target can never be coerced to a private/internal host even if a caller forgets to vet it. Also fixed a tainted-format-string in delivery error logging (the inbox URL is now passed as a `%s` argument, not interpolated into the format string), and added least-privilege `permissions:` blocks to the CI workflows. Resolves CodeQL `js/request-forgery` (delivery), `js/tainted-format-string`, and `actions/missing-workflow-permissions`.
- **Hardened the XML-RPC (MetaWeblog) endpoint against ReDoS.** The hand-rolled regex value extraction backtracked polynomially on hostile input; it's been rewritten as a linear `indexOf` scan in a new, unit-tested `src/lib/xmlrpc.ts` module, and the endpoint now rejects oversized request bodies. Behaviour for real blogging clients is unchanged. Resolves the CodeQL `js/polynomial-redos` findings and the `js/incomplete-multi-character-sanitization` tag-strip in that file. Also clamps the `metaWeblog.getRecentPosts` page size to 1–50 and rejects non-finite values, so a crafted request can't trigger an unbounded query (or a `take: NaN` 500). (#9)
- **Robust plain-text snippets + an HTML-entity decode fix.** Notification and reply-preview snippets are now built by a shared `htmlToText` helper (`src/lib/html-text.ts`) that strips tags in a single linear pass, instead of one-shot regexes that nested or malformed tags could slip through; and `decodeHtmlEntities` (link-preview metadata) now decodes `&amp;` last, so a literal like `&amp;lt;` is no longer doubly-unescaped. These are plain-text sinks (so not XSS), but the old patterns were incorrect. Resolves the CodeQL `js/incomplete-multi-character-sanitization` and `js/double-escaping` findings in those paths.
- **The public guest-comment endpoint now caps the request body (64 KB → 413).** `POST /api/comments` parsed the body with no size limit (App Router routes don't inherit a `bodyParser` cap), so an unauthenticated caller could buffer a very large payload into memory before the field-length checks ran. Legitimate comments are far under the cap. (#8)
- **The first-run setup wizard now requires a one-time token.** On a fresh deploy that's publicly reachable before `ADMIN_SECRET` is set (manual/Docker installs), an anonymous visitor could previously POST `/api/setup` and claim admin. Completing setup now requires a `SETUP_TOKEN` — taken from the env var, or auto-generated once and printed to the server console — verified with a constant-time compare. It fails closed. `install.sh` installs already set `ADMIN_SECRET`, so they're unaffected. (#22)

### Fixed
- **The app listen port is now configurable.** The `dev`/`start` scripts hardcoded `--port 3000`, which overrode Next.js's built-in `PORT` support — so FediHome couldn't run on a host already using port 3000, and `PORT=…` was silently ignored. The flag is dropped (Next reads `PORT` natively), pm2 forwards `PORT`, and Docker Compose's host port is now `FEDIHOME_PORT`. All default to 3000, so existing deploys are unchanged. Remember to keep `SITE_URL` pointed at your real public origin if you change the port. (#27)
- **`npm run update` now restarts pm2 deployments under any process name, and fails loudly if it can't restart.** The updater only restarted a pm2 process literally named `fedihome`, so a differently-named pm2 app (common on multi-site hosts) or a bare `npm start` silently kept serving the old build while the script exited 0. It now finds the pm2 process by working directory (falling back to the `fedihome` name), and when nothing can be restarted it prints a clear error and exits non-zero instead of a green success banner. (#32)
- **`SITE_URL` is now persisted at setup, preserving protocol and port.** Neither `install.sh` nor the setup wizard wrote `SITE_URL` (the canonical origin for ActivityPub IDs, WebFinger, RSS, signature keyId, and the CSRF check), and the wizard's fallback dropped the port and forced `https`. The installer now prompts for it (defaulting to any existing value, so a re-run never clobbers), and the wizard records the browser origin. Off-3000 / proxied deploys no longer silently break federation. Pairs with #27. (#33)
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
