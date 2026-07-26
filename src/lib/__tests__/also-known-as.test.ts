import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Account aliases — `alsoKnownAs` (#326).
 *
 * This is the property that decides whether someone can bring their followers
 * TO a FediHome. Their old server publishes a `Move`; every receiving server
 * then fetches *our* actor and only re-points the follow if `alsoKnownAs` names
 * the old account. Get this wrong and the move is silently refused — the
 * followers simply stay where they are, with no error anywhere.
 *
 * A malformed entry is worse than a missing one, because it can make the whole
 * property unusable to the server doing the verifying. So parsing drops junk
 * rather than emitting it.
 */

const { findUnique, upsert } = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findUnique, upsert } } }));

import { parseAliases, getAlsoKnownAs, setAlsoKnownAs, ALSO_KNOWN_AS_KEY } from "@/lib/identity-store";

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  upsert.mockResolvedValue({});
});

describe("parseAliases", () => {
  it("accepts absolute http(s) actor URIs", () => {
    expect(parseAliases("https://mastodon.social/users/ada")).toEqual([
      "https://mastodon.social/users/ada",
    ]);
  });

  it("splits on newlines, commas and spaces", () => {
    const out = parseAliases(
      "https://a.example/users/x\nhttps://b.example/users/y, https://c.example/users/z",
    );
    expect(out).toEqual([
      "https://a.example/users/x",
      "https://b.example/users/y",
      "https://c.example/users/z",
    ]);
  });

  it("drops anything that isn't an absolute web address", () => {
    // A handle is the single most likely thing to be pasted here by mistake.
    const out = parseAliases("@ada@mastodon.social\nnot a url\nftp://x.example/u\n/relative");
    expect(out).toEqual([]);
  });

  it("keeps the valid entries when only some are junk", () => {
    const out = parseAliases("@ada@mastodon.social\nhttps://good.example/users/ada");
    expect(out).toEqual(["https://good.example/users/ada"]);
  });

  it("strips trailing slashes so the alias matches the actor id exactly", () => {
    // An actor id differing by one slash is a DIFFERENT id to a remote server,
    // which is exactly the comparison a Move verification performs.
    expect(parseAliases("https://a.example/users/x/")).toEqual(["https://a.example/users/x"]);
  });

  it("de-duplicates", () => {
    const out = parseAliases("https://a.example/users/x\nhttps://a.example/users/x/");
    expect(out).toEqual(["https://a.example/users/x"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 25 }, (_, i) => `https://e${i}.example/users/x`).join("\n");
    expect(parseAliases(many)).toHaveLength(10);
  });

  it("returns [] for empty input", () => {
    expect(parseAliases("")).toEqual([]);
    expect(parseAliases("   \n  ")).toEqual([]);
  });
});

describe("getAlsoKnownAs", () => {
  it("reads the identity.alsoKnownAs row", async () => {
    findUnique.mockResolvedValue({ value: "https://a.example/users/x" });
    expect(await getAlsoKnownAs()).toEqual(["https://a.example/users/x"]);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: ALSO_KNOWN_AS_KEY } });
  });

  it("returns [] when unset", async () => {
    expect(await getAlsoKnownAs()).toEqual([]);
  });

  it("returns [] rather than throwing when the database is unavailable", async () => {
    // The actor document must still serve — a failure here would take down
    // federation entirely, which is far worse than a missing alias.
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await getAlsoKnownAs()).toEqual([]);
  });
});

describe("setAlsoKnownAs", () => {
  it("stores only the validated entries and reports them back", async () => {
    const saved = await setAlsoKnownAs("https://a.example/users/x\nnonsense");
    expect(saved).toEqual(["https://a.example/users/x"]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: ALSO_KNOWN_AS_KEY },
        update: { value: "https://a.example/users/x" },
      }),
    );
  });

  it("clears the list with an empty string", async () => {
    expect(await setAlsoKnownAs("")).toEqual([]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: "" } }),
    );
  });
});
