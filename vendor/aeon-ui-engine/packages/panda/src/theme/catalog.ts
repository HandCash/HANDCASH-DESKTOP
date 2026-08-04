import type { AeonMode, AeonThemeDefinition } from './catalog-types.js'
import { themesFromConfig } from './palette.js'
import { aeonThemesConfig } from './themes.config.js'

export type { AeonMode, AeonPalette, AeonThemeDefinition } from './catalog-types.js'
export type { AeonPaletteInput, AeonThemeConfigEntry } from './palette.js'
export { definePalette, themesFromConfig } from './palette.js'
export { aeonThemesConfig } from './themes.config.js'
export { OMARCHY_THEME_IDS, OMARCHY_SCROLL_THEME_IDS, omarchyThemesConfig, type OmarchyThemeId } from './omarchy.themes.js'

export const AEON_THEMES: AeonThemeDefinition[] = themesFromConfig(aeonThemesConfig)

export type AeonThemeId = (typeof aeonThemesConfig)[number]['id']

export const AEON_THEME_MAP = Object.fromEntries(
  AEON_THEMES.map((t) => [t.id, t]),
) as Record<AeonThemeId, AeonThemeDefinition>

export const AEON_THEME_IDS = aeonThemesConfig.map((t) => t.id) as AeonThemeId[]

export const DEFAULT_THEME_ID: AeonThemeId = 'default'
export const DEFAULT_MODE: AeonMode = 'dark'

const STORAGE_THEME = 'aeon-theme'
const STORAGE_MODE = 'aeon-mode'
const STORAGE_SCROLL = 'aeon-theme-scroll'

export function getAeonPreferredMode(themeId: AeonThemeId, fallback: AeonMode = DEFAULT_MODE): AeonMode {
  return AEON_THEME_MAP[themeId].preferredMode ?? fallback
}

export function isAeonScrollThemeMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_SCROLL) === '1'
  } catch {
    return false
  }
}

export function setAeonScrollThemeMode(enabled: boolean) {
  try {
    if (enabled) localStorage.setItem(STORAGE_SCROLL, '1')
    else localStorage.removeItem(STORAGE_SCROLL)
  } catch {
    /* private mode */
  }
}

export function isAeonThemeId(value: string): value is AeonThemeId {
  return value in AEON_THEME_MAP
}

export function isAeonMode(value: string): value is AeonMode {
  return value === 'light' || value === 'dark'
}

export function applyAeonTheme(themeId: AeonThemeId, mode: AeonMode) {
  const root = document.documentElement
  root.dataset.aeonTheme = themeId
  root.dataset.aeonMode = mode
  root.style.colorScheme = mode

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', AEON_THEME_MAP[themeId][mode].bg)
  }

  try {
    localStorage.setItem(STORAGE_THEME, themeId)
    localStorage.setItem(STORAGE_MODE, mode)
  } catch {
    /* private mode */
  }
}

/** Read saved prefs or system preference, then apply to `<html>`. */
export function initAeonTheme(): { themeId: AeonThemeId; mode: AeonMode } {
  let themeId: AeonThemeId = DEFAULT_THEME_ID
  let mode: AeonMode = DEFAULT_MODE

  try {
    const storedTheme = localStorage.getItem(STORAGE_THEME)
    const storedMode = localStorage.getItem(STORAGE_MODE)
    if (storedTheme && isAeonThemeId(storedTheme)) themeId = storedTheme
    if (storedMode && isAeonMode(storedMode)) {
      mode = storedMode
    } else if (!storedMode && window.matchMedia('(prefers-color-scheme: light)').matches) {
      mode = 'light'
    }
  } catch {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) mode = 'light'
  }

  applyAeonTheme(themeId, mode)
  return { themeId, mode }
}
