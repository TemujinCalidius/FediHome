/**
 * FediHome — Database Seed
 * Creates demo posts so the homepage isn't empty on first install.
 * Run after setup wizard completes, or manually: npx tsx prisma/seed.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

async function main() {
  // Check if posts already exist (don't re-seed)
  const count = await prisma.post.count();
  if (count > 0) {
    console.log("Posts already exist — skipping seed.");
    return;
  }

  console.log("Seeding demo content...");

  // Demo Post 1 — Welcome note
  await prisma.post.create({
    data: {
      slug: "welcome-to-fedihome",
      title: null,
      content:
        "Welcome to my FediHome! This is my first post on my own corner of the Fediverse. Follow me at my handle to see my posts on Mastodon, Pixelfed, or any ActivityPub-compatible platform.\n\n*This is a demo post — feel free to delete it.*",
      contentHtml:
        '<p>Welcome to my FediHome! This is my first post on my own corner of the Fediverse. Follow me at my handle to see my posts on Mastodon, Pixelfed, or any ActivityPub-compatible platform.</p><p><em>This is a demo post — feel free to delete it.</em></p>',
      category: "note",
      tags: ["fedihome", "fediverse"],
      photos: [],
      photoCaptions: [],
      published: true,
      apId: `${siteUrl}/post/welcome-to-fedihome`,
    },
  });

  // Demo Post 2 — Example article
  await prisma.post.create({
    data: {
      slug: "getting-started-with-fedihome",
      title: "Getting Started with FediHome",
      content: `FediHome is your personal publishing platform on the Fediverse. Here's what you can do:

## Write Posts

Create blog posts, short notes, and journal entries — all in Markdown. They automatically federate to your followers on Mastodon, Pixelfed, and other ActivityPub platforms.

## Share Photos

Upload photos with captions. They appear in a gallery with a lightbox viewer — click any image to see it full-screen with swipe navigation.

## Connect

Follow people from any Fediverse instance. Their posts appear in your timeline. Reply, like, and boost — all from your admin panel.

## Customize

Visit the admin panel to change your site name, bio, avatar, and theme. Make it yours.

---

*This is a demo post — feel free to delete it.*`,
      contentHtml: `<p>FediHome is your personal publishing platform on the Fediverse. Here's what you can do:</p>
<h2>Write Posts</h2>
<p>Create blog posts, short notes, and journal entries — all in Markdown. They automatically federate to your followers on Mastodon, Pixelfed, and other ActivityPub platforms.</p>
<h2>Share Photos</h2>
<p>Upload photos with captions. They appear in a gallery with a lightbox viewer — click any image to see it full-screen with swipe navigation.</p>
<h2>Connect</h2>
<p>Follow people from any Fediverse instance. Their posts appear in your timeline. Reply, like, and boost — all from your admin panel.</p>
<h2>Customize</h2>
<p>Visit the admin panel to change your site name, bio, avatar, and theme. Make it yours.</p>
<hr>
<p><em>This is a demo post — feel free to delete it.</em></p>`,
      category: "article",
      tags: ["fedihome", "guide", "getting-started"],
      photos: [],
      photoCaptions: [],
      published: true,
      apId: `${siteUrl}/post/getting-started-with-fedihome`,
    },
  });

  // Demo Post 3 — Photo post
  await prisma.post.create({
    data: {
      slug: "demo-photo-post",
      title: null,
      content:
        "Here's what a photo post looks like on your FediHome. Upload your own photos and they'll appear with a lightbox viewer.\n\n*This is a demo post — feel free to delete it.*",
      contentHtml:
        "<p>Here's what a photo post looks like on your FediHome. Upload your own photos and they'll appear with a lightbox viewer.</p><p><em>This is a demo post — feel free to delete it.</em></p>",
      category: "note",
      tags: ["photo", "demo"],
      photos: ["/images/demo-photo.webp"],
      photoCaptions: ["A peaceful landscape — your FediHome demo photo"],
      published: true,
      apId: `${siteUrl}/post/demo-photo-post`,
    },
  });

  console.log("Seeded 3 demo posts.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
