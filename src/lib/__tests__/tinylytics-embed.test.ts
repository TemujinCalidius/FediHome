import { describe, it, expect, beforeEach } from "vitest";
import Tinylytics from "@/components/analytics/Tinylytics";

// The component is a plain server function returning a <Script> element (or null),
// so we can call it directly and inspect the element without a renderer.
type El = { props: { src: string; strategy: string } } | null;

beforeEach(() => {
  delete process.env.TINYLYTICS_SITE_ID;
  delete process.env.TINYLYTICS_EMBED_ID;
});

describe("Tinylytics embed (#170)", () => {
  it("renders nothing when unconfigured", () => {
    expect(Tinylytics() as El).toBeNull();
  });

  it("renders the tracking embed keyed by the site id when configured", () => {
    process.env.TINYLYTICS_SITE_ID = "abc123";
    const el = Tinylytics() as El;
    expect(el?.props.src).toBe("https://tinylytics.app/embed/abc123.js");
    expect(el?.props.strategy).toBe("afterInteractive");
  });

  it("prefers TINYLYTICS_EMBED_ID over the API site id", () => {
    process.env.TINYLYTICS_SITE_ID = "site-id";
    process.env.TINYLYTICS_EMBED_ID = "embed-code";
    expect((Tinylytics() as El)?.props.src).toBe("https://tinylytics.app/embed/embed-code.js");
  });

  it("url-encodes the site code", () => {
    process.env.TINYLYTICS_SITE_ID = "a b/c";
    expect((Tinylytics() as El)?.props.src).toBe("https://tinylytics.app/embed/a%20b%2Fc.js");
  });
});
