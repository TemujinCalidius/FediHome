import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `login-throttle.ts` is the only implementation of admin-login throttling (#531).
 *
 * **Why this is structural and not behavioural.** The private instance's version
 * of this design was compromised by a *second* implementation: `/xmlrpc` carried
 * its own copy of the login limiter writing bare keys into the same store as the
 * reserved global row, so a caller could address that row through the other
 * route and clear a lockout in progress. The test asserting the attack was
 * impossible passed the entire time, because it exercised the throttle's own
 * function rather than the application. A behavioural test cannot catch *a
 * second implementation existing*. A source sweep can, and fails by name.
 *
 * This is the same idiom as `same-origin-call-sites.test.ts` and
 * `ssrf-call-sites.test.ts`: state the property once, and the next copy of it
 * fails on the next run.
 *
 * Note what is NOT asserted: other routes having their own rate limiters is
 * fine and expected — xmlrpc, kudos and the OAuth endpoints all do. What must
 * not exist is a second thing deciding whether an admin LOGIN is allowed, since
 * that is the one limiter whose failure mode is locking the owner out.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

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

const OWNER = "src/lib/login-throttle.ts";
const ROUTE = "src/app/api/admin/login/route.ts";

describe("admin-login throttling has exactly one implementation (#531)", () => {
  it("only login-throttle.ts decides whether a login attempt is allowed", () => {
    const users = sourceFiles()
      .filter((f) => f !== OWNER)
      .filter((f) => /\b(loginBlockedBy|recordLoginFailure|clearLoginAttempts)\b/.test(read(f)));
    expect(users).toEqual([ROUTE]);
  });

  it("the login route keeps no attempt counter of its own", () => {
    // The shape that was there before: a module-level Map keyed on the bare
    // client key. Restoring one — or growing a second beside the module — is the
    // failure this exists to catch.
    const src = read(ROUTE);
    expect(src).not.toMatch(/new Map</);
    expect(src).not.toMatch(/\bMAX_ATTEMPTS\b/);
  });

  it("counts a failure only after a password has been examined", () => {
    // The order is the security property: 429 before the body is parsed, but the
    // counter touched only past the verification. Free requests must cost
    // nothing, or the lockout is available for the price of an empty POST.
    const src = read(ROUTE);
    const verified = src.indexOf("const ok =");
    const counted = src.indexOf("recordLoginFailure(");
    expect(verified).toBeGreaterThan(-1);
    expect(counted).toBeGreaterThan(verified);
  });

  it("the two tiers never share a bucket store", () => {
    // What the private instance's incident turned on. Separate limiter instances
    // are the real separation; the `ip:` prefix keeps it true if they are ever
    // merged. Losing either should be a deliberate act, not a tidy-up.
    const src = read(OWNER);
    expect(src.match(/makeRateLimiter\(/g) ?? []).toHaveLength(2);
    expect(src).toContain("`ip:${key}`");
  });
});
