import fs from "node:fs";

/**
 * How was this instance installed, and therefore how is it updated? (#398)
 *
 * The bug this exists to fix isn't a missing feature — it's that everybody got
 * the same advice and for a third of them it was wrong. The update alert said
 * "Run `npm run update`", which in a container **refuses outright**:
 * `update.sh` hard-gates on `.git` existing, and a container has none (excluded
 * by `.dockerignore`). Nor could it work if it didn't gate — the runner image has
 * no `src/`, no Docker socket, and runs unprivileged. **A container genuinely
 * cannot update itself**; the work has to happen on the host.
 *
 * So the honest answer differs by install shape, and telling someone to run a
 * command that will refuse is worse than saying nothing.
 */

export type InstallShape = "container" | "git" | "tarball";

/**
 * Are we inside a container?
 *
 * Lifted from `/api/setup`, where it was module-private (and where losing this
 * distinction locks an operator out of their own admin panel). Two signals
 * because neither is universal: Docker writes `/.dockerenv`, and other runtimes
 * (containerd, Kubernetes) show up in PID 1's cgroup instead. No `/proc` at all
 * — macOS, Windows — means bare metal.
 */
export function isContainerised(): boolean {
  try {
    if (fs.existsSync("/.dockerenv")) return true;
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8");
    return /docker|containerd|kubepods/i.test(cgroup);
  } catch {
    return false;
  }
}

/**
 * Which shape this install is.
 *
 * Container first: a containerised install may well have a `.git` bind-mounted
 * in during development, and it still can't update itself from the inside.
 *
 * After that the question is only whether `update.sh` will run — and what it
 * actually requires is `.git`, since its first step is `git pull`. A tarball or
 * zip install has the code and no history, so it needs a different answer rather
 * than a command that exits 1.
 */
export function installShape(cwd = process.cwd()): InstallShape {
  if (isContainerised()) return "container";
  try {
    return fs.existsSync(`${cwd}/.git`) ? "git" : "tarball";
  } catch {
    return "tarball";
  }
}

/**
 * The command to actually apply an update, as a sentence that can be dropped into
 * an alert.
 *
 * Deliberately says "on the host" for a container. The owner is reading this in a
 * web page served *by* the container, so "run this" is ambiguous exactly where
 * being wrong wastes the most time.
 */
export function updateInstruction(shape: InstallShape = installShape()): string {
  // The operator always beats detection (#438). No amount of probing enumerates
  // every deployment topology — Kubernetes, Nomad, Swarm, Fly, Render, any PaaS
  // — and the failure is not subtle: an orchestrated install is detected as
  // `container` and told to run compose on a host it does not have, while a
  // platform that writes neither /.dockerenv nor a matching cgroup falls through
  // to `tarball` and is told to unpack a release over an immutable filesystem.
  const override = process.env.FEDIHOME_UPDATE_TEXT?.trim();
  if (override) return override;

  switch (shape) {
    case "container":
      return (
        "To apply it, run `docker compose pull && docker compose up -d` on the host " +
        "(or `docker compose build && docker compose up -d` if you build the image " +
        "yourself). A container can't update itself from the inside."
      );
    case "tarball":
      return (
        "To apply it, download the new release and unpack it over this install, then " +
        "run `npm install && npm run migrate && npx prisma db push && npm run build` " +
        "and restart. (`npm run update` needs a git checkout, which this install isn't.)"
      );
    case "git":
      return "To apply it, run `npm run update`.";
  }
}

/** The same thing as a bare command, for a log line with no room for a sentence. */
export function updateCommand(shape: InstallShape = installShape()): string {
  const override = process.env.FEDIHOME_UPDATE_TEXT?.trim();
  if (override) return override;

  switch (shape) {
    case "container":
      return "docker compose pull && docker compose up -d (on the host)";
    case "tarball":
      return "unpack the new release, then npm install && npm run build";
    case "git":
      return "npm run update";
  }
}

/**
 * Where an update alert should send the operator (#438).
 *
 * The cheap half of the same problem, and the reason it is worth doing first:
 * `MaintenanceItem.url` is ALREADY rendered — src/lib/notifications.ts maps it
 * to `targetUrl`, and NotificationBell opens it. `description`, where
 * updateInstruction() writes, is never mapped. So making the URL settable is a
 * config change with a working render path, whereas surfacing the text needs a
 * UI change as well.
 *
 * A URL is also the better fit for the case that prompted this. An orchestrated
 * install's instruction is rarely a command that can be typed into the box the
 * operator is looking at — it is "go and do this somewhere else", which a link
 * expresses natively and which survives the operator changing their process
 * without waiting for a core release.
 *
 * ONLY for FediHome's own update rows. npm package rows and security advisories
 * must keep pointing at npmjs and the advisory: those links are the evidence,
 * not the action, and redirecting them would hide what an alert is actually
 * about.
 */
export function updateUrl(fallback: string): string {
  const override = process.env.FEDIHOME_UPDATE_URL?.trim();
  if (!override) return fallback;
  try {
    const u = new URL(override);
    // Rendered as a link the operator clicks, so refuse anything that isn't a
    // plain web address — javascript: and data: are the obvious ones.
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}
