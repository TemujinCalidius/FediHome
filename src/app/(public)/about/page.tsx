import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { renderMarkdownToSafeHtml, defaultAboutMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const site = await getRuntimeSiteConfig();
  return {
    title: site.about.heading || "About",
    description: `About ${site.name || siteConfig.authorName}`,
  };
}

export default async function AboutPage() {
  const profile = await getRuntimeProfile();
  const site = await getRuntimeSiteConfig();

  // "" means "use the built-in", and the built-in is BUILT rather than stored
  // (#439) — so resetting keeps tracking the operator's real address instead of
  // pinning whatever it was the day they first saved. Their bio is folded in, so
  // an operator who has only filled that in gets the page they already had.
  const markdown =
    site.about.markdown ||
    defaultAboutMarkdown({
      fediAddress: siteConfig.fediAddress,
      authorBio: profile.authorBio ?? "",
    });

  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-6">
        {site.about.heading || "About"}
      </h1>

      {/* Sanitised on the way out, not trusted from the database. The owner is
          the only writer, but a hand-edited row or a restore is not, and #431
          is the precedent: validate wherever the value comes from. */}
      {/* Same styling as a post body — an About page written in markdown should
          look like everything else written in markdown, and a second hand-tuned
          string is how the two drift apart. hr is newly allowed (#481). */}
      <div
        className="prose-sl text-gray-300 leading-relaxed [&_a]:text-accent-400 [&_a:hover]:text-accent-300 [&_a]:underline [&_p]:mb-4 [&_h2]:font-display [&_h2]:text-white [&_h2]:text-xl [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:font-display [&_h3]:text-white [&_h3]:text-lg [&_h3]:mt-6 [&_h3]:mb-2 [&_ul]:list-disc [&_ul]:ml-5 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:mb-4 [&_li]:mb-1 [&_blockquote]:border-l-4 [&_blockquote]:border-accent-400/30 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-gray-400 [&_code]:bg-surface-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-accent-300 [&_code]:text-sm [&_strong]:text-white [&_hr]:border-surface-700 [&_hr]:my-8"
        dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(markdown) }}
      />

      <div className="divider my-8" />

      <h2 className="font-display text-xl font-semibold text-white">Contact</h2>
      <ul className="space-y-2 text-sm mt-4">
        <li>
          <span className="text-gray-500">Fediverse:</span>{" "}
          <span className="text-accent-400 font-mono">{siteConfig.fediAddress}</span>
        </li>
        {/* The RUNTIME contact address, not the build-time env one (#480). */}
        {site.contact.email && (
          <li>
            <span className="text-gray-500">Email:</span>{" "}
            <a
              href={`mailto:${site.contact.email}`}
              className="text-accent-400 hover:text-accent-300"
            >
              {site.contact.email}
            </a>
          </li>
        )}
      </ul>
    </div>
  );
}
