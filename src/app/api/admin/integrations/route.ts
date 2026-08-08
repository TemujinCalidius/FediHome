import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import {
  getIntegrationStatus,
  setBlueskyCredentials,
  clearBlueskyCredentials,
  testBlueskyLogin,
  setBlueskyService,
  validateBlueskyService,
  rememberBlueskyDid,
  checkDomainHandle,
  getBlueskyCredentials,
  setThreadsCredentials,
  clearThreadsCredentials,
  testThreadsToken,
  setDayOneCredentials,
  clearDayOneCredentials,
} from "@/lib/integrations";
import { secretBoxAvailable } from "@/lib/secret-box";
import { getIdentity } from "@/lib/identity";
import { applySiteConfig } from "@/lib/site-settings";

/**
 * Admin crosspost integrations (#59): configure Bluesky + Threads credentials
 * in-app instead of editing `.env.local`. Secrets are stored AES-256-GCM-
 * encrypted (secret-box, key from ADMIN_SECRET) and are NEVER returned to the
 * client — GET reports only a configured/handle/source status.
 *
 * Cookie-only ON PURPOSE (`verifyAdmin`, no bearer path): these are owner-only
 * credentials, an app token must never read or reconfigure them — same stance
 * as /api/admin/settings and /api/admin/site-config.
 *
 * `save` tests the connection FIRST and refuses to store a credential that
 * doesn't authenticate, so a wrong password can't be silently persisted.
 */

const CONTROL = /[\r\n]/;
function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max || CONTROL.test(t)) return null;
  return t;
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    status: await getIntegrationStatus(),
    encryptionAvailable: secretBoxAvailable(),
  });
}

