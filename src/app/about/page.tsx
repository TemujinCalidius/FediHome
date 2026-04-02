import { siteConfig } from "@/../site.config";

export const metadata = {
  title: "About",
  description: `About ${siteConfig.authorName}`,
};

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-6">
        About
      </h1>

      <div className="space-y-6 text-gray-400 leading-relaxed">
        {siteConfig.authorBio ? (
          <p>{siteConfig.authorBio}</p>
        ) : (
          <p>
            This is a self-hosted FediHome instance. Visit the admin panel to
            customize this page.
          </p>
        )}

        <div className="divider my-8" />

        <h2 className="font-display text-xl font-semibold text-white">
          This Site
        </h2>
        <p>
          This website is self-hosted, built with Next.js, and connected to the
          Fediverse via ActivityPub. You can follow at{" "}
          <span className="text-accent-400 font-mono text-sm">
            {siteConfig.fediAddress}
          </span>{" "}
          from Mastodon, Pixelfed, or any ActivityPub-compatible platform.
        </p>

        <p>
          Posts are published using the Micropub protocol, which means you can
          write from apps like iA Writer or the Micro.blog app and publish
          directly to this site.
        </p>

        <div className="divider my-8" />

        <h2 className="font-display text-xl font-semibold text-white">
          Contact
        </h2>
        <ul className="space-y-2 text-sm">
          <li>
            <span className="text-gray-500">Fediverse:</span>{" "}
            <span className="text-accent-400 font-mono">
              {siteConfig.fediAddress}
            </span>
          </li>
          {siteConfig.contactEmail && (
            <li>
              <span className="text-gray-500">Email:</span>{" "}
              <a
                href={`mailto:${siteConfig.contactEmail}`}
                className="text-accent-400 hover:text-accent-300"
              >
                {siteConfig.contactEmail}
              </a>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
