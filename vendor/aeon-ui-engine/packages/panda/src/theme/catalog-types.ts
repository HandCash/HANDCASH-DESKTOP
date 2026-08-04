export type AeonMode = 'light' | 'dark'

export interface AeonPalette {
  bg: string
  surface: string
  surfaceRaised: string
  border: string
  text: string
  muted: string
  accent: string
  accentDim: string
  danger: string
  dangerDim: string
  focusRing: string
  gridLine: string
}

export interface AeonThemeDefinition {
  id: string
  label: string
  description: string
  /** Canonical mode for scroll-cycle / one-sided terminal themes. */
  preferredMode?: AeonMode
  light: AeonPalette
  dark: AeonPalette
}
