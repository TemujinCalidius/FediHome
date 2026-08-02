import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #269. The public and own feeds honour `layout.feed`; /timeline — the owner's
 * private, interactive feed — was the one surface that ignored it. It was
 * deferred from #267 because it has its own client-side card with like/boost/
 * reply, not the shared PostFeed.
 */
describe("the admin timeline honours layout.feed (#269)", () => {
  const page = read("src/app/timeline/page.tsx");
  const client = read("src/app/timeline/TimelineClient.tsx");

  it("resolves the variant the same way the public feeds do", () => {
    expect(page).toContain("resolveLayout(");
    expect(page).toContain("feedVariant={feedVariant}");
  });

  it("resolves the site config once, not per use", () => {
    // Two awaits of the same cached getter is harmless and still wrong — it
    // reads as if they could differ.
    expect((page.match(/await getRuntimeSiteConfig\(\)/g) ?? []).length).toBe(1);
  });

  it("defaults to cards, so an instance that never set it is unchanged", () => {
    expect(client).toContain('feedVariant = "cards"');
  });
});

describe("what `list` means here, and what it must not cost", () => {
  const client = read("src/app/timeline/TimelineClient.tsx");
  const card = client.slice(client.indexOf("function PostCard("));

  it("KEEPS the interactive actions in the compact variant", () => {
    // The whole point. This is the owner's interactive feed; a denser view that
    // silently removed the ability to act on a post would make the setting a
    // trap rather than a preference. The issue left this open — this is the
    // only reading that doesn't degrade the surface it applies to.
    for (const action of ["liked", "boosted", "setReplyTo"]) {
      const guarded = new RegExp(`!compact && [^\\n]*${action}`);
      expect(card, `${action} must not be hidden by compact`).not.toMatch(guarded);
    }
  });

  it("drops only the tall blocks — media and the link preview", () => {
    expect(card).toMatch(/!compact && post\.mediaUrls\.length > 0/);
    expect(card).toMatch(/!compact && post\.embedUrl/);
  });

  it("leaves the cards path byte-identical apart from one class swap", () => {
    // The variant only ever ADDS a branch. Every `compact` use is either the
    // ternary on the wrapper or a `!compact &&` guard — never a change to what
    // the cards path renders.
    const uses = card.match(/compact[^?&\n]*/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    const wrapper = card.match(/compact \? "glass-card px-4 py-3" : "glass-card p-5"/);
    expect(wrapper).toBeTruthy();
  });
});
