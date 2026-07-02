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
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
