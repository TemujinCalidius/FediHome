import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every Bluesky login goes through the shared agent, so the configured PDS is
 * actually used (#541).
 *
 * **The bug this replaces.** #449 made the AT Protocol service URL configurable
 * and shipped in v1.25.0 — but its opening premise, *"every Bluesky call in the
 * app goes through that one agent"*, was false when it was written. `bluesky-agent.ts`
 * is *a* shared agent, not *the* agent; most modules predate it and built their
 * own. So the fix landed on one call site and twelve others kept
 * `new BskyAgent({ service: "https://bsky.social" })`, including crossposting.
 * An operator who set `BLUESKY_SERVICE` to their own PDS got reads and likes and
 * no posting — and their app password went to bsky.social in a login that failed.
 *
 * **Why structural and not behavioural.** Nothing in the type system, the tests
 * or the build notices a second `BskyAgent` with a literal host: it compiles, it
 * runs, and on the default configuration it is even correct. There is also no
 * unit test of `crosspostToBluesky`'s body anywhere, so the most important of
 * the twelve was — and still is — uncovered behaviourally. This states the
 * property once, and the thirteenth call site fails on the next run.
 *
 * Same idiom as `ssrf-call-sites.test.ts` and `login-throttle-single-impl.test.ts`.
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

/**
 * The ONE place allowed to build its own agent, and why.
 *
 * `testBlueskyLogin` powers the **Test** button: it logs in as a *candidate*
 * identity — the handle and password the operator has just typed, not the stored
 * ones — against a *candidate* service. Routing it through the shared agent
 * would test the saved configuration rather than the one about to be saved, and
 * would poison the session cache with credentials that may not even be valid.
 */
const ALLOWED = ["src/lib/integrations.ts"];

describe("no call site builds its own Bluesky agent (#541)", () => {
  it("nothing constructs a BskyAgent with a hardcoded host", () => {
    // The exact shape of the bug: a string literal where the service goes.
    const offenders = sourceFiles().filter((f) =>
      /new BskyAgent\(\{\s*service:\s*["'`]https?:\/\//.test(read(f)),
    );
    expect(offenders, "a hardcoded PDS ignores BLUESKY_SERVICE entirely").toEqual([]);
  });

  it("only the Test button constructs an agent at all", () => {
    const builders = sourceFiles()
      .filter((f) => f !== "src/lib/bluesky-agent.ts")
      .filter((f) => /new BskyAgent\(/.test(read(f)));
    expect(builders.sort()).toEqual([...ALLOWED].sort());
  });

  it("nothing outside the shared agent calls login()", () => {
    // A second `login()` is a second session — it bypasses the cache, the
    // concurrency collapsing and the DID capture, whatever host it points at.
    const loggers = sourceFiles()
      .filter((f) => f !== "src/lib/bluesky-agent.ts")
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => /\.login\(/.test(read(f)));
    expect(loggers).toEqual([]);
  });

  it("the shared agent still resolves the service rather than naming one", () => {
    // Losing this line would silently re-hardcode the host for every caller at
    // once, which is a much worse version of the same bug.
    const src = read("src/lib/bluesky-agent.ts");
    expect(src).toContain("const service = await blueskyService();");
    expect(src).toContain("new BskyAgent({ service })");
  });

  it("the in-flight login is keyed, so concurrent callers can't cross identities", () => {
    // A bare promise handed a caller with different credentials the OTHER
    // caller's agent — wrong identity, or wrong PDS, and working. Twelve more
    // callers now share this path.
    const src = read("src/lib/bluesky-agent.ts");
    expect(src).toContain("inFlight.key !== key");
  });
});
