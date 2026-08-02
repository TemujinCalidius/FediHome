import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #486. layout.tsx emits the full IndieAuth discovery contract on every page,
 * and /.well-known/oauth-authorization-server answers — but only three hardcoded
 * client ids can authenticate. So a third-party client finds the endpoints,
 * follows the spec exactly, and is turned away.
 *
 * It fails in the least helpful direction: a client given NO metadata reports
 * "this site doesn't support IndieAuth" and stops. One given full metadata and
 * then a rejection reports a BROKEN site — and nothing in FediHome's logs or
 * admin panel explains it.
 */
describe("the unknown-client rejection names the real constraint (#486)", () => {
  const src = read("src/app/api/oauth/authorize/route.ts");
  // Sliced FORWARD from the guard: `validateRedirectUri` also appears in the
  // import list above it, so an unanchored indexOf yields an empty string — and
  // every assertion against an empty string would fail loudly rather than pass,
  // but for the wrong reason.
  const start = src.indexOf("const client = getClient(p.clientId);");
  const msg = src.slice(start, src.indexOf("validateRedirectUri", start));

  it("no longer says only 'Unknown application'", () => {
    expect(src).not.toContain('error: "Unknown application (client_id)."');
  });

  it("says the instance only accepts its own apps", () => {
    // The actual reason, rather than implying the client_id was malformed.
    expect(msg).toMatch(/only accepts sign-in from its own apps/);
  });

  it("names the workaround an operator can actually take", () => {
    // A hand-generated scoped token (#255) genuinely covers this case, and it is
    // reachable from the panel — so the dead end becomes an action.
    expect(msg).toContain("Admin → Connected apps");
  });

  it("still rejects — this is a message change, not a policy change", () => {
    expect(msg).toContain("ok: false");
  });

  it("the discovery links that cause this are still present", () => {
    // Pinned deliberately: if someone removes them as the other fix for #486,
    // this test failing is the prompt to revisit the message too.
    const layout = read("src/app/layout.tsx");
    for (const rel of ["authorization_endpoint", "token_endpoint", "indieauth-metadata"]) {
      expect(layout).toContain(rel);
    }
  });
});
