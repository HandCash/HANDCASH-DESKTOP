/**
 * Send a vault sub-account (BRC-208 index ≥ 1) to someone else's identity key.
 *
 * The account root is sealed (BRC-78) to the recipient and delivered on box
 * `account-send`. This install then releases holding and never spends that
 * account again. The recipient opens the sealed package and may restore it as
 * a new vault from the root key (`restoreVaultFromRootKey`).
 *
 * Primary (index 0) is never sent: it is the vault identity. Anyone who still
 * holds the vault master can derive a sent account's key — only send a wallet
 * you created for that person.
 */
import { PrivateKey, PublicKey } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { recordWalletEvent } from './appActivity'
import { durableGetItem, durableSetItem } from './durableStorage'
import { normalizeIdentityKey, validateIdentityKey } from './friends'
import { sealPeerMessage } from './messageEnvelope'
import {
  ensureVaultAccounts,
  isHeldHere,
  readVaultAccounts,
  rootKeyHexForAccount,
  type VaultAccount,
} from './vaultAccounts'
import { vaultIdentityKey, type VaultMaster } from './vaultMaster'

export const ACCOUNT_SEND_BOX = 'account-send'
export const ACCOUNT_SEND_KIND = 'handcash-account-send' as const

const GIFTED_KEY = storageRegistry.accountSendGifted.key
const PENDING_KEY = storageRegistry.accountSendPending.key

export type AccountSendPackage = {
  v: 1
  kind: typeof ACCOUNT_SEND_KIND
  accountIdentityKey: string
  accountRootKeyHex: string
  name: string
  index: number
  fromIdentityKey: string
  at: number
}

export type AccountSendIo = {
  send: (args: {
    senderRootKeyHex: string
    recipientIdentityKey: string
    plaintext: string
  }) => Promise<void>
  release: (master: VaultMaster, index: number) => Promise<void>
  stopMonitor: (identityKey: string) => void
  now: () => number
}

type GiftedStore = { v: 1; byVault: Record<string, string[]> }
type PendingStore = { v: 1; packages: AccountSendPackage[] }

function readGifted(): GiftedStore {
  const raw = durableGetItem(GIFTED_KEY)
  if (!raw) return { v: 1, byVault: {} }
  try {
    const parsed = JSON.parse(raw) as GiftedStore
    if (parsed?.v !== 1 || typeof parsed.byVault !== 'object' || !parsed.byVault) {
      return { v: 1, byVault: {} }
    }
    return parsed
  } catch {
    return { v: 1, byVault: {} }
  }
}

function writeGifted(store: GiftedStore): void {
  durableSetItem(GIFTED_KEY, JSON.stringify(store))
}

function giftedSet(vaultIdentityKey: string): Set<string> {
  const list = readGifted().byVault[vaultIdentityKey.trim().toLowerCase()] ?? []
  return new Set(list.map((k) => k.toLowerCase()))
}

function markGifted(vaultIdentityKey: string, accountIdentityKey: string): void {
  const vault = vaultIdentityKey.trim().toLowerCase()
  const account = accountIdentityKey.trim().toLowerCase()
  const store = readGifted()
  const list = new Set(store.byVault[vault] ?? [])
  list.add(account)
  store.byVault[vault] = [...list]
  writeGifted(store)
}

/** True when this install already sealed that account away. */
export function isAccountSendGifted(vaultIdentityKey: string, accountIdentityKey: string): boolean {
  return giftedSet(vaultIdentityKey).has(accountIdentityKey.trim().toLowerCase())
}

/**
 * Held sub-accounts (index ≥ 1) that this install may still send. Empty when
 * the vault has only Primary, none are held here, or every sub-account was already sent.
 * The open account is omitted — it must be released after a switch.
 */
