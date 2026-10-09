/**
 * Vault sub-accounts (BRC-208) — named account roots under one vault master.
 *
 * Account 0 is the primary. How account n derives from the master is the
 * master's derivation (`vaultMaster.ts`): BRC-157 profile `m/0'/n'` for vaults
 * created now, the BRC-42 `self` child `[2, "account"]`/`account-n` of a root
 * that is itself account 0 for older vaults (no migration).
 * Each account is a full BRC-100 wallet root (own UTXOs, BAP, balances).
 * One backup / unlock recovers every account.
 *
 * Each account is held by one install (`accountHolding.ts`). Devices sharing a
 * vault hold different accounts; this install opens only the ones it holds.
 */
import { storageRegistry } from '../storage/registry'
import {
  UNKNOWN_ELSEWHERE,
  UNPUBLISHED_HERE,
  type AccountHolding,
} from './accountHolding'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  VAULT_ACCOUNT_PROTOCOL,
  accountIdentityKey,
  accountRootKeyHex,
  vaultIdentityKey,
  type VaultMaster,
} from './vaultMaster'

export { VAULT_ACCOUNT_PROTOCOL, accountKeyId } from './vaultMaster'

export type ReservedKeyRefusal = 'account-protocol' | 'self-linkage'

/**
 * Why an application request must not reach the wallet, or null.
 *
 * `account-protocol`: a key or signature under the account protocol is another
 * account's root. Reserved at every security level, as BRC-44 reserves
 * `admin`; names are matched as BRC-43 normalises them (lowercase, trimmed).
 *
 * `self-linkage`: linkage with the wallet itself is the BRC-42 offset of its
 * `self` children (counterparty linkage yields all of them, specific linkage
 * one). Those children are additive, so an offset plus the child key is the
 * root, and the wallet hands such children out: account roots, developer keys,
 * BAP signing keys. Rotating a child away does not change its offset.
 */
export function reservedKeyRefusal(
  method: string,
  args: unknown,
  identityKey: string | undefined,
): ReservedKeyRefusal | null {
  if (!args || typeof args !== 'object') return null
  const { protocolID, counterparty } = args as { protocolID?: unknown; counterparty?: unknown }
  if (
    Array.isArray(protocolID) &&
    typeof protocolID[1] === 'string' &&
    protocolID[1].toLowerCase().trim() === VAULT_ACCOUNT_PROTOCOL[1]
  ) {
    return 'account-protocol'
  }
  if (
    (method === 'revealCounterpartyKeyLinkage' || method === 'revealSpecificKeyLinkage') &&
    typeof counterparty === 'string'
  ) {
    const peer = counterparty.trim().toLowerCase()
    if (peer === 'self' || (!!identityKey && peer === identityKey.trim().toLowerCase())) {
      return 'self-linkage'
    }
  }
  return null
}

export type VaultAccount = {
  /** Stable index. 0 is the primary account. */
  index: number
  name: string
  identityKey: string
  /** Absent on stores written before holding existed: held here, unpublished. */
  holding?: AccountHolding
}

export type VaultAccountStore = {
  version: 1
  /** The vault's identity: account 0's identity key. */
  masterIdentityKey: string
  activeIndex: number
  accounts: VaultAccount[]
  /** Discovery from the vault master has run to completion on this device. */
  discovered?: boolean
  /**
   * This install replaced the vault's previous one (a restore that did not
   * keep the other device): it claims every account it finds until a holder
   * check has reached them all.
   */
  takeover?: boolean
}

export const ACCOUNT_HELD_ELSEWHERE =
  'This wallet is held by another device. Move it here from the wallet menu first.'

export function holdingOf(account: VaultAccount): AccountHolding {
  return account.holding ?? UNPUBLISHED_HERE
}

export function isHeldHere(account: VaultAccount): boolean {
  return holdingOf(account).kind === 'here'
}

const STORAGE_PREFIX = 'handcash.vault-accounts.v1:'

