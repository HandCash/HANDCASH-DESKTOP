import { applyBrandPalette, type BrandPaletteInput } from '@aeon-ui/core'
import {
  notifySystemAppearanceChanged,
  resolveColorMode,
  subscribeAppearance,
  type AppearancePreference,
  type ResolvedColorMode,
} from './themePrefs'

const FONTS = {
  font: "'Archivo', ui-sans-serif, system-ui, sans-serif",
  fontDisplay: "'Syncopate', 'Archivo', ui-sans-serif, sans-serif",
  radius: '0.5rem',
} as const

/** Classic HandCash dark sheet. */
export const HANDCASH_DARK_PALETTE: BrandPaletteInput = {
  bg: '#000000',
  surface: '#0a0a0a',
  surfaceRaised: '#141414',
  border: '#262626',
  text: '#fafafa',
  muted: '#a1a1aa',
  accent: '#57ff97',
  accentDim: 'rgba(87, 255, 151, 0.14)',
  danger: '#f87171',
  ...FONTS,
}

/**
 * White / light sheet.
 *
 * Neutrals are handcash.io's own light `:root` — cool slate (hue 215/220), not
 * a green-tinted grey, and a soft #31363f ink rather than near-black.
 *
 * On the light sheet the load-bearing colour is black, not green: the site
 * sets `--primary` to near-black, so CTAs, focus rings and checkboxes are
 * black with white type (see the light block in `handcash.css`). Green is
 * demoted to an accent and keeps only the roles where it carries meaning —
 * balance, live/OK state, success, links, the logo glyph.
 *
 * `accent` is read as *foreground* by ~60 rules, so it cannot be the neon
 * #57ff97 (near 1.3:1 on white). It is the same brand hue (143) at L33% —
 * bright enough to read as HandCash green, dark enough to stay legible on
 * paper. The neon itself survives as `--hc-brand` for fills and glows.
 */
export const HANDCASH_LIGHT_PALETTE: BrandPaletteInput = {
  bg: '#f6f7f8',
  surface: '#fcfcfd',
  surfaceRaised: '#ebedf0',
  border: '#dce0e5',
  text: '#31363f',
  muted: '#6e7687',
  accent: '#0d9b44',
  accentDim: 'rgba(13, 155, 68, 0.12)',
  danger: '#ef4444',
  ...FONTS,
}

export function paletteForMode(mode: ResolvedColorMode): BrandPaletteInput {
  return mode === 'light' ? HANDCASH_LIGHT_PALETTE : HANDCASH_DARK_PALETTE
}

export function applyHandCashTheme(mode: ResolvedColorMode = resolveColorMode()): ResolvedColorMode {
  applyBrandPalette(paletteForMode(mode), { mode, themeId: 'handcash' })
  return mode
}

/** Boot + live updates (Settings + OS scheme when preference is system). */
export function startHandCashTheme(): () => void {
  applyHandCashTheme()

  const unsubPref = subscribeAppearance((_pref: AppearancePreference, resolved) => {
    applyHandCashTheme(resolved)
  })

  let media: MediaQueryList | null = null
  let onMedia: (() => void) | null = null
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    media = window.matchMedia('(prefers-color-scheme: light)')
    onMedia = () => notifySystemAppearanceChanged()
    media.addEventListener('change', onMedia)
  }

  return () => {
    unsubPref()
    if (media && onMedia) media.removeEventListener('change', onMedia)
  }
}
