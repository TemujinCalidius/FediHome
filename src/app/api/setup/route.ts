import { NextResponse } from "next/server";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as fs from "fs";
import * as path from "path";
import { verifyAdmin } from "@/lib/auth";

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

export async function POST(request: Request) {
  try {
    // C6: if ADMIN_SECRET is already configured, this endpoint must require
    // admin auth. Otherwise an attacker who can reach the box (DB wiped,
    // initial deploy, snapshot restore) can re-setup and take over.
    if (process.env.ADMIN_SECRET) {
      if (!verifyAdmin(request as Request & { cookies: { get(name: string): { value: string } | undefined } })) {
        return NextResponse.json(
          { error: "Setup is locked; admin authentication required." },
          { status: 401 }
        );
      }
    }

    const body = await request.json();
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
    const siteUrl =
      process.env.SITE_URL ||
      `https://${new URL(request.url).hostname}`;
    const fediDomain = validateField("siteUrlHost", new URL(siteUrl).hostname);

    const envLines = [
      "",
      "# === FediHome Setup (auto-generated) ===",
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
