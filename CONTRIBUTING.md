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
- **Next.js App Router** conventions. Pages go in `src/app/`, API routes use `route.ts` files, and shared components live in `src/components/`.
- Prefer named exports for components and utility functions.
- Keep files focused: one component per file, one API route per file.

## Making a Pull Request

1. **Fork** the repository on GitHub.
2. **Create a branch** from `main`:
   ```bash
   git checkout -b my-feature
   ```
3. **Implement your change.** Write clear, typed code. Add comments where the "why" is not obvious.
4. **Test locally.** Make sure the dev server starts, the feature works, and existing functionality is not broken. Run the linter:
   ```bash
   npm run lint
   ```
5. **Commit** with a clear message describing what the change does and why:
   ```bash
   git commit -m "Add photo category filtering to gallery page"
   ```
6. **Push** and open a pull request against `main`:
   ```bash
   git push origin my-feature
   ```
7. In the PR description, explain:
   - What the change does
   - Why it is needed
   - How to test it
   - Screenshots if there are UI changes

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
