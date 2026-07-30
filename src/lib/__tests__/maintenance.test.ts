import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Raising and resolving maintenance items (#412).
 *
 * `MaintenanceItem` had eight writers and one of them ever cleared anything, so
 * the notification bell filled up and stayed full. The behaviours worth pinning
 * are the two that are easy to get backwards:
 *
 *  - a **dismissal must survive** a re-raise — otherwise every check resurrects
 *    an alert the owner already waved away, which is what `update: {}` bought and
 *    what must not be lost;
 *  - a sweep must **never resolve an alert it doesn't own**. `npm audit` listing
 *    the current advisories would otherwise clear the boot-time credential and
 *    identity alerts, which share `kind: "security"` and which it knows nothing
 *    whatsoever about. That failure is silent: the alert simply goes away.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    maintenanceItem: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import {
  raiseMaintenanceItem,
  resolveMaintenanceItem,
  seenKey,
  sweepResolved,
  NEVER_SWEPT,
} from "@/lib/maintenance";
import { prisma } from "@/lib/db";

const m = () => vi.mocked(prisma.maintenanceItem);

const ALERT = { kind: "update", packageName: "next", latest: "16.1.0", title: "next → 16.1.0" };

/** A stored row, defaulting to the shape a live item has. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "row1",
  ...ALERT,
  dismissed: false,
  applied: false,
  resolvedAt: null,
  occurrences: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m().findUnique.mockResolvedValue(null as never);
  m().findMany.mockResolvedValue([] as never);
  m().updateMany.mockResolvedValue({ count: 0 } as never);
});

describe("raising", () => {
  it("creates an item that doesn't exist yet", async () => {
    await raiseMaintenanceItem(ALERT);
    expect(m().create).toHaveBeenCalledWith({ data: expect.objectContaining(ALERT) });
  });

  it("leaves an outstanding item completely untouched", async () => {
    m().findUnique.mockResolvedValue(row() as never);
    await raiseMaintenanceItem(ALERT);
    expect(m().create).not.toHaveBeenCalled();
    expect(m().update).not.toHaveBeenCalled();
  });

  it("does NOT resurrect a dismissed item", async () => {
    // The contract the old `update: {}` idiom bought, and the reason this isn't
    // an upsert. A weekly cron re-raising a dismissed alert makes Dismiss useless.
    m().findUnique.mockResolvedValue(row({ dismissed: true }) as never);
    await raiseMaintenanceItem(ALERT);
    expect(m().update).not.toHaveBeenCalled();
  });

  it("re-raises an item that had been resolved, as a new occurrence", async () => {
    m().findUnique.mockResolvedValue(
      row({ resolvedAt: new Date("2026-07-01"), dismissed: true, occurrences: 2 }) as never,
    );
    await raiseMaintenanceItem(ALERT);
    expect(m().update).toHaveBeenCalledWith({
      where: { kind_packageName_latest: { kind: "update", packageName: "next", latest: "16.1.0" } },
      data: expect.objectContaining({
        resolvedAt: null,
        dismissed: false, // a dismissal doesn't carry across a resolution
        applied: false,
        occurrences: 3,
      }),
    });
  });

  it("refreshes an outstanding item's wording when asked, without un-dismissing it", async () => {
    // `current` drifts as a dependency tree is partly upgraded, and release bodies
    // get edited after publication. Neither is a reason to reopen the alert.
    m().findUnique.mockResolvedValue(row({ dismissed: true }) as never);
    await raiseMaintenanceItem({ ...ALERT, current: "16.0.9" }, { refresh: true });
    const data = m().update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.current).toBe("16.0.9");
    expect(data).not.toHaveProperty("dismissed");
    expect(data).not.toHaveProperty("resolvedAt");
  });
});

describe("sweeping", () => {
  const live = [
    row({ id: "a", packageName: "next", latest: "16.1.0" }),
    row({ id: "b", packageName: "next", latest: "16.0.9" }),
    row({ id: "c", packageName: "react", latest: "20.0.0" }),
  ];

  it("resolves exactly the items the checker no longer sees", async () => {
    m().findMany.mockResolvedValue(live as never);
    const n = await sweepResolved("update", new Set([seenKey("next", "16.1.0")]));
    expect(n).toBe(2);
    expect(m().updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["b", "c"] } },
      data: { resolvedAt: expect.any(Date) },
    });
  });

  it("resolves everything when the checker sees nothing at all", async () => {
    // THE case #412 exists for: a clean `npm audit` produces zero iterations, so
    // before this nothing reconciled and a fixed advisory was reported forever.
    m().findMany.mockResolvedValue(live as never);
    expect(await sweepResolved("update", new Set())).toBe(3);
  });

  it("only ever looks at items that are still unresolved", async () => {
    await sweepResolved("update", new Set());
    expect(m().findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: "update", resolvedAt: null } }),
    );
  });

  it("writes nothing when there is nothing to resolve", async () => {
    m().findMany.mockResolvedValue([row({ id: "a" })] as never);
    expect(await sweepResolved("update", new Set([seenKey("next", "16.1.0")]))).toBe(0);
    expect(m().updateMany).not.toHaveBeenCalled();
  });

  it("leaves another owner's rows alone when asked", async () => {
    // `kind: "update"` is written both by the npm check and by FediHome's own
    // release-tag fallback. Without this, the npm sweep resolves the row the
    // release check wrote moments earlier in the same run.
    m().findMany.mockResolvedValue(
      [...live, row({ id: "self", packageName: "fedihome", latest: "1.24.0" })] as never,
    );
    await sweepResolved("update", new Set(), { exceptPackages: ["fedihome"] });
    expect(m().updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["a", "b", "c"] } });
  });

  it("NEVER resolves the one-shot boot alerts, even unasked", async () => {
    // These share `kind: "security"` with `npm audit`, which has no idea whether
    // your credentials decrypt or your signing keys were regenerated. Exemption
    // lives in the sweeper, not the call site, so a future sweep can't forget an
    // alert it has never heard of.
    m().findMany.mockResolvedValue(
      [
        row({ id: "adv", kind: "security", packageName: "lodash", latest: "<4.17.21" }),
        row({ id: "creds", kind: "security", packageName: "stored-credentials", latest: "undecryptable" }),
        row({ id: "keys", kind: "security", packageName: "federation-identity", latest: "actor-keys-regenerated" }),
      ] as never,
    );
    const n = await sweepResolved("security", new Set());
    expect(n).toBe(1);
    expect(m().updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["adv"] } });
  });

  it("exempts the alerts the boot checks actually raise", () => {
    // Guards against a rename on either side: if secret-health or federation.ts
    // changes its identity, the exemption stops matching and the sweep silently
    // starts clearing them.
    expect(NEVER_SWEPT).toContain("security/stored-credentials");
    expect(NEVER_SWEPT).toContain("security/federation-identity");
  });

  it("distinguishes identities that share a prefix", async () => {
    // `latest` is a semver range for advisories (`<4.17.21`) and a version
    // elsewhere, so the composite key has to be unambiguous.
    m().findMany.mockResolvedValue(
      [row({ id: "x", packageName: "next", latest: "16.1" }), row({ id: "y", packageName: "next", latest: "16.10" })] as never,
    );
    await sweepResolved("update", new Set([seenKey("next", "16.1")]));
    expect(m().updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["y"] } });
  });
});

describe("resolving one item", () => {
  it("resolves only the unresolved matching row", async () => {
    await resolveMaintenanceItem("security", "stored-credentials", "undecryptable");
    expect(m().updateMany).toHaveBeenCalledWith({
      where: {
        kind: "security",
        packageName: "stored-credentials",
        latest: "undecryptable",
        resolvedAt: null,
      },
      data: { resolvedAt: expect.any(Date) },
    });
  });

  it("swallows a database failure — it runs on boot and render paths", async () => {
    m().updateMany.mockRejectedValue(new Error("db down") as never);
    await expect(
      resolveMaintenanceItem("security", "stored-credentials", "undecryptable"),
    ).resolves.toBeUndefined();
  });
});
