import { NextResponse } from "next/server";
import crypto from "crypto";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as fs from "fs";
import * as path from "path";
import { verifyAdmin, safeCompare } from "@/lib/auth";
import { applySiteConfig } from "@/lib/site-settings";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const MAX_FIELD_LEN = 200;
// Forbid characters that would break .env line parsing or allow shell-meta abuse.
// Newlines/CR allow injecting additional KEY=VALUE lines (C7).
// Backslash, double-quote, dollar, backtick are unescaped under shell-style env parsers.
const FORBIDDEN_FIELD_CHARS = /[\r\n\\"$`]/;

// Admin secret is generated client-side via window.crypto and is hex-only.
const ADMIN_SECRET_RE = /^[A-Fa-f0-9]{64,128}$/;

function validateField(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  if (value.length > MAX_FIELD_LEN) {
    throw new Error(`${name} exceeds ${MAX_FIELD_LEN} chars`);
  }
  if (FORBIDDEN_FIELD_CHARS.test(value)) {
    throw new Error(`${name} contains forbidden characters`);
  }
  return value;
}

/**
 * First-run setup token. When ADMIN_SECRET isn't configured yet (a fresh,
 * possibly publicly-exposed deploy), completing setup requires this out-of-band
 * token so an anonymous visitor can't claim admin before the owner. Taken from
 * SETUP_TOKEN if set; otherwise a random token is generated once, stored, and
 * printed to the server console for the operator to copy.
 */
async function getOrCreateSetupToken(): Promise<string> {
  const existing = await prisma.siteSetting.findUnique({ where: { key: "setup_token" } });
  if (existing) return existing.value;
  const token = crypto.randomBytes(24).toString("hex");
  try {
    await prisma.siteSetting.create({ data: { key: "setup_token", value: token } });
    console.warn(
      `\n[FediHome] First-run setup token — enter this in the setup wizard to complete setup:\n          ${token}\n`
    );
    return token;
  } catch {
    // Lost a race to create it — read whoever won.
    const again = await prisma.siteSetting.findUnique({ where: { key: "setup_token" } });
    return again?.value ?? token;
  }
}

export async function POST(request: Request) {
  try {
    // C6: if ADMIN_SECRET is already configured, this endpoint must require
    // admin auth. Otherwise an attacker who can reach the box (DB wiped,
    // initial deploy, snapshot restore) can re-setup and take over.
    if (process.env.ADMIN_SECRET) {
      if (!(await verifyAdmin(request as Request & { cookies: { get(name: string): { value: string } | undefined } }))) {
        return NextResponse.json(
          { error: "Setup is locked; admin authentication required." },
          { status: 401 }
        );
      }
    }

    const body = await request.json();

    // First-claim protection: when ADMIN_SECRET isn't set yet (a fresh deploy),
    // require the out-of-band setup token so an anonymous visitor can't claim
    // admin before the owner. install.sh sets ADMIN_SECRET, so its users never
    // reach this branch; the block above handles the already-configured case.
    if (!process.env.ADMIN_SECRET) {
      const expected = process.env.SETUP_TOKEN || (await getOrCreateSetupToken());
      const provided = typeof body.setupToken === "string" ? body.setupToken : "";
      if (!provided || !safeCompare(provided, expected)) {
        return NextResponse.json(
          {
            error:
              "A setup token is required. Check your server logs for the token printed at first setup (or set SETUP_TOKEN), then enter it to complete setup.",
          },
          { status: 401 }
        );
      }
    }

    const siteName = validateField("siteName", body.siteName ?? "");
    const authorName = validateField("authorName", body.authorName ?? "");
    const authorTagline = validateField("authorTagline", body.authorTagline ?? "");
    const fediHandle = validateField("fediHandle", body.fediHandle ?? "me");
    const contactEmail = validateField("contactEmail", body.contactEmail ?? "");
    const adminSecret: string = body.adminSecret ?? "";

    if (!ADMIN_SECRET_RE.test(adminSecret)) {
      return NextResponse.json(
        { error: "Invalid admin secret. Expected 64–128 hex chars." },
        { status: 400 }
      );
    }

    // C6: atomic claim of the setup slot. Two concurrent requests cannot both
    // succeed because the primary key collides on create, and updateMany with
    // setupDone=false matches at most one row.
    let claimed = false;
    try {
      await prisma.siteSettings.create({
        data: {
          id: "main",
          setupDone: true,
          siteName: siteName || "My FediHome",
          authorName: authorName || "Your Name",
          authorTagline,
          contactEmail,
        },
      });
      claimed = true;
    } catch {
      // Row already exists — try to update IFF setupDone is still false
      const upd = await prisma.siteSettings.updateMany({
        where: { id: "main", setupDone: false },
        data: {
          setupDone: true,
          siteName: siteName || "My FediHome",
          authorName: authorName || "Your Name",
          authorTagline,
          contactEmail,
        },
      });
      claimed = upd.count > 0;
    }

    if (!claimed) {
      return NextResponse.json(
        { error: "Setup has already been completed." },
        { status: 403 }
      );
    }

    // Build .env.local content. All field values were validated above to
    // contain no newlines / quotes / dollar / backtick, so this construction
    // is injection-safe.
    // SITE_URL is the canonical public origin (ActivityPub IDs, WebFinger, RSS,
    // signature keyId, CSRF). Prefer the value the wizard submitted
    // (window.location.origin — correct protocol AND port), then any configured
    // SITE_URL, then the request origin. `.origin`/`.host` preserve the port,
    // unlike the old `https://${hostname}` derivation which dropped it.
    const siteUrl = validateField(
      "siteUrl",
      body.siteUrl || process.env.SITE_URL || new URL(request.url).origin
    );
    const fediDomain = validateField("siteUrlHost", new URL(siteUrl).host);

    const envLines = [
      "",
      "# === FediHome Setup (auto-generated) ===",
      `SITE_URL="${siteUrl}"`,
      `SITE_NAME="${siteName || "My FediHome"}"`,
      `AUTHOR_NAME="${authorName || "Your Name"}"`,
      `AUTHOR_TAGLINE="${authorTagline}"`,
      `FEDI_HANDLE="${fediHandle || "me"}"`,
      `FEDI_DOMAIN="${fediDomain}"`,
      `CONTACT_EMAIL="${contactEmail}"`,
      `ADMIN_SECRET="${adminSecret}"`,
      "",
    ];

    const envPath = path.join(process.cwd(), ".env.local");

    let existingContent = "";
    try {
      existingContent = fs.readFileSync(envPath, "utf-8");
    } catch {
      // File doesn't exist yet, that's fine
    }

    // Remove any existing FediHome setup block to avoid duplicates
    const cleaned = existingContent.replace(
      /\n?# === FediHome Setup \(auto-generated\) ===[\s\S]*?(?=\n#|$)/,
      ""
    );

    const finalContent = cleaned.trimEnd() + "\n" + envLines.join("\n");
    fs.writeFileSync(envPath, finalContent, { encoding: "utf-8", mode: 0o600 });

    // Apply the wizard's appearance/feature choices (#59) to the DB-backed site
    // config, so a fresh install is configured with no file editing. Validated
    // + persisted by the same helper the admin panel uses. Best-effort: a bad
    // value is skipped, never blocking the (already-claimed) setup.
    if (body.siteConfig && typeof body.siteConfig === "object") {
      const applied = await applySiteConfig(body.siteConfig);
      if (!applied.ok) console.warn("Setup: skipped invalid site config:", applied.error);
    }

    const response = NextResponse.json({ success: true });

    response.cookies.set("fedihome_setup", "done", {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });

    return response;
  } catch (err) {
    if (err instanceof Error && /forbidden characters|exceeds|must be a string/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Setup error:", err);
    return NextResponse.json(
      { error: "Internal server error during setup." },
      { status: 500 }
    );
  }
}
