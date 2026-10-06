import { Transaction, Utils } from '@bsv/sdk'
import type { Chain } from '../vault'
import { appendAppLog } from '../appLog'
import { yieldToUi } from '../yieldToUi'
import { wocBulkPost, type FetchLike, type HistoryLookup, type ItemsLookup } from './discovery'
import type { AddressHoldings } from './holdings'

/**
 * What the user's own HandCash account says about the wallet they are
 * recovering, read by the HandCash migrate page through endpoints it already
 * uses (transactions, balances, item inventory) and handed over the bridge.
 *
 * A map, never custody: hints only decide which derived addresses get read
 * first. Every coin and item shown still comes from the chain, and the hinted
 * pass is accepted only when what the chain shows covers what HandCash claims.
 * Anything short of that falls back to the full address walk.
 */
export type HandCashRecoveryHints = {
  /** HandCash handle the hints were read for, without `$`. */
  handle: string | null
  txids: string[]
  /** False when the history had more pages than the migrate page read. */
  historyComplete: boolean
  /** BSV balance HandCash reports, in satoshis. */
  satoshis: number
  /** Items HandCash's inventory lists for the account. */
  itemCount: number
  receivedAt: number
}

export const MAX_HINT_TXIDS = 10_000
const MAX_HINT_ITEMS = 10_000
const HINT_TTL_MS = 6 * 60 * 60 * 1000
const RAW_TX_CHUNK = 20
const TXID = /^[0-9a-f]{64}$/

let current: HandCashRecoveryHints | null = null
let generation = 0
const listeners = new Set<() => void>()

function changed(): void {
  generation += 1
  for (const listener of listeners) listener()
}

export function subscribeRecoveryHints(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function recoveryHintsGeneration(): number {
  return generation
}

function txidOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const head = value.trim().toLowerCase().slice(0, 64)
  return TXID.test(head) ? head : null
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Validate what crossed the bridge. Malformed entries are dropped, not
 * trusted; a payload with nothing usable is no hints at all.
 */
export function parseRecoveryHints(raw: unknown, now = Date.now()): HandCashRecoveryHints | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const txids = new Set<string>()
  const add = (value: unknown) => {
    const txid = txidOf(value)
    if (txid && txids.size < MAX_HINT_TXIDS) txids.add(txid)
  }
  if (Array.isArray(body.txids)) for (const value of body.txids) add(value)
  // An item's mint pays the holder too; its origin outpoint names that tx.
  const origins = Array.isArray(body.itemOrigins) ? body.itemOrigins.slice(0, MAX_HINT_ITEMS) : []
  for (const origin of origins) add(origin)
  if (txids.size === 0) return null

  const handle = typeof body.handle === 'string' ? body.handle.trim().replace(/^\$/, '').toLowerCase() : ''
  const listedItems = origins.filter((origin) => txidOf(origin) != null).length
  return {
    handle: handle || null,
    txids: [...txids],
    historyComplete: body.historyComplete === true && txids.size < MAX_HINT_TXIDS,
    satoshis: wholeNumber(body.satoshis) ?? 0,
    itemCount: wholeNumber(body.itemCount) ?? listedItems,
    receivedAt: now,
  }
}

export function rememberRecoveryHints(hints: HandCashRecoveryHints): void {
  current = hints
  changed()
  appendAppLog(
    'info',
    `[import] HandCash recovery hints txids=${hints.txids.length} complete=${hints.historyComplete} sats=${hints.satoshis} items=${hints.itemCount}`,
  )
}

/** Hints for a saved HandCash source, or null when none apply. */
export function recoveryHintsFor(
  source: { kind: string; handle: { handle: string } | null },
  now = Date.now(),
): HandCashRecoveryHints | null {
  if (source.kind !== 'handcash' || !current) return null
  if (now - current.receivedAt > HINT_TTL_MS) {
    current = null
    return null
  }
  const probed = source.handle?.handle.trim().replace(/^\$/, '').toLowerCase()
  if (probed && current.handle && probed !== current.handle) return null
  return current
}

/**
 * What a saved source's view offers about HandCash history:
 * - `none`: not a HandCash export;
 * - `ask`: no history on this device — the user can sign in to send it;
 * - `ready`: history arrived after the last scan, so a rescan would use it;
 * - `used`: the last scan ran after this history arrived, whether it settled
 *   on it or fell back to the full walk;
 * - `mismatch`: the history belongs to another handle than the one these keys prove.
 */
export type RecoveryHintsOffer =
  | { kind: 'none' }
  | { kind: 'ask' }
  | { kind: 'ready'; txids: number; historyComplete: boolean }
  | { kind: 'used' }
  | { kind: 'mismatch'; hinted: string; saved: string }

export function recoveryHintsOffer(
  source: { kind: string; handle: { handle: string } | null; scan: { at: number } | null },
  now = Date.now(),
): RecoveryHintsOffer {
  if (source.kind !== 'handcash') return { kind: 'none' }
  const hints = recoveryHintsFor(source, now)
  if (!hints) {
    const saved = source.handle?.handle.trim().replace(/^\$/, '').toLowerCase()
    if (current?.handle && saved && current.handle !== saved) {
      return { kind: 'mismatch', hinted: current.handle, saved }
    }
    return { kind: 'ask' }
  }
  if (source.scan && source.scan.at >= hints.receivedAt) return { kind: 'used' }
  return { kind: 'ready', txids: hints.txids.length, historyComplete: hints.historyComplete }
}

