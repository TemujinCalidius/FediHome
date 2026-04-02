import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

export async function POST(request: Request) {
  try {
    // Check if setup is already done
    const existing = await prisma.siteSettings.findUnique({
      where: { id: "main" },
    });

    if (existing?.setupDone) {
      return NextResponse.json(
        { error: "Setup has already been completed." },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      siteName,
      authorName,
      authorTagline,
      fediHandle,
      contactEmail,
      adminSecret,
    } = body;

    // Validate admin secret was provided (generated client-side)
    if (!adminSecret || adminSecret.length < 64) {
      return NextResponse.json(
        { error: "Invalid admin secret." },
        { status: 400 }
      );
    }

    // Generate a server-side admin secret for hashing/storage
    // We use the client-provided one since user has already copied it
    const serverSecret = adminSecret;

    // Create or update SiteSettings
    await prisma.siteSettings.upsert({
      where: { id: "main" },
      create: {
        id: "main",
        setupDone: true,
        siteName: siteName || "My FediHome",
        authorName: authorName || "Your Name",
        authorTagline: authorTagline || "",
        contactEmail: contactEmail || "",
      },
      update: {
        setupDone: true,
        siteName: siteName || "My FediHome",
        authorName: authorName || "Your Name",
        authorTagline: authorTagline || "",
        contactEmail: contactEmail || "",
      },
    });

    // Build .env.local content
    const siteUrl =
      process.env.SITE_URL ||
      `https://${new URL(request.url).hostname}`;

    const envLines = [
      "",
      "# === FediHome Setup (auto-generated) ===",
      `SITE_NAME="${(siteName || "My FediHome").replace(/"/g, '\\"')}"`,
      `AUTHOR_NAME="${(authorName || "Your Name").replace(/"/g, '\\"')}"`,
      `AUTHOR_TAGLINE="${(authorTagline || "").replace(/"/g, '\\"')}"`,
      `FEDI_HANDLE="${(fediHandle || "me").replace(/"/g, '\\"')}"`,
      `FEDI_DOMAIN="${new URL(siteUrl).hostname}"`,
      `CONTACT_EMAIL="${(contactEmail || "").replace(/"/g, '\\"')}"`,
      `ADMIN_SECRET="${serverSecret}"`,
      "",
    ];

    const envPath = path.join(process.cwd(), ".env.local");

    // Read existing content, append if exists, or create new
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
    fs.writeFileSync(envPath, finalContent, "utf-8");

    // Set cookie to indicate setup is done
    const response = NextResponse.json({
      success: true,
    });

    response.cookies.set("fedihome_setup", "done", {
      path: "/",
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      // Long-lived — 10 years
      maxAge: 60 * 60 * 24 * 365 * 10,
    });

    return response;
  } catch (err) {
    console.error("Setup error:", err);
    return NextResponse.json(
      { error: "Internal server error during setup." },
      { status: 500 }
    );
  }
}
