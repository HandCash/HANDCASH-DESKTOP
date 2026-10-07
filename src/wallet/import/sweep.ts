import type { ActiveWallet } from '../session'
import { getWalletRuntime } from '../walletRuntime'
import { appendAppLog } from '../appLog'
import { beginWalletJob, type WalletJobHandle } from '../walletJobs'
import { MAX_ITEMS_PER_MIGRATE_TX } from '../itemMigrateBundle'
import {
  refreshAfterPhraseItemMigrate,
  scanAddressAny,
  sweepPhraseFunding,
  type PhraseFundingSource,
  type PhraseCandidate,
} from '../phraseSweep'
import {
  addHeld,
  totalHoldings,
  type AddressHoldings,
  type HeldTally,
  type HoldingsTotals,
} from './holdings'
import { keyDeriverFor } from './importSource'
import { listedImportOutpoints, readImportListMeta } from './itemStore'
import { importItemsThroughQueue } from './importQueue'
import { clearImportItems, syncImportItems } from './items'
import { watchImportStage } from './stageWatch'
import { sweepTokensFromAddress } from './tokenSweep'
import { loadImportedSources, updateImportedSource, type ImportedSource, type SweepSummary } from './store'

/**
 * Explicit, compatible-only sweep of a saved source.
 *
 * Never automatic: it runs from the user's confirm on a preview. Cash, 1-sat
 * collectables and valid BSV-21 tokens move into this wallet; everything else
 * stays at the source and is reported with its reason. Each asset class uses
 * the path this wallet already trusts for it — legacy cash sweep, the import
 * queue (BRC-150 remittance, bundled across addresses from the saved list),
 * and the token sweep.
 * The whole sweep is one wallet job: one Activity row with a bar, and its item
 * rows fold into one record.
 */

/** Tips per item transaction; matches the preview's fee estimate. */
export const IMPORT_ITEMS_PER_TX = MAX_ITEMS_PER_MIGRATE_TX
/** Address reads in flight while the cash step lists coins. */
const CASH_SCAN_CONCURRENCY = 4
/**
 * A sweep moves from the saved list when this scan's sync is younger than
 * this. Moves made here already leave the list; the list is the index's view
 * and each move re-decides its item from the source transaction anyway.
 */
const IMPORT_LIST_FRESH_MS = 30 * 60_000

export type SweepPlan = {
  cash: AddressHoldings[]
  items: AddressHoldings[]
  tokens: AddressHoldings[]
  totals: HoldingsTotals
}

/** What an explicit sweep would move, from the last scan. Pure. */
export function planSweep(source: Pick<ImportedSource, 'scan'>): SweepPlan {
  const holdings = (source.scan?.holdings ?? []).filter((h) => !h.uncompressed)
  return {
    cash: holdings.filter((h) => h.cashCount > 0),
    items: holdings.filter((h) => h.itemCount > 0),
    tokens: holdings.filter((h) => h.tokens.some((t) => t.standard === 'bsv21' && t.id)),
    totals: totalHoldings(source.scan?.holdings ?? []),
  }
}

export type SweepProgress = {
  phase: 'cash' | 'items' | 'tokens' | 'refresh'
  message: string
}

type SweepCaller = Pick<Parameters<typeof sweepImportedSource>[0], 'onProgress' | 'shouldStop'>

/**
 * One sweep per source. A second confirm — the panel reopened mid-sweep —
 * joins the run in flight; two runs would sign the same tips twice.
 */
const sweeps = new Map<string, { promise: Promise<SweepSummary>; callers: Set<SweepCaller>; last: SweepProgress | null }>()

export function sweepImportedSource(args: {
  sourceId: string
  onProgress?: (progress: SweepProgress) => void
  shouldStop?: () => boolean
}): Promise<SweepSummary> {
  const caller: SweepCaller = { onProgress: args.onProgress, shouldStop: args.shouldStop }
  const running = sweeps.get(args.sourceId)
  if (running) {
    appendAppLog('info', `[import] sweep joined the run in flight callers=${running.callers.size + 1}`)
    running.callers.add(caller)
    if (running.last) caller.onProgress?.(running.last)
    return running.promise.finally(() => running.callers.delete(caller))
  }
  const flight = { promise: null as unknown as Promise<SweepSummary>, callers: new Set([caller]), last: null as SweepProgress | null }
  flight.promise = startSweep({
    sourceId: args.sourceId,
    onProgress: (progress) => {
      flight.last = progress
      for (const c of flight.callers) c.onProgress?.(progress)
    },
    shouldStop: () => [...flight.callers].some((c) => c.shouldStop?.() === true),
  }).finally(() => sweeps.delete(args.sourceId))
  sweeps.set(args.sourceId, flight)
  return flight.promise
}

