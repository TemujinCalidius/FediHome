import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * `/ap/actor` refuses a handle that isn't ours (#429).
 *
 * The proxy used to rewrite ANY `/users/…` path here for an ActivityPub request,
 * never reading the segment — so the instance answered for handles it does not
 * have, and a crawler enumerating `/users/*` got a valid actor for every guess.
 * The HTML route has always checked (`users/[username]/page.tsx`); the AP path
 * did not, and the asymmetry meant the same URL 404'd in a browser and returned
 * 200 to a federation client.
 *
 * The comparison lives HERE rather than in the proxy on purpose. Identity
 * overrides are process-local and populated once at boot by instrumentation's
 * `register()`, so a proxy calling `getIdentity()` would see `process.env` alone
 * — and an instance whose handle comes from the database would start 404-ing its
 * own actor. That would be a worse bug than the one being fixed.
 */

vi.mock("@/lib/federation", () => ({
  getActorProfile: vi.fn(async () => ({ id: "https://demo.example/ap/actor", type: "Person" })),
}));

import { GET } from "@/app/ap/actor/route";
import { getActorProfile } from "@/lib/federation";

const OLD = { handle: process.env.FEDI_HANDLE, site: process.env.SITE_URL };

const req = (url: string, accept = "application/activity+json") =>
  ({ url, headers: { get: (n: string) => (n.toLowerCase() === "accept" ? accept : null) } }) as Request;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  process.env.FEDI_HANDLE = "samuel";
});

afterAll(() => {
  if (OLD.handle === undefined) delete process.env.FEDI_HANDLE;
  else process.env.FEDI_HANDLE = OLD.handle;
  if (OLD.site === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = OLD.site;
});

describe("handle checking", () => {
  it("serves the actor when the handle is ours", async () => {
    const res = await GET(req("https://demo.example/ap/actor?handle=samuel"));
    expect(res.status).toBe(200);
    expect(getActorProfile).toHaveBeenCalled();
  });

  it("404s a handle that is not ours, without building the document", async () => {
    const res = await GET(req("https://demo.example/ap/actor?handle=somebody-else"));
    expect(res.status).toBe(404);
    expect(getActorProfile).not.toHaveBeenCalled();
  });

  it("still serves /ap/actor asked for directly, with no handle param", async () => {
    // The canonical URL. Every remote server that has ever fetched this actor
    // holds THIS id — breaking it would unfederate the instance.
    const res = await GET(req("https://demo.example/ap/actor"));
    expect(res.status).toBe(200);
  });

  it("follows the configured handle rather than a hardcoded default", async () => {
    process.env.FEDI_HANDLE = "ada";
    expect((await GET(req("https://demo.example/ap/actor?handle=ada"))).status).toBe(200);
    expect((await GET(req("https://demo.example/ap/actor?handle=samuel"))).status).toBe(404);
  });

  it("is case-sensitive, matching the HTML route's comparison", async () => {
    expect((await GET(req("https://demo.example/ap/actor?handle=Samuel"))).status).toBe(404);
  });

  it("rejects an empty handle rather than treating it as absent", async () => {
    expect((await GET(req("https://demo.example/ap/actor?handle="))).status).toBe(404);
  });
});
