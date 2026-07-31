import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `verifySameOriginRequest` stays on exactly three routes.
 *
 * It is deliberately WEAKER than `verifyOrigin`: it asks "is this same-origin?",
 * not "is this to the address I think I am". A hostname an attacker owns, pointed
 * at this server's IP and served by our catch-all vhost, is same-origin to the
 * browser and passes it. `verifyOrigin` rejects that; this does not.
 *
 * That is affordable on the three routes below ONLY because each checks a
 * credential FIRST — an admin cookie scoped to the real hostname, or an
 * out-of-band setup token — neither of which travels to the attacker's host. On a
 * route with no credential (`/api/comments`, `/api/kudos`) it would be a genuine
 * widening: guest-comment and kudos spam driven through real visitors' browsers
 * and real residential IPs, which defeats the rate limiter far better than a
 * script does.
 *
 * So the failure mode this test exists to prevent is somebody hitting a confusing
 * 403 in six months and "fixing" it by swapping the helper in. Prose in a docstring
 * does not stop that; a failing test does.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

/** The only routes allowed to use the relaxed check, and why. */
const ALLOWED = [
  "src/app/api/admin/identity/route.ts", // #426 — repairs a wrong SITE_URL
  "src/app/api/setup/route.ts", //          #430 — SITE_URL isn't written yet
  "src/app/api/setup/media/route.ts", //    #430 — same, the wizard's uploader
];

/** Every .ts/.tsx under src/, excluding tests and generated code. */
function sourceFiles(dir = join(ROOT, "src"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "generated") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full.slice(ROOT.length + 1));
    }
  }
  return out;
}

describe("the relaxed origin check is contained", () => {
  it("is used by exactly the three routes that need it", () => {
    const users = sourceFiles()
      .filter((f) => f !== "src/lib/auth.ts")
      .filter((f) => /\bverifySameOriginRequest\b/.test(read(f)));
    expect(users.sort()).toEqual([...ALLOWED].sort());
  });

  it("is NEVER used by an unauthenticated public endpoint", () => {
    // Named explicitly rather than inferred: these two have no credential in
    // front of them, so the relaxed check would be their only gate.
    for (const rel of ["src/app/api/comments/route.ts", "src/app/api/kudos/route.ts"]) {
      const src = read(rel);
      expect(src, `${rel} must keep verifyOrigin`).toContain("verifyOrigin");
      expect(src, `${rel} must not use the relaxed check`).not.toContain("verifySameOriginRequest");
    }
  });

  it("runs AFTER the credential check on every route that uses it", () => {
    // The ordering IS the security argument. verifyOrigin's own call sites check
    // origin first, which is correct for them; here it must be second, because a
    // request from an attacker-owned hostname carries no admin cookie and no
    // setup token — so the credential is what actually rejects it.
    for (const rel of ALLOWED) {
      const src = read(rel);
      const relaxed = src.indexOf("verifySameOriginRequest(");
      const credential = Math.min(
        ...[src.indexOf("verifyAdmin("), src.indexOf("verifySetupToken(")].filter((i) => i >= 0),
      );
      expect(relaxed, `${rel}: no verifySameOriginRequest call`).toBeGreaterThan(-1);
      expect(credential, `${rel}: no credential check at all`).toBeLessThan(Infinity);
      expect(credential, `${rel}: credential check must come FIRST`).toBeLessThan(relaxed);
    }
  });

  it("leaves verifyOrigin guarding everything else", () => {
    // It protects 20+ routes. A regression that quietly swapped them all would
    // otherwise pass every other test in the suite.
    const guarded = sourceFiles().filter(
      (f) => f !== "src/lib/auth.ts" && /\bverifyOrigin\b/.test(read(f)),
    );
    expect(guarded.length).toBeGreaterThanOrEqual(15);
  });
});
