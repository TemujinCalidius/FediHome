/**
 * Federation identity — the single source of truth for `SITE_URL`,
 * `FEDI_HANDLE`, `FEDI_DOMAIN` and everything derived from them.
 *
 * **Why this module exists** (Phase 0 of #326). These values were read directly
 * from `process.env` in 23 places and captured into module-level constants in
 * 12 more. A module-level `const siteUrl = process.env.SITE_URL` is evaluated
 * once at *import*, so it can never see a value resolved at runtime — which
 * makes a DB-backed identity impossible until every consumer goes through one
 * accessor. This is that accessor.
 *
 * Resolution order is **runtime override → environment → built-in default**.
 * The overrides are loaded from the database at boot by `identity-store.ts`
 * (Phase 1); nothing writes those rows yet, so in practice this still resolves
 * from the environment exactly as before.
 *
 * **Why the agreement matters.** The actor id, the WebFinger `subject`/`href`
 * and the HTTP-signature `keyId` must all describe the same identity. If they
 * disagree, remote servers stop verifying posts and stop resolving the actor —
 * and nothing in the logs says why, because from our side every response looks
 * well-formed. Deriving them all from one place is the point.
 *
 * **Not cached, on purpose.** Derivation is trivial string work, and tests
 * mutate `process.env.SITE_URL` between cases. A cache belongs with the DB read
 * that actually needs one (Phase 1), together with explicit invalidation.
 *
 * **Server-side only in spirit.** `process.env.SITE_URL` is not available in
 * client bundles (only `NEXT_PUBLIC_*` is inlined), so client components must
 * receive identity as props or from the runtime site config — never by calling
 * this and hoping. See `media-url.ts` for the existing example of that rule.
 */

const DEFAULT_SITE_URL = "http://localhost:3000";

/**
 * Runtime overrides, layered over the environment (#326 Phase 1).
 *
 * This module deliberately imports **nothing** — `site.config.ts` imports it,
 * and that is pulled into client bundles, so a `prisma` import here would drag
 * the database client into the browser. The DB read therefore lives in the
 * server-only `identity-store.ts`, which *pushes* values in through
 * `applyIdentityOverrides`. That keeps `getIdentity()` synchronous, which is
 * what lets ~60 call sites — several of them in sync helpers — keep working.
 *
 * Empty until something loads it. On the client it stays empty forever, exactly
 * as `process.env.SITE_URL` is already absent there; client code must take
 * identity from props or the runtime site config, never from here.
 */
type IdentityOverrides = Partial<Record<"siteUrl" | "fediHandle" | "fediDomain", string>>;
let overrides: IdentityOverrides = {};

/**
 * Replace the runtime overrides. Server-side only — see `identity-store.ts`.
 *
 * ⚠️ Process-local. Under a multi-process deployment (pm2 cluster) a write in
 * one worker is invisible to the others until they reload, so whatever
 * eventually writes these rows must either refresh every worker or require a
 * restart. Same constraint as `webpush.setVapidDetails` in push-config.ts.
 */
export function applyIdentityOverrides(next: IdentityOverrides): void {
  overrides = { ...next };
}

/** Drop the overrides, falling back to the environment. */
export function clearIdentityOverrides(): void {
  overrides = {};
}

export interface Identity {
  /** Public origin, no trailing slash — e.g. `https://example.com`. */
  siteUrl: string;
  /** Local part of the fediverse address — e.g. `me`. */
  fediHandle: string;
  /** Domain part of the fediverse address — e.g. `example.com`. */
  fediDomain: string;
  /** The full address — e.g. `@me@example.com`. */
  fediAddress: string;
  /** ActivityPub actor id — the canonical, immutable identifier for this site. */
  actorId: string;
  /** HTTP-signature key id; must resolve to the actor's `publicKey`. */
  keyId: string;
  /** WebFinger `subject` — e.g. `acct:me@example.com`. */
  webfingerSubject: string;
}

/**
 * Trailing slashes are stripped so `${siteUrl}/ap/actor` can never produce a
 * double slash. An actor id that differs by a slash is a *different* id to a
 * remote server, so this is worth being defensive about — the setup wizard
 * already normalises what it writes (#59), but `.env.local` can be hand-edited.
 */
function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function getIdentity(): Identity {
  // Precedence: runtime override -> environment -> built-in default.
  const siteUrl = normalizeOrigin(overrides.siteUrl || process.env.SITE_URL || DEFAULT_SITE_URL);
  const fediHandle = overrides.fediHandle || process.env.FEDI_HANDLE || "me";
  // Derive the domain from the site URL when it isn't set explicitly, matching
  // what site.config.ts has always done. WebFinger used to fall back to the
  // literal "localhost" instead, so an instance that set SITE_URL but not
  // FEDI_DOMAIN advertised @me@example.com everywhere while WebFinger answered
  // only to acct:me@localhost — i.e. 404 to every remote lookup, undiscoverable,
  // with a perfectly healthy-looking site. One derivation, no disagreement.
  let fediDomain = overrides.fediDomain || process.env.FEDI_DOMAIN;
  if (!fediDomain) {
    try {
      fediDomain = new URL(siteUrl).host;
    } catch {
      fediDomain = new URL(DEFAULT_SITE_URL).host;
    }
  }

  const actorId = `${siteUrl}/ap/actor`;
  return {
    siteUrl,
    fediHandle,
    fediDomain,
    fediAddress: `@${fediHandle}@${fediDomain}`,
    actorId,
    keyId: `${actorId}#main-key`,
    webfingerSubject: `acct:${fediHandle}@${fediDomain}`,
  };
}

/** Shorthand for the common case — the public origin. */
export function getSiteUrl(): string {
  return getIdentity().siteUrl;
}

/**
 * The site URL *as configured*, or `undefined` when it isn't set — no
 * `localhost` default applied.
 *
 * Only for code deciding what identity to WRITE (the setup wizard), where the
 * default would be actively wrong: setup falls back to the request's own origin,
 * which is a far better guess than `http://localhost:3000`. Everything that
 * merely *reads* the identity wants `getSiteUrl()` instead.
 */
export function getConfiguredSiteUrl(): string | undefined {
  const raw = (overrides.siteUrl || process.env.SITE_URL)?.trim();
  return raw ? normalizeOrigin(raw) : undefined;
}
