import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeHtml } from "@/lib/sanitize";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #481. marked renders `---` as <hr>, and every publishing path pairs marked
 * with sanitizeHtml — which did not allow `hr`. So the commonest divider in
 * hand-written markdown was stripped after rendering, in article bodies and in
 * imports, reading as a theme choice rather than a bug.
 */
describe("horizontal rules survive sanitisation (#481)", () => {
  it("keeps an <hr>", () => {
    expect(sanitizeHtml("<p>a</p><hr><p>b</p>")).toContain("<hr");
  });

  it("keeps the tag marked actually emits", async () => {
    // Asserted against marked's real output rather than a hand-written string,
    // so a change in how it renders `---` fails here rather than silently.
    const { marked } = await import("marked");
    const html = (await marked.parse("a\n\n---\n\nb")) as string;
    expect(html).toContain("<hr");
    expect(sanitizeHtml(html)).toContain("<hr");
  });

  it("still strips what it is there to strip", () => {
    // The allowlist widening must not have become a general loosening.
    expect(sanitizeHtml('<script>alert(1)</script><p>ok</p>')).not.toContain("script");
    expect(sanitizeHtml('<hr onclick="x()">')).not.toContain("onclick");
  });
});

/**
 * #480. contact.email is editable in the panel and getRuntimeSiteConfig resolves
 * it database-over-env — but the DEFAULT footer and /about read the env value
 * directly, so on a stock install the panel changed nothing a visitor could see.
 */
describe("contact address comes from the runtime config (#480)", () => {
  const CONSUMERS = [
    "src/components/layout/Footer.tsx",
    "src/app/(public)/about/page.tsx",
    "src/components/layout/FooterColumns.tsx",
    "src/components/layout/Sidebar.tsx",
  ];

  for (const file of CONSUMERS) {
    it(`${file} does not read the env address`, () => {
      // siteConfig.contactEmail is the build-time env value. The two variants
      // that were already correct get it via getFooterData/getSidebarData.
      expect(read(file)).not.toContain("siteConfig.contactEmail");
    });
  }

  it("the default footer uses the config it already fetched", () => {
    // It called getRuntimeSiteConfig() at the top and then ignored it — the
    // correct value was in scope the whole time.
    const src = read("src/components/layout/Footer.tsx");
    expect(src).toContain("getRuntimeSiteConfig");
    expect(src).toContain("site.contact.email");
  });

  it("/about resolves the runtime config at all", () => {
    const src = read("src/app/(public)/about/page.tsx");
    expect(src).toContain("getRuntimeSiteConfig");
    expect(src).toContain("site.contact.email");
  });
});
