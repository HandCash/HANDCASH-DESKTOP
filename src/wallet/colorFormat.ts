/** Convert #rgb / #rrggbb to space-separated HSL channels for `hsl(var(--token))`. */
export function hexToHslChannels(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  const r = Number.parseInt(full.slice(0, 2), 16) / 255
  const g = Number.parseInt(full.slice(2, 4), 16) / 255
  const b = Number.parseInt(full.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return `0 0% ${Math.round(l * 1000) / 10}%`
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6
      break
    case g:
      h = ((b - r) / d + 2) / 6
      break
    default:
      h = ((r - g) / d + 4) / 6
  }
  return `${Math.round(h * 3600) / 10} ${Math.round(s * 1000) / 10}% ${Math.round(l * 1000) / 10}%`
}

function parseRgb(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function channelLuminance(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** Relative luminance 0–1 (WCAG). */
export function relativeLuminance(hex: string): number {
  const rgb = parseRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/** Pick the ink that contrasts best against `on`. */
export function bestOnColor(on: string, dark: string, light: string): string {
  return contrastRatio(on, dark) >= contrastRatio(on, light) ? dark : light
}

/**
 * Secondary label ink. Omarchy's `dark_foreground` is often chrome-muted and
 * fails AA on light sheets (e.g. White theme `#c0c0c0` on `#fff`). Prefer a
 * readable mid ink, never a ghost.
 */
export function pickMutedInk(
  bg: string,
  candidates: Array<string | undefined>,
  fallback: string,
  minRatio = 4.5,
): string {
  for (const c of candidates) {
    if (c && contrastRatio(c, bg) >= minRatio) return c
  }
  for (const c of candidates) {
    if (c && contrastRatio(c, bg) >= 3) return c
  }
  return fallback
}

export function isLightHex(hex: string): boolean {
  return relativeLuminance(hex) > 0.55
}
