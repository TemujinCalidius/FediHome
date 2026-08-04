import { describe, it, expect, afterEach, vi } from "vitest";
import { rateLimitKey } from "../client-ip";

/**
 * A fresh copy of the module, for the tests that assert on the warning.
 *
 * The "warn at most once" guard is deliberately process-global — it runs on
 * every rate-limited request and must not spam a log the operator is reading.
 * That makes it shared state between tests: whichever test warns first consumes
 * it for the rest of the file. Re-importing gives each of those tests its own
 * one-shot, without exporting a reset hook from production code purely for
 * tests to call.
 */
async function freshModule() {
  vi.resetModules();
  return (await import("../client-ip")).rateLimitKey;
}

function reqWith(headers: Record<string, string>) {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

afterEach(() => {
  delete process.env.TRUSTED_PROXY;
  delete process.env.TRUSTED_PROXY_HEADER;
  vi.restoreAllMocks();
});

describe("rateLimitKey — the untrusted case", () => {
  it("returns 'default' when TRUSTED_PROXY is unset, ignoring every forwarded header", () => {
    // Without a trusted proxy these are all attacker-spoofable, so every request
    // must collapse to one bucket (H2/H3) — no rotating buckets to outrun a limit.
    expect(
      rateLimitKey(
        reqWith({
          "x-forwarded-for": "1.2.3.4",
          "x-real-ip": "5.6.7.8",
          "cf-connecting-ip": "203.0.113.7",
        }),
      ),
    ).toBe("default");
  });

  it("returns 'default' when TRUSTED_PROXY is any value other than exactly 'true'", () => {
    process.env.TRUSTED_PROXY = "1";
    expect(rateLimitKey(reqWith({ "x-real-ip": "5.6.7.8" }))).toBe("default");
  });
});

/**
 * #515. The header to trust is the operator's to name, because whether a header
 * is forgeable depends entirely on what the edge in front of this instance does
 * with it — and no fixed order is right for every edge.
 */
describe("rateLimitKey — TRUSTED_PROXY_HEADER names the one header trusted", () => {
  it.each(["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] as const)(
    "trusts %s when it is the named header",
    (header) => {
      process.env.TRUSTED_PROXY = "true";
      process.env.TRUSTED_PROXY_HEADER = header;
      expect(rateLimitKey(reqWith({ [header]: "198.51.100.4" }))).toBe("198.51.100.4");
    },
  );

  it("takes the leftmost hop of X-Forwarded-For when that is the named header", () => {
    // Naming XFF asserts your edge OVERWRITES it, in which case hop 0 is the client.
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
    expect(rateLimitKey(reqWith({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }))).toBe("9.9.9.9");
  });

  it("is case- and whitespace-insensitive about the configured name", () => {
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "  CF-Connecting-IP  ";
    expect(rateLimitKey(reqWith({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("returns 'default' when the named header is absent", () => {
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
    expect(rateLimitKey(reqWith({}))).toBe("default");
  });

  it("returns 'default' when the named header is present but blank", () => {
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
    expect(rateLimitKey(reqWith({ "x-real-ip": "   " }))).toBe("default");
  });
});

/**
 * The regression this issue is about, stated as the property it violates. The
 * old code tried CF-Connecting-IP first on ANY deployment, so on everything
 * except Cloudflare a client could choose its own bucket key by setting a header.
 *
 * The test that used to live here — "uses CF-Connecting-IP over a spoofed
 * X-Forwarded-For" — asserted the preference order was the point. It wasn't; it
 * was the bug, and it passed for as long as the bug existed.
 */
describe("rateLimitKey — a header the operator did not name is never trusted (#515)", () => {
  it.each([
    ["cf-connecting-ip", "x-real-ip"],
    ["x-forwarded-for", "x-real-ip"],
    ["x-real-ip", "cf-connecting-ip"],
    ["cf-connecting-ip", "x-forwarded-for"],
  ])("ignores a forged %s when %s is the named header", (forged, named) => {
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = named;
    // The named header is absent; only the forged one arrives. It must not be used.
    expect(rateLimitKey(reqWith({ [forged]: "203.0.113.66" }))).toBe("default");
  });

  it("uses the named header, not the forged one, when both arrive", () => {
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
    expect(
      rateLimitKey(
        reqWith({ "x-real-ip": "198.51.100.4", "cf-connecting-ip": "203.0.113.66" }),
      ),
    ).toBe("198.51.100.4");
  });

  it("cannot be made to rotate buckets by varying an unnamed header", () => {
    // The concrete attack: mint a fresh bucket per request and never hit a limit.
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
    const keys = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((ip) =>
        rateLimitKey(reqWith({ "cf-connecting-ip": ip, "x-forwarded-for": ip })),
      ),
    );
    expect([...keys]).toEqual(["default"]);
  });
});

describe("rateLimitKey — TRUSTED_PROXY=true with no header named", () => {
  it("assumes X-Real-IP, the only one the shipped nginx config overwrites", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(rateLimitKey(reqWith({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("still ignores CF-Connecting-IP, which the old code preferred above all", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(rateLimitKey(reqWith({ "cf-connecting-ip": "203.0.113.7" }))).toBe("default");
  });

  it("warns when a different forwarded header arrives instead", async () => {
    // The Cloudflare operator who upgrades and sets nothing: their limits go to
    // one shared bucket, which is safe but surprising. Say so rather than not.
    const key = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY = "true";
    expect(key(reqWith({ "cf-connecting-ip": "203.0.113.7" }))).toBe("default");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("TRUSTED_PROXY_HEADER");
  });

  it("does not warn when no forwarded header arrives at all", async () => {
    // Nothing is misconfigured here — this is a direct-to-Node instance that set
    // the flag optimistically. Warning would be noise on every request.
    const key = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY = "true";
    expect(key(reqWith({}))).toBe("default");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("rateLimitKey — an unrecognised TRUSTED_PROXY_HEADER fails closed", () => {
  it("trusts nothing rather than falling back to the default", async () => {
    // A typo must not silently trust a header the operator never named — that is
    // the bug this issue is about, reintroduced through the error path.
    const key = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-realip";
    expect(key(reqWith({ "x-real-ip": "5.6.7.8", "cf-connecting-ip": "203.0.113.7" }))).toBe(
      "default",
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not repeat the warning on every request", async () => {
    const key = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "nonsense";
    for (let i = 0; i < 5; i++) key(reqWith({ "x-real-ip": "5.6.7.8" }));
    expect(warn).toHaveBeenCalledOnce();
  });
});
