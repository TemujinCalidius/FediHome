import { NextRequest, NextResponse } from "next/server";
import { resolveClient } from "@/lib/oauth-clients";
import crypto from "crypto";
import { verifyAdmin, verifyOrigin, hashToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { rateLimitKey } from "@/lib/client-ip";
import {
  validateRedirectUri,
  sanitizeScope,
  isValidCodeChallenge,
  escapeHtml,
  makeRateLimiter,
  bodyTooLarge,
  type OAuthClient,
} from "@/lib/oauth";

/**
 * OAuth 2.0 / IndieAuth authorization endpoint.
 *
 *   GET  — renders the owner login (if no admin session) then a consent screen.
 *   POST — the consent form; on approve mints a single-use PKCE-bound code and
 *          bounces back to the app's redirect URI.
 *
 * The owner authenticates on their OWN site (the existing ADMIN_SECRET login), so
 * the app never sees the secret — it only ever receives a scoped bearer token.
 *
 * CSP note: `form-action 'self'` (see next.config) means a server 302 to a custom
 * scheme after a form POST is blocked by WebKit. So the approve response is a 200
 * page that navigates to the redirect URI via a link/script, not a redirect.
 */

const CODE_TTL_MS = 60_000;
const authorizeLimiter = makeRateLimiter(20, 60_000);

const SCOPE_LABELS: Record<string, string> = {
  read: "Read your private feed, notifications, conversations and profile",
  create: "Create posts",
  update: "Edit your posts",
  delete: "Delete your posts",
  media: "Upload media",
  interact: "Like, boost, reply, follow and block",
  dm: "Read and send direct messages",
  manage: "Moderate comments and run maintenance tasks",
};

interface AuthzParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  responseType: string;
  codeChallengeMethod: string;
}

function readParams(get: (k: string) => string | null): AuthzParams {
  return {
    clientId: get("client_id") ?? "",
    redirectUri: get("redirect_uri") ?? "",
    scope: get("scope") ?? "",
    state: get("state") ?? "",
    codeChallenge: get("code_challenge") ?? "",
    responseType: get("response_type") ?? "",
    codeChallengeMethod: get("code_challenge_method") ?? "",
  };
}

/**
 * Validate the request. Returns the resolved client + sanitized scope, or an
 * error string. `redirectValidated` says whether redirect_uri is trusted (so the
 * caller knows an error page is mandatory vs. a redirect would be safe).
 */
async function validate(
  p: AuthzParams,
  /** Rate-limit key, spent only if the id is a URL we have to go and fetch (#494). */
  rateKey: string,
): Promise<{ ok: true; client: OAuthClient; scope: string } | { ok: false; error: string }> {
  // resolveClient, not getClient (#366): first-party ids resolve with no query,
  // and only an id that is neither first-party nor cached-as-missing reaches the
  // database. A URL id is fetched and read instead (#494), under its own budget.
  const client = await resolveClient(p.clientId, rateKey);
  if (!client) {
    // Name the actual constraint (#486). The site advertises the IndieAuth
    // discovery contract on every page — authorization_endpoint, token_endpoint,
    // indieauth-metadata — so a third-party client finds these endpoints,
    // follows the spec exactly, and lands here. "Unknown application" reads as a
    // broken site, and the operator gets a bug report with nothing in their logs
    // or admin panel to explain it. Say what is true and what to do instead.
    return {
      ok: false,
      error:
        "This app couldn't be verified. A web app is checked by fetching its client ID, " +
        "so that address has to be reachable and has to list this redirect; an app with a " +
        "custom link scheme can't be checked that way at all and has to be registered by " +
        "hand. If you own this site, add it in Admin → Connected apps — you'll need its " +
        "client ID and redirect URI — or generate a scoped token and paste it into the app.",
    };
  }
  if (!validateRedirectUri(client, p.redirectUri)) {
    return { ok: false, error: "The redirect URI is not registered for this application." };
  }
  if (p.responseType !== "code") {
    return { ok: false, error: "Unsupported response_type (only 'code' is allowed)." };
  }
  if (p.codeChallengeMethod !== "S256") {
    return { ok: false, error: "PKCE is required with code_challenge_method=S256." };
  }
  if (!isValidCodeChallenge(p.codeChallenge)) {
    return { ok: false, error: "Malformed code_challenge." };
  }
  const scope = sanitizeScope(p.scope);
  if (!scope) return { ok: false, error: "No valid scopes were requested." };
  return { ok: true, client, scope };
}

