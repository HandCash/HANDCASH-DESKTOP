/**
 * Map Omarchy desktop colors onto HandCash / Aeon brand tokens.
 * Active when Appearance is System and Omarchy is detected.
 */
import type { BrandPaletteInput } from '@aeon-ui/core'
import {
  bestOnColor,
  hexToHslChannels,
  isLightHex,
  pickMutedInk,
  relativeLuminance,
} from './colorFormat'

const FONTS = {
  font: "'Archivo', ui-sans-serif, system-ui, sans-serif",
  fontDisplay: "'Syncopate', 'Archivo', ui-sans-serif, sans-serif",
  radius: '0.5rem',
} as const

/** Mirrors electron/omarchyTheme.ts OmarchyColors (renderer-safe). */
export type OmarchyColors = {
  mode: 'light' | 'dark'
  name: string
  background: string
  darkBackground: string
  darkerBackground: string
  lighterBackground: string
  foreground: string
  darkForeground: string
  /** Mid ink — often better for muted labels on light sheets than darkForeground. */
  lightForeground: string
  brightForeground: string
  accent: string
  muted: string
  selection: string
  red: string
  green: string
}

export type OmarchyThemeSnapshot =
  | { ok: true; detected: true; colors: OmarchyColors }
  | { ok: true; detected: false }
  | { ok: false; error: string }

function lightSurfaces(colors: OmarchyColors): {
  bg: string
  surface: string
  surfaceRaised: string
  border: string
} {
  const bg = colors.background
  // Cards need a real lift: pure white on tinted paper, or a soft panel on white.
  const surface = isLightHex(bg) && relativeLuminance(bg) > 0.92 ? colors.darkBackground : '#ffffff'
  const surfaceRaised = colors.darkBackground
  // Prefer selection (subtle) over chrome-muted greys that can dominate light UI.
  const border =
    relativeLuminance(colors.muted) < 0.45 ? colors.selection || colors.muted : colors.muted
  return { bg, surface, surfaceRaised, border }
}

export function omarchyPalette(colors: OmarchyColors): BrandPaletteInput {
  const mode = colors.mode
  if (mode === 'light') {
    const { bg, surface, surfaceRaised, border } = lightSurfaces(colors)
    const muted = pickMutedInk(
      bg,
      [colors.lightForeground, colors.foreground, colors.darkForeground],
      colors.brightForeground,
    )
    return {
      bg,
      surface,
      surfaceRaised,
      border,
      text: colors.brightForeground,
      muted,
      // Accent stays the theme colour for meaning (active tabs, balances, links).
      accent: colors.accent,
      accentDim: `${colors.accent}24`,
      danger: colors.red,
      ...FONTS,
    }
  }

  const bg = colors.darkerBackground
  const muted = pickMutedInk(
    bg,
    [colors.lightForeground, colors.foreground, colors.brightForeground],
    colors.brightForeground,
    4.2,
  )
  return {
    bg,
    surface: colors.background,
    surfaceRaised: colors.lighterBackground,
    // Prefer selection over chrome-muted greys — those read as “faded UI” on borders.
    border: colors.selection,
    text: colors.brightForeground,
    muted,
    accent: colors.accent,
    accentDim: `${colors.accent}2e`,
    danger: colors.red,
    ...FONTS,
  }
}

const OMARCHY_STYLE_KEYS = [
  '--hc-brand',
  '--hc-success',
  '--hc-sunken-soft',
  '--hc-sunken',
  '--hc-sunken-strong',
  '--hc-field',
  '--hc-hover',
  '--hc-deep',
  '--hc-accent-deep',
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--border',
  '--input',
  '--ring',
] as const

/** Sync shadcn HSL channel tokens + chrome so CTAs / lists stay readable. */
export function markOmarchyTheme(colors: OmarchyColors): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const setHsl = (name: string, hex: string) => {
    const channels = hexToHslChannels(hex)
    if (channels) root.style.setProperty(name, channels)
  }
  const set = (name: string, value: string) => root.style.setProperty(name, value)

  root.dataset.omarchyTheme = colors.name
  const palette = omarchyPalette(colors)
  const mode = colors.mode
  const text = palette.text
  const surface = palette.surface
  const surfaceRaised = palette.surfaceRaised ?? palette.surface
  const border = palette.border
  const muted = palette.muted
  const bg = palette.bg

  // Brand mark / success fills expect HSL channels, not #rrggbb.
  setHsl('--hc-brand', colors.green)
  set('--hc-success', mode === 'light' ? colors.green : `hsl(var(--hc-brand))`)
  // Currency / balance ink stays HandCash dark green — never Omarchy accent.
  set('--hc-accent-deep', '#0c8f3e')

  setHsl('--background', bg)
  setHsl('--foreground', text)
  setHsl('--card', surface)
  setHsl('--card-foreground', text)
  setHsl('--popover', surfaceRaised)
  setHsl('--popover-foreground', text)

  /*
   * CTAs: HandCash light uses ink (not pastel accent) as --primary so buttons
   * stay solid. Soft Omarchy accents (White #6e6e6e, Rose Pine teal) look faded
   * as filled buttons — keep accent for meaning, ink for chrome.
   */
  if (mode === 'light') {
    setHsl('--primary', text)
    setHsl('--primary-foreground', bestOnColor(text, '#0a0a0a', '#ffffff'))
  } else {
    setHsl('--primary', colors.accent)
    setHsl(
      '--primary-foreground',
      bestOnColor(colors.accent, colors.darkerBackground, colors.brightForeground),
    )
  }

  setHsl('--secondary', surfaceRaised)
  setHsl('--secondary-foreground', text)
  setHsl('--muted', colors.selection)
  setHsl('--muted-foreground', muted)
  setHsl('--accent', colors.selection)
  setHsl('--accent-foreground', text)
  setHsl('--destructive', colors.red)
  setHsl('--border', border)
  setHsl('--input', border)
  setHsl('--ring', colors.accent)

  // Recessed / hover washes — dark-sheet rgba(0,0,0,…) and light HandCash
  // defaults both fail on tinted Omarchy paper if left alone.
  if (mode === 'light') {
    set('--hc-sunken-soft', 'color-mix(in srgb, var(--hc-text) 4%, transparent)')
    set('--hc-sunken', 'color-mix(in srgb, var(--hc-text) 6%, transparent)')
    set('--hc-sunken-strong', 'color-mix(in srgb, var(--hc-text) 9%, transparent)')
    set('--hc-hover', 'color-mix(in srgb, var(--hc-text) 5%, transparent)')
    set('--hc-field', surface)
    set('--hc-deep', surface)
  } else {
    set('--hc-sunken-soft', 'color-mix(in srgb, #000 28%, transparent)')
    set('--hc-sunken', 'color-mix(in srgb, #000 36%, transparent)')
    set('--hc-sunken-strong', 'color-mix(in srgb, #000 46%, transparent)')
    set('--hc-hover', 'color-mix(in srgb, #fff 5%, transparent)')
    set('--hc-field', surfaceRaised)
    set('--hc-deep', bg)
  }
}

export function clearOmarchyThemeMarkers(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  delete root.dataset.omarchyTheme
  for (const key of OMARCHY_STYLE_KEYS) root.style.removeProperty(key)
}
