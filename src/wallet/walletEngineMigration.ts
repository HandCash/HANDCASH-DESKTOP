import {
  SetupClient,
  exportBRC38Json,
  importBRC38,
  parseBRC38Json,
  type BRC38WalletData,
} from '@handcash/wallet-engine'
import { PrivateKey } from '@bsv/sdk'
import {
  originalToolboxDatabaseName,
  selectToolboxDatabase,
  toolboxDatabaseName,
} from './vaultAccounts'
import type { Chain } from './vault'
import { durableGetItem, durableSetItem } from './durableStorage'
import { storageRegistry } from '../storage/registry'

const ENGINE_SCHEMA = 1
const migratedThisRun = new Set<string>()

type MigrationArgs = {
  chain: Chain
  rootKeyHex: string
  handle: string
  accountIndex?: number
}

type DocumentFacts = {
  identityKey: string
  chain: string
  counts: Record<string, number>
  spendableSats: number
  spendableOutpoints: string[]
  transactionStates: string[]
}

function factsOf(document: BRC38WalletData): DocumentFacts {
  const data = document.tables as unknown as Record<string, unknown>
  const counts: Record<string, number> = {}
  for (const [name, value] of Object.entries(data)) {
    // Sync checkpoints belong to the database, not to the account's custody.
    if (name === 'syncStates') continue
    if (Array.isArray(value)) counts[name] = value.length
  }
  const outputs = document.tables.outputs as Array<Record<string, unknown>>
  const transactions = document.tables.transactions as Array<Record<string, unknown>>
  const spendable = outputs.filter(
    output => output.spendable === true && output.spentBy == null,
  )
  return {
    identityKey: String(document.user.identityKey),
    chain: String(document.sourceStorage.chain),
    counts,
    spendableSats: spendable.reduce(
      (sum, output) => sum + Math.max(0, Math.trunc(Number(output.satoshis) || 0)),
      0,
    ),
    spendableOutpoints: spendable
      .map(output => `${String(output.txid ?? '')}.${Number(output.vout ?? -1)}`)
      .sort(),
    transactionStates: transactions
      .map(tx => `${String(tx.txid ?? '')}:${String(tx.status ?? '')}`)
      .sort(),
  }
}

