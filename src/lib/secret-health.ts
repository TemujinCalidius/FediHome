import { prisma } from "./db";
import { decryptSecret, secretBoxAvailable } from "./secret-box";

/**
 * Notice when stored credentials have become undecryptable (#359).
 *
 * `ADMIN_SECRET` derives the key that encrypts every saved credential. If it's
 * lost, rotated, or regenerated, those ciphertexts can never be read again —
 * and the failure is completely silent. `decryptSecret()` returns `null` rather
 * than throwing, so push notifications simply stop arriving and crossposting
 * simply stops happening, with nothing in the logs and the values still showing
 * as "configured" in the admin panel.
 *
 * It's easy to hit by accident: `ADMIN_SECRET` lives only in `.env.local`, so a
 * database backup does NOT contain it. Restoring a database onto a host with a
 * freshly generated secret produces exactly this state.
 *
 * Reuses the #310 alerting idiom verbatim — `upsert` with an empty `update`, so
 * a dismissed alert is never resurrected and repeated boots don't spam. The
 * notification bell already renders these with Dismiss / Mark-applied actions.
 */

/** Every credential the secret box holds, with a human name for the alert. */
const ENCRYPTED_CREDENTIALS: { key: string; label: string }[] = [
  { key: "integration.push.privateKey", label: "Web Push (phone notifications)" },
  { key: "integration.bluesky.password", label: "Bluesky app password" },
  { key: "integration.threads.accessToken", label: "Threads access token" },
  { key: "integration.tinylytics.apiKey", label: "Tinylytics API key" },
];

const ALERT = {
  kind: "security",
  packageName: "stored-credentials",
  latest: "undecryptable",
} as const;

/**
 * Which stored credentials exist but can no longer be decrypted.
 *
 * Only counts values that are actually ciphertext (`v1:`) — a legacy plaintext
 * row or an unrelated setting isn't a key problem.
 */
export async function findUndecryptableCredentials(): Promise<string[]> {
  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: ENCRYPTED_CREDENTIALS.map((c) => c.key) } },
  });

  const broken: string[] = [];
  for (const row of rows) {
    if (typeof row.value !== "string" || !row.value.startsWith("v1:")) continue;
    if (decryptSecret(row.value) === null) {
      broken.push(ENCRYPTED_CREDENTIALS.find((c) => c.key === row.key)?.label ?? row.key);
    }
  }
  return broken;
}

/**
 * Check, and raise a maintenance alert if anything is unreadable.
 *
 * Never throws — this is a diagnostic, and a diagnostic must not be the reason
 * a boot fails.
 */
export async function checkStoredCredentials(): Promise<void> {
  try {
    const broken = await findUndecryptableCredentials();
    if (broken.length === 0) return;

    const list = broken.join(", ");
    const cause = secretBoxAvailable()
      ? "Your ADMIN_SECRET has changed since these were saved, so the key that decrypts them no longer matches."
      : "ADMIN_SECRET isn't set, so there is no key to decrypt them with.";

    console.error(
      `\n[FediHome] ⚠️  Stored credentials can no longer be decrypted: ${list}.\n` +
        `           ${cause}\n` +
        `           They will keep appearing as configured while silently not working. Re-enter them in the admin panel.\n`,
    );

    await prisma.maintenanceItem.upsert({
      where: { kind_packageName_latest: { ...ALERT } },
      update: {}, // already flagged — never resurrect a dismissed alert
      create: {
        ...ALERT,
        severity: "high",
        title: "Saved credentials can't be read any more",
        description:
          `These are stored encrypted and can no longer be decrypted: ${list}. ${cause} ` +
          `Until they're re-entered they will keep looking configured while silently doing nothing — ` +
          `push notifications aren't delivered, crossposting doesn't happen, analytics don't report. ` +
          `Re-enter each one in the admin panel to fix it. ` +
          `Worth knowing: ADMIN_SECRET lives only in .env.local, so a database backup does not include it — ` +
          `back it up separately, or restoring a database onto a new host reproduces this.`,
        url: "https://github.com/TemujinCalidius/FediHome/issues/359",
      },
    });
  } catch (err) {
    console.error("[fedihome] couldn't check stored credentials:", err);
  }
}
