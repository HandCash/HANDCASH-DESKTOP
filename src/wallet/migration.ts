/**
 * HandCash migration helpers exposed over the BRC-100 HTTP bridge.
 * Hosts: handcash.io / market.handcash.io (+ localhost / preprod).
 * Methods: getLegacyAddress, refreshLegacyAddress, listMigrationTxids.
 * Handle claim (separate): claimCloudHandle, getClaimedCloudHandle — see handleClaim.ts.
 */
import { getActiveWallet } from './session'
import { normalizeAppHost } from './appIdentity'
import { normalizeMigrationItem, type MigrationItem } from './oneSatImport'
import { durableGetItem, durableSetItem } from './durableStorage.js'
import { refreshFromChainExclusive } from './chainIngest'
import { runChainIngest } from './walletCoordinator'

const TXID_STORAGE_KEY = 'handcash.brc100.migrationTxids'
const MAX_TXIDS = 200

export type LegacyAddressPayload = {
  address: string
  identityKey: string
  handle: string
  chain: string
}

export type RefreshLegacyAddressPayload = {
  address: string
  satoshis: number
  importedCount: number
  importedItemsCount: number
  txids: string[]
}

export type ListMigrationTxidsPayload = {
  txids: string[]
}

export type RefreshLegacyAddressArgs = {
  txids?: string[]
  /** Ordinal outs from cloud migrate — internalized to basket `1sat`. */
  items?: MigrationItem[]
}

/** Origins allowed to call migration methods (after connect). */
export function isMigrationOrigin(origin: string | undefined): boolean {
  const host = normalizeAppHost(origin)
  const bare = (host.split(':')[0] ?? host).toLowerCase()
  if (bare === 'localhost' || bare === '127.0.0.1') return true
  return (
    bare === 'handcash.io' ||
    bare === 'www.handcash.io' ||
    bare === 'market.handcash.io' ||
    bare === 'preprod-market.handcash.io'
  )
}

export function isMigrationMethod(method: string): boolean {
  return (
    method === 'getLegacyAddress' ||
    method === 'refreshLegacyAddress' ||
    method === 'listMigrationTxids'
  )
}

function readTxidLog(): string[] {
  try {
    const raw = durableGetItem(TXID_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0)
  } catch {
    return []
  }
}

function writeTxidLog(txids: string[]): void {
  durableSetItem(TXID_STORAGE_KEY, JSON.stringify(txids.slice(0, MAX_TXIDS)))
}

/** Prepend unique txids (newest first). */
export function recordMigrationTxids(txids: string[]): string[] {
  if (txids.length === 0) return listMigrationTxids().txids
  const existing = readTxidLog()
  const seen = new Set<string>()
  const merged: string[] = []
  for (const txid of [...txids, ...existing]) {
    if (seen.has(txid)) continue
    seen.add(txid)
    merged.push(txid)
  }
  writeTxidLog(merged)
  return merged.slice(0, MAX_TXIDS)
}

export function getLegacyAddressPayload(): LegacyAddressPayload {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  return {
    address: active.address,
    identityKey: active.identityKey,
    handle: active.handle,
    chain: active.chain,
  }
}

function parseRefreshArgs(args?: RefreshLegacyAddressArgs | null): {
  txids: string[]
  items: MigrationItem[]
} {
  const txids = Array.isArray(args?.txids)
    ? args.txids.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []
  const items = Array.isArray(args?.items)
    ? args.items.map(normalizeMigrationItem).filter((x): x is MigrationItem => x != null)
    : []
  return { txids, items }
}

/**
 * Record cloud txids, then run the same chain-ingest body as Refresh
 * (ingest → review-with-funding-hold → balance). knownItems ride along so
 * migrate tips the indexer has not classified yet still import.
 */
export async function refreshLegacyAddressPayload(
  args?: RefreshLegacyAddressArgs | null,
): Promise<RefreshLegacyAddressPayload> {
  return runChainIngest(() => refreshLegacyAddressExclusive(args))
}

async function refreshLegacyAddressExclusive(
  args?: RefreshLegacyAddressArgs | null,
): Promise<RefreshLegacyAddressPayload> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const { txids: reportedTxids, items: reportedItems } = parseRefreshArgs(args)
  if (reportedTxids.length > 0) {
    recordMigrationTxids(reportedTxids)
  }

  const run = await refreshFromChainExclusive({
    forceReview: true,
    announceReceive: false,
    knownItems: reportedItems,
  })

  if (run.scannedTxids.length > 0) {
    recordMigrationTxids(run.scannedTxids)
  }

  const txids = [...new Set([...reportedTxids, ...run.scannedTxids])]

  return {
    address: active.address,
    satoshis: run.balanceSats ?? 0,
    importedCount: run.importedFunding,
    importedItemsCount: run.importedItems,
    txids,
  }
}

export function listMigrationTxids(): ListMigrationTxidsPayload {
  return { txids: readTxidLog().slice(0, MAX_TXIDS) }
}
