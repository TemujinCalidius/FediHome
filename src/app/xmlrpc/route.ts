import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken, safeCompare } from "@/lib/auth";

/**
 * XML-RPC endpoint (MetaWeblog API) for compatibility with micro.blog app
 * and other blogging clients that don't support Micropub.
 */

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function methodResponse(params: string): string {
  return `<?xml version="1.0"?>
<methodResponse><params>${params}</params></methodResponse>`;
}

function fault(code: number, message: string): string {
  return `<?xml version="1.0"?>
<methodResponse><fault><value><struct>
<member><name>faultCode</name><value><int>${code}</int></value></member>
<member><name>faultString</name><value><string>${message}</string></value></member>
</struct></value></fault></methodResponse>`;
}

function extractParam(xml: string, index: number): string {
  const params = xml.match(/<param>\s*<value>([\s\S]*?)<\/value>\s*<\/param>/g) || [];
  if (!params[index]) return "";
  const val = params[index];
  const str = val.match(/<string>([\s\S]*?)<\/string>/);
  if (str) return str[1];
  const int = val.match(/<int>(\d+)<\/int>/);
  if (int) return int[1];
  return val.replace(/<[^>]+>/g, "").trim();
}

function extractStruct(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const members = xml.match(/<member>([\s\S]*?)<\/member>/g) || [];
  for (const member of members) {
    const name = member.match(/<name>([\s\S]*?)<\/name>/)?.[1];
    const value = member.match(/<string>([\s\S]*?)<\/string>/)?.[1] ||
                  member.match(/<int>(\d+)<\/int>/)?.[1] ||
                  member.match(/<boolean>(\d)<\/boolean>/)?.[1] || "";
    if (name) result[name] = value;
  }
  return result;
}

async function verifyAuth(username: string, password: string): Promise<boolean> {
  // Accept admin secret OR any valid Micropub token as password
  if (safeCompare(password, process.env.ADMIN_SECRET || "")) return true;
  const hash = hashToken(password);
  const token = await prisma.authToken.findUnique({ where: { tokenHash: hash } });
  return !!token;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const methodMatch = body.match(/<methodName>([\s\S]*?)<\/methodName>/);
  const method = methodMatch?.[1]?.trim() || "";

  // Auth check for most methods
  if (!["system.listMethods", "mt.supportedMethods"].includes(method)) {
    const username = extractParam(body, 1);
    const password = extractParam(body, 2);
    if (!(await verifyAuth(username, password))) {
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
          <member><name>url</name><value><string>${siteUrl}</string></value></member>
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

      const post = await prisma.post.create({
        data: {
          slug,
          title: title || null,
          content,
          category: "note",
          tags: [],
          published: true,
          apId: `${siteUrl}/post/${slug}`,
        },
      });

      // Federate + crosspost
      const { deliverToFollowers } = await import("@/lib/http-signatures");
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${siteUrl}/ap/create/${post.id}`,
        type: "Create",
        actor: `${siteUrl}/ap/actor`,
        published: post.publishedAt.toISOString(),
        object: {
          type: title ? "Article" : "Note",
          id: post.apId,
          attributedTo: `${siteUrl}/ap/actor`,
          content: `<p>${content.replace(/\n/g, "<br>")}</p>`,
          url: `${siteUrl}/post/${slug}`,
          published: post.publishedAt.toISOString(),
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: [`${siteUrl}/ap/followers`],
        },
      };
      deliverToFollowers(activity).catch(() => {});

      const { crosspostToBluesky, crosspostToThreads } = await import("@/lib/crosspost");
      crosspostToBluesky(content, `${siteUrl}/post/${slug}`).catch(() => {});
      crosspostToThreads(content, `${siteUrl}/post/${slug}`).catch(() => {});

      return xmlResponse(methodResponse(`<param><value><string>${post.id}</string></value></param>`));
    }

    case "metaWeblog.getRecentPosts": {
      const count = parseInt(extractParam(body, 3) || "10", 10);
      const posts = await prisma.post.findMany({
        where: { published: true },
        orderBy: { publishedAt: "desc" },
        take: count,
      });

      const items = posts.map((p) => `<value><struct>
        <member><name>postid</name><value><string>${p.id}</string></value></member>
        <member><name>title</name><value><string>${p.title || ""}</string></value></member>
        <member><name>description</name><value><string><![CDATA[${p.content}]]></string></value></member>
        <member><name>link</name><value><string>${siteUrl}/post/${p.slug}</string></value></member>
        <member><name>dateCreated</name><value><dateTime.iso8601>${p.publishedAt.toISOString()}</dateTime.iso8601></value></member>
      </struct></value>`).join("\n");

      return xmlResponse(methodResponse(`<param><value><array><data>${items}</data></array></value></param>`));
    }

    case "metaWeblog.getPost": {
      const postId = extractParam(body, 0);
      const post = await prisma.post.findUnique({ where: { id: postId } });
      if (!post) return xmlResponse(fault(404, "Post not found"));

      return xmlResponse(methodResponse(`<param><value><struct>
        <member><name>postid</name><value><string>${post.id}</string></value></member>
        <member><name>title</name><value><string>${post.title || ""}</string></value></member>
        <member><name>description</name><value><string><![CDATA[${post.content}]]></string></value></member>
        <member><name>link</name><value><string>${siteUrl}/post/${post.slug}</string></value></member>
      </struct></value></param>`));
    }

    case "metaWeblog.deletePost": {
      const postId = extractParam(body, 0);
      await prisma.post.delete({ where: { id: postId } }).catch(() => {});
      return xmlResponse(methodResponse(`<param><value><boolean>1</boolean></value></param>`));
    }

    default:
      return xmlResponse(fault(0, `Unknown method: ${method}`));
  }
}
