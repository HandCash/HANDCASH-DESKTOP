/**
 * Find vault sub-accounts from the vault master alone (BRC-208 recovery).
 *
 * The account list is device storage, so a restored vault starts with only
 * the primary. Indices are allocated in order and never reused, so probing
 * index after index until a run of unused ones finds every account that
 * left a trace: a history backup, a holder record, or mail waiting for its
 * identity key. A found account is held elsewhere unless this install is
 * taking the vault over (`accountHolding.ts`).
 */
import { appendAppLog } from './appLog'
import {
  discoveredAccountHolding,
  ensureVaultAccounts,
  identityKeyForAccount,
  nextAccountIndex,
  readVaultAccounts,
  rootKeyHexForAccount,
  writeVaultAccounts,
} from './vaultAccounts'
import type { VaultMaster } from './vaultMaster'

export type AccountUse = 'used' | 'unused' | 'unknown'

export type AccountProbe = (account: {
  index: number
  identityKey: string
  rootKeyHex: string
}) => Promise<AccountUse>

export type DiscoveryResult =
  | { kind: 'skipped' }
  | { kind: 'complete'; found: number[] }
  /** A probe could not say; found accounts are kept and discovery runs again next unlock. */
  | { kind: 'interrupted'; found: number[]; atIndex: number }

/** Unused indices in a row that end discovery (BRC-208 §Recovery). */
export const DISCOVERY_GAP = 5
const MAX_INDEX = 1000

export async function discoverVaultAccounts(args: {
  master: VaultMaster
  probe: AccountProbe
  gap?: number
}): Promise<DiscoveryResult> {
  const { master, probe } = args
  const gap = args.gap ?? DISCOVERY_GAP
  const initial = ensureVaultAccounts(master)
  const masterIdentityKey = initial.masterIdentityKey
  if (initial.discovered) return { kind: 'skipped' }

  const started = Date.now()
  const start = nextAccountIndex(initial)
  let lastUsed = start - 1
  let misses = 0
  let index = start
  let interruptedAt: number | null = null
  while (misses < gap && index <= MAX_INDEX) {
    const rootKeyHex = rootKeyHexForAccount(master, index)
    const use = await probe({ index, identityKey: identityKeyForAccount(master, index), rootKeyHex })
    if (use === 'unknown') {
      interruptedAt = index
      break
    }
    if (use === 'used') {
      lastUsed = index
      misses = 0
    } else {
      misses += 1
    }
    index += 1
  }

  // Re-read: the user may have created an account while probes were out.
  const store = readVaultAccounts(masterIdentityKey)
  const found: number[] = []
  for (let n = start; n <= lastUsed; n++) {
    if (store.accounts.some((a) => a.index === n)) continue
    store.accounts.push({
      index: n,
      name: `Wallet ${n}`,
      identityKey: identityKeyForAccount(master, n),
      holding: discoveredAccountHolding(store),
    })
    found.push(n)
  }
  store.accounts.sort((a, b) => a.index - b.index)
  if (interruptedAt === null) store.discovered = true
  writeVaultAccounts(store)

  const ms = Date.now() - started
  if (found.length > 0 || ms > 250 || interruptedAt !== null) {
    appendAppLog(
      interruptedAt === null ? 'info' : 'warn',
      `[vault-accounts] discovery ${interruptedAt === null ? 'done' : `interrupted at a${interruptedAt}`} ${ms}ms: found ${found.length ? found.map((n) => `a${n}`).join(',') : 'none'}`,
    )
  }
  return interruptedAt === null
    ? { kind: 'complete', found }
    : { kind: 'interrupted', found, atIndex: interruptedAt }
}

/**
 * Used when the history backup host holds a backup or a holder record for the
 * account, or its messagebox holds mail. Unknown when a source cannot answer.
 */
export const probeAccountUse: AccountProbe = async ({ identityKey, rootKeyHex }) => {
  const { historyBackupObjectUrl } = await import('./historyBackupPrefs')
  let backupUrl: string | null = null
  try {
    backupUrl = historyBackupObjectUrl(identityKey)
  } catch {
    // No backup host configured: the messagebox alone answers.
  }
  let backup: AccountUse | null = null
  if (backupUrl) {
    const { probeRemoteBrc39 } = await import('./historyRemoteProbe')
    const head = await probeRemoteBrc39(rootKeyHex, backupUrl)
    backup = head.kind === 'present' ? 'used' : head.kind === 'absent' ? 'unused' : 'unknown'
  }
  if (backup === 'used') return 'used'
  const { readHolderRecord } = await import('./accountHolderRecord')
  const holder = await readHolderRecord({ identityKey, rootKeyHex })
  if (holder.kind === 'record') return 'used'
  const { messageboxHasMail } = await import('./messageTransport')
  const mail = await messageboxHasMail(rootKeyHex)
  if (mail === true) return 'used'
  if (mail === null || backup === 'unknown' || holder.kind === 'unreachable') return 'unknown'
  return 'unused'
}
