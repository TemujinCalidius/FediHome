import { getFooterData } from "./footerData";
import { RssIcon } from "./headerData";

/**
 * Footer variant: "minimal" (#250). A single quiet line — credit, handle, feed.
 * The leanest way to close a page; pairs with the minimal header. Keeps
 * `mt-auto` so short pages still push it to the bottom.
 */
export default async function FooterMinimal() {
  const { authorName, fediAddress, year } = await getFooterData();

  return (
    <footer className="mt-auto">
      <div className="divider" />
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-content-dim">
          <span>&copy; {year} {authorName}</span>
          <span className="font-mono text-content-ghost">{fediAddress}</span>
          <a href="/feed.xml" className="text-content-faint hover:text-accent-400 transition-colors" title="RSS Feed">
            <RssIcon />
          </a>
        </div>
      </div>
    </footer>
  );
}
