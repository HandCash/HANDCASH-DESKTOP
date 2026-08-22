/**
 * Why an unlock failed, in the holder's terms.
 *
 * The store layer answers in Chromium's voice: an IndexedDB partition that cannot
 * be opened rejects with `UnknownError: Internal error.` Handing that string to the
 * unlock screen tells the holder nothing, names no cause, and offers no way out —
 * the wallet reads as bricked when the keys are untouched and OS-sealed.
 *
 * Two causes produce it, and neither is the password:
 * - another copy of HandCash holds the exclusive LevelDB lock on the partition
 * - the partition is damaged, so Chromium refuses it (and renames it `.broken`)
 *
 * Both are survivable: toolbox state is a replica of chain + BRC-39 history, so
 * recovery is a restore, not a loss. Only the local copy is gone.
 */

export type UnlockFailure =
  | { kind: 'walletMismatch'; message: string; offerRestore: true }
  | { kind: 'storeUnreadable'; message: string; offerRestore: true }
  | { kind: 'diskFull'; message: string; offerRestore: false }
  | { kind: 'other'; message: string; offerRestore: false }

const STORE_UNREADABLE =
  'HandCash could not open this device’s wallet data. Quit any other copy of HandCash and try again, or restore with your recovery phrase — your coins are on-chain, not in this file.'

const DISK_FULL =
  'This device is out of space, so HandCash could not open the wallet data. Free some space and try again.'

/** Mismatch copy already reaches us written for the holder — keep it as thrown. */
export function isWalletMismatchMessage(message: string | null | undefined): boolean {
  if (!message) return false
  return (
    message.includes('does not match the funded') ||
    message.includes('missing unlock keys') ||
    message.includes('Restore with your recovery') ||
    message.includes('Restore with a recovery')
  )
}

function errorName(err: unknown): string {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) return err.name
  if (err instanceof Error) return err.name
  return ''
}

/** The untranslated text, for logs and support — never for the unlock screen. */
export function rawUnlockError(err: unknown): string {
  const name = errorName(err)
  const message = err instanceof Error ? err.message : String(err)
  return name && !message.startsWith(name) ? `${name}: ${message}` : message
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Chromium reports an unopenable store through a small set of DOMException names.
 * Match the name first — the message is localised and can be as bare as
 * "Internal error." — and keep a message probe for wrappers that drop the name.
 */
function looksUnreadable(name: string, message: string): boolean {
  if (name === 'UnknownError' || name === 'InvalidStateError' || name === 'VersionError') {
    return true
  }
  return (
    /internal error/i.test(message) ||
    /backing store/i.test(message) ||
    /database is not open/i.test(message)
  )
}

export function classifyUnlockFailure(err: unknown): UnlockFailure {
  const message = rawMessage(err)
  const name = errorName(err)

  if (isWalletMismatchMessage(message)) {
    return { kind: 'walletMismatch', message, offerRestore: true }
  }
  if (name === 'QuotaExceededError' || /quota/i.test(message)) {
    return { kind: 'diskFull', message: DISK_FULL, offerRestore: false }
  }
  if (looksUnreadable(name, message)) {
    return { kind: 'storeUnreadable', message: STORE_UNREADABLE, offerRestore: true }
  }
  return { kind: 'other', message, offerRestore: false }
}
