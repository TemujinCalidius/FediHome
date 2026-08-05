/**
 * The owner area, described as DATA (#368).
 *
 * The problem this solves is stated in the issue: a grep for links to `/admin/…`
 * across all of `src/` found them in exactly one file — the `/timeline` header.
 * There is no admin nav, no sidebar, no index, and `/admin` itself 404s. Miss
 * that one header and Sessions, App activity and Integrations are effectively
 * invisible.
 *
 * The issue also names the prerequisite for the part that actually scales:
 * search "needs settings to be described as data (label, keywords, location)
 * rather than only as JSX". That is this file. Every destination carries the
 * words an owner would plausibly type — including the ones the UI does NOT use,
 * because "where do I turn off notifications" is typed by someone who has never
 * read the word "VAPID".
 *
 * Deliberately NOT a route change. The existing paths are linked from
 * `docs/configuration.md`, `docs/app-api.md`, the macOS app and the setup
 * wizard's deep links, so moving them is a separate piece of work with
 * redirects — and none of it is needed to fix the finding-things problem. What
 * lands here is the index, the navigation and the search; the route
 * reorganisation and the "does /timeline fold in" question stay open.
 */

export interface AdminDestination {
  /** Where to go. An `#anchor` targets a section id on that page. */
  href: string;
  /** What it is called on screen. */
  label: string;
  /** One line, in the owner's language, saying what they'd change here. */
  blurb: string;
  /**
   * Extra words that should MATCH but need not be displayed — synonyms, the
   * jargon we deliberately avoid in the UI, and the thing an owner calls it.
   */
  keywords: string[];
}

export interface AdminGroup {
  title: string;
  /** Why these belong together, so the grouping isn't just an assertion. */
  blurb: string;
  items: AdminDestination[];
}

/**
 * Section anchors on /admin/site.
 *
 * `SiteSettingsClient` derives each `<section id>` from its title:
 * `title.toLowerCase().replace(/[^a-z0-9]+/g, "-")`. So these are not invented —
 * they are that transform applied to the headings that exist, and a test pins
 * every one of them against the real file. #411 already relies on the mechanism
 * (`/admin/site#security` is where the sign-in screen sends an owner still using
 * ADMIN_SECRET), so this is using it rather than introducing it.
 */
const SITE = "/admin/site";

