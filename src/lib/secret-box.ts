import crypto from "crypto";

/**
 * Symmetric secret box for encrypting integration credentials at rest (crosspost
 * app passwords / API tokens configured in the admin panel).
 *
 * AES-256-GCM with a key derived from `ADMIN_SECRET` — which lives in the server
 * environment and is NEVER stored in the database. So a database dump/backup
 * leak alone can't reveal a stored secret: an attacker also needs the host's
 * `ADMIN_SECRET`. (A full host compromise exposes both, exactly as reading the
 * plain env vars would today — this defends the far more common DB-leak vector.)
 *
 * GCM's auth tag also detects tampering. Ciphertext format:
 *   "v1:" + base64( iv[12] || tag[16] || ciphertext )
 * Rotating `ADMIN_SECRET` makes existing ciphertexts undecryptable (decrypt →
 * null); the owner simply re-enters the credential once.
 */

const PREFIX = "v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * 32-byte key derived from ADMIN_SECRET via HMAC-SHA256 with a fixed domain-
 * separation label. ADMIN_SECRET is already high-entropy (64–128 hex chars),
 * so an HMAC KDF is appropriate (no need for a slow password hash). Returns null
 * when ADMIN_SECRET isn't set (encryption unavailable pre-setup).
 */
function deriveKey(): Buffer | null {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("fedihome:secret-box:v1").digest();
}

/** True when encryption is available (ADMIN_SECRET is configured). */
export function secretBoxAvailable(): boolean {
  return !!process.env.ADMIN_SECRET;
}

/** Encrypt a UTF-8 secret. Returns the "v1:"-prefixed token, or null if no key. */
export function encryptSecret(plaintext: string): string | null {
  const key = deriveKey();
  if (!key) return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt a token produced by encryptSecret. Returns null on any failure —
 * wrong key (ADMIN_SECRET rotated), tampered ciphertext (GCM tag mismatch),
 * malformed input, or a non-"v1:" value.
 */
export function decryptSecret(token: string): string | null {
  const key = deriveKey();
  if (!key || typeof token !== "string" || !token.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(token.slice(PREFIX.length), "base64");
    if (raw.length < IV_LEN + TAG_LEN) return null;
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
