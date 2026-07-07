import { describe, it, expect } from "vitest";
import { parseCursor, encodeCursor, cursorWhere, CURSOR_ORDER } from "@/lib/cursor";

describe("cursor pagination (#206)", () => {
  it("encodes and round-trips (publishedAt, id)", () => {
    const d = new Date("2026-07-06T10:00:00.000Z");
    const token = encodeCursor(d, "cid123");
    expect(token).toBe("2026-07-06T10:00:00.000Z_cid123");
    expect(parseCursor(token)).toEqual({ publishedAt: d, id: "cid123" });
  });

  it("null/empty/garbage cursors parse to null", () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("not-a-date_x")).toBeNull();
  });

  it("a legacy plain-ISO token parses with an empty id", () => {
    const c = parseCursor("2026-07-06T10:00:00.000Z");
    expect(c).toEqual({ publishedAt: new Date("2026-07-06T10:00:00.000Z"), id: "" });
  });

  it("cursorWhere with an id seeks strictly past (publishedAt, id) — no tie skipped", () => {
    const c = parseCursor("2026-07-06T10:00:00.000Z_mid")!;
    expect(cursorWhere(c)).toEqual({
      OR: [
        { publishedAt: { lt: new Date("2026-07-06T10:00:00.000Z") } },
        { publishedAt: new Date("2026-07-06T10:00:00.000Z"), id: { lt: "mid" } },
      ],
    });
  });

  it("cursorWhere for a legacy (id-less) cursor falls back to strict lt", () => {
    const c = parseCursor("2026-07-06T10:00:00.000Z")!;
    expect(cursorWhere(c)).toEqual({ publishedAt: { lt: new Date("2026-07-06T10:00:00.000Z") } });
  });

  it("the DESC order includes id so the seek is a total order", () => {
    expect(CURSOR_ORDER).toEqual([{ publishedAt: "desc" }, { id: "desc" }]);
  });

  it("scenario: two posts share a millisecond at the page boundary and NEITHER is skipped", () => {
    // Page 1's last row is {t, id:"b"}; the tied row {t, id:"a"} (a<b) is on page 2.
    const t = new Date("2026-07-06T10:00:00.000Z");
    const where = cursorWhere({ publishedAt: t, id: "b" }) as { OR: Array<Record<string, unknown>> };
    // The equal-timestamp branch keeps rows at t whose id < "b" (i.e. "a"),
    // which strict `lt` on publishedAt alone would have excluded.
    const tieBranch = where.OR.find((b) => b.id);
    expect(tieBranch).toEqual({ publishedAt: t, id: { lt: "b" } });
  });
});
