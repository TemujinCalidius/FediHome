import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log } from "../log";

describe("log (structured logger)", () => {
  let out: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    out = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => out.mockRestore());

  it("emits one JSON line with level, a valid ISO ts, msg, and fields", () => {
    log.info("hello", { a: 1, b: "two" });
    expect(out).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(out.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ level: "info", msg: "hello", a: 1, b: "two" });
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it("routes error() to console.error and serializes Error fields", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("boom", { err: new Error("nope") });
    const parsed = JSON.parse(err.mock.calls[0][0] as string);
    expect(parsed.level).toBe("error");
    expect(parsed.err).toMatchObject({ name: "Error", message: "nope" });
    err.mockRestore();
  });
});
