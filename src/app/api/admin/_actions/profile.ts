import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverToFollowers } from "@/lib/http-signatures";
import { getActorProfile } from "@/lib/federation";
import { getRuntimeProfile, invalidateProfileCache } from "@/lib/site-profile";
import { isThemeId } from "@/lib/themes";
import { siteConfig } from "@/../site.config";
import type { AdminBody } from "./types";

const siteUrl = siteConfig.url;

const MAX_TEXT = 500;
// Same characters the setup wizard forbids in .env values — even though these
// go to the DB (not .env), keeping the profile clean of control chars avoids
// surprises in the federated actor + rendered pages.
const FORBIDDEN = /[\r\n]/;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
// Image paths must be a same-origin relative upload/asset — never an external
// URL (SSRF/hotlink) or a path-traversal escape. The client uploads via
// POST /api/media (which returns an absolute URL); we accept either the
// returned URL under our own origin, or a plain "/uploads/…" / "/images/…" path.
const IMAGE_PATH_RE = /^\/(uploads|images)\/[A-Za-z0-9._/-]+$/;

function textField(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (value.length > MAX_TEXT) throw new Error(`${name} is too long`);
  if (FORBIDDEN.test(value)) throw new Error(`${name} contains forbidden characters`);
  return value;
}

/** Normalize an image path input to a same-origin relative path, or throw. */
function imagePath(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  let path = value.trim();
  if (path.startsWith(siteUrl)) path = path.slice(siteUrl.length); // strip our own origin
  if (!IMAGE_PATH_RE.test(path) || path.includes("..")) {
    throw new Error(`${name} must be an uploaded image path (/uploads/… or /images/…)`);
  }
  return path;
}

/**
 * An image path, or `""`/`null` to CLEAR back to the built-in default. Storing
 * an empty string is what "use the default" means here: the read side does
 * `row.avatarPath || base.avatarPath` (site-profile), so it reverts to
 * site.config's `/images/avatar.png` — and it keeps tracking that default
 * rather than pinning a permanent override. Mirrors the `""`/`null` = "inherit"
 * convention `themeAccents` already uses.
 */
function imagePathOrClear(name: string, value: unknown): string {
  if (value === null || (typeof value === "string" && value.trim() === "")) return "";
  return imagePath(name, value);
}

// Fields that appear in the AP actor document (getActorProfile: name, summary,
// icon, image). Only a change to one of these warrants federating an `Update`;
// accent / bio / tagline are local display and must NOT blast a pointless,
// byte-identical actor Update to every follower (#276).
const FEDERATED_FIELDS = ["authorName", "actorSummary", "avatarPath", "bannerPath"] as const;

/**
 * Edit the owner's profile post-setup (#201): name/bio/tagline/summary, avatar/
 * banner (paths from a prior POST /api/media upload), the legacy default-theme
 * `accentColor`, and per-theme accent overrides (`themeAccents`, #276). Writes
 * the `SiteSettings` overlay that getRuntimeProfile() reads, so the change takes
 * effect on the actor + /api/account immediately. Federates an actor `Update`
 * ONLY when a federated field changed (see FEDERATED_FIELDS).
 *
 * `manage` scope (gated by the caller) + owner cookie. Only provided fields are
 * written; omitted ones are left unchanged.
 */
export async function updateProfile(body: AdminBody): Promise<NextResponse> {
  const data: Record<string, string> = {};
  // Per-theme accent overrides are merged (a partial `{ themeId: hex|"" }`),
  // written separately since the column is JSON, not a string.
  let themeAccentsUpdate: Record<string, string> | undefined;
  try {
    if (body.authorName !== undefined) data.authorName = textField("authorName", body.authorName);
    if (body.authorBio !== undefined) data.authorBio = textField("authorBio", body.authorBio);
    if (body.authorTagline !== undefined) data.authorTagline = textField("authorTagline", body.authorTagline);
    if (body.actorSummary !== undefined) data.actorSummary = textField("actorSummary", body.actorSummary);
    if (body.accentColor !== undefined) {
      if (typeof body.accentColor !== "string" || !ACCENT_RE.test(body.accentColor)) {
        throw new Error("accentColor must be a #RRGGBB hex color");
      }
      data.accentColor = body.accentColor;
    }
    if (body.themeAccents !== undefined) {
      themeAccentsUpdate = await mergeThemeAccents(body.themeAccents);
    }
    if (body.avatarPath !== undefined) data.avatarPath = imagePathOrClear("avatarPath", body.avatarPath);
    if (body.bannerPath !== undefined) data.bannerPath = imagePathOrClear("bannerPath", body.bannerPath);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  if (Object.keys(data).length === 0 && themeAccentsUpdate === undefined) {
    return NextResponse.json({ error: "no profile fields provided" }, { status: 400 });
  }

  const update = { ...data, ...(themeAccentsUpdate !== undefined ? { themeAccents: themeAccentsUpdate } : {}) };
  await prisma.siteSettings.upsert({
    where: { id: "main" },
    update,
    create: { id: "main", setupDone: true, ...update },
  });
  invalidateProfileCache();

  // Federate an actor Update so Mastodon etc. refresh the cached profile — but
  // only when a federated field actually changed (#276).
  if (FEDERATED_FIELDS.some((f) => f in data)) {
    const actor = await getActorProfile();
    void deliverToFollowers({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/actor#update-${Date.now()}`,
      type: "Update",
      actor: `${siteUrl}/ap/actor`,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: actor,
    }).catch((err) => console.error("Failed to federate profile update:", err));
  }

  const profile = await getRuntimeProfile();
  return NextResponse.json({
    success: true,
    profile: {
      authorName: profile.authorName,
      bio: profile.authorBio,
      tagline: profile.authorTagline,
      summary: profile.actorSummary,
      accentColor: profile.accentColor,
      themeAccents: profile.themeAccents,
      avatar: `${siteUrl}${profile.avatarPath}`,
      banner: `${siteUrl}${profile.bannerPath}`,
    },
  });
}

/**
 * Merge a partial per-theme accent map onto the currently-stored overrides.
 * Each value is a `#RRGGBB` hex to set for a known theme, or `""`/`null` to
 * clear that theme (→ inherit the theme's own accent). Throws on a bad value.
 */
async function mergeThemeAccents(input: unknown): Promise<Record<string, string>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("themeAccents must be an object");
  }
  const merged = { ...(await getRuntimeProfile()).themeAccents };
  for (const [themeId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isThemeId(themeId)) throw new Error(`unknown theme: ${themeId}`);
    if (value === "" || value === null) {
      delete merged[themeId]; // clear → inherit
      continue;
    }
    if (typeof value !== "string" || !ACCENT_RE.test(value)) {
      throw new Error(`themeAccents.${themeId} must be a #RRGGBB hex color`);
    }
    merged[themeId] = value.toLowerCase();
  }
  return merged;
}