function storageKey(masterIdentityKey: string): string {
  return `${STORAGE_PREFIX}${masterIdentityKey}`
}

/** Derive the private key hex for account `index` under the vault master. */
export function rootKeyHexForAccount(master: VaultMaster, index: number): string {
  return accountRootKeyHex(master, index)
}

export function identityKeyForAccount(master: VaultMaster, index: number): string {
  return accountIdentityKey(master, index)
}

export function originalToolboxDatabaseName(args: {
  chain: string
  handle: string
  accountIndex: number
}): string {
  // Keep primary (0) on the historical IDB name so existing wallets stay put.
  if (args.accountIndex === 0) {
    return `handcash-brc100-${args.chain}-${args.handle}`
  }
  return `handcash-brc100-${args.chain}-${args.handle}-a${args.accountIndex}`
}

/** A validated replacement is selected with one committed pointer write.
 * The historical database remains an independent rollback copy. */
export function toolboxDatabaseName(args: { chain: string; handle: string; accountIndex: number }): string {
  const base = originalToolboxDatabaseName(args)
  const selected = durableGetItem(storageRegistry.toolboxDatabasePointer.key + base)
  return selected?.startsWith(base + '-restore-') && /^[a-zA-Z0-9._-]+$/.test(selected) ? selected : base
}

export function selectToolboxDatabase(args: { chain: string; handle: string; accountIndex: number }, name: string): void {
  const base = originalToolboxDatabaseName(args)
  if (name !== base && !(name.startsWith(base + '-restore-') && /^[a-zA-Z0-9._-]+$/.test(name))) {
    throw new Error('Invalid replacement database')
  }
  if (!durableSetItem(storageRegistry.toolboxDatabasePointer.key + base, name)) {
    throw new Error('Could not commit recovery database selection; original history retained')
  }
}

function defaultPrimary(masterIdentityKey: string): VaultAccount {
  return { index: 0, name: 'Primary', identityKey: masterIdentityKey }
}

