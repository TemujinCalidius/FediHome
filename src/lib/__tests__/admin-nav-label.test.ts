import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #367. The owner-facing nav link read "Fedi Feed" and pointed at /timeline —
 * which has seven tabs, of which the Fediverse feed is one. The others are DMs,
 * comment moderation, the blocklist, the social graph and analytics.
 *
 * It also matters more than a label usually would: that header is the ONLY way
 * into the entire owner area. Site settings, Instance settings, Integrations,
 * Connected apps, App activity and Sessions are reachable from nowhere else, so
 * mislabelling it is why the owner area is hard to find at all.
 */
const NAVS = [
  "src/components/layout/Navbar.tsx",
  "src/components/layout/HeaderCentered.tsx",
  "src/components/layout/MobileMenu.tsx",
];

describe("the owner nav link is named for what it opens (#367)", () => {
  for (const file of NAVS) {
    it(`${file} no longer calls it a feed`, () => {
      expect(read(file)).not.toContain("Fedi Feed");
    });
  }

  it("all three renderings agree", () => {
    // Three components render the same link. Two saying "Admin" and one still
    // saying something else is worse than the original, because the owner then
    // can't tell they're the same destination.
    for (const file of NAVS) {
      // Whitespace-insensitive: the three components indent differently, and a
      // test that breaks on indentation stops being about the label.
      expect(read(file), `${file} is missing the label`).toMatch(/>\s*Admin\s*</);
    }
  });

  it("still points at /timeline, so nothing breaks", () => {
    // Deliberately a label-only change. The route can move when the owner area
    // gets a proper home (#368); until then, changing it would break every
    // bookmark for no gain.
    for (const file of NAVS) {
      expect(read(file)).toContain('href="/timeline"');
    }
  });
});
