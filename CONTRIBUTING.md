# Contributing to FediHome

Thanks for your interest in contributing to FediHome! This guide will help you get set up and understand how the project is organized.

## Prerequisites

- **Node.js 20+** — check with `node -v`
- **PostgreSQL 15+** — running locally or via Docker
- **Git** — for cloning and version control

## Local Development Setup

1. **Clone the repo:**
   ```bash
   git clone https://github.com/TemujinCalidius/fedihome.git
   cd fedihome
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create your environment file:**
   ```bash
   cp .env.example .env.local
   ```

4. **Edit `.env.local`** and set at minimum:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/fedihome
   ADMIN_SECRET=any-secret-string-for-dev
   SITE_URL=http://localhost:3000
   FEDI_HANDLE=me
   FEDI_DOMAIN=localhost
   ```

5. **Set up the database:**
   ```bash
   npx prisma db push
   ```

6. **Start the dev server:**
   ```bash
   npm run dev
   ```
   The app runs on `http://localhost:3000` by default.

7. **Visit `/setup`** to run the setup wizard on first launch.

## Code Style

- **TypeScript** with strict mode enabled. All new code should be fully typed.
- **Tailwind CSS** for styling. Use utility classes and the existing design tokens defined in `src/app/globals.css` (surface colors, accent colors, font families).
- **Prisma** for all database access. The schema is in `prisma/schema.prisma`. FediHome doesn't track migration files — after changing the schema, run `npx prisma db push` to sync your local database, and document the change in the changelog under a "Schema" heading so operators know to run `db push` after upgrading.
  - **Adding a `@unique`/`@@unique` to an existing table?** `prisma db push` refuses to add a unique constraint without `--accept-data-loss`, even when it's provably safe — so it can't run flaglessly on an upgrade. Either enforce uniqueness in app code (a `findFirst` guard, as the federation handlers do), or ship an idempotent `prisma/manual-migrations/<date>-<name>.sql` (`CREATE UNIQUE INDEX IF NOT EXISTS …`). `update.sh` applies every `manual-migrations/*.sql` **before** `db push`, so a pre-created index means `db push` sees no diff and never trips the data-loss guard.
- **Next.js App Router** conventions. Pages go in `src/app/`, API routes use `route.ts` files, and shared components live in `src/components/`.
- Prefer named exports for components and utility functions.
- Keep files focused: one component per file, one API route per file.

## Branching model

FediHome uses two long-lived branches:

- **`dev`** — the active development / integration branch. **All code changes land here.**
- **`main`** — the stable, released branch. It only moves when maintainers cut a release (by merging `dev` → `main`) or for **documentation-only** changes.

**In short: code → `dev`, docs → `main`.**

- **Code work** (anything under `src/`, `prisma/`, `scripts/`, build config, dependencies): fork, branch from **`dev`**, and open your PR against **`dev`**.
- **Documentation only** (README, `docs/`, `CONTRIBUTING.md`, code comments, typos): you may branch from **`main`** and PR against **`main`** — apply the `skip-changelog` label.

A code PR opened against `main` will be asked to retarget to `dev`. Releases are cut by maintainers: `dev` is merged into `main` (a **merge commit**, not a squash, so the branches stay in sync), `## Unreleased` is promoted to the new version, and `main` is tagged + a GitHub Release is published.

## Making a Pull Request

1. **Fork** the repository on GitHub.
2. **Create a branch from the right base** — `dev` for code, `main` for docs-only:
   ```bash
   git checkout -b my-feature dev      # code work
   # git checkout -b my-docs-fix main  # documentation only
   ```
3. **Implement your change.** Write clear, typed code. Add comments where the "why" is not obvious.
4. **Test locally.** Make sure the dev server starts and existing functionality isn't broken, then run the same checks CI does:
   ```bash
   npx tsc --noEmit && npm test && npm run build
   ```
5. **Commit** with a clear message describing what the change does and why:
   ```bash
   git commit -m "Add photo category filtering to gallery page"
   ```
6. **Push** and open a pull request against **`dev`** (or `main` for documentation-only changes):
   ```bash
   git push origin my-feature
   ```
7. In the PR description, explain:
   - What the change does
   - Why it is needed
   - How to test it
   - Screenshots if there are UI changes

**Changelog (required).** Every pull request must add an entry to [`CHANGELOG.md`](CHANGELOG.md) under the `## Unreleased` heading (create it if it's missing), grouped under `### Added` / `### Changed` / `### Fixed` / `### Security`. CI enforces this on pull requests. If a change genuinely warrants no entry (e.g. a documentation-only PR, a CI-config tweak, or a typo fix), apply the `skip-changelog` label to bypass the check. At release time, `## Unreleased` is renamed to the new version.

**Tracking staged fixes (`fixed-pending-merge`).** When a PR implements the fix for an open issue or a Security & Quality alert (Dependabot / code-scanning), maintainers label it `fixed-pending-merge`, and apply the same label to any issue the PR closes. This makes it easy to see at a glance which problems are already fixed and just waiting on a merge — filter with `fixed-pending-merge` in the [issues](https://github.com/TemujinCalidius/fedihome/issues?q=is%3Aopen+label%3Afixed-pending-merge) or [pull requests](https://github.com/TemujinCalidius/fedihome/pulls?q=is%3Aopen+label%3Afixed-pending-merge) list. (Security & Quality *alerts* can't carry labels themselves, so the labelled PR — whose description lists the alerts it resolves — is their tracking record.) The label needs no cleanup: on merge the PR closes and any linked issue auto-closes via a `Closes #N` reference.

## Issue Templates

### Bug Report

When filing a bug, please include:

- **Description:** What went wrong?
- **Steps to reproduce:** How can someone trigger this bug?
- **Expected behavior:** What should have happened instead?
- **Environment:** OS, Node version, browser, deployment method (Docker, manual, etc.)
- **Logs:** Any relevant console output or error messages.

### Feature Request

When requesting a feature, please include:

- **Description:** What do you want FediHome to do?
- **Use case:** Why is this useful? How would you use it?
- **Alternatives considered:** Have you tried any workarounds?

## Architecture Overview

FediHome is a Next.js 16 app using the App Router, React 19, Prisma with PostgreSQL, and Tailwind CSS. Federation is implemented directly via ActivityPub with HTTP Signatures — no external federation library handles the protocol logic at runtime.

Key areas of the codebase:

- `src/app/ap/` — ActivityPub endpoints (actor, inbox, outbox, followers, following)
- `src/app/api/` — Internal APIs (compose, admin, micropub, media, comments)
- `src/lib/` — Core logic (federation, HTTP signatures, crossposting, auth, media processing)
- `prisma/schema.prisma` — The full database schema

For a deeper walkthrough, see [docs/architecture.md](docs/architecture.md).

## Code of Conduct

FediHome is a small project, and we want to keep the community welcoming for everyone.

- **Be kind.** Assume good intent. Disagree respectfully.
- **Be inclusive.** Welcome newcomers. Avoid jargon without explanation.
- **Be constructive.** When reviewing code, suggest improvements rather than just pointing out problems. Explain why.
- **No harassment, discrimination, or personal attacks.** This includes in issues, PRs, and any project communication channels.

If someone's behavior makes you uncomfortable, reach out to the maintainers. We will address it.
