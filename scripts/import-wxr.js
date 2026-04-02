const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

const xml = fs.readFileSync('export.xml', 'utf-8');

// Split into items
const itemBlocks = xml.split('<item>').slice(1).map(block => block.split('</item>')[0]);
console.log('Found', itemBlocks.length, 'items');

function extract(block, tag) {
  // Handle namespaced tags like wp:status, content:encoded
  const regex = new RegExp('<' + tag.replace(':', '\\:') + '>([\\s\\S]*?)</' + tag.replace(':', '\\:') + '>');
  const m = block.match(regex);
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function slugFromLink(link) {
  if (!link) return 'post-' + Date.now().toString(36);
  return link.replace(/\.html$/, '').split('/').pop() || 'post-' + Date.now().toString(36);
}

function htmlToMarkdown(html) {
  if (!html) return '';
  return html
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<a[^>]*href="([^"]*?)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, '> $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec)))
    .replace(/&quot;/g, '"')
    .replace(/\n\n+/g, '\n\n')
    .trim();
}

function extractPhotos(html) {
  if (!html) return [];
  const photos = [];
  const imgRegex = /src="([^"]*uploads[^"]*)"/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    let src = m[1];
    src = src.replace(SITE_URL + '/', '/');
    if (!src.startsWith('/') && src.includes('uploads/')) {
      src = '/' + src.substring(src.indexOf('uploads/'));
    }
    if (src.startsWith('/uploads/')) photos.push(src);
  }
  return photos;
}

function extractCategories(block) {
  const cats = [];
  const regex = /nicename="([^"]+)"/g;
  let m;
  while ((m = regex.exec(block)) !== null) {
    cats.push(m[1]);
  }
  return cats;
}

async function run() {
  await prisma.guestComment.deleteMany({});
  await prisma.photo.deleteMany({});
  await prisma.post.deleteMany({});
  console.log('Cleared existing data');

  let imported = 0, photoCount = 0, skipped = 0;
  const seenSlugs = new Set();

  for (const block of itemBlocks) {
    const status = extract(block, 'wp:status');
    const postType = extract(block, 'wp:post_type');
    const contentRaw = extract(block, 'content:encoded');

    if (postType !== 'post' || status !== 'publish' || !contentRaw) { skipped++; continue; }

    const link = extract(block, 'link');
    let slug = slugFromLink(link);
    if (seenSlugs.has(slug)) slug += '-' + (++imported).toString(36);
    seenSlugs.add(slug);

    const content = htmlToMarkdown(contentRaw);
    const photos = extractPhotos(contentRaw);
    const cats = extractCategories(block);

    const firstCat = (cats[0] || '').toLowerCase();
    const category =
      firstCat.includes('photo') ? 'photo' :
      firstCat.includes('captain') || firstCat.includes('journal') ? 'journal' :
      firstCat.includes('article') ? 'article' : 'note';

    let title = extract(block, 'title') || null;
    if (title && /^\d{4}[-_]/.test(title)) title = null;

    const dateStr = extract(block, 'wp:post_date_gmt') || extract(block, 'wp:post_date');
    const publishedAt = dateStr ? new Date(dateStr + 'Z') : new Date();

    try {
      const post = await prisma.post.create({
        data: {
          slug, title, content, category,
          tags: cats.map(c => c.toLowerCase()),
          photos, published: true, publishedAt,
          apId: SITE_URL + '/post/' + slug,
        },
      });

      for (const photoUrl of photos) {
        const ps = photoUrl.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
        try {
          await prisma.photo.create({
            data: {
              slug: ps + '-' + post.id.slice(-4),
              caption: content.slice(0, 200) || null,
              imagePath: photoUrl,
              category: 'general',
              tags: cats.map(c => c.toLowerCase()),
              published: true, publishedAt,
              apId: SITE_URL + '/photography/' + ps + '-' + post.id.slice(-4),
            },
          });
          photoCount++;
        } catch(e) {}
      }
      imported++;
    } catch(e) {
      console.error('Skip:', slug, e.message?.slice(0, 80));
      skipped++;
    }
  }

  console.log('Imported:', imported, 'posts |', photoCount, 'photos | Skipped:', skipped);
  await prisma.$disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
