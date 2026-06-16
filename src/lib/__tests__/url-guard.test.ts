import { describe, it, expect } from "vitest";
import { isPrivateUrl } from "../url-guard";

describe("isPrivateUrl", () => {
  it("allows public HTTP/HTTPS URLs", () => {
    expect(isPrivateUrl("https://example.com")).toBe(false);
    expect(isPrivateUrl("http://example.com/path")).toBe(false);
    expect(isPrivateUrl("https://mastodon.social/users/bob")).toBe(false);
  });

  it("rejects non-http protocols", () => {
    expect(isPrivateUrl("ftp://example.com")).toBe(true);
    expect(isPrivateUrl("file:///etc/passwd")).toBe(true);
    expect(isPrivateUrl("javascript:alert(1)")).toBe(true);
    expect(isPrivateUrl("data:text/html,<h1>hi</h1>")).toBe(true);
  });

  it("rejects localhost variants", () => {
    expect(isPrivateUrl("http://localhost")).toBe(true);
    expect(isPrivateUrl("http://localhost:8080/api")).toBe(true);
    expect(isPrivateUrl("http://0.0.0.0")).toBe(true);
  });

  it("rejects RFC-1918 private IPv4 ranges", () => {
    expect(isPrivateUrl("http://10.0.0.1")).toBe(true);
    expect(isPrivateUrl("http://10.255.255.255")).toBe(true);
    expect(isPrivateUrl("http://192.168.1.1")).toBe(true);
    expect(isPrivateUrl("http://172.16.0.1")).toBe(true);
    expect(isPrivateUrl("http://172.31.255.255")).toBe(true);
  });

  it("allows public IPv4 just outside private ranges", () => {
    expect(isPrivateUrl("http://172.15.0.1")).toBe(false);
    expect(isPrivateUrl("http://172.32.0.1")).toBe(false);
    expect(isPrivateUrl("http://11.0.0.1")).toBe(false);
  });

  it("rejects loopback 127.x.x.x", () => {
    expect(isPrivateUrl("http://127.0.0.1")).toBe(true);
    expect(isPrivateUrl("http://127.255.255.255")).toBe(true);
  });

  it("rejects link-local 169.254.x.x", () => {
    expect(isPrivateUrl("http://169.254.169.254")).toBe(true); // AWS metadata
    expect(isPrivateUrl("http://169.254.0.1")).toBe(true);
  });

  it("rejects hex-encoded IPv4 (SSRF bypass attempt)", () => {
    expect(isPrivateUrl("http://0x7f000001")).toBe(true); // 127.0.0.1 in hex
    expect(isPrivateUrl("http://0xc0a80101")).toBe(true); // 192.168.1.1 in hex
  });

  it("rejects decimal-encoded IPv4 (SSRF bypass attempt)", () => {
    expect(isPrivateUrl("http://2130706433")).toBe(true); // 127.0.0.1 as decimal
    expect(isPrivateUrl("http://3232235777")).toBe(true); // 192.168.1.1 as decimal
  });

  it("rejects IPv6 loopback and link-local", () => {
    expect(isPrivateUrl("http://[::1]")).toBe(true);
    expect(isPrivateUrl("http://[::]")).toBe(true);
    expect(isPrivateUrl("http://[fe80::1]")).toBe(true);
  });

  it("rejects private hostname suffixes", () => {
    expect(isPrivateUrl("http://server.local")).toBe(true);
    expect(isPrivateUrl("http://host.internal")).toBe(true);
    expect(isPrivateUrl("http://box.lan")).toBe(true);
  });

  it("rejects malformed URLs", () => {
    expect(isPrivateUrl("not a url")).toBe(true);
    expect(isPrivateUrl("")).toBe(true);
    expect(isPrivateUrl("://bad")).toBe(true);
  });
});
