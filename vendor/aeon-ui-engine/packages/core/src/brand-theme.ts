/**
 * Brand → Aeon CSS variable bridge.
 *
 * Product apps often already have design tokens. Instead of maintaining a parallel
 * `--product-*` layer forever, map them onto Aeon’s runtime vars so `@aeon-ui/ui`
 * recipes and `aeon.css` pick up the brand without forking Panda.
 */
import type { AeonColorMode } from './theme.js'

/** Minimal brand fields — anything omitted gets a safe default. */
export type BrandPaletteInput = {
  bg: string
  surface: string
  surfaceRaised?: string
  border: string
  text: string
  muted: string
  accent: string
  accentDim?: string
  danger?: string
  dangerDim?: string
  gridLine?: string
  /** Optional product fonts (applied as --aeon-font / --aeon-font-display). */
  font?: string
  fontDisplay?: string
  radius?: string
}

export type BrandPalette = Required<
  Pick<
    BrandPaletteInput,
    | 'bg'
    | 'surface'
    | 'surfaceRaised'
    | 'border'
    | 'text'
    | 'muted'
    | 'accent'
    | 'accentDim'
    | 'danger'
    | 'dangerDim'
    | 'gridLine'
  >
> & {
  font?: string
  fontDisplay?: string
  radius?: string
  focusRing: string
}

const DEFAULT_DANGER = { light: '#dc2626', dark: '#f87171' } as const

function focusRing(bg: string, accent: string) {
  return `0 0 0 2px ${bg}, 0 0 0 4px ${accent}`
}

/** Normalize a partial brand palette into a full Aeon-compatible palette. */
export function normalizeBrandPalette(
  input: BrandPaletteInput,
  mode: AeonColorMode = 'dark',
): BrandPalette {
  const danger = input.danger ?? DEFAULT_DANGER[mode]
  return {
    bg: input.bg,
    surface: input.surface,
    surfaceRaised: input.surfaceRaised ?? input.surface,
    border: input.border,
    text: input.text,
    muted: input.muted,
    accent: input.accent,
    accentDim: input.accentDim ?? `${input.accent}2e`,
    danger,
    dangerDim: input.dangerDim ?? `${danger}18`,
    gridLine:
      input.gridLine ??
      (mode === 'light' ? 'rgba(15, 23, 42, 0.07)' : 'rgba(255, 255, 255, 0.05)'),
    font: input.font,
    fontDisplay: input.fontDisplay,
    radius: input.radius,
    focusRing: focusRing(input.bg, input.accent),
  }
}

/** CSS custom properties Aeon recipes already read. */
export function brandPaletteToCssVars(palette: BrandPalette): Record<string, string> {
  const vars: Record<string, string> = {
    '--colors-aeon-bg': palette.bg,
    '--colors-aeon-surface': palette.surface,
    '--colors-aeon-surface-raised': palette.surfaceRaised,
    '--colors-aeon-border': palette.border,
    '--colors-aeon-text': palette.text,
    '--colors-aeon-muted': palette.muted,
    '--colors-aeon-accent': palette.accent,
    '--colors-aeon-accent-dim': palette.accentDim,
    '--colors-aeon-danger': palette.danger,
    '--colors-aeon-danger-dim': palette.dangerDim,
    '--shadows-focus-ring': palette.focusRing,
    '--aeon-grid-line': palette.gridLine,
  }
  if (palette.font) {
    // Recipes read --fonts-ui / --fonts-body; also expose --aeon-font for shells.
    vars['--aeon-font'] = palette.font
    vars['--fonts-ui'] = palette.font
    vars['--fonts-body'] = palette.font
  }
  if (palette.fontDisplay) {
    vars['--aeon-font-display'] = palette.fontDisplay
    vars['--fonts-display'] = palette.fontDisplay
  }
  if (palette.radius) {
    vars['--aeon-radius'] = palette.radius
    vars['--radii-aeon'] = palette.radius
  }
  return vars
}

export type ApplyBrandPaletteOptions = {
  mode?: AeonColorMode
  /** Theme id stamped on <html> (default: `brand`). */
  themeId?: string
  /** Persist mode/theme to localStorage (default: false — brand apps usually own prefs). */
  persist?: boolean
  root?: HTMLElement
}

/**
 * Apply a product brand palette to the document so Aeon CSS vars match the app.
 * Does not require registering a catalog theme — one call at boot is enough.
 *
 * @example
 * applyBrandPalette({
 *   bg: '#000', surface: '#0a0a0a', border: '#262626',
 *   text: '#fafafa', muted: '#a1a1aa', accent: '#57ff97',
 * }, { mode: 'dark' })
 */
export function applyBrandPalette(
  input: BrandPaletteInput,
  options: ApplyBrandPaletteOptions = {},
): BrandPalette {
  const mode = options.mode ?? 'dark'
  const palette = normalizeBrandPalette(input, mode)
  if (typeof document === 'undefined') return palette

  const root = options.root ?? document.documentElement
  const themeId = options.themeId ?? 'brand'
  root.dataset.aeonTheme = themeId
  root.dataset.aeonMode = mode
  root.style.colorScheme = mode

  const vars = brandPaletteToCssVars(palette)
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', palette.bg)

  if (options.persist) {
    try {
      localStorage.setItem('aeon-theme', themeId)
      localStorage.setItem('aeon-mode', mode)
    } catch {
      /* private mode */
    }
  }

  return palette
}

/** Serialize palette vars for injecting a `<style>` tag (SSR / non-DOM). */
export function brandPaletteToCssText(
  input: BrandPaletteInput,
  options: { mode?: AeonColorMode; selector?: string } = {},
): string {
  const mode = options.mode ?? 'dark'
  const palette = normalizeBrandPalette(input, mode)
  const vars = brandPaletteToCssVars(palette)
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  const selector = options.selector ?? 'html'
  return `${selector} {\n  color-scheme: ${mode};\n${body}\n}`
}
