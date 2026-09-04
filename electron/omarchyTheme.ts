/**
 * Read the active Omarchy desktop theme (colors.toml) for HandCash Electron.
 *
 * Omarchy stores the live theme at ~/.local/state/omarchy/current/theme →
 * colors.toml. We only activate when that tree exists — plain Linux stays on
 * HandCash brand palettes.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type OmarchyColors = {
  mode: 'light' | 'dark'
  name: string
  background: string
  darkBackground: string
  darkerBackground: string
  lighterBackground: string
  foreground: string
  darkForeground: string
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

const STATE_DIR = () => join(homedir(), '.local/state/omarchy/current')
const THEME_DIR = () => join(STATE_DIR(), 'theme')
const THEME_NAME_FILE = () => join(STATE_DIR(), 'theme.name')
const COLORS_FILE = () => join(THEME_DIR(), 'colors.toml')

function parseTomlColors(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

function requireHex(map: Record<string, string>, key: string, fallback: string): string {
  const v = map[key]?.trim()
  return v && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : fallback
}

export function isOmarchyPresent(): boolean {
  return existsSync(COLORS_FILE()) || existsSync('/usr/share/omarchy')
}

export function readOmarchyTheme(): OmarchyThemeSnapshot {
  try {
    if (!existsSync(COLORS_FILE())) {
      return { ok: true, detected: false }
    }
    const raw = readFileSync(COLORS_FILE(), 'utf8')
    const map = parseTomlColors(raw)
    let name = 'Omarchy'
    try {
      if (existsSync(THEME_NAME_FILE())) {
        name = readFileSync(THEME_NAME_FILE(), 'utf8').trim() || name
      }
    } catch {
      /* ignore */
    }
    const mode = map.mode === 'light' ? 'light' : 'dark'
    const background = requireHex(map, 'background', mode === 'light' ? '#f3f5f3' : '#1a1b26')
    const colors: OmarchyColors = {
      mode,
      name,
      background,
      darkBackground: requireHex(map, 'dark_background', background),
      darkerBackground: requireHex(map, 'darker_background', background),
      lighterBackground: requireHex(map, 'lighter_background', background),
      foreground: requireHex(map, 'foreground', mode === 'light' ? '#1a1f1a' : '#a9b1d6'),
      darkForeground: requireHex(map, 'dark_foreground', '#6e7687'),
      lightForeground: requireHex(
        map,
        'light_foreground',
        mode === 'light' ? '#403e3c' : '#a9b1d6',
      ),
      brightForeground: requireHex(map, 'bright_foreground', mode === 'light' ? '#1a1f1a' : '#c0caf5'),
      accent: requireHex(map, 'accent', mode === 'light' ? '#0c8f3e' : '#57ff97'),
      muted: requireHex(map, 'muted', '#414868'),
      selection: requireHex(map, 'selection', '#292e42'),
      red: requireHex(map, 'red', '#f87171'),
      green: requireHex(map, 'green', mode === 'light' ? '#40a02b' : '#9ece6a'),
    }
    return { ok: true, detected: true, colors }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

type Listener = (snap: OmarchyThemeSnapshot) => void

let watchers: FSWatcher[] = []
const listeners = new Set<Listener>()

function emit() {
  const snap = readOmarchyTheme()
  for (const listener of listeners) listener(snap)
}

/** Watch Omarchy theme files; no-op when Omarchy is not installed. */
export function startOmarchyThemeWatch(onChange: Listener): () => void {
  listeners.add(onChange)
  onChange(readOmarchyTheme())

  if (watchers.length === 0 && existsSync(STATE_DIR())) {
    const watchPath = (target: string) => {
      try {
        if (!existsSync(target)) return
        const w = watch(target, { persistent: false }, () => {
          // Debounce symlink/theme swaps that fire multiple events.
          setTimeout(emit, 50)
        })
        w.on('error', () => {})
        watchers.push(w)
      } catch {
        /* missing path */
      }
    }
    watchPath(STATE_DIR())
    watchPath(THEME_NAME_FILE())
    watchPath(COLORS_FILE())
    watchPath(THEME_DIR())
  }

  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) {
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          /* ignore */
        }
      }
      watchers = []
    }
  }
}
