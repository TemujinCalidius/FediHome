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
 * That correctness fix would otherwise cost eight suites their stubs. Around
 * two dozen tests across `http-signatures`, `outbound-blocks`, `inbox-blocks`,
 * `profile-endpoint` and friends do `vi.stubGlobal("fetch", …)` — none of them
 * is testing undici. They are testing signature binding, block enforcement and
 * delivery classification, and they simply need *a* fetch they can stub.
 *
 * So undici's `fetch` delegates to whatever `globalThis.fetch` is at call time.
 * Everything else undici exports — `Agent` above all — is passed through
 * untouched, so `guardedDispatcher()` still builds a real Dispatcher.
 *
 * WHAT THIS DELIBERATELY DOES NOT WEAKEN. Two suites stand up real
 * `node:http` servers and drive the genuine undici `fetch` end to end —
 * `safe-fetch.test.ts` (18 tests) and `signed-fetch-redirects.test.ts` (9).
 * They never stub the global, so they exercise the real thing, and they are
 * what proved the fix against undici 8.9.0. And the structural guard in
 * `pinned-dispatcher.test.ts` reads `safe-fetch.ts` as source, so it catches a
 * regression to global fetch regardless of what is mocked here.
 */
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  };
});
