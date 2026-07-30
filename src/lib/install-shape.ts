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
  switch (shape) {
    case "container":
      return "docker compose pull && docker compose up -d (on the host)";
    case "tarball":
      return "unpack the new release, then npm install && npm run build";
    case "git":
      return "npm run update";
  }
}
