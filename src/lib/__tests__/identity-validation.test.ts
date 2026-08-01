import { describe, it, expect } from "vitest";
import { siteUrlShape, HANDLE_RE, DOMAIN_RE } from "@/lib/identity-store";

/**
 * #431. clean() checked type, non-empty, length and whitespace — while
 * validateSiteUrl lived in the admin ROUTE. So a row written by anything else (a
 * manual psql edit, a restore, a migration, a script) flowed straight into
 * getIdentity().siteUrl, and from there into the actor id, the keyId and every
 * published post's apId.
 *
 * The module's own docstring already claimed clean() existed to "reject junk so
 * a bad row can't produce a malformed actor id". It just didn't reject enough.
 */
describe("siteUrlShape", () => {
  it("accepts a bare origin", () => {
    expect(siteUrlShape("https://example.com")).toBe("https://example.com");
    expect(siteUrlShape("https://example.com/")).toBe("https://example.com");
  });

  it("rejects the exact value from the issue", () => {
    // "not a url" produced an actor id of "not a url/ap/actor", published.
    expect(siteUrlShape("not a url")).toBeUndefined();
  });

  it("rejects a non-http scheme", () => {
    for (const v of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com"]) {
      expect(siteUrlShape(v), v).toBeUndefined();
    }
  });

  it("rejects embedded credentials", () => {
    expect(siteUrlShape("https://user:pw@example.com")).toBeUndefined();
  });

  it("rejects anything past the origin", () => {
    // The actor id is built by appending, so a path would produce
    // "https://example.com/foo/ap/actor".
    for (const v of ["https://example.com/foo", "https://example.com/?a=1", "https://example.com/#x"]) {
      expect(siteUrlShape(v), v).toBeUndefined();
    }
  });

  it("normalises away a default port, so two spellings can't disagree", () => {
    expect(siteUrlShape("https://example.com:443")).toBe("https://example.com");
  });

  it("keeps a non-default port, which a self-hoster genuinely uses", () => {
    expect(siteUrlShape("https://example.com:8443")).toBe("https://example.com:8443");
  });

  it("still accepts localhost — the LOAD path must not second-guess a dev", () => {
    // Reachability belongs to what an operator may SET, not to what we load. A
    // developer pointing an instance at localhost by hand has done something
    // deliberate, and silently reverting to the environment with nothing in the
    // logs is the same unexplained behaviour #431 is trying to remove.
    expect(siteUrlShape("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("handle and domain rules are shared with the route", () => {
  it("accepts ordinary values", () => {
    expect(HANDLE_RE.test("me")).toBe(true);
    expect(DOMAIN_RE.test("example.com")).toBe(true);
    expect(DOMAIN_RE.test("sub.example.co.uk")).toBe(true);
  });

  it("rejects a handle with anything that would break an @address", () => {
    for (const v of ["a b", "me@you", "with/slash", ""]) {
      expect(HANDLE_RE.test(v), v).toBe(false);
    }
  });

  it("rejects a domain with no TLD, or with a scheme attached", () => {
    for (const v of ["localhost", "https://example.com", "example"]) {
      expect(DOMAIN_RE.test(v), v).toBe(false);
    }
  });
});
