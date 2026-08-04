import { partAttrs, scopeAttrs, themeSwitcherAnatomy } from '@aeon-ui/core'
import {
  applyAeonTheme,
  initAeonTheme,
  type AeonColorMode,
} from '@aeon-ui/core'
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  useContext,
  useLayoutEffect,
  useState,
} from 'react'
import { mergeProps } from '../utils/merge-props.js'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ThemeSwitcherRootProps extends HTMLAttributes<HTMLDivElement> {
  /** Initial theme — overridden by localStorage / system preference. */
  defaultTheme?: string
  /** Initial mode — overridden by localStorage / system preference. */
  defaultMode?: AeonColorMode
  /** Called when theme or mode changes. */
  onThemeChange?: (themeId: string, mode: AeonColorMode) => void
}

export interface ThemeSwitcherModesProps extends HTMLAttributes<HTMLDivElement> {}

export interface ThemeSwitcherModeBtnProps extends HTMLAttributes<HTMLButtonElement> {
  mode: AeonColorMode
  active: boolean
}

export interface ThemeSwitcherThemeSelectProps extends HTMLAttributes<HTMLDivElement> {}

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

const Root = forwardRef<HTMLDivElement, ThemeSwitcherRootProps>(
  function ThemeSwitcherRoot(
    { defaultTheme, defaultMode, onThemeChange, children, ...rest },
    ref,
  ) {
    const [themeId, setThemeId] = useState(defaultTheme ?? 'default')
    const [mode, setMode] = useState<AeonColorMode>(defaultMode ?? 'dark')

    useLayoutEffect(() => {
      const { themeId: t, mode: m } = initAeonTheme()
      setThemeId(t)
      setMode(m)
    }, [])

    const handleThemeChange = (next: string) => {
      setThemeId(next)
      applyAeonTheme(next, mode)
      onThemeChange?.(next, mode)
    }

    const handleModeChange = (next: AeonColorMode) => {
      setMode(next)
      applyAeonTheme(themeId, next)
      onThemeChange?.(themeId, next)
    }

    return (
      <div
        ref={ref}
        {...mergeProps(
          scopeAttrs(themeSwitcherAnatomy.scope, themeSwitcherAnatomy.root),
          rest,
        )}
      >
        <ThemeSwitcherContext.Provider
          value={{ themeId, mode, handleThemeChange, handleModeChange }}
        >
          {children}
        </ThemeSwitcherContext.Provider>
      </div>
    )
  },
)

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface ThemeSwitcherContextValue {
  themeId: string
  mode: AeonColorMode
  handleThemeChange: (id: string) => void
  handleModeChange: (mode: AeonColorMode) => void
}

const ThemeSwitcherContext = createContext<ThemeSwitcherContextValue | null>(null)

function useThemeSwitcher() {
  const ctx = useContext(ThemeSwitcherContext)
  if (!ctx) throw new Error('ThemeSwitcher parts must be used inside <ThemeSwitcher.Root>')
  return ctx
}

/* ------------------------------------------------------------------ */
/*  Modes (light/dark button group)                                    */
/* ------------------------------------------------------------------ */

const Modes = forwardRef<HTMLDivElement, ThemeSwitcherModesProps>(
  function ThemeSwitcherModes(props, ref) {
    return (
      <div
        ref={ref}
        role="group"
        aria-label="Color mode"
        {...mergeProps(
          partAttrs(themeSwitcherAnatomy.scope, themeSwitcherAnatomy.modes),
          props,
        )}
      />
    )
  },
)

/* ------------------------------------------------------------------ */
/*  Mode button                                                        */
/* ------------------------------------------------------------------ */

const ModeBtn = forwardRef<HTMLButtonElement, ThemeSwitcherModeBtnProps>(
  function ThemeSwitcherModeBtn({ mode, active, ...rest }, ref) {
    const { handleModeChange } = useThemeSwitcher()
    return (
      <button
        ref={ref}
        type="button"
        aria-pressed={active}
        data-active={active ? 'true' : undefined}
        {...mergeProps(
          partAttrs(themeSwitcherAnatomy.scope, themeSwitcherAnatomy.modeBtn),
          rest,
        )}
        onClick={(e) => {
          handleModeChange(mode)
          rest.onClick?.(e)
        }}
      >
        {rest.children ?? (mode === 'light' ? 'Light' : 'Dark')}
      </button>
    )
  },
)

/* ------------------------------------------------------------------ */
/*  Theme select wrapper                                               */
/* ------------------------------------------------------------------ */

const ThemeSelect = forwardRef<HTMLDivElement, ThemeSwitcherThemeSelectProps>(
  function ThemeSwitcherThemeSelect({ children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(
          partAttrs(themeSwitcherAnatomy.scope, themeSwitcherAnatomy.themeSelect),
          rest,
        )}
      >
        {children}
      </div>
    )
  },
)

/* ------------------------------------------------------------------ */
/*  Theme trigger (displays current theme label)                        */
/* ------------------------------------------------------------------ */

const ThemeTrigger = forwardRef<HTMLButtonElement, HTMLAttributes<HTMLButtonElement>>(
  function ThemeSwitcherThemeTrigger(props, ref) {
    const { themeId } = useThemeSwitcher()
    return (
      <button
        ref={ref}
        type="button"
        aria-label={`Theme preset: ${themeId}`}
        {...mergeProps(
          partAttrs(themeSwitcherAnatomy.scope, themeSwitcherAnatomy.themeTrigger),
          props,
        )}
      >
        {props.children ?? themeId}
      </button>
    )
  },
)

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * ThemeSwitcher — headless compound component for theme + mode control.
 *
 * Uses `initAeonTheme()` on mount to read localStorage / system preference.
 * All state changes call `applyAeonTheme()` to update `<html>` dataset attrs.
 *
 * @example
 * <ThemeSwitcher.Root>
 *   <ThemeSwitcher.Modes>
 *     <ThemeSwitcher.ModeBtn mode="light" active={mode === 'light'} />
 *     <ThemeSwitcher.ModeBtn mode="dark" active={mode === 'dark'} />
 *   </ThemeSwitcher.Modes>
 *   <ThemeSwitcher.ThemeSelect>
 *     <ThemeSwitcher.ThemeTrigger />
 *   </ThemeSwitcher.ThemeSelect>
 * </ThemeSwitcher.Root>
 */
export const ThemeSwitcher = {
  Root,
  Modes,
  ModeBtn,
  ThemeSelect,
  ThemeTrigger,
}

/** Re-export theme types for convenience. */
export type { AeonColorMode as AeonMode }