/** Test-only. */
export function clearRecoveryHintsForTests(): void {
  current = null
  generation = 0
  listeners.clear()
}

/** Every P2PKH hash in a script, including one wrapped by an ordinal envelope or lock. */
function p2pkhHashes(scriptHex: string): string[] {
  const out: string[] = []
  let at = scriptHex.indexOf('76a914')
  while (at !== -1) {
    const end = at + 6 + 40
    if (at % 2 === 0 && scriptHex.slice(end, end + 4) === '88ac') out.push(scriptHex.slice(at + 6, end))
    at = scriptHex.indexOf('76a914', at + 2)
  }
  return out
}

export type HintedAddresses = {
  /** Base58 (mainnet form, as discovery derives) of every output address seen. */
  addresses: Set<string>
  read: number
  /** Txids the chain does not know — another network's, or never broadcast. They hold nothing. */
  unknown: number
  /** Txids the provider did not answer for, or answered with bytes that do not parse. */
  failed: number
  stopped: boolean
}

/** Read the hinted transactions and collect the address of every output. */
export async function readHintedAddresses(args: {
  chain: Chain
  txids: readonly string[]
  fetchImpl?: FetchLike
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<HintedAddresses> {
  const startedAt = Date.now()
  const addresses = new Set<string>()
  let read = 0
  let unknown = 0
  let failed = 0
  let stopped = false
  for (let i = 0; i < args.txids.length; i += RAW_TX_CHUNK) {
    if (args.shouldStop?.()) {
      stopped = true
      break
    }
    const chunk = args.txids.slice(i, i + RAW_TX_CHUNK)
    let rows: unknown
    try {
      rows = await wocBulkPost(args.chain, '/txs/hex', { txids: chunk }, args.fetchImpl)
    } catch (err) {
      failed += chunk.length
      appendAppLog(
        'warn',
        `[import] hinted tx read failed for ${chunk.length} tx(s): ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    // WhatsOnChain answers a txid it has never seen with `{ txid, error: 'unknown' }`.
    const hexById = new Map<string, string | 'unknown'>()
    for (const row of Array.isArray(rows) ? rows : []) {
      const { txid, hex, error } = (row ?? {}) as { txid?: unknown; hex?: unknown; error?: unknown }
      if (typeof txid !== 'string') continue
      if (typeof hex === 'string' && hex) hexById.set(txid.toLowerCase(), hex)
      else if (error === 'unknown') hexById.set(txid.toLowerCase(), 'unknown')
    }
    for (const txid of chunk) {
      const hex = hexById.get(txid)
      if (hex == null) {
        failed += 1
        continue
      }
      if (hex === 'unknown') {
        unknown += 1
        continue
      }
      try {
        for (const output of Transaction.fromHex(hex).outputs) {
          for (const hash of p2pkhHashes(output.lockingScript.toHex())) {
            addresses.add(Utils.toBase58Check(Utils.toArray(hash, 'hex'), [0x00]))
          }
        }
        read += 1
      } catch {
        failed += 1
      }
    }
    args.onProgress?.(Math.min(i + RAW_TX_CHUNK, args.txids.length), args.txids.length)
    await yieldToUi()
  }
  appendAppLog(
    'info',
    `[import] hinted history done ${Date.now() - startedAt}ms txs=${read} unknown=${unknown} failed=${failed} addresses=${addresses.size}`,
  )
  return { addresses, read, unknown, failed, stopped }
}

/** Discovery lookups answered from the hinted outputs — no network. */
export function hintedLookups(seen: ReadonlySet<string>): { history: HistoryLookup; items: ItemsLookup } {
  return {
    history: async (addresses) => new Set(addresses.filter((address) => seen.has(address))),
    items: async (address) => seen.has(address),
  }
}

export type HintVerdict =
  | { kind: 'settled'; foundSats: number; foundItems: number }
  | { kind: 'fallback'; reason: HintFallbackReason }

export type HintFallbackReason =
  | 'history-capped'
  | 'history-unread'
  | 'empty-claim'
  | 'balance-short'
  | 'items-short'

/**
 * Is the hinted pass the whole wallet? Only when HandCash's full history was
 * read and the chain shows at least the balance and items HandCash reports.
 * An empty claim never shortcuts: it would make a wrong hint look like an
 * empty wallet.
 */
export function judgeHintedScan(
  hints: HandCashRecoveryHints,
  read: Pick<HintedAddresses, 'failed' | 'stopped'>,
  holdings: readonly AddressHoldings[],
): HintVerdict {
  if (!hints.historyComplete) return { kind: 'fallback', reason: 'history-capped' }
  if (read.failed > 0 || read.stopped) return { kind: 'fallback', reason: 'history-unread' }
  if (hints.satoshis === 0 && hints.itemCount === 0) return { kind: 'fallback', reason: 'empty-claim' }
  let foundSats = 0
  let foundItems = 0
  let itemsCapped = false
  for (const h of holdings) {
    if (h.uncompressed) continue
    foundSats += h.cashSats + (h.dustSats ?? 0)
    foundItems += h.itemCount
    itemsCapped ||= h.itemCountCapped
  }
  if (foundSats < hints.satoshis) return { kind: 'fallback', reason: 'balance-short' }
  if (!itemsCapped && foundItems < hints.itemCount) return { kind: 'fallback', reason: 'items-short' }
  return { kind: 'settled', foundSats, foundItems }
}
