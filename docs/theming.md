# Theming

FediHome's look is a **theme**: a bundle of design tokens (colour, type, feel)
plus a chosen **layout variant for each region** of the page. There are two ways
to change it — pick one based on who you are:

- **Site owner?** Everything below in [From the admin panel](#from-the-admin-panel)
  is web-editable, no file editing or restart.
- **Developer adding a built-in theme?** Jump to [Authoring a theme](#authoring-a-theme).

---

## From the admin panel

**Admin → Site settings → Appearance** controls all of this live:

| Control | What it does |
|---|---|
| **Theme** | Pick a built-in theme — Cards (default), Editorial, Classic Blog. Sets colours, fonts, feel and every region's layout at once. |
| **Accent colour** | Any `#RRGGBB`, **per theme** (each theme remembers its own). "Use theme's accent" reverts to the theme's built-in colour. |
| **Header / Feed / Footer / Page width** | Override any single region's variant (bar/centered/minimal, cards/list, row/minimal/columns, normal/narrow/sidebar). "Inherit from theme" uses the theme's own default. |
| **Sidebar side / blocks** | When the shell is a sidebar: left or right, and an ordered list of blocks (`about, recent, sections, connect`) — omit one to hide it. |

**Profile picture & banner** live in **Admin → Site settings → Your profile**
(or during first-run setup) — upload directly, no file swapping.

Under the hood these write to the `SiteSetting` / `SiteSettings` overlay, read
back within ~60s. Env vars (`THEME`, `LAYOUT_*`, `SIDEBAR_*`, `ACCENT_COLOR`, …)
still work as defaults for automated deploys; a saved admin value wins.

---

## How themes work

A **theme is pure data** (`src/lib/themes/<id>.ts`): the design tokens the UI
resolves to at runtime, plus its layout presets. Everything visual references a
CSS variable (`var(--color-*)`, `var(--font-*)`, `var(--radius-*)`,
`var(--glass-filter)`), defined in `src/app/globals.css`'s `@theme` block. At
runtime `buildThemeStyle` (`src/lib/themes/index.ts`) emits **only the tokens
that differ from the default** as a `:root:root{…}` block and injects it in the
root layout — so the default theme injects nothing and is byte-identical, and a
theme only ships its deltas.

The `Theme` contract (`src/lib/themes/types.ts`):

```ts
interface Theme {
  id: string;
  name: string;
  description?: string;
  tokens: {
    colors: Record<ColorToken, string>;   // surface-950…600, accent-50…900, moss-400…600
    fonts:  { display; body; mono };
    feel:   { radiusCard; radiusButton; glassFilter };  // e.g. "8px", "blur(12px)", "none"
  };
  layout:  { feed; header; footer; shell };             // a variant per region
  sidebar?: { side?; blocks? };                         // preset, if shell is "sidebar"
}
```

### Regions × variants

Layout is a curated catalogue, not arbitrary markup (so a theme can't break
ActivityPub actor pages, feeds, SEO or a11y). Each region offers a fixed set of
variants (`src/lib/themes/layout.ts`, `LAYOUT_REGIONS`):

| Region | Variants |
|---|---|
| `feed`   | `cards` · `list` |
| `header` | `bar` · `centered` · `minimal` |
| `footer` | `row` · `minimal` · `columns` |
| `shell`  | `normal` · `narrow` · `sidebar` |

A theme sets a default variant per region; the owner can override any one from
the admin panel (`resolveLayout` / `resolveSidebar` layer owner → theme →
built-in default).

---

## Authoring a theme

Adding a built-in theme is **one data file + one registry line** — no other
wiring. It auto-appears in the admin theme picker and the first-run wizard
(both iterate the `THEMES` registry).

1. **Create `src/lib/themes/<id>.ts`.** Copy an existing one as a template —
   `editorial.ts` (warm, list feed) or `classic.ts` (sidebar shell) are the
   closest to a "second look".

   ```ts
   import type { Theme } from "./types";

   export const OCEAN_THEME: Theme = {
     id: "ocean",
     name: "Ocean",
     description: "Cool teal on deep navy — a calm reading theme.",
     tokens: {
       colors: {
         "surface-950": "#0a1420", /* … 900/800/700/600, monotonic in luminance */
         // Pin the accent ramp from a single base — see the constraint below:
         "accent-500": "#2f8f83", /* …the full 50–900 scale, pinned */
         "moss-400": "#…", "moss-500": "#…", "moss-600": "#…",
       },
       fonts: { display: '…', body: '…', mono: '"JetBrains Mono", monospace' },
       feel:  { radiusCard: "12px", radiusButton: "8px", glassFilter: "blur(12px)" },
     },
     layout:  { feed: "list", header: "bar", footer: "row", shell: "normal" },
     // sidebar: { side: "left", blocks: ["about", "recent", "connect"] }, // if shell: "sidebar"
   };
   ```

2. **Register it** in `src/lib/themes/registry.ts`:

   ```ts
   import { OCEAN_THEME } from "./ocean";
   export const THEMES = { …, [OCEAN_THEME.id]: OCEAN_THEME };
   ```

3. **Run the tests** — `themes.test.ts` iterates every registered theme and
   enforces the constraints below, so a bad theme fails CI rather than shipping.

### Constraints (enforced by `themes.test.ts`)

- **Themes must be dark.** Components hard-code Tailwind neutrals (`text-white`,
  `text-gray-*`) for body/secondary text, and `@theme` *extends* the palette so
  those neutrals stay fixed while `surface-*` moves. On a light ground
  `text-white` lands at ~1:1 — an invisible site. A contrast invariant requires
  `white` / `gray-200` / `gray-400` to stay ≥ 4.5:1 (AA) on your `surface-950`.
  (Light themes await a `text-white`/`gray-*` → token migration — tracked in #250.)
- **Fonts swap families only.** `buildThemeStyle` can't register `@font-face`,
  and only **Inter** and **Source Serif 4** are self-hosted, so pick among those
  (+ system fallbacks). Adding a new face means an `@font-face` in `globals.css`.
- **Pin the accent ramp.** Generate the 50–900 scale from your base with
  `deriveAccentScale("#…")` (`src/lib/themes/color.ts`) and paste the literal
  values — so the shipped theme's identity can't drift if that ramp is ever
  retuned. (This is the same ramp a per-theme custom accent goes through.)
- **`mono` and any token equal to the default diff out** and are never emitted —
  only your real deltas ship.

---

## Deeper changes in `globals.css`

For anything below the token layer, edit `src/app/globals.css`:

- The `@theme` block defines the **default** token values (what other themes diff
  against) and the Tailwind utilities (`bg-surface-900`, `text-accent-400`, …).
- The `@font-face` rules self-host the fonts (`public/fonts/`).
- Component classes — `.glass-card`, `.btn-primary`, `.btn-outlined`, `.divider`,
  `.fedi-badge`, `.lightbox-overlay` — style the reusable UI pieces and read the
  feel tokens (`var(--radius-card)`, `var(--glass-filter)`). Override any of them
  for a site-wide tweak.

Changes here are compiled into the build (not runtime-swappable per theme), so
they affect every theme's baseline.

## Open Graph image

Avatar and banner are web-editable (above). The social-share fallback image is
still a file: replace `public/images/og-image.webp` (1200×630 recommended). It's
used when a URL is shared without a post-specific cover.
