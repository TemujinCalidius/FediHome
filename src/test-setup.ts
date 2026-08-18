import { vi } from "vitest";

/**
 * THE SUITE MUST NOT READ THE MACHINE'S ENVIRONMENT.
 *
 * Reported from the demo instance, about the storage tests: "the storage test
 * only passes on a machine with no uploads." That one was a filesystem
 * dependency (#574). This is the same failure in its other form — a test that
 * silently reads whatever the operator happens to have exported.
 *
 * Eleven tests across four files failed under a plausible live-install
 * environment, and every one of them is a variable an operator is DOCUMENTED to
 * set:
 *
 *   TRUSTED_PROXY=true        → 6 in oauth-authorize, 1 in client-ip
 *   SITE_URL=<anything>       → 1 in setup-route
 *   FEDIHOME_UPDATE_TEXT=…    → 3 in install-shape
 *
 * Every one of those tests asserts the behaviour for the variable being ABSENT,
 * and none of them says so. On a maintainer's laptop that is invisible; on the
 * box that actually runs FediHome it is a suite that cannot be trusted — which
 * is exactly where someone reaches for it.
 *
 * Clearing them HERE rather than in each file is deliberate. `setupFiles` runs
 * once per test file and before that file's imports, so a module that reads
 * `process.env` at import time sees the cleared value too — which per-file hooks
 * cannot promise. It also covers tests written later, and the per-file version
 * of this has already been forgotten four times.
 *
 * A test that wants a variable SET still sets it; that is unaffected, and is how
 * every one of these files already works. What changes is that "unset" now means
 * unset everywhere instead of meaning "unset on the maintainer's machine".
 *
 * Deleting is safe and does not leak: process.env is per test-file here (each
 * file runs in its own worker environment), so this neither sees nor disturbs
 * the shell the suite was launched from.
 *
 * NOT CLEARED, on purpose:
 *   NODE_ENV, PORT — Node's and Vitest's own, not FediHome's to take.
 *   DATABASE_URL   — Prisma reads it at client construction; tests mock the
 *                    client rather than assert this is absent.
 */
for (const name of [
  "SITE_URL",
  "FEDI_HANDLE",
  "FEDI_DOMAIN",
  "ADMIN_SECRET",
  "ADMIN_PASSWORD",
  "SETUP_TOKEN",
  "FEDIHOME_UPLOADS_DIR",
  "FEDIHOME_FEDI_CACHE_MB",
  "FEDIHOME_UPDATE_URL",
  "FEDIHOME_UPDATE_TEXT",
  "FEDIHOME_STANDALONE",
  "BLUESKY_HANDLE",
  "BLUESKY_APP_PASSWORD",
  "BLUESKY_SERVICE",
  "THREADS_USER_ID",
  "THREADS_ACCESS_TOKEN",
  "TRUSTED_PROXY",
  "TRUSTED_PROXY_HEADER",
  "APP_TOKEN_TTL_DAYS",
  "ADMIN_SESSION_TTL_DAYS",
]) {
  delete process.env[name];
}

/**
 * Let a test stub `globalThis.fetch` and still intercept `guardedFetch` (#506).
 *
 * `safe-fetch.ts` calls **undici's** `fetch`, not the global one, and it has to:
 * `dispatcher` is honoured only by the undici copy that built the Agent, so
 * handing an Agent from `node_modules/undici` to Node's bundled fetch is the
 * version mismatch that breaks every outbound request the moment the userland
 * copy moves to 8.x.
 *
 * That correctness fix would otherwise cost seven suites their stubs. Around two
 * dozen tests across `outbound-blocks`, `block-unblock`, `actor-actions-api`,
 * `inbox-blocks`, `deliver-followers-enqueue`, `conversation-blocks` and
 * `profile-endpoint` do `vi.stubGlobal("fetch", …)` or `global.fetch = vi.fn()`.
 * None of them is testing undici. They are testing signature binding, block
 * enforcement and delivery classification, and they simply need *a* fetch they
 * can stub.
 *
 * WHY THE IDENTITY CHECK, AND NOT AN UNCONDITIONAL DELEGATE. The first version
 * of this file delegated always, which silently reintroduced the exact
 * cross-copy pairing the fix removes — a userland Agent handed to the bundled
 * fetch — in EVERY suite, including the two that are supposed to prove the fix.
 * Production was spotless and the harness undid it four lines away.
 *
 * So: delegate only when something has actually replaced the global. When
 * nothing has, real undici handles the request, which is what the real-server
 * suites need in order to mean anything.
 *
 * Compared with `globalThis.fetch !== pristineFetch` rather than
 * `vi.isMockFunction(...)` deliberately. The latter duck-types a private
 * `_isMockFunction` property, so a plain-function stub —
 * `vi.stubGlobal("fetch", async () => new Response(…))`, perfectly idiomatic —
 * would fall through and make a REAL network call, failing with a DNS error that
 * points nowhere near this file. Identity catches every stub form.
 *
 * IF YOU CHANGE THIS FILE, RE-RUN THE PROOF — a proof that cannot fail proves
 * nothing. Run:
 *
 *     npx vitest run src/lib/__tests__/safe-fetch.test.ts \
 *       src/lib/__tests__/signed-fetch-redirects.test.ts \
 *       src/lib/__tests__/pinned-dispatcher.test.ts
 *
 * That must be green (40/40). Then revert only the `undiciFetch` swap in
 * `safe-fetch.ts` and confirm the failures return — 24 of 40 at undici 8.10.
 *
 * Since #506 the userland copy IS 8.x, so the mismatch is live rather than
 * hypothetical and the control fails on the checked-out tree. While both copies
 * were 6.x the handler shapes agreed, which is why this needed a manual bump to
 * demonstrate at all.
 */

/**
 * Node's own `fetch`, captured before any test can replace it. `setupFiles` runs
 * once per test FILE and before that file's imports, so this is always the real
 * one and never a leftover stub from another file.
 */
const pristineFetch = globalThis.fetch;

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (...args: Parameters<typeof globalThis.fetch>) =>
      globalThis.fetch === pristineFetch
        ? (actual.fetch as unknown as typeof globalThis.fetch)(...args)
        : globalThis.fetch(...args),
  };
});
