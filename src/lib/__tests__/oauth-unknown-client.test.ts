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
  const start = src.indexOf("const client = await resolveClient(p.clientId, rateKey);");
  const msg = src.slice(start, src.indexOf("validateRedirectUri", start));

  it("no longer says only 'Unknown application'", () => {
    expect(src).not.toContain('error: "Unknown application (client_id)."');
  });

  it("says why verification failed, rather than implying a malformed id", () => {
    // The actual reason. Reworded once URL client ids landed (#494): "isn't
    // registered" became wrong for the commonest case, since a web client is
    // never registered and is not supposed to be — it failed because its address
    // wasn't reachable or didn't list the redirect.
    expect(msg).toMatch(/couldn't be verified/);
    expect(msg).toMatch(/fetching its client ID/);
  });

  it("distinguishes the two kinds of client, since the fix differs (#494)", () => {
    // A web app is fixed on the app's side (make the address reachable, list the
    // redirect); a custom-scheme app can only be fixed here, by registering it.
    // One message for both would send half the readers to the wrong place.
    expect(msg).toMatch(/custom link scheme/);
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
