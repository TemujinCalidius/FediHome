import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hasScope, verifyTokenValue, type TokenVerification } from "@/lib/auth";
import { recordTokenUse } from "@/lib/audit";
import { sanitizeHtml } from "@/lib/sanitize";
import { marked } from "marked";
import { extractParam, extractStruct, between } from "@/lib/xmlrpc";
import { rateLimitKey } from "@/lib/client-ip";
import { buildPostObject } from "@/lib/ap-post";
import { deletePostWithFederation } from "@/lib/delete-post";
import { getSiteUrl } from "@/lib/identity";

/**
 * XML-RPC endpoint (MetaWeblog API) for compatibility with micro.blog app
 * and other blogging clients that don't support Micropub.
 *
 * Auth: Micropub bearer tokens only (the password parameter is treated as a
 * Micropub token and looked up in AuthToken). The legacy ADMIN_SECRET
 * fallback was removed — a single high-entropy secret over an unrate-limited
 * XML-RPC endpoint is a brute-force liability.
 *
 * The token goes through `verifyTokenValue` — the SAME check every other bearer
 * path uses. It used to have its own verifier here that returned `!!token`, which
 * meant this route alone honoured neither `expiresAt` nor `scope`: an expired
 * token kept working, and a token narrowed to `read` in /admin/apps could still
 * create and delete posts. The admin UI tells owners "a reduced scope takes
 * effect on the token's next request"; over XML-RPC that was simply untrue.
 *
 * Rate limit: per-bucket, same TRUSTED_PROXY model as the admin login route.
 */

const RATE_MAX_ATTEMPTS = 10;
const RATE_WINDOW_MS = 60_000;
// XML-RPC requests are small (text posts at most — no media upload is wired up).
// Cap the body so parsing work is bounded regardless of input.
const MAX_REQUEST_CHARS = 1_000_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || entry.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX_ATTEMPTS;
}

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

/** Escape characters that are special in XML text. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap text safely in CDATA, splitting any internal `]]>` so it can't terminate the section. */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function methodResponse(params: string): string {
  return `<?xml version="1.0"?>
<methodResponse><params>${params}</params></methodResponse>`;
}