function assertEquivalent(source: BRC38WalletData, staged: BRC38WalletData): void {
  const sourceFacts = factsOf(source)
  const stagedFacts = factsOf(staged)
  const mismatches: string[] = []
  if (sourceFacts.identityKey !== stagedFacts.identityKey) mismatches.push('identity')
  if (sourceFacts.chain !== stagedFacts.chain) mismatches.push('chain')
  if (sourceFacts.spendableSats !== stagedFacts.spendableSats) mismatches.push('spendable sats')
  if (JSON.stringify(sourceFacts.counts) !== JSON.stringify(stagedFacts.counts)) {
    const tables = new Set([...Object.keys(sourceFacts.counts), ...Object.keys(stagedFacts.counts)])
    const changed = [...tables].filter((table) => sourceFacts.counts[table] !== stagedFacts.counts[table])
    mismatches.push(`table counts (${changed.join(', ')})`)
  }
  if (JSON.stringify(sourceFacts.spendableOutpoints) !== JSON.stringify(stagedFacts.spendableOutpoints)) {
    mismatches.push('spendable outpoints')
  }
  if (JSON.stringify(sourceFacts.transactionStates) !== JSON.stringify(stagedFacts.transactionStates)) {
    mismatches.push('transaction states')
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Wallet-engine migration verification failed (${mismatches.join(', ')}); original database retained`,
    )
  }
}

function markerKey(base: string): string {
  return storageRegistry.walletEngineMigration.key + base
}

export function legacyToolboxDatabaseName(chain: Chain): string {
  return `wallet-toolbox-${chain}net`
}

async function databaseNames(): Promise<string[]> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return []
  const rows = await indexedDB.databases()
  return rows.map((row) => row.name).filter((name): name is string => Boolean(name))
}

async function identityIsStored(name: string, identityKey: string): Promise<boolean> {
  if (!(await databaseNames()).includes(name)) return false
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(name)
    request.onerror = () => resolve(null)
    request.onsuccess = () => resolve(request.result)
  })
  if (db == null || !db.objectStoreNames.contains('users')) {
    db?.close()
    return false
  }
  try {
    const rows = await new Promise<Array<{ identityKey?: string }>>((resolve, reject) => {
      const request = db.transaction('users', 'readonly').objectStore('users').getAll()
      request.onerror = () => reject(request.error ?? new Error('users unreadable'))
      request.onsuccess = () => resolve((request.result ?? []) as Array<{ identityKey?: string }>)
    })
    return rows.some((row) => row.identityKey === identityKey)
  } finally {
    db.close()
  }
}

/**
 * Transactions this identity holds in a database, or null when the database
 * has no user for it. Counted on the `userId` index, never by reading rows.
 */
async function identityTransactionCount(name: string, identityKey: string): Promise<number | null> {
  if (!(await databaseNames()).includes(name)) return null
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(name)
    request.onerror = () => resolve(null)
    request.onsuccess = () => resolve(request.result)
  })
  if (db == null || !db.objectStoreNames.contains('users') || !db.objectStoreNames.contains('transactions')) {
    db?.close()
    return null
  }
  try {
    const users = await new Promise<Array<{ identityKey?: string, userId?: number }>>((resolve, reject) => {
      const request = db.transaction('users', 'readonly').objectStore('users').getAll()
      request.onerror = () => reject(request.error ?? new Error('users unreadable'))
      request.onsuccess = () => resolve((request.result ?? []) as Array<{ identityKey?: string, userId?: number }>)
    })
    const user = users.find((row) => row.identityKey === identityKey)
    if (user?.userId == null) return null
    return await new Promise<number>((resolve, reject) => {
      const request = db.transaction('transactions', 'readonly').objectStore('transactions')
        .index('userId').count(IDBKeyRange.only(user.userId))
      request.onerror = () => reject(request.error ?? new Error('transactions unreadable'))
      request.onsuccess = () => resolve(request.result)
    })
  } finally {
    db.close()
  }
}

function sourceKey(base: string): string {
  return storageRegistry.walletEngineSource.key + base
}

/** The source chosen for this pointer value. A restore that moves the pointer re-decides. */
function decidedSource(base: string, selected: string): string | null {
  const [use, from] = (durableGetItem(sourceKey(base)) ?? '').split('\n')
  return use && from === selected ? use : null
}

function recordSource(base: string, selected: string, use: string): void {
  durableSetItem(sourceKey(base), `${use}\n${selected}`)
}

/**
 * The database this account's wallet opens.
 *
 * Toolbox 2.13 ignored the database name and kept every account in the shared
 * `wallet-toolbox-<chain>net` database. The engine honours the name, so an
 * account whose history is only in the shared database opened an empty one,
 * created a blank user there and showed a zero balance. Open the database that
 * holds more of this identity's transactions, after merging the other one into
 * it, so neither the shared history nor anything received since is dropped.
 * A merge that fails opens the larger database anyway and is retried next open.
 */
export async function resolveWalletEngineDatabase(args: MigrationArgs): Promise<string> {
  const { accountIndex, base, selected } = accountOf(args)
  const legacy = legacyToolboxDatabaseName(args.chain)
  if (selected === legacy || selected.includes(`-restore-engine-v${ENGINE_SCHEMA}-`)) return selected
  if (typeof indexedDB === 'undefined') return selected
  const identityKey = PrivateKey.fromHex(args.rootKeyHex).toPublicKey().toString()
  const decided = decidedSource(base, selected)
  if (decided === legacy && (await identityTransactionCount(legacy, identityKey)) != null) return legacy
  if (decided === selected) return selected

  const started = Date.now()
  const [ownCount, legacyCount] = await Promise.all([
    identityTransactionCount(selected, identityKey),
    identityTransactionCount(legacy, identityKey),
  ])
  if (!legacyCount || (ownCount != null && ownCount >= legacyCount)) {
    if (legacyCount) recordSource(base, selected, selected)
    return selected
  }
  let merged = 0
  if (ownCount) {
    try {
      merged = await mergeIdentity(args, selected, legacy, identityKey)
    } catch (error) {
      console.warn(
        `[wallet-engine] source merge deferred — a${accountIndex} ${selected} → ${legacy}:`,
        error instanceof Error ? error.message : String(error),
      )
      return legacy
    }
  }
  recordSource(base, selected, legacy)
  console.info(
    `[wallet-engine] source done ${Date.now() - started}ms — a${accountIndex} ${legacy} (${legacyCount} txs) over ${selected} (${ownCount ?? 'no user'}), merged ${merged}`,
  )
  return legacy
}

/** Merge one identity's rows from `from` into `into`; newer rows win, nothing is replaced. */
async function mergeIdentity(args: MigrationArgs, from: string, into: string, identityKey: string): Promise<number> {
  const source = await SetupClient.createStorageIdb({ chain: args.chain, rootKeyHex: args.rootKeyHex, databaseName: from })
  const target = await SetupClient.createStorageIdb({ chain: args.chain, rootKeyHex: args.rootKeyHex, databaseName: into })
  try {
    const document = parseBRC38Json(await exportBRC38Json(source, identityKey))
    if (document.user.identityKey !== identityKey || document.sourceStorage.chain !== args.chain) {
      throw new Error('identity or chain mismatch')
    }
    const result = await importBRC38(target, document, { mode: 'merge' })
    return result.inserts + result.updates
  } finally {
    await Promise.allSettled([source.destroy(), target.destroy()])
  }
}

/** Drop staging copies an interrupted run left behind; the selected one stays. */
async function dropAbandonedStages(base: string, selected: string): Promise<void> {
  const prefix = `${base}-restore-engine-v${ENGINE_SCHEMA}-`
  for (const name of await databaseNames()) {
    if (!name.startsWith(prefix) || name === selected) continue
    const started = Date.now()
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name)
      const timer = setTimeout(resolve, 60_000)
      const finish = () => {
        clearTimeout(timer)
        resolve()
      }
      request.onsuccess = finish
      request.onerror = finish
      request.onblocked = finish
    })
    console.info(`[wallet-engine] dropped abandoned migration copy done ${Date.now() - started}ms — ${name}`)
  }
}

function accountOf(args: MigrationArgs) {
  const accountIndex = args.accountIndex ?? 0
  const account = { chain: args.chain, handle: args.handle, accountIndex }
  return {
    accountIndex,
    account,
    base: originalToolboxDatabaseName(account),
    selected: toolboxDatabaseName(account),
  }
}

/**
 * Let unlock open the wallet.
 *
 * The engine reads the toolbox's own IndexedDB schema, so an account already
 * in its own database needs no copy. The previous unlock waited on a full
 * history export and, after that was removed, on deleting the leftover copy.
 * Both happen after the wallet is on screen, in {@link settleWalletEngineStorage}.
 */
export async function migrateWalletEngineStorage(args: MigrationArgs): Promise<void> {
  const started = Date.now()
  const { selected, base } = accountOf(args)
  const key = markerKey(base)
  if (
    migratedThisRun.has(selected) ||
    durableGetItem(key) === selected ||
    selected.includes(`-restore-engine-v${ENGINE_SCHEMA}-`)
  ) {
    migratedThisRun.add(selected)
    return
  }
  if (!durableSetItem(key, selected)) {
    throw new Error('Wallet-engine migration marker could not be persisted')
  }
  migratedThisRun.add(selected)
  const ms = Date.now() - started
  console.info(
    ms > 250
      ? `[wallet-engine] adopt done ${ms}ms — ${selected}`
      : `[wallet-engine] adopted ${selected} in place`,
  )
}

/**
 * After unlock: delete copies a stalled run left behind, and copy a shared
 * legacy database only when this account's own database does not hold it.
 * The pointer moves only after the portable history round-trips with identical
 * custody facts. The source database stays as the rollback copy.
 */
export async function settleWalletEngineStorage(args: MigrationArgs): Promise<void> {
  const { accountIndex, account, base, selected } = accountOf(args)
  const key = markerKey(base)
  const identityKey = PrivateKey.fromHex(args.rootKeyHex).toPublicKey().toString()
  const legacy = legacyToolboxDatabaseName(args.chain)
  // The wallet already reads the shared database in place; copying it out is
  // the long write that froze unlock, and nothing needs it.
  if (decidedSource(base, selected) === legacy) {
    await dropAbandonedStages(base, selected)
    return
  }
  const sourceName =
    selected !== legacy &&
    !(await identityIsStored(selected, identityKey)) &&
    (await identityIsStored(legacy, identityKey))
      ? legacy
      : selected
  if (sourceName === selected) {
    await dropAbandonedStages(base, selected)
    return
  }
  const replacement =
    `${base}-restore-engine-v${ENGINE_SCHEMA}-` + globalThis.crypto.randomUUID()
  const startedAt = Date.now()
  const source = await SetupClient.createStorageIdb({
    chain: args.chain,
    rootKeyHex: args.rootKeyHex,
    databaseName: sourceName,
  })
  const stage = await SetupClient.createStorageIdb({
    chain: args.chain,
    rootKeyHex: args.rootKeyHex,
    databaseName: replacement,
  })

  try {
    const sourceJson = await exportBRC38Json(source, identityKey)
    const sourceDocument = parseBRC38Json(sourceJson)
    if (
      sourceDocument.user.identityKey !== identityKey ||
      sourceDocument.sourceStorage.chain !== args.chain
    ) {
      throw new Error('Wallet-engine migration identity or chain mismatch')
    }
    await importBRC38(stage, sourceDocument, { mode: 'merge' })
    const stagedDocument = parseBRC38Json(
      await exportBRC38Json(stage, identityKey),
    )
    assertEquivalent(sourceDocument, stagedDocument)
  } finally {
    await Promise.allSettled([source.destroy(), stage.destroy()])
  }

  if (!durableSetItem(key, replacement)) {
    throw new Error('Wallet-engine migration marker could not be persisted')
  }
  selectToolboxDatabase(account, replacement)
  migratedThisRun.add(replacement)
  console.info(
    `[wallet-engine] migration done ${Date.now() - startedAt}ms — a${accountIndex} ${sourceName} → ${replacement}`,
  )
  await dropAbandonedStages(base, replacement)
}

/** Run settlement once the wallet is on screen, so unlock never waits on it. */
export function scheduleWalletEngineSettlement(args: MigrationArgs): void {
  if (import.meta.env?.MODE === 'test' || typeof window === 'undefined') return
  const start = () => {
    void settleWalletEngineStorage(args).catch((error) => {
      console.warn(
        '[wallet-engine] settlement skipped',
        error instanceof Error ? error.message : String(error),
      )
    })
  }
  setTimeout(() => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 20_000 })
    else start()
  }, 8_000)
}

export function __resetWalletEngineMigrationForTests(): void {
  migratedThisRun.clear()
}
