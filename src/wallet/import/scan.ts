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
import { inspectHoldings } from './holdings'
import { keyDeriverFor, type KeyDeriver } from './importSource'
import {
  hintedLookups,
  judgeHintedScan,
  readHintedAddresses,
  recoveryHintsFor,
  type HandCashRecoveryHints,
} from './recoveryHints'
import { loadImportedSources, updateImportedSource, type ImportedSource, type SourceScan } from './store'

export type ScanProgress =
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
  const scan =
    (hints ? await hintedScan(deriver, active.chain, hints, args) : null) ??
    (await walkScan(deriver, active.chain, args, {
      history: wocHistoryLookup(active.chain),
      items: gorillaItemsLookup(active.chain),
    }))
  const saved = await updateImportedSource(source.id, { scan })
  if (!saved) throw new Error('That saved wallet was removed during the scan')
  return saved
}

async function walkScan(
  deriver: KeyDeriver,
  chain: Chain,
  args: ScanArgs,
  lookups: { history: HistoryLookup; items: ItemsLookup },
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

/** The hinted pass, or null when the full walk must run instead. */
async function hintedScan(
  deriver: KeyDeriver,
  chain: Chain,
  hints: HandCashRecoveryHints,
  args: ScanArgs,
): Promise<SourceScan | null> {
  const read = await readHintedAddresses({
    chain,
    txids: hints.txids,
    onProgress: (done, total) => args.onProgress?.({ phase: 'history', done, total }),
    shouldStop: args.shouldStop,
  })
  const scan = await walkScan(deriver, chain, args, hintedLookups(read.addresses))
  if (args.shouldStop?.()) return { ...scan, complete: false }
  const verdict = judgeHintedScan(hints, read, scan.holdings)
  if (verdict.kind === 'fallback') {
    appendAppLog('info', `[import] hinted scan refused reason=${verdict.reason} — full walk`)
    return null
  }
  appendAppLog(
    'info',
    `[import] hinted scan settled sats=${verdict.foundSats} items=${verdict.foundItems} of sats=${hints.satoshis} items=${hints.itemCount}`,
  )
  return { ...scan, via: 'handcash-history' }
}
