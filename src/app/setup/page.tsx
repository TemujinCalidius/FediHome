"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { THEMES } from "@/lib/themes";

const TOTAL_STEPS = 7;

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => {
        const step = i + 1;
        const isCompleted = step < current;
        const isCurrent = step === current;
        return (
          <div key={step} className="flex items-center gap-3">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-all duration-300 ${
                isCompleted
                  ? "bg-accent-500 text-surface-950"
                  : isCurrent
                  ? "border-2 border-accent-400 text-accent-400"
                  : "border border-surface-600 text-surface-600"
              }`}
            >
              {isCompleted ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                step
              )}
            </div>
            {step < TOTAL_STEPS && (
              <div
                className={`w-8 h-0.5 transition-all duration-300 ${
                  isCompleted ? "bg-accent-500" : "bg-surface-700"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-HTTPS contexts
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider transition-all duration-200 border cursor-pointer"
      style={{
        background: copied ? "rgba(94, 138, 78, 0.15)" : "rgba(212, 144, 58, 0.1)",
        borderColor: copied ? "rgba(94, 138, 78, 0.3)" : "rgba(212, 144, 58, 0.3)",
        color: copied ? "#7da86b" : "#d4903a",
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export default function SetupWizard() {
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [siteName, setSiteName] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorTagline, setAuthorTagline] = useState("");
  const [fediHandle, setFediHandle] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [adminSecret, setAdminSecret] = useState("");
  const [savedPassword, setSavedPassword] = useState(false);
  const [setupToken, setSetupToken] = useState("");

  // Site features (#59) — collected here and written to the DB-backed site
  // config, so a fresh install is configured without editing files. Defaults
  // match the env defaults (nav sections all shown; landing + public feed off).
  const [publicFeed, setPublicFeed] = useState(false);
  const [landingMode, setLandingMode] = useState(false);
  const [nav, setNav] = useState({
    journal: true, articles: true, photography: true, videos: true, audio: true, about: true,
  });
  // Appearance (#250): theme + feed layout, written via the same applySiteConfig
  // path as the feature toggles. Defaults = the env defaults (no override sent).
  const [theme, setTheme] = useState("default");
  const [feedLayout, setFeedLayout] = useState(""); // "" = inherit the theme's default
  const [headerLayout, setHeaderLayout] = useState(""); // "" = inherit the theme's default

  // Domain from current URL
  const [domain, setDomain] = useState("yourdomain.com");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time init of the domain from the browser location on mount
    setDomain(window.location.hostname);
  }, []);

  // Generate admin secret when reaching the password step (6)
  useEffect(() => {
    if (step === 6 && !adminSecret) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- generate the admin secret once when reaching the password step
      setAdminSecret(hex);
    }
  }, [step, adminSecret]);

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  const prev = () => setStep((s) => Math.max(s - 1, 1));

  const handleComplete = async () => {
    setIsSubmitting(true);
    setError(null);
    // Only send the feature choices that DIFFER from the env defaults, so setup
    // writes a clean set of overrides (an untouched toggle stays env-driven).
    const siteConfig: Record<string, string> = {};
    if (publicFeed) siteConfig["feed.public"] = "true";
    if (landingMode) siteConfig["landing.mode"] = "true";
    const navKeys: Record<keyof typeof nav, string> = {
      journal: "nav.journal", articles: "nav.articles", photography: "nav.photography",
      videos: "nav.videos", audio: "nav.audio", about: "nav.about",
    };
    (Object.keys(nav) as (keyof typeof nav)[]).forEach((k) => {
      if (!nav[k]) siteConfig[navKeys[k]] = "false"; // hidden = non-default
    });
    if (theme && theme !== "default") siteConfig["theme.id"] = theme;
    if (feedLayout) siteConfig["layout.feed"] = feedLayout; // "" = inherit → no override
    if (headerLayout) siteConfig["layout.header"] = headerLayout; // "" = inherit → no override
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteName: siteName || "My FediHome",
          authorName: authorName || "Your Name",
          authorTagline,
          fediHandle: fediHandle || "me",
          contactEmail,
          adminSecret,
          siteUrl: window.location.origin,
          setupToken,
          ...(Object.keys(siteConfig).length ? { siteConfig } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Setup failed. Please try again.");
        setIsSubmitting(false);
        return;
      }
      // Success — move to completion step
      next();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    "w-full px-4 py-3 rounded-lg bg-surface-800 border border-surface-700 text-white placeholder-surface-600 focus:outline-none focus:ring-2 focus:ring-accent-500/50 focus:border-accent-500 transition-colors";

  const labelClass = "block text-sm font-medium text-gray-300 mb-1.5";

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center p-4">
      <div className="w-full max-w-xl">
        {step > 1 && <StepIndicator current={step} />}

        <div className="bg-surface-900 border border-surface-700 rounded-xl p-8 shadow-2xl shadow-black/30">
          {/* Step 1: Welcome */}
          {step === 1 && (
            <div className="text-center">
              <div className="mb-6">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-500/10 border border-accent-500/20 mb-4">
                  <svg className="w-8 h-8 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                  </svg>
                </div>
                <h1 className="text-3xl font-bold text-white font-display mb-2">FediHome</h1>
                <p className="text-accent-400 text-sm font-medium uppercase tracking-wider">Setup Wizard</p>
              </div>

              <p className="text-gray-400 mb-2 leading-relaxed">
                Welcome to your new home on the Fediverse.
              </p>
              <p className="text-gray-500 text-sm mb-8">
                This setup will take about 2 minutes. You&apos;ll configure your site identity,
                fediverse handle, and admin credentials.
              </p>

              <button onClick={next} className="btn-primary text-base px-8 py-3 cursor-pointer">
                Get Started
              </button>
            </div>
          )}

          {/* Step 2: Your Identity */}
          {step === 2 && (
            <div>
              <div className="mb-6">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wider mb-1">Step 1 of 6</p>
                <h2 className="text-2xl font-bold text-white font-display">Your Identity</h2>
                <p className="text-gray-500 text-sm mt-1">How your site and profile appear to visitors.</p>
              </div>

              <div className="space-y-4 mb-6">
                <div>
                  <label className={labelClass}>Site Name</label>
                  <input
                    type="text"
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    placeholder="My Blog"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Your Display Name</label>
                  <input
                    type="text"
                    value={authorName}
                    onChange={(e) => setAuthorName(e.target.value)}
                    placeholder="Jane Doe"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Short Tagline</label>
                  <input
                    type="text"
                    value={authorTagline}
                    onChange={(e) => setAuthorTagline(e.target.value)}
                    placeholder="Writer, photographer, maker"
                    className={inputClass}
                  />
                </div>
              </div>

              {/* Preview */}
              <div className="rounded-lg bg-surface-800/50 border border-surface-700 p-4 mb-6">
                <p className="text-xs text-surface-600 uppercase tracking-wider font-semibold mb-3">Preview</p>
                <p className="text-lg font-bold text-white font-display">{siteName || "My Blog"}</p>
                <p className="text-accent-400 font-medium mt-0.5">{authorName || "Jane Doe"}</p>
                {(authorTagline || !authorName) && (
                  <p className="text-gray-500 text-sm mt-0.5">{authorTagline || "Writer, photographer, maker"}</p>
                )}
              </div>

              <div className="flex justify-between">
                <button onClick={prev} className="btn-outlined cursor-pointer">Back</button>
                <button onClick={next} className="btn-primary cursor-pointer">Continue</button>
              </div>
            </div>
          )}

          {/* Step 3: Fediverse Handle */}
          {step === 3 && (
            <div>
              <div className="mb-6">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wider mb-1">Step 2 of 6</p>
                <h2 className="text-2xl font-bold text-white font-display">Fediverse Handle</h2>
                <p className="text-gray-500 text-sm mt-1">Your identity on the Fediverse.</p>
              </div>

              <div className="mb-4">
                <label className={labelClass}>Username</label>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 text-lg">@</span>
                  <input
                    type="text"
                    value={fediHandle}
                    onChange={(e) => setFediHandle(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase())}
                    placeholder="me"
                    className={inputClass + " flex-1"}
                  />
                  <span className="text-gray-500 text-lg">@{domain}</span>
                </div>
              </div>

              {/* Preview */}
              <div className="rounded-lg bg-surface-800/50 border border-surface-700 p-4 mb-4">
                <p className="text-xs text-surface-600 uppercase tracking-wider font-semibold mb-2">Your Fediverse Address</p>
                <p className="text-accent-400 font-mono text-lg">
                  @{fediHandle || "me"}@{domain}
                </p>
              </div>

              <p className="text-gray-500 text-xs mb-6 leading-relaxed">
                This becomes your identity on the Fediverse. People will follow you at this address
                from Mastodon, Misskey, and other ActivityPub platforms.
              </p>

              <div className="flex justify-between">
                <button onClick={prev} className="btn-outlined cursor-pointer">Back</button>
                <button onClick={next} className="btn-primary cursor-pointer">Continue</button>
              </div>
            </div>
          )}

          {/* Step 4: Recovery Email */}
          {step === 4 && (
            <div>
              <div className="mb-6">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wider mb-1">Step 3 of 6</p>
                <h2 className="text-2xl font-bold text-white font-display">Recovery Email</h2>
                <p className="text-gray-500 text-sm mt-1">In case you need to reset your admin password.</p>
              </div>

              <div className="mb-4">
                <label className={labelClass}>Email Address</label>
                <input
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={inputClass}
                />
              </div>

              <p className="text-gray-500 text-xs mb-6 leading-relaxed">
                Used to recover your admin password if you forget it. This email is stored locally
                and is not shared publicly.
              </p>

              <div className="flex justify-between">
                <button onClick={prev} className="btn-outlined cursor-pointer">Back</button>
                <button onClick={next} className="btn-primary cursor-pointer">Continue</button>
              </div>
            </div>
          )}

          {/* Step 4: Site Features */}
          {step === 5 && (
            <div>
              <div className="mb-6">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wider mb-1">Step 4 of 6</p>
                <h2 className="text-2xl font-bold text-white font-display">Site Features</h2>
                <p className="text-gray-500 text-sm mt-1">
                  Turn sections on or off. You can change all of this later in Settings — nothing here is permanent.
                </p>
              </div>

              <div className="space-y-3 mb-6">
                <label className="flex items-start gap-3 rounded-lg bg-surface-800 border border-surface-700 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={publicFeed}
                    onChange={(e) => setPublicFeed(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-white">Public Fediverse feed</span>
                    <span className="block text-xs text-gray-500">
                      Show a login-free, read-only window into the accounts you follow at <code>/fediverse</code>.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-3 rounded-lg bg-surface-800 border border-surface-700 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={landingMode}
                    onChange={(e) => setLandingMode(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-white">Project landing page</span>
                    <span className="block text-xs text-gray-500">
                      Make the homepage a project-style landing page instead of your personal blog intro.
                    </span>
                  </span>
                </label>
              </div>

              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Navigation sections</p>
              <div className="grid grid-cols-2 gap-2 mb-6">
                {([
                  ["journal", "Journal"], ["articles", "Articles"], ["photography", "Photography"],
                  ["videos", "Videos"], ["audio", "Audio"], ["about", "About"],
                ] as [keyof typeof nav, string][]).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={nav[key]}
                      onChange={(e) => setNav((n) => ({ ...n, [key]: e.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>

              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Appearance</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  <span>Theme</span>
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value)}
                    className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
                  >
                    {Object.values(THEMES).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  <span>Feed layout</span>
                  <select
                    value={feedLayout}
                    onChange={(e) => setFeedLayout(e.target.value)}
                    className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
                  >
                    <option value="">Theme default</option>
                    <option value="cards">Cards</option>
                    <option value="list">List</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  <span>Header layout</span>
                  <select
                    value={headerLayout}
                    onChange={(e) => setHeaderLayout(e.target.value)}
                    className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
                  >
                    <option value="">Theme default</option>
                    <option value="bar">Bar</option>
                    <option value="centered">Centered</option>
                    <option value="minimal">Minimal</option>
                  </select>
                </label>
              </div>

              <div className="flex justify-between">
                <button onClick={prev} className="btn-outlined cursor-pointer">Back</button>
                <button onClick={next} className="btn-primary cursor-pointer">Continue</button>
              </div>
            </div>
          )}

          {/* Step 5: Admin Password */}
          {step === 6 && (
            <div>
              <div className="mb-6">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wider mb-1">Step 5 of 6</p>
                <h2 className="text-2xl font-bold text-white font-display">Admin Password</h2>
                <p className="text-gray-500 text-sm mt-1">Your key to the admin panel.</p>
              </div>

              <div className="rounded-lg bg-surface-800 border border-surface-700 p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-surface-600 uppercase tracking-wider font-semibold">Your Admin Secret</p>
                  <CopyButton text={adminSecret} />
                </div>
                <p className="font-mono text-sm text-accent-300 break-all leading-relaxed select-all">
                  {adminSecret}
                </p>
              </div>

              <div className="rounded-lg bg-amber-950/30 border border-amber-800/40 p-4 mb-6">
                <div className="flex gap-3">
                  <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <div>
                    <p className="text-amber-400 text-sm font-semibold mb-1">Save this password now</p>
                    <p className="text-amber-500/70 text-xs leading-relaxed">
                      Store it in a password manager or somewhere safe. You will need it to access your
                      admin panel. It cannot be recovered without your email.
                    </p>
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-3 mb-6 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={savedPassword}
                  onChange={(e) => setSavedPassword(e.target.checked)}
                  className="w-4 h-4 rounded border-surface-600 bg-surface-800 text-accent-500 focus:ring-accent-500/50 accent-accent-500"
                />
                <span className="text-sm text-gray-300 group-hover:text-white transition-colors">
                  I have saved my admin password somewhere safe
                </span>
              </label>

              <div className="mb-6">
                <label className={labelClass}>First-run setup token</label>
                <input
                  type="text"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  placeholder="Paste the token from your server logs"
                  className={inputClass}
                />
                <p className="text-gray-500 text-xs mt-1.5 leading-relaxed">
                  On first run, FediHome prints a one-time setup token to the server
                  console (or set <code>SETUP_TOKEN</code>). It stops a stranger from
                  claiming your site before you do.
                </p>
              </div>

              {error && (
                <div className="rounded-lg bg-red-950/30 border border-red-800/40 p-3 mb-4">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <div className="flex justify-between">
                <button onClick={prev} className="btn-outlined cursor-pointer">Back</button>
                <button
                  onClick={handleComplete}
                  disabled={!savedPassword || isSubmitting}
                  className={`btn-primary cursor-pointer ${
                    !savedPassword || isSubmitting ? "opacity-40 cursor-not-allowed" : ""
                  }`}
                >
                  {isSubmitting ? "Setting up..." : "Complete Setup"}
                </button>
              </div>
            </div>
          )}

          {/* Step 6: Complete */}
          {step === 7 && (
            <div className="text-center">
              <div className="mb-6">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-moss-500/15 border border-moss-500/25 mb-4">
                  <svg className="w-8 h-8 text-moss-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-white font-display mb-1">Your FediHome is ready!</h2>
                <p className="text-gray-500 text-sm">Everything has been configured. Here&apos;s a summary.</p>
              </div>

              <div className="rounded-lg bg-surface-800/50 border border-surface-700 p-4 mb-6 text-left">
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Site Name</span>
                    <span className="text-white font-medium">{siteName || "My FediHome"}</span>
                  </div>
                  <div className="divider" />
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Display Name</span>
                    <span className="text-white font-medium">{authorName || "Your Name"}</span>
                  </div>
                  <div className="divider" />
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Fediverse Handle</span>
                    <span className="text-accent-400 font-mono">@{fediHandle || "me"}@{domain}</span>
                  </div>
                  <div className="divider" />
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Recovery Email</span>
                    <span className="text-white font-medium">{contactEmail || "Not set"}</span>
                  </div>
                  <div className="divider" />
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Admin Password</span>
                    <span className="text-moss-400 font-medium">Saved securely</span>
                  </div>
                </div>
              </div>

              <Link href="/" className="btn-primary text-base px-8 py-3 inline-block no-underline cursor-pointer">
                Go to your site &rarr;
              </Link>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-surface-600 text-xs mt-6">
          FediHome &mdash; Your corner of the Fediverse
        </p>
      </div>
    </div>
  );
}
