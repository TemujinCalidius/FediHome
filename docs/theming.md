# Theming

FediHome uses Tailwind CSS with custom design tokens defined in CSS variables. You can customize colors, fonts, and layout without modifying component code.

## Theme Architecture

All theme variables are defined in `src/app/globals.css` inside the `@theme` block. Tailwind picks these up as custom utilities, so they're available throughout the app as classes like `bg-surface-900` or `text-accent-400`.

The default theme is a dark palette with blue accents:

```css
@theme {
  /* Neutral slate dark palette */
  --color-surface-950: #0a0a0f;
  --color-surface-900: #111118;
  --color-surface-800: #1a1a24;
  --color-surface-700: #252530;
  --color-surface-600: #3a3a4a;

  /* Blue accent */
  --color-accent-50:  #eff6ff;
  --color-accent-100: #dbeafe;
  --color-accent-200: #bfdbfe;
  --color-accent-300: #93c5fd;
  --color-accent-400: #60a5fa;
  --color-accent-500: #3b82f6;
  --color-accent-600: #2563eb;
  --color-accent-700: #1d4ed8;
  --color-accent-800: #1e40af;
  --color-accent-900: #1e3a8a;

  /* Success green */
  --color-moss-400: #34d399;
  --color-moss-500: #10b981;
  --color-moss-600: #059669;

  /* Typography */
  --font-display: "Source Serif 4", "Georgia", serif;
  --font-body: "Inter", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", monospace;
}
```

## Changing the Accent Color

The accent color is used for links, buttons, borders, badges, and interactive elements throughout the UI.

### Method 1: Admin Panel

The simplest way is to change the accent color in the admin panel settings. This sets the `accentColor` field in the `SiteSettings` database table.

### Method 2: Edit globals.css

For full control over the entire accent scale, edit `src/app/globals.css`:

```css
@theme {
  /* Example: change to purple */
  --color-accent-50:  #faf5ff;
  --color-accent-100: #f3e8ff;
  --color-accent-200: #e9d5ff;
  --color-accent-300: #d8b4fe;
  --color-accent-400: #c084fc;
  --color-accent-500: #a855f7;
  --color-accent-600: #9333ea;
  --color-accent-700: #7e22ce;
  --color-accent-800: #6b21a8;
  --color-accent-900: #581c87;
}
```

Each shade (50 through 900) is used in different contexts:
- **accent-400/500** — Primary interactive elements (links, buttons)
- **accent-50/100** — Very light tints (text on dark backgrounds)
- **accent-600/700** — Hover states, button gradients
- **accent-800/900** — Darkest accents (rarely used in dark theme)

You can generate a consistent color scale from any base color using tools like [uicolors.app](https://uicolors.app/create) or [tailwindshades.com](https://www.tailwindshades.com/).

The button gradient in `.btn-primary` and border colors in `.glass-card` also reference the accent color directly. If you change the accent palette, update these too:

```css
.btn-primary {
  background: linear-gradient(135deg, #a855f7 0%, #9333ea 100%);
}

.btn-primary:hover {
  box-shadow: 0 4px 16px rgba(168, 85, 247, 0.25);
}

.glass-card {
  border: 1px solid rgba(168, 85, 247, 0.1);
}

.glass-card:hover {
  border-color: rgba(168, 85, 247, 0.2);
}
```

## Changing Surface Colors

The surface palette controls the background colors of the page, cards, and panels:

```css
@theme {
  /* Example: warmer dark palette */
  --color-surface-950: #0f0d0a;
  --color-surface-900: #1a1714;
  --color-surface-800: #252118;
  --color-surface-700: #332d22;
  --color-surface-600: #4a4232;
}
```

The body background is `surface-950`, cards use `surface-900`, and borders/dividers use `surface-700/800`.

## Changing Fonts

FediHome ships with three font families:

- **Display** (`font-display`) — Used for headings. Default: Source Serif 4 (serif)
- **Body** (`font-body`) — Used for body text, navigation, UI elements. Default: Inter (sans-serif)
- **Mono** (`font-mono`) — Used for code blocks and inline code. Default: JetBrains Mono

### Replacing a Font

1. Download the font file(s) in `.woff2` format
2. Place them in `public/fonts/`
3. Update the `@font-face` rule in `globals.css`:

```css
@font-face {
  font-family: "Your Font Name";
  src: url("/fonts/YourFont-Variable.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
```

4. Update the `@theme` block:

```css
@theme {
  --font-body: "Your Font Name", system-ui, sans-serif;
}
```

### Using System Fonts Only

To skip custom font loading entirely and use system fonts:

```css
@theme {
  --font-display: Georgia, "Times New Roman", serif;
  --font-body: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", "Consolas", monospace;
}
```

Then remove or comment out the `@font-face` rules.

## Custom CSS Overrides

You can add custom CSS at the bottom of `globals.css`. Styles defined there take precedence over Tailwind utilities when specificity is equal.

Examples:

```css
/* Make all headings use the accent color */
h1, h2, h3, h4, h5, h6 {
  color: var(--color-accent-400);
}

/* Rounded avatar instead of default */
.avatar-img {
  border-radius: 50%;
}

/* Custom link underline style */
a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* Hide the footer entirely */
footer {
  display: none;
}
```

## Component Classes

FediHome uses several reusable CSS classes defined in `globals.css`:

| Class | Purpose |
|-------|---------|
| `.glass-card` | Card container with translucent background, blur, and subtle border. Used for post cards, timeline entries, and panels. |
| `.btn-primary` | Solid gradient button (accent color). Used for primary actions. |
| `.btn-outlined` | Outlined button with accent border. Used for secondary actions. |
| `.divider` | A subtle horizontal line with gradient fade on edges. |
| `.fedi-badge` | Small pill-shaped badge for Fediverse interaction counts. |
| `.lightbox-overlay` | Full-screen overlay for the photo lightbox. |

You can override any of these to change the look of core UI elements.

## Uploading Custom Avatar and Banner

### Avatar

Replace the file at `public/images/avatar.png` with your own image. The recommended size is 400x400 pixels. PNG or WebP format.

The avatar is used in:
- The site navbar
- Your ActivityPub profile (what Mastodon users see)
- RSS feed metadata

### Banner

Replace the file at `public/images/banner.webp` with your own image. The recommended size is at least 1500x500 pixels. WebP format is preferred for file size.

The banner is used in:
- The homepage header area
- Your ActivityPub profile header image

### Open Graph Image

Replace `public/images/og-image.webp` with a custom image (1200x630 pixels recommended). This is the default image shown when your site URL is shared on social media without a specific post cover image.

After replacing any of these files, the changes take effect immediately (or after clearing any CDN cache if you use one).
