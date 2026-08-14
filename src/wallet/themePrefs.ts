import { durableGetItem, durableSetItem } from './durableStorage'

/**
 * Appearance preference — survives wallet wipe (not under handcash.brc100.*).
 * Default: system (follow OS light/dark).
 */
export const APPEARANCE_PREF_KEY = 'handcash.appearance'

export type AppearancePreference = 'system' | 'light' | 'dark'
export type ResolvedColorMode = 'light' | 'dark'

type Listener = (pref: AppearancePreference, resolved: ResolvedColorMode) => void

const listeners = new Set<Listener>()

function isAppearancePreference(value: string | null): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function getAppearancePreference(): AppearancePreference {
  const raw = durableGetItem(APPEARANCE_PREF_KEY)
  return isAppearancePreference(raw) ? raw : 'system'
}

export function resolveColorMode(pref: AppearancePreference = getAppearancePreference()): ResolvedColorMode {
  if (pref === 'light' || pref === 'dark') return pref
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

export function setAppearancePreference(pref: AppearancePreference): void {
  durableSetItem(APPEARANCE_PREF_KEY, pref)
  const resolved = resolveColorMode(pref)
  for (const listener of listeners) listener(pref, resolved)
}

export function subscribeAppearance(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notify subscribers when OS scheme changes while preference is `system`. */
export function notifySystemAppearanceChanged(): void {
  if (getAppearancePreference() !== 'system') return
  const resolved = resolveColorMode('system')
  for (const listener of listeners) listener('system', resolved)
}
