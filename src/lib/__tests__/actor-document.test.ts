import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * The actor document itself — the single most consequential thing this server
 * publishes. Every remote instance reads it to decide who we are, how to reach
 * us, and whether to trust our signatures.
 *
 * Nothing covered it before. These lock down the invariants that fail SILENTLY
 * when broken: the key id must anchor to the actor id (or signature
 * verification fails remotely with nothing in our logs), and `alsoKnownAs` must
 * appear only when set (or a default instance's actor changes shape for no
 * reason) and exactly as stored (or a move verification won't match it).
 */

const { actorKeysFindUnique, siteSettingFindUnique, settingsFindUnique, followerCount } = vi.hoisted(() => ({
  actorKeysFindUnique: vi.fn(),
  siteSettingFindUnique: vi.fn(),
  settingsFindUnique: vi.fn(),
  followerCount: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    actorKeys: { findUnique: actorKeysFindUnique, create: vi.fn() },
    siteSetting: { findUnique: siteSettingFindUnique, upsert: vi.fn() },
    siteSettings: { findUnique: settingsFindUnique },
    fediFollower: { count: followerCount },
    maintenanceItem: { upsert: vi.fn() },
  },
}));
vi.mock("@/lib/site-profile", () => ({
  getRuntimeProfile: vi.fn(async () => ({
    authorName: "Ada",
    actorSummary: "About me",
    avatarPath: "/images/avatar.png",
    bannerPath: "/images/banner.webp",
  })),
}));

import { getActorProfile } from "@/lib/federation";

const OLD = { SITE_URL: process.env.SITE_URL, FEDI_HANDLE: process.env.FEDI_HANDLE, FEDI_DOMAIN: process.env.FEDI_DOMAIN };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  process.env.FEDI_HANDLE = "ada";
  delete process.env.FEDI_DOMAIN;
  actorKeysFindUnique.mockResolvedValue({ publicKey: "PUBKEY", privateKey: "PRIVKEY" });
  siteSettingFindUnique.mockResolvedValue(null); // no aliases by default
});

afterAll(() => {
  for (const [k, v] of Object.entries(OLD)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("actor identity invariants", () => {
  it("anchors the key id to the actor id", async () => {
    const actor = await getActorProfile();
    expect(actor.id).toBe("https://demo.example/ap/actor");
    // A remote server fetches the actor and looks for publicKey.id matching the
    // keyId we sign with. A mismatch fails verification with no error our side.
    expect(actor.publicKey.id).toBe(`${actor.id}#main-key`);
    expect(actor.publicKey.owner).toBe(actor.id);
  });

  it("serves the collections and shared inbox off the same origin", async () => {
    const actor = await getActorProfile();
    for (const url of [actor.inbox, actor.outbox, actor.followers, actor.following, actor.endpoints.sharedInbox]) {
      expect(url.startsWith("https://demo.example/")).toBe(true);
    }
  });

  it("declares the activitystreams + security contexts", async () => {
    const actor = await getActorProfile();
    expect(actor["@context"]).toContain("https://www.w3.org/ns/activitystreams");
    expect(actor["@context"]).toContain("https://w3id.org/security/v1");
  });
});

describe("alsoKnownAs on the actor (#326)", () => {
  it("is absent entirely when no alias is set", async () => {
    // A default instance's actor document must not change shape.
    const actor = await getActorProfile();
    expect("alsoKnownAs" in actor).toBe(false);
  });

  it("appears verbatim once set, so a Move verification can match it", async () => {
    siteSettingFindUnique.mockResolvedValue({
      value: "https://mastodon.social/users/ada\nhttps://old.example/users/ada",
    });
    const actor = await getActorProfile();
    expect((actor as { alsoKnownAs?: string[] }).alsoKnownAs).toEqual([
      "https://mastodon.social/users/ada",
      "https://old.example/users/ada",
    ]);
  });

  it("needs no extra JSON-LD term — alsoKnownAs is in the activitystreams context", async () => {
    // Verified against the published AS2 context: alsoKnownAs is defined there
    // as {"@id":"as:alsoKnownAs","@type":"@id"}. (movedTo is NOT — that one will
    // need an inline term when the outbound half lands.)
    siteSettingFindUnique.mockResolvedValue({ value: "https://old.example/users/ada" });
    const actor = await getActorProfile();
    expect(actor["@context"]).toEqual([
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ]);
  });

  it("still serves the actor when the alias lookup fails", async () => {
    siteSettingFindUnique.mockRejectedValue(new Error("db down"));
    const actor = await getActorProfile();
    expect(actor.id).toBe("https://demo.example/ap/actor");
    expect("alsoKnownAs" in actor).toBe(false);
  });
});
