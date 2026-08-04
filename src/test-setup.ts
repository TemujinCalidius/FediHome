import { vi } from "vitest";

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
 * IF YOU CHANGE THIS FILE, RE-RUN THE PROOF. A green suite at the pinned undici
 * says nothing about the mismatch, because at 6.x-vs-6.x the handler shapes
 * agree. In a throwaway copy of the repo:
 *
 *     npm install undici@8.10.0
 *     npx vitest run src/lib/__tests__/safe-fetch.test.ts \
 *       src/lib/__tests__/signed-fetch-redirects.test.ts \
 *       src/lib/__tests__/pinned-dispatcher.test.ts
 *
 * That must be green. Then revert only the `undiciFetch` swap in `safe-fetch.ts`
 * and confirm the 22 failures return — a proof that cannot fail proves nothing.
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
