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

### One CodeQL rule that is expected to be noisy

`js/request-forgery` reports a **critical** alert on `src/lib/safe-fetch.ts`, and
it is a false positive. Read this before dismissing or acting on one.

FediHome makes outbound requests to URLs chosen by remote servers — an actor URI
arrives inside an inbox activity, a signature's `keyId` is chosen by whoever
signed it. Every one of those goes through `guardedFetch`, which resolves and
validates the host on **every redirect hop** rather than once up front (#433).
CodeQL cannot see that: the check is a boolean guard on a local variable, and
`RequestForgeryConfig` has `isBarrier` but no `isBarrierGuard`, so no model can
express it. Verified against the CodeQL CLI rather than assumed — see #436.

**What to check when one of these appears**, because the rule is not useless, it
is narrowed:

- If the alert points at `src/lib/safe-fetch.ts`, it is the known one. Dismiss as
  a false positive.
- If it points **anywhere else in `src/`**, treat it as real. There is exactly one
  `fetch()` on a remote-controlled URL in the application, and it is that one. Any
  other is either a new call site that skipped `guardedFetch` — the bug #433
  existed to fix, across eight files — or a first-party host that has become
  remote-controlled.
- The one-chokepoint guarantee is about `src/`, **not** `scripts/`. The one-off
  maintenance scripts still call `fetch` directly on remote-controlled URLs and
  are not covered by `ssrf-call-sites.test.ts`. They are operator-run rather than
  reachable by a stranger, which is why they are a lower priority and not a
  quietly-broken promise — but do not read a clean scan as covering them.

So the rule still does its job on the case that matters. What it cannot do is
stay silent on the chokepoint itself.
