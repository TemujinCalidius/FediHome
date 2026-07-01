import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { marked } from "marked";
import { extractParam, extractStruct, between } from "@/lib/xmlrpc";
import { rateLimitKey } from "@/lib/client-ip";
import { buildPostObject } from "@/lib/ap-post";
import { deletePostWithFederation } from "@/lib/delete-post";

/**
 * XML-RPC endpoint (MetaWeblog API) for compatibility with micro.blog app
 * and other blogging clients that don't support Micropub.
 *
 * Auth: Micropub bearer tokens only (the password parameter is treated as a
 * Micropub token and looked up in AuthToken). The legacy ADMIN_SECRET
 * fallback was removed — a single high-entropy secret over an unrate-limited
 * XML-RPC endpoint is a brute-force liability.
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

async function verifyAuth(password: string): Promise<boolean> {
  if (!password) return false;
  const hash = hashToken(password);
  const token = await prisma.authToken.findUnique({ where: { tokenHash: hash } });
  return !!token;
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

  if (!["system.listMethods", "mt.supportedMethods"].includes(method)) {
    const password = extractParam(body, 2);
    if (!(await verifyAuth(password))) {
      return xmlResponse(fault(403, "Authentication failed"));
    }
  }

  const siteUrl = process.env.SITE_URL || "http://localhost:3000";

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
      const post = await prisma.post.findUnique({ where: { id: postId } });
      if (!post) return xmlResponse(fault(404, "Post not found"));

      return xmlResponse(methodResponse(`<param><value><struct>
        <member><name>postid</name><value><string>${xmlEscape(post.id)}</string></value></member>
        <member><name>title</name><value><string>${xmlEscape(post.title || "")}</string></value></member>
        <member><name>description</name><value><string>${cdata(post.content)}</string></value></member>
        <member><name>link</name><value><string>${xmlEscape(`${siteUrl}/post/${post.slug}`)}</string></value></member>
      </struct></value></param>`));
    }

    case "metaWeblog.deletePost": {
      const postId = extractParam(body, 0);
      // Route through the shared helper so XML-RPC deletes federate + clean up
      // child rows exactly like Micropub does (#16), instead of the old naive
      // delete that silently failed on posts with replies/comments.
      const post = postId ? await prisma.post.findUnique({ where: { id: postId } }) : null;
      if (post) await deletePostWithFederation(post);
      return xmlResponse(methodResponse(`<param><value><boolean>1</boolean></value></param>`));
    }

    default:
      return xmlResponse(fault(0, `Unknown method: ${method}`));
  }
}
