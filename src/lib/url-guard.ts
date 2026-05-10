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

function isPrivateIPv6(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "::" || bare === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  const mapped = bare.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isPrivateIPv4(mapped[1])) return true;
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