export const ADMIN_GROUPS: AdminGroup[] = [
  {
    title: "Your site",
    blurb: "How your site looks and what a visitor sees.",
    items: [
      {
        href: `${SITE}#identity`,
        label: "Address and handle",
        blurb: "Your site address and your Fediverse handle.",
        keywords: ["identity", "domain", "url", "handle", "actor", "fedi address", "username"],
      },
      {
        href: `${SITE}#your-profile`,
        label: "Your profile",
        blurb: "Your name, bio, avatar and banner.",
        keywords: ["profile", "name", "bio", "avatar", "picture", "banner", "header image", "tagline"],
      },
      {
        href: `${SITE}#appearance`,
        label: "Appearance",
        blurb: "Theme, accent colour, page width and the sidebar.",
        keywords: ["theme", "colour", "color", "accent", "layout", "sidebar", "dark", "light", "feed layout", "cards", "list"],
      },
      {
        href: `${SITE}#landing-page`,
        label: "Landing page",
        blurb: "What people see first at your front door.",
        keywords: ["landing", "home", "front page", "headline", "subhead", "splash"],
      },
      {
        href: `${SITE}#navigation`,
        label: "Navigation",
        blurb: "Which sections show in your menu.",
        keywords: ["nav", "menu", "links", "journal", "articles", "photography", "videos", "audio", "about"],
      },
      {
        href: `${SITE}#about-page`,
        label: "About page",
        blurb: "The heading and text of your About page.",
        keywords: ["about", "bio page", "markdown", "colophon"],
      },
      {
        href: `${SITE}#analytics`,
        label: "Analytics",
        blurb: "Visitor stats, if you've connected Tinylytics.",
        keywords: ["analytics", "stats", "visitors", "tinylytics", "traffic", "hits"],
      },
      {
        href: `${SITE}#footer`,
        label: "Footer",
        blurb: "Webring, badge and funding links at the bottom of every page.",
        keywords: ["footer", "webring", "badge", "funding", "donate", "sponsor", "tip"],
      },
    ],
  },
  {
    title: "Publishing",
    blurb: "What you post, where it goes, and who can read it.",
    items: [
      {
        href: "/compose",
        label: "Write a post",
        blurb: "Notes, articles, photos, video and audio.",
        keywords: ["compose", "write", "new post", "publish", "draft", "schedule"],
      },
      {
        href: `${SITE}#public-fediverse-feed`,
        label: "Public Fediverse feed",
        blurb: "Whether strangers can read the feed you follow, and the Explore feed.",
        keywords: ["public feed", "fediverse page", "read-only", "social graph", "followers list", "explore"],
      },
      {
        href: `${SITE}#explore`,
        label: "Explore",
        blurb: "Discover people through the ones you already follow.",
        keywords: ["explore", "discover", "boosts", "replies", "recommendations", "find people"],
      },
      {
        href: `${SITE}#categories`,
        label: "Categories",
        blurb: "The galleries your photos, videos and audio are filed under.",
        keywords: ["categories", "galleries", "albums", "tags", "collections"],
      },
      {
        href: `${SITE}#contact-podcast`,
        label: "Contact and podcast",
        blurb: "Your contact address and the details on your audio feed.",
        keywords: ["contact", "email", "podcast", "rss", "itunes", "audio feed"],
      },
      {
        href: "/admin/integrations",
        label: "Bluesky and Threads",
        blurb: "Sign in so your posts can be copied to those networks.",
        keywords: ["bluesky", "threads", "atproto", "crosspost", "cross-post", "mirror", "day one", "smtp", "email journal"],
      },
    ],
  },
  {
    title: "People",
    blurb: "Your feed, your conversations, and who you let in.",
    items: [
      {
        href: "/timeline",
        label: "Timeline",
        blurb: "Your feed, replies, messages, followers and analytics.",
        keywords: ["timeline", "feed", "home", "replies", "mentions", "notifications", "analytics", "stats"],
      },
      {
        href: "/timeline",
        label: "Comment moderation",
        blurb: "Approve or reject comments left on your posts.",
        keywords: ["moderation", "comments", "approve", "reject", "pending", "spam"],
      },
      {
        href: "/timeline",
        label: "Blocked accounts",
        blurb: "Accounts and servers you've blocked.",
        keywords: ["block", "blocked", "mute", "ban", "domain block", "defederate"],
      },
      {
        href: "/timeline",
        label: "Messages",
        blurb: "Direct messages, from the Fediverse and Bluesky.",
        keywords: ["dm", "messages", "direct message", "inbox", "private"],
      },
    ],
  },
  {
    title: "Apps and access",
    blurb: "What can sign in as you, and from where.",
    items: [
      {
        href: "/admin/apps",
        label: "Connected apps",
        blurb: "App tokens, and third-party apps you've allowed.",
        keywords: ["apps", "tokens", "api key", "oauth", "indieauth", "micropub", "quill", "obsidian", "revoke"],
      },
      {
        href: "/admin/sessions",
        label: "Sessions",
        blurb: "Devices signed in to your admin account.",
        keywords: ["sessions", "devices", "sign out", "logout", "browsers", "revoke"],
      },
      {
        href: "/admin/audit",
        label: "App activity",
        blurb: "What your apps and tokens have been doing.",
        keywords: ["audit", "activity", "log", "history", "who did what"],
      },
      {
        href: `${SITE}#phone-notifications-web-push`,
        label: "Phone notifications",
        blurb: "Get a buzz when someone follows, replies or messages you.",
        keywords: ["push", "notifications", "phone", "alerts", "vapid", "web push", "buzz"],
      },
      {
        href: `${SITE}#macos-app`,
        label: "macOS app",
        blurb: "Show a download link for the Mac app on your site.",
        keywords: ["macos", "mac", "app store", "download", "desktop"],
      },
    ],
  },
  {
    title: "Maintenance",
    blurb: "The parts you set once and mostly forget.",
    items: [
      {
        href: `${SITE}#security`,
        label: "Password and security",
        blurb: "Your admin password, and how long sign-ins and tokens last.",
        keywords: ["password", "security", "login", "session length", "token lifetime", "expiry", "admin secret"],
      },
      {
        href: `${SITE}#storage`,
        label: "Storage",
        blurb: "Where uploads are written, and how much space they use.",
        keywords: ["storage", "disk", "uploads", "space", "cache", "media", "full", "volume"],
      },
      {
        href: "/admin/settings",
        label: "Background jobs",
        blurb: "How often FediHome publishes, syncs and tidies up.",
        keywords: ["scheduler", "background", "jobs", "cron", "interval", "retention", "prune", "cleanup", "update check"],
      },
      {
        href: `${SITE}#support-bundle`,
        label: "Support bundle",
        blurb: "A summary of your instance to paste into a bug report.",
        keywords: ["support", "bundle", "diagnostics", "debug", "bug report", "version", "logs"],
      },
      {
        href: `${SITE}#export-your-content`,
        label: "Export your content",
        blurb: "Download everything you've written.",
        keywords: ["export", "download", "backup", "archive", "leave", "takeout"],
      },
      {
        href: `${SITE}#moving-here-from-another-account`,
        label: "Moving here",
        blurb: "Bring your followers from another server.",
        keywords: ["move in", "migrate", "alias", "alsoknownas", "import followers", "mastodon"],
      },
      {
        href: `${SITE}#moving-away-from-here`,
        label: "Moving away",
        blurb: "Take your followers to another server.",
        keywords: ["move out", "migrate", "leave", "movedto", "export followers", "quit"],
      },
    ],
  },
];

/** Flat list, for search. */
export const ADMIN_DESTINATIONS: AdminDestination[] = ADMIN_GROUPS.flatMap((g) => g.items);

/**
 * Rank destinations against what the owner typed.
 *
 * Substring, not fuzzy: a fuzzy match on a list this small produces confident
 * nonsense ("push" matching "Publishing"), and an owner who typed three
 * characters and got the wrong page trusts the box less than one who got
 * nothing. Label matches outrank blurb, which outranks keywords, so typing
 * "storage" puts Storage first rather than whatever mentions the word.
 */
export function searchAdmin(query: string, limit = 8): AdminDestination[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const scored: { d: AdminDestination; score: number }[] = [];
  for (const d of ADMIN_DESTINATIONS) {
    const label = d.label.toLowerCase();
    let score = 0;
    if (label === q) score = 100;
    else if (label.startsWith(q)) score = 80;
    else if (label.includes(q)) score = 60;
    else if (d.keywords.some((k) => k.toLowerCase() === q)) score = 50;
    else if (d.keywords.some((k) => k.toLowerCase().includes(q))) score = 30;
    else if (d.blurb.toLowerCase().includes(q)) score = 20;
    if (score > 0) scored.push({ d, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.d.label.localeCompare(b.d.label))
    .slice(0, limit)
    .map((s) => s.d);
}
