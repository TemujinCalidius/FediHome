/**
 * Hand-authored, self-contained illustration of the FediHome macOS app (#241):
 * a menu-bar dropdown showing the feed, with a compose sheet overlapping — a
 * stylised "screenshot" that needs no external asset and matches the site's
 * single dark theme (surface #0a0a0f/#111118, accent blue #3b82f6/#60a5fa,
 * moss #10b981). Given role="img" + an aria-label so a screen reader announces
 * it as one labelled illustration; the inner shapes are presentational.
 */
export default function MacAppMockup({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 560 420"
      role="img"
      aria-label="Illustration of the FediHome menu-bar app for macOS, showing a feed and a compose window"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="fh-panel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#15151f" />
          <stop offset="1" stopColor="#0e0e15" />
        </linearGradient>
        <linearGradient id="fh-accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <radialGradient id="fh-glow" cx="0.5" cy="0.35" r="0.65">
          <stop offset="0" stopColor="#3b82f6" stopOpacity="0.22" />
          <stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* accent glow */}
      <rect x="0" y="0" width="560" height="420" fill="url(#fh-glow)" />

      {/* ── macOS menu bar (shows it's a menu-bar app) ── */}
      <rect x="40" y="24" width="480" height="26" rx="8" fill="#111118" stroke="#252530" />
      <circle cx="60" cy="37" r="5" fill="url(#fh-accent)" />
      <rect x="74" y="34" width="34" height="6" rx="3" fill="#3a3a4a" />
      <rect x="120" y="34" width="26" height="6" rx="3" fill="#252530" />
      <rect x="158" y="34" width="30" height="6" rx="3" fill="#252530" />
      {/* right-side status icons + the highlighted FediHome menu-bar icon */}
      <rect x="430" y="34" width="20" height="6" rx="3" fill="#252530" />
      <g transform="translate(470 30)">
        <rect x="-6" y="-3" width="26" height="20" rx="6" fill="#3b82f6" fillOpacity="0.16" stroke="#3b82f6" strokeOpacity="0.5" />
        {/* little "home" glyph */}
        <path d="M0 6 L7 0 L14 6" fill="none" stroke="#60a5fa" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="2.5" y="6" width="9" height="6" rx="1.2" fill="#60a5fa" />
      </g>
      {/* connector notch from the menu-bar icon down to the panel */}
      <path d="M477 50 l7 10 l7 -10 z" fill="#15151f" stroke="#252530" />

      {/* ── Feed panel (the dropdown) ── */}
      <rect x="150" y="62" width="300" height="330" rx="16" fill="url(#fh-panel)" stroke="#252530" />
      {/* panel header */}
      <circle cx="176" cy="90" r="12" fill="#1a1a24" stroke="#3a3a4a" />
      <path d="M170 92 L176 86 L182 92" fill="none" stroke="#60a5fa" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="196" y="82" width="92" height="8" rx="4" fill="#e5e7eb" fillOpacity="0.85" />
      <rect x="196" y="95" width="60" height="6" rx="3" fill="#3a3a4a" />
      {/* compose pencil button in header */}
      <rect x="404" y="78" width="26" height="24" rx="8" fill="#3b82f6" fillOpacity="0.16" stroke="#3b82f6" strokeOpacity="0.5" />
      <path d="M411 95 l9 -9 l3 3 l-9 9 l-4 1 z" fill="#60a5fa" />

      {/* feed items */}
      {[0, 1, 2].map((i) => {
        const y = 128 + i * 74;
        return (
          <g key={i}>
            <circle cx="178" cy={y + 12} r="14" fill="#1a1a24" stroke="#3a3a4a" />
            <circle cx="178" cy={y + 12} r="7" fill={i === 1 ? "#10b981" : "#3b82f6"} fillOpacity="0.55" />
            <rect x="204" y={y + 2} width="70" height="7" rx="3.5" fill="#cbd5e1" fillOpacity="0.7" />
            <rect x="280" y={y + 2} width="34" height="7" rx="3.5" fill="#3a3a4a" />
            <rect x="204" y={y + 18} width="216" height="6" rx="3" fill="#3a3a4a" />
            <rect x="204" y={y + 30} width="176" height="6" rx="3" fill="#2b2b38" />
            {/* like / boost / reply hints */}
            <circle cx="208" cy={y + 50} r="3.5" fill="none" stroke="#4b5563" strokeWidth="1.3" />
            <circle cx="230" cy={y + 50} r="3.5" fill="none" stroke="#4b5563" strokeWidth="1.3" />
            <circle cx="252" cy={y + 50} r="3.5" fill="none" stroke="#4b5563" strokeWidth="1.3" />
            {i < 2 && <rect x="168" y={y + 62} width="264" height="1" fill="#1f1f2b" />}
          </g>
        );
      })}

      {/* ── Compose sheet (overlaps, front) ── */}
      <g transform="translate(64 232)">
        <rect x="0" y="0" width="248" height="150" rx="16" fill="#15151f" stroke="#3b82f6" strokeOpacity="0.35" />
        <rect x="0" y="0" width="248" height="150" rx="16" fill="#3b82f6" fillOpacity="0.04" />
        {/* header */}
        <rect x="18" y="18" width="70" height="7" rx="3.5" fill="#e5e7eb" fillOpacity="0.85" />
        <circle cx="230" cy="21" r="8" fill="#1a1a24" stroke="#3a3a4a" />
        <path d="M227 18 l6 6 M233 18 l-6 6" stroke="#6b7280" strokeWidth="1.3" strokeLinecap="round" />
        {/* text area */}
        <rect x="18" y="38" width="212" height="6" rx="3" fill="#3a3a4a" />
        <rect x="18" y="50" width="188" height="6" rx="3" fill="#2b2b38" />
        <rect x="18" y="62" width="150" height="6" rx="3" fill="#2b2b38" />
        {/* media / schedule / draft icons */}
        <g transform="translate(18 92)" fill="none" stroke="#60a5fa" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="0" y="0" width="18" height="16" rx="3" />
          <circle cx="5.5" cy="5.5" r="1.8" fill="#60a5fa" stroke="none" />
          <path d="M1 15 l6 -6 l4 4 l3 -3 l4 6" />
        </g>
        <g transform="translate(46 92)" fill="none" stroke="#60a5fa" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="8" r="8" />
          <path d="M9 4 v4 l3 2" />
        </g>
        <g transform="translate(74 92)" fill="none" stroke="#60a5fa" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 1 h11 l4 4 v11 a1 1 0 0 1 -1 1 h-14 a1 1 0 0 1 -1 -1 v-15 a1 1 0 0 1 1 -1 z" />
          <path d="M5 8 h8 M5 12 h6" />
        </g>
        {/* Post button */}
        <rect x="170" y="90" width="60" height="24" rx="8" fill="url(#fh-accent)" />
        <rect x="184" y="99" width="32" height="6" rx="3" fill="#ffffff" fillOpacity="0.92" />
      </g>
    </svg>
  );
}
