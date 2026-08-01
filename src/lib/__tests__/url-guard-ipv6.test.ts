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

  // 6to4 (2002::/16) carries its IPv4 in groups 1-2, not 6-7 — which is exactly
  // why the three extraction branches above all missed it. Every one of these is
  // a private IPv4 wearing an IPv6 hat.
  "http://[2002:7f00:1::]/x",          // 127.0.0.1
  "http://[2002:a9fe:a9fe::]/x",       // 169.254.169.254 — cloud metadata
  "http://[2002:c0a8:1::]/x",          // 192.168.0.1
  "http://[2002:a00:1::]/x",           // 10.0.0.1
  "http://[2002:ac10:1::]/x",          // 172.16.0.1
  "http://[2002:6440:1::]/x",          // 100.64.0.1 — CGNAT

  // Prefixes with nothing worth extracting: the address is hidden behind a
  // transform we can't reverse, or the range is local/reserved by definition.
  "http://[64:ff9b:1::7f00:1]/x",      // NAT64 LOCAL-USE (RFC 8215)
  "http://[64:ff9b:1:ffff::1]/x",      // ...anywhere in that /48
  "http://[2001::1]/x",                // Teredo (2001::/32)
  "http://[2001:0:1234::1]/x",         // ...also Teredo
  "http://[2001:20::1]/x",             // ORCHIDv2 (2001:20::/28)
  "http://[2001:db8::1]/x",            // documentation (RFC 3849)
  "http://[3fff::1]/x",                // documentation (RFC 9637)
  "http://[100::1]/x",                 // discard-only (RFC 6666)
];

/** Genuinely routable, and must stay usable — federation depends on it. */
const MUST_BE_PUBLIC = [
  "http://[2606:4700:4700::1111]/x", // Cloudflare DNS
  "http://[2001:4860:4860::8888]/x", // Google DNS
  "http://[fec0::1]/x",              // site-local: deprecated, but not private space

  // THE over-correction guard. 6to4 is unwrapped and judged as IPv4, not blanket
  // -blocked — a 6to4 address wrapping a genuinely public IPv4 is legitimately
  // routable, and refusing it would be the same mistake in the other direction.
  "http://[2002:0808:0808::]/x",     // 8.8.8.8 via 6to4
  "http://[2002:5db8:d822::]/x",     // 93.184.216.34 via 6to4

  // Teredo is 2001::/32 exactly — ordinary 2001: space must stay reachable, and
  // 3ffe:: is not the 3fff::/20 documentation range.
  "http://[2001:1::1]/x",
  "http://[3ffe::1]/x",
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
