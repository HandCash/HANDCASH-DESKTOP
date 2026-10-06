import { getWalletRuntime } from '../walletRuntime'
import { assertOnlineForPayment } from '../paymentPolicy'
import { appendAppLog } from '../appLog'
import type { Chain } from '../vault'
import {
  discoverAddresses,
  gorillaItemsLookup,
  wocHistoryLookup,
  type HistoryLookup,
  type ItemsLookup,
} from './discovery'
import { emptyHoldings, inspectHoldings, type AddressHoldings } from './holdings'
import { fetchHandCashUtxoSet, readUnspentOutpoints, verifyUtxoSet } from './handcashUtxoSet'
import { keyDeriverFor, type KeyDeriver } from './importSource'
import {
  createHistoryReader,
  hintedLookups,
  judgeHintedScan,
  readItemOwners,
  recoveryHintsFor,
  type HandCashRecoveryHints,
  type HintVerdict,
} from './recoveryHints'
import { loadImportedSources, updateImportedSource, type ImportedSource, type SourceScan } from './store'

export type ScanProgress =
  | { phase: 'utxoSet'; fetched: number }
  | { phase: 'items'; done: number; total: number }
  | { phase: 'history'; done: number; total: number }
  | { phase: 'discover'; checked: number; found: number; walk: string }
  | { phase: 'holdings'; done: number; total: number }

type ScanArgs = {
  sourceId: string
  /** Overrides each template's gap — a quick look or a deeper walk. */
  gap?: number
  onProgress?: (progress: ScanProgress) => void
  shouldStop?: () => boolean
}

/**
 * Walk a saved source's key set, then read what each used address holds.
 * Read-only: nothing is signed or broadcast. The result is saved on the source.
 *
 * A HandCash source with recovery hints from the migrate page is first walked
 * against the outputs of its own history. That pass stands only when the chain
 * shows everything HandCash reports; otherwise the full network walk runs.
 */
export async function scanImportedSource(args: ScanArgs): Promise<ImportedSource> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')

  const deriver = keyDeriverFor(source.secret)
  const hints = args.gap == null ? recoveryHintsFor(source) : null
  const cache = new Map<string, AddressHoldings>()
  const scan =
    (args.gap == null && source.secret.kind === 'handcash' ? await utxoSetScan(deriver, active.chain, args, cache) : null) ??
    (hints ? await hintedScan(deriver, active.chain, hints, args, cache) : null) ??
    (await walkScan(
      deriver,
      active.chain,
      args,
      { history: wocHistoryLookup(active.chain), items: gorillaItemsLookup(active.chain) },
      undefined,
      cache,
    ))
  const saved = await updateImportedSource(source.id, { scan })
  if (!saved) throw new Error('That saved wallet was removed during the scan')
  return saved
}

async function walkScan(
  deriver: KeyDeriver,
  chain: Chain,
  args: ScanArgs,
  lookups: { history: HistoryLookup; items: ItemsLookup },
  mayHold?: ReadonlySet<string>,
  cache?: Map<string, AddressHoldings>,
): Promise<SourceScan> {
  const discovered = await discoverAddresses({
    deriver,
    ...lookups,
    ...(args.gap != null ? { gap: args.gap } : {}),
    onProgress: (p) => args.onProgress?.({ phase: 'discover', ...p }),
    shouldStop: args.shouldStop,
  })
  const holdings = await inspectHoldings({
    addresses: discovered.addresses,
    chain,
    ...(mayHold ? { mayHold } : {}),
    ...(cache ? { cache } : {}),
    onProgress: (done, total) => args.onProgress?.({ phase: 'holdings', done, total }),
    shouldStop: args.shouldStop,
  })
  return {
    at: Date.now(),
    complete: discovered.complete && holdings.length === discovered.addresses.length,
    checked: discovered.checked,
    addresses: discovered.addresses,
    holdings,
  }
}

/**
 * The HandCash export read from its own account's UTXO set, or null when the
 * set cannot be had and the hinted pass or full walk must run instead.
 *
 * Rows count only when the keys derive their path to their address. Cash and
 * token addresses are read live; one-sat items are counted by outpoint where
 * the 1Sat index shows them unspent.
 */
