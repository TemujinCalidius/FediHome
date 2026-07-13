import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

const { unlink } = vi.hoisted(() => ({ unlink: vi.fn() }));
vi.mock("fs/promises", () => ({
  unlink,
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import { removeFediMediaFiles } from "@/lib/fedi-media";

beforeEach(() => {
  vi.clearAllMocks();
  unlink.mockResolvedValue(undefined);
});

describe("removeFediMediaFiles (#240)", () => {
  it("unlinks ONLY proxied /uploads/fedi/ paths, skipping remote passthrough URLs", async () => {
    const n = await removeFediMediaFiles([
      "/uploads/fedi/2026/01/a.jpg",
      "https://youtube.com/watch?v=x", // skip-proxy video host — passthrough
      "https://cdn.remote/avatar.png", // remote avatar — never proxied
      "/uploads/fedi/2026/01/b.mp4",
    ]);
    expect(n).toBe(2);
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith(path.join(process.cwd(), "public", "/uploads/fedi/2026/01/a.jpg"));
  });

  it("refuses a path-traversal escape out of the fedi media dir", async () => {
    const n = await removeFediMediaFiles(["/uploads/fedi/../../../etc/passwd"]);
    expect(n).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
  });

  it("is best-effort: a missing file doesn't throw or stop the rest", async () => {
    unlink.mockRejectedValueOnce(new Error("ENOENT"));
    const n = await removeFediMediaFiles(["/uploads/fedi/gone.jpg", "/uploads/fedi/here.jpg"]);
    expect(n).toBe(1);
    expect(unlink).toHaveBeenCalledTimes(2);
  });
});
