# Security Policy

Thanks for helping keep FediHome — and the people who self-host it — safe.

## Reporting a vulnerability

**Please don't report security vulnerabilities through public GitHub issues, discussions, or pull requests** — a public report discloses the problem before a fix exists.

Instead, report it privately via GitHub's **[Report a vulnerability](https://github.com/TemujinCalidius/fedihome/security/advisories/new)** form (the repo's **Security → Advisories → Report a vulnerability**). Only the maintainers can see it.

Please include what you can:

- the affected file(s) / endpoint / version,
- the impact and how it could be exploited,
- steps to reproduce or a proof of concept,
- any suggested fix.

## What happens next

FediHome is small and mostly solo-maintained, so this is best-effort:

1. We aim to **acknowledge** your report within a few days.
2. We confirm the issue and develop a fix **privately**.
3. We **release the fix first**, then publish a **GitHub Security Advisory** (requesting a CVE where warranted) and **credit you** — unless you'd prefer to stay anonymous.

We practice **coordinated disclosure**: please give us a reasonable window to ship a fix before disclosing publicly.

## Supported versions

Security fixes ship against the **latest release** only. Keep your instance current with `npm run update`.

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Anything older | ❌ — please update |

## Scope

FediHome is **self-hosted**, so every instance is run independently.

- **In scope:** vulnerabilities in the **FediHome code in this repository**.
- **Out of scope here:** a specific deployment's misconfiguration, and bugs in third-party dependencies (report those upstream — though we're glad to hear about ones that materially affect FediHome).

A self-hosted instance is also only as safe as its setup: keep `ADMIN_SECRET` and `.env.local` secret, serve over HTTPS, and run the latest release.

## How we handle security internally

Most hardening lands openly as normal issues and PRs, and we run CodeQL, `npm audit`, and a daily triage. Genuinely sensitive, high-severity findings go through the private advisory process above instead, so a fix is available before any public disclosure.
