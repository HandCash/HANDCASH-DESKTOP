import { AEON_THEMES, type AeonMode, type AeonPalette } from './catalog.js'

type ThemeCssVars = Record<string, string>

function paletteVars(p: AeonPalette): ThemeCssVars {
  return {
    '--colors-aeon-bg': p.bg,
    '--colors-aeon-surface': p.surface,
    '--colors-aeon-surface-raised': p.surfaceRaised,
    '--colors-aeon-border': p.border,
    '--colors-aeon-text': p.text,
    '--colors-aeon-muted': p.muted,
    '--colors-aeon-accent': p.accent,
    '--colors-aeon-accent-dim': p.accentDim,
    '--colors-aeon-danger': p.danger,
    '--colors-aeon-danger-dim': p.dangerDim,
    '--shadows-focus-ring': p.focusRing,
    '--aeon-grid-line': p.gridLine,
    '--aeon-scrollbar-size': '10px',
    '--aeon-scrollbar-track': p.surface,
    '--aeon-scrollbar-thumb': p.border,
    '--aeon-scrollbar-thumb-hover': p.muted,
    '--aeon-scrollbar-corner': p.surfaceRaised,
  }
}

/** Runtime theme × mode overrides — one source for Panda + landing CSS. */
export function buildThemeGlobalCss(): Record<string, ThemeCssVars & { colorScheme?: AeonMode }> {
  const rules: Record<string, ThemeCssVars & { colorScheme?: AeonMode }> = {}

  // Safe dark defaults before attribute selectors resolve (prevents light scrollbar FOUC).
  const defaultDark = AEON_THEMES.find((t) => t.id === 'default')?.dark
  if (defaultDark) {
    rules['html'] = {
      colorScheme: 'dark',
      ...paletteVars(defaultDark),
    }
  }

  for (const theme of AEON_THEMES) {
    for (const mode of ['light', 'dark'] as const satisfies AeonMode[]) {
      const selector = `html[data-aeon-theme="${theme.id}"][data-aeon-mode="${mode}"]`
      rules[selector] = {
        colorScheme: mode,
        ...paletteVars(theme[mode]),
      }
    }
  }

  return rules
}