// === HTML rendering (self-contained — a route handler doesn't ship app CSS) ===

function shell(title: string, body: string): NextResponse {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0b0d12; color:#e6e8ee; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:24px; }
  .card { width:100%; max-width:420px; background:#141821; border:1px solid #232a37; border-radius:16px; padding:28px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#98a2b3; font-size:13px; margin:0 0 20px; }
  ul.scopes { list-style:none; padding:0; margin:0 0 22px; }
  ul.scopes li { display:flex; gap:10px; padding:9px 0; border-top:1px solid #1e2531; font-size:14px; color:#cbd3e1; }
  ul.scopes li:first-child { border-top:0; }
  ul.scopes li::before { content:"✓"; color:#6ee7a8; font-weight:700; }
  input[type=password] { width:100%; background:#0f131b; border:1px solid #2a3342; border-radius:10px;
    padding:11px 13px; color:#fff; font-size:14px; margin-bottom:12px; }
  input:focus { outline:none; border-color:#5b8cff; }
  .row { display:flex; gap:10px; }
  button, .btn { flex:1; border:0; border-radius:10px; padding:11px 14px; font-size:14px; font-weight:600;
    cursor:pointer; text-align:center; text-decoration:none; display:inline-block; }
  .primary { background:#5b8cff; color:#fff; }
  .ghost { background:#1c2431; color:#c7cfdd; }
  .err { color:#ff8a8a; font-size:13px; margin:0 0 12px; }
  .muted { color:#6b7486; font-size:12px; margin-top:16px; word-break:break-all; }
  .app { color:#fff; font-weight:600; }
</style></head><body><div class="card">${body}</div></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function errorPage(message: string): NextResponse {
  return shell(
    "Authorization error",
    `<h1>Authorization error</h1><p class="sub">This request can't be completed.</p>
     <p class="err">${escapeHtml(message)}</p>
     <p class="muted">If you opened this from an app, close this window and try connecting again.</p>`
  );
}

function loginPage(p: AuthzParams, client: OAuthClient): NextResponse {
  return shell(
    "Sign in",
    `<h1>Sign in to authorize</h1>
     <p class="sub"><span class="app">${escapeHtml(client.label)}</span> wants to connect to your FediHome. Sign in with your admin password to continue.</p>
     <form id="login" autocomplete="off">
       <input type="password" id="pw" placeholder="Admin password" autofocus>
       <p class="err" id="err" hidden>Incorrect password.</p>
       <button type="submit" class="primary">Sign in</button>
     </form>
     <script>
       (function(){
         var f=document.getElementById('login');
         f.addEventListener('submit',function(e){
           e.preventDefault();
           var err=document.getElementById('err'); err.hidden=true;
           fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
             body:JSON.stringify({password:document.getElementById('pw').value})})
             .then(function(r){ if(r.ok){location.reload();} else {err.hidden=false;} })
             .catch(function(){err.hidden=false;});
         });
       })();
     </script>`
  );
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

/**
 * Say WHICH KIND of app this is, and therefore what the owner is trusting (#494).
 *
 * The three are not interchangeable, and the screen used to render all three
 * identically as a label:
 *
 *  - first-party  — ships in FediHome.
 *  - registered   — the owner vouched for it themselves, because nothing about a
 *                   custom link scheme can be verified.
 *  - indieauth    — the client id is a URL, and its DOCUMENT is what vouched for
 *                   the redirect. So the URL is shown, because it is the only
 *                   part of that claim the owner can check with their own eyes —
 *                   the name came from a page a stranger controls.
 */
function provenanceNote(client: OAuthClient): string {
  if (client.kind === "first-party") {
    return `<p class="muted">A FediHome app.</p>`;
  }
  if (client.kind === "registered") {
    return `<p class="muted">You registered this app yourself in Connected apps.</p>`;
  }
  return (
    `<p class="muted">Verified by fetching <strong>${escapeHtml(client.id)}</strong>. ` +
    `The name above comes from that page — check the address is one you recognise.</p>`
  );
}

function consentPage(p: AuthzParams, client: OAuthClient, scope: string): NextResponse {
  const items = scope
    .split(" ")
    .map((s) => `<li>${escapeHtml(SCOPE_LABELS[s] ?? s)}</li>`)
    .join("");
  return shell(
    "Authorize app",
    `<h1>Authorize <span class="app">${escapeHtml(client.label)}</span></h1>
     ${provenanceNote(client)}
     <p class="sub">This app is asking to:</p>
     <ul class="scopes">${items}</ul>
     <form method="POST" action="/api/oauth/authorize">
       ${hidden("client_id", p.clientId)}
       ${hidden("redirect_uri", p.redirectUri)}
       ${hidden("scope", scope)}
       ${hidden("state", p.state)}
       ${hidden("code_challenge", p.codeChallenge)}
       ${hidden("code_challenge_method", p.codeChallengeMethod)}
       ${hidden("response_type", p.responseType)}
       <div class="row">
         <button type="submit" name="decision" value="deny" class="ghost">Deny</button>
         <button type="submit" name="decision" value="approve" class="primary">Authorize</button>
       </div>
     </form>
     <p class="muted">You can revoke access any time from your dashboard.</p>`
  );
}

/** Build the redirect URL. Validated redirect URIs never carry a query, so "?". */
function buildRedirect(redirectUri: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  if (!qs) return redirectUri;
  return `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}${qs}`;
}

/**
 * Terminal page that hands control back to the app. Navigating to the (custom
 * scheme / loopback) redirect URI happens via a link + script — NOT a server
 * 302 — because `form-action 'self'` would block a post-form redirect to a
 * custom scheme. The URL only ever lives in an HTML attribute (escaped), never
 * interpolated into JS, so there's no injection path.
 */
function returnToApp(target: string, label: string): NextResponse {
  return shell(
    "Returning to the app",
    `<h1>Returning to <span class="app">${escapeHtml(label)}</span>…</h1>
     <p class="sub">If nothing happens, tap the button below.</p>
     <a id="return" class="btn primary" href="${escapeHtml(target)}">Return to ${escapeHtml(label)}</a>
     <script>(function(){var a=document.getElementById('return');if(a&&a.href)location.replace(a.href);})();</script>`
  );
}

export async function GET(req: NextRequest) {
  const p = readParams((k) => req.nextUrl.searchParams.get(k));
  // This handler has no rate limit of its own — `authorizeLimiter` guards POST
  // only — which was safe while an unknown id cost zero queries. A URL id costs
  // an outbound fetch, so the key is threaded through and spent inside
  // resolveClient, on cache misses alone (#494).
  const v = await validate(p, rateLimitKey(req));
  if (!v.ok) return errorPage(v.error);

  if (!(await verifyAdmin(req))) {
    return loginPage(p, v.client);
  }
  return consentPage(p, v.client, v.scope);
}

export async function POST(req: NextRequest) {
  // Same-site cookie-authenticated form submission → CSRF-gated.
  if (!verifyOrigin(req)) {
    return errorPage("Invalid request origin.");
  }
  if (!authorizeLimiter.check(rateLimitKey(req), Date.now())) {
    return shell("Slow down", `<h1>Too many requests</h1><p class="sub">Please wait a moment and try again.</p>`);
  }
  if (bodyTooLarge(req)) {
    return errorPage("Request body too large.");
  }
  if (!(await verifyAdmin(req))) {
    // Session expired between rendering and submit — the app restarts the flow.
    return errorPage("Your session expired. Restart the connection from the app.");
  }

  const form = await req.formData().catch(() => null);
  if (!form) return errorPage("Malformed request.");
  const p = readParams((k) => {
    const val = form.get(k);
    return typeof val === "string" ? val : null;
  });
  const decision = form.get("decision");

  const v = await validate(p, rateLimitKey(req));
  if (!v.ok) return errorPage(v.error);

  // Deny → hand an OAuth error back to the app (redirect URI is validated now).
  if (decision !== "approve") {
    const target = buildRedirect(p.redirectUri, { error: "access_denied", state: p.state });
    return returnToApp(target, v.client.label);
  }

  // Approve → mint a single-use, PKCE-bound authorization code.
  const now = Date.now();
  const code = crypto.randomBytes(32).toString("hex");
  const codeHash = hashToken(code);
  // Opportunistically sweep expired codes so the table can't grow unbounded.
  await prisma.authorizationCode
    .deleteMany({ where: { expiresAt: { lt: new Date(now) } } })
    .catch(() => {});
  await prisma.authorizationCode.create({
    data: {
      codeHash,
      clientId: v.client.id,
      redirectUri: p.redirectUri,
      scope: v.scope,
      codeChallenge: p.codeChallenge,
      expiresAt: new Date(now + CODE_TTL_MS),
    },
  });

  const target = buildRedirect(p.redirectUri, { code, state: p.state });
  return returnToApp(target, v.client.label);
}
