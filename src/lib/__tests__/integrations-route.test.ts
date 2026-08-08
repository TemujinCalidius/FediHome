import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * `/api/admin/integrations` — the PDS field (#504), and the route's first tests.
 *
 * #449 shipped the resolver, the validator and the credential plumbing for a
 * self-hosted AT Protocol server, and then nothing called any of it:
 * `setBlueskyService()` had no caller, and `testBlueskyLogin`'s third `service`
 * parameter was dead. The v1.25.0 changelog described a screen that did not
 * exist. This wires it up, and pins the three things that are easy to get
 * subtly wrong.
 *
 * The route had **no tests at all** before this, which is a large part of why
 * the gap survived a release.
 */

const { verifyAdmin, verifyOrigin } = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  verifyOrigin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin }));

const mocks = vi.hoisted(() => ({
  testBlueskyLogin: vi.fn(),
  setBlueskyCredentials: vi.fn(),
  setBlueskyService: vi.fn(),
  rememberBlueskyDid: vi.fn(),
  getIntegrationStatus: vi.fn(),
  clearBlueskyCredentials: vi.fn(),
}));
vi.mock("@/lib/integrations", async (orig) => {
  // Keep the REAL validateBlueskyService: the route's job is to reject a bad
  // address before attempting a login, and stubbing the validator would make
  // that test assert nothing.
  const actual = await orig<typeof import("@/lib/integrations")>();
  return { ...actual, ...mocks };
});

import { POST } from "@/app/api/admin/integrations/route";

const post = (body: unknown): NextRequest =>
  new Request("https://x/api/admin/integrations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

const save = (over: Record<string, unknown> = {}) =>
  post({ action: "save", provider: "bluesky", handle: "me.bsky.social", password: "pw", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdmin.mockResolvedValue(true);
  verifyOrigin.mockReturnValue(true);
  mocks.testBlueskyLogin.mockResolvedValue({ ok: true, did: "did:plc:me" });
  mocks.setBlueskyCredentials.mockResolvedValue({ ok: true });
  mocks.setBlueskyService.mockResolvedValue({ ok: true, value: "https://pds.example.com" });
  mocks.getIntegrationStatus.mockResolvedValue({ bluesky: {}, threads: {}, dayOne: {} });
});

describe("the PDS field reaches the code that stores it (#504)", () => {
  it("saves the address the operator typed", async () => {
    await POST(save({ service: "https://pds.example.com" }));
    expect(mocks.setBlueskyService).toHaveBeenCalledWith("https://pds.example.com");
  });

  it("Test signs in to the address in the box, not the saved one", async () => {
    // The whole point of the third argument. Without it the button verifies the
    // host you are replacing, which is worse than not offering the button.
    await POST(post({
      action: "test", provider: "bluesky",
      handle: "me.bsky.social", password: "pw", service: "https://pds.example.com",
    }));
    expect(mocks.testBlueskyLogin).toHaveBeenCalledWith("me.bsky.social", "pw", "https://pds.example.com");
    expect(mocks.setBlueskyService).not.toHaveBeenCalled();
  });

  it("an empty string clears it, and is not confused with 'not sent'", async () => {
    // `clean()` maps "" to null, which is why the service deliberately does not
    // go through it: submitting the field blank is how an operator goes back to
    // bsky.social, and that has to be distinguishable from omitting the field.
    await POST(save({ service: "" }));
    expect(mocks.setBlueskyService).toHaveBeenCalledWith("");
  });

  it("omitting the field entirely leaves the stored PDS alone", async () => {
    await POST(save());
    expect(mocks.setBlueskyService).not.toHaveBeenCalled();
  });

  it("saves the service AFTER the credentials", async () => {
    // Every failure path above returns early, so a service row written first
    // would point the NEXT set of credentials at a host nobody chose for them.
    const order: string[] = [];
    mocks.setBlueskyCredentials.mockImplementation(async () => {
      order.push("creds");
      return { ok: true };
    });
    mocks.setBlueskyService.mockImplementation(async () => {
      order.push("service");
      return { ok: true, value: "https://pds.example.com" };
    });
    await POST(save({ service: "https://pds.example.com" }));
    expect(order).toEqual(["creds", "service"]);
  });
});

describe("a bad PDS address is rejected as an address, not as a failed login", () => {
  it.each([
    ["http://pds.example.com", "not https"],
    ["https://pds.example.com/xrpc", "has a path"],
    ["https://localhost", "not reachable from the internet"],
    ["not a url", "not a url at all"],
  ])("refuses %s (%s) before attempting to sign in", async (service) => {
    // Validating after the login would report a typo'd host as "check your
    // handle and app password", which sends the operator to the wrong field.
    const res = await POST(save({ service }));
    expect(res.status).toBe(400);
    expect(mocks.testBlueskyLogin).not.toHaveBeenCalled();
    expect(mocks.setBlueskyCredentials).not.toHaveBeenCalled();
  });

  it("says what a good address looks like", async () => {
    const res = await POST(save({ service: "http://pds.example.com" }));
    expect((await res.json()).error).toMatch(/https:\/\/pds\.example\.com/);
  });

  it("rejects a header-injection attempt in the address", async () => {
    const res = await POST(save({ service: "https://pds.example.com\r\nX-Evil: 1" }));
    expect(res.status).toBe(400);
    expect(mocks.testBlueskyLogin).not.toHaveBeenCalled();
  });
});

describe("the route still guards itself", () => {
  it("403s a cross-origin request", async () => {
    verifyOrigin.mockReturnValue(false);
    expect((await POST(save())).status).toBe(403);
  });

  it("401s a caller who isn't the owner", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(save())).status).toBe(401);
  });

  it("does not save anything when the login fails", async () => {
    mocks.testBlueskyLogin.mockResolvedValue({ ok: false, error: "bad password" });
    const res = await POST(save({ service: "https://pds.example.com" }));
    expect(res.status).toBe(400);
    expect(mocks.setBlueskyCredentials).not.toHaveBeenCalled();
    expect(mocks.setBlueskyService).not.toHaveBeenCalled();
  });
});