function readStoredAccounts(masterIdentityKey: string): VaultAccountStore | null {
  try {
    const raw = localStorage.getItem(storageKey(masterIdentityKey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as VaultAccountStore
    if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) return null
    return parsed
  } catch {
    return null
  }
}

/** The store for a vault created on this device: it has nothing to discover. */
export function initCreatedVaultAccounts(master: VaultMaster): VaultAccountStore {
  const masterIdentityKey = vaultIdentityKey(master)
  const store: VaultAccountStore = {
    version: 1,
    masterIdentityKey,
    activeIndex: 0,
    accounts: [defaultPrimary(masterIdentityKey)],
    discovered: true,
  }
  writeVaultAccounts(store)
  return store
}

export function readVaultAccounts(masterIdentityKey: string): VaultAccountStore {
  const parsed = readStoredAccounts(masterIdentityKey)
  if (!parsed) {
    return {
      version: 1,
      masterIdentityKey,
      activeIndex: 0,
      accounts: [defaultPrimary(masterIdentityKey)],
    }
  }
  if (!parsed.accounts.some((a) => a.index === 0)) {
    parsed.accounts = [defaultPrimary(masterIdentityKey), ...parsed.accounts]
  }
  parsed.masterIdentityKey = masterIdentityKey
  if (!parsed.accounts.some((a) => a.index === parsed.activeIndex)) {
    parsed.activeIndex = 0
  }
  return parsed
}

const listeners = new Set<() => void>()

/** Called after the stored account list changes. */
export function subscribeVaultAccounts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function writeVaultAccounts(store: VaultAccountStore): void {
  const key = storageKey(store.masterIdentityKey)
  const next = JSON.stringify(store)
  if (localStorage.getItem(key) === next) return
  localStorage.setItem(key, next)
  for (const listener of listeners) listener()
}

/** Ensure the store exists and every listed identity matches the unlocked vault. */
export function ensureVaultAccounts(master: VaultMaster): VaultAccountStore {
  const masterIdentityKey = vaultIdentityKey(master)
  const store = readVaultAccounts(masterIdentityKey)
  for (const acct of store.accounts) {
    acct.identityKey = acct.index === 0 ? masterIdentityKey : identityKeyForAccount(master, acct.index)
  }
  writeVaultAccounts(store)
  return store
}

export function nextAccountIndex(store: VaultAccountStore): number {
  let max = 0
  for (const a of store.accounts) if (a.index > max) max = a.index
  return max + 1
}

/** Add account `index`, held here. Allocation across devices is `claimVaultAccount`. */
export function createVaultAccount(args: {
  master: VaultMaster
  name: string
  index?: number
  holding?: AccountHolding
}): VaultAccountStore {
  const store = ensureVaultAccounts(args.master)
  const index = args.index ?? nextAccountIndex(store)
  if (store.accounts.some((a) => a.index === index)) {
    throw new Error(`account index already listed: ${index}`)
  }
  store.accounts.push({
    index,
    name: args.name.trim() || `Account ${index}`,
    identityKey: identityKeyForAccount(args.master, index),
    holding: args.holding ?? UNPUBLISHED_HERE,
  })
  store.accounts.sort((a, b) => a.index - b.index)
  writeVaultAccounts(store)
  return store
}

/** Record how this install holds account `index`. */
export function setAccountHolding(
  masterIdentityKey: string,
  index: number,
  holding: AccountHolding,
): VaultAccountStore {
  const store = readVaultAccounts(masterIdentityKey)
  const account = store.accounts.find((a) => a.index === index)
  if (!account) throw new Error(`unknown account index: ${index}`)
  account.holding = holding
  writeVaultAccounts(store)
  return store
}

/** Listed accounts discovered from the vault master but not created here. */
export function discoveredAccountHolding(store: VaultAccountStore): AccountHolding {
  return store.takeover ? UNPUBLISHED_HERE : UNKNOWN_ELSEWHERE
}

export function renameVaultAccount(args: {
  masterIdentityKey: string
  index: number
  name: string
}): VaultAccountStore {
  const store = readVaultAccounts(args.masterIdentityKey)
  const acct = store.accounts.find((a) => a.index === args.index)
  if (acct) acct.name = args.name.trim() || acct.name
  writeVaultAccounts(store)
  return store
}

export function setActiveVaultAccountIndex(
  masterIdentityKey: string,
  index: number,
): VaultAccountStore {
  const store = readVaultAccounts(masterIdentityKey)
  const account = store.accounts.find((a) => a.index === index)
  if (!account) throw new Error(`unknown account index: ${index}`)
  if (!isHeldHere(account)) throw new Error(ACCOUNT_HELD_ELSEWHERE)
  store.activeIndex = index
  writeVaultAccounts(store)
  return store
}

/** The active account if held here, else the first held one; null when none is. */
export function resolveActiveRootKeyHex(
  master: VaultMaster,
): { rootKeyHex: string; accountIndex: number; account: VaultAccount } | null {
  const store = ensureVaultAccounts(master)
  const held = store.accounts.filter(isHeldHere)
  const account = held.find((a) => a.index === store.activeIndex) ?? held[0]
  if (!account) return null
  return {
    rootKeyHex: rootKeyHexForAccount(master, account.index),
    accountIndex: account.index,
    account,
  }
}

/** Match a payee identity to a named vault account under this master (case-insensitive). */
export function findVaultAccountByIdentityKey(
  masterIdentityKey: string,
  payeeIdentityKey: string,
): VaultAccount | null {
  const needle = payeeIdentityKey.trim().toLowerCase()
  if (!needle) return null
  const store = readVaultAccounts(masterIdentityKey)
  return (
    store.accounts.find((a) => a.identityKey.trim().toLowerCase() === needle) ??
    null
  )
}

