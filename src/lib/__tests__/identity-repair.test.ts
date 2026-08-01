import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

/**
 * #447. #426 fixed the recoverable half — an unpublished instance can repair a
 * wrong SITE_URL from the panel. Once anything is published the route 409s
 * forever and there is no in-app path, so the two halves here are the script
 * that provides one, and the log that tells an owner what is actually wrong.
 */

describe("verifyOrigin explains a SITE_URL mismatch (#447)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const load = async (siteUrl: string) => {
    vi.resetModules();
    warn.mockClear();
    vi.doMock("@/lib/identity", () => ({ getSiteUrl: () => siteUrl }));
    return import("@/lib/auth");
  };
  const req = (origin: string | null, referer?: string) =>
    ({ headers: { get: (n: string) => (n === "origin" ? origin : (referer ?? null)) } });

  afterEach(() => vi.doUnmock("@/lib/identity"));

  it("still returns false — it reports, it does not decide", async () => {
    const { verifyOrigin } = await load("https://right.example");
    expect(verifyOrigin(req("https://wrong.example"))).toBe(false);
  });

  it("names BOTH addresses, so the owner can see which one is the typo", async () => {
    const { verifyOrigin } = await load("https://right.example");
    verifyOrigin(req("https://wrong.example"));
    const msg = warn.mock.calls[0]?.[0] ?? "";
    expect(msg).toContain("https://wrong.example");
    expect(msg).toContain("https://right.example");
  });

  it("points at the escape hatch for an instance the panel already refuses", async () => {
    const { verifyOrigin } = await load("https://right.example");
    verifyOrigin(req("https://wrong.example"));
    expect(warn.mock.calls[0]?.[0]).toContain("scripts/set-identity.ts");
  });

  it("logs once per pair — a 403'd panel retries", async () => {
    const { verifyOrigin } = await load("https://right.example");
    for (let i = 0; i < 5; i++) verifyOrigin(req("https://wrong.example"));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs again for a DIFFERENT mismatching origin", async () => {
    const { verifyOrigin } = await load("https://right.example");
    verifyOrigin(req("https://wrong.example"));
    verifyOrigin(req("https://other.example"));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the origin matches", async () => {
    const { verifyOrigin } = await load("https://right.example");
    expect(verifyOrigin(req("https://right.example"))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing when there is no Origin or Referer at all", async () => {
    // A non-browser caller is not a misconfiguration, and would otherwise fill
    // the log with noise that has nothing to do with SITE_URL.
    const { verifyOrigin } = await load("https://right.example");
    expect(verifyOrigin(req(null))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("survives an unparseable Origin without throwing", async () => {
    const { verifyOrigin } = await load("https://right.example");
    expect(verifyOrigin(req("not a url"))).toBe(false);
  });

  it("falls back to Referer, and explains that mismatch too", async () => {
    const { verifyOrigin } = await load("https://right.example");
    verifyOrigin(req(null, "https://wrong.example/admin/site"));
    expect(warn.mock.calls[0]?.[0]).toContain("https://wrong.example");
  });
});

describe("scripts/set-identity.ts — the escape hatch (#447)", () => {
  const src = readFileSync(join(ROOT, "scripts/set-identity.ts"), "utf8");

  it("refuses to act on a published instance without an explicit flag", () => {
    expect(src).toContain("orphan-published");
    expect(src).toMatch(/Refusing to continue/);
  });

  it("writes to the database, not to a file", () => {
    // The whole reason it exists: on a PaaS the filesystem is rebuilt every
    // deploy, so an .env.local edit silently reverts. The override is durable.
    expect(src).toContain("prisma.siteSetting.upsert");
    expect(src).not.toMatch(/writeFile|\.env\.local['"]/);
  });

  it("counts the lock itself rather than importing identityIsLocked", () => {
    // The library version reads through the identity overlay, which is exactly
    // what is wrong when someone runs this.
    // Referring to either in a comment is fine and useful; IMPORTING is the bug.
    const imports = src.match(/^import .*$/gm)?.join("\n") ?? "";
    expect(imports).not.toMatch(/identity-store|identityIsLocked/);
    expect(src).toContain("prisma.fediFollower.count");
  });

  it("reports the numbers, not just a verdict", () => {
    // If a lockable category is added later this under-reports; printing the
    // counts means an operator can still see what they are about to orphan.
    for (const line of ["published item(s)", "follow you at the current address", "you follow recorded"]) {
      expect(src).toContain(line);
    }
  });

  it("normalises the host, so it can't reintroduce #427", () => {
    // A capital letter in the domain made the whole instance invisible.
    expect(src).toContain("toLowerCase()");
  });

  it("rejects a URL with a path, query or fragment", () => {
    expect(src).toMatch(/must be an origin with no path/);
  });

  it("tells the operator to restart — overrides load once at boot", () => {
    expect(src).toMatch(/RESTART THE APP/);
  });
});
