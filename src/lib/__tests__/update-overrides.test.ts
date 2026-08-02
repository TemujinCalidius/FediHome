import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { updateInstruction, updateCommand, updateUrl } from "@/lib/install-shape";

/**
 * #438. installShape() returns `container` for anything running in one and the
 * container branch says to run `docker compose` ON THE HOST — which an
 * orchestrated install does not have. And a platform that writes neither
 * /.dockerenv nor a matching cgroup falls through to `tarball`, whose advice is
 * to unpack a release over an immutable filesystem.
 *
 * Detection can never enumerate every deployment topology. The operator knows
 * theirs, so the fix is to let them say it.
 */
const FALLBACK = "https://github.com/TemujinCalidius/FediHome/releases/latest";

describe("update overrides (#438)", () => {
  const saved = { text: process.env.FEDIHOME_UPDATE_TEXT, url: process.env.FEDIHOME_UPDATE_URL };
  beforeEach(() => {
    delete process.env.FEDIHOME_UPDATE_TEXT;
    delete process.env.FEDIHOME_UPDATE_URL;
  });
  afterEach(() => {
    if (saved.text === undefined) delete process.env.FEDIHOME_UPDATE_TEXT;
    else process.env.FEDIHOME_UPDATE_TEXT = saved.text;
    if (saved.url === undefined) delete process.env.FEDIHOME_UPDATE_URL;
    else process.env.FEDIHOME_UPDATE_URL = saved.url;
  });

  it("keeps the detected instruction when nothing is set", () => {
    expect(updateInstruction("container")).toContain("docker compose");
    expect(updateInstruction("git")).toContain("npm run update");
  });

  it("replaces the instruction for every shape once set", () => {
    // Must beat the detection rather than only the fallback: the orchestrated
    // case is DETECTED as `container`, confidently and wrongly.
    process.env.FEDIHOME_UPDATE_TEXT = "Approve the pending deploy in Argo CD.";
    for (const shape of ["container", "git", "tarball"] as const) {
      expect(updateInstruction(shape)).toBe("Approve the pending deploy in Argo CD.");
    }
  });

  it("overrides the bare command form too, so the log can't contradict the alert", () => {
    process.env.FEDIHOME_UPDATE_TEXT = "Approve the pending deploy in Argo CD.";
    expect(updateCommand("container")).toBe("Approve the pending deploy in Argo CD.");
  });

  it("ignores an empty or whitespace-only override", () => {
    // An unset variable in a compose file is often "" rather than absent, and
    // blanking the instruction would be worse than the wrong one.
    process.env.FEDIHOME_UPDATE_TEXT = "   ";
    expect(updateInstruction("container")).toContain("docker compose");
  });

  it("uses the fallback URL when nothing is set", () => {
    expect(updateUrl(FALLBACK)).toBe(FALLBACK);
  });

  it("redirects the update alert at the operator's own pipeline", () => {
    process.env.FEDIHOME_UPDATE_URL = "https://ci.example.com/deploy";
    expect(updateUrl(FALLBACK)).toBe("https://ci.example.com/deploy");
  });

  it("refuses a non-http scheme — the value is rendered as a clickable link", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      process.env.FEDIHOME_UPDATE_URL = bad;
      expect(updateUrl(FALLBACK)).toBe(FALLBACK);
    }
  });

  it("falls back rather than throwing on an unparseable URL", () => {
    process.env.FEDIHOME_UPDATE_URL = "not a url";
    expect(updateUrl(FALLBACK)).toBe(FALLBACK);
  });

  it("allows http, for an internal control plane with no TLS", () => {
    process.env.FEDIHOME_UPDATE_URL = "http://argocd.internal/applications/fedihome";
    expect(updateUrl(FALLBACK)).toBe("http://argocd.internal/applications/fedihome");
  });
});

describe("the override reaches FediHome's own rows and no others (#438)", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "..", "scripts/check-updates.ts"),
    "utf8",
  );

  it("wraps both FediHome self-update URLs", () => {
    expect(src.match(/updateUrl\(/g)?.length).toBe(2);
  });

  it("leaves npm and advisory links alone", () => {
    // Those links are the EVIDENCE, not the action. Redirecting them would hide
    // what the alert is actually about.
    expect(src).toContain("url: `https://www.npmjs.com/package/${name}`");
    expect(src).toContain("url: via.url");
    expect(src).toContain("url: release.html_url");
  });
});