export function listSendableSubAccounts(
  master: VaultMaster,
  activeAccountIndex?: number | null,
): VaultAccount[] {
  const vaultIk = vaultIdentityKey(master)
  const gifted = giftedSet(vaultIk)
  const open = activeAccountIndex ?? null
  return ensureVaultAccounts(master).accounts.filter(
    (a) =>
      a.index >= 1 &&
      a.index !== open &&
      isHeldHere(a) &&
      !gifted.has(a.identityKey.trim().toLowerCase()),
  )
}

export function parseAccountSendPackage(
  plaintext: string,
  forIdentityKey: string,
): AccountSendPackage | null {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Partial<AccountSendPackage>
  if (p.v !== 1 || p.kind !== ACCOUNT_SEND_KIND) return null
  if (typeof p.accountIdentityKey !== 'string' || typeof p.accountRootKeyHex !== 'string') return null
  if (typeof p.name !== 'string' || typeof p.fromIdentityKey !== 'string') return null
  if (!Number.isSafeInteger(p.index) || (p.index as number) < 1) return null
  if (!Number.isSafeInteger(p.at) || (p.at as number) < 0) return null
  if (validateIdentityKey(p.accountIdentityKey) || validateIdentityKey(p.fromIdentityKey)) return null
  let derived: string
  try {
    derived = PrivateKey.fromHex(p.accountRootKeyHex.trim()).toPublicKey().toString().toLowerCase()
  } catch {
    return null
  }
  if (derived !== normalizeIdentityKey(p.accountIdentityKey)) return null
  // Package is sealed to `forIdentityKey`; the open step already bound that.
  void forIdentityKey
  return {
    v: 1,
    kind: ACCOUNT_SEND_KIND,
    accountIdentityKey: normalizeIdentityKey(p.accountIdentityKey),
    accountRootKeyHex: p.accountRootKeyHex.trim().toLowerCase(),
    name: p.name.trim().slice(0, 80) || `Wallet ${p.index}`,
    index: p.index as number,
    fromIdentityKey: normalizeIdentityKey(p.fromIdentityKey),
    at: p.at as number,
  }
}

function readPending(): PendingStore {
  const raw = durableGetItem(PENDING_KEY)
  if (!raw) return { v: 1, packages: [] }
  try {
    const parsed = JSON.parse(raw) as PendingStore
    if (parsed?.v !== 1 || !Array.isArray(parsed.packages)) return { v: 1, packages: [] }
    return parsed
  } catch {
    return { v: 1, packages: [] }
  }
}

function writePending(store: PendingStore): void {
  durableSetItem(PENDING_KEY, JSON.stringify(store))
}

export function listPendingAccountSends(): AccountSendPackage[] {
  return readPending().packages.slice()
}

export function storePendingAccountSend(pkg: AccountSendPackage): void {
  const store = readPending()
  if (store.packages.some((p) => p.accountIdentityKey === pkg.accountIdentityKey)) return
  store.packages.push(pkg)
  writePending(store)
}

export function dropPendingAccountSend(accountIdentityKey: string): void {
  const needle = normalizeIdentityKey(accountIdentityKey)
  const store = readPending()
  store.packages = store.packages.filter((p) => p.accountIdentityKey !== needle)
  writePending(store)
}

async function defaultIo(): Promise<AccountSendIo> {
  const [{ sendSealedToPeerBox }, { releaseIdleVaultAccount }, { dropWarmAccount }] = await Promise.all([
    import('./messageTransport'),
    import('./vaultAccountHolding'),
    import('./walletPool'),
  ])
  return {
    send: async ({ senderRootKeyHex, recipientIdentityKey, plaintext }) => {
      await sendSealedToPeerBox(senderRootKeyHex, recipientIdentityKey, ACCOUNT_SEND_BOX, plaintext)
    },
    release: (master, index) => releaseIdleVaultAccount(master, index),
    stopMonitor: (identityKey) => {
      try {
        dropWarmAccount(identityKey)
      } catch {
        /* warm pool may not hold it */
      }
    },
    now: () => Date.now(),
  }
}

