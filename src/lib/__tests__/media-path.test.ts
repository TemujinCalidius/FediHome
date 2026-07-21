import { describe, it, expect } from "vitest";
import { validateImagePath, saveUploadedImage } from "@/lib/media";

describe("saveUploadedImage (#59)", () => {
  it("returns ok:false for an undecodable image instead of throwing (→ 400, not 500)", async () => {
    const bad = new File([new Uint8Array([1, 2, 3, 4])], "x.png", { type: "image/png" });
    const r = await saveUploadedImage(bad);
    expect(r.ok).toBe(false);
  });

  it("rejects an unsupported type without touching sharp", async () => {
    const r = await saveUploadedImage(new File([new Uint8Array([1])], "x.txt", { type: "text/plain" }));
    expect(r).toEqual({ ok: false, error: "unsupported file type" });
  });
});

describe("validateImagePath (#59) — the shared avatar/banner path guard", () => {
  it("accepts a same-origin /uploads or /images path", () => {
    expect(validateImagePath("/uploads/2026/07/me.webp")).toBe("/uploads/2026/07/me.webp");
    expect(validateImagePath("/images/avatar.png")).toBe("/images/avatar.png");
  });

  it("treats empty/null as a clear-to-default (empty string)", () => {
    expect(validateImagePath("")).toBe("");
    expect(validateImagePath("   ")).toBe("");
    expect(validateImagePath(null)).toBe("");
  });

  it("rejects external URLs, traversal, and non-strings (undefined)", () => {
    expect(validateImagePath("https://evil.example/x.jpg")).toBeUndefined();
    expect(validateImagePath("/uploads/../../etc/passwd")).toBeUndefined();
    expect(validateImagePath("/etc/passwd")).toBeUndefined();
    expect(validateImagePath("javascript:alert(1)")).toBeUndefined();
    expect(validateImagePath(42)).toBeUndefined();
  });
});
