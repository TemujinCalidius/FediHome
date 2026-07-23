/**
 * Next.js instrumentation hook — runs once when the server boots (both
 * `next start` and `next dev`; NOT during `next build`).
 *
 * Starts FediHome's in-app scheduler (scheduled-post publishing, Bluesky
 * sync). The NEXT_RUNTIME guard + dynamic import keep the scheduler (and its
 * Prisma/@atproto imports) out of the Edge runtime, where register() is also
 * invoked because src/proxy.ts exists.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Federation identity first, and awaited (#326). getIdentity() is synchronous,
    // so the database overrides have to be in place BEFORE anything can serve a
    // request — a request answered mid-load would sign with the environment's
    // identity instead of the configured one, which is precisely the silent
    // actor-id mismatch that breaks federation with nothing in the logs.
    const { loadIdentity } = await import("@/lib/identity-store");
    await loadIdentity();

    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
