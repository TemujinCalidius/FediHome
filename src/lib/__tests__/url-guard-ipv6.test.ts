import { describe, it, expect } from "vitest";
import http from "node:http";
import { assertPublicHost, isPrivateUrl } from "@/lib/url-guard";

/**
 * IPv4-mapped IPv6 literals, which used to walk straight through the SSRF guard.
 *
 * `isPrivateIPv6` matched the address as TEXT, looking for a dotted quad:
 *
 * ```ts
 * const mapped = bare.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
 * ```
 *
 * But WHATWG URL **normalises** `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` — so by
 * the time `new URL()` has run, the spelling that regex looks for no longer exists.
 * The check therefore returned false for loopback, RFC1918, `0.0.0.0` and
 * `169.254.169.254`, and `assertPublicHost`'s "IP literals skip DNS" shortcut
 * returned `true` on top of that.
 *
 * The effect was that the guard did nothing at all for these addresses — no redirect
 * needed. A remote server could put `keyId: http://[::ffff:a9fe:a9fe]/…` on a signed
 * activity and the inbox would fetch cloud metadata directly.
 *
 * Now evaluated on the parsed address, so spelling is irrelevant.
 */

/** Every way of writing loopback and friends that URL parsing will accept. */
const MUST_BE_PRIVATE = [
  "http://[::ffff:127.0.0.1]/x",       // normalises to [::ffff:7f00:1]
  "http://[::ffff:7f00:1]/x",          // the normalised form, written directly
  "http://[::ffff:169.254.169.254]/x", // cloud metadata
  "http://[::ffff:a9fe:a9fe]/x",
  "http://[::ffff:10.0.0.1]/x",        // RFC1918
  "http://[::ffff:a00:1]/x",
  "http://[::ffff:192.168.1.1]/x",
  "http://[::ffff:172.16.0.1]/x",
  "http://[::ffff:0.0.0.0]/x",
  "http://[::ffff:0:0]/x",
  "http://[::7f00:1]/x",               // deprecated IPv4-compatible ::127.0.0.1
  "http://[::1]/x",                    // plain loopback
  "http://[::]/x",                     // unspecified
  "http://[fd00::1]/x",                // unique-local
  "http://[fe80::1]/x",                // link-local
  "http://[febf::1]/x",                // top of fe80::/10 — the old regex missed this
  "http://[ff02::1]/x",                // multicast
  "http://[64:ff9b::7f00:1]/x",        // NAT64 onto loopback
];

/** Genuinely routable, and must stay usable — federation depends on it. */
const MUST_BE_PUBLIC = [
  "http://[2606:4700:4700::1111]/x", // Cloudflare DNS
  "http://[2001:4860:4860::8888]/x", // Google DNS
  "http://[fec0::1]/x",              // site-local: deprecated, but not private space
];

describe("IPv4-mapped and special IPv6 literals are refused", () => {
  it.each(MUST_BE_PRIVATE)("%s is private", async (url) => {
    expect(isPrivateUrl(url), "isPrivateUrl").toBe(true);
    expect(await assertPublicHost(url), "assertPublicHost").toBe(false);
  });

  it.each(MUST_BE_PUBLIC)("%s is still allowed", async (url) => {
    expect(isPrivateUrl(url), "isPrivateUrl").toBe(false);
    expect(await assertPublicHost(url), "assertPublicHost").toBe(true);
  });

  it("refuses an address it cannot parse rather than assuming it's fine", async () => {
    // Failing open here is how the original bug behaved.
    for (const url of ["http://[::ffff:999.1.1.1]/x", "http://[1:2:3:4:5:6:7:8:9]/x", "http://[gg::1]/x"]) {
      expect(await assertPublicHost(url), url).toBe(false);
    }
  });

  it("no longer reaches a real loopback listener", async () => {
    // The end-to-end proof. Before the fix this returned the server's body.
    const s = http.createServer((_req, res) => { res.writeHead(200); res.end("internal"); });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    expect(await assertPublicHost(`http://[::ffff:7f00:1]:${port}/latest/meta-data/`)).toBe(false);
    s.close();
  });
});