export class AccountSendRefused extends Error {
  constructor(
    readonly code:
      | 'no-accounts'
      | 'not-sendable'
      | 'primary'
      | 'bad-recipient'
      | 'self'
      | 'unconfirmed'
      | 'already-gifted',
    message: string,
  ) {
    super(message)
    this.name = 'AccountSendRefused'
  }
}

/**
 * Seal a held sub-account to `recipientIdentityKey` and release it here.
 * `confirmedRecipientIdentityKey` must equal the recipient — the UI only
 * passes it after the user confirms the key they see.
 */
export async function sendSubAccountToIdentityKey(args: {
  master: VaultMaster
  accountIndex: number
  recipientIdentityKey: string
  confirmedRecipientIdentityKey: string
  recipientLabel?: string | null
  fromIdentityKey: string
  io?: AccountSendIo
}): Promise<{ accountIdentityKey: string; name: string }> {
  const recipient = normalizeIdentityKey(args.recipientIdentityKey)
  const confirmed = normalizeIdentityKey(args.confirmedRecipientIdentityKey)
  if (validateIdentityKey(recipient)) {
    throw new AccountSendRefused('bad-recipient', 'Recipient identity key is invalid')
  }
  if (confirmed !== recipient) {
    throw new AccountSendRefused(
      'unconfirmed',
      'Confirm the recipient identity key before sending this wallet.',
    )
  }
  if (args.accountIndex < 1) {
    throw new AccountSendRefused('primary', 'The primary wallet cannot be sent to someone else.')
  }

  const { getWalletRuntime } = await import('./walletRuntime')
  const open = getWalletRuntime()?.instance
  if (open && open.vaultMaster === args.master && open.accountIndex === args.accountIndex) {
    throw new AccountSendRefused(
      'not-sendable',
      'Switch to another wallet before sending this one.',
    )
  }

  const vaultIk = vaultIdentityKey(args.master)
  const store = readVaultAccounts(vaultIk)
  const account = store.accounts.find((a) => a.index === args.accountIndex)
  if (!account) {
    throw new AccountSendRefused('not-sendable', 'That wallet is not in this vault.')
  }
  if (isAccountSendGifted(vaultIk, account.identityKey)) {
    throw new AccountSendRefused('already-gifted', 'That wallet was already sent from this device.')
  }
  if (!isHeldHere(account)) {
    throw new AccountSendRefused('not-sendable', 'This device does not hold that wallet.')
  }

  const accountIk = normalizeIdentityKey(account.identityKey)
  const fromIk = normalizeIdentityKey(args.fromIdentityKey)
  if (recipient === accountIk || recipient === fromIk || recipient === normalizeIdentityKey(vaultIk)) {
    throw new AccountSendRefused('self', 'Cannot send a wallet to this same identity.')
  }

  // Re-derive; never trust a stored private key string from the account list.
  const accountRootKeyHex = rootKeyHexForAccount(args.master, args.accountIndex)
  const derivedIk = PrivateKey.fromHex(accountRootKeyHex).toPublicKey().toString().toLowerCase()
  if (derivedIk !== accountIk) {
    throw new AccountSendRefused('not-sendable', 'Account key does not match this vault.')
  }

  const io = args.io ?? (await defaultIo())
  const name = account.name.trim() || `Wallet ${account.index}`
  const pkg: AccountSendPackage = {
    v: 1,
    kind: ACCOUNT_SEND_KIND,
    accountIdentityKey: accountIk,
    accountRootKeyHex,
    name,
    index: account.index,
    fromIdentityKey: fromIk,
    at: io.now(),
  }

  io.stopMonitor(accountIk)
  await io.send({
    senderRootKeyHex: accountRootKeyHex,
    recipientIdentityKey: recipient,
    plaintext: JSON.stringify(pkg),
  })
  await io.release(args.master, args.accountIndex)
  markGifted(vaultIk, accountIk)

  const label = args.recipientLabel?.trim()
  recordWalletEvent({
    method: 'account-send',
    note: label
      ? `Sent ${name} to ${label}`
      : `Sent ${name} to ${recipient.slice(0, 12)}…`,
  })

  return { accountIdentityKey: accountIk, name }
}