function fault(code: number, message: string): string {
  return `<?xml version="1.0"?>
<methodResponse><fault><value><struct>
<member><name>faultCode</name><value><int>${code}</int></value></member>
<member><name>faultString</name><value><string>${xmlEscape(message)}</string></value></member>
</struct></value></fault></methodResponse>`;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export async function POST(req: NextRequest) {
  if (isRateLimited(rateLimitKey(req))) {
    return xmlResponse(fault(429, "rate limit exceeded"), 429);
  }

  const body = await req.text();
  if (body.length > MAX_REQUEST_CHARS) {
    return xmlResponse(fault(400, "request too large"), 413);
  }
  const method = (between(body, "methodName") ?? "").trim();

  // The two discovery methods are static and carry no data, so they stay open.
  let auth: TokenVerification = { valid: false };
  if (!["system.listMethods", "mt.supportedMethods"].includes(method)) {
    auth = await verifyTokenValue(extractParam(body, 2));
    if (!auth.valid) {
      return xmlResponse(fault(403, "Authentication failed"));
    }
    void recordTokenUse(auth, req);
  }

  /**
   * Scope gate. Deliberately asymmetric, and the asymmetry is load-bearing:
   * `AuthToken.scope` has defaulted to "create update delete media" since the
   * first release, so every hand-issued token a micro.blog user pasted in years
   * ago HAS create and delete but does NOT have `read`. Gating the writes breaks
   * nobody; gating the reads would break every existing client — and /api/micropub
   * doesn't gate reads either, so leaving them open is also parity, not laxity.
   */
  const refuseScope = (required: string) =>
    xmlResponse(fault(403, `This token is not allowed to ${required} posts`));

  const siteUrl = getSiteUrl();

  switch (method) {
    case "system.listMethods":
    case "mt.supportedMethods":
      return xmlResponse(methodResponse(`<param><value><array><data>
        <value><string>blogger.getUsersBlogs</string></value>
        <value><string>metaWeblog.getRecentPosts</string></value>
        <value><string>metaWeblog.newPost</string></value>
        <value><string>metaWeblog.getPost</string></value>
        <value><string>metaWeblog.editPost</string></value>
        <value><string>metaWeblog.deletePost</string></value>
        <value><string>metaWeblog.getCategories</string></value>
        <value><string>metaWeblog.newMediaObject</string></value>
        <value><string>wp.getUsersBlogs</string></value>
      </data></array></value></param>`));

    case "blogger.getUsersBlogs":
    case "wp.getUsersBlogs":
      return xmlResponse(methodResponse(`<param><value><array><data>
        <value><struct>
          <member><name>blogid</name><value><string>1</string></value></member>
          <member><name>blogName</name><value><string>FediHome</string></value></member>
          <member><name>url</name><value><string>${xmlEscape(siteUrl)}</string></value></member>
        </struct></value>
      </data></array></value></param>`));

    case "metaWeblog.getCategories":
      return xmlResponse(methodResponse(`<param><value><array><data>
        <value><struct>
          <member><name>categoryId</name><value><string>note</string></value></member>
          <member><name>categoryName</name><value><string>Note</string></value></member>
        </struct></value>
        <value><struct>
          <member><name>categoryId</name><value><string>journal</string></value></member>
          <member><name>categoryName</name><value><string>Journal</string></value></member>
        </struct></value>
        <value><struct>
          <member><name>categoryId</name><value><string>article</string></value></member>
          <member><name>categoryName</name><value><string>Article</string></value></member>
        </struct></value>
        <value><struct>
          <member><name>categoryId</name><value><string>photo</string></value></member>
          <member><name>categoryName</name><value><string>Photo</string></value></member>
        </struct></value>
      </data></array></value></param>`));

    case "metaWeblog.newPost": {
      if (!hasScope(auth.scope, "create")) return refuseScope("create");
      const struct = extractStruct(body);
      const title = struct.title || null;
      const content = struct.description || "";
      const slug = slugify(title || content.slice(0, 40) || "post-" + Date.now().toString(36));
      const contentHtml = sanitizeHtml(marked.parse(content) as string);

      const post = await prisma.post.create({
        data: {
          slug,
          title: title || null,
          content,
          contentHtml,
          category: "note",
          tags: [],
          published: true,
          apId: `${siteUrl}/post/${slug}`,
        },
      });

      const { deliverToFollowers } = await import("@/lib/http-signatures");
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${siteUrl}/ap/create/${post.id}`,
        type: "Create",
        actor: `${siteUrl}/ap/actor`,
        published: post.publishedAt.toISOString(),
        object: buildPostObject(post),
      };
      deliverToFollowers(activity).catch(() => {});

      const { crosspostToBluesky, crosspostToThreads } = await import("@/lib/crosspost");
      crosspostToBluesky(content, `${siteUrl}/post/${slug}`).catch(() => {});
      crosspostToThreads(content, `${siteUrl}/post/${slug}`).catch(() => {});

      return xmlResponse(methodResponse(`<param><value><string>${xmlEscape(post.id)}</string></value></param>`));
    }

    case "metaWeblog.getRecentPosts": {
      // Clamp the client-supplied page size: bound it to 1–50 and reject
      // non-finite values (a non-numeric param → NaN → Prisma `take: NaN` 500;
      // a huge value → unbounded query). #9
      const requested = parseInt(extractParam(body, 3) || "10", 10);
      const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
      const posts = await prisma.post.findMany({
        where: { published: true, inReplyToPostId: null },
        orderBy: { publishedAt: "desc" },
        take: count,
      });

      const items = posts.map((p) => `<value><struct>
        <member><name>postid</name><value><string>${xmlEscape(p.id)}</string></value></member>
        <member><name>title</name><value><string>${xmlEscape(p.title || "")}</string></value></member>
        <member><name>description</name><value><string>${cdata(p.content)}</string></value></member>
        <member><name>link</name><value><string>${xmlEscape(`${siteUrl}/post/${p.slug}`)}</string></value></member>
        <member><name>dateCreated</name><value><dateTime.iso8601>${p.publishedAt.toISOString()}</dateTime.iso8601></value></member>
      </struct></value>`).join("\n");

      return xmlResponse(methodResponse(`<param><value><array><data>${items}</data></array></value></param>`));
    }

    case "metaWeblog.getPost": {
      const postId = extractParam(body, 0);
      // `published: true` to match getRecentPosts. Without it this returned the
      // full body of an unpublished draft or a scheduled post to any token —
      // findUnique by id, no visibility filter at all.
      const post = postId
        ? await prisma.post.findFirst({ where: { id: postId, published: true } })
        : null;
      if (!post) return xmlResponse(fault(404, "Post not found"));

      return xmlResponse(methodResponse(`<param><value><struct>
        <member><name>postid</name><value><string>${xmlEscape(post.id)}</string></value></member>
        <member><name>title</name><value><string>${xmlEscape(post.title || "")}</string></value></member>
        <member><name>description</name><value><string>${cdata(post.content)}</string></value></member>
        <member><name>link</name><value><string>${xmlEscape(`${siteUrl}/post/${post.slug}`)}</string></value></member>
      </struct></value></param>`));
    }

    case "metaWeblog.deletePost": {
      if (!hasScope(auth.scope, "delete")) return refuseScope("delete");
      const postId = extractParam(body, 0);
      // Route through the shared helper so XML-RPC deletes federate + clean up
      // child rows exactly like Micropub does (#16), instead of the old naive
      // delete that silently failed on posts with replies/comments.
      const post = postId ? await prisma.post.findUnique({ where: { id: postId } }) : null;
      // Was an unconditional `1`, so deleting a nonexistent id reported success.
      if (!post) return xmlResponse(fault(404, "Post not found"));
      await deletePostWithFederation(post);
      return xmlResponse(methodResponse(`<param><value><boolean>1</boolean></value></param>`));
    }

    default:
      return xmlResponse(fault(0, `Unknown method: ${method}`));
  }
}
