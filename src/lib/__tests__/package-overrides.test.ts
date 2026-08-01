import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The `overrides` entries that dedupe a direct dependency must stay in step with
 * that dependency's own range.
 *
 * **Why the overrides exist at all** (commit `caea9f7`, #329/#330): `next` pins
 * `postcss` at exactly `8.4.31` and optionally pins `sharp ^0.34.5`. Without an
 * override, npm installs a *second* nested copy of each — which for postcss
 * reopens advisory #12, and for sharp means a duplicate libvips binary. Neither
 * is visible to `tsc`, the test suite, or `next build`. Deleting these entries
 * looks harmless and isn't.
 *
 * **Why they're explicit ranges rather than `"$name"`** (#451): npm's `$name` form
 * dereferences against the root package of whichever edge is being resolved, and
 * during peer-set resolution that can be a *virtual* root whose manifest has no
 * such entry — so `npm install` without a lockfile dies with
 * `Unable to resolve reference $postcss`. It only reproduced for `postcss`
 * because it has four consumer edges to `sharp`'s one; `$sharp` was the same bug
 * waiting its turn.
 *
 * `$name` bought automatic sync as a side effect. Trading it for correctness means
 * the two ranges can now drift on a bump, and a drifted override silently stops
 * deduping. This test is what replaces that guarantee.
 */

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides: Record<string, string>;
};

describe("package.json overrides", () => {
  it("never reintroduces the $name form that breaks lockfile-free installs", () => {
    const dollar = Object.entries(pkg.overrides).filter(([, v]) => v.startsWith("$"));
    expect(dollar, `these will fail \`npm install\` without a lockfile (#451): ${JSON.stringify(dollar)}`).toEqual([]);
  });

  it("keeps each override in step with the dependency it dedupes", () => {
    const direct = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(pkg.overrides)) {
      if (!(name in direct)) continue; // pure-transitive pin, nothing to match
      expect(range, `overrides.${name} has drifted from dependencies.${name}`).toBe(direct[name]);
    }
  });

  it("still pins the two that would silently duplicate", () => {
    // Named explicitly: an override quietly disappearing is exactly the kind of
    // tidy-up that passes every other check in the repo.
    expect(pkg.overrides.sharp, "sharp override removed — duplicate libvips").toBeTruthy();
    expect(pkg.overrides.postcss, "postcss override removed — reopens advisory #12").toBeTruthy();
  });
});