async function startSweep(args: Parameters<typeof sweepImportedSource>[0]): Promise<SweepSummary> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')
  if (!source.scan) throw new Error('Scan this wallet before sweeping it')

  const startedAt = Date.now()
  const plan = planSweep(source)
  const job = beginWalletJob({ kind: 'wallet-sweep', identityKey: active.identityKey, startedAt })
  try {
    const { summary, paused } = await runSweep(args, source, plan, active, job)
    if (paused) job.stop(paused)
    else job.finish(`${summary.items.toLocaleString()} collectable(s) moved`)
    appendAppLog(
      'info',
      `[import] sweep done ${Date.now() - startedAt}ms kind=${source.kind} cash=${summary.cashSats}sats items=${summary.items}` +
        ` tokens=${summary.tokens.length} failed=${summary.failed}${paused ? ' paused' : ''}`,
    )
    return summary
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendAppLog('warn', `[import] sweep failed after ${Date.now() - startedAt}ms: ${message.slice(0, 160)}`)
    job.fail(message)
    throw err
  }
}

/**
 * Addresses read with no coins leave the cash plan, so the next sweep does not
 * re-read every address an earlier one already emptied. Unread addresses keep
 * their counts.
 */
async function forgetEmptyCash(sourceId: string, empty: ReadonlySet<string>): Promise<void> {
  try {
    const scan = (await loadImportedSources()).find((s) => s.id === sourceId)?.scan
    if (!scan) return
    await updateImportedSource(sourceId, {
      scan: {
        ...scan,
        holdings: scan.holdings.map((h) =>
          empty.has(h.address) && h.cashCount > 0 ? { ...h, cashCount: 0, cashSats: 0 } : h,
        ),
      },
    })
  } catch (err) {
    appendAppLog('warn', `[import] empty cash addresses not saved: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runSweep(
  args: Parameters<typeof sweepImportedSource>[0],
  source: ImportedSource,
  plan: SweepPlan,
  active: ActiveWallet,
  job: WalletJobHandle,
): Promise<{ summary: SweepSummary; paused: string | null }> {
  const deriver = keyDeriverFor(source.secret)
  /** Known once the saved list is read; the bar runs indeterminate until then. */
  let itemTotal: number | null = null
  const report = (phase: SweepProgress['phase'], message: string, itemsDone = 0) => {
    args.onProgress?.({ phase, message })
    job.progress(itemsDone, phase === 'items' ? itemTotal : null, message)
  }
  const stop = () => args.shouldStop?.() === true
  const notes: string[] = []
  // Listed tips are counted per output by the token sweep itself.
  const { listed: _listed, ...preHeld } = plan.totals.held
  let held: HeldTally = preHeld
  let cashSats = 0
  let items = 0
  let failed = 0
  /** Why the sweep stopped short and resumes on the next one; null when it ran out of work. */
  let paused: string | null = null
  const tokens: SweepSummary['tokens'] = []

  const candidateFor = (h: AddressHoldings): PhraseCandidate | null => {
    const key = deriver.privateKeyAt(h.path)
    if (key.toPublicKey().toString().toLowerCase() === active.identityKey.toLowerCase()) {
      notes.push(`${h.label} is this wallet’s own key — use Refresh instead.`)
      return null
    }
    return {
      scheme: 'import',
      label: h.label,
      path: h.path,
      rootKeyHex: key.toHex(),
      identityKey: key.toPublicKey().toString(),
      address: h.address,
    }
  }

  // Cash first: it is what pays for item and token transactions. Every address
  // is read, then all of its coins share transactions, each signed by its own key.
  const cashFrom = plan.cash.flatMap((h) => {
    const candidate = candidateFor(h)
    return candidate ? [candidate] : []
  })
  if (cashFrom.length > 0 && !stop()) {
    const scannedAt = Date.now()
    const sources: PhraseFundingSource[] = []
    const empty = new Set<string>()
    let read = 0
    let next = 0
    const reader = async () => {
      while (next < cashFrom.length && !stop()) {
        const candidate = cashFrom[next++]!
        report('cash', `Reading BSV addresses… ${read} of ${cashFrom.length}`)
        try {
          const scan = await scanAddressAny(candidate.address, active.chain)
          if (scan.utxos.length > 0) sources.push({ candidate, utxos: scan.utxos })
          else empty.add(candidate.address)
        } catch {
          notes.push(`${candidate.label} could not be read. Sweep again to move its BSV.`)
        }
        read += 1
      }
    }
    await watchImportStage('cash scan', () =>
      Promise.all(Array.from({ length: Math.min(CASH_SCAN_CONCURRENCY, cashFrom.length) }, reader)),
    )
    appendAppLog('info', `[import] cash scan addresses=${cashFrom.length} holding=${sources.length} done ${Date.now() - scannedAt}ms`)
    if (empty.size > 0) await forgetEmptyCash(source.id, empty)
    if (sources.length > 0 && !stop()) {
      report('cash', `Moving BSV from ${sources.length} address(es)…`)
      const result = await watchImportStage('cash sweep', () => sweepPhraseFunding({ sources }))
      cashSats += result.fundingSatsMoved
      failed += result.failed
      notes.push(...result.errors.slice(0, 2))
    }
  }

  // Items ride the import queue Browse items uses: each carries the key of the
  // address holding it, so a HandCash export — one item per address — still
  // shares transactions, and one runner owns every item move.
  if (plan.items.length > 0 && !stop()) {
    const meta = await readImportListMeta(source.id)
    const listAgeMs = meta.scanAt === source.scan?.at && meta.syncedAt != null ? Date.now() - meta.syncedAt : null
    if (listAgeMs != null && listAgeMs < IMPORT_LIST_FRESH_MS) {
      appendAppLog('info', `[import] sweep reuses the list synced ${Math.round(listAgeMs / 1000)}s ago complete=${meta.complete}`)
      if (!meta.complete) notes.push('Some addresses could not be read. Sweep again to move what they hold.')
    } else {
      report('items', 'Listing collectables…')
      const listing = await watchImportStage('listing items', () =>
        syncImportItems({ sourceId: source.id, shouldStop: stop, onStep: (message) => report('items', message) }),
      )
      if (!listing.complete && !stop()) {
        notes.push('Some addresses could not be read. Sweep again to move what they hold.')
      }
    }
    const listed = stop() ? [] : [...(await listedImportOutpoints(source.id))]
    itemTotal = listed.length || null
    report('items', `Moving collectables… 0 of ${listed.length.toLocaleString()}`)
    const moved = await watchImportStage('moving items', () =>
      importItemsThroughQueue({
        sourceId: source.id,
        outpoints: listed,
        job,
        shouldStop: stop,
        onProgress: ({ done, total, paused: cooling }) =>
          report(
            'items',
            cooling ? 'Waiting for the last import to clear…' : `Moving collectables… ${done.toLocaleString()} of ${total.toLocaleString()}`,
            done,
          ),
      }),
    )
    items += moved.moved
    failed += moved.failed
    if (moved.skipped > 0) held = addHeld(held, 'notCollectable', moved.skipped)
    if (moved.error) notes.push(moved.error)
    const verdict = moved.report
    if (verdict && (verdict.outcome === 'funds' || verdict.outcome === 'deferred')) {
      paused = verdict.body
      notes.push(paused)
    }
    report('items', `Moved ${items.toLocaleString()} collectable(s)`, items)
  }

  for (const h of plan.tokens) {
    if (stop() || paused) break
    const candidate = candidateFor(h)
    if (!candidate) continue
    report('tokens', `Moving tokens from ${h.label}…`, items)
    const result = await watchImportStage('token sweep', () =>
      sweepTokensFromAddress({
        active,
        spendKey: deriver.privateKeyAt(h.path),
        address: h.address,
        tokens: h.tokens.filter((t) => t.standard === 'bsv21' && t.id),
      }),
    )
    for (const moved of result.moved) {
      const sym = h.tokens.find((t) => t.id === moved.tokenId)?.sym ?? 'token'
      tokens.push({ tokenId: moved.tokenId, sym, amount: moved.amount })
    }
    for (const [reason, count] of Object.entries(result.held)) {
      held = addHeld(held, reason as keyof HeldTally, count ?? 0)
    }
    failed += result.failed
    notes.push(...result.errors.slice(0, 2))
    if (result.stopped === 'funds') {
      paused = 'This wallet ran low on BSV for token fees. Add funds and sweep again.'
      notes.push(paused)
    } else if (result.stopped === 'propagating') {
      paused = 'The last token transfer is still reaching the network. Sweep again in a moment to move the rest.'
      notes.push(paused)
    }
  }

  if (cashSats > 0 || items > 0 || tokens.length > 0) {
    report('refresh', 'Checking the chain…', items)
    await watchImportStage('refresh after sweep', () => refreshAfterPhraseItemMigrate())
  }
  if (stop()) {
    paused ??= 'Paused — sweep again to continue.'
    notes.push('Paused — sweep again to continue.')
  }

  const summary: SweepSummary = {
    at: Date.now(),
    cashSats,
    items,
    tokens,
    held,
    failed,
    notes: [...new Set(notes)].slice(0, 8),
  }
  // A paused sweep resumes from this list; only a finished one re-reads next time.
  if (!paused) await clearImportItems(source.id)
  await updateImportedSource(source.id, { lastSweep: summary })
  return { summary, paused }
}
