/**
 * SSRF guard for outbound fetches against URLs derived from untrusted input.
 *
 * `isPrivateUrl` does pure-string-level rejection for IPv4/IPv6 literals in
 * any encoded form (decimal/hex/octal IPv4, IPv6 ULA, link-local, v4-mapped),
 * private hostname suffixes, and well-known cloud-metadata names.
 *
 * `assertPublicHost` additionally resolves DNS so a public hostname that
 * answers with a private IP (rebinding) is rejected before connection.
 */
import { promises as dns } from "dns";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".localhost"];
const PRIVATE_HOSTS = new Set(["localhost", "0.0.0.0"]);

function ipv4FromAnyForm(host: string): string | null {
  // Hex (0x7f000001) or decimal (2130706433) — convert to dotted quad.
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    if (!Number.isFinite(n)) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
  }
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
  }
  // Octal-leading dotted quad (e.g. 0177.0.0.1).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map((p) => {
      if (/^0\d+$/.test(p)) return parseInt(p, 8);
      return parseInt(p, 10);
    });
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return parts.join(".");
  }
  return null;
}

function isPrivateIPv4(ip: string): boolean {
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  const m172 = ip.match(/^172\.(\d+)\./);
  if (m172) {
    const n = parseInt(m172[1], 10);
    if (n >= 16 && n <= 31) return true;
  }
  if (/^169\.254\./.test(ip)) return true;
  const m100 = ip.match(/^100\.(\d+)\./);
  if (m100) {
    const n = parseInt(m100[1], 10);
    if (n >= 64 && n <= 127) return true;
  }
  const m1st = ip.match(/^(\d+)\./);
  if (m1st) {
    const n = parseInt(m1st[1], 10);
    if (n >= 224 || n === 0) return true;
  }
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if unparseable.
 *
 * Needed because the textual form cannot be pattern-matched reliably: WHATWG URL
 * **normalises** `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so any regex looking for
 * a dotted quad is matching a spelling that `new URL()` has already destroyed. That
 * is exactly how loopback and the cloud-metadata address walked through this guard.
 */
function expandIPv6(bare: string): number[] | null {
  let text = bare;

  // A trailing dotted quad (`::ffff:127.0.0.1`) becomes two hex groups.
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = [dotted[2], dotted[3], dotted[4], dotted[5]].map((n) => parseInt(n, 10));
    if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/**
 * The IPv4 address an IPv6 group array embeds, if it embeds one.
 *
 * IPv6 has several transition mechanisms that carry an IPv4 address inside the
 * address, at different offsets. Each one is a way to reach an IPv4 host through
 * an IPv6 literal, so each one has to be unwrapped and judged as IPv4 — otherwise
 * `[2002:7f00:1::]` sails past every range check below and dials 127.0.0.1.
 */
function embeddedIPv4(g: number[]): string | null {
  const zeros = (upTo: number) => g.slice(0, upTo).every((x) => x === 0);
  /** Two 16-bit groups, high then low, as a dotted quad. */
  const quad = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

  // ::ffff:0:0/96 — IPv4-mapped. The one URL normalisation rewrites.
  if (zeros(5) && g[5] === 0xffff) return quad(g[6], g[7]);
  // ::/96 — deprecated IPv4-compatible. Covers `::7f00:1` and `::0:0`.
  if (zeros(6)) return quad(g[6], g[7]);
  // 64:ff9b::/96 — NAT64 well-known. A translator forwards to the embedded v4.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return quad(g[6], g[7]);
  }
  // 2002::/16 — 6to4. The IPv4 sits in groups 1-2, NOT 6-7, which is why the
  // three cases above all missed it: `2002:7f00:1::` is 127.0.0.1 wearing a hat.
  // Extracted rather than blanket-blocked on purpose — a 6to4 address wrapping a
  // genuinely public IPv4 is legitimately routable, and refusing those would be
  // the same mistake in the opposite direction.
  if (g[0] === 0x2002) return quad(g[1], g[2]);
  return null;
}

/**
 * Prefixes that are never a legitimate destination, whatever they wrap.
 *
 * Distinct from `embeddedIPv4` on purpose: these either hide the address behind a
 * transform we can't reverse, or are local/reserved by definition, so there is no
 * embedded value worth extracting and judging.
 */
function isReservedIPv6Prefix(g: number[]): boolean {
  // 64:ff9b:1::/48 — NAT64 LOCAL-USE (RFC 8215). The embedding is operator-chosen
  // and RFC 6052 splits the quad around a reserved octet for /48, so there is no
  // single correct extraction. "Local-use" is the entire point of the prefix.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;
  // 2001::/32 — Teredo. The embedded client IPv4 is XOR-obfuscated, and Teredo is
  // deprecated. Note this needs g[1] === 0 exactly, so it does NOT catch ordinary
  // 2001:xxxx:: space — 2001:4860:4860::8888 (Google DNS) stays reachable.
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;
  // 2001:20::/28 — ORCHIDv2. Cryptographic identifiers, not routable hosts.
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0020) return true;
  // 2001:db8::/32 and 3fff::/20 — documentation ranges (RFC 3849, RFC 9637).
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0x0000) return true;
  // 100::/64 — discard-only (RFC 6666).
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  return false;
}

/**
 * Is this IPv6 address one we must never connect to?
 *
 * Evaluated on the **parsed** address rather than its spelling. The previous version
 * matched text, and `[::ffff:127.0.0.1]` is unrecognisable by the time `new URL()`
 * has rewritten it to `[::ffff:7f00:1]` — so loopback, RFC1918, `0.0.0.0` and
 * `169.254.169.254` all read as public and the guard passed them straight through.
 *
 * Unparseable is treated as private: if we cannot tell what an address is, we do not
 * connect to it.
 */
function isPrivateIPv6(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const g = expandIPv6(bare);
  if (!g) return true; // can't parse it → don't reach it

  const v4 = embeddedIPv4(g);
  if (v4 !== null) return isPrivateIPv4(v4);
  if (isReservedIPv6Prefix(g)) return true;

  if (g.every((x) => x === 0)) return true; //                       ::  unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; //                    fc00::/7  unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; //                    fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; //                    ff00::/8  multicast
  return false;
}

export function isPrivateUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return true;

  if (PRIVATE_HOSTS.has(host)) return true;
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }

  if (host.includes(":")) return isPrivateIPv6(host);

  // Direct dotted-quad IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);

  // Decimal/hex/octal IPv4
  const normalized = ipv4FromAnyForm(host);
  if (normalized) return isPrivateIPv4(normalized);

  return false;
}

/**
 * DNS-rebinding-resistant: resolve the hostname and reject if any returned
 * address is private. Use for paths where the response body crosses a trust
 * boundary (AP inbox key fetch, actor fetch).
 */
export async function assertPublicHost(urlStr: string): Promise<boolean> {
  if (isPrivateUrl(urlStr)) return false;
  try {
    const host = new URL(urlStr).hostname;
    // An IP literal has nothing to resolve, and isPrivateUrl above has already
    // judged it — including IPv4-mapped IPv6, which it used to wave through.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return true;
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) {
      if (a.family === 4 && isPrivateIPv4(a.address)) return false;
      if (a.family === 6 && isPrivateIPv6(a.address)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
