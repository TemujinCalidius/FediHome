import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveTinylyticsEmbed } from "@/lib/tinylytics";

// The collecting embed needs the site's `uid`, not the numeric id (which 404s).
// resolveTinylyticsEmbed derives it. Distinct site ids per test avoid the
// module-level uid cache leaking between cases.

const fetchMock = vi.fn();
const OLD_KEY = process.env.TINYLYTICS_API_KEY;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {}); // quiet the unresolved warning
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (OLD_KEY === undefined) delete process.env.TINYLYTICS_API_KEY;
  else process.env.TINYLYTICS_API_KEY = OLD_KEY;
});

const okUid = (uid: string) => ({ ok: true, json: async () => ({ id: 1, uid, url: "https://x" }) });

describe("resolveTinylyticsEmbed (#288)", () => {
  it("uses an explicit embed id verbatim (override) — no API call", async () => {
    expect(await resolveTinylyticsEmbed({ siteId: "3461", embedId: "vGTbspkpj5RT" })).toBe("vGTbspkpj5RT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a non-numeric site id through as the uid — no API call", async () => {
    expect(await resolveTinylyticsEmbed({ siteId: "abc-DEF-1", embedId: "" })).toBe("abc-DEF-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives the uid from the API for a numeric site id when an API key is set", async () => {
    process.env.TINYLYTICS_API_KEY = "tly-key";
    fetchMock.mockResolvedValueOnce(okUid("derived-uid-100"));
    expect(await resolveTinylyticsEmbed({ siteId: "100", embedId: "" })).toBe("derived-uid-100");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/sites/100");
  });

  it("caches the derived uid (a second call does not re-fetch)", async () => {
    process.env.TINYLYTICS_API_KEY = "tly-key";
    fetchMock.mockResolvedValueOnce(okUid("uid-cached-200"));
    expect(await resolveTinylyticsEmbed({ siteId: "200", embedId: "" })).toBe("uid-cached-200");
    expect(await resolveTinylyticsEmbed({ siteId: "200", embedId: "" })).toBe("uid-cached-200");
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
  });

  it("returns null for a numeric site id with no API key — never emits the (404ing) numeric id", async () => {
    delete process.env.TINYLYTICS_API_KEY;
    expect(await resolveTinylyticsEmbed({ siteId: "300", embedId: "" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the API 404s the site id", async () => {
    process.env.TINYLYTICS_API_KEY = "tly-key";
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await resolveTinylyticsEmbed({ siteId: "404", embedId: "" })).toBeNull();
  });

  it("returns null when nothing is configured", async () => {
    expect(await resolveTinylyticsEmbed({ siteId: "", embedId: "" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
