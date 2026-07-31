import { durableGetItem, durableSetItem } from './durableStorage'

/** Survives wallet wipe (not under handcash.brc100.*). Default off — opt-in. */
export const SFX_PREF_KEY = 'handcash.sfx.enabled'

type Listener = (enabled: boolean) => void

const listeners = new Set<Listener>()

export function isWalletSfxEnabled(): boolean {
  return durableGetItem(SFX_PREF_KEY) === '1'
}

export function setWalletSfxEnabled(enabled: boolean): void {
  durableSetItem(SFX_PREF_KEY, enabled ? '1' : '0')
  for (const listener of listeners) listener(enabled)
}

export function subscribeWalletSfx(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
