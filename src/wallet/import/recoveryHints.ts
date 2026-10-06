import { Transaction, Utils } from '@bsv/sdk'
import type { Chain } from '../vault'
import { appendAppLog } from '../appLog'
import { yieldToUi } from '../yieldToUi'
import { gorillaBase, wocBulkPost, type FetchLike, type HistoryLookup, type ItemsLookup } from './discovery'
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
  /** Account history, in the order HandCash lists it (newest first). */
  txids: string[]
  /** Item origins (`txid_vout`) from the inventory — located by the 1Sat index, not by history. */
  origins: string[]
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
const ORIGIN_CHUNK = 100
const TXID = /^[0-9a-f]{64}$/
const ORIGIN = /^([0-9a-f]{64})[_.](\d+)$/

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
  const origins = new Set<string>()
  for (const value of Array.isArray(body.itemOrigins) ? body.itemOrigins.slice(0, MAX_HINT_ITEMS) : []) {
    const m = typeof value === 'string' ? ORIGIN.exec(value.trim().toLowerCase()) : null
    if (m) origins.add(`${m[1]}_${m[2]}`)
  }
  if (txids.size === 0 && origins.size === 0) return null

  const handle = typeof body.handle === 'string' ? body.handle.trim().replace(/^\$/, '').toLowerCase() : ''
  return {
    handle: handle || null,
    txids: [...txids],
    origins: [...origins],
    historyComplete: body.historyComplete === true && txids.size < MAX_HINT_TXIDS,
    satoshis: wholeNumber(body.satoshis) ?? 0,
    itemCount: wholeNumber(body.itemCount) ?? origins.size,
    receivedAt: now,
  }
}

export function rememberRecoveryHints(hints: HandCashRecoveryHints): void {
  current = hints
  changed()
  appendAppLog(
    'info',
    `[import] HandCash recovery hints txids=${hints.txids.length} complete=${hints.historyComplete} sats=${hints.satoshis} items=${hints.itemCount} origins=${hints.origins.length}`,
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
 * - `none`: not a HandCash export, or one already read from its UTXO set;
 * - `ask`: no history on this device — the user can sign in to send it;
 * - `ready`: history arrived after the last scan, so a rescan would use it;
 * - `used`: the last scan ran after this history arrived, whether it settled
 *   on it or fell back to the full walk;
 * - `mismatch`: the history belongs to another handle than the one these keys prove.
 */
export type RecoveryHintsOffer =
  | { kind: 'none' }
  | { kind: 'ask' }
  | { kind: 'ready'; txids: number; items: number }
  | { kind: 'used' }
  | { kind: 'mismatch'; hinted: string; saved: string }

export function recoveryHintsOffer(
  source: { kind: string; handle: { handle: string } | null; scan: { at: number; via?: string } | null },
  now = Date.now(),
): RecoveryHintsOffer {
  if (source.kind !== 'handcash' || source.scan?.via === 'handcash-utxo-set') return { kind: 'none' }
  const hints = recoveryHintsFor(source, now)
  if (!hints) {
    const saved = source.handle?.handle.trim().replace(/^\$/, '').toLowerCase()
    if (current?.handle && saved && current.handle !== saved) {
      return { kind: 'mismatch', hinted: current.handle, saved }
    }
    return { kind: 'ask' }
  }
  if (source.scan && source.scan.at >= hints.receivedAt) return { kind: 'used' }
  return { kind: 'ready', txids: hints.txids.length, items: hints.origins.length }
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
  /**
   * Addresses with an output no read transaction spends. Every other address
   * was emptied by transactions the chain returned, so it holds nothing.
   */
  mayHold: Set<string>
  read: number
  /** Txids the chain does not know — another network's, or never broadcast. They hold nothing. */
  unknown: number
  /** Txids the provider did not answer for, or answered with bytes that do not parse. */
  failed: number
  stopped: boolean
}

export type HistoryReader = {
  /** Read the first `limit` hinted txids (later calls continue where the last stopped). */
  readUntil(limit: number, opts?: { onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean }): Promise<void>
  /** What the transactions read so far say. */
  snapshot(): HintedAddresses
  /** How many hinted txids have been asked for. */
  readonly position: number
}

/**
 * Read hinted transactions in order and keep every output address and every
 * outpoint they spend. An output spent by a read transaction is spent on
 * chain; one no read transaction spends may still hold value.
 */
export function createHistoryReader(args: { chain: Chain; txids: readonly string[]; fetchImpl?: FetchLike }): HistoryReader {
  const addresses = new Set<string>()
  const spent = new Set<string>()
  const outputs: Array<{ outpoint: string; addresses: string[] }> = []
  let position = 0
  let read = 0
  let unknown = 0
  let failed = 0
  let stopped = false
  return {
    get position() {
      return position
    },
    async readUntil(limit, opts) {
      const startedAt = Date.now()
      const end = Math.min(limit, args.txids.length)
      stopped = false
      while (position < end) {
        if (opts?.shouldStop?.()) {
          stopped = true
          break
        }
        const chunk = args.txids.slice(position, Math.min(position + RAW_TX_CHUNK, end))
        position += chunk.length
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
            const tx = Transaction.fromHex(hex)
            for (const input of tx.inputs) {
              if (input.sourceTXID) spent.add(`${input.sourceTXID.toLowerCase()}.${input.sourceOutputIndex}`)
            }
            tx.outputs.forEach((output, vout) => {
              const paid = p2pkhHashes(output.lockingScript.toHex()).map((hash) =>
                Utils.toBase58Check(Utils.toArray(hash, 'hex'), [0x00]),
              )
              if (paid.length === 0) return
              for (const address of paid) addresses.add(address)
              outputs.push({ outpoint: `${txid}.${vout}`, addresses: paid })
            })
            read += 1
          } catch {
            failed += 1
          }
        }
        opts?.onProgress?.(position, args.txids.length)
        await yieldToUi()
      }
      appendAppLog(
        'info',
        `[import] hinted history done ${Date.now() - startedAt}ms txs=${read} unknown=${unknown} failed=${failed} addresses=${addresses.size} upTo=${position}/${args.txids.length}`,
      )
    },
    snapshot() {
      const mayHold = new Set<string>()
      for (const output of outputs) {
        if (spent.has(output.outpoint)) continue
        for (const address of output.addresses) mayHold.add(address)
      }
      return { addresses: new Set(addresses), mayHold, read, unknown, failed, stopped }
    },
  }
}

