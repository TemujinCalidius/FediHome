import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #387. A container path can be absolute, exist and be writable — and still be
 * deleted by the next `docker compose up --build`. The read fallback hides the
 * loss until then, so the failure surfaces days after the change that caused it.
 */

// A realistic mountinfo: overlay root, a bind mount at /data, a tmpfs at /tmp,
// and the usual container-injected single-file mounts.
const MOUNTINFO = [
  "1976 1975 0:142 / / rw,relatime - overlay overlay rw,lowerdir=/l1,upperdir=/u,workdir=/w",
  "1977 1976 0:145 / /proc rw,nosuid - proc proc rw",
  "1985 1976 0:147 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=65536k",
  "1990 1976 259:1 /srv/fedihome /data rw,relatime - ext4 /dev/nvme0n1p1 rw",
  "1994 1976 259:1 /etc/hosts /etc/hosts rw,relatime - ext4 /dev/nvme0n1p1 rw",
  "1999 1976 0:150 / /mnt/media\\040files rw,relatime - ext4 /dev/sdb1 rw",
].join("\n");

const load = async (opts: { container: boolean; mountinfo?: string | Error }) => {
  vi.resetModules();
  vi.doMock("@/lib/install-shape", () => ({ isContainerised: () => opts.container }));
  vi.doMock("fs", () => ({
    default: {
      readFileSync: () => {
        if (opts.mountinfo instanceof Error) throw opts.mountinfo;
        return opts.mountinfo ?? MOUNTINFO;
      },
      existsSync: () => false,
    },
  }));
  return import("@/lib/uploads-dir");
};

describe("ephemeralReason — which mount does the path actually land on", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("fs"));

  it("flags a path with nothing but the overlay root above it", async () => {
    const { ephemeralReason } = await load({ container: true });
    // The issue's exact reproduction: /app/data looks fine and is not a mount.
    expect(ephemeralReason("/app/data")).toMatch(/container's own filesystem/);
  });

  it("accepts a bind mount", async () => {
    const { ephemeralReason } = await load({ container: true });
    expect(ephemeralReason("/data/uploads")).toBeNull();
  });

  it("accepts the mount point itself, not just paths under it", async () => {
    const { ephemeralReason } = await load({ container: true });
    expect(ephemeralReason("/data")).toBeNull();
  });

  it("flags tmpfs, which IS a mount point but lives in RAM", async () => {
    // The case a naive "is it mounted?" test gets wrong.
    const { ephemeralReason } = await load({ container: true });
    expect(ephemeralReason("/tmp/uploads")).toMatch(/held in memory/);
  });

  it("takes the LONGEST matching mount, not the first", async () => {
    // /data/uploads is a prefix-match for both "/" and "/data". Picking "/"
    // would warn about a correctly-mounted volume.
    const { ephemeralReason } = await load({ container: true });
    expect(ephemeralReason("/data/uploads/photos/2026")).toBeNull();
  });

  it("does not treat /etc/hostsomething as being under the /etc/hosts mount", async () => {
    // Prefix matching on strings rather than path segments would match this.
    const { ephemeralReason } = await load({ container: true });
    expect(ephemeralReason("/etc/hostsomething")).toMatch(/container's own filesystem/);
  });

  it("decodes octal-escaped spaces in mount points", async () => {
    const { ephemeralReason } = await load({ container: true });
    expect(ephemeralReason("/mnt/media files/uploads")).toBeNull();
  });

  it("says nothing outside a container", async () => {
    // On a host every path is as durable as the disk under it.
    const { ephemeralReason } = await load({ container: false });
    expect(ephemeralReason("/app/data")).toBeNull();
  });

  it("fails open when mountinfo can't be read", async () => {
    // A false warning on a correct instance teaches operators to click through
    // the one that matters.
    const { ephemeralReason } = await load({ container: true, mountinfo: new Error("ENOENT") });
    expect(ephemeralReason("/app/data")).toBeNull();
  });

  it("fails open on unparseable mountinfo rather than guessing", async () => {
    const { ephemeralReason } = await load({ container: true, mountinfo: "garbage\nmore garbage" });
    expect(ephemeralReason("/app/data")).toBeNull();
  });
});
