import type { Theme } from "./types";
import { CONTENT_RAMP } from "./content";

/**
 * The default ("Cards") theme — today's look, extracted verbatim from the
 * `@theme` block in globals.css so it's the single source of truth for the
 * base palette + type. A default instance injects NOTHING at runtime (the
 * resolved tokens equal these), so it renders pixel-identically.
 */
export const DEFAULT_THEME: Theme = {
  id: "default",
  name: "Cards",
  description: "The default FediHome look — a near-black glassy dark UI with a bright-blue accent.",
  tokens: {
    colors: {
      "surface-950": "#0a0a0f",
      "surface-900": "#111118",
      "surface-800": "#1a1a24",
      "surface-700": "#252530",
      "surface-600": "#3a3a4a",
      "accent-50": "#eff6ff",
      "accent-100": "#dbeafe",
      "accent-200": "#bfdbfe",
      "accent-300": "#93c5fd",
      "accent-400": "#60a5fa",
      "accent-500": "#3b82f6",
      "accent-600": "#2563eb",
      "accent-700": "#1d4ed8",
      "accent-800": "#1e40af",
      "accent-900": "#1e3a8a",
      "moss-400": "#34d399",
      "moss-500": "#10b981",
      "moss-600": "#059669",
      // Text ramp (#250) — the Tailwind neutrals the components already used.
      ...CONTENT_RAMP,
    },
    fonts: {
      display: '"Source Serif 4", "Georgia", serif',
      body: '"Inter", system-ui, -apple-system, sans-serif',
      mono: '"JetBrains Mono", "Fira Code", monospace',
    },
    // Today's texture, verbatim from globals.css — so a default instance emits
    // no feel overrides and renders byte-identically.
    feel: {
      radiusCard: "12px",
      radiusButton: "8px",
      glassFilter: "blur(12px)",
    },
  },
  // "Cards" renders the feed as glass cards — today's look.
  layout: { feed: "cards", header: "bar", footer: "row", shell: "normal" },
};
