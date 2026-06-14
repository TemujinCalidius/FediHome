"use client";

/**
 * One-click translate for a post — opens Kagi Translate with the post text
 * already filled in (target English, source auto-detected), so there's no need
 * to select text and right-click. Opens in a new tab; works in any browser.
 *
 * Kagi Translate URL scheme (help.kagi.com/kagi/translate/url-parameters.html):
 * text mode `?text=<encoded>&to=en` (omit `from` for auto-detect). For very long
 * posts we translate the original page instead so nothing is truncated.
 */
function toPlainText(html: string): string {
  if (typeof document === "undefined") {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  const el = document.createElement("div");
  el.innerHTML = html;
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

const MAX_TEXT = 1800; // keep the GET URL well within limits

export default function TranslateButton({
  html,
  sourceUrl,
  className = "",
}: {
  html: string;
  sourceUrl?: string | null;
  className?: string;
}) {
  const open = () => {
    const text = toPlainText(html);
    let url: string;
    if (text.length > MAX_TEXT && sourceUrl) {
      // Long post → translate the whole original page so nothing is cut off.
      url = `https://translate.kagi.com/${sourceUrl}?to=en`;
    } else if (text) {
      url = `https://translate.kagi.com/?text=${encodeURIComponent(text)}&to=en`;
    } else if (sourceUrl) {
      url = `https://translate.kagi.com/${sourceUrl}?to=en`;
    } else {
      return;
    }
    window.open(url, "_blank", "noopener");
  };

  return (
    <button
      onClick={open}
      title="Translate (Kagi)"
      aria-label="Translate post"
      className={`inline-flex items-center gap-1 text-gray-500 hover:text-accent-400 transition-colors ${className}`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802"
        />
      </svg>
    </button>
  );
}
