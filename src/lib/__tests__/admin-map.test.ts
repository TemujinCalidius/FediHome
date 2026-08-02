import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { ADMIN_GROUPS, ADMIN_DESTINATIONS, searchAdmin } from "@/lib/admin-map";
import { SITE_CONFIG_KEYS } from "@/lib/site-settings";

/**
 * The owner area, described as data (#368).
 *
 * The finding-things problem was real and measurable: a grep for links to
 * `/admin/…` across all of `src/` found them in exactly ONE file — the
 * `/timeline` header — and `/admin` itself returned 404. So an owner who missed
 * that one row of small grey links had no route to Sessions, App activity or
 * Integrations at all.
 *
 * A map is only useful while it is true, which is what most of this file is
 * about. Every anchor is checked against the section ids the settings screen
 * actually generates, and every page against the routes that actually exist —
 * because a dead link on the page whose whole job is navigation is worse than
 * the missing nav was.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

/**
 * The section ids `SiteSettingsClient` really generates.
 *
 * Derived by applying its own transform to its own `section("…")` titles rather
 * than by listing them here — a hand-kept list would be a second thing to keep
 * in sync, which is the problem, not the fix.
 */
function realSectionIds(): Set<string> {
  const src = read("src/app/admin/site/SiteSettingsClient.tsx");
  const ids = new Set<string>();
  for (const m of src.matchAll(/\bsection\("([^"]+)"/g)) {
    ids.add(m[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  }
  return ids;
}

describe("every destination goes somewhere real", () => {
  const ids = realSectionIds();

  it("the settings screen still derives its ids the way the map assumes", () => {
    // If this transform changes, every anchor below silently becomes a link to
    // the top of the page — which LOOKS like it worked.
    expect(read("src/app/admin/site/SiteSettingsClient.tsx")).toContain(
      'id={title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}',
    );
    expect(ids.size).toBeGreaterThan(10);
  });

  it.each(ADMIN_DESTINATIONS.map((d) => d.href))("%s exists", (href) => {
    const [path, anchor] = href.split("#");
    if (anchor) {
      expect(ids.has(anchor), `no section on /admin/site with id "${anchor}"`).toBe(true);
    }
    // Route file, in either the plain or the grouped form the repo uses.
    const candidates = [
      `src/app${path}/page.tsx`,
      `src/app/(public)${path}/page.tsx`,
    ];
    expect(
      candidates.some((c) => existsSync(join(ROOT, c))),
      `no page for ${path} (looked for ${candidates.join(", ")})`,
    ).toBe(true);
  });

  it("has no duplicate label within a group", () => {
    for (const g of ADMIN_GROUPS) {
      const labels = g.items.map((i) => i.label);
      expect(new Set(labels).size, `duplicate label in ${g.title}`).toBe(labels.length);
    }
  });

  it("gives every entry a blurb and at least two keywords", () => {
    // A destination with no keywords is invisible to search, which is the one
    // feature this data exists for.
    for (const d of ADMIN_DESTINATIONS) {
      expect(d.blurb.length, `${d.label} has no blurb`).toBeGreaterThan(10);
      expect(d.keywords.length, `${d.label} has too few keywords`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("searchAdmin", () => {
  it("finds a setting by a word the UI does not use", () => {
    // THE point. "Where do I turn off notifications" is typed by someone who has
    // never read the word VAPID, and "backup" is what people call an export.
    expect(searchAdmin("vapid")[0].label).toBe("Phone notifications");
    expect(searchAdmin("backup")[0].label).toBe("Export your content");
    expect(searchAdmin("cron")[0].label).toBe("Background jobs");
    expect(searchAdmin("defederate")[0].label).toBe("Blocked accounts");
  });

  it("ranks an exact label above an incidental mention", () => {
    // "storage" appears in more than one blurb; typing it must land on Storage.
    expect(searchAdmin("storage")[0].label).toBe("Storage");
    expect(searchAdmin("sessions")[0].label).toBe("Sessions");
  });

  it("returns nothing for one character, rather than everything", () => {
    // A single letter matches most of the map, and a list of everything is the
    // same as no search at all.
    expect(searchAdmin("a")).toEqual([]);
    expect(searchAdmin(" ")).toEqual([]);
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    expect(searchAdmin("  PUSH  ")[0].label).toBe("Phone notifications");
  });

  it("is bounded, so a common word can't render the whole map", () => {
    expect(searchAdmin("e", 8).length).toBeLessThanOrEqual(8);
    expect(searchAdmin("your", 3).length).toBeLessThanOrEqual(3);
  });

  it("does not do fuzzy matching", () => {
    // Deliberate: on a list this small, fuzzy produces confident nonsense, and
    // an owner who typed three characters and got the wrong page trusts the box
    // less than one who got nothing.
    expect(searchAdmin("zzzz")).toEqual([]);
  });
});

describe("the map covers what the settings screen actually offers", () => {
  it("names every top-level settings area, not a favourites list", () => {
    // Not one entry per KEY — the map is about places, and 50-odd controls
    // listed individually would be the wall of text it replaces. But a whole
    // SECTION missing means a set of settings nobody can find from here.
    const ids = realSectionIds();
    const linked = new Set(
      ADMIN_DESTINATIONS.map((d) => d.href.split("#")[1]).filter(Boolean) as string[],
    );
    const missing = [...ids].filter((id) => !linked.has(id));
    expect(missing, `settings sections absent from the admin map: ${missing.join(", ")}`).toEqual([]);
  });

  it("still knows about every editable setting key, indirectly", () => {
    // A sanity check on the premise rather than on the map: if the settings
    // screen ever stops being the place these live, this file needs revisiting.
    expect(SITE_CONFIG_KEYS.length).toBeGreaterThan(30);
  });
});

describe("#368 — the navigation exists at all", () => {
  it("/admin is a real page now, not a 404", () => {
    expect(existsSync(join(ROOT, "src/app/admin/page.tsx"))).toBe(true);
  });

  it("the nav is in a LAYOUT, so no admin page can ship without it", () => {
    // The original failure was links living in one file. A layout means adding a
    // seventh page can't reintroduce it.
    const layout = read("src/app/admin/layout.tsx");
    expect(layout).toContain("AdminNav");
  });

  it("the layout draws the nav but does not stand in for page auth", () => {
    // A page that came to rely on a layout for auth would be unprotected the
    // moment it moved. Every page still gates itself.
    const layout = read("src/app/admin/layout.tsx");
    expect(layout).toContain("verifyAdminSession");
    expect(layout).toMatch(/signedIn\s*&&\s*<AdminNav/);
    for (const page of ["apps", "audit", "integrations", "sessions", "settings", "site"]) {
      expect(
        read(`src/app/admin/${page}/page.tsx`),
        `/admin/${page} stopped checking its own session`,
      ).toContain("verifyAdminSession");
    }
  });

  it("the two indistinguishable page names are gone", () => {
    // "Site settings" vs "Instance settings" told you nothing about which held
    // push notifications and which held data retention.
    expect(read("src/app/admin/settings/page.tsx")).not.toContain("Instance settings");
    expect(read("src/app/admin/settings/SettingsClient.tsx")).not.toContain("Instance settings");
  });
});
