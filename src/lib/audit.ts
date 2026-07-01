import { prisma } from "./db";

/**
 * App API audit log (#158). Records a coarse per-request trail (method + path)
 * for connected apps so the owner can see which token/app performed which write
 * action, and when. Best-effort — never blocks or fails a request.
 */

interface TokenMeta {
  tokenId?: string;
  clientId?: string | null;
  label?: string;
  scope?: string;
}
interface ReqMeta {
  method?: string;
  nextUrl?: { pathname: string };
}

/** Record a bearer-token write/action. Call fire-and-forget (`void`). */
export async function recordTokenUse(token: TokenMeta, req: ReqMeta): Promise<void> {
  try {
    await prisma.appTokenUsage.create({
      data: {
        tokenId: token.tokenId ?? null,
        clientId: token.clientId ?? null,
        label: token.label || "unknown",
        scope: token.scope || "",
        method: (req.method || "?").slice(0, 8),
        path: (req.nextUrl?.pathname || "?").slice(0, 512),
      },
    });
  } catch {
    // best-effort audit; swallow
  }
}

const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let lastAuditPrune = 0;

/**
 * Prune audit rows older than the retention window (30 days). Throttled to once
 * / hour per process so it's cheap to call from a frequently-polled path.
 */
export async function pruneTokenUsage(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastAuditPrune < 60 * 60 * 1000) return 0;
  lastAuditPrune = now;
  try {
    const res = await prisma.appTokenUsage.deleteMany({
      where: { at: { lt: new Date(now - AUDIT_RETENTION_MS) } },
    });
    return res.count;
  } catch {
    return 0;
  }
}
