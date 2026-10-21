/** The sign-in email this device registered, for display; the relay keeps only its keyed hash. */
import { storageRegistry } from '../../storage/registry'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { vaultLocalKey } from '../vaultLocalKeys'

const KEY = storageRegistry.signinEmail.key
const listeners = new Set<() => void>()

export function getSigninEmail(): string | null {
  return durableGetItem(vaultLocalKey(KEY))?.trim() || null
}

export function setSigninEmail(email: string | null): void {
  durableSetItem(vaultLocalKey(KEY), email ?? '')
  for (const listener of listeners) listener()
}

export function subscribeSigninEmail(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
