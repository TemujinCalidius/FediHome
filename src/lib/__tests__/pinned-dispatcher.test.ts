import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #434. assertPublicHost resolves the hostname and checks every address. Then
 * fetch resolves it AGAIN to open the socket. Two lookups, and an attacker who
 * owns the zone answers the first publicly and the second with 127.0.0.1 — the
 * check passes and the connection goes somewhere never validated.
 *
 * Closing it means the lookup that DECIDES and the lookup that CONNECTS are the
 * same one.
 */
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup }, lookup }));

import { guardedLookup, guardedDispatcher, resetGuardedDispatcher } from "@/lib/pinned-dispatcher";

const call = (hostname: string, all = true) =>
  new Promise<{ err: unknown; addr: unknown; family?: number }>((resolve) =>
    guardedLookup(hostname, { all }, (err, addr, family) => resolve({ err, addr, family })),
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetGuardedDispatcher();
});

describe("guardedLookup — hands back only what it validated", () => {
  it("passes a public address through", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const { err, addr } = await call("example.com");
    expect(err).toBeNull();
    expect(addr).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses a host that resolves only to loopback", async () => {
    // The rebinding payload: DNS says 127.0.0.1 at connect time.
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const { err } = await call("rebind.example");
    expect((err as Error)?.message).toContain("every address it resolves to is private");
  });

  it("refuses the cloud metadata address", async () => {
    lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect((await call("metadata.example")).err).toBeTruthy();
  });

  it("refuses private IPv6, including the IPv4-mapped spellings", async () => {
    for (const address of ["::1", "fc00::1", "fe80::1", "::ffff:7f00:1", "2002:7f00:1::"]) {
      lookup.mockResolvedValue([{ address, family: 6 }]);
      expect((await call("v6.example")).err, `${address} should be refused`).toBeTruthy();
    }
  });

  it("STRIPS a private address from a mixed answer rather than trusting the set", async () => {
    // The subtle case. A host answering with one public and one private address
    // must not be able to get the private one into the connection candidates —
    // undici picks from what we hand back.
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const { err, addr } = await call("mixed.example");
    expect(err).toBeNull();
    expect(addr).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("keeps a working family when the other one is misconfigured", async () => {
    // Dual-stack hosts really do have one broken family; refusing the whole host
    // would break legitimate federation.
    lookup.mockResolvedValue([
      { address: "fe80::1", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    const { err, addr } = await call("dual.example");
    expect(err).toBeNull();
    expect(addr).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("uses the scalar callback shape when opts.all is false", async () => {
    // undici passes all: true in practice, but the option is undici's to choose.
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const { err, addr, family } = await call("example.com", false);
    expect(err).toBeNull();
    expect(addr).toBe("93.184.216.34");
    expect(family).toBe(4);
  });

  it("propagates a resolver failure instead of inventing an address", async () => {
    // Must reach the caller as a transport error: deliverActivity then treats it
    // as NON-permanent and the activity stays retryable, rather than being
    // dropped with no FailedDelivery row.
    lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }));
    const { err } = await call("down.example");
    expect((err as NodeJS.ErrnoException)?.code).toBe("EAI_AGAIN");
  });

  it("always resolves with all: true, so a partial answer can't hide a private address", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await call("example.com");
    expect(lookup).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
  });
});

describe("guardedDispatcher — one Agent, and a real one", () => {
  it("reuses a single Agent across calls", async () => {
    // An Agent owns connection pools; one per request would leak sockets and
    // throw away keep-alive on the chattiest federation paths.
    expect(guardedDispatcher()).toBe(guardedDispatcher());
  });

  it("is a genuine undici Dispatcher, not a duck-typed object", async () => {
    // A plain object with a dispatch method is SILENTLY IGNORED by fetch — no
    // error, the hook never fires, and the guard looks installed while doing
    // nothing at all.
    const { Agent } = await import("undici");
    expect(guardedDispatcher()).toBeInstanceOf(Agent);
  });
});

describe("guardedFetch installs it (#434)", () => {
  it("passes the dispatcher on every hop — to UNDICI's fetch, not the global one", async () => {
    // This test used to stub the GLOBAL fetch, and that is exactly why it could
    // not see #506. `dispatcher` is honoured only by the undici copy that built
    // it: the Agent comes from node_modules' undici, while global fetch is
    // Node's bundled one. Stubbing the global made the assertion pass while the
    // real code handed an Agent to a stranger.
    //
    // Mocking the `undici` module instead means this fails if anyone puts the
    // global back.
    vi.resetModules();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.doMock("undici", async (orig) => ({
      ...(await orig<typeof import("undici")>()),
      fetch: fetchSpy,
    }));
    vi.doMock("@/lib/url-guard", async (orig) => ({
      ...(await orig<typeof import("@/lib/url-guard")>()),
      assertPublicHost: vi.fn().mockResolvedValue(true),
    }));
    const { guardedFetch } = await import("@/lib/safe-fetch");
    await guardedFetch("https://example.com/", { crossOrigin: true, label: "t", timeoutMs: 1000 });
    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][1]).toHaveProperty("dispatcher");
    vi.doUnmock("undici");
    vi.doUnmock("@/lib/url-guard");
  });

  it("the dispatcher and the fetch come from the SAME undici copy", async () => {
    // THE structural guard, and the one that would have made #506 a one-line
    // diagnosis instead of 22 confusing assertion failures.
    //
    // `guardedDispatcher()` builds an Agent from the undici in node_modules.
    // Whatever `guardedFetch` calls has to be from that same copy, or the
    // handler shapes disagree — silently while both are 6.x, and fatally
    // (`UND_ERR_INVALID_ARG: invalid onRequestStart method`) the moment the
    // userland one moves to 8.x. Neither `tsc` nor `next build` can see it.
    const src = readFileSync(join(process.cwd(), "src/lib/safe-fetch.ts"), "utf-8");
    expect(src, "safe-fetch.ts must import fetch from undici").toMatch(
      /import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*"undici"/,
    );
    // A bare `fetch(` call would be the global one creeping back in.
    const calls = src
      .split("\n")
      .filter((l) => /(?:^|[^.\w])fetch\s*\(/.test(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .filter((l) => !/undiciFetch\s*\(/.test(l));
    expect(calls, `safe-fetch.ts calls a non-undici fetch:\n${calls.join("\n")}`).toEqual([]);
  });
});
