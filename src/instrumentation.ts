/**
 * Next.js instrumentation hook — runs once when the server boots (both
 * `next start` and `next dev`; NOT during `next build`).
 *
 * Starts FediHome's in-app scheduler (scheduled-post publishing, Bluesky
 * sync). The NEXT_RUNTIME guard + dynamic import keep the scheduler (and its
 * Prisma/@atproto imports) off any runtime that can't carry them.
 *
 * The guard is cheap insurance rather than a live constraint on Next 16: the
 * build manifest now reports `"/_middleware": { "runtime": "nodejs" }`, and the
 * compiled proxy lands in the Node server bundle, not the Edge one. It used to
 * be an Edge concern because src/proxy.ts existing caused register() to be
 * invoked there too.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The log tail, before anything else can log (#490). Two steps, in this
    // order and for different reasons:
    //
    //  1. resolve the redaction set FIRST, so the very first captured line is
    //     already scrubbed — the buffer is meant never to hold a plaintext
    //     credential, not to be cleaned up later;
    //  2. then tee the console.
    //
    // Neither can fail a boot: the refresh reads the database and decrypts, both
    // of which can be down, and a diagnostic must never be the reason an
    // instance won't start.
    try {
      const { refreshRedactionSet } = await import("@/lib/log-secrets");
      await refreshRedactionSet();
    } catch {
      /* the tail is still captured; the bundle re-resolves before emitting it */
    }
    const { installConsoleTee } = await import("@/lib/log-buffer");
    installConsoleTee();

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

    // One-shot, self-recording (#460). Awaited: it decides what the PUBLIC feed
    // shows, and serving one request with the pre-backfill answer is the leak
    // this is here to close. Cheap — a single indexed updateMany that matches
    // nothing on every boot after the first.
    const { backfillViaLookup } = await import("@/lib/lookup-backfill");
    await backfillViaLookup().catch((e) => console.error("[fedihome] #460 backfill failed", e));

    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
