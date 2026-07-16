import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret, secretBoxAvailable } from "@/lib/secret-box";

const ORIGINAL = process.env.ADMIN_SECRET;

beforeEach(() => {
  process.env.ADMIN_SECRET = "a".repeat(64);
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIGINAL;
});

describe("secret-box (encrypt integration credentials at rest)", () => {
  it("round-trips a secret", () => {
    const ct = encryptSecret("abcd-efgh-ijkl-mnop");
    expect(ct).toMatch(/^v1:/);
    expect(decryptSecret(ct!)).toBe("abcd-efgh-ijkl-mnop");
  });

  it("uses a random IV — same input encrypts to different ciphertext", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("decrypt returns null under a rotated ADMIN_SECRET (can't decrypt with a different key)", () => {
    const ct = encryptSecret("secret")!;
    process.env.ADMIN_SECRET = "b".repeat(64);
    expect(decryptSecret(ct)).toBeNull();
  });

  it("decrypt returns null for malformed / non-v1 / too-short input", () => {
    expect(decryptSecret("plaintext")).toBeNull();
    expect(decryptSecret("v1:" + Buffer.from("short").toString("base64"))).toBeNull();
  });

  it("decrypt returns null for a tampered ciphertext (GCM tag mismatch)", () => {
    const ct = encryptSecret("secret")!;
    const body = ct.slice(3);
    const tampered = "v1:" + (body[0] === "A" ? "B" : "A") + body.slice(1);
    expect(decryptSecret(tampered)).toBeNull();
  });

  it("is unavailable (null) when ADMIN_SECRET is unset", () => {
    delete process.env.ADMIN_SECRET;
    expect(secretBoxAvailable()).toBe(false);
    expect(encryptSecret("x")).toBeNull();
    expect(decryptSecret("v1:whatever")).toBeNull();
  });
});
