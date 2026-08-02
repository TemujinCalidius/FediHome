import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SITE_CONFIG_KEYS } from "@/lib/site-settings";

/**
 * #495. Every editable setting must actually be sent when the owner presses Save.
 *
 * The settings screen builds an EXPLICIT key→value map rather than deriving one
 * from `SITE_CONFIG_FIELDS`, so a field can be fully wired on screen — bound to
 * `cfg`, updating local state as you type, showing the new value — and still be
 * absent from the payload. Nothing fails: the request succeeds, the green
 * "Saved" message appears, and the value is gone on the next render.
 *
 * That is exactly what happened to `storage.fediCacheMb`, where the input and
 * the entire read path shipped in one commit (#364) and the save key was
 * overlooked. `0` in that box is the operator saying "don't copy other people's
 * images onto my disk", so being told it saved when it didn't is the worst
 * version of the failure.
 *
 * Asserted structurally rather than per field: a source scan of the two lists is
 * what makes a NEW field that nobody wired up fail on the next run, instead of
 * shipping as a dead input for however long it takes someone to notice.
 */

const ROOT = process.cwd();
const CLIENT = "src/app/admin/site/SiteSettingsClient.tsx";
const src = readFileSync(join(ROOT, CLIENT), "utf-8");

/**
 * Keys deliberately NOT on this screen, each with the screen that does own it.
 * Kept short and named on purpose — an allowlist that grows without a reason
 * beside each entry is how the rule above stops meaning anything.
 */
const EDITED_ELSEWHERE: Record<string, string> = {
  // Serving /.well-known/atproto-did is a Bluesky decision, so it lives with the
  // Bluesky credentials: src/app/api/admin/integrations/route.ts.
  "bluesky.domainHandle": "/admin/integrations",
};

/** The literal map passed to post() in save(). */
function saveMap(): string {
  const start = src.indexOf("const settings: Record<string, string> = {");
  expect(start, `${CLIENT}: could not find the save() payload map`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("const okConfig", start));
}

/** The array of keys cleared by "Use defaults". */
function clearList(): string {
  const start = src.indexOf("const useDefaults");
  expect(start, `${CLIENT}: could not find useDefaults()`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("].map((k) => [k, null])", start));
}

describe("#495 — every editable setting is actually saved", () => {
  const owned = SITE_CONFIG_KEYS.filter((k) => !(k in EDITED_ELSEWHERE));

  it.each(owned)("%s is in the save payload", (key) => {
    expect(
      saveMap().includes(`"${key}"`),
      `${key} is declared editable but is missing from ${CLIENT}'s save() map — ` +
        `the field will look like it saved and silently won't`,
    ).toBe(true);
  });

  it.each(owned)("%s is cleared by Use defaults", (key) => {
    expect(
      clearList().includes(`"${key}"`),
      `${key} is missing from ${CLIENT}'s useDefaults() list — "Use defaults" ` +
        `would leave a stale override in place for this field alone`,
    ).toBe(true);
  });

  it("the allowlist names only keys this screen genuinely doesn't render", () => {
    // A key parked here to silence the check above, while still being editable on
    // this screen, would reintroduce the bug under cover of the exemption.
    for (const [key, where] of Object.entries(EDITED_ELSEWHERE)) {
      expect(SITE_CONFIG_KEYS, `${key} is allowlisted but is not a setting`).toContain(key);
      expect(
        saveMap().includes(`"${key}"`),
        `${key} is allowlisted as belonging to ${where} but IS in this screen's save map`,
      ).toBe(false);
    }
  });

  it("the cache budget specifically — the field that was missing", () => {
    // Named separately from the sweep so the regression reads as a regression.
    expect(saveMap()).toContain('"storage.fediCacheMb"');
    expect(clearList()).toContain('"storage.fediCacheMb"');
  });
});
