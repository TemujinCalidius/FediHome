import { describe, it, expect } from "vitest";
import Tinylytics from "@/components/analytics/Tinylytics";

// The component is a plain server function returning a <Script> element (or null),
// so we can call it directly and inspect the element without a renderer. It now
// takes a resolved `siteCode` prop (#59) — the embed-vs-site-id precedence lives
// in the caller (layout.tsx: `analytics.embedId || analytics.siteId`).
type El = { props: { src: string; strategy: string } } | null;

describe("Tinylytics embed (#170)", () => {
  it("renders nothing when the site code is empty", () => {
    expect(Tinylytics({ siteCode: "" }) as El).toBeNull();
  });

  it("renders the tracking embed keyed by the given site code", () => {
    const el = Tinylytics({ siteCode: "abc123" }) as El;
    expect(el?.props.src).toBe("https://tinylytics.app/embed/abc123.js");
    expect(el?.props.strategy).toBe("afterInteractive");
  });

  it("url-encodes the site code", () => {
    expect((Tinylytics({ siteCode: "a b/c" }) as El)?.props.src).toBe("https://tinylytics.app/embed/a%20b%2Fc.js");
  });
});
