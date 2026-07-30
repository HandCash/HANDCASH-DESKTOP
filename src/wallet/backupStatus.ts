import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.brc100.backupConfirmed'

type Listener = (confirmed: boolean) => void
const listeners = new Set<Listener>()

function notify(confirmed: boolean) {
  for (const listener of listeners) listener(confirmed)
}

export function isBackupConfirmed(): boolean {
  return durableGetItem(KEY) === '1'
}

export function markBackupConfirmed(): void {
  durableSetItem(KEY, '1')
  notify(true)
}

export function clearBackupConfirmed(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
  // Durable wipe clears this with other handcash.brc100 keys; keep helper for tests.
  notify(false)
}

export function subscribeBackupConfirmed(listener: Listener): () => void {
  listeners.add(listener)
  listener(isBackupConfirmed())
  return () => {
    listeners.delete(listener)
  }
}
