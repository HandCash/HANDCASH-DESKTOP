export type AeonColorMode = 'light' | 'dark'

/** Class applied to `<html>` to enable theme-transition.css */
export const AEON_THEME_TRANSITION_CLASS = 'aeon-theme-transition'

export function isAeonColorMode(value: string): value is AeonColorMode {
  return value === 'light' || value === 'dark'
}

/** Map next-themes / user prefs to Aeon `data-aeon-mode`. */
export function resolveAeonColorMode(
  theme: string | undefined,
  systemPrefersDark = false,
): AeonColorMode {
  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  return systemPrefersDark ? 'dark' : 'light'
}

/**
 * Keep `data-aeon-theme` / `data-aeon-mode` in sync with Tailwind `.dark` apps.
 * Enables smooth transitions when paired with `@aeon-ui/core/theme-transition.css`.
 */
export function syncAeonColorMode(
  root: HTMLElement,
  mode: AeonColorMode,
  options?: { themeId?: string; enableTransitionClass?: boolean },
) {
  const themeId = options?.themeId ?? root.dataset.aeonTheme ?? 'default'
  root.dataset.aeonTheme = themeId
  root.dataset.aeonMode = mode
  root.style.colorScheme = mode

  if (options?.enableTransitionClass !== false) {
    root.classList.add(AEON_THEME_TRANSITION_CLASS)
  }
}

/** Cross-fade theme changes when View Transitions API is available. */
export function runAeonThemeTransition(apply: () => void): void {
  if (typeof document === 'undefined') {
    apply()
    return
  }

  const start = document.startViewTransition
  if (typeof start === 'function') {
    start.call(document, apply)
    return
  }

  apply()
}

/* ------------------------------------------------------------------ */
/*  Theme catalog — pure DOM runtime, no Panda dependency               */
/* ------------------------------------------------------------------ */

export type AeonPalette = {
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
  light: AeonPalette
  dark: AeonPalette
}

const STORAGE_THEME = 'aeon-theme'
const STORAGE_MODE = 'aeon-mode'

const DEFAULT_THEME_ID = 'default'
const DEFAULT_MODE: AeonColorMode = 'dark'

/**
 * Register theme definitions. Call once at app init.
 * Returns the registered themes array and lookup map.
 */
export function registerAeonThemes(themes: AeonThemeDefinition[]) {
  const map = Object.fromEntries(themes.map((t) => [t.id, t])) as Record<string, AeonThemeDefinition>
  const ids = themes.map((t) => t.id)
  return { themes, map, ids }
}

export function isAeonThemeId(value: string): boolean {
  return value !== undefined
}

export function isAeonMode(value: string): value is AeonColorMode {
  return value === 'light' || value === 'dark'
}

/**
 * Apply a theme + mode to `<html>`. Persists to localStorage.
 */
export function applyAeonTheme(
  themeId: string,
  mode: AeonColorMode,
  themeMap?: Record<string, AeonThemeDefinition>,
) {
  const root = document.documentElement
  root.dataset.aeonTheme = themeId
  root.dataset.aeonMode = mode
  root.style.colorScheme = mode

  if (themeMap && themeMap[themeId]) {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      meta.setAttribute('content', themeMap[themeId][mode].bg)
    }
  }

  try {
    localStorage.setItem(STORAGE_THEME, themeId)
    localStorage.setItem(STORAGE_MODE, mode)
  } catch {
    /* private mode */
  }
}

/**
 * Read saved prefs or system preference, apply to `<html>`, return current values.
 */
export function initAeonTheme(
  themeMap?: Record<string, AeonThemeDefinition>,
): { themeId: string; mode: AeonColorMode } {
  let themeId = DEFAULT_THEME_ID
  let mode: AeonColorMode = DEFAULT_MODE

  try {
    const storedTheme = localStorage.getItem(STORAGE_THEME)
    const storedMode = localStorage.getItem(STORAGE_MODE)
    if (storedTheme) themeId = storedTheme
    if (storedMode && isAeonMode(storedMode)) {
      mode = storedMode
    } else if (!storedMode && window.matchMedia('(prefers-color-scheme: light)').matches) {
      mode = 'light'
    }
  } catch {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) mode = 'light'
  }

  applyAeonTheme(themeId, mode, themeMap)
  return { themeId, mode }
}