/** Open sealed `account-send` box messages for this identity; store new packages. */
export async function receiveAccountSends(args: {
  identityKey: string
  rootKeyHex: string
  list?: (rootKeyHex: string, box: string) => Promise<Array<{ messageId: string; plaintext: string | null }> | null>
  acknowledge?: (rootKeyHex: string, box: string, ids: string[]) => Promise<void>
}): Promise<AccountSendPackage[]> {
  const identityKey = normalizeIdentityKey(args.identityKey)
  const list =
    args.list ??
    (async (root, box) => {
      const { listSealedOwnBox } = await import('./messageTransport')
      return listSealedOwnBox(root, box)
    })
  const acknowledge =
    args.acknowledge ??
    (async (root, box, ids) => {
      const { acknowledgeOwnBox } = await import('./messageTransport')
      await acknowledgeOwnBox(root, box, ids)
    })

  const listed = await list(args.rootKeyHex, ACCOUNT_SEND_BOX)
  if (!listed) return listPendingAccountSends()

  const accepted: string[] = []
  const found: AccountSendPackage[] = []
  for (const m of listed) {
    if (!m.messageId || !m.plaintext) continue
    const pkg = parseAccountSendPackage(m.plaintext, identityKey)
    if (!pkg) continue
    storePendingAccountSend(pkg)
    found.push(pkg)
    accepted.push(m.messageId)
    recordWalletEvent({
      method: 'account-receive',
      note: `Received wallet ${pkg.name}`,
    })
  }
  if (accepted.length) await acknowledge(args.rootKeyHex, ACCOUNT_SEND_BOX, accepted)
  return found.length ? found : listPendingAccountSends()
}

/** Install a pending package as this device's vault. Refuses when a vault already exists. */
export async function acceptPendingAccountSend(args: {
  accountIdentityKey: string
  chain: 'main' | 'test'
  password?: string
  useDevice?: boolean
}): Promise<{ identityKey: string; name: string }> {
  const needle = normalizeIdentityKey(args.accountIdentityKey)
  const pkg = listPendingAccountSends().find((p) => p.accountIdentityKey === needle)
  if (!pkg) throw new Error('No pending wallet with that key')

  const { hasVault, restoreVaultFromRootKey } = await import('./vault')
  if (hasVault()) {
    throw new Error('This device already has a wallet. Open the received wallet on an empty device.')
  }

  const unlocked = await restoreVaultFromRootKey({
    rootKeyHex: pkg.accountRootKeyHex,
    chain: args.chain,
    handle: pkg.name,
    password: args.password,
    useDevice: args.useDevice,
  })
  dropPendingAccountSend(pkg.accountIdentityKey)
  return { identityKey: unlocked.record.identityKey, name: pkg.name }
}

/** Build the sealed wire body (tests and QR export). */
export function sealAccountSendForRecipient(args: {
  pkg: AccountSendPackage
  senderRootKeyHex: string
  recipientIdentityKey: string
}): string {
  PublicKey.fromString(normalizeIdentityKey(args.recipientIdentityKey))
  return sealPeerMessage({
    plaintext: JSON.stringify(args.pkg),
    rootKeyHex: args.senderRootKeyHex,
    recipientIdentityKey: normalizeIdentityKey(args.recipientIdentityKey),
  })
}

export function resetAccountSendForTests(): void {
  durableSetItem(GIFTED_KEY, JSON.stringify({ v: 1, byVault: {} } satisfies GiftedStore))
  durableSetItem(PENDING_KEY, JSON.stringify({ v: 1, packages: [] } satisfies PendingStore))
}
