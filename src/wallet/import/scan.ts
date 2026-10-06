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
import { inspectHoldings, type AddressHoldings } from './holdings'
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
