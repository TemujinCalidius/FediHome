import { NextResponse } from "next/server";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as fs from "fs";
import * as path from "path";
import { verifyAdmin } from "@/lib/auth";
import { applySiteConfig } from "@/lib/site-settings";
import { verifySetupToken } from "@/lib/setup-token";
import { validateImagePath } from "@/lib/media";

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

/** A caller-fixable validation failure — mapped to 400, never a 500. */
class SetupValidationError extends Error {}

/**
 * Best-effort "are we inside a container?" check (#308).
 *
 * It matters here because the wizard writes `.env.local` to `process.cwd()` —
 * i.e. INSIDE the container — while docker-compose loads `env_file: .env.local`
 * from the HOST. They are different files. So on the next restart the container
 * reads the host copy, which has no ADMIN_SECRET, while `setupDone: true` is
 * already recorded in Postgres and survives. `/api/setup` then refuses with
 * "Setup has already been completed" and the owner is locked out of admin.
 *
 * We can't fix that from in here — the host file isn't writable from the
 * container — so the honest move is to tell the operator, loudly, while they
 * still have the secret on screen.
 */
function isContainerised(): boolean {
  try {
    if (fs.existsSync("/.dockerenv")) return true;
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8");
    return /docker|containerd|kubepods/i.test(cgroup);
  } catch {
    return false; // no /proc (macOS/Windows) → assume bare metal
  }
}

function validateField(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new SetupValidationError(`${name} must be a string`);
  }
  if (value.length > MAX_FIELD_LEN) {
    throw new SetupValidationError(`${name} exceeds ${MAX_FIELD_LEN} chars`);
  }
  if (FORBIDDEN_FIELD_CHARS.test(value)) {
    throw new SetupValidationError(`${name} contains forbidden characters`);
  }
  return value;
}

/**
 * Validate the canonical public origin. `SITE_URL` is baked into ActivityPub
 * ids, WebFinger, signature keyIds, RSS and CSRF checks — and once setup
 * completes the wizard is unreachable (proxy redirects away), so a bad value is
 * only fixable by hand-editing `.env.local`. Require a clean http(s) ORIGIN:
 * real host, no credentials, no path/query/fragment. Returns the normalized
 * origin (trailing slash dropped) plus the host used for `FEDI_DOMAIN`.
 */
function validateSiteUrl(raw: unknown): { siteUrl: string; host: string } {
  const value = validateField("siteUrl", raw).trim();
  if (!value) throw new SetupValidationError("siteUrl is required");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new SetupValidationError("siteUrl must be a valid absolute URL, e.g. https://example.com");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SetupValidationError("siteUrl must start with http:// or https://");
  }
  if (!u.hostname) throw new SetupValidationError("siteUrl must include a hostname");
  if (u.username || u.password) throw new SetupValidationError("siteUrl must not contain credentials");
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) {
    throw new SetupValidationError("siteUrl must be a bare origin — no path, query or fragment");
  }
  return { siteUrl: u.origin, host: u.host };
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
      if (!(await verifySetupToken(body.setupToken))) {
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

    // Optional avatar/banner (#59) — paths from a prior setup-token-gated upload.
    // Validate before the claim; a bad path is a 400, not a silent skip.
    let avatarPath: string | undefined;
    let bannerPath: string | undefined;
    if (typeof body.avatarPath === "string" && body.avatarPath.trim()) {
      const v = validateImagePath(body.avatarPath);
      if (!v) return NextResponse.json({ error: "Invalid avatar image path." }, { status: 400 });
      avatarPath = v;
    }
    if (typeof body.bannerPath === "string" && body.bannerPath.trim()) {
      const v = validateImagePath(body.bannerPath);
      if (!v) return NextResponse.json({ error: "Invalid banner image path." }, { status: 400 });
      bannerPath = v;
    }
    const imageData = { ...(avatarPath ? { avatarPath } : {}), ...(bannerPath ? { bannerPath } : {}) };

    // Resolve + validate EVERYTHING before claiming the setup slot. This used to
    // happen after the claim, which meant a bad siteUrl (or an unwritable
    // .env.local) left `setupDone=true` with NO ADMIN_SECRET written — the proxy
    // then redirects to /setup forever while /api/setup 403s "already completed",
    // bricking the install with no file-free recovery.
    // Prefer the value the wizard submitted (correct protocol AND port), then any
    // configured SITE_URL, then the request origin.
    const { siteUrl, host: fediDomain } = validateSiteUrl(
      body.siteUrl || process.env.SITE_URL || new URL(request.url).origin
    );

    // Build .env.local content. All field values were validated above to
    // contain no newlines / quotes / dollar / backtick, so this construction
    // is injection-safe. Pure string work — no I/O yet.
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
          ...imageData,
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
          ...imageData,
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

    // Write .env.local. If this fails the claim above is already recorded, which
    // would leave the instance with setupDone=true and no ADMIN_SECRET — bricked.
    // So roll the claim back and let the operator retry. (Reopening the
    // first-claim window is correct here: the write failed, so there is no admin
    // secret to protect yet, and bricking is strictly worse.)
    try {
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
    } catch (writeErr) {
      console.error("Setup: failed to write .env.local — rolling back the setup claim:", writeErr);
      try {
        await prisma.siteSettings.updateMany({ where: { id: "main" }, data: { setupDone: false } });
      } catch (rollbackErr) {
        console.error("Setup: ROLLBACK FAILED — setupDone is stuck true, fix .env.local manually:", rollbackErr);
      }
      return NextResponse.json(
        {
          error:
            "Couldn't write .env.local — check that the install directory is writable, then run setup again.",
        },
        { status: 500 }
      );
    }

    // Apply the wizard's appearance/feature choices (#59) to the DB-backed site
    // config, so a fresh install is configured with no file editing. Validated
    // + persisted by the same helper the admin panel uses. Best-effort: a bad
    // value is skipped, never blocking the (already-claimed) setup.
    if (body.siteConfig && typeof body.siteConfig === "object") {
      const applied = await applySiteConfig(body.siteConfig);
      if (!applied.ok) console.warn("Setup: skipped invalid site config:", applied.error);
    }

    // In a container the .env.local we just wrote is NOT the file compose reads
    // on the next start (#308) — surface that while the secret is still on screen.
    const containerised = isContainerised();
    if (containerised) {
      console.warn(
        "\n[FediHome] Setup ran inside a container. ADMIN_SECRET was written to .env.local " +
          "*inside* the container, but docker-compose reads .env.local from the HOST. " +
          "Add ADMIN_SECRET to the host's .env.local now, or you'll be locked out of admin " +
          "the next time the container is replaced.\n",
      );
    }

    const response = NextResponse.json({ success: true, containerised });

    response.cookies.set("fedihome_setup", "done", {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });

    return response;
  } catch (err) {
    // Caller-fixable input problems (incl. a malformed siteUrl, which previously
    // fell through to a confusing 500) are 400s.
    if (err instanceof SetupValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Setup error:", err);
    return NextResponse.json(
      { error: "Internal server error during setup." },
      { status: 500 }
    );
  }
}
