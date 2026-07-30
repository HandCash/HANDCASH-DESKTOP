/**
 * HandCash migration helpers exposed over the BRC-100 HTTP bridge.
 * Contract mirrored in items-market `src/lib/brc100/types.ts`.
 */
import { getActiveWallet, fetchBalanceSats } from './session'
import { scanLegacyAddress, importLegacyUtxos } from './legacyScan'
import { reconcilePendingSends } from './pendingSend'
import { normalizeAppHost } from './appIdentity'

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
  txids: string[]
}

export type ListMigrationTxidsPayload = {
  txids: string[]
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
    const raw = localStorage.getItem(TXID_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0)
  } catch {
    return []
  }
}

function writeTxidLog(txids: string[]): void {
  localStorage.setItem(TXID_STORAGE_KEY, JSON.stringify(txids.slice(0, MAX_TXIDS)))
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

export async function refreshLegacyAddressPayload(
  args?: { txids?: string[] } | null,
): Promise<RefreshLegacyAddressPayload> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const reportedTxids = Array.isArray(args?.txids)
    ? args.txids.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []
  if (reportedTxids.length > 0) {
    recordMigrationTxids(reportedTxids)
  }

  try {
    reconcilePendingSends()
  } catch (err) {
    console.warn('[migration] pending send reconcile skipped', err)
  }

  const scan = await scanLegacyAddress(active)
  const scannedTxids = [...new Set(scan.utxos.map((u) => u.txid).filter(Boolean))]
  let importedCount = 0

  if (scan.utxos.length > 0) {
    const outpoints = scan.utxos.map((u) => u.outpoint)
    const result = await importLegacyUtxos(outpoints, active)
    importedCount = result.imported
    if (result.failed > 0) {
      console.warn('[migration] legacy import partial', result)
    }
  }

  if (scannedTxids.length > 0) {
    recordMigrationTxids(scannedTxids)
  }

  let satoshis = 0
  try {
    satoshis = await fetchBalanceSats(active.wallet)
  } catch (err) {
    console.warn('[migration] balance refresh failed', err)
  }

  const txids = [...new Set([...reportedTxids, ...scannedTxids])]

  return {
    address: active.address,
    satoshis,
    importedCount,
    txids,
  }
}

export function listMigrationTxids(): ListMigrationTxidsPayload {
  return { txids: readTxidLog().slice(0, MAX_TXIDS) }
}
