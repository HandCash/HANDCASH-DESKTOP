import { applyBrandPalette, type BrandPaletteInput } from '@aeon-ui/core'
import {
  notifySystemAppearanceChanged,
  resolveColorMode,
  getAppearancePreference,
  subscribeAppearance,
  type AppearancePreference,
  type ResolvedColorMode,
} from './themePrefs'
import {
  clearOmarchyThemeMarkers,
  markOmarchyTheme,
  omarchyPalette,
  type OmarchyThemeSnapshot,
} from './omarchyTheme'

const FONTS = {
  font: "'Archivo', ui-sans-serif, system-ui, sans-serif",
  fontDisplay: "'Syncopate', 'Archivo', ui-sans-serif, sans-serif",
  radius: '0.5rem',
} as const

/**
 * Classic HandCash dark sheet.
 *
 * True black stage (`#000`) keeps the neon `#57ff97` at max pop — that pairing
 * *is* the brand. Surfaces step up in neutral zinc, not green-tinted grey, so
 * panels read as depth instead of “muddy black”.
 */
export const HANDCASH_DARK_PALETTE: BrandPaletteInput = {
  bg: '#000000',
  surface: '#0a0a0a',
  surfaceRaised: '#161616',
  border: '#2a2a2a',
  text: '#f4f4f5',
  muted: '#a1a1aa',
  accent: '#57ff97',
  accentDim: 'rgba(87, 255, 151, 0.14)',
  danger: '#f87171',
  ...FONTS,
}

/**
 * HandCash light / paper sheet.
 *
 * Previous cool-slate neutrals (hue ~215) made “white” look bluish and dirty
 * next to true `#fff` fields. Neutrals now sit on a *whisper* of brand green
 * (hue ~140, very low chroma): paper feels clean, cards are pure white for
 * clear elevation, and ink stays near-black without a blue cast.
 *
 * Load-bearing chrome is still black (`--primary` in CSS), not neon. Green
 * stays meaning-only (balance, live, success, logo). Accent here is deep
 * brand green so it can be used as *foreground* on paper (~4.5:1+).
 */
export const HANDCASH_LIGHT_PALETTE: BrandPaletteInput = {
  bg: '#f3f5f3',
  surface: '#ffffff',
  surfaceRaised: '#e8ece8',
  border: '#d2d8d2',
  text: '#1a1f1a',
  muted: '#5a635c',
  accent: '#0c8f3e',
  accentDim: 'rgba(12, 143, 62, 0.11)',
  danger: '#dc2626',
  ...FONTS,
}

export function paletteForMode(mode: ResolvedColorMode): BrandPaletteInput {
  return mode === 'light' ? HANDCASH_LIGHT_PALETTE : HANDCASH_DARK_PALETTE
}

let lastOmarchy: OmarchyThemeSnapshot | null = null

function omarchyActiveForPref(pref: AppearancePreference): boolean {
  return (
    pref === 'system' &&
    lastOmarchy?.ok === true &&
    lastOmarchy.detected === true
  )
}

export function applyHandCashTheme(
  mode: ResolvedColorMode = resolveColorMode(),
): ResolvedColorMode {
  const pref = getAppearancePreference()
  if (omarchyActiveForPref(pref) && lastOmarchy && lastOmarchy.ok && lastOmarchy.detected) {
    const colors = lastOmarchy.colors
    applyBrandPalette(omarchyPalette(colors), {
      mode: colors.mode,
      themeId: `omarchy-${colors.name.toLowerCase().replace(/\s+/g, '-')}`,
    })
    markOmarchyTheme(colors)
    return colors.mode
  }
  clearOmarchyThemeMarkers()
  applyBrandPalette(paletteForMode(mode), { mode, themeId: 'handcash' })
  return mode
}

function ingestOmarchy(snap: OmarchyThemeSnapshot): void {
  lastOmarchy = snap
  if (getAppearancePreference() === 'system') {
    applyHandCashTheme(resolveColorMode('system'))
  }
}

/** Boot + live updates (Settings + OS scheme + Omarchy theme-set). */
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

  let unsubOmarchy: (() => void) | null = null
  const bridge = typeof window !== 'undefined' ? window.handcash : undefined
  if (bridge?.getOmarchyTheme) {
    void bridge.getOmarchyTheme().then(ingestOmarchy).catch(() => {})
  }
  if (bridge?.onOmarchyTheme) {
    unsubOmarchy = bridge.onOmarchyTheme(ingestOmarchy)
  }

  return () => {
    unsubPref()
    unsubOmarchy?.()
    if (media && onMedia) media.removeEventListener('change', onMedia)
  }
}