export async function utxoSetScan(
  deriver: KeyDeriver,
  chain: Chain,
  args: ScanArgs,
  cache: Map<string, AddressHoldings> = new Map(),
): Promise<SourceScan | null> {
  const set = await fetchHandCashUtxoSet({
    deriver,
    onProgress: (fetched) => args.onProgress?.({ phase: 'utxoSet', fetched }),
    shouldStop: args.shouldStop,
  })
  if (set.kind === 'refused') return null
  const verified = verifyUtxoSet(deriver, set.utxos)
  if (set.utxos.length > 0 && verified.addresses.length === 0) {
    appendAppLog('warn', `[import] utxo set refused reason=underived rows=${set.utxos.length} — falling back`)
    return null
  }
  const items = await readUnspentOutpoints({
    chain,
    outpoints: [...verified.itemOutpoints.values()].flat(),
    onProgress: (done, total) => args.onProgress?.({ phase: 'items', done, total }),
    shouldStop: args.shouldStop,
  })
  const read = await inspectHoldings({
    addresses: verified.addresses,
    chain,
    mayHold: verified.cashAddresses,
    cache,
    onProgress: (done, total) => args.onProgress?.({ phase: 'holdings', done, total }),
    shouldStop: args.shouldStop,
  })
  const byAddress = new Map(read.map((h) => [h.address, h]))
  const holdings = verified.addresses.map((address) => {
    const live = byAddress.get(address.address)
    if (live && verified.cashAddresses.has(address.address)) return live
    const itemCount = (verified.itemOutpoints.get(address.address) ?? []).filter((o) => items.unspent.has(o)).length
    return { ...(live ?? emptyHoldings(address)), itemCount }
  })
  const stopped = items.stopped || args.shouldStop?.() === true || read.length < verified.addresses.length
  return {
    at: Date.now(),
    complete: !stopped && items.failed === 0,
    checked: verified.addresses.length,
    addresses: verified.addresses,
    holdings,
    via: 'handcash-utxo-set',
  }
}

/** History windows, newest first: most HandCash balances sit in recent outputs. */
const HISTORY_WINDOWS = [500, 2_500]

/**
 * The hinted pass, or null when the full walk must run instead.
 *
 * Only the unspent set matters. Items are located by origin in the 1Sat index;
 * cash by reading history newest first in widening windows until the chain
 * shows what HandCash reports. Addresses every read output of which was spent
 * by a read transaction are not read again; the rest are read once per scan,
 * and a fallback walk reuses those reads.
 */
export async function hintedScan(
  deriver: KeyDeriver,
  chain: Chain,
  hints: HandCashRecoveryHints,
  args: ScanArgs,
  cache: Map<string, AddressHoldings> = new Map(),
): Promise<SourceScan | null> {
  if (hints.satoshis === 0 && hints.itemCount === 0) {
    appendAppLog('info', '[import] hinted scan refused reason=empty-claim — full walk')
    return null
  }
  const items =
    hints.origins.length > 0
      ? await readItemOwners({
          chain,
          origins: hints.origins,
          onProgress: (done, total) => args.onProgress?.({ phase: 'items', done, total }),
          shouldStop: args.shouldStop,
        })
      : null
  const history = createHistoryReader({ chain, txids: hints.txids })
  const limits = [...HISTORY_WINDOWS.filter((n) => n < hints.txids.length), hints.txids.length]
  let verdict: HintVerdict = { kind: 'fallback', reason: 'balance-short' }
  for (const limit of limits) {
    await history.readUntil(limit, {
      onProgress: (done, total) => args.onProgress?.({ phase: 'history', done, total }),
      shouldStop: args.shouldStop,
    })
    const read = history.snapshot()
    const owners = items?.owners ?? new Set<string>()
    const seen = new Set([...read.addresses, ...owners])
    const mayHold = new Set([...read.mayHold, ...owners])
    const scan = await walkScan(deriver, chain, args, hintedLookups(seen), mayHold, cache)
    if (args.shouldStop?.()) return { ...scan, complete: false }
    verdict = judgeHintedScan(hints, { stopped: read.stopped || items?.stopped === true }, scan.holdings)
    appendAppLog(
      'info',
      `[import] hinted window txs=${history.position}/${hints.txids.length} mayHold=${mayHold.size} used=${scan.addresses.length} verdict=${verdict.kind === 'settled' ? 'settled' : verdict.reason}`,
    )
    if (verdict.kind === 'settled') {
      appendAppLog(
        'info',
        `[import] hinted scan settled sats=${verdict.foundSats} items=${verdict.foundItems} of sats=${hints.satoshis} items=${hints.itemCount}`,
      )
      return { ...scan, via: 'handcash-history' }
    }
    if (verdict.reason === 'stopped') break
  }
  appendAppLog('info', `[import] hinted scan refused reason=${verdict.kind === 'fallback' ? verdict.reason : 'settled'} — full walk`)
  return null
}
