import {
  getAppearancePreference, setAppearancePreference, subscribeAppearance,
  type AppearancePreference,
} from './themePrefs'
import { isWalletSfxEnabled, setWalletSfxEnabled, subscribeWalletSfx } from './soundPrefs'

export type SettingsPreferences = { appearance: AppearancePreference; sound: boolean }
/** Tagged domain choice; persistence is synchronous, not a save workflow. */
export type SettingsPreferencePath =
  | { kind: 'appearance'; value: AppearancePreference }
  | { kind: 'sound'; value: boolean }

export type SettingsPreferencesPort = {
  read: () => SettingsPreferences
  choose: (path: SettingsPreferencePath) => void
  subscribe: (changed: () => void) => () => void
}

export const settingsPreferencesPort: SettingsPreferencesPort = {
  read: () => ({ appearance: getAppearancePreference(), sound: isWalletSfxEnabled() }),
  choose: (path) => {
    if (path.kind === 'appearance') setAppearancePreference(path.value)
    else setWalletSfxEnabled(path.value)
  },
  subscribe: (changed) => {
    const appearance = subscribeAppearance(changed)
    const sound = subscribeWalletSfx(changed)
    return () => { appearance(); sound() }
  },
}
