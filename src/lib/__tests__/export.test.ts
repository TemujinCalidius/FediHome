import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #365. Backup was documented as pg_dump plus a tarball, which is right for
 * someone with a terminal on the box and useless for everyone else — so "it's
 * your data" was only actionable for people comfortable with Postgres.
 */
const SITE = { siteUrl: "https://x.test", fediAddress: "@me@x.test", version: "1.0.0" };

/** A table of `n` rows, served in pages, recording how it was asked. */
const table = (n: number, calls: unknown[] = []) => ({
  count: vi.fn().mockResolvedValue(n),
  findMany: vi.fn(async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
    calls.push(args);
    const start = args.cursor ? Number(args.cursor.id) + 1 : 0;
    return Array.from({ length: Math.max(0, Math.min(args.take, n - start)) }, (_, i) => ({
      id: String(start + i),
      title: `row ${start + i}`,
    }));
  }),
});

const load = async (over: Record<string, unknown> = {}) => {
  vi.resetModules();
  const empty = () => table(0);
  vi.doMock("@/lib/db", () => ({
    prisma: {
      post: empty(), photo: empty(), video: empty(), audio: empty(),
      fediPost: empty(), guestComment: empty(), ...over,
    },
  }));
  return import("@/lib/export");
};

const collect = async (mod: { exportRecords: (s: typeof SITE) => AsyncGenerator<Record<string, unknown>> }) => {
  const out: Record<string, unknown>[] = [];
  for await (const r of mod.exportRecords(SITE)) out.push(r);
  return out;
};

beforeEach(() => vi.resetModules());

describe("the export describes itself before anything else", () => {
  it("emits a header record first", async () => {
    // A truncated download is still self-describing, and a consumer knows what
    // it is holding before it parses a single content row.
    const recs = await collect(await load());
    expect(recs[0]._type).toBe("export");
    expect(recs[0].formatVersion).toBe(1);
    expect(recs[0].site).toEqual(SITE);
  });

  it("carries counts, so a consumer can tell complete from truncated", async () => {
    const recs = await collect(await load({ post: table(3) }));
    expect((recs[0].counts as Record<string, number>).posts).toBe(3);
  });
});

describe("pagination is cursor-based, not offset-based", () => {
  it("pages through more rows than fit in one query", async () => {
    const recs = await collect(await load({ post: table(450) }));
    expect(recs.filter((r) => r._type === "post")).toHaveLength(450);
  });

  it("cursors on id and skips the cursor row", async () => {
    // OFFSET pagination silently skips or repeats rows when the set shifts
    // underneath it, and an export of a live instance runs while posts arrive.
    const calls: unknown[] = [];
    const recs = await collect(await load({ post: table(450, calls) }));
    const ids = recs.filter((r) => r._type === "post").map((r) => r.id);
    expect(new Set(ids).size).toBe(450);
    expect((calls[1] as { skip?: number }).skip).toBe(1);
    expect((calls[1] as { cursor?: { id: string } }).cursor).toBeTruthy();
  });

  it("stops on a short page without an extra round trip", async () => {
    const calls: unknown[] = [];
    await collect(await load({ post: table(5, calls) }));
    expect(calls).toHaveLength(1);
  });
});

describe("what is and is not somebody else's data", () => {
  it("exports only OUR fediverse posts", async () => {
    // The rest of that table is other people's content cached for the timeline.
    // Exporting it would hand the operator a pile of strangers' posts labelled
    // "your data".
    const fediPost = table(2);
    await collect(await load({ fediPost }));
    expect(fediPost.findMany.mock.calls[0][0]).toMatchObject({ where: { isOutgoing: true } });
  });

  it("exports only approved comments", async () => {
    // A pending or rejected comment is a moderation decision the operator has
    // not made public.
    const guestComment = table(2);
    await collect(await load({ guestComment }));
    expect(guestComment.findMany.mock.calls[0][0]).toMatchObject({ where: { status: "approved" } });
  });
});

describe("streaming, not buffering (#365)", () => {
  it("emits NDJSON one record per line", async () => {
    const mod = await load({ post: table(2) });
    const stream = mod.exportStream(SITE);
    const text = await new Response(stream).text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 posts
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("reports a mid-stream failure as a record, not a silent truncation", async () => {
    // The headers are long gone by then, so it cannot become an HTTP error. A
    // consumer that checks the last line can still tell the difference.
    const mod = await load({
      post: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockRejectedValue(new Error("db went away")),
      },
    });
    const text = await new Response(mod.exportStream(SITE)).text();
    const last = JSON.parse(text.trim().split("\n").pop()!);
    expect(last._type).toBe("error");
    expect(last.message).toContain("db went away");
  });
});

describe("the route (#365)", () => {
  const src = read("src/app/api/admin/export/route.ts");

  it("is admin-gated", () => {
    expect(src).toContain("verifyAdmin(req)");
    expect(src).toContain("status: 401");
  });

  it("runs on node with a raised duration — it can take minutes", () => {
    expect(src).toContain('runtime = "nodejs"');
    expect(src).toContain("maxDuration");
  });

  it("streams rather than returning a built body", () => {
    expect(src).toContain("exportStream(");
    expect(src).not.toContain("JSON.stringify(records");
  });

  it("sends no Content-Length, because the size isn't known up front", () => {
    expect(src).not.toContain("Content-Length");
  });
});
