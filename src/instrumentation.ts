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

    // Guards run AFTER the overlay loads, or a perfectly good DB-configured
    // identity would be judged on the environment alone (#357, #362). The first
    // one THROWS on purpose — a production instance with an unreachable address
    // must not start, because what it publishes can't be taken back.
    const { assertUsableIdentity, markSetupCompleteIfConfigured } = await import("@/lib/boot-checks");
    assertUsableIdentity();
    await markSetupCompleteIfConfigured();

    // Diagnostic, not a gate — fire-and-forget so it can never delay or fail a
    // boot. Catches the silent case where ADMIN_SECRET changed and every stored
    // credential became unreadable (#359).
    // Consume ADMIN_PASSWORD once, if provisioning supplied one (#356). Awaited
    // so a scripted install can log in on its very first request rather than
    // racing the boot.
    const { consumeInitialPassword } = await import("@/lib/password");
    await consumeInitialPassword();

    const { checkStoredCredentials } = await import("@/lib/secret-health");
    void checkStoredCredentials();

    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
