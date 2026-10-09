/**
 * Vault sub-accounts (BRC-208) — named account roots under one vault master.
 *
 * Account 0 is the vault master root (existing wallets; no migration).
 * Account n>=1 is KeyDeriver(master).derivePrivateKey([2, "account"], `account-${n}`, "self").
 * Each account is a full BRC-100 wallet root (own UTXOs, BAP, balances).
 * One mnemonic / unlock recovers every account.
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'

export const VAULT_ACCOUNT_PROTOCOL: [2, 'account'] = [2, 'account']

export type VaultAccountRefusal = 'account-protocol' | 'self-linkage'

/**
 * Why an application request must not reach the wallet, or null.
 *
 * `account-protocol`: a key or signature under the account protocol is another
 * account's root. Reserved at every security level, as BRC-44 reserves
 * `admin`; names are matched as BRC-43 normalises them (lowercase, trimmed).
 *
 * `self-linkage`: the wallet's shared secret with itself yields the offset of
 * every account root, and one offset plus one exported account key is the
 * master.
 */
export function vaultAccountRefusal(
  method: string,
  args: unknown,
  identityKey: string | undefined,
): VaultAccountRefusal | null {
  if (!args || typeof args !== 'object') return null
  const { protocolID, counterparty } = args as { protocolID?: unknown; counterparty?: unknown }
  if (
    Array.isArray(protocolID) &&
    typeof protocolID[1] === 'string' &&
    protocolID[1].toLowerCase().trim() === VAULT_ACCOUNT_PROTOCOL[1]
  ) {
    return 'account-protocol'
  }
  if (method === 'revealCounterpartyKeyLinkage' && typeof counterparty === 'string') {
    const peer = counterparty.trim().toLowerCase()
    if (peer === 'self' || (!!identityKey && peer === identityKey.trim().toLowerCase())) {
      return 'self-linkage'
    }
  }
  return null
}

export type VaultAccount = {
  /** Stable index. 0 = primary (vault master). */
  index: number
  name: string
  identityKey: string
}

export type VaultAccountStore = {
  version: 1
  /** Vault master identity key (account 0). */
  masterIdentityKey: string
  activeIndex: number
  accounts: VaultAccount[]
}

const STORAGE_PREFIX = 'handcash.vault-accounts.v1:'

function storageKey(masterIdentityKey: string): string {
  return `${STORAGE_PREFIX}${masterIdentityKey}`
}

export function accountKeyId(index: number): string {
  return `account-${index}`
}

/** Derive the private key hex for account `index` under vault master. */
export function rootKeyHexForAccount(masterRootKeyHex: string, index: number): string {
  if (index < 0 || !Number.isInteger(index)) {
    throw new Error(`invalid account index: ${index}`)
  }
  if (index === 0) return masterRootKeyHex
  const deriver = new KeyDeriver(PrivateKey.fromHex(masterRootKeyHex))
  return deriver
    .derivePrivateKey(VAULT_ACCOUNT_PROTOCOL, accountKeyId(index), 'self')
    .toHex()
}

export function identityKeyForAccount(masterRootKeyHex: string, index: number): string {
  return PrivateKey.fromHex(rootKeyHexForAccount(masterRootKeyHex, index))
    .toPublicKey()
    .toString()
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

export function readVaultAccounts(masterIdentityKey: string): VaultAccountStore {
  const empty: VaultAccountStore = {
    version: 1,
    masterIdentityKey,
    activeIndex: 0,
    accounts: [defaultPrimary(masterIdentityKey)],
  }
  try {
    const raw = localStorage.getItem(storageKey(masterIdentityKey))
    if (!raw) return empty
    const parsed = JSON.parse(raw) as VaultAccountStore
    if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) return empty
    if (!parsed.accounts.some((a) => a.index === 0)) {
      parsed.accounts = [defaultPrimary(masterIdentityKey), ...parsed.accounts]
    }
    parsed.masterIdentityKey = masterIdentityKey
    if (!parsed.accounts.some((a) => a.index === parsed.activeIndex)) {
      parsed.activeIndex = 0
    }
    return parsed
  } catch {
    return empty
  }
}

export function writeVaultAccounts(store: VaultAccountStore): void {
  localStorage.setItem(storageKey(store.masterIdentityKey), JSON.stringify(store))
}

/** Ensure store exists and primary identity matches the unlocked vault. */
export function ensureVaultAccounts(
  masterRootKeyHex: string,
  masterIdentityKey: string,
): VaultAccountStore {
  const store = readVaultAccounts(masterIdentityKey)
  const primary = store.accounts.find((a) => a.index === 0)
  if (primary) primary.identityKey = masterIdentityKey
  // Refresh derived identityKeys (deterministic) in case protocol stayed fixed.
  for (const acct of store.accounts) {
    if (acct.index === 0) continue
    try {
      acct.identityKey = identityKeyForAccount(masterRootKeyHex, acct.index)
    } catch {
      // leave stored
    }
  }
  writeVaultAccounts(store)
  return store
}

export function nextAccountIndex(store: VaultAccountStore): number {
  let max = 0
  for (const a of store.accounts) if (a.index > max) max = a.index
  return max + 1
}

export function createVaultAccount(args: {
  masterRootKeyHex: string
  masterIdentityKey: string
  name: string
}): VaultAccountStore {
  const store = ensureVaultAccounts(args.masterRootKeyHex, args.masterIdentityKey)
  const index = nextAccountIndex(store)
  const identityKey = identityKeyForAccount(args.masterRootKeyHex, index)
  store.accounts.push({
    index,
    name: args.name.trim() || `Account ${index}`,
    identityKey,
  })
  writeVaultAccounts(store)
  return store
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
  if (!store.accounts.some((a) => a.index === index)) {
    throw new Error(`unknown account index: ${index}`)
  }
  store.activeIndex = index
  writeVaultAccounts(store)
  return store
}

export function resolveActiveRootKeyHex(
  masterRootKeyHex: string,
  masterIdentityKey: string,
): { rootKeyHex: string; accountIndex: number; account: VaultAccount } {
  const store = ensureVaultAccounts(masterRootKeyHex, masterIdentityKey)
  const account =
    store.accounts.find((a) => a.index === store.activeIndex) ?? store.accounts[0]!
  return {
    rootKeyHex: rootKeyHexForAccount(masterRootKeyHex, account.index),
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

