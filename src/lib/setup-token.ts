import crypto from "crypto";
import { prisma } from "./db";
import { safeCompare } from "./auth";

/**
 * First-run setup token (#22). When `ADMIN_SECRET` isn't configured yet (a fresh,
 * possibly publicly-exposed deploy), any first-run write — completing setup, or
 * uploading an avatar during the wizard — requires this out-of-band token so an
 * anonymous visitor can't claim the instance before the owner. Taken from
 * `SETUP_TOKEN` if set; otherwise generated once, stored, and printed to the
 * server console for the operator to copy.
 *
 * Stored as the `setup_token` SiteSetting row, so every caller resolves the same
 * value.
 */
export async function getOrCreateSetupToken(): Promise<string> {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  const existing = await prisma.siteSetting.findUnique({ where: { key: "setup_token" } });
  if (existing) return existing.value;
  const token = crypto.randomBytes(24).toString("hex");
  try {
    await prisma.siteSetting.create({ data: { key: "setup_token", value: token } });
    console.warn(
      `\n[FediHome] First-run setup token — enter this in the setup wizard to complete setup:\n          ${token}\n`,
    );
    return token;
  } catch {
    // Lost a race to create it — read whoever won.
    const again = await prisma.siteSetting.findUnique({ where: { key: "setup_token" } });
    return again?.value ?? token;
  }
}

/** Constant-time check of a provided setup token against the expected one. */
export async function verifySetupToken(provided: unknown): Promise<boolean> {
  if (typeof provided !== "string" || !provided) return false;
  const expected = await getOrCreateSetupToken();
  return safeCompare(provided, expected);
}
