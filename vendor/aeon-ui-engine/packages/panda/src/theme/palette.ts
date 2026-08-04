import type { AeonPalette, AeonThemeDefinition } from './catalog-types.js'

/** Minimal palette fields — edit this shape in themes.config.ts */
export interface AeonPaletteInput {
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
}

export interface AeonThemeConfigEntry {
  id: string
  label: string
  description: string
  /** Canonical Omarchy / terminal mode when the theme is primarily one-sided. */
  preferredMode?: 'light' | 'dark'
  light: AeonPaletteInput
  dark: AeonPaletteInput
}

const focusRing = (bg: string, accent: string) =>
  `0 0 0 2px ${bg}, 0 0 0 4px ${accent}`

const DEFAULT_DANGER = { light: '#dc2626', dark: '#f87171' } as const

/** Turn a short config entry into a full runtime palette (focus ring, dims, etc.). */
export function definePalette(mode: 'light' | 'dark', input: AeonPaletteInput): AeonPalette {
  const danger = input.danger ?? DEFAULT_DANGER[mode]
  const accentDim = input.accentDim ?? `${input.accent}2e`
  const dangerDim = input.dangerDim ?? `${danger}18`
  const surfaceRaised = input.surfaceRaised ?? input.surface

  return {
    bg: input.bg,
    surface: input.surface,
    surfaceRaised,
    border: input.border,
    text: input.text,
    muted: input.muted,
    accent: input.accent,
    accentDim,
    danger,
    dangerDim,
    focusRing: focusRing(input.bg, input.accent),
    gridLine:
      input.gridLine ??
      (mode === 'light' ? 'rgba(15, 23, 42, 0.07)' : 'rgba(255, 255, 255, 0.05)'),
  }
}

/** Build theme definitions from themes.config.ts entries. */
export function themesFromConfig(entries: readonly AeonThemeConfigEntry[]): AeonThemeDefinition[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    preferredMode: entry.preferredMode,
    light: definePalette('light', entry.light),
    dark: definePalette('dark', entry.dark),
  }))
}
