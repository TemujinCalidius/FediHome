import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverToFollowers } from "@/lib/http-signatures";
import { getActorProfile } from "@/lib/federation";
import { getRuntimeProfile, invalidateProfileCache } from "@/lib/site-profile";
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
 * Edit the owner's profile post-setup (#201): name/bio/tagline/summary/accent
 * and avatar/banner (paths from a prior POST /api/media upload). Writes the
 * `SiteSettings` overlay that getRuntimeProfile() reads, so the change takes
 * effect on the actor + /api/account immediately, and federates an actor
 * `Update` so remote servers refresh their cached profile.
 *
 * `manage` scope (gated by the caller) + owner cookie. Only provided fields are
 * written; omitted ones are left unchanged.
 */
export async function updateProfile(body: AdminBody): Promise<NextResponse> {
  const data: Record<string, string> = {};
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
    if (body.avatarPath !== undefined) data.avatarPath = imagePath("avatarPath", body.avatarPath);
    if (body.bannerPath !== undefined) data.bannerPath = imagePath("bannerPath", body.bannerPath);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no profile fields provided" }, { status: 400 });
  }

  await prisma.siteSettings.upsert({
    where: { id: "main" },
    update: data,
    create: { id: "main", setupDone: true, ...data },
  });
  invalidateProfileCache();

  // Federate an actor Update so Mastodon etc. refresh the cached profile.
  const actor = await getActorProfile();
  void deliverToFollowers({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/actor#update-${Date.now()}`,
    type: "Update",
    actor: `${siteUrl}/ap/actor`,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    object: actor,
  }).catch((err) => console.error("Failed to federate profile update:", err));

  const profile = await getRuntimeProfile();
  return NextResponse.json({
    success: true,
    profile: {
      authorName: profile.authorName,
      bio: profile.authorBio,
      tagline: profile.authorTagline,
      summary: profile.actorSummary,
      accentColor: profile.accentColor,
      avatar: `${siteUrl}${profile.avatarPath}`,
      banner: `${siteUrl}${profile.bannerPath}`,
    },
  });
}
