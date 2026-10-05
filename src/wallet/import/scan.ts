import { getWalletRuntime } from '../walletRuntime'
import { assertOnlineForPayment } from '../paymentPolicy'
import {
  discoverAddresses,
  gorillaItemsLookup,
  wocHistoryLookup,
} from './discovery'
import { inspectHoldings } from './holdings'
import { keyDeriverFor } from './importSource'
import { loadImportedSources, updateImportedSource, type ImportedSource, type SourceScan } from './store'

export type ScanProgress =
  | { phase: 'discover'; checked: number; found: number; walk: string }
  | { phase: 'holdings'; done: number; total: number }

/**
 * Walk a saved source's key set, then read what each used address holds.
 * Read-only: nothing is signed or broadcast. The result is saved on the source.
 */
export async function scanImportedSource(args: {
  sourceId: string
  /** Overrides each template's gap — a quick look or a deeper walk. */
  gap?: number
  onProgress?: (progress: ScanProgress) => void
  shouldStop?: () => boolean
}): Promise<ImportedSource> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')

  const deriver = keyDeriverFor(source.secret)
  const discovered = await discoverAddresses({
    deriver,
    history: wocHistoryLookup(active.chain),
    items: gorillaItemsLookup(active.chain),
    ...(args.gap != null ? { gap: args.gap } : {}),
    onProgress: (p) => args.onProgress?.({ phase: 'discover', ...p }),
    shouldStop: args.shouldStop,
  })
  const holdings = await inspectHoldings({
    addresses: discovered.addresses,
    chain: active.chain,
    onProgress: (done, total) => args.onProgress?.({ phase: 'holdings', done, total }),
    shouldStop: args.shouldStop,
  })
  const scan: SourceScan = {
    at: Date.now(),
    complete: discovered.complete && holdings.length === discovered.addresses.length,
    checked: discovered.checked,
    addresses: discovered.addresses,
    holdings,
  }
  const saved = await updateImportedSource(source.id, { scan })
  if (!saved) throw new Error('That saved wallet was removed during the scan')
  return saved
}