/** Read every hinted transaction and collect the address of every output. */
export async function readHintedAddresses(args: {
  chain: Chain
  txids: readonly string[]
  fetchImpl?: FetchLike
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<HintedAddresses> {
  const reader = createHistoryReader(args)
  await reader.readUntil(args.txids.length, { onProgress: args.onProgress, shouldStop: args.shouldStop })
  return reader.snapshot()
}

export type ItemOwners = {
  /** Addresses holding an unspent item, by the 1Sat index. */
  owners: Set<string>
  /** Items whose latest output is unspent. */
  unspent: number
  /** Origins the index answered for. */
  located: number
  /** Origins the index has no latest output for — burned, or never indexed. */
  missing: number
  failed: number
  stopped: boolean
}

const NO_LATEST = /No latest outpoint for origin ([0-9a-f]{64}_\d+)/

type LatestAnswer = { rows: unknown[] } | { missing: string } | null

async function askLatest(fetchImpl: FetchLike, chain: Chain, origins: readonly string[]): Promise<LatestAnswer> {
  try {
    const res = await fetchImpl(`${gorillaBase(chain)}/api/inscriptions/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(origins),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const rows: unknown = await res.json()
      return Array.isArray(rows) ? { rows } : null
    }
    if (res.status === 404) {
      const missing = NO_LATEST.exec(await res.text())?.[1]
      if (missing && origins.includes(missing)) return { missing }
    }
  } catch {
    /* transient: the caller retries once */
  }
  return null
}

/**
 * Where each item sits now: the 1Sat index's latest output for every origin
 * HandCash's inventory lists, a hundred per request. Only the owners matter —
 * the holdings read still counts items from the chain index at each address.
 */
export async function readItemOwners(args: {
  chain: Chain
  origins: readonly string[]
  fetchImpl?: FetchLike
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<ItemOwners> {
  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  const owners = new Set<string>()
  let unspent = 0
  let located = 0
  let missing = 0
  let failed = 0
  let stopped = false
  for (let i = 0; i < args.origins.length; i += ORIGIN_CHUNK) {
    if (args.shouldStop?.()) {
      stopped = true
      break
    }
    // The index refuses the whole batch over one origin it has no output for, naming it.
    let ask = args.origins.slice(i, i + ORIGIN_CHUNK)
    let rows: unknown[] | null = null
    let retried = false
    while (ask.length > 0 && rows == null) {
      const answer = await askLatest(fetchImpl, args.chain, ask)
      if (answer && 'rows' in answer) rows = answer.rows
      else if (answer) {
        missing += 1
        ask = ask.filter((origin) => origin !== answer.missing)
      } else if (!retried) retried = true
      else break
    }
    if (rows == null) failed += ask.length
    for (const row of rows ?? []) {
      const { owner, spend } = (row ?? {}) as { owner?: unknown; spend?: unknown }
      located += 1
      if (spend) continue
      unspent += 1
      if (typeof owner === 'string' && owner) owners.add(owner)
    }
    args.onProgress?.(Math.min(i + ORIGIN_CHUNK, args.origins.length), args.origins.length)
    await yieldToUi()
  }
  appendAppLog(
    'info',
    `[import] item owners done ${Date.now() - startedAt}ms origins=${args.origins.length} located=${located} unspent=${unspent} owners=${owners.size} missing=${missing} failed=${failed}`,
  )
  return { owners, unspent, located, missing, failed, stopped }
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
  | 'stopped'
  | 'empty-claim'
  | 'balance-short'
  | 'items-short'

/**
 * Is the hinted pass the whole wallet? Only when the chain shows at least the
 * balance and items HandCash reports at addresses these keys derive — how much
 * history it took to find them does not matter. An empty claim never
 * shortcuts: it would make a wrong hint look like an empty wallet.
 */
export function judgeHintedScan(
  hints: HandCashRecoveryHints,
  read: { stopped: boolean },
  holdings: readonly AddressHoldings[],
): HintVerdict {
  if (read.stopped) return { kind: 'fallback', reason: 'stopped' }
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