export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const provider = body?.provider;
  if (provider !== "bluesky" && provider !== "threads" && provider !== "dayone") {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }

  // Disconnect — clear the DB override (reverts to the env var if set).
  if (action === "disconnect") {
    if (provider === "bluesky") await clearBlueskyCredentials();
    else if (provider === "dayone") await clearDayOneCredentials();
    else await clearThreadsCredentials();
    return NextResponse.json({ success: true, status: await getIntegrationStatus() });
  }

  // Ahead of the allowlist and the handle/password guard below: these actions need
  // neither, because they read the identity and credentials already stored (#448).
  if (provider === "bluesky" && action === "set-domain-handle") {
    const enabled = body?.enabled === true;

    // Capture the DID BEFORE writing the setting, when enabling.
    //
    // The owner's next step is to change their handle in the Bluesky app, and
    // Bluesky verifies the record AT THAT MOMENT. So the endpoint has to be live
    // the instant the toggle goes on — but an instance configured before this
    // feature existed has no DID yet, and the route correctly 404s without one.
    // Left to the lazy capture in getBlueskyAgent, that gap lasts until the next
    // Bluesky sync: up to fifteen minutes of the feature looking broken.
    //
    // Uses the STORED credentials, never anything from the request. Persisting a
    // DID proved by some other handle would pair it with the saved password and
    // break every login — the DID outranks the handle, so it would win silently.
    if (enabled) {
      try {
        const { getBlueskyAgent } = await import("@/lib/bluesky-agent");
        await getBlueskyAgent();
      } catch {
        return NextResponse.json(
          { error: "Couldn't reach Bluesky to confirm your account. Check the connection above, then try again." },
          { status: 400 },
        );
      }
      const creds = await getBlueskyCredentials();
      if (!creds?.did) {
        return NextResponse.json(
          { error: "Connected to Bluesky but couldn't read your account id. Try saving your credentials again." },
          { status: 400 },
        );
      }
    }

    const applied = await applySiteConfig({ "bluesky.domainHandle": enabled ? "true" : "false" });
    if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 400 });
    return NextResponse.json({ success: true, enabled });
  }

  if (provider === "bluesky" && action === "verify-domain") {
    // The configured identity, never a client-supplied domain — taking it from the
    // request body would make this a handle-lookup proxy for anyone with admin.
    const { fediDomain } = getIdentity();
    return NextResponse.json({ domain: fediDomain, ...(await checkDomainHandle(fediDomain)) });
  }

  if (action !== "test" && action !== "save") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  if (provider === "bluesky") {
    const handle = clean(body?.handle, 400);
    const password = clean(body?.password, 200);
    if (!handle || !password) {
      return NextResponse.json({ error: "Handle and app password are required." }, { status: 400 });
    }

    // The PDS, and NOT through `clean()` (#504). `clean` maps an empty string to
    // null, which is the one value that has to survive here: submitting the
    // field blank is how an operator goes back to bsky.social, and it must be
    // distinguishable from not sending the field at all.
    const rawService = typeof body?.service === "string" ? body.service.trim() : undefined;
    if (rawService !== undefined && (rawService.length > 400 || /[\r\n]/.test(rawService))) {
      return NextResponse.json({ error: "That PDS address isn't valid." }, { status: 400 });
    }
    // Validate BEFORE the login, so a typo'd host reports itself as a bad
    // address rather than as a failed sign-in — which is what it would look
    // like, since we would then try to log in to the wrong place.
    if (rawService && !validateBlueskyService(rawService)) {
      return NextResponse.json(
        {
          error:
            "Use a bare https:// address for your PDS, reachable from the internet — for example https://pds.example.com.",
        },
        { status: 400 },
      );
    }

    // The host under test, not the saved one: the Test button has to exercise
    // the address about to be saved or it verifies nothing. This third argument
    // has existed since #449 and had no caller until now.
    const t = await testBlueskyLogin(handle, password, rawService || undefined);
    if (action === "test") return NextResponse.json(t);
    if (!t.ok) {
      return NextResponse.json(
        { error: `Bluesky login failed — check the handle and app password. (${t.error || "unknown"})` },
        { status: 400 },
      );
    }
    const r = await setBlueskyCredentials(handle, password);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    // After the credentials, not before: every failure above returns early, and
    // a service row written for an account that then failed to save would point
    // the NEXT set of credentials at a host the operator never chose for them.
    // (setBlueskyCredentials itself only drops the DID — it is
    // clearBlueskyCredentials, on disconnect, that clears the service row.)
    if (rawService !== undefined) {
      const sv = await setBlueskyService(rawService);
      if (!sv.ok) return NextResponse.json({ error: sv.error }, { status: 400 });
    }
    // Persist the DID the login just proved. It is the identifier every later
    // login uses, so that a handle change — including pointing it at this very
    // domain (#448) — doesn't quietly break crossposting. After
    // setBlueskyCredentials, which clears any DID belonging to the old account.
    if (t.did) await rememberBlueskyDid(t.did);
    return NextResponse.json({ success: true, status: await getIntegrationStatus() });
  }

  if (provider === "dayone") {
    // No "test" action: unlike Bluesky and Threads there is no cheap way to
    // verify an SMTP credential without actually sending mail to the owner's
    // journal, which would put a stray entry in it every time they saved.
    const dayOneEmail = clean(body?.dayOneEmail, 320);
    const host = clean(body?.host, 253);
    const user = clean(body?.user, 320);
    const pass = clean(body?.pass, 400);
    const port = Number.parseInt(String(body?.port ?? "587"), 10);
    if (!dayOneEmail || !host || !user || !pass) {
      return NextResponse.json(
        { error: "Journal address, SMTP host, username and password are all required." },
        { status: 400 },
      );
    }
    if (!dayOneEmail.includes("@")) {
      return NextResponse.json({ error: "That journal address doesn't look like an email address." }, { status: 400 });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return NextResponse.json({ error: "That isn't a valid port number." }, { status: 400 });
    }
    const r = await setDayOneCredentials({ dayOneEmail, host, port, user, pass });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, status: await getIntegrationStatus() });
  }

  // provider === "threads"
  const userId = clean(body?.userId, 100);
  const accessToken = clean(body?.accessToken, 1000);
  if (!userId || !accessToken) {
    return NextResponse.json({ error: "User ID and access token are required." }, { status: 400 });
  }
  const t = await testThreadsToken(userId, accessToken);
  if (action === "test") return NextResponse.json(t);
  if (!t.ok) {
    return NextResponse.json(
      { error: `Threads check failed — verify the token and user ID. (${t.error || "unknown"})` },
      { status: 400 },
    );
  }
  const r = await setThreadsCredentials(userId, accessToken);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ success: true, status: await getIntegrationStatus() });
}
