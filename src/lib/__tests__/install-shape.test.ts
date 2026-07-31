import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Telling the owner the update command that actually works (#398).
 *
 * The bug was never a missing feature — it was that everyone got the same advice
 * and for containers it was **wrong**. The alert said "Run `npm run update`",
 * which in a container refuses outright: `update.sh` gates on `.git`, and the
 * image has none. Nor could it work without the gate — no `src/`, no Docker
 * socket, unprivileged `node`. A container genuinely cannot update itself.
 *
 * Telling someone to run a command that will exit 1 is worse than saying nothing,
 * because they'll assume the update itself is broken.
 */

const { existsSync, readFileSync } = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock("node:fs", () => ({ default: { existsSync, readFileSync } }));

import { installShape, isContainerised, updateCommand, updateInstruction } from "@/lib/install-shape";

/** A filesystem where only the listed paths exist. */
const only = (...paths: string[]) => existsSync.mockImplementation((p: string) => paths.includes(p));

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
  readFileSync.mockImplementation(() => {
    throw new Error("ENOENT"); // no /proc — a Mac or Windows box
  });
});

describe("detecting a container", () => {
  it("recognises Docker's marker file", () => {
    only("/.dockerenv");
    expect(isContainerised()).toBe(true);
  });

  it("recognises containerd and Kubernetes from PID 1's cgroup", () => {
    // Neither signal is universal — Docker writes /.dockerenv, other runtimes
    // only show up in the cgroup — so both are checked.
    for (const cgroup of ["1:name=systemd:/docker/abc", "0::/kubepods/besteffort", "0::/containerd/x"]) {
      vi.clearAllMocks();
      existsSync.mockReturnValue(false);
      readFileSync.mockReturnValue(cgroup);
      expect(isContainerised(), cgroup).toBe(true);
    }
  });

  it("treats a host with no /proc as bare metal, not as a container", () => {
    // macOS and Windows have no /proc. Guessing "container" there would send a
    // developer to `docker compose` for a plain `npm run dev` checkout.
    expect(isContainerised()).toBe(false);
  });

  it("treats an ordinary Linux cgroup as bare metal", () => {
    readFileSync.mockReturnValue("0::/init.scope");
    expect(isContainerised()).toBe(false);
  });
});

describe("choosing the shape", () => {
  it("a git checkout is a git checkout", () => {
    only("/app/.git");
    expect(installShape("/app")).toBe("git");
  });

  it("no .git means a release archive, not a checkout", () => {
    // update.sh's first step is `git pull`, so this install can't use it — it
    // needs a different answer rather than a command that exits 1.
    expect(installShape("/app")).toBe("tarball");
  });

  it("container WINS over a bind-mounted .git", () => {
    // A dev container may well have the history mounted in, and it still cannot
    // rebuild its own image from the inside.
    only("/.dockerenv", "/app/.git");
    expect(installShape("/app")).toBe("container");
  });
});

describe("the instruction each shape gets", () => {
  it("tells a git install to run the updater", () => {
    expect(updateInstruction("git")).toContain("npm run update");
  });

  it("tells a container to use compose, and says ON THE HOST", () => {
    // The owner is reading this in a page served BY the container, so "run this"
    // is ambiguous exactly where being wrong wastes the most time.
    const s = updateInstruction("container");
    expect(s).toContain("docker compose");
    expect(s).toContain("on the host");
    expect(s).toContain("can't update itself");
  });

  it("never tells a container to run the command that would refuse", () => {
    // The whole of #398 in one assertion.
    expect(updateInstruction("container")).not.toContain("npm run update");
    expect(updateCommand("container")).not.toContain("npm run update");
  });

  it("tells a tarball install what to do, and why the updater isn't it", () => {
    const s = updateInstruction("tarball");
    expect(s).toContain("npm run build");
    expect(s).toContain("git checkout"); // explains why `npm run update` won't work
  });

  it("gives every shape a non-empty short form for a log line", () => {
    for (const shape of ["container", "git", "tarball"] as const) {
      expect(updateCommand(shape).length).toBeGreaterThan(0);
    }
  });
});
