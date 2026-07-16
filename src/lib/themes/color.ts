/**
 * Small colour helpers for deriving an accent scale from a single base colour
 * (#250). A theme author — or the owner picking an accent colour (#201) — gives
 * one `#RRGGBB`; we generate the 50–900 scale by mixing toward white (lighter
 * shades) and black (darker shades), keeping 500 = the base. Deterministic and
 * pure, so it's easy to unit-test.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Linear mix of `rgb` toward `target` by `amount` (0 = rgb, 1 = target). */
function mix(rgb: [number, number, number], target: [number, number, number], amount: number): [number, number, number] {
  return [0, 1, 2].map((i) => rgb[i] * (1 - amount) + target[i] * amount) as [number, number, number];
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

// Mix ramp: how far each shade sits from the base toward white/black. 500 = base.
const RAMP: Array<{ token: string; to: "white" | "black"; amt: number }> = [
  { token: "accent-50", to: "white", amt: 0.95 },
  { token: "accent-100", to: "white", amt: 0.88 },
  { token: "accent-200", to: "white", amt: 0.74 },
  { token: "accent-300", to: "white", amt: 0.55 },
  { token: "accent-400", to: "white", amt: 0.28 },
  { token: "accent-500", to: "white", amt: 0 },
  { token: "accent-600", to: "black", amt: 0.12 },
  { token: "accent-700", to: "black", amt: 0.28 },
  { token: "accent-800", to: "black", amt: 0.45 },
  { token: "accent-900", to: "black", amt: 0.58 },
];

/**
 * Derive the accent-50…900 scale from a base `#RRGGBB` (which becomes accent-500).
 * Returns a map of `accent-<n>` → hex, or `{}` if the base isn't a valid hex.
 */
export function deriveAccentScale(base: string): Record<string, string> {
  const rgb = hexToRgb(base);
  if (!rgb) return {};
  const out: Record<string, string> = {};
  for (const { token, to, amt } of RAMP) {
    out[token] = rgbToHex(mix(rgb, to === "white" ? WHITE : BLACK, amt));
  }
  return out;
}
